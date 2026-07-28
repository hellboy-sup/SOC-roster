# SOC Roster Hub

Monthly SOC shift roster generator, employee self-service portal, and admin management
tool for Digiglass / NSOC rotating and general shift staff.

## Structure
- `frontend/` — the single web app (deployed via Cloudflare Pages)
- `worker/` — Cloudflare Worker backend (all Sheets/Calendar writes, auth gating)
- `apps-script/` — reference copy of the Google Apps Script project (deployed manually)
- `engine-tests/` — Node regression tests for the roster generation engine
- `docs/` — security notes and deployment checklist

See `SOC_ROSTER_IMPLEMENTATION_PLAN.md` for the full phased implementation plan.

## Status
🚧 In active migration — see implementation plan for current phase.
