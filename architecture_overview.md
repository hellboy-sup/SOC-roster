# SOC Roster Hub Architecture Guide

This document provides a complete map of your modular architecture and explains how the frontend securely connects to the backend proxy.

## 1. Complete File Architecture

Here is the exact structure of your active files and what each one does:

```text
📁 Roster-Hub
├── 📄 CHANGELOG.md                              (Tracks architectural changes)
├── 📄 README.md
├── 📄 SOC_ROSTER_IMPLEMENTATION_PLAN.md
│
├── 📁 frontend/                                 (Your User Interface - Hosted on Cloudflare Pages)
│   ├── 📄 index.html                            (Main HTML structure, login screen, and callWorker logic)
│   ├── 📄 config.js                             (Frontend config: Client ID & Worker URL)
│   ├── 📁 styles/
│   │   └── 📄 roster-builder.css                (All CSS styling)
│   └── 📁 modules/
│       └── 📁 admin/
│           ├── 📄 roster-builder-ui.js          (Pure HTML string containing the Admin Panel layout)
│           └── 📄 roster-engine.js              (Frontend core logic: tabs, fetching data via callWorker)
│
├── 📁 worker/                                   (Your Secure Backend API - Hosted on Cloudflare Workers)
│   ├── 📄 wrangler.toml                         (Cloudflare deployment configuration)
│   ├── 📄 package.json                          (Worker dependencies)
│   ├── 📄 .dev.vars                             (Your local secrets for testing!)
│   └── 📁 src/
│       └── 📄 index.js                          (The backend proxy logic that talks to Google Sheets)
│
├── 📁 apps-script/                              (Google Sheet Utilities)
│   └── 📄 soc-roster-apps-script.js             (Background tasks: generate sheets, send mass emails)
│
└── 🔑 Configuration Keys (JSON files)
    ├── 📄 clientsecretforcloudflarepages.json   (Prod OAuth Client ID)
    ├── 📄 clientsecretforlocalhost.json         (LocalHost OAuth Client ID)
    └── 📄 serviceaccount-clientsecretkey.json   (Service Account Private Key for Sheets API)
```

## 2. How to Verify the Secure Backend Merge

To verify that the frontend has been completely decoupled from Google Sheets and is routing everything securely through the Cloudflare Worker, check the following files:

### Frontend Verification
1. **[frontend/config.js](file:///c:/Users/Neel/Videos/Roster-Hub/frontend/config.js)**
   * **What to check:** Verify it only contains your public `CLIENT_ID` and points to your `WORKER_URL`. Note that there are absolutely no sensitive keys (like `SHEET_ID` or Private Keys) stored here anymore.
2. **[frontend/index.html](file:///c:/Users/Neel/Videos/Roster-Hub/frontend/index.html#L816)** (Line 816)
   * **What to check:** Look at the `callWorker()` function. Notice how it takes an action payload and sends a secure `POST` request strictly to your Cloudflare Worker. All legacy direct `fetch()` calls to `sheets.googleapis.com` have been wiped from this file.
3. **[frontend/modules/admin/roster-engine.js](file:///c:/Users/Neel/Videos/Roster-Hub/frontend/modules/admin/roster-engine.js#L125)**
   * **What to check:** Search the file for `callWorker(`. Instead of requesting data directly from Google Sheets, the frontend code now issues commands like `await callWorker({ action: 'getRoster', month })` to ask the backend for the data.
4. **[frontend/modules/admin/roster-builder-ui.js](file:///c:/Users/Neel/Videos/Roster-Hub/frontend/modules/admin/roster-builder-ui.js)**
   * **What to check:** This file strictly holds the complex HTML layout for the Admin Panel to keep `index.html` clean. It is actively injected into the page when an Admin logs in, but contains no backend connection logic to verify.

### Backend Verification
1. **[worker/src/index.js](file:///c:/Users/Neel/Videos/Roster-Hub/worker/src/index.js#L540)** (Line 540)
   * **What to check:** Look at `export default { async fetch(request, env) }`. This is the backend router. It intercepts the payload sent from the frontend, checks the `action` (e.g., `getRoster`), and executes the Google Sheets API request securely on its own server.
2. **[worker/src/index.js](file:///c:/Users/Neel/Videos/Roster-Hub/worker/src/index.js#L140)** (Line 140)
   * **What to check:** Look at the `getServiceAccountToken()` function. This proves that the Cloudflare Worker securely generates its own Google API access token using the hidden `env.SA_PRIVATE_KEY` locked inside your Cloudflare Dashboard, completely independent of the user's browser.

## 3. Data Flow Summary
1. User clicks a button on `soc-roster-hub.pages.dev`.
2. Frontend triggers `callWorker({ action: 'doSomething' })` targeting the Worker URL.
3. Cloudflare Worker securely verifies the user's identity, grabs the hidden Google Sheets credentials, and secretly modifies/reads the Google Sheet.
4. Google Sheets returns the raw data to the Worker.
5. The Worker safely passes only the non-sensitive data back down to the frontend for display!
