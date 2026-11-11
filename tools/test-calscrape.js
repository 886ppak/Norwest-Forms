// Tests the Apps Script scraper's pure logic on the built file. Run: node tools/test-calscrape.js
const assert = require('assert');
const { build } = require('./build-calscrape.js');
const F = require('./calscrape-fixtures.js');
const lib = new Function(build() + '\n;return {calParseEmail, csJobItems, csJobKey_};')();
const who = 'Aiden Amur';
let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
}

ok('PSA: one job, items = shift span + MOB + DMOB + SD/FD', () => {
  const r = lib.calParseEmail(F.psa, who, 'HIO Travel Confirmation');
  assert.ok(r.jobs, r.error);
  const items = lib.csJobItems(r.jobs[0]);
  const byKey = Object.fromEntries(items.map(i => [i.key.split('|').pop(), i]));
  assert.strictEqual(items.length, 4);
  assert.strictEqual(byKey.shift.title, 'DS 30234 PSA');
  assert.strictEqual(byKey.shift.start, '2026-07-29');
  assert.strictEqual(byKey.shift.end, '2026-08-03');
  assert.strictEqual(byKey.mob.start, '2026-07-29');
  assert.strictEqual(byKey.demob.start, '2026-08-04');
  assert.strictEqual(byKey.sd.start, '2026-07-30');
  assert.ok(!/RH118877|Person/.test(JSON.stringify(items)), 'other workers leaked');
});

ok('BHP: site falls back to the email subject, no VD in title', () => {
  const r = lib.calParseEmail(F.bhp, who, 'BHP Whaleback - High Capacity Digger');
  const shift = lib.csJobItems(r.jobs[0]).find(i => i.key.endsWith('|shift'));
  assert.strictEqual(shift.title, 'DS BHP Whaleback - High Capacity Digger');
  assert.ok(shift.description.includes('Commute: DIDO'));
});

ok('item keys are unique and match the PWA job key', () => {
  const r = lib.calParseEmail(F.psa, who, '');
  const items = lib.csJobItems(r.jobs[0]);
  assert.strictEqual(new Set(items.map(i => i.key)).size, items.length);
  assert.strictEqual(lib.csJobKey_(r.jobs[0]), ['30234', '2026-07-29', '2026-07-29', '2026-08-03', 'DS', 'CO Operator - 220T CRWL'].join('|'));
});

ok('same job pasted twice gives the same keys (no duplicates on re-run)', () => {
  const a = lib.csJobItems(lib.calParseEmail(F.fmgLines, who, '').jobs[0]).map(i => i.key);
  const b = lib.csJobItems(lib.calParseEmail(F.fmgLines, who, '').jobs[0]).map(i => i.key);
  assert.deepStrictEqual(a, b);
});

ok('contact list row produces no items', () => {
  const r = lib.calParseEmail(F.contact, who, '');
  assert.ok(!r.jobs);
});

ok('FMG one-line-per-cell: single-day job gives shift + MOB + DMOB', () => {
  const items = lib.csJobItems(lib.calParseEmail(F.fmgLines, who, '').jobs[0]);
  assert.ok(items.some(i => i.key.endsWith('|shift') && i.start === '2026-09-02' && i.end === '2026-09-02'));
});

console.log(`\n${pass} passed`);
