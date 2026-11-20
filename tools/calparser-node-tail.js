// Node-only parser helpers, appended to functions/calparser.js by tools/build-calscrape.js.
// Kept here so a rebuild from index.html cannot drop them: fuzzy matching (name-match.js) and the
// every-row parser used for the shared pool.
// Fuzzy version for job sharing: a cell counts as this worker's row when its name
// scores at least SUGGEST_MIN against the profile name (see name-match.js).
// Each job carries matchScore and matchKind ('match' | 'suggest').
function calParseEmailFuzzy(text, name, subject){
  const { nameScore, classify } = require('./name-match.js');
  if(!calNorm(name)) return {error:'No name to match.'};
  const cells = calCells(text);
  const jobs=[];
  cells.forEach((c,n)=>{
    const s = nameScore(name, c);
    const kind = classify(s);
    if(!kind) return;
    const j = calParseRow(cells,n);
    if(!j.hasTravel || !j.shift) return;
    j.site = j.site || subject || '';
    jobs.push(Object.assign(j, {matchScore:s, matchKind:kind, matchedName:String(c).trim().slice(0,80)}));
  });
  if(!jobs.length) return {error:'No job rows match this name.'};
  return {jobs};
}

// Every job row in the text, for the pool (v1.101): any cell that looks like a person's name and
// has a travel/shift/date pattern beside it. Returns an array (possibly empty); never throws.
function calNameLike(c){
  const t = String(c||'').trim();
  if(!/^[A-Za-z][A-Za-z'’.\- ]{2,60}$/.test(t)) return false;
  const words = t.split(/\s+/).length;
  if(words < 2 || words > 4) return false;
  if(CAL_SHIFT_RE.test(t) || CAL_TRAVEL_RE.test(t) || /\b(operator|rigger|supervisor|tba|regards|please|crew|class|shift|demob|mobe|full name|travel in|travel out|first shift|last shift|rh card|accommodation|commute|site)\b/i.test(t)) return false;
  return true;
}
function calParseAllRows(text, subject){
  const cells = calCells(text);
  const jobs = [];
  cells.forEach((c,n)=>{
    if(!calNameLike(c)) return;
    const j = calParseRow(cells, n);
    if(!j.hasTravel || !j.shift || !j.demob) return;
    j.site = j.site || subject || '';
    jobs.push(Object.assign(j, {crewName: String(c).trim().slice(0,80)}));
  });
  return jobs;
}
