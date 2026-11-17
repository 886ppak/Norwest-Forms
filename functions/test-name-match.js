const assert = require('assert');
const { nameScore, classify } = require('./name-match.js');
const cases = [
  // [profile, email, expected class]
  ['Brenton Pool', 'Brenton Pool', 'match'],
  ['Brenton Pool', 'brenton  pool.', 'match'],
  ['Brenton Pool', 'Brenton Michael Pool', 'match'],     // middle name added on the email
  ['Brenton Pool', 'BrentonPool', 'match'],               // missing space
  ['Brenton Pool', 'Brenton Poole', 'suggest'],           // one letter different
  ['Brenton Pool', 'Brenton Pol', 'suggest'],
  ['Brenton Pool', 'Brentan Pool', 'suggest'],            // typo
  ['Brenton Pool', 'Brenton Smith', null],                // different surname
  ['Brenton Pool', 'Aiden Tunupopo', null],
  ['Brenton Pool', 'Pool Brenton', 'suggest'],         // surname first: suggested, never auto-matched
];
let fail = 0;
for (const [p, e, want] of cases) {
  const s = nameScore(p, e), got = classify(s);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.padEnd(14)} | ${e.padEnd(22)} ${String(s).padEnd(6)} ${got} (want ${want})`);
}
assert.strictEqual(fail, 0, `${fail} case(s) failed`);
console.log('all name-match cases passed');
