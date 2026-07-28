# Deployment Checklist — SOC Roster Hub

## One-time Google Cloud setup
- [ ] Google Cloud project created (or reuse existing one with your OAuth Client ID).
- [ ] Google Sheets API enabled for the project.
- [ ] Service account created (e.g. `soc-roster-sheets-writer@<project>.iam.gserviceaccount.com`).
- [ ] Service account JSON key downloaded, stored only as a Cloudflare secret.
- [ ] Target Google Sheet shared with the service account email (Editor access).
- [ ] OAuth Client ID has `http://localhost:PORT` (dev) and the Cloudflare Pages
      production domain added as Authorized JavaScript origins.

## Cloudflare setup
- [ ] Cloudflare account, Workers + Pages enabled.
- [ ] KV namespaces created: `SOC_TOKENS`, `ADMIN_ALLOWLIST`, `RATE_LIMIT`.
- [ ] Worker secrets set:
      `wrangler secret put SA_EMAIL`
      `wrangler secret put SA_PRIVATE_KEY`
      `wrangler secret put GOOGLE_CLIENT_ID`
      `wrangler secret put GOOGLE_CLIENT_SECRET`
      `wrangler secret put APPS_SCRIPT_URL`
      `wrangler secret put SHEET_ID` (or var, if repo stays private)
- [ ] Admin allowlist seeded:
      `wrangler kv:key put --binding=ADMIN_ALLOWLIST "you@example.com" "1"`
- [ ] Cloudflare Pages project created, connected to this GitHub repo, build output
      directory set to `frontend/`.

## Environments
- [ ] Staging Worker (`wrangler.toml` `[env.staging]`) pointed at a throwaway test Sheet.
- [ ] Production Worker pointed at the real Sheet — only after staging tests pass.

## Pre-production verification (see implementation plan Phase 6)
- [ ] Admin login → generate + publish a real month roster on staging.
- [ ] Non-admin login → confirm Admin tab inert, direct API calls 403.
- [ ] Non-Employee_Master Google account → confirm request submission is rejected
      (once Phase 3's employee-whitelist check is added).
