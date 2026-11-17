// Fuzzy name matching for job sharing (P2P). Pure functions, no I/O.
// Used to decide whether a name on a mobilisation email belongs to a phone's
// profile name: exact (auto-match), close (offer as a suggestion), or no match.
// Thresholds are owner-tunable below; test with functions/test-name-match.js.

const AUTO_MATCH = 0.95;   // at or above: the job is offered as this person's
const SUGGEST_MIN = 0.85;  // from SUGGEST_MIN up to AUTO_MATCH: offered as a suggestion

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function ratio(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - lev(a, b) / max : 1;
}
// Whole-name similarity with spaces removed, so "John Smith" and "JohnSmith" match.
function wholeSim(a, b) {
  return ratio(a.replace(/ /g, ''), b.replace(/ /g, ''));
}
// Share of the profile's name parts found in the email's name (handles an added middle name).
// A part counts when it matches an email part closely (small typo allowed).
function partCoverage(profileParts, emailParts) {
  if (!profileParts.length) return 0;
  let hit = 0;
  for (const p of profileParts) {
    if (emailParts.some(e => e === p || (p.length >= 4 && ratio(p, e) >= 0.8))) hit++;
  }
  return hit / profileParts.length;
}

// Score 0..1 of how well a profile name matches a name from the email.
function nameScore(profileName, emailName) {
  const a = norm(profileName), b = norm(emailName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pa = a.split(' '), pb = b.split(' ');
  // Surname and first name present, but the email has extra parts (middle name):
  // treat it as the same person when every profile part is found and the first and last parts agree.
  const cov = partCoverage(pa, pb);
  const firstLast = pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
  let score = wholeSim(a, b);
  if (cov === 1 && firstLast) score = Math.max(score, AUTO_MATCH);
  else if (cov === 1) score = Math.max(score, SUGGEST_MIN);
  return Math.round(score * 1000) / 1000;
}

// Classify a score: 'match' (offer it), 'suggest' (ask first), or null (ignore).
function classify(score) {
  if (score >= AUTO_MATCH) return 'match';
  if (score >= SUGGEST_MIN) return 'suggest';
  return null;
}

module.exports = { nameScore, classify, norm, AUTO_MATCH, SUGGEST_MIN };
