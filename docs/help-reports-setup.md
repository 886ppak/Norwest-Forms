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

### 4. Deploy (from the computer you deploy myslewer from)
```bash
git clone https://github.com/886ppak/Norwest-Forms   # or: git pull
cd Norwest-Forms/functions
npm install
cp .env.example .env        # then edit .env:
#   NEXTCLOUD_DOMAIN=https://<your nextcloud>   (no trailing slash)
#   NEXTCLOUD_USERNAME=<your nextcloud username>
#   NEXTCLOUD_REPORTS_PATH=/PWA/Norwest-forms
cd ..
firebase use norwest-forms
firebase functions:secrets:set NEXTCLOUD_APP_PASSWORD   # paste the app password
firebase functions:secrets:set DISCORD_WEBHOOK_URL      # paste the webhook URL
firebase deploy --only functions,firestore:rules
```
The first deploy asks to enable a few Google APIs (Cloud Functions, Cloud
Build, Artifact Registry, Eventarc, Cloud Scheduler, Secret Manager). Say
yes. It deploys:
- `deliverHelpReport`: runs on each new report
- `cleanupOrphanHelpShots`: daily 3am Perth, removes screenshots whose
  report never arrived

`firestore:rules` publishes the rules from this repo, which also keep the
usage log's rules exactly as they are.

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
