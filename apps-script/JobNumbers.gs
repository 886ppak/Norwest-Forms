/**
 * Norwest Forms - Job Numbers API (Google Apps Script)
 *
 * Paste this whole file into the Apps Script editor of the JobNumbers
 * spreadsheet (Extensions > Apps Script). Setup steps are in
 * docs/job-numbers-setup.md.
 *
 * The PWA (index.html) fetches the deployed web app URL (JOB_NUMBERS_URL)
 * and expects a JSON array like:
 *   [{"Month":"10-2026","Port Hedland":"12345","Newman":"...","Flights":"...","Logistics":"..."}]
 * Header names must match CLIENT_SITE_MAP in index.html EXACTLY
 * ("Port Hedland" with a space).
 */

const SHEET_NAME = 'JobNumbers';
const HEADERS = ['Month', 'Port Hedland', 'Newman', 'Flights', 'Logistics'];
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
      const nums = {
        'Port Hedland': findJobNumber_(text, /port\s*hedland/i),
        'Newman':       findJobNumber_(text, /newman/i),
        'Flights':      findJobNumber_(text, /flights?/i),
        'Logistics':    findJobNumber_(text, /logistics/i)
      };
      if (Object.values(nums).some(Boolean)) {
        upsertMonth_(monthKeyFor_(msg.getDate()), nums);
      }
    });
    thread.removeLabel(label);
  });
}

// Finds "<site> ... <job number>" on the same line. A job number must
// contain at least 4 digits, so stray words like "NCH" or "Operations"
// are never picked up. CHECK THIS AGAINST A REAL EMAIL (setup guide step 6).
function findJobNumber_(text, siteRegex) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!siteRegex.test(line)) continue;
    const after = line.split(siteRegex).slice(1).join(' ');
    const m = after.match(/\b([A-Z]{0,4}[-\/]?\d{4,}[A-Z0-9\-\/]*)\b/i);
    if (m) return m[1];
  }
  return '';
}

// The monthly email is for the month it arrives in.
function monthKeyFor_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MM-yyyy');
}

function upsertMonth_(monthKey, nums) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  let rowIdx = values.findIndex((r, i) => i > 0 && String(r[0]).trim() === monthKey);
  if (rowIdx === -1) {
    sheet.appendRow([monthKey, '', '', '', '']);
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
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  // Keep every cell plain text so "10-2026" never turns into a date
  sheet.getRange('A:E').setNumberFormat('@');
  return sheet;
}

// Run this once by hand from the editor to create the sheet and test parsing
// on the newest labelled email WITHOUT removing the label.
function testSetup() {
  getSheet_();
  const label = GmailApp.getUserLabelByName(GMAIL_LABEL);
  const thread = label && label.getThreads(0, 1)[0];
  if (!thread) { Logger.log('Sheet ready. No email with label ' + GMAIL_LABEL + ' found yet.'); return; }
  const text = thread.getMessages().pop().getPlainBody();
  ['Port Hedland', 'Newman', 'Flights', 'Logistics'].forEach(site =>
    Logger.log(site + ': ' + (findJobNumber_(text, new RegExp(site.replace(' ', '\\s*'), 'i')) || '(not found)')));
}
