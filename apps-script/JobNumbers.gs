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
// digits. Needs 5+ digits, so stray words like "NCH" or "Operations" and the
// year ("2026") are never picked up.
function findJobNumber_(text, siteRegex) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const site = line.match(siteRegex);
    if (!site) continue;
    const after = line.slice(site.index + site[0].length);
    const m = after.match(/(?:NCH\s*)?(\d{5,})/i);
    if (m) return m[1];
  }
  return '';
}

// The email says which month it's for ("for the month of October 2026") and
// usually arrives in the month BEFORE, so read the month from the text.
// Falls back to the month after the email's date if that line is missing.
function monthKeyFromEmail_(text, date) {
  const MONTHS = ['january','february','march','april','may','june','july',
                  'august','september','october','november','december'];
  const m = text.match(/month of\s+([A-Za-z]+)\s+(\d{4})/i);
  if (m) {
    const idx = MONTHS.indexOf(m[1].toLowerCase());
    if (idx !== -1) return String(idx + 1).padStart(2, '0') + '-' + m[2];
  }
  const next = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return Utilities.formatDate(next, Session.getScriptTimeZone(), 'MM-yyyy');
}

function upsertMonth_(monthKey, nums) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  let rowIdx = values.findIndex((r, i) => i > 0 && String(r[0]).trim() === monthKey);
  if (rowIdx === -1) {
    sheet.appendRow([monthKey].concat(HEADERS.slice(1).map(() => '')));
    rowIdx = sheet.getLastRow() - 1;
  }
  HEADERS.slice(1).forEach((h, i) => {
    if (nums[h]) sheet.getRange(rowIdx + 1, i + 2).setValue(nums[h]);
  });
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
