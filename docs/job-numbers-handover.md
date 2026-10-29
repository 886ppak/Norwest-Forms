# Job Numbers — system handover (updated 2026-10-29)

## What this is

The Norwest Forms PWA shows each month's job numbers for five sites (Port Hedland,
Newman, Flights, Logistics, Medicals). Those numbers arrive in Norwest's monthly
"Visual Dispatch" email, get reaped into a Google Sheet by a Google Apps Script, and
the PWA reads that sheet. This file is the maintainer/agent handover for that pipeline
(it complements `job-numbers-setup.md`, which is the from-scratch rebuild guide).

## Architecture

```
Norwest monthly email  ("Visual Dispatch", "for the month of <Month> <Year>")
   │  Gmail filter applies label "Process-JobNumbers"
   ▼
Google Apps Script  "Job Numbers API"   (time-driven trigger, daily 09:10 Perth)
   │  processJobNumberEmails():
   │    - read labelled emails, parse the 5 job numbers, upsert that month's sheet row,
   │      remove the label
   │    - sense-check (MAX_JUMP) refuses implausible numbers
   │    - notifyDiscord_() posts added / refused to Discord
   ▼
Google Sheet  (tab "JobNumbers", columns Month | Port Hedland | Newman | Flights | Logistics | Medicals)
   │  doGet() serves the sheet as JSON
   ▼
PWA  (index.html, JOB_NUMBERS_URL -> the deployed doGet web-app /exec URL)
```

## The Apps Script (`apps-script/JobNumbers.gs`)

Single `Code.gs` file. Functions:

| Function | What it does |
|---|---|
| `doGet` | Serves the sheet as JSON to the PWA (the live `/exec` web-app endpoint). |
| `processJobNumberEmails` | Reads Gmail labelled `Process-JobNumbers`, parses + upserts, removes label, then Discord-notifies. Run by the daily trigger. |
| `parseJobNumbers_` | Maps the 5 site names to `findJobNumber_` regexes. |
| `findJobNumber_` | On a line mentioning a site, grabs the first 5-digit `NCH xxxxx` (or bare `xxxxx`) after it. 5-digit-only, so phone numbers / years / "NCH" don't match. |
| `monthKeyFromEmail_` | Reads "for the month of X YYYY" from the email; sanity-clamps to not-earlier-than "arrived + 10 days" (the email usually arrives late the month before). |
| `upsertMonth_` | Writes the numbers into that month's row, with the **sense-check** (below). |
| `reportSuspicious_` | Emails the owner + Discord-notifies any number the sense-check refused. |
| `getSheet_` | Gets/creates the `JobNumbers` tab, enforces headers + plain-text format. |
| `checkCurrentMonth_` | Emails the owner daily if the current month has no row. |
| `backfillOldEmails` / `previewOldEmails` | Sweep all of Gmail for past "Visual Dispatch" emails and (re)write their rows. |
| `testSetup` | Parses the newest labelled email WITHOUT writing/removing anything — the diagnosis tool. |
| `testAlertEmail` | Sends a test alert email (grants the send-email permission). |
| `traceValue` | Finds which email a given number came from (debug). |
| `notifyDiscord_` | Posts a message to the Discord webhook (silent no-op if unset). |
| `testDiscord` | Posts one test Discord message (verifies the webhook + permission). |

### The sense-check (why a number can silently NOT appear)

`MAX_JUMP = 2000`. For each site, if the incoming number is more than 2000 away from
the median of the last up-to-3 earlier months, `upsertMonth_` refuses it (does NOT write
it), logs + emails "odd job number(s) not added", and now also Discord-notifies. This is
deliberate — a mistyped number (e.g. a phone number like 91721518) must not land in the
sheet. To find where a refused number came from, set `TRACE_VALUE` and run `traceValue`.

### The parser is wording-sensitive

`findJobNumber_` is built against Norwest's October-2026 wording:

```
Port Hedland – NCH 30689
Newman – NCH 30690
Logistics – NCH 30691
...Job Number for Flights (When not paid by a Client) = NCH30405.
...Job Number for Medicals & Lab Das / Inductions, Courses & Training etc NCH30406.
```

If Norwest changes the wording, numbers parse as "(not found)" and nothing is written —
run `testSetup` and read its log to see which sites are `(not found)`, then fix the regex.

## Discord notifications (added 2026-10-29)

The script now posts to Discord (the **same channel as the "Report a problem" helper**):
- ✅ `Norwest job numbers added:` + month + numbers, when the daily run writes them.
- ⚠️ `Norwest job numbers REFUSED by sense-check:` when a number is skipped.
- `testDiscord()` posts a test message.

The webhook URL is a **secret** — it lives in GCP Secret Manager
(`DISCORD_WEBHOOK_URL`, project `norwest-forms`) and in the homelab secrets file, NOT in
this repo. Anyone holding the webhook URL can post to / delete from the channel.

`UrlFetchApp` needs the `https://www.googleapis.com/auth/script.external_request` scope
(declared in `appsscript.json`), which must be re-authorised in the editor after adding it.

## Remote API access (how an AI agent / maintainer edits it)

The script is linked to GCP project **`norwest-forms`** (project number
**1077512044401**). OAuth credentials + a refresh token are stored in the homelab secrets
file (keys `NORWEST_OAUTH_CLIENT_ID`, `NORWEST_OAUTH_CLIENT_SECRET`,
`NORWEST_OAUTH_REFRESH_TOKEN`) — **never in this repo**.

Script ID: `1ZZPJqnBk5PXP3rGitQr6T0syj05JIbZTyN6RDaJCiIXamjolPjUPAyJ5`

Via the Apps Script API (`script.googleapis.com/v1`), with a refreshed access token:
- `GET /projects/{scriptId}/content` — read the source.
- `PUT /projects/{scriptId}/content` — write the source (body `{files:[{name,type,source}...]}`).
- `GET /processes?pageSize=100` — execution history (timestamps, status, duration). The
  per-run log lines are NOT returned by the current API, so diagnosing parsing failures
  means running `testSetup` in the editor and reading its execution log there.

Granted scopes: `script.projects` + `script.processes` (edit + read history) only. The
Gmail and Sheets scopes are intentionally NOT granted (Gmail is a restricted scope that
hard-blocks for an unverified app in production), so the reaper functions themselves are
run by the daily trigger (or manually in the editor), not by the agent.

## Gotchas / operational notes

- **The trigger is DAILY at 09:10 Perth**, not hourly (the setup doc's "every hour" is
  wrong). A new email that arrives after 09:10 waits until the next 09:10.
- "Numbers are missing" is almost always **timing** (the daily run hasn't fired yet) or the
  **Sheets phone app caching** a stale snapshot — not a parsing/sense-check failure. Pull
  to refresh / reopen the sheet before concluding it's broken.
- `checkCurrentMonth_` emails the owner every day until the current month has a row.
- The sheet is plain-text formatted so `10-2026` never turns into a date.

## Session log

- **2026-10-29** — Added Discord notifications (`notifyDiscord_`, ✅/⚠️ posts) + `testDiscord`;
  diagnosed the "missing" November numbers as daily-trigger timing (they were added by the
  09:10 run on 29 Oct); granted `aiden.tunupopo@gmail.com` editor access to `norwest-forms`;
  set up the Apps Script API OAuth access for remote editing.
