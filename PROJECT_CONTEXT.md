# Norwest Forms — Timesheet & Leave PWA

## What this is
A single-page PWA covering three paper/PDF forms for two companies:
- **NCH weekly timesheet** (NCH-HR-FORM-025) for Norwest Crane Hire
- **NWP weekly timesheet** (NP-HR-FRM-001) for Norwest Personnel
- **NCH leave/R&R/travel application** (NCH-HR-FORM-002, page 1 only — shared
  by both companies since there's no separate NWP leave form)

Employees pick their company on first open (`#companyGate` /
`chooseCompany()` / `applyCompany()`), fill the relevant form on their
phone, sign it, and it generates a PDF that closely replicates the original
paper form, then shares it (or emails it) to that company's admin address
— `admin@norwestcranehire.com.au` (NCH) or `payroll@norwestpersonnel.com.au`
(NWP). Company choice persists in `localStorage` and drives which timesheet
layout, logo, and admin email are used throughout the app; see `COMPANIES`
in index.html.

## Files (all flat in repo root except icons/ and docs/)
- `index.html` — the entire app: UI, state, PDF generation, everything. No
  build step, no framework — vanilla JS in one file.
- `manifest.json` — PWA manifest (install prompt, icons, app name).
- `service-worker.js` — caches the app shell + jsPDF (loaded from cdnjs) so
  it works fully offline after the first online load.
- `icons/icon-192.png`, `icons/icon-512.png` — app icons, generated from the
  real Norwest logo's icon mark.
- `docs/` — README assets (currently just the install-to-home-screen gif).

## Key implementation details worth knowing

**PDF generation** has three separate builders, routed by
`buildPdfForCompany()`:
- `buildPdf()` — NCH timesheet.
- `buildPdfNWP()` — NWP timesheet. Every margin, column width, row height,
  and fill color in this one was pixel-measured directly off the real
  reference PDF (NP-HR-FRM-001 Rev 10) at 300dpi rather than eyeballed —
  don't casually nudge numbers in here without re-measuring against a
  current reference PDF the same way, or it'll drift out of alignment
  again in ways that are hard to eyeball-detect.
- `buildLeavePdf()` — the leave application (NCH-HR-FORM-002 page 1).

All three use jsPDF with manual `drawCell()`-style positioning (not
autoTable) to closely replicate each original PDF's exact layout. Company
logos are embedded as base64 PNG constants — `LOGO_PNG_B64` (NCH) and
`LOGO_PNG_B64_NWP` (NWP). The NWP logo asset is a *tightly cropped* PNG
(no padding) — if it's ever re-exported from the source design file, check
it doesn't reintroduce padding, since a padded image throws off the
precisely-measured `logoX/logoY/logoW/logoH` placement in `buildPdfNWP()`.

**Draft persistence.** The in-progress timesheet (`state`) and leave form
(`leaveState`), including both signature canvases, autosave to `localStorage`
(`norwestTimesheetDraft`, `norwestLeaveDraft`, `norwestEmpSigDraft`,
`norwestSupSigDraft`, `norwestLeaveSigDraft`) and restore on load — so
filling in Monday and coming back Friday actually works, even if the tab/PWA
gets killed in between. Saving is debounced (`scheduleDraftSave()`) and
triggered by one delegated `input`/`change` listener on `document` (every
field in both forms bubbles into it, so new fields get autosave for free)
plus explicit calls at the handful of mutation points that don't fire a
native input event (`clearForm()`/`undoClear()`, `clearSig()`,
`copyFromPreviousDay()`, `addJob()`, `chooseCompany()`, and signature-pad
strokes via `end()` in `setupSig()`). `leaveSig`'s canvas is only sized
once the Leave tab is first shown (`leaveSigReady` in `switchFormTab()`),
so its draft is restored there rather than at boot.

**Leave form "Total days requested" calculation.** `daysBetween()` counts
plain calendar days, inclusive of both the first and last day (e.g.
Thu-Mon is 5, not 4) — this is what R&R always uses, since it's
rostered/FIFO-based, not tied to a Mon-Fri work week.

Every other leave type (RDO, Annual Leave, Personal/Cultural, LWOP, DIL,
Other) defaults to `countBusinessDays()` instead — Mon-Fri only, excluding
`WA_PUBLIC_HOLIDAYS` — because this crew's contracted working days are
Monday-Friday and public holidays don't need leave applied for them. This
is user-toggleable per submission via the "Count only weekdays, excluding
WA public holidays" checkbox in the Leave and R&R card
(`leaveState.excludeWeekendsHolidays`, default `true`); `calcLeaveDays(key,
first, last)` is the single entry point that picks the right function based
on the leave type key and that toggle — route any future changes to total-
days logic through it rather than calling `daysBetween`/`countBusinessDays`
directly.

`WA_PUBLIC_HOLIDAYS` is a hardcoded set of ISO dates sourced from
wa.gov.au, confirmed for 2026-2027 only (as of Aug 2026) — **needs a manual
top-up for 2028 onward**, and the 2027 King's Birthday date is a computed
guess (first Monday in August) pending official gazettal, so double-check
it closer to the date. It deliberately uses the **Port Hedland/Karratha**
regional King's Birthday date (first Monday in August), not the statewide
September date — this business is Hedland-based (see the leave form's
"travel from Hedland" flight section) — don't swap this back to the
statewide date without checking with the business first.

**Total Daily Hours / Total Work Hours** (both companies) is calculated
from the sum of that day's Job Hours entries (`calcDailyHours()`), NOT from
Start/Finish time. Start/Finish/Lunch are purely informational — the
business doesn't deduct lunch (they bill an extra 30min/day to the client
instead to guarantee a 10hr minimum), so those fields don't drive any
calculation. Don't "fix" this back to time-based calculation — it was
deliberately changed after user clarification.

**Northwest Allowance** (NCH only). Formula: `Total hours worked − NS
Stand Down − FIFO travel time`. NS Stand Down is a separately-paid
allowance for night-shift-to-day transitions, not downtime — it's not
being conflated with the allowance, it's correctly subtracted per the
business's actual formula. **This does NOT apply to NWP** — NWP's form
used to have an equivalent "Productivity Allowance" concept, but it was
removed entirely from the real NWP form (NP-HR-FRM-001 Rev 10) and from
this app to match. NWP's allowance section is now Higher Duties / Leading
Hand / Heavy Rigging / Meal Allowance instead — none of these are computed
from a formula the way Northwest Allowance is; Higher Duties, Leading Hand,
and Heavy Rigging each just credit that day's full worked hours when
marked, and Meal Allowance is a plain per-day yes/no checkbox with no
computed total. Don't reintroduce a "productivity" calculation for NWP —
it's gone from the real form on purpose.

**Job number auto-fill**: picking a client on a job line looks up that
day's month (MM-YYYY format, e.g. `08-2026`) against a Google Sheet fetched
via `JOB_NUMBERS_URL` (a deployed Apps Script web app). `CLIENT_SITE_MAP`
maps dropdown values to the *exact* sheet column names — note it's `'Port
Hedland'` (with a space) not `'Porthedland'`, because that's what the
user's Gmail-parsing Apps Script actually writes as the header. If this
ever breaks again, check for an exact string mismatch here first. Shared
by both companies; the `CLIENTS` dropdown list is filtered per company
(NWP excludes `'NCH FLIGHTS'`).

**Week Ending date auto-fills all 7 day dates** (`populateWeekDates()` /
`isoAddDays()`). This uses manual UTC-safe date arithmetic
(`Date.UTC(...)` + `getUTCDate()`), NOT `new Date(iso).toISOString()` —
the naive version caused an off-by-one-day bug for users in timezones ahead
of UTC (e.g. Perth, AWST +8), because parsing as local midnight then
serializing via `toISOString()` silently shifts the date back a day.
Keep all date math UTC-based. Applies to the timesheet's week only — the
leave form's dates are simple single-date pickers, no cascading fill.

**Signature requirements**: employee signature (`empSig`) is mandatory
before Download or Submit on the timesheet, for both companies, validated
via canvas pixel-alpha check (`isCanvasBlank()`, see
`validateRequiredFields()`). The second signature canvas (`supSig`,
labelled "Supervisor" for NCH / "Client" for NWP) is optional/unused in
practice — don't add validation there. The leave form has its own separate
signature canvas (`leaveSig`) and its own validator
(`validateLeaveRequiredFields()`), which only requires Name + Signature —
no second signature at all on that form. `leaveSig` lives in a static
(non-regenerated) part of the DOM on purpose: it's set up lazily on first
tab-switch (`setupSig()` needs the container visible to size the canvas
correctly) and must never sit inside a block that gets `innerHTML`-replaced
on re-render, or a drawn signature gets wiped.

**"Start new week" button** (`clearForm()`, timesheet only) resets all 7
days' data but deliberately *keeps* the employee's name, print name, and
both signature canvases intact (captured/restored via dataURL) —
re-signing every week would be pointless friction. There's a one-shot Undo
bar for accidental clears. The leave form has no equivalent reset button.

**Submit & Send** (`submitTimesheet()` / `submitLeave()`) uses the Web
Share API (`navigator.share()`) to hand the generated PDF to Gmail
pre-attached. Important limitation: Web Share has no "recipient" field in
the spec at all — no website can pre-fill a "To" address when sharing a
file. As a workaround, the relevant admin email (company- and form-
specific — see `COMPANIES`) is silently copied to the clipboard right
before Share opens, with a visible hint above the buttons telling the user
to paste it. The mailto fallback path (used when Web Share isn't
supported) *can* pre-fill To/Subject/Body, but can't attach a file at all
— that's a mailto limitation, not ours.

**"Other, type manually" dropdown pattern**: several fields use a
`<select>` with known options plus an "Other (type manually)" option that
reveals a text input when selected — Job Client, Higher Duties, and (on
the leave form) the Destination/Departing From city pickers via the shared
`cityDropdownField()` / `wireCityDropdown()` helpers. Reuse those helpers
for any new city-style field rather than hand-rolling the pattern again;
for non-city fields, check `CLIENTS` and the job-row render logic in
`renderDay()` for the reference implementation.

## Service worker versioning — IMPORTANT
`CACHE_NAME` in `service-worker.js` MUST be bumped on every deploy that
changes `index.html`, or returning users will keep getting served the old
cached version indefinitely. The app has auto-update logic
(`checkForUpdatesAndRefresh()`, `controllerchange` listener) that detects a
version bump and reloads automatically — but only if the version string
actually changed. Forgetting this bump is the #1 cause of "I uploaded the
fix but it's not showing up" reports. Also note: the install step in
`service-worker.js` fetches app-shell files with `{cache:'reload'}`
specifically to bypass the browser's own HTTP cache (GitHub Pages serves
everything with a 10-minute `max-age`) — without that, a freshly-installed
service worker version could still cache a stale copy of `index.html` it
grabbed from disk cache instead of the network. Don't remove that.

There's also a small in-app version label (`.appVersion`, top-left of the
sticky banner) that should be bumped alongside `CACHE_NAME` on every
change — user-facing scheme is `v1` → `v1.1`...`v1.10` → `v2`, and so on.

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
- The Total Daily Hours / Total Work Hours = sum-of-job-hours logic (see
  above, was deliberate) — applies to both companies.
- The Northwest Allowance formula (NCH only — NWP has no equivalent, see
  above; don't reintroduce one).
- The Job Client / CLIENT_SITE_MAP column name mapping (must match the
  actual sheet headers exactly).
- Signature requirements (employee mandatory on both timesheet and leave
  form; second timesheet signature optional; leave form has no second
  signature at all).
- Anything in any of the three PDF layouts (`buildPdf()`, `buildPdfNWP()`,
  `buildLeavePdf()`) without comparing against the real corresponding form
  first — they're meant to be near-identical, and the NWP one specifically
  was pixel-measured against a reference PDF, not eyeballed.
