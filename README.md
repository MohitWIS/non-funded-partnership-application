# Non-Funded Partnership Application — Zoho Creator Widget

A dashboard widget for the **non-funded-partnership-application** app
(account: `itzoho_nsdcindia`). It fetches these reports via the Creator
Widget SDK (v2, with v1 fallback) and renders KPIs, a status donut, a
time-trend chart and a recent-applications table — no external JS libraries:

| Metric | Report link name |
|---|---|
| Total applications / trend / recent table | `NSDC_Partnership_Application_Report` |
| Pending cases | `My_Pending_Cases` |
| Approved | `Approved_Cases` |
| Rejected | `Rejected_Cases` |
| Sent back | `Sent_Back_Cases` |
| Resubmitted | `Resubmitted_Cases` |
| Emails sent | `All_Emails` |

Features: date-range filter (all time / 90 / 30 / 7 days), chart⇄table
toggles, hover tooltips + keyboard navigation, and dark-mode support.

**Inside Zoho Creator the widget always shows live report data.** If the
SDK or a report fetch fails it shows an explicit error (with a Retry
button, or a "Couldn't load report" note on the affected tile) — it never
substitutes demo numbers. Sample data (clearly badged) appears only when
the page is opened outside Creator, e.g. locally via `zet run`, where no
SDK exists.

Report/app names are configured at the top of `app/js/script.js` (`CONFIG`).

## Project Structure

```
non-funded-partnership-application/
├── plugin-manifest.json   # Widget manifest (service: CREATOR)
└── app/
    ├── widget.html        # Widget entry point
    ├── css/
    │   └── style.css      # Widget styles
    └── js/
        └── script.js      # Widget logic (SDK init)
```

## Prerequisites

- Node.js
- Zoho Extension Toolkit (ZET):

```bash
npm install -g zoho-extension-toolkit
```

## Local Development

Run a local server from the project root:

```bash
zet run
```

Then open `https://127.0.0.1:5000/widget.html` in your browser (accept the self-signed certificate).

## Validate & Package

```bash
zet validate
zet pack
```

`zet pack` creates a zip file inside the `dist/` folder.

## Upload to Zoho Creator

1. Open your Creator app **non-funded-partnership-application**.
2. Go to **Settings → Widgets** (under Extensions).
3. Click **New Widget**, give it a name, and upload the zip from `dist/`.
4. Add the widget to a page in your app.
