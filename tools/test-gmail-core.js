// Tests functions/gmail-core.js with a mocked fetch. Run: node tools/test-gmail-core.js
const assert = require('assert');
const core = require('../functions/gmail-core.js');
const F = require('./calscrape-fixtures.js');
const SECRET = 'test-secret-0123456789abcdef';
let pass = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('PASS', name); },
    e => { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; });
}
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');

(async () => {
  await ok('token encrypts, decrypts, and the blob holds no plain text', () => {
    const blob = core.encryptToken('1//refresh-abc', SECRET);
    assert.ok(!blob.includes('refresh-abc'));
    assert.strictEqual(core.decryptToken(blob, SECRET), '1//refresh-abc');
    assert.throws(() => core.decryptToken(blob, 'another-secret-0123456789'));
  });

  await ok('short or missing key is refused', () => {
    assert.throws(() => core.encryptToken('x', 'short'));
  });

  await ok('auth URL asks for read-only Gmail, offline, consent', () => {
    const u = new URL(core.buildAuthUrl({ clientId: 'cid', redirectUri: 'https://r/cb', state: 'st' }));
    assert.strictEqual(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.strictEqual(u.searchParams.get('access_type'), 'offline');
    assert.strictEqual(u.searchParams.get('prompt'), 'consent');
    assert.strictEqual(u.searchParams.get('state'), 'st');
  });

  await ok('expired refresh token (invalid_grant) means reconnect, not error', async () => {
    const fetchFn = async () => json(400, { error: 'invalid_grant' });
    const blob = core.encryptToken('old', SECRET);
    const r = await core.scanAccount({ refreshTokenBlob: blob, name: 'Aiden Amur', processedIds: [], jobs: [] },
      { fetchFn, clientId: 'c', clientSecret: 's', tokenKeySecret: SECRET, query: 'q' });
    assert.strictEqual(r.status, 'reconnect');
  });

  await ok('no name on the profile: no Gmail call at all', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return json(200, {}); };
    const r = await core.scanAccount({ refreshTokenBlob: core.encryptToken('x', SECRET), name: '' },
      { fetchFn, clientId: 'c', clientSecret: 's', tokenKeySecret: SECRET, query: 'q' });
    assert.strictEqual(r.status, 'need-name');
    assert.strictEqual(called, false);
  });

  await ok('scan: only own row kept, raw text not in the result, re-run adds nothing', async () => {
    const psaHtml = '<table><tr><td>' + F.psa.replace(/\n/g, '</td></tr><tr><td>') + '</td></tr></table>';
    const list = { messages: [{ id: 'm1' }] };
    const msg = { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'HIO Travel Confirmation' }],
      mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64(F.psa) } }] } };
    const fetchFn = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'AT' });
      if (url.includes('/messages?')) return json(200, list);
      if (url.includes('/messages/m1')) return json(200, msg);
      throw new Error('unexpected ' + url);
    };
    const deps = { fetchFn, clientId: 'c', clientSecret: 's', tokenKeySecret: SECRET, query: 'mobilisation' };
    const state = { refreshTokenBlob: core.encryptToken('rt', SECRET), name: 'Aiden Amur', processedIds: [], jobs: [] };
    const r1 = await core.scanAccount(state, deps);
    assert.strictEqual(r1.status, 'ok');
    assert.strictEqual(r1.jobs.length, 1);
    assert.strictEqual(r1.jobs[0].vd, '30234');
    assert.ok(!/RH118877|Person One|Person Two/.test(JSON.stringify(r1)), 'other workers leaked');
    assert.ok(!/Kind Regards|Please see below/.test(JSON.stringify(r1)), 'raw email text leaked');
    // second run: message already processed, so no new jobs and the list stays the same
    const r2 = await core.scanAccount({ ...state, processedIds: r1.processedIds, jobs: r1.jobs }, deps);
    assert.strictEqual(r2.newJobs, 0);
    assert.strictEqual(r2.jobs.length, 1);
    assert.deepStrictEqual(r2.processedIds, r1.processedIds);
  });

  await ok('html-only email: table cells split so the parser still reads the row', () => {
    const html = '<table><tr><td>30234</td><td>PSA</td><td>CO Operator - 220T CRWL</td><td>Aiden Amur</td><td>DS2</td><td>29/07/2026</td><td>29/07/2026</td><td>3/08/2026</td><td>4/08/2026</td><td>DRIVE SITE TO ZN</td></tr></table>';
    const text = core.plainTextOf({ mimeType: 'text/html', body: { data: b64(html) } });
    const r = core.scanMessages([{ id: 'h', subject: 'x', text }], 'Aiden Amur');
    assert.strictEqual(r.jobs.length, 1, JSON.stringify(r));
    assert.strictEqual(r.jobs[0].vd, '30234');
  });

  await ok('merge: same job key replaces, different jobs kept, sorted by MOB', () => {
    const a = { vd: '1', mob: '2026-08-01', first: '2026-08-02', last: '2026-08-03', shift: 'DS', cls: 'X', site: 'old' };
    const b = { ...a, site: 'new' };
    const c = { vd: '2', mob: '2026-07-01', first: '2026-07-02', last: '2026-07-03', shift: 'NS', cls: 'Y' };
    const m = core.mergeJobs([a], [b, c]);
    assert.strictEqual(m.length, 2);
    assert.strictEqual(m[0].vd, '2');
    assert.strictEqual(m[1].site, 'new');
  });

  await ok('removed job stays out, even if the scan finds it again', async () => {
    const a = { vd: '1', mob: '2026-08-01', first: '2026-08-02', last: '2026-08-03', shift: 'DS', cls: 'X' };
    const b = { vd: '2', mob: '2026-08-05', first: '2026-08-06', last: '2026-08-07', shift: 'NS', cls: 'Y' };
    const key = core.jobKey(a);
    const kept = core.withoutDismissed(core.mergeJobs([], [a, b]), [key]);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].vd, '2');
    // a scan that finds the cancelled job again must not bring it back
    const fetchFn = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'AT' });
      if (url.includes('/messages?')) return json(200, { messages: [{ id: 'new1' }] });
      if (url.includes('/messages/new1')) return json(200, { id: 'new1', payload: { headers: [{ name: 'Subject', value: 'x' }], mimeType: 'text/plain', body: { data: b64(F.psa) } } });
      throw new Error('unexpected ' + url);
    };
    const r = await core.scanAccount({ refreshTokenBlob: core.encryptToken('rt', SECRET), name: 'Aiden Amur', processedIds: [], jobs: [], dismissed: [key] },
      { fetchFn, clientId: 'c', clientSecret: 's', tokenKeySecret: SECRET, query: 'q' });
    assert.ok(!r.jobs.some(j => core.jobKey(j) === key), 'cancelled job came back');
  });

  await ok('processed-id memory is capped', async () => {
    const many = Array.from({ length: 600 }, (_, i) => 'id' + i);
    const fetchFn = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'AT' });
      return json(200, {});
    };
    const r = await core.scanAccount({ refreshTokenBlob: core.encryptToken('rt', SECRET), name: 'A B', processedIds: many, jobs: [] },
      { fetchFn, clientId: 'c', clientSecret: 's', tokenKeySecret: SECRET, query: 'q' });
    assert.strictEqual(r.processedIds.length, core.MAX_PROCESSED);
  });

  console.log(`\n${pass} passed`);
})();
