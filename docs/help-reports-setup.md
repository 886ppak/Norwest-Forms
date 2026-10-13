# Help tab reports: setup

The app's **Help** page (the **?** icon at the top, next to refresh and share) has a "Report a problem" form (message, type, up to 3
screenshots, optional name/contact). Reports go:

```
Phone ─► Firestore (norwest-forms project: report + screenshots)
           ─► Cloud Function deliverHelpReport (australia-southeast1)
                ├─► Nextcloud: PWA/Norwest-forms/<date> #<ref> <type>/report.txt + shot-N.jpg + read-only share link
                ├─► Discord: message with the details, screenshots and the Nextcloud link
                └─► deletes the screenshots from Firestore (keeps the small text record)
```

Same Firestore → function → Nextcloud hand-off as myslewer's Lift Library,
without Firebase Storage (screenshots are shrunk to ~150 KB on the phone and
fit in Firestore). Code: `functions/index.js`. Rules: `firestore.rules`
(`helpReports`). App side: `sendHelpReport()` in `index.html`.

The form stays hidden until `HELP_REPORTS_ENABLED` in `index.html` is `true`.
Flip it only after a test report has arrived in Discord.

## One-time setup (about 20 minutes)

### 1. Put the Firebase project on the Blaze plan
Cloud Functions need it (myslewer is already on it).
1. console.firebase.google.com → **norwest-forms** → bottom-left
   **Upgrade** → **Blaze** → link a billing account.
2. Add a safety net: console.cloud.google.com/billing → **Budgets & alerts**
   → **Create budget** → project `norwest-forms`, amount **$1**, alerts at
   50/90/100%.

At this volume everything sits inside the free allowances: 2 million
function runs a month, Firestore's free reads and writes, 3 free scheduler
jobs, and 6 free secret versions.

### 2. Discord webhook
Discord → your server → **Server Settings → Integrations → Webhooks → New
Webhook**. Name it "Norwest Forms", pick the channel, **Copy Webhook URL**.
Don't paste it anywhere public: anyone with it can post as it or delete it.

### 3. Nextcloud
1. Reports go in **PWA › Norwest-forms** (`/PWA/Norwest-forms`). The
   function creates those folders if they're missing.
2. **Personal settings → Security → Devices & sessions** → app name
   `norwest-forms` → **Create new app password**. Copy it.
   Use a new one, not myslewer's, so either can be revoked on its own.

### 4. Deploy (Google Cloud Shell, in the browser)
No install needed. Cloud Shell is a browser terminal, already signed in as
you, with the Firebase CLI (`firebase`, not `gcloud`) pre-installed. It's
how myslewer's functions were first deployed too. Paste one command at a
time and let each finish.

1. Open https://shell.cloud.google.com as the Google account that owns the
   `norwest-forms` Firebase project.
2. ```
   git clone https://github.com/886ppak/Norwest-Forms
   ```
   ```
   cd Norwest-Forms/functions && npm install && cd ..
   ```
3. Nextcloud settings (not secret, but they stay out of the repo). Replace
   the placeholders; the address has no trailing `/`:
   ```
   printf 'NEXTCLOUD_DOMAIN=https://YOUR-NEXTCLOUD\nNEXTCLOUD_USERNAME=YOUR-USERNAME\nNEXTCLOUD_REPORTS_PATH=/PWA/Norwest-forms\n' > functions/.env
   ```
4. ```
   firebase login --no-localhost
   ```
   (open the link, approve, paste the code back)
   ```
   firebase use norwest-forms
   ```
5. Secrets: each asks you to paste the value, and nothing shows while you
   paste.
   ```
   firebase functions:secrets:set NEXTCLOUD_APP_PASSWORD
   ```
   ```
   firebase functions:secrets:set DISCORD_WEBHOOK_URL
   ```
6. ```
   firebase deploy --only functions,firestore:rules
   ```
   Answer **y** to enabling Google APIs (Cloud Functions, Cloud Build,
   Artifact Registry, Eventarc, Cloud Scheduler, Secret Manager). It should
   end with **Deploy complete!** and list:
   - `deliverHelpReport`: runs on each new report
   - `cleanupOrphanHelpShots`: daily 3am Perth, removes screenshots whose
     report never arrived

`firestore:rules` publishes the rules from this repo, which also keep the
usage log's rules exactly as they are.

Later changes to `functions/` need the same `firebase deploy` again (Cloud
Shell keeps the clone; `git pull` first). If deploys become frequent, a
GitHub Action like myslewer's `.github/workflows/firebase-deploy.yml` can do
it automatically on push. It needs a deploy service account key stored as a
GitHub secret, and myslewer's experience is that the account ends up needing
broad roles.

### 5. Turn the form on
Tell Claude (or edit it yourself): set `HELP_REPORTS_ENABLED = true` in
`index.html`, bump the version, push to `main`. Then send a test report from
the Help page and check that Discord and Nextcloud both receive it. Once it
works, send everyone a one-time pop-up (`#noticeModal`, new `NOTICE_ID`)
pointing them to the **?** icon.

## Day to day
- **Where reports land:** Discord (instant) and Nextcloud (permanent copy).
  Each has a reference like **#TXT295** that the worker also sees.
- **Status** is written back to the Firestore record: `delivered`, `partial`
  (one of Nextcloud/Discord failed), `failed` (both failed; the screenshots
  are kept in Firestore so nothing's lost), or `throttled` (more than 15
  reports in an hour, which is treated as spam and not forwarded).
- **Logs:** Firebase console → Functions → `deliverHelpReport` → Logs.
- **Rotate a secret:** `firebase functions:secrets:set <NAME>`, then
  `firebase deploy --only functions`.
- **Turn reports off quickly:** set `HELP_REPORTS_ENABLED = false` and push.
  The Quick fixes stay visible.

## Tested (Oct 2026, local Firebase emulators + stand-in Nextcloud/Discord)
- Rules: valid report and screenshots accepted; reading back, updating,
  deleting, wrong ref, bad type, empty or 2001-character message, extra
  fields, 4 screenshots, a stale timestamp, screenshot id 3, a PNG and an
  oversized screenshot all refused. The usage log still accepted.
- Happy path from the real Help tab on a phone-sized screen: Nextcloud
  folder, report.txt and screenshots, share link, Discord post with images,
  screenshots removed from Firestore, status `delivered`.
- Nextcloud down → `partial`, Discord still posted. Both down → `failed`,
  screenshots kept.

## Usage log archive to Nextcloud (exportUsageToNextcloud)
Same functions deploy, same Nextcloud app password. Every **Sunday 11:00
Perth** it writes the usage log (`submissions/`) to
`PWA/Norwest-forms/Usage/usage-YYYY-MM.csv`, one file per month. Columns:
`perth_time, week_ending, late, form, company, name, ip` (medical rows have no
name). Only this month's and last month's files are rewritten, so older months
stay put as the permanent history. Firestore only keeps ~60 days and is what
the live dashboard reads. To run it now (e.g. right after the first deploy):
```
gcloud scheduler jobs run firebase-schedule-exportUsageToNextcloud-australia-southeast1 --location australia-southeast1 --project norwest-forms
```
Tested (Oct 2026, Firestore emulator + stand-in Nextcloud): rows split into the
right Perth month (a 1 Oct 01:00 timesheet goes in October), pay week and
late flag correct, commas in names quoted, medical without a name, rows
older than last month and the TEST record skipped.
