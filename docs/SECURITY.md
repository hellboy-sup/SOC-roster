# Security Notes — SOC Roster Hub

## Trust boundary
- The frontend NEVER holds a Google OAuth access token scoped to `spreadsheets` or
  broad `calendar` access. It only holds an ID token (identity proof) which it sends to
  the Worker as `X-Id-Token`.
- All Google Sheets reads/writes happen server-side in the Cloudflare Worker, using a
  dedicated Service Account credential (`SA_PRIVATE_KEY`), never exposed to the client.
- Admin status is decided by the Worker from the `ADMIN_ALLOWLIST` KV namespace — never
  from a client-supplied flag, never from a live Sheet read triggered by the client.

## Secrets inventory (Cloudflare, never in this repo)
| Secret | Where it lives | Purpose |
|---|---|---|
| `SA_EMAIL` | Worker secret | Service account identity |
| `SA_PRIVATE_KEY` | Worker secret | Signs JWTs for Sheets API auth |
| `GOOGLE_CLIENT_ID` | Worker secret + frontend config | OAuth client identity, ID token `aud` check |
| `GOOGLE_CLIENT_SECRET` | Worker secret | Refresh token exchange (Calendar sync) |
| `APPS_SCRIPT_URL` | Worker secret | Deployed Apps Script web app endpoint |
| `SHEET_ID` | Worker var | Target spreadsheet (not itself a credential) |
| Per-user refresh tokens | `SOC_TOKENS` KV | Personal Calendar sync only |
| Admin allowlist | `ADMIN_ALLOWLIST` KV | Who may call admin-gated Worker actions |

## Rotation policy
- [ ] Document service account key rotation cadence here once decided (Phase 3).

## Known residual risks / accepted trade-offs
- (to be filled in as they're identified during Phase 3 testing)
