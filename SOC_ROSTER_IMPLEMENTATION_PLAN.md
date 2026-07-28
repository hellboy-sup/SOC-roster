# SOC Roster Hub — Implementation Plan
_Last updated: 2026-07-23_

This document is the single source of truth for how the SOC Roster Hub project moves from
"two separate HTML prototypes + one Worker" to a single, modular, securely-deployed
production application. Follow it top to bottom.

---

## 0. Guiding principles (read this first)

1. **One frontend, one backend.** `soc-roster-hub.html` and `soc_roster_final_v20.html`
   merge into a single app. The roster-generator becomes a tab inside the Hub's Admin
   Panel — it does not stay a separate file with its own login.
2. **The browser never holds a credential that can write to Google Sheets.** Only the
   Cloudflare Worker (using a service account) writes to Sheets. The frontend sends only
   an identity token (ID token), never an access token with the `spreadsheets` scope.
3. **Admin status is decided server-side, from Cloudflare KV, never from client-side JS
   or from data the client can influence.**
4. **Modularity = folder/file structure + versioned API routes, inside one app** — not
   multiple standalone HTML files pretending to be modules.
5. **All real work happens in git branches, reviewed via Pull Requests, merged into `main`.**
   `main` is what's live in production. Nothing skips this path.

---

## 1. Target repository structure

Create **one** GitHub repository. Suggested name: `soc-roster-hub`.

```
soc-roster-hub/
├── README.md
├── SOC_ROSTER_IMPLEMENTATION_PLAN.md      ← this file, committed at repo root
├── .gitignore
│
├── frontend/                               ← deployed to Cloudflare Pages
│   ├── index.html                          ← shell: login, tab nav, routing
│   ├── /styles/
│   │   └── main.css
│   ├── /modules/
│   │   ├── my-shifts.js
│   │   ├── team-roster.js
│   │   ├── auth.js                         ← Google Sign-In + ID token capture
│   │   ├── api-client.js                   ← wraps fetch() to the Worker, adds X-Id-Token
│   │   └── admin/
│   │       ├── admin-panel.js              ← admin shell (tabs: Setup/Carryover/etc.)
│   │       ├── roster-engine.js            ← ported soc_roster_logic.js (pure, no DOM)
│   │       ├── roster-builder-ui.js        ← ported v20 UI (Setup/Carryover/NS Teams/etc.)
│   │       └── publish.js                  ← "Publish to Sheets" — calls Worker
│   └── wrangler-pages.toml (optional, or configure via dashboard)
│
├── worker/                                  ← deployed to Cloudflare Workers
│   ├── wrangler.toml
│   ├── package.json
│   └── src/
│       ├── index.js                        ← router (entry point)
│       ├── auth.js                         ← verifyIdToken, checkIsAdminKV
│       ├── serviceAccount.js               ← getServiceAccountToken (JWT signing)
│       ├── sheets.js                       ← sheetsRead/Write/Append helpers
│       ├── calendar.js                     ← per-user calendar sync (refresh tokens)
│       ├── rateLimit.js
│       └── handlers/
│           ├── submitRequest.js
│           ├── editShift.js
│           ├── processRequest.js
│           ├── getSyncFlag.js
│           ├── serverSync.js                (storeRefreshToken/checkServerSync/revoke)
│           └── publishRoster.js
│
├── apps-script/                             ← reference copy of the Apps Script project
│   └── soc-roster-apps-script.js            (deployed manually via script.google.com;
│                                              this folder is documentation, not auto-deployed)
│
├── engine-tests/                            ← Node/JSDOM regression suite
│   ├── package.json
│   ├── extract-engine.js                    ← your existing regex-based extraction script
│   └── roster-engine.test.js
│
└── docs/
    ├── SECURITY.md                          ← trust boundary, what's a secret, what's not
    └── DEPLOYMENT.md                        ← env vars, KV namespaces, secrets checklist
```

**Why this shape:** every "module" (my-shifts, team-roster, admin roster-builder, each
Worker handler) is its own file. You can branch on `frontend/roster-builder-ui`,
`worker/publish-roster`, etc., touch one file, PR it, merge it — without the other
modules being at risk of merge conflicts or accidental edits.

---

## 2. Creating the GitHub repository

### 2.1 Create it (do this once, on github.com)
1. Go to github.com → **New repository**.
2. Name: `soc-roster-hub`. Visibility: **Private** (this holds Sheet IDs, client IDs,
   internal employee logic — keep it private even though secrets themselves live in
   Cloudflare, not in the repo).
3. Initialize with a README and a `.gitignore` (choose "Node" template — it excludes
   `node_modules/`, `.env`, etc.).
4. Do **not** upload the real `SA_PRIVATE_KEY`, refresh tokens, or `.env` files to this
   repo at any point — those live only in Cloudflare Secrets/KV (see `docs/SECURITY.md`).

### 2.2 Clone it locally
```bash
git clone https://github.com/<your-username>/soc-roster-hub.git
cd soc-roster-hub
```

### 2.3 Set up branch protection (do this once, in GitHub repo Settings)
1. Settings → Branches → Add branch protection rule for `main`.
2. Require a pull request before merging (even solo, this stops accidental direct pushes).
3. Optional but recommended: require status checks to pass (once CI is set up in Phase 5
   below) before merging.

### 2.4 Populate the initial structure
```bash
mkdir -p frontend/modules/admin worker/src/handlers apps-script engine-tests docs
touch README.md docs/SECURITY.md docs/DEPLOYMENT.md
git add .
git commit -m "chore: scaffold repo structure"
git push origin main
```

---

## 3. Branching workflow (how you'll actually work day to day)

### 3.1 Naming convention
`  <area>/<short-description>  `
Examples:
- `frontend/merge-roster-builder`
- `frontend/id-token-auth`
- `worker/service-account-sheets`
- `worker/admin-allowlist`
- `docs/security-writeup`

### 3.2 The cycle for every change
```bash
git checkout main
git pull origin main                 # always branch from latest main
git checkout -b worker/admin-allowlist
# ... make changes (or have Antigravity/Claude make them) ...
git add .
git commit -m "worker: gate admin actions via KV allowlist instead of client flag"
git push origin worker/admin-allowlist
```
Then on GitHub: **Compare & pull request** → review the diff → **Merge pull request**
→ delete the branch (GitHub offers a button for this after merge).

### 3.3 What triggers a deploy
- **Frontend branch pushed** → Cloudflare Pages auto-builds a **preview URL** for that
  branch (e.g. `worker-admin-allowlist.soc-roster-hub.pages.dev`) — safe to test, not
  public-facing in any meaningful sense, not linked from anywhere.
- **Frontend branch merged to `main`** → Cloudflare Pages deploys to your **production**
  URL.
- **Worker branch** → no auto-deploy by default; you run `wrangler deploy --env staging`
  manually from that branch to test, and `wrangler deploy` (production) only after
  merging to `main`. (You can wire GitHub Actions to automate this later — see Phase 5.)

---

## 4. Connecting Antigravity (or Claude Code) to the repo

"Antigravity" here refers to giving an AI coding agent direct read/write access to your
actual repo instead of you copy-pasting file contents into chat. Two supported paths —
pick one:

### Option A — Claude Code (recommended, since you're already using Claude)
1. Install: `npm install -g @anthropic-ai/claude-code` (or via the desktop app's Code tab).
2. From your terminal: `cd soc-roster-hub && claude` — this starts a session with direct
   filesystem access to the repo.
3. Authenticate GitHub access once via `gh auth login` (GitHub CLI) so Claude Code can
   `git push` on your behalf when you approve it.
4. From here on, instead of pasting files into a chat window, you say things like:
   *"Create a branch `worker/admin-allowlist`, update `worker/src/auth.js` to add the
   KV-based admin check, commit, and push."* — Claude Code does this directly against
   real files and shows you the diff before/while committing.

### Option B — GitHub App / MCP connector inside claude.ai
1. In claude.ai, go to **Settings → Connectors** → connect **GitHub**.
2. Authorize it against your `soc-roster-hub` repository specifically (not all repos,
   to limit scope).
3. Once connected, tools appear in the conversation that let Claude read repo contents,
   open branches, and propose commits/PRs directly — similar effect to Option A, but
   usable from the same chat interface you're in right now, without a terminal.

**Recommendation for you specifically:** start with **Option B** (GitHub connector in
claude.ai) since you're new to this — zero terminal setup, and you approve every action.
Move to Claude Code later once you're comfortable, since it's more powerful for larger
multi-file refactors (like the frontend merge in Phase 1 below).

### 4.1 Using source control once connected
Regardless of option, the loop is the same:
1. You describe the change.
2. The agent creates/switches to a branch, edits files, commits with a clear message.
3. You review the diff (GitHub PR view, or the tool's shown diff).
4. You explicitly approve push/merge — the agent should not merge to `main` without you
   saying so.

---

## 5. Ordered implementation plan

Do these in order. Each phase assumes the previous one is merged to `main`.

### Phase 1 — Repo + hosting foundation (no feature changes yet)
- [ ] Create GitHub repo, structure, branch protection (Section 2).
- [ ] Connect Antigravity/Claude to the repo (Section 4).
- [ ] Create Cloudflare Pages project, connect it to this GitHub repo, set build output
      directory to `frontend/`.
- [ ] Confirm existing `soc-roster-hub.html` (renamed `frontend/index.html`) deploys and
      still works as-is (old behavior, old Worker) — this is just a hosting-move, not a
      feature change. Verify before moving on.

### Phase 2 — Frontend merge (highest-risk, do it early while stakes are low)
- [ ] Branch: `frontend/merge-roster-builder`.
- [ ] Port `soc_roster_final_v20.html`'s state/logic into `frontend/modules/admin/`,
      namespaced (e.g. wrapped in an IIFE or module object like `RosterBuilder.*`) to
      avoid collisions with the Hub's existing `emps`/`roster`/`cfg` globals.
- [ ] Wire "Auto-Generate" / "Roster Grid" / "Summary" as a new sub-view inside the
      existing Admin Panel tab, gated behind the Hub's existing `isAdmin` check.
- [ ] Remove the roster-builder's own login/auth entirely — it now inherits the Hub's
      session.
- [ ] Keep local Excel export working (no backend dependency, low risk, high value —
      don't touch this while merging).
- [ ] Test manually: generate a roster inside the merged Admin Panel, confirm grid,
      warnings, and summary all render identically to the old standalone tool.
- [ ] PR → review → merge to `main`.

### Phase 3 — Worker security hardening (the v6 Worker)
- [ ] Branch: `worker/service-account-sheets`.
- [ ] Set up Google Cloud service account, share the Sheet with it (see `docs/DEPLOYMENT.md`,
      to be written — mirrors the steps already discussed in this project's chat history).
- [ ] Add Cloudflare secrets: `SA_EMAIL`, `SA_PRIVATE_KEY`, `GOOGLE_CLIENT_ID`,
      `GOOGLE_CLIENT_SECRET`, `APPS_SCRIPT_URL`, `SHEET_ID`.
- [ ] Create KV namespaces: `ADMIN_ALLOWLIST`, `RATE_LIMIT` (in addition to existing
      `SOC_TOKENS`).
- [ ] Add your own email to `ADMIN_ALLOWLIST` via `wrangler kv:key put`.
- [ ] Implement `worker/src/index.js` + supporting files (the v6 Worker logic already
      drafted in this project).
- [ ] Deploy to a **staging** Worker environment first (`wrangler.toml` `[env.staging]`
      block, separate KV/staging Sheet) — never point this at the real production Sheet
      yet.
- [ ] PR → review → merge to `main` (this merges code; production deploy is a separate,
      deliberate `wrangler deploy` step, not automatic yet).

### Phase 4 — Frontend auth change (ID token instead of access token)
- [ ] Branch: `frontend/id-token-auth`.
- [ ] Update `frontend/modules/auth.js` to capture the Google **ID token** (from
      `google.accounts.id` credential response) alongside/instead of the OAuth access
      token currently used.
- [ ] Update `frontend/modules/api-client.js` so every Worker call sends
      `X-Id-Token: <idToken>` instead of `token: accessToken` in the body.
- [ ] Remove the `spreadsheets` scope from the frontend's requested OAuth scopes
      entirely — the frontend should no longer request it at all.
- [ ] Test against the **staging** Worker from Phase 3 end-to-end: sign in, submit a
      leave request, confirm it lands in the staging Sheet.
- [ ] PR → review → merge to `main`.

### Phase 5 — Testing pipeline (formalize what you've been doing ad hoc)
- [ ] Branch: `tests/ci-pipeline`.
- [ ] Add GitHub Actions workflow: on every PR, run `engine-tests/` (your existing
      Node/JSDOM roster regression suite) automatically.
- [ ] Add a second workflow step: adversarial auth tests against the staging Worker
      (expired token → 401, wrong `aud` → 401, non-admin calling admin action → 403).
- [ ] Require these checks to pass before merge (tie into branch protection, Section 2.3).
- [ ] PR → review → merge to `main`.

### Phase 6 — Production cutover
- [ ] Point the production Worker (`wrangler deploy`, no `--env`) at the real
      `SHEET_ID`, real `ADMIN_ALLOWLIST` entries, real `APPS_SCRIPT_URL`.
- [ ] Confirm Cloudflare Pages production build (from `main`) points its API calls at
      the production Worker URL, not staging.
- [ ] Do one full manual pass yourself: sign in as admin, generate + publish a real
      month's roster, sign in as a test non-admin account, confirm the Admin tab is
      inert and direct API calls 403.
- [ ] Only after this passes, consider the migration complete and retire the old
      GitHub Pages + v5 Worker deployment.

---

## 6. Quick reference — what NOT to commit to the repo, ever
- Service account private key (`SA_PRIVATE_KEY`) — Cloudflare secret only.
- Any refresh tokens — Cloudflare KV only, per user, never in code.
- `SHEET_ID` — acceptable as a Cloudflare **var** since it's not itself exploitable
  without the service account credential, but keep the repo **private** regardless.
- `.env` files of any kind — covered by `.gitignore` from repo creation.

---

## 7. Open items to resolve as you go (not blockers, just flag them)
- Decide final admin-allowlist maintenance process: is it always you manually via
  `wrangler kv:key put`, or should the Admin Panel eventually have a UI for managing
  the allowlist itself (bootstrap problem: needs an even-higher-trust "super admin").
- Decide CORS origin lock-down: `Access-Control-Allow-Origin: '*'` in the Worker should
  be tightened to your exact Cloudflare Pages production domain once that domain is
  final.
- Decide retention/rotation policy for the service account key (e.g. rotate yearly,
  document the date in `docs/SECURITY.md`).
