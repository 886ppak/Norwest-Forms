# Job Numbers setup (rebuild guide)

The app fills in job numbers from a Google Sheet, served through an Apps
Script web app. The original sheet and script were deleted in October 2026.
These are the steps to rebuild them. The script source is saved in
`apps-script/JobNumbers.gs` so it can't be lost again.

Do all of this signed into **one** Google account: the one that receives
Norwest's monthly job numbers email.

## 1. Create the sheet
1. Go to sheets.google.com and create a blank spreadsheet. Name it
   `Norwest Job Numbers`.
2. Rename the tab at the bottom (`Sheet1`) to exactly `JobNumbers`.
3. Select columns A to F, then **Format → Number → Plain text**. This stops
   `10-2026` turning into a date.
4. Type these headers in row 1, spelled exactly like this:

   | A | B | C | D | E | F |
   |---|---|---|---|---|---|
   | Month | Port Hedland | Newman | Flights | Logistics | Medicals |

5. Add a row for the current month, e.g. `10-2026` in column A (two-digit
   month, dash, four-digit year), then that month's job number under each
   site. This gets the app working straight away, even before the email
   automation is set up.

## 2. Add the script
1. In the sheet: **Extensions → Apps Script**.
2. Delete everything in `Code.gs` and paste in the whole of
   `apps-script/JobNumbers.gs` from this repo.
3. Click the project name at the top and rename it `Job Numbers API`.
4. Click **Save** (the disk icon).

## 3. Deploy it as a web app
1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**. It must be
   *Anyone*, not *Anyone with a Google account*, or workers' phones can't
   read it.
4. Click **Deploy**, then go through the permission prompts. If you see
   "Google hasn't verified this app", click **Advanced → Go to Job Numbers
   API (unsafe)**. It's your own script.
5. Copy the **Web app URL**. It ends in `/exec`.
6. Open that URL in a browser. You should see your rows as text, like
   `[{"Month":"10-2026","Port Hedland":"..."}]`.
7. Send the URL to whoever maintains the app (or Claude) so
   `JOB_NUMBERS_URL` in `index.html` can be updated.

Later script edits: use **Deploy → Manage deployments → ✏️ edit → Version:
New version**. That keeps the same URL. **New deployment** creates a new URL
and the app would need updating again.

## 4. Gmail label and filter (automation)
1. In Gmail, open last month's job numbers email from Norwest.
2. Click the **⋮** menu → **Filter messages like these**. Keep the "From"
   address, and add a subject word if needed so only this email matches.
3. Click **Create filter**, tick **Apply the label → New label**, and name it
   exactly `Process-JobNumbers`. Click **Create filter**.
4. Add that label to the existing email by hand too, for testing.

## 5. Test the parsing
1. Back in Apps Script, pick `testSetup` in the function dropdown at the top
   and click **Run**.
2. Open **Execution log**. It lists the job number it found for each site.
   For the October 2026 email it should show `Month: 10-2026`,
   `Port Hedland: 30689`, `Newman: 30690`, `Flights: 30405`,
   `Logistics: 30691`, `Medicals: 30406`.
3. If any are wrong or `(not found)`, Norwest has probably changed the email
   wording. Send a copy of the new email text so `findJobNumber_` can be
   adjusted.

## 6. Schedule it
1. In Apps Script, click the **clock icon (Triggers)** on the left.
2. **Add Trigger** → function `processJobNumberEmails`, event source
   **Time-driven**, type **Hour timer**, **Every hour**. Save.

Each hour it checks for emails with the label, writes that month's row, and
removes the label. It reads the month from the email's "for the month of
October 2026" line (the email usually arrives late the month before) and
stores just the digits of each job number (`NCH 30689` → `30689`). The
yearly Medicals & Lab D&As / Inductions, Courses & Training number
(NCH30406) goes in the `Medicals` column and fills in when someone picks
the `NCH MEDICALS` job client in the app.

## If a month's numbers don't arrive
- **Workers:** when there's no row for the month, the app shows an orange
  warning on the Job numbers card and under any NCH job line, telling them to
  type the job number in manually. The app re-checks the sheet every time
  it's opened (at most every 30 minutes) and fills the numbers in as soon as
  they appear.
- **You:** each daily run of `processJobNumberEmails` emails the script's
  owner if the sheet has no row for the current month, and repeats daily
  until the row is there. The first run after pasting this version asks for
  permission to send email: run `processJobNumberEmails` once by hand and
  allow it.
- Check **Project Settings (⚙️) → Time zone** is `(GMT+08:00) Perth`, so
  "the current month" flips at Perth midnight.

## Fill in older months (optional, one-off)
Pay weeks that cross a month-end need both months' numbers, because each
day looks up its own month. To pull every past job numbers email out of
Gmail at once:
1. In Apps Script, run `previewOldEmails`. The log lists each email found,
   the month it's for and its numbers. Nothing is changed.
2. If that looks right, run `backfillOldEmails`. It writes a row per month
   (updating any that already exist) and sorts the sheet oldest-first.

It searches all of Gmail for `"Visual Dispatch" "month of"`, so it finds
emails whoever sent them, with or without the label.

## Safeguards
- **Don't delete the sheet.** The script lives inside it, so deleting the
  sheet deletes the script and breaks the app's link.
- Drive keeps deleted files in **Trash for 30 days** if it happens again.
- **Back up the sheet:** File → Make a copy every so often, or keep a copy in
  another account.
