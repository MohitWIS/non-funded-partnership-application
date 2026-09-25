# Non-Funded Partnership Application — Zoho Creator Widget

A dashboard widget for the **non-funded-partnership-application** app
(account: `itzoho_nsdcindia`), built with the Creator Widget SDK v2 and no
external JS libraries.

## Dashboards

A switch at the top selects one of two dashboards, each with the same five KPIs:

- **A. Cumulative (Till date)**: everything to date, or the selected date range
- **B. Daily (Today)**: only today's activity

| KPI | How it is counted |
| --- | --- |
| Emails sent | Records in `All_Emails` by `Email_Sent_Date` (form-sharing module) |
| Form responses received | Applications, dated by their first *Submitted* entry in the audit log |
| Approved / Rejected / Sent back cases | Till date with no range: applications whose **current** `Status` is that value (matches the *Approved/Rejected/Sent Back Cases* reports). Today or a date range: applications that got that action in the period, per the audit log. |

Graphs (they follow the selected dashboard and filters):

1. **Emails sent vs responses received** over time (daily, weekly or monthly buckets depending on the span; the Daily dashboard shows the last 7 days)
2. **Case status**: current status of the cases received or acted on in the period
3. **Cases by assignee**: the same cases, stacked by status

Filters: **Assignee** and **Date range** (From–To). On the Daily dashboard the
date range is fixed to today. `All_Emails` has no assignee field, so the email
count ignores the assignee filter, and the tile says so.

Every chart has a Chart/Table toggle, hover tooltips and keyboard navigation,
and the widget supports dark mode.

## Data sources

Configured in `CONFIG` at the top of `app/js/script.js`. Only the listed
fields are requested, so no applicant details are loaded.

| Report | Fields used |
| --- | --- |
| `NSDC_Partnership_Application_Report` | `Status`, `Assignee` |
| `Audit_Log_Report` | `NSDC_Partnership_Application_Form`, `Action_field`, `Action_Time` |
| `All_Emails` | `Email_Sent_Date` |

**Inside Zoho Creator the widget always shows live report data.** An empty
report counts as 0 (Creator answers HTTP 400 / code 9220, which the browser
console shows in red but the widget handles). If a report fails to load, the
affected tiles show "Couldn't load report" and never show made-up numbers.
Sample data (clearly badged) appears only when the page is opened outside
Creator.

## Project Structure

```text
non-funded-partnership-application/
├── plugin-manifest.json   # Widget manifest (service: CREATOR)
└── app/
    ├── widget.html        # Widget entry point
    ├── css/
    │   └── style.css      # Widget styles
    └── js/
        └── script.js      # Data loading, KPI logic, charts
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
