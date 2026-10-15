// Norwest Forms - Help tab issue reports.
//
// The app (no login, static GitHub Pages site) writes a report straight
// into Firestore: up to 3 screenshots as helpReports/{id}/shots/{n}
// (already shrunk to ~150KB JPEGs on the phone), then the report itself
// as helpReports/{id}. firestore.rules only lets a client CREATE
// well-shaped documents there - never read, list, update or delete.
//
// When the report document lands, deliverHelpReport (below) runs with
// admin access and:
//   1. archives it to Nextcloud: a folder per report holding report.txt
//      and the screenshots, plus a read-only public share link
//   2. posts it to a Discord channel (message + screenshots + the link)
//   3. deletes the screenshot copies from Firestore and marks the report
//      delivered, so Firestore only ever holds the small text record
//
// Same Firestore -> function -> Nextcloud hand-off as the myslewer app's
// Lift Library, minus Firebase Storage (screenshots are small enough to
// ride in Firestore, which avoids a bucket, storage rules, and the
// bucket/database region mismatch myslewer had to work around).
//
// Secrets (Discord webhook URL, Nextcloud app password) live in Secret
// Manager, NEVER in the app or this repo: anyone holding a Discord
// webhook URL can post as it or delete it. Non-secret Nextcloud settings
// come from functions/.env (gitignored; see .env.example).

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString, defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

initializeApp();

const NEXTCLOUD_DOMAIN = defineString('NEXTCLOUD_DOMAIN');
const NEXTCLOUD_USERNAME = defineString('NEXTCLOUD_USERNAME');
const NEXTCLOUD_REPORTS_PATH = defineString('NEXTCLOUD_REPORTS_PATH', { default: '/PWA/Norwest-forms' });
const NEXTCLOUD_APP_PASSWORD = defineSecret('NEXTCLOUD_APP_PASSWORD');
const DISCORD_WEBHOOK_URL = defineSecret('DISCORD_WEBHOOK_URL');

// Must match the Firestore database's location (australia-southeast1) -
// a Firestore trigger can only run in its database's region.
const REGION = 'australia-southeast1';

// Spam guard: the app has no login, so anyone who finds the page could
// script reports. Past this many in an hour, further reports are kept in
// Firestore (status "throttled") but NOT pushed to Discord/Nextcloud.
const MAX_REPORTS_PER_HOUR = 15;

const CATEGORY_LABELS = {
  jobnumbers: 'Job numbers',
  pdf: 'PDF / sending',
  looks: 'Something looks wrong',
  idea: 'Idea / request',
  other: 'Other',
};

// ---- Nextcloud (WebDAV + OCS share API), ported from myslewer ----------
function ncAuthHeader() {
  const basic = Buffer.from(`${NEXTCLOUD_USERNAME.value()}:${NEXTCLOUD_APP_PASSWORD.value()}`).toString('base64');
  return `Basic ${basic}`;
}
function ncDavUrl(davPath) {
  const encoded = davPath.split('/').map(encodeURIComponent).join('/');
  return `${NEXTCLOUD_DOMAIN.value()}/remote.php/dav/files/${encodeURIComponent(NEXTCLOUD_USERNAME.value())}${encoded}`;
}
// MKCOL on a folder that already exists returns 405 - that's fine.
async function ncEnsureFolder(davPath) {
  const res = await fetch(ncDavUrl(davPath), { method: 'MKCOL', headers: { Authorization: ncAuthHeader() } });
  if (res.status !== 201 && res.status !== 405) throw new Error(`MKCOL ${davPath} failed: ${res.status}`);
}
async function ncUpload(davPath, bytes, contentType) {
  const res = await fetch(ncDavUrl(davPath), {
    method: 'PUT',
    headers: { Authorization: ncAuthHeader(), 'Content-Type': contentType || 'application/octet-stream' },
    body: bytes,
  });
  if (res.status !== 201 && res.status !== 204) throw new Error(`PUT ${davPath} failed: ${res.status}`);
}
// shareType 3 = public link, permissions 1 = read-only
async function ncCreatePublicShareUrl(davPath) {
  const res = await fetch(`${NEXTCLOUD_DOMAIN.value()}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
    method: 'POST',
    headers: { Authorization: ncAuthHeader(), 'OCS-APIRequest': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ path: davPath, shareType: '3', permissions: '1' }).toString(),
  });
  if (!res.ok) throw new Error(`OCS share for ${davPath} failed: ${res.status}`);
  const url = (await res.json())?.ocs?.data?.url;
  if (!url) throw new Error(`OCS share for ${davPath} returned no url`);
  return url;
}

// ---- helpers ----------------------------------------------------------
// Perth time (AWST, UTC+8, no daylight saving) for folder names/messages
function perth(date) {
  const d = new Date(date.getTime() + 8 * 3600e3);
  return { day: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
// folder-name safe: no slashes or control characters
function safe(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function reportText(r, id, when) {
  return [
    `Norwest Forms issue report ${r.ref || id}`,
    `When:     ${when.day} ${when.time} AWST`,
    `Type:     ${CATEGORY_LABELS[r.category] || r.category}`,
    `Name:     ${r.name || '(not given)'}`,
    `Contact:  ${r.contact || '(not given)'}`,
    `Company:  ${r.company || '?'}   Form: ${r.formTab || '?'}   App: ${r.appVersion || '?'}`,
    `Job nos:  ${r.jobNumbers || '?'}`,
    `Device:   ${r.device || '?'}`,
    `Screenshots: ${r.shotCount || 0}`,
    '',
    'What happened:',
    r.message || '',
    '',
  ].join('\n');
}

async function postToDiscord(r, id, when, shots, shareUrl) {
  const fields = [
    { name: 'Type', value: CATEGORY_LABELS[r.category] || String(r.category), inline: true },
    { name: 'Company', value: r.company || '?', inline: true },
    { name: 'Form', value: r.formTab || '?', inline: true },
    { name: 'Name', value: r.name || '(not given)', inline: true },
    { name: 'Contact', value: r.contact || '(not given)', inline: true },
    { name: 'App', value: r.appVersion || '?', inline: true },
    { name: 'Job numbers', value: (r.jobNumbers || '?').slice(0, 200), inline: false },
    { name: 'Device', value: (r.device || '?').slice(0, 300), inline: false },
  ];
  if (shareUrl) fields.push({ name: 'Nextcloud', value: shareUrl, inline: false });
  const payload = {
    content: `🛠️ New Norwest Forms report **#${r.ref || id}**`,
    // never let a report ping @everyone / @here / roles
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${CATEGORY_LABELS[r.category] || 'Report'} — ${when.day} ${when.time} AWST`,
      description: (r.message || '(no message)').slice(0, 3900),
      color: 0xe8622c,
      fields,
      ...(shots.length ? { image: { url: 'attachment://shot-1.jpg' } } : {}),
    }],
    attachments: shots.map((s, i) => ({ id: i, filename: `shot-${i + 1}.jpg` })),
  };
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  shots.forEach((s, i) => form.append(`files[${i}]`, new Blob([s.bytes], { type: 'image/jpeg' }), `shot-${i + 1}.jpg`));
  const res = await fetch(DISCORD_WEBHOOK_URL.value(), { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ---- the trigger --------------------------------------------------------
exports.deliverHelpReport = onDocumentCreated(
  {
    document: 'helpReports/{reportId}',
    region: REGION,
    secrets: [NEXTCLOUD_APP_PASSWORD, DISCORD_WEBHOOK_URL],
    memory: '512MiB',
    timeoutSeconds: 120,
    retry: false,
  },
  async (event) => {
    const db = getFirestore();
    const id = event.params.reportId;
    const ref = db.collection('helpReports').doc(id);
    const r = event.data?.data();
    if (!r) return;

    const shotsSnap = await ref.collection('shots').get();
    const deleteShots = () => Promise.all(shotsSnap.docs.map(d => d.ref.delete()));

    // spam guard
    const hourAgo = Timestamp.fromMillis(Date.now() - 3600e3);
    const recent = await db.collection('helpReports').where('createdAt', '>', hourAgo).count().get();
    if (recent.data().count > MAX_REPORTS_PER_HOUR) {
      await deleteShots();
      await ref.update({ status: 'throttled', handledAt: FieldValue.serverTimestamp() });
      console.warn(`Report ${id} throttled: ${recent.data().count} reports in the last hour`);
      return;
    }

    const shots = shotsSnap.docs
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(d => ({ bytes: Buffer.from(String(d.get('data') || ''), 'base64') }))
      .filter(s => s.bytes.length > 0);

    const when = perth(r.createdAt?.toDate ? r.createdAt.toDate() : new Date());
    const errors = [];

    // 1. Nextcloud archive
    let shareUrl = null;
    try {
      const base = NEXTCLOUD_REPORTS_PATH.value().replace(/\/+$/, '');
      const folder = `${base}/${when.day} #${safe(r.ref || id)} ${safe(CATEGORY_LABELS[r.category] || r.category)}`;
      // create each level (e.g. /PWA then /PWA/Norwest-forms) - MKCOL can't
      // make a folder whose parent doesn't exist yet
      let level = '';
      for (const part of base.split('/').filter(Boolean)) { level += '/' + part; await ncEnsureFolder(level); }
      await ncEnsureFolder(folder);
      await ncUpload(`${folder}/report.txt`, Buffer.from(reportText(r, id, when), 'utf8'), 'text/plain; charset=utf-8');
      for (let i = 0; i < shots.length; i++) await ncUpload(`${folder}/shot-${i + 1}.jpg`, shots[i].bytes, 'image/jpeg');
      shareUrl = await ncCreatePublicShareUrl(folder);
    } catch (err) {
      errors.push(`nextcloud: ${err.message}`);
      console.error(`Report ${id} Nextcloud archive failed:`, err.message);
    }

    // 2. Discord
    try {
      await postToDiscord(r, id, when, shots, shareUrl);
    } catch (err) {
      errors.push(`discord: ${err.message}`);
      console.error(`Report ${id} Discord post failed:`, err.message);
    }

    // 3. Keep the screenshots in Firestore only if BOTH destinations failed,
    // so nothing is lost; otherwise drop them and keep the text record.
    const delivered = errors.length < 2;
    if (delivered) await deleteShots();
    await ref.update({
      status: delivered ? (errors.length ? 'partial' : 'delivered') : 'failed',
      nextcloudUrl: shareUrl || null,
      errors,
      handledAt: FieldValue.serverTimestamp(),
    });
  }
);

// Screenshots are written before their report. If a phone drops out in
// between (or someone scripts junk), orphan screenshot docs are left with
// no report. Daily, delete any screenshot more than a day old whose
// report doesn't exist.
exports.cleanupOrphanHelpShots = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Australia/Perth', region: REGION },
  async () => {
    const db = getFirestore();
    const dayAgo = Date.now() - 24 * 3600e3;
    const shots = await db.collectionGroup('shots').get();
    let removed = 0;
    for (const doc of shots.docs) {
      const parent = doc.ref.parent.parent;
      if (!parent || parent.parent.id !== 'helpReports') continue;
      if (doc.createTime.toMillis() > dayAgo) continue;
      const p = await parent.get();
      if (p.exists && p.get('status') === 'failed') continue; // kept on purpose
      if (!p.exists || p.get('status')) { await doc.ref.delete(); removed++; }
    }
    console.log(`Help shots cleanup: removed ${removed} orphan screenshot(s).`);
  }
);

// ---- Usage log -> Nextcloud (long-term history) --------------------------
// Firestore keeps the usage log (submissions/) for ~60 days (expireAt + TTL)
// and the admin dashboard reads it live from there. Once a week (Sunday
// 11:00 Perth) this archives each month's rows to a CSV in Nextcloud:
//   <NEXTCLOUD_REPORTS_PATH>/Usage/usage-YYYY-MM.csv
// Only the current and previous Perth month are rewritten (whole file each
// time - WebDAV has no append), so a month's last days are picked up by the
// first run of the next month, older months' files are never touched, and
// stay as the permanent history after Firestore expires the rows.
// Medical claims stay anonymous (no name is ever logged for them).

// Perth date parts for a JS Date (AWST, UTC+8, no daylight saving)
function perthParts(date) {
  const d = new Date(date.getTime() + 8 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, iso: d.toISOString(), dow: d.getUTCDay(), hour: d.getUTCHours(), d };
}
// Timesheets are for the week ending Sunday, due Monday 10am Perth. A
// submission belongs to the week ending the Sunday BEFORE its Monday
// (Tue..Mon window); Monday from 10:00 counts as late. Same rule as
// tools/usage-stats.mjs.
function payWeek(date) {
  const p = perthParts(date);
  const e = new Date(p.d); e.setUTCDate(e.getUTCDate() - 1);
  e.setUTCDate(e.getUTCDate() + ((7 - e.getUTCDay()) % 7));
  return { weekEnding: e.toISOString().slice(0, 10), late: p.dow === 1 && p.hour >= 10 };
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function usageCsv(rows) {
  const header = ['perth_time', 'week_ending', 'late', 'form', 'company', 'name', 'ip'];
  const lines = rows.map(r => [r.perthTime, r.weekEnding, r.late ? 'yes' : '', r.formType, r.company, r.name, r.ip].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

async function exportUsage() {
  const db = getFirestore();
  const now = perthParts(new Date());
  const prev = now.m === 1 ? { y: now.y - 1, m: 12 } : { y: now.y, m: now.m - 1 };
  // start of the previous Perth month, as a real instant (Perth midnight = 16:00Z the day before)
  const since = new Date(Date.UTC(prev.y, prev.m - 1, 1) - 8 * 3600e3);
  const snap = await db.collection('submissions').where('submittedAt', '>=', Timestamp.fromDate(since)).get();

  const months = {};
  [prev, { y: now.y, m: now.m }].forEach(k => { months[`${k.y}-${String(k.m).padStart(2, '0')}`] = []; });
  snap.docs.forEach(doc => {
    const r = doc.data();
    if (r.company === 'TEST') return; // Oct 2026 rules-check record
    const at = r.submittedAt?.toDate ? r.submittedAt.toDate() : null;
    if (!at) return;
    const p = perthParts(at);
    const key = `${p.y}-${String(p.m).padStart(2, '0')}`;
    if (!months[key]) return;
    const w = payWeek(at);
    months[key].push({
      at, perthTime: p.iso.slice(0, 16).replace('T', ' '), weekEnding: w.weekEnding, late: w.late,
      formType: r.formType || '', company: r.company || '', name: (r.name || '').trim(), ip: r.ip || '',
    });
  });

  const base = NEXTCLOUD_REPORTS_PATH.value().replace(/\/+$/, '');
  const dir = `${base}/Usage`;
  let level = '';
  for (const part of dir.split('/').filter(Boolean)) { level += '/' + part; await ncEnsureFolder(level); }
  const written = [];
  for (const [key, rows] of Object.entries(months)) {
    rows.sort((a, b) => a.at - b.at);
    await ncUpload(`${dir}/usage-${key}.csv`, Buffer.from(usageCsv(rows), 'utf8'), 'text/csv; charset=utf-8');
    written.push(`${key}: ${rows.length} row(s)`);
  }
  console.log(`Usage export to Nextcloud: ${written.join(', ')}`);
  return written;
}

exports.exportUsageToNextcloud = onSchedule(
  { schedule: '0 11 * * 0', timeZone: 'Australia/Perth', region: REGION, secrets: [NEXTCLOUD_APP_PASSWORD], timeoutSeconds: 120 },
  async () => { await exportUsage(); }
);

// ---- Admin dashboard: "Sign in with passkey" --------------------------
// Same approach as the myslewer app's passkeySignIn, so no paid Firebase
// add-on (custom OIDC providers would need the Identity Platform upgrade):
// admin.html sends the owner to the homelab's Authentik (app
// norwest-admin - a PUBLIC OIDC client, PKCE, no client secret anywhere,
// straight to the passkey prompt, and only the owner's two Authentik
// accounts are allowed in). Authentik sends them back to admin.html with
// ?code=, which posts code + code_verifier here. We swap those for the
// account's email, check it's an admin email, and hand back a one-time
// Firebase email sign-in link that admin.html completes on the spot with
// signInWithEmailLink - nothing is actually emailed. firestore.rules
// (isAdmin) stays the real gate: the link only proves the email.
const { onRequest } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');
// Overridable only so the emulator tests can point at a stand-in.
const AUTHENTIK_URL = defineString('AUTHENTIK_URL', { default: 'https://net.15buzza.au' });
const ADMIN_PAGE_URL = defineString('ADMIN_PAGE_URL', { default: 'https://886ppak.github.io/Norwest-Forms/admin.html' });
const AUTHENTIK_ADMIN_CLIENT_ID = 'fPLJ239vZGyR5IlHTCH7uFwOIp5msCE8AwsVtSyB';
// Keep in step with isAdmin() in firestore.rules.
const ADMIN_EMAILS = ['myslewer@gmail.com', '15buzza@gmail.com'];

exports.adminPasskeySignIn = onRequest(
  { region: REGION, invoker: 'public' },
  async (req, res) => {
    const origin = new URL(ADMIN_PAGE_URL.value()).origin;
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '3600');
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const { code, codeVerifier } = req.body || {};
    if (typeof code !== 'string' || typeof codeVerifier !== 'string' || code.length > 512 || codeVerifier.length > 256) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    let email;
    try {
      const tr = await fetch(`${AUTHENTIK_URL.value()}/application/o/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier,
          redirect_uri: ADMIN_PAGE_URL.value(), client_id: AUTHENTIK_ADMIN_CLIENT_ID }),
      });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) {
        res.status(401).json({ error: 'That sign-in didn’t go through - try again.' });
        return;
      }
      const ur = await fetch(`${AUTHENTIK_URL.value()}/application/o/userinfo/`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
      const info = await ur.json();
      email = String(info.email || '').trim().toLowerCase();
    } catch (e) {
      console.error('adminPasskeySignIn: Authentik exchange failed', e);
      res.status(502).json({ error: 'Could not reach the sign-in server - try again shortly.' });
      return;
    }
    if (!ADMIN_EMAILS.includes(email)) {
      console.warn(`adminPasskeySignIn refused for ${email || '(no email)'}`);
      res.status(403).json({ error: 'That account can’t see the dashboard.' });
      return;
    }
    const link = await getAuth().generateSignInWithEmailLink(email, { url: ADMIN_PAGE_URL.value(), handleCodeInApp: true });
    console.log(`Admin passkey sign-in for ${email}`);
    res.json({ email, link });
  }
);
