#!/usr/bin/env node
// Prints the usage log (Firestore `submissions` in the norwest-forms Firebase
// project) in Perth time, with a per-week summary.
//
// Needs the project's service account JSON in the env var
// NORWEST_FORMS_SERVICE_ACCOUNT (Firebase console → Project settings →
// Service accounts → Generate new private key). Never commit that key.
//
//   NORWEST_FORMS_SERVICE_ACCOUNT="$(cat key.json)" node tools/usage-stats.mjs
//
// Read-only: it never writes or deletes anything.
import crypto from 'crypto';

const raw = process.env.NORWEST_FORMS_SERVICE_ACCOUNT;
if (!raw) { console.error('Set NORWEST_FORMS_SERVICE_ACCOUNT to the service account JSON.'); process.exit(1); }
const sa = JSON.parse(raw);

// Service-account OAuth: sign a JWT and swap it for an access token
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
  iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
const jwt = unsigned + '.' + crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
const tj = await tr.json();
if (!tj.access_token) { console.error('Auth failed', tr.status, JSON.stringify(tj)); process.exit(1); }

let docs = [], pageToken = '';
do {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/submissions?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`,
    { headers: { Authorization: 'Bearer ' + tj.access_token } });
  const j = await r.json();
  if (!r.ok) { console.error('Read failed', r.status, JSON.stringify(j)); process.exit(1); }
  docs.push(...(j.documents || [])); pageToken = j.nextPageToken || '';
} while (pageToken);

const rows = docs.map(d => Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, Object.values(v)[0]])))
  .filter(r => r.company !== 'TEST')          // the Oct 2026 rules-check record
  .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

// Perth = AWST, UTC+8, no daylight saving
const perth = iso => new Date(new Date(iso).getTime() + 8 * 3600e3);
const fmt = d => d.toUTCString().slice(0, 3) + ' ' + d.toISOString().slice(0, 16).replace('T', ' ');

console.log(`${rows.length} submission(s)\n`);
for (const r of rows) {
  console.log(`${fmt(perth(r.submittedAt))} AWST | ${r.formType.padEnd(9)} | ${r.company} | ${r.name || '(no name - medical form)'}`);
}

// Timesheets are for the week ending Sunday, due by Monday 10am Perth.
// A submission belongs to the week ending on the Sunday before its Monday:
// Tue..Mon -> that Sunday (Monday after 10am counts as late).
const weeks = {};
for (const r of rows) {
  const d = perth(r.submittedAt);
  const e = new Date(d); e.setUTCDate(e.getUTCDate() - 1);           // Mon -> Sun
  e.setUTCDate(e.getUTCDate() + ((7 - e.getUTCDay()) % 7));          // next Sunday on/after
  const key = e.toISOString().slice(0, 10);
  (weeks[key] ||= []).push({ ...r, late: d.getUTCDay() === 1 && (d.getUTCHours() >= 10) });
}
console.log('\nPer pay week:');
for (const [weekEnding, list] of Object.entries(weeks)) {
  const people = new Set(list.map(r => (r.name || '').trim().toLowerCase()).filter(Boolean));
  const byForm = list.reduce((a, r) => (a[r.formType] = (a[r.formType] || 0) + 1, a), {});
  const late = list.filter(r => r.late).map(r => r.name);
  console.log(`  week ending Sun ${weekEnding}: ${list.length} submission(s), ${people.size} named people, ` +
    `forms ${JSON.stringify(byForm)}, late (after Mon 10am): ${late.length ? late.join(', ') : 'none'}`);
}
