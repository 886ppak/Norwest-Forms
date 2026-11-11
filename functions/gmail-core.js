// Gmail job import for NCH Forms: the parts that do not need Firebase.
// index.js wires these to Firestore and the scheduler; tests mock fetch.
//
// Privacy: only parsed job rows leave this module. Raw bodies are read,
// parsed and dropped. Nothing here logs message text.
const crypto = require('crypto');
const { calParseEmail } = require('./calparser.js');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_PROCESSED = 500;     // message ids remembered per account
const MAX_THREADS = 100;       // threads read per scan

// ---- token encryption (AES-256-GCM; key = sha256 of the GMAIL_TOKEN_KEY secret)
function tokenKey(secret) {
  if (!secret || String(secret).length < 16) throw new Error('GMAIL_TOKEN_KEY is missing or too short');
  return crypto.createHash('sha256').update(String(secret)).digest();
}
function encryptToken(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', tokenKey(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
}
function decryptToken(blob, secret) {
  const parts = String(blob || '').split('.');
  if (parts.length !== 3) throw new Error('bad token blob');
  const [iv, tag, ct] = parts.map(s => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', tokenKey(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---- OAuth
function buildAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',          // always returns a refresh token
    include_granted_scopes: 'false',
    state,
  }).toString();
  return u.toString();
}

// Returns {ok:true, refreshToken} or {ok:false, reason} where reason is 'invalid_grant' or 'error'.
async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchFn }) {
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return { ok: false, reason: j.error === 'invalid_grant' ? 'invalid_grant' : 'error' };
  return { ok: true, refreshToken: j.refresh_token };
}

// Returns {ok:true, accessToken} or {ok:false, reason:'invalid_grant'|'error'}.
// invalid_grant = the person must connect again (Testing-mode weekly expiry, password change, revoked).
async function accessTokenFor(refreshToken, { clientId, clientSecret, fetchFn }) {
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return { ok: false, reason: j.error === 'invalid_grant' ? 'invalid_grant' : 'error' };
  return { ok: true, accessToken: j.access_token };
}

async function revokeToken(refreshToken, fetchFn) {
  try {
    await fetchFn('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch (e) { /* best effort: the local delete still happens */ }
}

// ---- Gmail reads
async function gmailGet(accessToken, path, fetchFn) {
  const r = await fetchFn('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) throw new Error('gmail ' + r.status);
  return r.json();
}

function decodeB64url(s) { return Buffer.from(String(s || ''), 'base64url').toString('utf8'); }

// Plain text of a Gmail message payload. Falls back to HTML with table cells split by two spaces,
// which is how calCells expects columns.
function plainTextOf(payload) {
  const walk = (p, want) => {
    if (!p) return '';
    if (p.mimeType === want && p.body && p.body.data) return decodeB64url(p.body.data);
    for (const c of p.parts || []) { const t = walk(c, want); if (t) return t; }
    return '';
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  return walk(payload, 'text/html')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function headerOf(payload, name) {
  const h = ((payload && payload.headers) || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}

// Scan a list of {id, subject, text} messages for one person's job rows.
// Returns {jobs, skipped, processedIds}. Pure: no I/O.
function scanMessages(messages, name) {
  const jobs = [];
  const skipped = [];
  const processedIds = [];
  for (const m of messages) {
    processedIds.push(m.id);
    const r = calParseEmail(m.text, name, m.subject);
    if (r.error || !r.jobs) { skipped.push({ id: m.id, reason: r.error ? 'name not found' : 'no job rows' }); continue; }
    for (const j of r.jobs) jobs.push(j);
  }
  return { jobs, skipped, processedIds };
}

// Same identity as the PWA's calJobKey, so a job found twice is one job.
function jobKey(j) { return [j.vd, j.mob, j.first, j.last, j.shift, j.cls].join('|'); }

// Existing jobs + new jobs: new wins for the same key. Returns a new array sorted by MOB date.
function mergeJobs(existing, incoming) {
  const map = new Map();
  for (const j of existing || []) map.set(jobKey(j), j);
  for (const j of incoming || []) map.set(jobKey(j), j);
  return [...map.values()].sort((a, b) => String(a.mob || '').localeCompare(String(b.mob || '')));
}

// One account, one scan. deps: {fetchFn, clientId, clientSecret, tokenKeySecret, query, now}
// state: {refreshTokenBlob, name, processedIds, jobs}
// Returns {status, jobs, processedIds, lastError}; status is 'ok' | 'reconnect' | 'need-name' | 'error'.
async function scanAccount(state, deps) {
  if (!state.name) return { status: 'need-name', jobs: state.jobs || [], processedIds: state.processedIds || [] };
  let refreshToken;
  try { refreshToken = decryptToken(state.refreshTokenBlob, deps.tokenKeySecret); }
  catch (e) { return { status: 'error', lastError: 'token unreadable', jobs: state.jobs || [], processedIds: state.processedIds || [] }; }

  const tok = await accessTokenFor(refreshToken, deps);
  if (!tok.ok) {
    return tok.reason === 'invalid_grant'
      ? { status: 'reconnect', jobs: state.jobs || [], processedIds: state.processedIds || [] }
      : { status: 'error', lastError: 'token refresh failed', jobs: state.jobs || [], processedIds: state.processedIds || [] };
  }

  const done = new Set(state.processedIds || []);
  // List messages first, then fetch only the ones not seen before (cheap on quiet hours).
  const list = await gmailGet(tok.accessToken, 'messages?maxResults=' + MAX_THREADS + '&q=' + encodeURIComponent(deps.query), deps.fetchFn);
  const messages = [];
  for (const ref of list.messages || []) {
    if (done.has(ref.id)) continue;
    const m = await gmailGet(tok.accessToken, 'messages/' + ref.id + '?format=full', deps.fetchFn);
    messages.push({
      id: m.id,
      subject: headerOf(m.payload, 'Subject'),
      text: plainTextOf(m.payload),
    });
  }
  const scan = scanMessages(messages, state.name);
  const remembered = [...(state.processedIds || []), ...scan.processedIds].slice(-MAX_PROCESSED);
  return {
    status: 'ok',
    jobs: mergeJobs(state.jobs, scan.jobs),
    processedIds: remembered,
    newJobs: scan.jobs.length,
    skipped: scan.skipped.length,
  };
}

module.exports = {
  GMAIL_SCOPE, MAX_PROCESSED,
  encryptToken, decryptToken,
  buildAuthUrl, exchangeCode, accessTokenFor, revokeToken,
  plainTextOf, headerOf, scanMessages, jobKey, mergeJobs, scanAccount,
};
