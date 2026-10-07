# Norwest Forms — Timesheet & Leave PWA

## What this is
A single-page PWA covering five paper/PDF forms across two companies:
- **NCH weekly timesheet** (NCH-HR-FORM-025) for Norwest Crane Hire
- **NWP weekly timesheet** (NP-HR-FRM-001) for Norwest Personnel
- **NCH leave/R&R/travel application** (NCH-HR-FORM-002, page 1 only — shared
  by both companies since there's no separate NWP leave form)
- **NWP Training Payment Claim** (NP-HR-FRM-004) — NWP-only
- **NWP Medical & D&A Allowance Claim** (NP-ADM-FOR-003) — NWP-only

Employees pick their company on first open (`#companyGate` /
`chooseCompany()` / `applyCompany()`), fill the relevant form on their
phone, sign it, and it generates a PDF that closely replicates the original
paper form, then shares it (or emails it) to that company's admin address
— `admin@norwestcranehire.com.au` (NCH) or `payroll@norwestpersonnel.com.au`
(NWP). Company choice persists in `localStorage` and drives which timesheet
layout, logo, and admin email are used throughout the app; see `COMPANIES`
in index.html.

## Files (all flat in repo root except icons/, docs/, apps-script/ and tools/)
- `index.html` — the entire app: UI, state, PDF generation, everything. No
  build step, no framework — vanilla JS in one file.
- `manifest.json` — PWA manifest (install prompt, icons, app name).
- `service-worker.js` — caches the app shell + jsPDF (loaded from cdnjs) so
  it works fully offline after the first online load.
- `icons/icon-192.png`, `icons/icon-512.png` — app icons, generated from the
  real Norwest logo's icon mark.
- `docs/` — README assets, plus `RUNBOOK.md` (what to do when things break —
  read this first), `job-numbers-setup.md` (rebuild the job numbers
  sheet/script) and the HR claim-form test guide.
- `apps-script/JobNumbers.gs` — source of the Job Numbers API Apps Script
  (lives in Google, this is the saved copy).
- `tools/usage-stats.mjs` — read-only usage stats from the Firestore log.
- `firestore.rules` — rules for the usage-logging Firestore project.

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

**manifest.json has no `orientation` field — keep it that way.** Setting it
(e.g. `"portrait"`) locks the *installed* app (not browser tabs) to that
orientation on Android, and on any screen/orientation that doesn't match,
the WebAPK letterboxes the app with a blurred, scaled-up copy of the icon
instead of stretching content to fill the screen — this bit a real user on
a tablet. If this field ever gets re-added, know that fixing it isn't as
simple as a normal deploy: Android bakes the orientation lock into the
installed WebAPK package at install time, not just cached page content, so
existing installs need to be uninstalled from Android Settings → Apps
(not just removed from the home screen) before reinstalling picks up the
fix — a plain refresh or "reinstall from the home screen" won't do it.

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

`WA_HOLIDAYS_MAX_YEAR` tracks the last confirmed year in the set above —
bump it whenever a new year's dates are added. `warnIfHolidaysStale()`
checks a leave row's `last` date against it and toasts a warning (rather
than silently falling back to weekend-only exclusion with no explanation)
once someone actually enters a date past the years we've got loaded — this
is the real safety net for the list going stale, not just the comment
above, since nobody needs to remember a year-plus ahead of time for it to
still work correctly for users.

**Clearing the leave form.** `clearLeaveForm()` (button in `leaveView`,
mirrors `clearForm()`'s "Start new week") resets `leaveState` to
`defaultLeaveState()` but keeps `empName`/`position`/`empNo`/`qantasFF`/
`virginVelocity` and leaves the `leaveSig` canvas untouched — same "keep
identity, clear the rest" idea as the timesheet's clear. Both clear
buttons share one `undoBar`/`showToast` pair; a shared `undoTarget`
variable plus `runUndo()` route the bar's Undo button to `undoClear()` or
`undoClearLeave()` depending on which form was last cleared.

**Training Payment Claim and Medical/D&A Allowance Claim are NWP-only
forms**, unlike Leave which both companies share. Same overall pattern as
Leave (`trainingState`/`medicalState`, `renderTrainingView()`/
`renderMedicalView()`, `buildTrainingPdf()`/`buildMedicalPdf()`,
`clearTrainingForm()`/`clearMedicalForm()` + their own undo pair wired into
the same shared `undoTarget`/`runUndo()`, own signature canvases
`trainingSig`/`medicalSig` with the same lazy-setup-on-first-tab-view
pattern as `leaveSig`, own draft keys in `saveDraft()`/`loadDraft()`), but
with real differences worth knowing:
- Their tabs (`.nwpOnlyTab` in the `formTabs` bar) are hidden entirely for
  NCH and only shown by `applyCompany()` alongside the logo/position swap.
  `activeFormTab` tracks which tab is showing; if someone's sitting on
  Training or Medical and switches to NCH, `applyCompany()` bounces them
  back to the timesheet tab rather than leaving them stranded on a
  now-hidden one.
- Both send to `hr@norwestpersonnel.com.au` (via the shared
  `submitClaimPdf()` helper), not either company's usual admin address —
  don't route these through `COMPANIES[...].adminEmail`.
- Each Employee Declaration checkbox is **required** before submit/download
  (`validateTrainingRequiredFields()`/`validateMedicalRequiredFields()`
  check every `declare*` flag) — this was a deliberate call since they're
  literal attestations on the real form, not optional notes; revisit if
  that turns out to be too strict for a real submission.
- Both PDFs **do** include the real forms' "Office Use Only" HR-approval
  section — unlike the Leave PDF (which only implements its employee-facing
  page), NWP/HR specifically asked for this section to be reproduced so
  they can fill it in themselves after a claim is submitted (e.g.
  annotating the emailed PDF in a mobile PDF app, same workflow as the
  original paper form). It's drawn by the shared `drawOfficeUseOnly()`
  helper (called from `drawClaimSigAndFooter()`, after the "Please email…"
  line and before the document-control footer) and is **always
  blank/unchecked** — employees never fill this in, so don't wire it to
  any app state. Training and Medical differ slightly in what goes in the
  middle of this section (`officeUseOpts.middleType`): Training gets a
  single "APPROVED HOURS" box, Medical gets an "Allowance Payable: Yes/No"
  checkbox pair instead — everything else (NWP/HR Declaration checkboxes,
  the Approver Name/Signature/Date row, Conditions of Payment numbered
  list) is passed in via `officeUseOpts` and rendered by the same shared
  code for both forms via a shared `drawClaimIdRow()`/
  `drawClaimTitleAndLogo()`/`drawClaimSigAndFooter()`/
  `drawDeclarationLines()`/`drawOfficeUseOnly()` set of helpers. As of the
  second pass on these two forms, every margin, cell width/height, font
  size, and shading color in this set was pixel-measured directly off the
  two real reference PDFs (NP-HR-FRM-004, NP-ADM-FOR-003) via PyMuPDF
  vector/text extraction (`page.get_drawings()` for fill rects,
  `page.get_text('dict')` for exact text-span bboxes/sizes/fonts) — same
  rigor as `buildPdfNWP()`, not eyeballed. Two shading tones are used,
  `CLAIM_GREY1`/`CLAIM_GREY2`; the Office Use Only section's outer box is
  drawn as its own filled rect (`drawOfficeUseOnly()`'s `opts.boxHeight`,
  a hardcoded measured height since the section's content is always the
  same fixed blank layout) that deliberately overhangs the main content
  margins on both sides, matching the reference. `drawClaimTitleAndLogo()`
  still shrinks the title font until it clears the logo rather than
  overlapping it — the reference PDFs' title text runs visually under
  their logo's transparent margin at a fixed 14pt, but this app's
  `LOGO_PNG_B64_NWP` asset has no such safe margin, so the Medical form's
  long title needs the shrink to avoid a real visual collision (caught in
  testing, not hypothetical) — don't remove this shrink loop even though
  the reference itself doesn't need one.
- The Employee Signature row's Date cell auto-fills with today's date at
  PDF-generation time (there's no separate date input in either form) —
  intentional, matching the "auto-fill wherever sensible" pattern used
  elsewhere (job numbers, week dates).

**NWP's "Position" box is an EBA classification, not a job title.** Unlike
NCH (which just uses the shared `state.position` Full time/Casual select,
header UI `#positionNCH`), NWP's real form's Position box holds a code like
`CO CAT 5 LV2 CASUAL` — role + category + level + employment type, sourced
from the NWP Enterprise Agreement's Appendix A/B wage schedule. UI is
`#positionNWP` (four selects: `#nwpRole`, `#nwpCategory`, `#nwpLevel`,
`#nwpEmployment`), toggled against `#positionNCH` by `applyCompany()`
alongside the logo swap. `NWP_ROLE_CATEGORIES` maps each role to its valid
categories (DG/MC → Cat 1, CN/RB → Cat 2, RI/RA → Cat 3, CO → Cat 3-7,
**SUPERVISOR → `[]`**) — changing the role clears and rebuilds the category
options via `updateNwpCategoryOptions()`, since a category valid for one
role usually isn't valid for another. Supervisor sits outside the EBA
crane/rigger wage schedule entirely, so it has no CAT or LV at all —
`updateNwpCategoryOptions()` detects an empty category list (`hasStructure`
check) and disables both `#nwpCategory` (shown as a single "N/A" option)
and `#nwpLevel`, and the role-change handler also clears `state.nwpLevel`
when switching to a no-structure role. Any future role with no category
structure should map to `[]` the same way, not be special-cased by name.
`buildNwpPositionString()` mirrors this — for a no-structure role it omits
the "CAT x LVy" segment entirely (e.g. "SUPERVISOR CASUAL" instead of
"CO CAT 5 LV2 CASUAL") — and uppercases the employment type ("CASUAL"/
"FULL TIME", defaulting to Casual). That's what actually gets printed into
`buildPdfNWP()`'s Position cell — not `state.position`, which stays
NCH-only. Like the NWP
position fields, `state.nwpRole/nwpCategory/nwpLevel/nwpEmployment` persist
through `clearForm()` same as `empName` (see its keep-list) since someone's
classification doesn't change week to week; `chooseCompany()` doesn't touch
them either. `validateRequiredFields()` branches on `getCompany()` to
require `nwpRole` (plus `nwpCategory`/`nwpLevel` only if that role actually
has a category structure) instead of `state.position` before
submit/download.

**Email subject tags** (`submitTimesheet()`'s `subjectTags` array) flag
things the admin should notice at a glance: Leading Hand/Supervisor
Allowance and Higher Duties (both companies, day-level fields), plus
`'Supervisor'` when NWP's Position role is Supervisor (`state.nwpRole===
'SUPERVISOR'`) — a separate check since that's a one-time role pick, not a
per-day field like the others.

**The timesheet and leave actionbars each have their own admin-email
hint** (`#timesheetHintEmail` in `#timesheetActionbar`, and a plain
hardcoded `<b>` in `#leaveActionbar` that's always `opsadmin@norwestcranehire.com.au`
regardless of company — leave applications go to NCH either way). Use the
specific ID, not a generic `.actionbar .hint b` selector — that used to
grab whichever one appears first in the DOM (the leave one), silently
leaving the timesheet's hint stuck on its initial hardcoded value and
wrongly overwriting the leave one's fixed address. Found and fixed
alongside the NWP position work below.

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
ever breaks again, check for an exact string mismatch here first. The
`CLIENTS` dropdown list is identical for both companies — NWP used to
filter out `'NCH FLIGHTS'` but that was removed per user request, so don't
reintroduce a per-company filter here without checking first.

**Week Ending date auto-fills all 7 day dates** (`populateWeekDates()` /
`isoAddDays()`). This uses manual UTC-safe date arithmetic
(`Date.UTC(...)` + `getUTCDate()`), NOT `new Date(iso).toISOString()` —
the naive version caused an off-by-one-day bug for users in timezones ahead
of UTC (e.g. Perth, AWST +8), because parsing as local midnight then
serializing via `toISOString()` silently shifts the date back a day.
Keep all date math UTC-based. Applies to the timesheet's week only — the
leave form's dates are simple single-date pickers, no cascading fill.

**The per-day "Date" field in `renderDay()` is a plain readonly text
input, not `type="date"`** — deliberately. It's purely a display of
`state.days[i].date` (clicking it just flashes the Week Ending reminder;
it was never actually editable), and a native `<input type="date">` here
hit a real bug: its displayed format is governed by the browser/OS locale,
and recreating one repeatedly via `innerHTML` (which happens on every
`setDay()` tab switch) triggered inconsistent locale detection on at least
one Android WebView — the first day shown would render dd/mm/yyyy
correctly and every day after would silently flip to mm/dd/yyyy, despite
the underlying value being identical in shape for all 7 days. Rendering it
as plain text via `fmtDateDDMMYYYY()` sidesteps the whole class of bug by
never depending on locale-driven native date-input rendering at all. Don't
change this back to `type="date"` for a field that's just showing a
computed value, non-editable — use plain text for any future read-only
date display in this app for the same reason.

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

**One phone = one user (v1.30).** The employee name is kept in sync across
the timesheet, leave, training and medical forms (`NAME_FIELDS`,
`shareName()`, `fillBlankNames()` on startup). Names, position/emp no and
every signature are "sticky": "Start new week" and each form's clear button
keep them; only the person deleting them (or a signature's own Clear link)
removes them. Don't add anything that clears identity or signatures
automatically without asking.

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

**Job client dropdown's "Other (type manually)" option needs its own
`otherClient` flag on the job object** (`{no,client,hours,otherClient}`)
— don't try to infer "is this Other?" from `j.client` being non-empty and
not in `CLIENTS`, the way it briefly was. Selecting "Other" sets
`client=''` (there's genuinely nothing typed yet), and without a separate
flag, the very next re-render sees an empty falsy `client` and can't tell
"Other, not yet typed" apart from "nothing selected" — it silently
reverts the dropdown to blank and never renders the manual-entry text
input at all, so there's no way to type a custom client name. This was a
real bug (found via user report), not hypothetical. The leave form's
`cityDropdownField()`/`wireCityDropdown()` already had this right via its
own `otherFlag` — the job-client dropdown just never followed the same
pattern. Keep both in sync if either changes.

## Backend automation (separate from this repo)
**Start with `docs/RUNBOOK.md`** for how it all fits together and what to do
when it breaks; `docs/job-numbers-setup.md` is the step-by-step rebuild.

A Google Apps Script project ("Job Numbers API") handles the monthly job
number sync. It's bound to the job numbers Google Sheet (Extensions → Apps
Script), in the Google account that receives Norwest's "Visual Dispatch"
emails. Source of truth for the code is `apps-script/JobNumbers.gs` in this
repo: paste it into the editor after any change. (Before Oct 2026 the
original lived under aiden.tunupopo's account and its code was never saved
anywhere; it was lost when the sheet was deleted.)
- `doGet()` serves the JobNumbers sheet as JSON to the PWA. Live endpoint
  the app depends on; changing it needs Manage deployments → New version.
- `processJobNumberEmails()` reads Gmail threads labelled
  `Process-JobNumbers` (applied by a Gmail filter: From
  `@norwestcranehire.com.au`, has the words `Visual Dispatch`), writes the
  month's row, removes the label, then runs `checkCurrentMonth_()`. Runs on a
  **daily 9–10am time-driven trigger** (Apps Script → Triggers).
- `previewOldEmails()` / `backfillOldEmails()` rebuild past months straight
  from Gmail. `testSetup()` and `testAlertEmail()` are manual checks.

**October 2026 outage: the original sheet + script were deleted and couldn't be
recovered** (the old `JOB_NUMBERS_URL` returned Google's "Page Not Found").
Rebuilt on 7 Oct 2026 as a new sheet + bound script (new deployment URL now
in `JOB_NUMBERS_URL`). The script source is saved in
`apps-script/JobNumbers.gs` with step-by-step setup in
`docs/job-numbers-setup.md`. When editing the script, redeploy via Manage
deployments → edit → New version so the URL stays the same. Its email-parsing matcher
(`findJobNumber_`) is a fresh rewrite, tested against the real October 2026
email text (`Port Hedland – NCH 30689`, `...Flights (...) = NCH30405`). It
stores digits only and takes the month from the email's "for the month of
<Month> <Year>" line, NOT the date received (the email arrives the month
before). Sixth column `Medicals` (the yearly Medicals & Lab D&As /
Inductions, Courses & Training number, NCH30406 for 2026) backs the
`NCH MEDICALS/LAB DAS/INDUCTIONS` job client (added in v1.26 as `NCH MEDICALS`,
renamed in v1.28; `loadDraft()` migrates old drafts). Job client PDF cells use
`drawCell(..., {fit:true})` so long names shrink/wrap inside their day column.

**Missing-month warnings (v1.27):** if the sheet has no row for a job
line's month, the job row shows an orange "type it in manually" note
(`.jn-missing`) and the Job numbers card warns about the current month.
`checkForNewMonth()` now also re-fetches (max every 30 min, and on
`visibilitychange`) while the current month is missing, and a successful
fetch runs `autofillAllJobNumbers()` so late numbers fill themselves in.
Month checks use the phone's local month (`currentMonthISO()`), not UTC, so
Perth flips at local midnight. Script side, `checkCurrentMonth_()` emails
the owner daily while the current month's row is missing.

**One-time announcements** (`#noticeModal`, `showNoticeIfNeeded()`): shown
once per phone on next open, gone for good once dismissed (stored as
`norwestNoticeSeen` = `NOTICE_ID`). Brand-new users still on the company
picker skip it, and it stops after `NOTICE_UNTIL`. To send a new one, edit
the modal text and change `NOTICE_ID` + `NOTICE_UNTIL`. First used in v1.29
for the October 2026 job numbers outage.

## Hosting
Static GitHub Pages, repo root. Apps Script (job numbers) is Google's own
infrastructure, not ours to host. There's now also a small Firebase
project (`norwest-forms`) for usage logging only - see its own section
below; it holds no form data, no PDFs, nothing from the actual timesheets/
claims, just a bare event log.

## Usage logging (temporary, ~2-month test)
Person asked whether the app is actually getting used and by how much,
given HR started asking for form changes (implying real usage) despite
only a handful of people having the link. `logUsageEvent()` in index.html
fires a best-effort, fire-and-forget write to a separate Firebase project
(`norwest-forms`, own Firebase project - NOT the same as any other app's)
on every real "Submit & Send" (not the separate "Download PDF" buttons),
recording just `formType` / `name` / `company` / `ip` / `submittedAt` /
`expireAt`.

Two things worth knowing if this ever needs touching:
- **The Medical & D&A Allowance Claim form is deliberately logged WITHOUT
  a name** - `submitMedical()` doesn't pass `empName` through to
  `submitClaimPdf()`/`logUsageEvent()` at all, unlike every other form.
  This was a direct ask: even though D&A testing isn't stigmatized in this
  industry, "who submitted the medical form" is the one piece of usage
  data here that edges toward health information, so it stays anonymous
  (formType+company+timestamp only) regardless of that context. Don't
  thread a name through for this form without asking first.
- **This is disclosed on the first-open company-picker screen**
  (`#companyGate`) - a one-line addition under the existing "not an
  official system" disclaimer. Silently logging identifiable data (name +
  IP) without telling anyone was flagged as a real problem, not a detail -
  don't remove that disclosure line without replacing it with something
  equivalent, and don't add more logging elsewhere without extending it.

No Firebase SDK added to the app - it's a plain unauthenticated `fetch()`
POST to the Firestore REST API (`logUsageEvent()`'s own comment explains
why: zero other JS dependencies beyond jsPDF, not worth bloating for one
write-only call). IP is self-reported by the client via ipify (a free,
no-key, CORS-friendly "what's my public IP" lookup) - not independently
verified server-side, since that would need a Cloud Function, which needs
Firebase's paid Blaze plan; this project is on the free Spark plan and a
self-reported IP is accurate enough for a usage-volume test.

`expireAt` is set 60 days out per event, meant to be paired with a
Firestore TTL policy on that field so records auto-delete once the test
window passes rather than accumulating personal data indefinitely. TTL
couldn't be set via the admin API this round (403 - a genuine IAM gap on
the project's auto-generated Firebase Admin SDK service account, not the
same "not allowed to touch infra" block security-rules deploys hit) - if
nobody's turned it on via Firestore console (Rules tab's sibling "TTL"
tab, field `expireAt` on the `submissions` collection) by the time this
test should end, delete the `submissions` collection manually instead.

**Reading the stats:** `tools/usage-stats.mjs` (read-only, needs the
service account JSON in `NORWEST_FORMS_SERVICE_ACCOUNT`) lists submissions in
Perth time and summarises each pay week (week ending Sunday, due Monday
10am AWST, late = Monday after 10am). It skips the one `company: TEST`
record written while checking the live rules in Oct 2026. See RUNBOOK §8.

`firestore.rules` in this repo (new file) is write-only and tightly
shaped - a client can create a well-formed event document and nothing
else, never read/list/update/delete. Needs to be published via the
Firebase console's Rules tab for the `norwest-forms` project (same
console-paste-and-publish step every rules change on the sibling
myslewer project needs - couldn't be automated from here either).


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
