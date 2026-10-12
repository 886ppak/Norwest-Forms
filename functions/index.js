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
const NEXTCLOUD_REPORTS_PATH = defineString('NEXTCLOUD_REPORTS_PATH', { default: '/Norwest Issues' });
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
      await ncEnsureFolder(base);
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
