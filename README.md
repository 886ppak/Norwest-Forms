# Norwest Crane Hire — Weekly Timesheet PWA

A single-page Progressive Web App that replaces the paper/PDF weekly
timesheet (**NCH-HR-FORM-025**) used by Norwest Crane Hire. Employees fill
it out and sign it on their phone, the app generates a PDF that closely
matches the original company form, and it's shared straight to
`admin@norwestcranehire.com.au`.

**Live app:** https://886ppak.github.io/nch-fulltime-timesheet/

## Features

- 📱 **Installable PWA** — add to home screen, works fully offline after
  the first load (service worker caches the app shell + PDF library).
- 🗓️ **Auto-filled week** — pick a "Week Ending" date and all 7 daily dates
  populate automatically.
- 🔢 **Job number lookup** — selecting a client auto-fills the correct job
  number for that month from a live company spreadsheet.
- ✍️ **On-screen signature** — required before you can download or submit.
- 📄 **PDF generation** — produces a PDF that closely replicates the
  original paper form, including job details, daily hour totals, leave
  legend, and allowance calculations.
- 📤 **One-tap submit** — uses the Web Share API to hand the finished PDF
  straight to your phone's Gmail app, ready to send.
- 🔁 **Start new week** — resets the timesheet for the next week while
  keeping your name and signature saved.

## Usage

Just open the [live app](https://886ppak.github.io/nch-fulltime-timesheet/)
in a mobile browser and, when prompted, install it to your home screen for
the best experience. No account or login required.

## Tech stack

Plain HTML/CSS/JavaScript — no build step, no framework. PDF generation is
handled by [jsPDF](https://github.com/parallax/jsPDF), loaded from a CDN
and cached by the service worker for offline use.

## Project structure

```
index.html         # the entire app: UI, state, and PDF generation
manifest.json       # PWA manifest (icons, app name, install prompt)
service-worker.js   # offline caching + auto-update logic
icons/               # app icons
```

## Local development

This is a static site with no build step — just serve the folder and open
it in a browser:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

Deployment is via GitHub Pages from the repo root, so pushing to `main`
publishes the live site directly.

## Contributing

This is a small, purpose-built internal tool for Norwest Crane Hire.
See [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) for implementation notes,
business-logic details, and things that shouldn't be changed without
checking first — read it before submitting changes.
