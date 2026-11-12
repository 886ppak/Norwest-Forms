# NCH Forms — how everything is connected

Where each piece of data comes from, where it goes, and which service holds it. Read this with
`PROJECT_CONTEXT.md` (app detail), `job-numbers-handover.md` (Apps Script) and `RUNBOOK.md` (deploys and fixes).

## 1. Whole system

```mermaid
flowchart LR
    %% ---------- Sources ----------
    subgraph SRC["Where data comes from"]
        DISP["Norwest monthly<br/>'Visual Dispatch' email<br/>(job numbers, 5 sites)"]
        MOB["Mobilisation email<br/>(worker's job rows)"]
        WORKER["Worker on their phone"]
    end

    %% ---------- Job numbers ----------
    subgraph JN["Job numbers (Google Apps Script)"]
        LBL["Gmail label<br/>Process-JobNumbers"]
        REAP["Daily trigger<br/>processJobNumberEmails"]
        SENSE{"Sense-check"}
        SHEET[("Google Sheet<br/>JobNumbers")]
        WEB["Web app doGet<br/>JSON"]
        DISP --> LBL --> REAP --> SENSE
        SENSE -- "plausible" --> SHEET --> WEB
        SENSE -- "refused" --> ALERT1["Owner email +<br/>Discord"]
    end

    %% ---------- The PWA ----------
    subgraph PWA["NCH Forms PWA (index.html)"]
        FETCH["Fetch job numbers<br/>(open, refresh, every 30 min<br/>while this month is missing)"]
        CAL["JOB CALENDAR<br/>(see section 2)"]
        TS["Timesheet<br/>job line: client + date<br/>→ job number auto-filled"]
        FORMS["Forms: Timesheet NCH / NWP,<br/>Leave / R&amp;R,<br/>Training claim, Medical claim"]
        HELP["Help / Report a problem"]
        FETCH --> TS
        CAL -- "'From your calendar' jobs<br/>for that date" --> TS
        TS --> FORMS
    end
    WEB -- "JSON" --> FETCH
    MOB -- "Share into app<br/>or paste text" --> CAL
    WORKER --> FETCH
    WORKER --> CAL
    WORKER --> FORMS

    %% ---------- Sending ----------
    subgraph OUT["Sending (phone Share sheet or mailto; the worker sends)"]
        M1["admin@norwestcranehire.com.au<br/>NCH timesheet"]
        M2["payroll@norwestpersonnel.com.au<br/>NWP timesheet"]
        M3["opsadmin@norwestcranehire.com.au<br/>Leave / R&amp;R"]
        M4["hr@norwestpersonnel.com.au<br/>Training + medical claims"]
    end
    FORMS --> M1
    FORMS --> M2
    FORMS --> M3
    FORMS --> M4

    %% ---------- Firebase logs ----------
    subgraph FB["Firebase (norwest-forms)"]
        SUBS[("submissions<br/>90-day expiry")]
        USE[("usageEvents<br/>opens + calendar imports<br/>90-day expiry")]
        REPORTS[("helpReports")]
        DELIV["deliverHelpReport<br/>Cloud Function"]
        ARCH["archiveUsageDaily<br/>02:30 Perth"]
    end
    FORMS -- "each send" --> SUBS
    FETCH -- "each open" --> USE
    CAL -- "each import" --> USE
    HELP --> REPORTS --> DELIV

    subgraph NC["Nextcloud (PWA/Norwest-forms)"]
        NCSTORE["Usage CSVs (kept forever)<br/>Help reports<br/>Calendar backups"]
    end
    ARCH --> NCSTORE
    DELIV --> NCSTORE

    subgraph DC["Discord (one channel)"]
        CHAN["Help reports, job-number<br/>alerts, daily check failures"]
    end
    DELIV --> CHAN
    ALERT1 --> CHAN
    CHK["Daily health check<br/>pve 08:17 Perth"] -- "fetch JSON" --> WEB
    CHK -- "FAIL only" --> CHAN

    subgraph ADM["Owner's admin dashboard (admin.html)"]
        DASH["Usage, submissions, help reports,<br/>job numbers Health row"]
    end
    SUBS --> DASH
    USE --> DASH
    REPORTS --> DASH
    WEB -- "same URL" --> DASH
    NCSTORE -. "older months" .-> DASH
```

## 2. The job calendar in detail

The calendar lives on each phone. Optional sign-in syncs it to the owner's other phones.

```mermaid
flowchart TD
    subgraph IN["How jobs get in"]
        SHARE["Android: share the mobilisation<br/>email into Norwest Forms"]
        PASTE["iPhone / desktop: paste the<br/>email text, tap Add"]
        GMAIL["Gmail import (beta, owner accounts only)<br/>server scans the mailbox on a schedule"]
    end

    subgraph PHONE["On this phone (localStorage)"]
        PARSE["Parse the email<br/>keeps MOB / DEMOB dates, site,<br/>VD number, codes<br/>drops card and phone numbers"]
        JOBS[("Job emails<br/>norwestCalJobs")]
        ROST[("Roster<br/>norwestCalRoster<br/>painted cycle, repeats 2 years")]
        OVR[("Your changes to single days<br/>norwestCalOverrides")]
        LEAVE[("Old leave list<br/>norwestCalLeave<br/>read only, moved into changes")]
        NAME[("Your name<br/>norwestCalName")]
        GRID["Calendar grid<br/>one code per day, layered:<br/>your change > job email > leave > roster"]
        TSJ["Timesheet job list<br/>'From your calendar'"]
        ICS["Download calendar file (.ics)"]
    end

    SHARE --> PARSE
    PASTE --> PARSE
    NAME -. "used when parsing" .-> PARSE
    PARSE --> JOBS
    GMAIL -- "jobs, fetched on open" --> JOBS
    JOBS --> GRID
    ROST --> GRID
    OVR --> GRID
    LEAVE -. "moved on load" .-> OVR
    JOBS --> TSJ
    JOBS --> ICS
    GRID --> ICS

    subgraph SYNC["Optional account sync"]
        SIGN["Sign in with a passkey<br/>(signin.15buzza.au)"]
        PUT["Sync the stores<br/>newest copy wins"]
        CLOUD[("Firebase: nchUsers<br/>one doc per account")]
        BK["Nightly backup 03:15 Perth<br/>to Nextcloud"]
        OTHER["Your other phones"]
    end
    JOBS <--> PUT
    ROST <--> PUT
    OVR <--> PUT
    NAME <--> PUT
    SIGN --> PUT <--> CLOUD
    CLOUD --> BK
    CLOUD <--> OTHER

    IMP["Usage log: 'calimport'<br/>written only when a job<br/>email lands on the calendar"]
    PARSE -. "logged" .-> IMP
```

What the calendar does for the worker:

- **Jobs from the mobilisation email** show on the grid and in the timesheet's "From your calendar" group.
  Picking one there fills in the job for that day, with the VD number.
- **Roster**: paint one cycle (for example 21 DS then 7 RNR) once; it repeats for two years.
- **Changes to single days** always win over the email and the roster.
- **Download .ics** exports the grid to a normal calendar app.
- **Sync** (optional): the five stores and the profile sync to the account. Clearing the browser data
  loses the local copy unless the account is signed in.
- **Gmail import** is in beta and only for two owner accounts. It is separate from the share/paste route.

## 3. Where each form goes

| Form | Who it's for | Sent to | Notes |
|---|---|---|---|
| NCH weekly timesheet | Norwest Crane Hire | `admin@norwestcranehire.com.au` | Job lines can use calendar jobs or the auto-filled sheet number. |
| NWP weekly timesheet | Norwest Personnel | `payroll@norwestpersonnel.com.au` | |
| Leave / R&R | Both companies | `opsadmin@norwestcranehire.com.au` | Hard-coded in `submitLeave()`. Leave is not written to the calendar by the current app. |
| Training payment claim | Norwest Personnel | `hr@norwestpersonnel.com.au` | Sent via `submitClaimPdf()`. |
| Medical & D&A allowance claim | Norwest Personnel | `hr@norwestpersonnel.com.au` | Same route as the training claim. |

The app never emails anything itself. Sending uses the phone's **Share** sheet when available, otherwise it
copies the address and opens a `mailto:` link. The worker presses send.

## 4. Where the job numbers come from

1. Norwest's monthly **Visual Dispatch** email carries the job numbers for the five sites.
2. A Gmail label marks it; the daily trigger writes it to the **JobNumbers** sheet.
3. The web app serves the sheet as JSON.
4. **Each phone** fetches it (on open, refresh, and every 30 min while this month is missing) and stores it locally.
   Picking a client on a timesheet line fills in that month's number.
5. The **admin dashboard** reads the same JSON for its Health row.

Job numbers from the sheet and jobs from the calendar both feed the timesheet job line. They are separate sources.

## 5. What is logged

- **Every send** writes a row to `submissions` (form, name, company, installed or browser, IP, time).
- **Every app open** and **calendar import** writes a row to `usageEvents`.
- **Help reports** go to `helpReports`; a Cloud Function forwards them to Nextcloud and Discord.
- Firestore rows expire after 90 days. `archiveUsageDaily` (02:30 Perth) keeps monthly CSVs in Nextcloud forever.

## 6. Where things live

| Thing | Where | Deployed by |
|---|---|---|
| `index.html`, `admin.html`, `service-worker.js` | GitHub Pages (`main`) | Push to `main` |
| Job numbers script and sheet | Google Apps Script (job numbers Google account) | Editor: Deploy → Manage deployments |
| Firestore rules, Cloud Functions | Firebase `norwest-forms` | From pve: `firebase deploy` |
| Calendar sync data | Firestore `nchUsers` (one doc per account) | Cloud Functions `nchCalendarGet` / `nchCalendarPut` |
| Gmail import data (beta) | Firestore `nchGmail` | Cloud Functions `nchGmail*` |
| Daily health check | pve systemd timer, 08:17 Perth | `tools/jobnumbers-check.sh` |
| Discord webhook | GCP Secret Manager `DISCORD_WEBHOOK_URL` | Never in code |

## 7. The job-numbers URL is in two files

`index.html` and `admin.html` each have a `JOB_NUMBERS_URL` constant, and they must match. The URL only changes
with a **new deployment** of the web app (not a new version). After one, update both files and bump the service
worker cache name.

## 8. What to check when something breaks

| Symptom | Where you see it | Cause seen so far | Fix |
|---|---|---|---|
| PWA: "Could not refresh — check connection" | Job numbers card | Web app returns an Apps Script permission error. Not the phone's connection. | Run `testSetup` in the script editor with Select all. Then Deploy → Manage deployments → New version. Check the URL returns JSON. |
| Admin Health: "couldn't fetch" | Admin dashboard | `admin.html` pointed at a dead URL. Fixed 12 Nov (commit `2185504`). | Keep the URL the same as `index.html`. |
| No new job numbers after the monthly email | Trigger history in the script editor | Gmail permission lapsed (4–5 Nov, after a password change). | Same as the first row. |
| Permissions suddenly missing after a manifest edit | Trigger and web app both fail | `oauthScopes` replaces auto-detected scopes. Keep the full list. (29 Oct.) | Restore the full scope list, then re-consent. |
| A job number is missing from the sheet | Owner email + Discord notice | Sense-check refused a number far from recent months. Deliberate. | Use `traceValue` in the script to find the source email. |
| Daily check posts to Discord | Discord channel | The web app stopped returning JSON. The message has the server's error. | Use the first row's fix. |

## 9. Not in this file

Webhook URLs, OAuth client secrets and refresh tokens are not written here. They live in GCP Secret Manager
and the homelab secrets file.
