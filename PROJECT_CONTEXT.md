# Norwest Crane Hire — Weekly Timesheet PWA

## What this is
A single-page PWA that replaces a paper/PDF weekly timesheet (NCH-HR-FORM-025)
for Norwest Crane Hire. Employees fill it out on their phone, sign it, and it
generates a PDF that closely replicates the original company form, then shares
it (or emails it) to admin@norwestcranehire.com.au.

## Files (all flat in repo root except icons/)
- `index.html` — the entire app: UI, state, PDF generation, everything. No
  build step, no framework — vanilla JS in one file.
- `manifest.json` — PWA manifest (install prompt, icons, app name).
- `service-worker.js` — caches the app shell + jsPDF (loaded from cdnjs) so
  it works fully offline after the first online load.
- `icons/icon-192.png`, `icons/icon-512.png` — app icons, generated from the
  real Norwest logo's icon mark.

## Key implementation details worth knowing

**PDF generation** (`buildPdf()` in index.html) uses jsPDF with manual
`drawCell()`-style positioning (not autoTable) to closely replicate the
original PDF's exact layout — day columns, highlighted "Total Daily Hours"
row, job details grid, signature boxes, leave legend, allowance totals box.
The real company logo is embedded as a base64 PNG constant (`LOGO_PNG_B64`)
— recolored from the original white SVG logo to dark text since the PDF page
is white. This makes the file ~90KB in code / ~3MB when a PDF is generated
(signatures + logo image).

**Total Daily Hours** is calculated from the sum of that day's Job Hours
entries (`calcDailyHours()`), NOT from Start/Finish time. Start/Finish/Lunch
are purely informational — the business doesn't deduct lunch (they bill an
extra 30min/day to the client instead to guarantee a 10hr minimum), so those
fields don't drive any calculation. Don't "fix" this back to time-based
calculation — it was deliberately changed after user clarification.

**Northwest Allowance = Productivity Allowance** (same figure, historically
confusing naming). Formula: `Total hours worked − NS Stand Down − FIFO travel
time`. NS Stand Down is a separately-paid allowance for night-shift-to-day
transitions, not downtime — it's not being conflated with productivity, it's
correctly subtracted per the business's actual formula.

**Job number auto-fill**: picking a client on a job line looks up that day's
month (MM-YYYY format, e.g. `08-2026`) against a Google Sheet fetched via
`JOB_NUMBERS_URL` (a deployed Apps Script web app). `CLIENT_SITE_MAP` maps
dropdown values to the *exact* sheet column names — note it's `'Port
Hedland'` (with a space) not `'Porthedland'`, because that's what the user's
Gmail-parsing Apps Script actually writes as the header. If this ever breaks
again, check for an exact string mismatch here first.

**Week Ending date auto-fills all 7 day dates** (`populateWeekDates()` /
`isoAddDays()`). This uses manual UTC-safe date arithmetic
(`Date.UTC(...)` + `getUTCDate()`), NOT `new Date(iso).toISOString()` —
the naive version caused an off-by-one-day bug for users in timezones ahead
of UTC (e.g. Perth, AWST +8), because parsing as local midnight then
serializing via `toISOString()` silently shifts the date back a day.
Keep all date math UTC-based.

**Signature requirement**: employee signature is mandatory before Download
or Submit (validated via canvas pixel-alpha check, `isCanvasBlank()`).
Supervisor signature is optional/unused in practice — this business never
gets supervisor sign-off, so don't add validation there.

**"Start new week" button** (`clearForm()`) resets all 7 days' data but
deliberately *keeps* the employee's name, print name, and both signature
canvases intact (captured/restored via dataURL) — re-signing every week
would be pointless friction. There's a one-shot Undo bar for accidental
clears.

**Submit & Send** uses the Web Share API (`navigator.share()`) to hand the
generated PDF to Gmail pre-attached. Important limitation: Web Share has no
"recipient" field in the spec at all — no website can pre-fill a "To"
address when sharing a file. As a workaround, the admin email is silently
copied to the clipboard right before Share opens, and there's a visible hint
above the buttons telling the user to paste it. The mailto fallback path
(used when Web Share isn't supported) *can* pre-fill To/Subject/Body, but
can't attach a file at all — that's a mailto limitation, not ours.

**Client dropdown "Other" pattern**: several fields (Job Client, Higher
Duties) use a `<select>` with known options plus an "Other (type manually)"
option that reveals a text input when selected. This pattern is reused for
new client-list-style fields — check `CLIENTS` array and the job-row render
logic in `renderDay()` for the reference implementation.

## Service worker versioning — IMPORTANT
`CACHE_NAME` in `service-worker.js` (e.g. `'norwest-timesheet-v13'`) MUST be
bumped on every deploy that changes `index.html`, or returning users will
keep getting served the old cached version indefinitely. The app has
auto-update logic (`checkForUpdatesAndRefresh()`, `controllerchange`
listener) that detects a version bump and reloads automatically — but only
if the version string actually changed. Forgetting this bump is the #1
cause of "I uploaded the fix but it's not showing up" reports.

## Backend automation (separate from this repo)
A Google Apps Script project ("Job Numbers API") handles the monthly job
number sync:
- `doGet()` — serves the JobNumbers sheet as JSON to the PWA. Don't touch
  this without understanding it's a live API endpoint other code depends on.
- `processJobNumberEmails()` — runs on a daily time-driven trigger, reads
  Gmail threads labeled "Process-JobNumbers" (auto-applied via a Gmail
  filter when Norwest's monthly email arrives), regex-extracts the Port
  Hedland/Newman/Flights/Logistics job numbers, writes/updates a row in the
  JobNumbers sheet, then removes the label. Regex patterns were built and
  tested against the real email wording — don't loosen them without testing
  against actual email text, since earlier looser versions grabbed stray
  words like "NCH" or "Operations" instead of the numbers.

## Hosting
Static GitHub Pages, repo root. No backend of our own — the Apps Script web
app is the only server-side piece, and it's Google's infrastructure, not
ours to host.

## What NOT to change without asking
- The Total Daily Hours = sum-of-job-hours logic (see above, was deliberate).
- The Northwest/Productivity allowance formula.
- The Job Client / CLIENT_SITE_MAP column name mapping (must match the
  actual sheet headers exactly).
- Signature requirement (employee mandatory, supervisor optional).
- Anything in the PDF layout without comparing against the real
  NCH-HR-FORM-025 form first — it's meant to be near-identical.
