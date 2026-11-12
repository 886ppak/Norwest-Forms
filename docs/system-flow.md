# NCH Forms — how everything is connected

Where each piece of data comes from, where it goes, and which Google/Firebase/GitHub service
holds it. Read this with `PROJECT_CONTEXT.md` (app detail), `job-numbers-handover.md` (Apps Script)
and `RUNBOOK.md` (deploys and fixes).

## 1. Full picture

```mermaid
flowchart LR
    %% ---------- Sources ----------
    subgraph SRC["Where data comes from"]
        DISP["Norwest monthly<br/>'Visual Dispatch' email<br/>(job numbers, 5 sites)"]
        MOB["Mobilisation email<br/>(worker's job rows)"]
        WORKER["Worker fills a form<br/>on their phone"]
    end

    %% ---------- Job numbers pipeline ----------
    subgraph JN["Job numbers pipeline (Google, Job Numbers script)"]
        LBL["Gmail label<br/>Process-JobNumbers"]
        REAP["Daily trigger<br/>processJobNumberEmails"]
        SENSE{"Sense-check<br/>(MAX_JUMP 2000)"}
        SHEET[("Google Sheet<br/>JobNumbers<br/>Month | 5 sites")]
        WEB["Web app doGet<br/>returns JSON"]
        DISP --> LBL --> REAP --> SENSE
        SENSE -- "plausible" --> SHEET --> WEB
        SENSE -- "refused" --> ALERT1["Email owner +<br/>Discord notice"]
    end

    %% ---------- The PWA on each phone ----------
    subgraph PWA["NCH Forms PWA (index.html, GitHub Pages)"]
        OPEN["App opens<br/>(company picked once)"]
        FETCH["Fetch job numbers<br/>store in phone localStorage<br/>(on open, refresh, every 30 min<br/>while this month is missing)"]
        AUTO["Job line: pick client<br/>+ this month => job number<br/>auto-filled"]
        FORMS["Forms:<br/>Timesheet (NCH / NWP)<br/>Leave and R&amp;R<br/>Training claim<br/>Medical &amp; D&amp;A claim"]
        CAL["Job calendar<br/>(stored on this phone only)"]
        HELP["Help / Report a problem"]
        OPEN --> FETCH --> AUTO --> FORMS
    end

    WEB -- "JSON" --> FETCH
    MOB -- "Share or paste" --> CAL
    WORKER --> OPEN

    %% ---------- Where forms go ----------
    subgraph OUT["Where each form is sent (Share sheet or mailto, the worker sends it)"]
        A1["NCH timesheet"]
        A2["NWP timesheet"]
        A3["Leave / R&amp;R"]
        A4["Training and medical claims"]
        MAIL1["admin@norwestcranehire.com.au"]
        MAIL2["payroll@norwestpersonnel.com.au"]
        MAIL3["opsadmin@norwestcranehire.com.au"]
        MAIL4["hr@norwestpersonnel.com.au"]
        A1 --> MAIL1
        A2 --> MAIL2
        A3 --> MAIL3
        A4 --> MAIL4
    end
    FORMS --> A1
    FORMS --> A2
    FORMS --> A3
    FORMS --> A4

    %% ---------- Logs and admin ----------
    subgraph FB["Firebase (norwest-forms project)"]
        SUBS[("submissions<br/>name, form, company,<br/>installed, time<br/>(90-day expiry)")]
        USE[("usageEvents<br/>opens, calendar imports<br/>(90-day expiry)")]
        REPORTS[("helpReports<br/>+ screenshots")]
        DELIV["deliverHelpReport<br/>(Cloud Function)"]
        ARCH["archiveUsageDaily<br/>02:30 Perth"]
    end
    FORMS -- "each send logs a row" --> SUBS
    FETCH -- "each open" --> USE
    CAL -- "each import" --> USE
    HELP --> REPORTS --> DELIV

    subgraph NC["Nextcloud (PWA/Norwest-forms)"]
        NCSTORE["Usage CSVs (forever)<br/>Help reports"]
    end
    ARCH --> NCSTORE
    DELIV --> NCSTORE
    DELIV --> DC

    subgraph ADM["Owner's admin dashboard (admin.html, passkey/Google sign-in)"]
        DASH["Usage, submissions,<br/>help reports,<br/>job numbers Health row"]
    end
    SUBS --> DASH
    USE --> DASH
    REPORTS --> DASH
    NCSTORE -. "older months" .-> DASH
    WEB -- "same URL" --> DASH

    subgraph DC["Discord"]
        CHAN["One channel:<br/>help reports, job number alerts,<br/>daily health check failures"]
    end
    ALERT1 --> CHAN
    HELP -. "via function" .-> CHAN

    %% ---------- Daily check ----------
    CHK["Daily health check<br/>(pve, 08:17 Perth)"]
    CHK -- "fetch JSON" --> WEB
    CHK -- "FAIL only" --> CHAN
```

## 2. Where each form goes

| Form | Who it's for | Sent to | Notes |
|---|---|---|---|
| NCH weekly timesheet | Norwest Crane Hire | `admin@norwestcranehire.com.au` | Job lines use auto-filled job numbers. |
| NWP weekly timesheet | Norwest Personnel | `payroll@norwestpersonnel.com.au` | |
| Leave / R&R | Both companies | `opsadmin@norwestcranehire.com.au` | Address hard-coded in `submitLeave()` for both companies. |
| Training payment claim | Norwest Personnel | `hr@norwestpersonnel.com.au` | Sent via `submitClaimPdf()`, not the company admin address. |
| Medical & D&A allowance claim | Norwest Personnel | `hr@norwestpersonnel.com.au` | Same path as training claim. |

Sending uses the phone's **Share** sheet when available (the PDF is attached). Otherwise it copies the
address and opens a `mailto:` link. Either way the worker sends it; the app doesn't email anything itself.

## 3. Where the job numbers come from

1. Norwest's monthly **Visual Dispatch** email carries the job numbers for the 5 sites.
2. A Gmail label (`Process-JobNumbers`) marks it; the daily trigger reads it into the **JobNumbers** sheet.
3. The sheet is served as JSON by the web app (`doGet`).
4. **Each phone** fetches it itself (on open, refresh, and every 30 min while the current month is missing) and
   stores it locally. Picking a client on a timesheet job line fills in that month's number.
5. The **admin dashboard** reads the same JSON for its Health row.

The **mobilisation email** is different: it lists one worker's job rows. Sharing it into the app adds them to
the **job calendar** on that phone only. I found no code that feeds the calendar into the timesheet.

## 4. What is logged

- **Every send** writes a row to `submissions` (form, name, company, installed or browser, IP, time).
- **Every app open** and **calendar import** writes a row to `usageEvents`.
- **Help reports** go to `helpReports`, then a Cloud Function forwards them to Nextcloud and Discord.
- Firestore rows expire after 90 days. `archiveUsageDaily` (02:30 Perth) keeps monthly CSVs in Nextcloud
  forever, and the admin dashboard reads them back for older months.

## 5. Where things live

| Thing | Where | Deployed by |
|---|---|---|
| `index.html`, `admin.html`, `service-worker.js` | GitHub Pages (`main`) | Push to `main` |
| Job numbers script and sheet | Google Apps Script (job numbers Google account) | Editor: Deploy → Manage deployments |
| Firestore rules, Cloud Functions | Firebase `norwest-forms` | From pve: `firebase deploy` |
| Daily health check | pve systemd timer, 08:17 | `tools/jobnumbers-check.sh` |
| Discord webhook | GCP Secret Manager `DISCORD_WEBHOOK_URL` | Never in code |

## 6. The job-numbers URL is in two files

`index.html` and `admin.html` each have a `JOB_NUMBERS_URL` constant. They must match. The URL only
changes when the web app gets a **new deployment** (not a new version). After one, update both files and bump
the service worker cache name.

## 7. What to check when something breaks

| Symptom | Where you see it | Cause seen so far | Fix |
|---|---|---|---|
| PWA: "Could not refresh — check connection" | Job numbers card | Web app returns an Apps Script permission error. Not the phone's connection. | Run `testSetup` in the script editor with Select all. Then Deploy → Manage deployments → New version. Check the URL returns JSON. |
| Admin Health: "couldn't fetch" | Admin dashboard | `admin.html` pointed at a dead URL. Fixed 12 Nov (commit `2185504`). | Keep the URL the same as `index.html`. |
| No new job numbers after the monthly email | Trigger history in the script editor | Gmail permission lapsed (4–5 Nov, after a password change). | Same as the first row: run `testSetup` with Select all. |
| Permissions suddenly missing after a manifest edit | Trigger and web app both fail | `oauthScopes` replaces auto-detected scopes. Keep the full list. (29 Oct.) | Restore the full scope list, then re-consent. |
| A job number is missing from the sheet | Email to owner + Discord notice | Sense-check refused a number far from recent months. Deliberate. | Use `traceValue` in the script to find the source email. |
| Daily check posts to Discord | Discord channel | The web app stopped returning JSON. The message has the server's error. | Use the first row's fix. |

## 8. Not in this file

Webhook URLs, OAuth client secrets and refresh tokens are not written here. They live in GCP Secret Manager
(`DISCORD_WEBHOOK_URL`) and the homelab secrets file.
