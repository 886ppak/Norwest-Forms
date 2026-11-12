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
// Does a file already exist? (HEAD on WebDAV: 200 yes, 404 no.)
async function ncFileExists(davPath) {
  const res = await fetch(ncDavUrl(davPath), { method: 'HEAD', headers: { Authorization: ncAuthHeader() } });
  return res.status === 200;
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
// Firestore keeps the usage log (submissions/) with NO expiry since
// 2026-11-06 - the owner chose to keep everything until logging is switched
// off - and the admin dashboard reads it live from there. This weekly
// archive (Sunday 11:00 Perth) is therefore a backup and a spreadsheet-
// friendly copy rather than the only long-term record. It writes each
// month's rows to Nextcloud:
//   <NEXTCLOUD_REPORTS_PATH>/Usage/usage-YYYY-MM.csv
// Only the current and previous Perth month are rewritten (whole file each
// time - WebDAV has no append), so older months' files are never touched.
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

// ---- Daily archive: Firestore detail -> Nextcloud, before TTL deletes it --
// Both collections keep detail 90 days in Firestore (expireAt + TTL) and the
// owner's dashboard reads that window. This runs daily and, for every month
// that still has rows, rewrites that month's full-detail CSV in Nextcloud and
// a small permanent monthly-totals file. Old detail therefore survives in
// Nextcloud for good, and the dashboard's "older months" are read from those
// totals (owner chose monthly totals over full old detail, 6 Nov 2026).
//
// WHY DAILY AND NOT ONCE A MONTH: TTL deletion is neither instant nor exact,
// so a monthly-only job could lose rows if a single run failed. This always
// re-exports a month that still has rows in Firestore and only stops touching
// a month once Firestore has nothing left in it - by then its file is
// complete. A failed run therefore self-heals the next day.
//
// Files (in NEXTCLOUD_REPORTS_PATH/Usage):
//   logs-submissions-YYYY-MM.csv  full detail, one row per submission
//   logs-usage-YYYY-MM.csv        full detail, one row per usage event
//   totals-YYYY-MM.csv            permanent aggregate: per-day counts, plus
//                                 per-person/per-form totals for submissions
const ARCHIVE_MONTHS_BACK = 4;   // a 90-day TTL can only reach ~4 months

// Perth month key ("2026-11") for a Date, and the last n month keys, newest first
function perthMonthKey(date) {
  const p = perthParts(date);
  return `${p.y}-${String(p.m).padStart(2, '0')}`;
}
function monthKeysBack(n) {
  const now = perthParts(new Date());
  const out = [];
  for (let i = 0; i < n; i++) {
    let y = now.y, m = now.m - i;
    while (m < 1) { m += 12; y -= 1; }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

// Aggregate one month into metric,item,value rows - the shape the dashboard
// reads for months older than its live 90-day window.
function monthlyTotals(subRows, evRows) {
  const rows = [['metric', 'item', 'value']];
  const subDays = {}, formCount = {}, personDays = {}, companyCount = {};
  let late = 0;
  subRows.forEach(r => {
    const day = r.perthTime.slice(0, 10);
    subDays[day] = (subDays[day] || 0) + 1;
    formCount[r.formType] = (formCount[r.formType] || 0) + 1;
    if (r.company) companyCount[r.company] = (companyCount[r.company] || 0) + 1;
    if (r.name) personDays[r.name.toLowerCase()] = (personDays[r.name.toLowerCase()] || 0) + 1;
    if (r.late) late += 1;
  });
  const openDays = {}, impDays = {}, devices = new Set(), impDevices = new Set(), dlDevices = new Set();
  let opens = 0, imports = 0, jobs = 0, viaShare = 0, downloads = 0;
  const dlForms = {};
  evRows.forEach(r => {
    const day = r.perthTime.slice(0, 10);
    if (r.kind === 'open') {
      opens += 1; openDays[day] = (openDays[day] || 0) + 1;
      if (r.device) devices.add(r.device);
    } else if (r.kind === 'download') {
      // a PDF saved without submitting: counted separately from sent forms
      downloads += 1; if (r.device) dlDevices.add(r.device);
      dlForms[r.formType || '?'] = (dlForms[r.formType || '?'] || 0) + 1;
    } else if (r.kind === 'calimport') {
      imports += 1; impDays[day] = (impDays[day] || 0) + 1;
      jobs += Number(r.jobs) || 0;
      if (r.via === 'share') viaShare += 1;
      if (r.device) impDevices.add(r.device);
    }
  });
  rows.push(['submissions_total', '', subRows.length]);
  rows.push(['submissions_late', '', late]);
  rows.push(['submission_people', '', Object.keys(personDays).length]);
  Object.entries(formCount).sort().forEach(([k, n]) => rows.push(['submission_form', k, n]));
  Object.entries(companyCount).sort().forEach(([k, n]) => rows.push(['submission_company', k, n]));
  rows.push(['app_opens', '', opens]);
  rows.push(['app_devices', '', devices.size]);
  rows.push(['pdf_downloads', '', downloads]);
  rows.push(['pdf_download_devices', '', dlDevices.size]);
  Object.entries(dlForms).sort().forEach(([k, n]) => rows.push(['pdf_download_form', k, n]));
  rows.push(['cal_imports', '', imports]);
  rows.push(['cal_import_devices', '', impDevices.size]);
  rows.push(['cal_import_jobs', '', jobs]);
  rows.push(['cal_import_shared_in', '', viaShare]);
  rows.push(['cal_import_pasted', '', imports - viaShare]);
  Object.entries(openDays).sort().forEach(([d, n]) => rows.push(['opens_day', d, n]));
  Object.entries(impDays).sort().forEach(([d, n]) => rows.push(['imports_day', d, n]));
  Object.entries(subDays).sort().forEach(([d, n]) => rows.push(['submissions_day', d, n]));
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function archiveUsageDaily() {
  const db = getFirestore();
  const base = NEXTCLOUD_REPORTS_PATH.value().replace(/\/+$/, '');
  const dir = `${base}/Usage`;
  let level = '';
  for (const part of dir.split('/').filter(Boolean)) { level += '/' + part; await ncEnsureFolder(level); }

  const months = monthKeysBack(ARCHIVE_MONTHS_BACK);
  const earliest = months[months.length - 1] + '-01';
  // Perth midnight on the 1st of the oldest month we care about
  const since = Timestamp.fromDate(new Date(`${earliest}T00:00:00+08:00`));

  const subsSnap = await db.collection('submissions').where('submittedAt', '>=', since).get();
  const eventsSnap = await db.collection('usageEvents').where('at', '>=', since).get();

  const subRows = {}, evRows = {};
  months.forEach(k => { subRows[k] = []; evRows[k] = []; });

  subsSnap.forEach(doc => {
    const r = doc.data();
    if (r.company === 'TEST') return;                       // Oct 2026 rules-check record
    const at = r.submittedAt?.toDate ? r.submittedAt.toDate() : null;
    if (!at) return;
    const key = perthMonthKey(at);
    if (!subRows[key]) return;
    const w = payWeek(at);
    const p = perthParts(at);
    subRows[key].push({
      at, perthTime: p.iso.slice(0, 16).replace('T', ' '), weekEnding: w.weekEnding, late: w.late,
      formType: r.formType || '', company: r.company || '', name: (r.name || '').trim(), ip: r.ip || '',
    });
  });
  eventsSnap.forEach(doc => {
    const r = doc.data();
    const at = r.at?.toDate ? r.at.toDate() : null;
    if (!at) return;
    const key = perthMonthKey(at);
    if (!evRows[key]) return;
    evRows[key].push({
      at, perthTime: perthParts(at).iso.slice(0, 16).replace('T', ' '),
      formType: r.formType || '', name: r.name || '',
      kind: r.kind || '', device: r.device || '', appVersion: r.appVersion || '',
      installed: r.inst ? 'yes' : 'no', via: r.via || '',
      jobs: r.jobs == null ? '' : r.jobs, company: r.company || '',
    });
  });

  // Write a detail log, but never let it shrink. Records start expiring 90
  // days after they are written, so a month's file is at its fullest just
  // before that; a later run would hand us a subset and quietly throw detail
  // away. Keeping the longest version means the archive ends up with the
  // complete month.
  const writeDetail = async (name, header, lines) => {
    const davPath = `${dir}/${name}`;
    const existing = await ncDownload(davPath);
    const existingRows = existing ? existing.trim().split(/\r?\n/).length - 1 : -1;
    if (lines.length < existingRows) {
      written.push(`${name} kept: ${existingRows} rows (had ${lines.length})`);
      return;
    }
    const csv = [header.join(','), ...lines].join('\r\n') + '\r\n';
    await ncUpload(davPath, Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8');
    written.push(`${name}: ${lines.length}`);
  };

  const written = [];
  for (const key of months) {
    if (subRows[key].length) {
      subRows[key].sort((a, b) => a.at - b.at);
      const header = ['perth_time', 'week_ending', 'late', 'form', 'company', 'name', 'ip'];
      const lines = subRows[key].map(r => [r.perthTime, r.weekEnding, r.late ? 'yes' : '', r.formType, r.company, r.name, r.ip].map(csvCell).join(','));
      await writeDetail(`logs-submissions-${key}.csv`, header, lines);
    }
    if (evRows[key].length) {
      evRows[key].sort((a, b) => a.at - b.at);
      const header = ['perth_time', 'kind', 'device', 'app_version', 'installed', 'via', 'jobs', 'company', 'form', 'name'];
      const lines = evRows[key].map(r => [r.perthTime, r.kind, r.device, r.appVersion, r.installed, r.via, r.jobs, r.company, r.formType, r.name].map(csvCell).join(','));
      await writeDetail(`logs-usage-${key}.csv`, header, lines);
    }
    // Permanent monthly totals, rewritten from whatever detail is still in
    // Firestore. Once a month has fully expired the file must NOT be rewritten
    // with zeros - that would wipe the long-term record the dashboard reads.
    // So an empty month is only written when there is nothing there yet
    // (months from before the app was used).
    const monthHasRows = subRows[key].length || evRows[key].length;
    if (monthHasRows || !(await ncFileExists(`${dir}/totals-${key}.csv`))) {
      await ncUpload(`${dir}/totals-${key}.csv`, Buffer.from(monthlyTotals(subRows[key], evRows[key]), 'utf8'), 'text/csv; charset=utf-8');
      written.push(`totals-${key}${monthHasRows ? '' : ' (empty)'}`);
    } else {
      // No records left for this month (expired, or never had any); leave the
      // permanent totals exactly as they are.
      written.push(`totals-${key} kept`);
    }
  }
  console.log('Daily usage archive: ' + written.join(', '));
  return written;
}

exports.archiveUsageDaily = onSchedule(
  { schedule: '30 2 * * *', timeZone: 'Australia/Perth', region: REGION, secrets: [NEXTCLOUD_APP_PASSWORD], timeoutSeconds: 300 },
  async () => { await archiveUsageDaily(); }
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

// ---- archived monthly totals, read back by the dashboard ----------------
// admin.html is a static public page, so it cannot hold the Nextcloud app
// password. This hands it the permanent monthly-totals files from the Usage
// folder once it proves who it is: a Firebase ID token whose email is an
// admin. The dashboard uses these for months older than its live 90-day
// window, so "all time" keeps meaning all time instead of "all 90 days".
// Detail (per person, per day) stays in the live window by design - the
// archive carries monthly totals only.
const ARCHIVE_MONTHS_SHOWN = 24;

async function ncDownload(davPath) {
  const res = await fetch(ncDavUrl(davPath), { headers: { Authorization: ncAuthHeader() } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${davPath} failed: ${res.status}`);
  return res.text();
}

// Minimal CSV split - company names are NCH/NWP today, but csvCell could
// quote them, so handle quotes rather than assuming no commas.
function csvSplit(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') { q = true; } else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseTotalsCsv(text) {
  const map = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [metric, item, value] = csvSplit(line);
    if (!metric || metric === 'metric') continue;              // header
    const key = item ? `${metric}|${item}` : metric;
    map[key] = Number(value) || 0;
  }
  return map;
}

exports.usageArchive = onRequest(
  { region: REGION, invoker: 'public', secrets: [NEXTCLOUD_APP_PASSWORD], timeoutSeconds: 60 },
  async (req, res) => {
    const origin = new URL(ADMIN_PAGE_URL.value()).origin;
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Access-Control-Allow-Headers', 'Authorization');
      res.set('Access-Control-Max-Age', '3600');
      res.status(204).send('');
      return;
    }
    if (req.method !== 'GET') { res.status(405).send('Method Not Allowed'); return; }

    const auth = String(req.get('Authorization') || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'Sign in first' }); return; }
    let email;
    try {
      email = String((await getAuth().verifyIdToken(token)).email || '').toLowerCase();
    } catch (e) {
      res.status(401).json({ error: 'Sign in again' });
      return;
    }
    if (!ADMIN_EMAILS.includes(email)) { res.status(403).json({ error: 'Not an admin account' }); return; }

    const dir = `${NEXTCLOUD_REPORTS_PATH.value().replace(/\/+$/, '')}/Usage`;
    const months = [];
    try {
      for (const key of monthKeysBack(ARCHIVE_MONTHS_SHOWN)) {
        const csv = await ncDownload(`${dir}/totals-${key}.csv`);
        if (!csv) continue;                       // month never archived (app unused)
        const t = parseTotalsCsv(csv);
        const m = {
          month: key,
          opens: t.app_opens || 0,
          imports: t.cal_imports || 0,
          jobs: t.cal_import_jobs || 0,
          submissions: t.submissions_total || 0,
          people: t.submission_people || 0,
          devices: t.app_devices || 0,
        };
        // The archiver writes a file for every month it looks back over, so
        // months before the app was used exist but are all zeros. Skip those
        // rather than showing a row of noughts.
        if (m.opens || m.imports || m.submissions) months.push(m);
      }
    } catch (e) {
      console.error('usageArchive: read failed', e);
      res.status(502).json({ error: 'Could not read the archive' });
      return;
    }
    res.json({ months });
  }
);

// ---- NCH Forms sign-in + calendar sync (v1.53) -------------------------
// Sign-in: passkey on signin.15buzza.au (Authentik app norwest-forms, public PKCE, no secret).
// nchPasskeySignIn swaps the code for the account's email and hands back a signed session
// token (HMAC, 90 days). The phone never gets a Firebase login; it only carries this token,
// which the calendar functions verify. Calendar data lives in Firestore nchUsers/{email}
// (admin SDK only; firestore.rules deny everything else to clients).
// Set the secret once before deploying:  firebase functions:secrets:set NCH_SESSION_SECRET
const { createHmac, timingSafeEqual, randomBytes } = require('crypto');
const NCH_AUTH_URL = defineString('NCH_AUTH_URL', { default: 'https://signin.15buzza.au' });
const NCH_PAGE_URL = defineString('NCH_PAGE_URL', { default: 'https://886ppak.github.io/Norwest-Forms/' });
const NCH_CLIENT_ID = 'FwUq7HZ6147XZ6hjOl6G37Z0MQJWPJ0EQPRRcNJt';
const NCH_SESSION_SECRET = defineSecret('NCH_SESSION_SECRET');
const NCH_SESSION_DAYS = 90;
// The five calendar stores the phone keeps in localStorage. Nothing else is synced.
const NCH_STORES = ['norwestCalJobs', 'norwestCalRoster', 'norwestCalOvr', 'norwestCalLeave', 'norwestCalName', 'norwestProfile'];

function nchSign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', NCH_SESSION_SECRET.value()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function nchVerify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const want = createHmac('sha256', NCH_SESSION_SECRET.value()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp && Date.now() < p.exp ? p : null;
}
function nchCors(req, res) {
  res.set('Access-Control-Allow-Origin', new URL(NCH_PAGE_URL.value()).origin);
  res.set('Vary', 'Origin');
  if (req.method !== 'OPTIONS') return false;
  res.set('Access-Control-Allow-Methods', 'POST, GET');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
  res.status(204).send('');
  return true;
}
function nchEmailFrom(req) {
  const m = (req.get('Authorization') || '').match(/^Bearer (.+)$/);
  const p = m && nchVerify(m[1]);
  return p ? p.email : null;
}
function nchDoc(email) {
  return getFirestore().collection('nchUsers').doc(email);
}

exports.nchPasskeySignIn = onRequest(
  { region: REGION, invoker: 'public', secrets: [NCH_SESSION_SECRET] },
  async (req, res) => {
    if (nchCors(req, res)) return;
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const { code, codeVerifier } = req.body || {};
    if (typeof code !== 'string' || typeof codeVerifier !== 'string' || code.length > 512 || codeVerifier.length > 256) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    let info;
    try {
      const base = NCH_AUTH_URL.value();
      const tr = await fetch(`${base}/application/o/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier,
          redirect_uri: NCH_PAGE_URL.value(), client_id: NCH_CLIENT_ID }),
      });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) {
        res.status(401).json({ error: 'That sign-in didn’t go through. Try again.' });
        return;
      }
      const ur = await fetch(`${base}/application/o/userinfo/`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
      info = await ur.json();
    } catch (e) {
      console.error('nchPasskeySignIn: Authentik exchange failed', e);
      res.status(502).json({ error: 'Could not reach the sign-in server. Try again shortly.' });
      return;
    }
    const email = String(info.email || info.preferred_username || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(403).json({ error: 'No email on that account.' });
      return;
    }
    const name = String(info.name || '').trim().slice(0, 120);
    const token = nchSign({ email, exp: Date.now() + NCH_SESSION_DAYS * 86400000 });
    res.json({ token, email, name });
  }
);

exports.nchCalendarGet = onRequest(
  { region: REGION, invoker: 'public', secrets: [NCH_SESSION_SECRET] },
  async (req, res) => {
    if (nchCors(req, res)) return;
    const email = nchEmailFrom(req);
    if (!email) { res.status(401).json({ error: 'Sign in again.' }); return; }
    const [snap, gsnap] = await Promise.all([nchDoc(email).get(), gmailDoc(email).get()]);
    const data = snap.exists ? snap.data() : {};
    const g = gsnap.exists ? gsnap.data() : null;
    // Gmail summary for the phone: the jobs only, never the token or the processed ids.
    const gmail = g ? { connected: true, status: g.status || 'ok', jobs: g.jobs || [] } : { connected: false, status: 'none', jobs: [] };
    res.json({ stores: data.stores || {}, gmail });
  }
);

// Per-store merge: a store is replaced only when the incoming copy is newer than the stored one.
exports.nchCalendarPut = onRequest(
  { region: REGION, invoker: 'public', secrets: [NCH_SESSION_SECRET] },
  async (req, res) => {
    if (nchCors(req, res)) return;
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const email = nchEmailFrom(req);
    if (!email) { res.status(401).json({ error: 'Sign in again.' }); return; }
    const incoming = (req.body && req.body.stores) || {};
    const clean = {};
    for (const key of NCH_STORES) {
      const item = incoming[key];
      if (!item) continue;
      const value = item.value === null ? null : String(item.value);
      if (value !== null && value.length > 400000) { res.status(413).json({ error: 'Too much data in one store.' }); return; }
      clean[key] = { value, updatedAt: Number(item.updatedAt) || 0 };
    }
    const ref = nchDoc(email);
    const merged = await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const stores = (snap.exists && snap.data().stores) || {};
      for (const [key, item] of Object.entries(clean)) {
        const cur = stores[key];
        if (!cur || item.updatedAt > (cur.updatedAt || 0)) stores[key] = item;
      }
      tx.set(ref, { stores, email, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return stores;
    });
    res.json({ stores: merged });
  }
);

// Daily copy of every signed-in calendar to Nextcloud: <REPORTS_PATH>/Calendars/<email>.json
exports.nchCalendarBackup = onSchedule(
  { schedule: '15 3 * * *', timeZone: 'Australia/Perth', region: REGION, secrets: [NEXTCLOUD_APP_PASSWORD], timeoutSeconds: 300 },
  async () => {
    const base = NEXTCLOUD_REPORTS_PATH.value().replace(/\/+$/, '');
    const dir = `${base}/Calendars`;
    await ncEnsureFolder(dir);
    const docs = await getFirestore().collection('nchUsers').get();
    let n = 0;
    for (const d of docs.docs) {
      const payload = { email: d.id, exportedAt: new Date().toISOString(), stores: d.data().stores || {} };
      await ncUpload(`${dir}/${d.id}.json`, Buffer.from(JSON.stringify(payload, null, 2)), 'application/json');
      n++;
    }
    console.log(`nchCalendarBackup wrote ${n} calendar(s)`);
  }
);

// ===== Gmail job import (multi-user, Google Testing mode) =====
// Each signed-in NCH user can connect their own Gmail (read-only). The hourly
// scan reads their mobilisation emails, keeps only their own job rows, and
// stores them in nchGmail/{email}. nchCalendarGet hands them to the phone.
// Logic lives in gmail-core.js (tested offline). Set secrets before deploying:
//   firebase functions:secrets:set GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GMAIL_TOKEN_KEY
const gmailCore = require('./gmail-core.js');
const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const GMAIL_TOKEN_KEY = defineSecret('GMAIL_TOKEN_KEY');
const NCH_GMAIL_CALLBACK_URL = defineString('NCH_GMAIL_CALLBACK_URL', {
  default: `https://${REGION}-norwest-forms.cloudfunctions.net/nchGmailCallback`,
});
const NCH_GMAIL_QUERY = defineString('NCH_GMAIL_QUERY', {
  default: 'newer_than:120d (subject:mobilisation OR subject:"travel confirmation" OR subject:mobe)',
});
const GMAIL_SECRETS = [NCH_SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_TOKEN_KEY];
// Only these accounts may connect Gmail for now (owner only). Widen when ready.
const GMAIL_ALLOWED = ['myslewer@gmail.com', 'aiden.tunupopo@gmail.com'];

function gmailDoc(email) {
  return getFirestore().collection('nchGmail').doc(email);
}

// The name to look for on the email: the one the person set in their profile on the phone.
function nchNameFrom(data) {
  const stores = (data && data.stores) || {};
  try {
    const p = stores.norwestProfile && JSON.parse(stores.norwestProfile.value || '{}');
    if (p && p.name) return String(p.name).trim();
  } catch (e) { /* fall through */ }
  const raw = stores.norwestCalName && stores.norwestCalName.value;
  if (!raw) return '';
  try { const v = JSON.parse(raw); return typeof v === 'string' ? v.trim() : ''; }
  catch (e) { return String(raw).trim(); }
}

// Step 1: the phone asks for a Google sign-in link. Returns the URL to open.
exports.nchGmailStart = onRequest(
  { region: REGION, invoker: 'public', secrets: GMAIL_SECRETS },
  async (req, res) => {
    if (nchCors(req, res)) return;
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const email = nchEmailFrom(req);
    if (!email) { res.status(401).json({ error: 'Sign in again.' }); return; }
    if (!GMAIL_ALLOWED.includes(email)) { res.status(403).json({ error: 'Gmail import is not open to your account yet.' }); return; }
    const state = nchSign({ purpose: 'gmail', email, nonce: randomBytes(12).toString('base64url'), exp: Date.now() + 10 * 60000 });
    const url = gmailCore.buildAuthUrl({
      clientId: GOOGLE_CLIENT_ID.value(), redirectUri: NCH_GMAIL_CALLBACK_URL.value(), state,
    });
    res.json({ url });
  }
);

// Step 2: Google sends the person back here with a code. Exchange it and store the refresh token encrypted.
exports.nchGmailCallback = onRequest(
  { region: REGION, invoker: 'public', secrets: GMAIL_SECRETS },
  async (req, res) => {
    const back = (q) => res.redirect(302, NCH_PAGE_URL.value() + '?gmail=' + q);
    const st = nchVerify(String(req.query.state || ''));
    if (!st || st.purpose !== 'gmail' || !st.email) { res.status(400).send('That link has expired. Start again from the app.'); return; }
    if (req.query.error) { back('denied'); return; }
    const x = await gmailCore.exchangeCode({
      code: String(req.query.code || ''), clientId: GOOGLE_CLIENT_ID.value(), clientSecret: GOOGLE_CLIENT_SECRET.value(),
      redirectUri: NCH_GMAIL_CALLBACK_URL.value(), fetchFn: fetch,
    });
    if (!x.ok) { back(x.reason === 'invalid_grant' ? 'retry' : 'failed'); return; }
    await gmailDoc(st.email).set({
      email: st.email,
      refreshTokenBlob: gmailCore.encryptToken(x.refreshToken, GMAIL_TOKEN_KEY.value()),
      status: 'ok',
      connectedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    back('connected');
  }
);

// Disconnect: revoke at Google, delete the token and every Gmail-derived job.
// Remove one imported job for good: stored as dismissed so the weekly scan never adds it back.
exports.nchGmailDismiss = onRequest(
  { region: REGION, invoker: 'public', secrets: GMAIL_SECRETS },
  async (req, res) => {
    if (nchCors(req, res)) return;
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const email = nchEmailFrom(req);
    if (!email) { res.status(401).json({ error: 'Sign in again.' }); return; }
    if (!GMAIL_ALLOWED.includes(email)) { res.status(403).json({ error: 'Gmail import is not open to your account yet.' }); return; }
    const key = req.body && req.body.key;
    if (typeof key !== 'string' || key.length < 3 || key.length > 300) { res.status(400).json({ error: 'Bad job key.' }); return; }
    const ref = gmailDoc(email);
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const dismissed = Array.from(new Set([...(data.dismissed || []), key])).slice(-500);
      const jobs = (data.jobs || []).filter(j => gmailCore.jobIdentity(j) !== key);
      tx.set(ref, { dismissed, jobs }, { merge: true });
    });
    res.json({ ok: true });
  }
);

exports.nchGmailDisconnect = onRequest(
  { region: REGION, invoker: 'public', secrets: GMAIL_SECRETS },
  async (req, res) => {
    if (nchCors(req, res)) return;
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    const email = nchEmailFrom(req);
    if (!email) { res.status(401).json({ error: 'Sign in again.' }); return; }
    const ref = gmailDoc(email);
    const snap = await ref.get();
    if (snap.exists && snap.data().refreshTokenBlob) {
      try {
        await gmailCore.revokeToken(gmailCore.decryptToken(snap.data().refreshTokenBlob, GMAIL_TOKEN_KEY.value()), fetch);
      } catch (e) { /* still delete locally */ }
    }
    await ref.delete();
    res.json({ ok: true });
  }
);

// Weekly (Sun 03:17 Perth, before timesheets are done): every connected account, read its mail, keep its own rows. Errors are per account.
exports.nchGmailScan = onSchedule(
  { schedule: '17 3 * * 0', timeZone: 'Australia/Perth', region: REGION, secrets: GMAIL_SECRETS, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    const accounts = await db.collection('nchGmail').get();
    for (const doc of accounts.docs) {
      const email = doc.id;
      const data = doc.data();
      if (!data.refreshTokenBlob) continue;
      try {
        const userSnap = await db.collection('nchUsers').doc(email).get();
        const name = nchNameFrom(userSnap.exists ? userSnap.data() : {});
        const r = await gmailCore.scanAccount(
          { refreshTokenBlob: data.refreshTokenBlob, name, processedIds: data.processedIds || [], jobs: data.jobs || [], dismissed: data.dismissed || [] },
          { fetchFn: fetch, clientId: GOOGLE_CLIENT_ID.value(), clientSecret: GOOGLE_CLIENT_SECRET.value(),
            tokenKeySecret: GMAIL_TOKEN_KEY.value(), query: NCH_GMAIL_QUERY.value() }
        );
        await doc.ref.set({
          status: r.status,
          lastRunAt: FieldValue.serverTimestamp(),
          lastError: r.lastError || FieldValue.delete(),
          processedIds: r.processedIds,
          jobs: r.jobs,
        }, { merge: true });
      } catch (e) {
        // Log the error type only: never message text or emails.
        console.error('nchGmailScan: one account failed', String(e && e.message || e).slice(0, 120));
        await doc.ref.set({ status: 'error', lastRunAt: FieldValue.serverTimestamp(), lastError: 'scan failed' }, { merge: true });
      }
    }
  }
);
