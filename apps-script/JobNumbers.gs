/**
 * Norwest Forms - Job Numbers API (Google Apps Script)
 *
 * Paste this whole file into the Apps Script editor of the JobNumbers
 * spreadsheet (Extensions > Apps Script). Setup steps are in
 * docs/job-numbers-setup.md.
 *
 * The PWA (index.html) fetches the deployed web app URL (JOB_NUMBERS_URL)
 * and expects a JSON array like:
 *   [{"Month":"10-2026","Port Hedland":"12345","Newman":"...","Flights":"...","Logistics":"...","Medicals":"..."}]
 * Header names must match CLIENT_SITE_MAP in index.html EXACTLY
 * ("Port Hedland" with a space).
 */

const SHEET_NAME = 'JobNumbers';
const HEADERS = ['Month', 'Port Hedland', 'Newman', 'Flights', 'Logistics', 'Medicals'];
const GMAIL_LABEL = 'Process-JobNumbers';

// Serves the sheet as JSON to the app. Live endpoint - the app depends on it.
function doGet() {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  const tz = Session.getScriptTimeZone();
  const rows = values
    .filter(r => r.some(c => c !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        let v = r[i];
        // If Sheets turned "10-2026" into a real date, turn it back into MM-yyyy
        if (v instanceof Date) v = Utilities.formatDate(v, tz, h === 'Month' ? 'MM-yyyy' : 'dd/MM/yyyy');
        obj[h] = String(v).trim();
      });
      return obj;
    });
  return ContentService.createTextOutput(JSON.stringify(rows))
    .setMimeType(ContentService.MimeType.JSON);
}

// Reads emails labelled Process-JobNumbers, pulls out the job numbers,
// writes/updates that month's row, then removes the label.
// Run on a time-driven trigger (see setup guide).
function processJobNumberEmails() {
  const label = GmailApp.getUserLabelByName(GMAIL_LABEL);
  if (!label) return;
  const threads = label.getThreads();
  threads.forEach(thread => {
    thread.getMessages().forEach(msg => {
      const text = msg.getPlainBody();
      const nums = parseJobNumbers_(text);
      if (Object.values(nums).some(Boolean)) {
        upsertMonth_(monthKeyFromEmail_(text, msg.getDate()), nums);
      }
    });
    thread.removeLabel(label);
  });
  reportSuspicious_();
  checkCurrentMonth_();
}

// Emails the script's owner if the sheet has no row for the current month
// (email never arrived, filter/label broke, wording changed...). Runs at the
// end of every daily trigger run, so it repeats once a day until fixed.
// Workers see a matching "type it in manually" warning in the app meanwhile.
function checkCurrentMonth_() {
  const tz = Session.getScriptTimeZone();
  const monthKey = Utilities.formatDate(new Date(), tz, 'MM-yyyy');
  const months = getSheet_().getDataRange().getDisplayValues().slice(1).map(r => String(r[0]).trim());
  if (months.indexOf(monthKey) !== -1) return;
  const me = Session.getEffectiveUser().getEmail();
  const sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  MailApp.sendEmail(me, 'Norwest Forms: job numbers missing for ' + monthKey,
    'The JobNumbers sheet has no row for ' + monthKey + ', so workers are being told to type job numbers in manually.\n\n' +
    'To fix it, either:\n' +
    '  - add the row by hand in the sheet: ' + sheetUrl + '\n' +
    '  - or find this month\'s Norwest "Visual Dispatch" email, add the Process-JobNumbers label, and run processJobNumberEmails in Apps Script.\n\n' +
    'If the email arrived but the numbers weren\'t picked up, Norwest may have changed the wording - send the email text to whoever maintains the app.\n\n' +
    'This reminder repeats each day until the row is there.');
}

// Pulls the four job numbers out of the email. Built against the real
// Norwest wording (October 2026 email):
//   Port Hedland – NCH 30689
//   Newman – NCH 30690
//   Logistics – NCH 30691
//   ...Job Number for Flights (When not paid by a Client) = NCH30405.
//   ...Job Number for Medicals & Lab Das / Inductions, Courses & Training etc NCH30406.
function parseJobNumbers_(text) {
  return {
    'Port Hedland': findJobNumber_(text, /port\s*hedland/i),
    'Newman':       findJobNumber_(text, /newman/i),
    'Flights':      findJobNumber_(text, /\bflights?\b/i),
    'Logistics':    findJobNumber_(text, /logistics/i),
    'Medicals':     findJobNumber_(text, /medicals?/i)
  };
}

// Finds the site name on a line, then the first "NCH 30689" / "NCH30405" /
// "30689" style number AFTER it on that same line, and returns just the
// digits. Job numbers are EXACTLY 5 digits, so stray words ("NCH",
// "Operations"), the year ("2026") and phone numbers ("91721518", the
// Port Hedland 08 9172 xxxx exchange) are never picked up. A phone number
// on a line mentioning flights once put 91721518 in June 2026's Flights.
function findJobNumber_(text, siteRegex) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const site = line.match(siteRegex);
    if (!site) continue;
    const after = line.slice(site.index + site[0].length);
    const m = after.match(/(?:NCH\s*)?(?<!\d)(\d{5})(?!\d)/i);
    if (m) return m[1];
  }
  return '';
}

// The email says which month it's for ("for the month of October 2026") and
// usually arrives late in the month BEFORE, so read the month from the text.
// Sanity check: an email received on 26 Feb that says "February" is really
// March's (seen in the real Feb 2026 email), so the month can never be
// earlier than the month 10 days after it arrived. Early/Christmas emails
// (21 Dec for January, 1 Jun for June) still keep their stated month.
// Falls back to that same "10 days later" month if the line is missing.
function monthKeyFromEmail_(text, date) {
  const MONTHS = ['january','february','march','april','may','june','july',
                  'august','september','october','november','december'];
  const soon = new Date(date.getTime() + 10 * 24 * 60 * 60 * 1000);
  const floor = soon.getFullYear() * 12 + soon.getMonth();
  const m = text.match(/month of\s+([A-Za-z]+)\s+(\d{4})/i);
  if (m) {
    const idx = MONTHS.indexOf(m[1].toLowerCase());
    if (idx !== -1 && Number(m[2]) * 12 + idx >= floor) {
      return String(idx + 1).padStart(2, '0') + '-' + m[2];
    }
  }
  return String(soon.getMonth() + 1).padStart(2, '0') + '-' + soon.getFullYear();
}

// ---- One-off backfill of older months ----------------------------------
// Searches ALL of Gmail (not just the label) for past job numbers emails,
// e.g. to fill in previous months so pay weeks that cross a month-end have
// both months' numbers. Run previewOldEmails() first (changes nothing),
// then backfillOldEmails() to write the rows.
const BACKFILL_QUERY = '"Visual Dispatch" "month of"';

function findOldEmails_() {
  const found = [];
  let start = 0, batch;
  do {
    batch = GmailApp.search(BACKFILL_QUERY, start, 100);
    batch.forEach(thread => thread.getMessages().forEach(msg => {
      const text = msg.getPlainBody();
      const nums = parseJobNumbers_(text);
      if (!Object.values(nums).some(Boolean)) return;
      found.push({ date: msg.getDate(), from: msg.getFrom(), month: monthKeyFromEmail_(text, msg.getDate()), nums: nums });
    }));
    start += batch.length;
  } while (batch.length === 100 && start < 1000);
  // Oldest first, so if a month was re-sent/corrected the latest email wins
  found.sort((a, b) => a.date - b.date);
  return found;
}

// Lists every old email it can find and what it would write. Writes nothing.
function previewOldEmails() {
  const tz = Session.getScriptTimeZone();
  const found = findOldEmails_();
  Logger.log('Found ' + found.length + ' job numbers email(s):');
  found.forEach(f => Logger.log(
    f.month + '  (received ' + Utilities.formatDate(f.date, tz, 'dd/MM/yyyy') + ' from ' + f.from + ')  ' +
    HEADERS.slice(1).map(h => h + ': ' + (f.nums[h] || '-')).join(' | ')));
}

// Writes a row per month found (updates the month's row if it already exists).
function backfillOldEmails() {
  const found = findOldEmails_();
  found.forEach(f => upsertMonth_(f.month, f.nums));
  sortMonths_();
  reportSuspicious_();
  Logger.log('Wrote ' + found.length + ' email(s) covering ' + new Set(found.map(f => f.month)).size + ' month(s).');
}

// Keeps the sheet in date order (oldest month at the top).
function sortMonths_() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 3) return;
  const range = sheet.getRange(2, 1, last - 1, HEADERS.length);
  const rows = range.getDisplayValues();
  const key = r => { const [m, y] = String(r[0]).split('-'); return (Number(y) || 0) * 100 + (Number(m) || 0); };
  rows.sort((a, b) => key(a) - key(b));
  range.setValues(rows);
}

// Sense check: real job numbers only creep up month to month (Port Hedland
// ~+100/month, Flights/Medicals jump ~+1000 at the July financial-year
// rollover). A value more than MAX_JUMP away from the typical recent value
// for that column (median of the up-to-3 nearest earlier months) is NOT
// written - it's logged and emailed to the owner to check instead. Using a
// median means one bad old cell can't block good values after it.
const MAX_JUMP = 2000;
const suspicious_ = [];

function upsertMonth_(monthKey, nums) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  let rowIdx = values.findIndex((r, i) => i > 0 && String(r[0]).trim() === monthKey);
  if (rowIdx === -1) {
    sheet.appendRow([monthKey].concat(HEADERS.slice(1).map(() => '')));
    rowIdx = sheet.getLastRow() - 1;
  }
  const order = k => { const [m, y] = String(k).split('-'); return (Number(y) || 0) * 12 + (Number(m) || 0); };
  const earlier = values.slice(1)
    .filter(r => order(r[0]) < order(monthKey))
    .sort((a, b) => order(b[0]) - order(a[0]));
  HEADERS.slice(1).forEach((h, i) => {
    if (!nums[h]) return;
    const recent = earlier.map(r => Number(r[i + 1])).filter(n => n > 0).slice(0, 3).sort((a, b) => a - b);
    const typical = recent.length ? recent[Math.floor(recent.length / 2)] : null;
    if (typical !== null && Math.abs(Number(nums[h]) - typical) > MAX_JUMP) {
      suspicious_.push(monthKey + ' ' + h + ': ' + nums[h] + ' (recent months ~' + typical + ') - not written');
      return;
    }
    sheet.getRange(rowIdx + 1, i + 2).setValue(nums[h]);
  });
}

// Logs and emails anything the sense check refused to write.
function reportSuspicious_() {
  if (!suspicious_.length) return;
  const list = suspicious_.splice(0);
  list.forEach(x => Logger.log('SKIPPED ' + x));
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    'Norwest Forms: odd job number(s) not added',
    'These job numbers looked wrong compared with recent months, so they were NOT written to the sheet:\n\n  ' +
    list.join('\n  ') + '\n\nCheck the email (run traceValue with that number to find it) and type the right ' +
    'number into the sheet by hand if needed: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  // Make sure every header is there (adds "Medicals" to an older 5-column sheet)
  const current = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
  if (current.some((h, i) => String(h).trim() !== HEADERS[i])) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  // Keep every cell plain text so "10-2026" never turns into a date
  sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
  return sheet;
}

// Run this once by hand from the editor to create the sheet and test parsing
// on the newest labelled email WITHOUT removing the label or writing anything.
function testSetup() {
  getSheet_();
  const label = GmailApp.getUserLabelByName(GMAIL_LABEL);
  const thread = label && label.getThreads(0, 1)[0];
  if (!thread) { Logger.log('Sheet ready. No email with label ' + GMAIL_LABEL + ' found yet.'); return; }
  const msg = thread.getMessages().pop();
  const text = msg.getPlainBody();
  Logger.log('Month: ' + monthKeyFromEmail_(text, msg.getDate()));
  const nums = parseJobNumbers_(text);
  Object.keys(nums).forEach(site => Logger.log(site + ': ' + (nums[site] || '(not found)')));
}

// Run by hand to check the missing-month alert can send email (and to grant
// the "send email as you" permission). Sends one test email to yourself.
function testAlertEmail() {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    'Norwest Forms: test alert',
    'If you got this, the missing job numbers alert can email you.');
}

// Debug helper: finds which email(s) a value in the sheet came from. Set
// TRACE_VALUE to the odd number, run traceValue, and read the log (date,
// sender, subject and the exact line it's on). Writes nothing.
const TRACE_VALUE = '91721518';
function traceValue() {
  const spaced = TRACE_VALUE.length === 8 ? TRACE_VALUE.slice(0, 4) + ' ' + TRACE_VALUE.slice(4) : TRACE_VALUE;
  const threads = GmailApp.search('"' + TRACE_VALUE + '" OR "' + spaced + '"', 0, 50);
  const tz = Session.getScriptTimeZone();
  let hits = 0;
  threads.forEach(t => t.getMessages().forEach(msg => {
    const lines = msg.getPlainBody().split(/\r?\n/);
    lines.forEach(line => {
      if (line.replace(/\s/g, '').indexOf(TRACE_VALUE) === -1) return;
      hits++;
      Logger.log(Utilities.formatDate(msg.getDate(), tz, 'dd/MM/yyyy') + ' | ' + msg.getFrom() +
        ' | "' + msg.getSubject() + '"\n    line: ' + line.trim() +
        '\n    labels: ' + t.getLabels().map(l => l.getName()).join(', '));
    });
  }));
  Logger.log(hits ? hits + ' line(s) found.' : 'Not found in Gmail.');
}
