// Run: node functions/test-share-core.js
const assert = require('assert');
const C = require('./share-core.js');
const perth = (iso, hh) => Date.parse(`${iso}T${String(hh).padStart(2,'0')}:00:00+08:00`);
let fail = 0;
function ok(name, fn){ try{ fn(); console.log('PASS', name); } catch(e){ fail++; console.log('FAIL', name, '\n  ', e.message); } }

ok('pay week starts on Monday (Sunday belongs to the week before)', () => {
  assert.strictEqual(C.payWeekMonday('2026-11-16'), '2026-11-16'); // Monday
  assert.strictEqual(C.payWeekMonday('2026-11-22'), '2026-11-16'); // Sunday
  assert.strictEqual(C.payWeekMonday('2026-11-19'), '2026-11-16');
});
ok('owner example: job 16-22 Nov is offered until Mon 23 Nov 10:00 Perth', () => {
  const end = '2026-11-22';
  assert.strictEqual(C.cutoffMs(end), perth('2026-11-23', 10));
  assert.ok(C.isOfferable({ endDate: end }, perth('2026-11-23', 9) + 59 * 60000)); // 09:59
  assert.ok(!C.isOfferable({ endDate: end }, perth('2026-11-23', 10) + 1));        // 10:00:00.001
});
ok('owner example: on 24 Nov the 16-22 Nov job is not offered', () => {
  assert.ok(!C.isOfferable({ endDate: '2026-11-22' }, perth('2026-11-24', 8)));
});
ok('job overlapping into this week (14-19 Nov, today 17 Nov) is offered', () => {
  assert.ok(C.isOfferable({ endDate: '2026-11-19' }, perth('2026-11-17', 12)));
});
ok('Sunday end date uses that week (cut-off the next Monday, not the one after)', () => {
  assert.strictEqual(C.cutoffMs('2026-11-22'), C.cutoffMs('2026-11-16'));
});
ok('a job with no end date is never offered', () => {
  assert.ok(!C.isOfferable({}, perth('2026-11-17', 9)));
});
ok('pool row expires 14 days after the end date (not the cut-off)', () => {
  // end 22 Nov -> 14 days later is 6 Dec; start of 6 Dec in Perth = 5 Dec 16:00 UTC
  assert.strictEqual(new Date(C.poolExpiryMs('2026-11-22')).toISOString(), '2026-12-05T16:00:00.000Z');
  assert.strictEqual(C.poolExpiryMs('2026-11-22'), perth('2026-12-06', 0));
});
ok('phone registrations idle 60+ days are removed, recent ones kept', () => {
  const now = perth('2026-11-17', 9);
  const day = 86400000;
  const ids = C.staleDeviceIds([
    { id: 'old', lastOpenedMs: now - 61 * day },
    { id: 'new', lastOpenedMs: now - 5 * day },
    { id: 'never', lastOpenedMs: 0 },
  ], now);
  assert.deepStrictEqual(ids.sort(), ['never', 'old']);
});
ok('offer ids are safe document ids', () => {
  assert.strictEqual(C.offerId('30234', 'abc_DEF-1'), '30234__abc_DEF-1');
  assert.strictEqual(C.offerId('30/234', 'a b'), '30234__ab');
});
if (fail) { console.log(fail + ' failed'); process.exitCode = 1; } else console.log('all share-core tests passed');
