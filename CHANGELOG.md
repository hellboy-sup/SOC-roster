# SOC Roster Hub — Changelog

This file tracks major technical and architectural changes made to the repository.

## [2026-07-30] Deployment Configuration

### Changed
- Configured Cloudflare deployments for modular architecture:
  - **Worker API**: `soc-roster-hub.navoneeldas001.workers.dev` (Build root directory updated from `/` to `worker`).
  - **Frontend UI**: `soc-roster-hub.pages.dev` (Build root directory explicitly set to `frontend`).

## [2026-07-29] Phase 2: Roster Builder Merge & Security Hardening

### Added
- Created `frontend/config.js` to decouple environment constants (like `CLIENT_ID` and `WORKER_URL`) from HTML files.
- Extracted and modularized Roster Builder (v20) logic into `frontend/modules/admin/roster-engine.js` and `frontend/modules/admin/roster-builder-ui.js`.
- Added scoped CSS for Roster Builder at `frontend/styles/roster-builder.css`.
- New Cloudflare Worker routes added to handle direct read requests from the frontend: `getRoster`, `getEmployeeMaster`, `getAvailableMonths`, `getLeaveLog`, `checkAdminStatus`.

### Changed
- Replaced frontend Google Sign-In `ID token` handling with explicit `Access Token` validation flow inside the Cloudflare Worker, bypassing the double-prompt popups.
- Removed all direct `fetch()` calls to Google Sheets API from `index.html`. All database I/O is now securely proxied through the Cloudflare Worker using `callWorker()`.
- Updated `initApp()` in `index.html` to execute securely through Worker routes rather than direct API calls.
- Updated Google OAuth `CLIENT_ID` to use the new credentials belonging to the correct GCP project.

### Removed
- Removed hardcoded `SHEET_ID`, `ADMIN_EMAIL`, and `APPS_SCRIPT_URL` constants from frontend to prevent exposure.
- Removed unused and vulnerable utility functions (`sheetsRead`, `sheetsWrite`, `sheetsAppend`) from the frontend.
- Removed overly permissive `spreadsheets` OAuth scope from client requests.

### Fixed 
- Fixed bug where `roster-engine.js` auto-executed IIFE on script load before the DOM elements were injected, resolving console errors on initial load.
- Resolved `origin_mismatch` errors by ensuring proper Google Cloud Console OAuth redirect configuration.
