# Norwest Forms runbook: when something breaks

Plain-English guide to how the moving parts work, how to check them, and how
to fix them. Written after the October 2026 job numbers outage. For the
deeper code notes see `PROJECT_CONTEXT.md`.

All times are **Perth (AWST, UTC+8, no daylight saving)**. Timesheets are for
the week ending **Sunday** and are due by **Monday 10am**.

---

## 1. The pieces

| Piece | Where it lives | What it does |
|---|---|---|
| The app | `index.html` in this repo → GitHub Pages: https://886ppak.github.io/Norwest-Forms/ | Forms, PDFs, job number auto-fill |
| Job numbers sheet | Google Sheet with a `JobNumbers` tab, in the Google account that receives Norwest's "Visual Dispatch" emails | One row per month: `Month, Port Hedland, Newman, Flights, Logistics, Medicals` |
| Job Numbers API | Apps Script project **"Job Numbers API"**, inside that sheet (Extensions → Apps Script). Source: `apps-script/JobNumbers.gs` | Serves the sheet to the app, reads the monthly email, emails you if a month is missing |
| Gmail filter + label | Same Google account. Label `Process-JobNumbers` | Marks the monthly email so the script picks it up |
| Usage log | Firebase project `norwest-forms`, Firestore collection `submissions` | One record per real "Submit & Send" (temporary test) |

The app reads job numbers from the URL in `JOB_NUMBERS_URL` in `index.html`.
Current deployment (Oct 2026):
`https://script.google.com/macros/s/AKfycbybxIi5mpwWfOangXUqF785UvoQl02v3ldL9mLWJZoWCwKIgEXq514M81OqQGymGL6EFQ/exec`

---

## 2. How job numbers flow each month

1. Late in the month, Norwest Operations (usually Gidget Freeman
   `opsadmin@norwestcranehire.com.au`, sometimes Siti Arifin
   `admin@norwestcranehire.com.au` when Gidget's away) emails the
   "Visual Dispatch (Vis D) numbers ... for the month of November 2026".
2. The Gmail filter (From `@norwestcranehire.com.au` + has the words
   `Visual Dispatch`) labels it `Process-JobNumbers`.
3. The Apps Script trigger runs `processJobNumberEmails` **daily, 9–10am**. It
   reads labelled emails, writes that month's row, removes the label, then
   checks the current month's row exists (and emails you if not).
4. The app downloads the sheet when it's first opened in a new month, when
   someone taps **↻ Refresh job numbers**, and keeps re-checking (max every
   30 min) while the current month is missing.
5. Picking an NCH job client on a day fills in that day's month's number.
   A pay week that crosses a month-end gets both months' numbers.

### What the script pulls from the email

| Email line | Column | App job client |
|---|---|---|
| `Port Hedland – NCH 30689` | Port Hedland | NCH PORTHEDLAND |
| `Newman – NCH 30690` | Newman | NCH NEWMAN |
| `Logistics – NCH 30691` | Logistics | NCH LOGISTICS |
| `...Job Number for Flights (When not paid by a Client) = NCH30405` | Flights | NCH FLIGHTS |
| `...Job Number for Medicals & Lab Das / Inductions, Courses & Training etc NCH30406` | Medicals | NCH MEDICALS/LAB DAS/INDUCTIONS |

Rules it follows (all learned from the real emails, Nov 2025 to Oct 2026):
- **Digits only** are stored: `NCH 30689` and `NCH30405` both become the
  number alone. A job number must be **exactly 5 digits**, so it never grabs
  "NCH", "Operations", the year, or a phone number. (Before this rule, a
  Port Hedland phone number, 91721518, on a line mentioning flights ended up
  in June 2026's Flights cell.)
- **Sense check before writing:** each new number is compared with the
  typical value for that column over the previous 3 months. If it's more
  than 2,000 away (`MAX_JUMP`), it's **not written**; the owner gets an
  email "odd job number(s) not added" listing the month, column and value.
  Normal changes (about +100 a month, about +1,000 for Flights/Medicals at
  the July rollover) pass. If Norwest ever genuinely jumps to a very
  different number range, type it into the sheet by hand once; the next
  months then compare against it.
- **The month comes from the email text** ("for the month of October 2026"),
  not the date it arrived, because it usually arrives the month before.
- **Safety net:** the month can never be earlier than the month 10 days
  after the email arrived. The 26 Feb 2026 email said "February" but was
  March's numbers; this rule files it under March. Early emails (21 Dec for
  January, 1 Jun for June) keep their stated month.
- **Flights and Medicals are yearly numbers** that roll over with the
  financial year in July (2025-26: 29344 / 29345, 2026-27: 30405 / 30406).
  They're stored per month anyway, so the rollover just works.
- If the same month is sent twice (a correction, or a forward), the later
  email wins. Blank values never overwrite a number already there.

---

## 3. Quick health check (2 minutes)

1. **Is the API up?** Open the `/exec` URL above in a browser. You should see
   text like `[{"Month":"10-2026","Port Hedland":"30689",...}]`.
   - Google "Page Not Found" / "file does not exist" → the script or its
     deployment is gone. See **5. Rebuild**.
   - A Google sign-in page → the deployment's access isn't **Anyone**. Fix in
     Deploy → Manage deployments → ✏️ → Who has access: Anyone → Deploy.
   - Works, but this month is missing → see **4. A month is missing**.
2. **Is the app on the latest version?** The version number is top-left
   (`v1.29` as of Oct 2026). Live site:
   `curl -s https://886ppak.github.io/Norwest-Forms/ | grep -o 'appVersion">v[0-9.]*'`
3. **Is the automation running?** Apps Script → ⏰ Triggers. There should be
   one `processJobNumberEmails`, Head, time-based, with a recent "Last run"
   and no error rate.

---

## 4. A month is missing

What people see: an orange "type the job number in manually" note in the app,
and you get a daily email "Norwest Forms: job numbers missing for MM-YYYY".

Fix, quickest first:
1. **Type the row into the sheet by hand.** `MM-YYYY` in column A (e.g.
   `11-2026`) and the five numbers. Columns are plain text, so it stays as
   typed. The app picks it up within 30 minutes or on the next open.
2. **Or let the script do it:** find the email in Gmail, add the
   `Process-JobNumbers` label, then in Apps Script run
   `processJobNumberEmails`.
3. If the email arrived but numbers weren't picked up: in Apps Script run
   `testSetup` (reads the newest labelled email, writes nothing) and look at
   the log. A `(not found)` means Norwest changed the wording; update
   `findJobNumber_` / `parseJobNumbers_` in `apps-script/JobNumbers.gs`
   against the new email text, then paste the new version in.
4. **A number in the sheet looks wrong?** Set `TRACE_VALUE` at the bottom of
   the script to that number, run `traceValue`, and the log shows which
   email(s) it came from: date, sender, subject and the exact line. Correct
   the cell by hand, or fix the parser and re-run `backfillOldEmails`.

---

## 5. Rebuild from scratch (the October 2026 situation)

What happened: the original sheet (with its script inside it) was deleted,
probably more than 30 days earlier since both Drive Trash and Apps Script
Trash were empty. The app kept using its last saved numbers until October,
when there was nothing for the new month. The old script's code had never
been saved anywhere, which is why `apps-script/JobNumbers.gs` now exists.

Before rebuilding, check (signed into the right Google account, ideally in a
private window so another signed-in account doesn't get in the way):
- drive.google.com → search `JobNumbers`, and **Trash**
- script.google.com → **Trash** in the left sidebar (separate from Drive's)
- myaccount.google.com → Security → recent activity, in case someone got in

If it's gone, follow `docs/job-numbers-setup.md` end to end (about 15 min):
sheet → paste script → deploy as web app (Execute as Me, access Anyone) →
put the new `/exec` URL in `JOB_NUMBERS_URL` in `index.html` and bump the
version → Gmail filter + label → `testSetup` → trigger → `testAlertEmail`.
Then run `previewOldEmails` and `backfillOldEmails` to restore past months
straight from Gmail.

Gotchas we hit:
- **Pasting into the sheet:** single-click a cell, don't double-click, or
  everything lands in one cell. Easiest is typing the 12 cells directly
  after setting columns A–F to Format → Number → Plain text.
- **Permissions screen:** Google's consent page has a tick box per
  permission. Untick any and that feature silently fails later. Tick **Select
  all**. If it won't ask again, remove access at
  myaccount.google.com/permissions and re-run.
- **Two script files** in the project (e.g. `Code.gs` and an older copy):
  Apps Script may run the old function. Keep exactly one file.
- **Editing the script later:** Deploy → Manage deployments → ✏️ → Version:
  **New version**. "New deployment" makes a new URL and breaks the app.
  Changes to anything except `doGet` don't need a redeploy at all; the
  trigger always runs the latest saved code.

---

## 6. Telling everyone something (one-time pop-up)

`index.html` has a one-time announcement (`#noticeModal`). It shows once per
phone on next open and is gone for good once dismissed. Brand-new users skip
it. To send a new one: edit the text inside `#noticeModal`, change
`NOTICE_ID` to something new (e.g. `jobnumbers-dec2026`) and `NOTICE_UNTIL`
to a cut-off date, bump the version, push to `main`.

Real push notifications aren't possible with this setup (they'd need a
notification server and every worker opting in).

---

## 7. Shipping an app change

1. Edit `index.html`.
2. Bump `.appVersion` in `index.html` **and** `CACHE_NAME` in
   `service-worker.js` (see PROJECT_CONTEXT "Service worker versioning").
3. Push to `main`. GitHub Pages updates in about a minute; check with the
   `curl` line in section 3.
4. Phones pick it up on next open. Some need a second open, or a tap on the
   refresh icon top-right.

---

## 8. Usage stats (temporary, started ~30 Sep 2026)

Every real "Submit & Send" logs form type, name, company, IP and time to
Firestore. The Medical & D&A claim is logged **without a name** on purpose.
Records carry `expireAt` (60 days).

To see the numbers:
```
NORWEST_FORMS_SERVICE_ACCOUNT="$(cat key.json)" node tools/usage-stats.mjs
```
The key comes from Firebase console → Project settings → Service accounts →
Generate new private key. Keep it out of the repo. In a Claude Code cloud
environment it's set as the `NORWEST_FORMS_SERVICE_ACCOUNT` environment
variable. The tool is read-only; it lists every submission in Perth time and
summarises each pay week (people, forms, who was late after Monday 10am).

First week (week ending Sun 4 Oct 2026): 13 timesheets from 12 people (7 NWP,
5 NCH), 3 after the Monday 10am deadline, no leave/training/medical forms.

Loose ends:
- A test record (`company: TEST`, name "TEST - Claude rules check, ignore")
  is in the collection. The tool skips it. Delete it in the Firebase console
  if you like.
- **TTL isn't confirmed on.** Firebase console → Firestore → TTL → add a
  policy on `expireAt` for `submissions`, or delete the collection when the
  test ends, so names and IPs don't pile up.
- `firestore.rules` (write-only, tightly shaped) is published; reads and
  malformed writes are refused.

---

## 9. Ideas not done yet

- Discord webhook alerts to the homelab server instead of / as well as
  email, plus an in-app "Report an issue" button that posts there via the
  Apps Script (never put the webhook URL in the public app).
