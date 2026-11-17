// Fuzzy job matching on the real fixtures. Run: node functions/test-share-match.js
const assert = require('assert');
const P = require('./calparser.js');
const F = require('../tools/calscrape-fixtures.js');
const who = 'Aiden Amur';
const key = j => [j.vd, j.mob, j.demob, j.shift].join('|');
let fail = 0;
function ok(name, fn){ try{ fn(); console.log('PASS', name); } catch(e){ fail++; console.log('FAIL', name, '\n  ', e.message); } }

ok('exact name: fuzzy finds the same jobs as the exact parser (PSA)', () => {
  const a = P.calParseEmail(F.psa, who, 'x'), b = P.calParseEmailFuzzy(F.psa, who, 'x');
  assert.ok(a.jobs && b.jobs);
  assert.deepStrictEqual(b.jobs.map(key), a.jobs.map(key));
  assert.strictEqual(b.jobs[0].matchKind, 'match');
});
ok('middle name added on the email still finds the job (PSA)', () => {
  const mid = F.psa.replace(/Aiden Amur/g, 'Aiden James Amur');
  const r = P.calParseEmailFuzzy(mid, who, 'x');
  assert.ok(r.jobs, r.error);
  assert.strictEqual(r.jobs.length, P.calParseEmail(F.psa, who, 'x').jobs.length);
});
ok('one-letter difference is a suggestion, not a match (PSA)', () => {
  const typo = F.psa.replace(/Aiden Amur/g, 'Aiden Amurr');
  const r = P.calParseEmailFuzzy(typo, who, 'x');
  assert.ok(r.jobs, r.error);
  assert.strictEqual(r.jobs[0].matchKind, 'suggest');
});
ok('a different person is not matched (PSA)', () => {
  const r = P.calParseEmailFuzzy(F.psa, 'Brenton Pool', 'x');
  assert.ok(r.error, 'should find nothing for another name');
});
ok('exact-name jobs unchanged on BHP and FMG fixtures', () => {
  for (const [t, subj] of [[F.bhp, 'BHP Whaleback - High Capacity Digger'], [F.fmgLines, '']]) {
    const a = P.calParseEmail(t, who, subj), b = P.calParseEmailFuzzy(t, who, subj);
    if (a.jobs) assert.deepStrictEqual(b.jobs.map(key), a.jobs.map(key));
  }
});
if (fail) { console.log(fail + ' failed'); process.exitCode = 1; } else console.log('all share-match tests passed');
