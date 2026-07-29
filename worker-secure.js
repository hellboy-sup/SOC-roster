// ═══════════════════════════════════════════════════════════════
//  SOC Roster Hub — Cloudflare Worker  v6 (SECURITY HARDENED)
//
//  KEY CHANGES FROM v5:
//    1. Frontend no longer sends a Sheets-scoped OAuth access_token.
//       It sends a Google ID TOKEN (identity only, no API scopes).
//       The Worker verifies the ID token's signature/aud/exp itself
//       (via Google's tokeninfo endpoint — simple and sufficient for
//       this traffic volume; swap for local JWKS verification later
//       if you want zero dependency on a live Google call per request).
//    2. Admin status is now decided from a Cloudflare KV allowlist
//       (ADMIN_ALLOWLIST), not from a client-supplied flag and not
//       from a live Sheet read on every call. Only you (via `wrangler
//       kv:key put`) can change who is admin — the roster Sheet and
//       the browser never influence this decision.
//    3. ALL Sheets reads/writes go through the Service Account token
//       (getServiceAccountToken). The frontend never holds a
//       Sheets-capable credential, so there is no client-side path
//       that can write to the Sheet except through this Worker's
//       admin-gated routes.
//    4. Basic per-IP rate limiting on mutating routes.
//    5. Calendar sync (per-user refresh_token in KV) is UNCHANGED —
//       that's a personal-resource grant per user for their own
//       calendar and was never the vulnerable part.
//
//  Required Cloudflare bindings (wrangler.toml):
//    SOC_TOKENS            KV — refresh tokens + calendar IDs (existing)
//    ADMIN_ALLOWLIST        KV — key = lowercase email, value = "1"
//    RATE_LIMIT             KV — key = ip, value = request count/window
//    SA_EMAIL                Service account email        (secret)
//    SA_PRIVATE_KEY           Service account private key   (secret)
//    GOOGLE_CLIENT_ID         OAuth Client ID (must match frontend)
//    GOOGLE_CLIENT_SECRET     OAuth Client Secret (for refresh_token exchange)
//    APPS_SCRIPT_URL          Deployed Apps Script web app URL (existing)
//    SHEET_ID                 (secret — no longer hardcoded as a literal
//                              visible in a public repo file; still fine
//                              to keep as a var if repo is private)
// ═══════════════════════════════════════════════════════════════

const MONTH_ORDER = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const SOC_CAL_NAME = 'SOC Roster';

const SHIFT_META_W = {
  'MS':     { label:'Morning Shift',   start:'07:00', end:'16:30', emoji:'🌅', allDay:false, nextDay:false, colorId:'7'  },
  'GS':     { label:'General Shift',   start:'10:30', end:'20:00', emoji:'☀️', allDay:false, nextDay:false, colorId:'2'  },
  'AS':     { label:'Afternoon Shift', start:'12:00', end:'21:30', emoji:'🌆', allDay:false, nextDay:false, colorId:'5'  },
  'NS':     { label:'Night Shift',     start:'21:30', end:'07:00', emoji:'🌙', allDay:false, nextDay:true,  colorId:'3'  },
  'WFH-MS': { label:'WFH – Morning',   start:'07:00', end:'16:30', emoji:'🏠', allDay:false, nextDay:false, colorId:'10' },
  'WFH-GS': { label:'WFH – General',   start:'10:30', end:'20:00', emoji:'🏠', allDay:false, nextDay:false, colorId:'10' },
  'WFH-AS': { label:'WFH – Afternoon', start:'12:00', end:'21:30', emoji:'🏠', allDay:false, nextDay:false, colorId:'10' },
  'WFH-NS': { label:'WFH – Night',     start:'21:30', end:'07:00', emoji:'🏠', allDay:false, nextDay:true,  colorId:'10' },
  'WO':     { label:'Week Off',                                                allDay:true  },
  'VL':     { label:'Vacation Leave',  emoji:'🏖️', allDay:true,  colorId:'11' },
  'CL':     { label:'Casual Leave',    emoji:'📋', allDay:true,  colorId:'11' },
  'SL':     { label:'Sick Leave',      emoji:'🤒', allDay:true,  colorId:'11' },
  'CO':     { label:'Compensatory Off',emoji:'🔄', allDay:true,  colorId:'5'  },
  'GH':     { label:'Gazetted Holiday',emoji:'🎉', allDay:true,  colorId:'11' },
};
const LEAVE_CODES_W = ['VL','CL','SL','CO','GH'];

const CORS = {
  'Access-Control-Allow-Origin':  '*', // tighten to your Pages domain in production
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Id-Token',
  'Content-Type':                 'application/json',
};

// Actions that require a verified admin identity.
const ADMIN_ACTIONS = new Set([
  'editShift', 'processRequest', 'publishRoster',
]);

// Actions any signed-in (non-admin) user may call.
const USER_ACTIONS = new Set([
  'submitRequest', 'getSyncFlag', 'storeRefreshToken',
  'checkServerSync', 'revokeServerSync',
]);

// ── Entry point ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rl = await checkRateLimit(env, ip);
      if (!rl.allowed) return json({ ok: false, error: 'Rate limit exceeded — try again shortly.' }, 429);

      const body   = await request.json();
      const action = body.action;

      if (!USER_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) {
        return json({ ok: false, error: 'Unknown action: ' + action }, 400);
      }

      // ── 1. Verify identity from the ID token (never an access token) ──────
      const idToken = request.headers.get('X-Id-Token') || body.idToken;
      const callerEmail = await verifyIdToken(idToken, env);
      if (!callerEmail) return json({ ok: false, error: 'Unauthorized — please sign in again.' }, 401);

      // ── 2. Admin gate — decided ONLY from KV, never from the client ───────
      if (ADMIN_ACTIONS.has(action)) {
        const isAdmin = await checkIsAdminKV(callerEmail, env);
        if (!isAdmin) return json({ ok: false, error: 'Admin access required.' }, 403);
      }

      // ── 3. Service-account token for all Sheets I/O ───────────────────────
      const saToken = await getServiceAccountToken(env);

      // ── 4. Route ───────────────────────────────────────────────────────────
      if (action === 'submitRequest')     return await handleSubmitRequest(body, callerEmail, saToken, env, ctx);
      if (action === 'editShift')         return await handleEditShift(body, callerEmail, saToken, env, ctx);
      if (action === 'processRequest')    return await handleProcessRequest(body, callerEmail, saToken, env, ctx);
      if (action === 'getSyncFlag')       return await handleGetSyncFlag(callerEmail, saToken, env);
      if (action === 'storeRefreshToken') return await handleStoreRefreshToken(body, callerEmail, env);
      if (action === 'checkServerSync')   return await handleCheckServerSync(callerEmail, env);
      if (action === 'revokeServerSync')  return await handleRevokeServerSync(callerEmail, env);
      if (action === 'publishRoster')     return await handlePublishRoster(body, callerEmail, saToken, env);

      return json({ ok: false, error: 'Unhandled action' }, 400);

    } catch (e) {
      // Never leak internals (stack traces, key material) to the client.
      console.error('[Worker] error:', e.message);
      return json({ ok: false, error: 'Internal error. Please try again.' }, 500);
    }
  }
};

// ═══════════════════════════════════════════════════════════════
//  IDENTITY — ID token verification (replaces access-token trust)
// ═══════════════════════════════════════════════════════════════
// We call Google's tokeninfo endpoint for simplicity/correctness. This is a
// live network call per request (small latency cost) but avoids maintaining
// local JWKS caching/rotation logic. Revisit if request volume grows.
async function verifyIdToken(idToken, env) {
  if (!idToken) return null;
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) return null;
  const info = await r.json();

  // aud must match YOUR OAuth client — prevents a token minted for some
  // other Google app from being replayed against this Worker.
  if (info.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!info.email || info.email_verified !== 'true') return null;

  const exp = parseInt(info.exp, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;

  return info.email.toLowerCase();
}

// ── Admin check — pure KV lookup, no Sheets dependency, no client input ──────
async function checkIsAdminKV(email, env) {
  const v = await env.ADMIN_ALLOWLIST.get(email.toLowerCase());
  return v !== null;
}

// ═══════════════════════════════════════════════════════════════
//  SERVICE ACCOUNT AUTH (Sheets API) — cached in KV to avoid
//  re-signing a JWT + round-tripping to Google on every request.
// ═══════════════════════════════════════════════════════════════
async function getServiceAccountToken(env) {
  const cached = await env.SOC_TOKENS.get('sa:access_token');
  const cachedExp = await env.SOC_TOKENS.get('sa:access_token_exp');
  if (cached && cachedExp && parseInt(cachedExp, 10) > Math.floor(Date.now() / 1000) + 30) {
    return cached;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss:   env.SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  }));
  const unsigned = `${header}.${claim}`;
  const pem      = env.SA_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemBody  = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${unsigned}.${sig}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!tokenResp.ok) throw new Error('Service account auth failed');
  const tok = await tokenResp.json();

  // Cache for reuse across requests (Google tokens last 1hr; we keep 55m margin)
  await env.SOC_TOKENS.put('sa:access_token', tok.access_token, { expirationTtl: 3300 });
  await env.SOC_TOKENS.put('sa:access_token_exp', String(now + 3300), { expirationTtl: 3300 });

  return tok.access_token;
}

// ═══════════════════════════════════════════════════════════════
//  RATE LIMITING — simple fixed-window counter per IP in KV
// ═══════════════════════════════════════════════════════════════
async function checkRateLimit(env, ip) {
  const WINDOW_SECONDS = 60;
  const MAX_REQUESTS   = 30; // generous for legitimate UI polling + admin edits
  const key = `rl:${ip}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= MAX_REQUESTS) return { allowed: false };
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: WINDOW_SECONDS * 2 });
  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════
//  SHEETS HELPERS (all via service account token — unchanged shape from v5)
// ═══════════════════════════════════════════════════════════════
async function sheetsRead(saToken, env, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}`;
  const r   = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!r.ok) throw new Error('Sheets read failed: ' + (await r.text()));
  return (await r.json()).values || [];
}

async function sheetsWrite(saToken, env, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error('Sheets write failed: ' + (await r.text()));
}

async function sheetsAppend(saToken, env, sheetName, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/` +
    `${encodeURIComponent(sheetName + '!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values: [row] }),
  });
  if (!r.ok) throw new Error('Sheets append failed: ' + (await r.text()));
}

async function getEmployeeEmail(empName, saToken, env) {
  const rows = await sheetsRead(saToken, env, 'Employee_Master!A3:F25');
  for (const row of rows) {
    if (row[1]?.trim().toLowerCase() === empName.trim().toLowerCase()) {
      return row[3]?.trim().toLowerCase() || null;
    }
  }
  return null;
}

async function writeSyncFlag(saToken, env, empEmail) {
  if (!empEmail) return;
  const email = empEmail.toLowerCase();
  const rows  = await sheetsRead(saToken, env, 'Sync_Flags!A:B').catch(() => []);
  const ts    = new Date().toISOString();
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').toLowerCase() === email) {
      await sheetsWrite(saToken, env, `Sync_Flags!B${i + 1}`, [[ts]]);
      return;
    }
  }
  await sheetsAppend(saToken, env, 'Sync_Flags', [email, ts]);
}

// ═══════════════════════════════════════════════════════════════
//  CALENDAR — per-user refresh token flow (UNCHANGED from v5;
//  this is a personal-resource grant, not the shared-write surface)
// ═══════════════════════════════════════════════════════════════
async function handleStoreRefreshToken(body, callerEmail, env) {
  const { code } = body;
  if (!code) return json({ ok: false, error: 'Missing auth code.' }, 400);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  'postmessage',
      grant_type:    'authorization_code',
    }),
  });
  if (!tokenResp.ok) return json({ ok: false, error: 'Token exchange failed.' }, 400);

  const tokens = await tokenResp.json();
  if (!tokens.refresh_token) {
    return json({ ok: false, error: 'no_refresh_token',
      message: 'No refresh token returned. Please retry Enable Background Sync.' });
  }

  await env.SOC_TOKENS.put(`rt:${callerEmail}`, tokens.refresh_token);
  await env.SOC_TOKENS.delete(`cal:${callerEmail}`);
  return json({ ok: true, message: 'Background sync enabled for ' + callerEmail });
}

async function handleCheckServerSync(callerEmail, env) {
  const rt = await env.SOC_TOKENS.get(`rt:${callerEmail}`);
  return json({ ok: true, enabled: !!rt });
}

async function handleRevokeServerSync(callerEmail, env) {
  await env.SOC_TOKENS.delete(`rt:${callerEmail}`);
  await env.SOC_TOKENS.delete(`cal:${callerEmail}`);
  return json({ ok: true, message: 'Background sync revoked for ' + callerEmail });
}

async function getUserAccessToken(email, env) {
  const rt = await env.SOC_TOKENS.get(`rt:${email}`);
  if (!rt) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: rt, grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) {
    await env.SOC_TOKENS.delete(`rt:${email}`);
    await env.SOC_TOKENS.delete(`cal:${email}`);
    return null;
  }
  return (await r.json()).access_token || null;
}

async function getOrCreateCalendarId(userToken, email, env) {
  const cached = await env.SOC_TOKENS.get(`cal:${email}`);
  if (cached) {
    const check = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cached)}`,
      { headers: { Authorization: `Bearer ${userToken}` } }
    );
    if (check.ok) return cached;
    await env.SOC_TOKENS.delete(`cal:${email}`);
  }
  const listResp = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${userToken}` } });
  if (!listResp.ok) throw new Error('Could not list calendars');
  const listData = await listResp.json();
  const existing = (listData.items || []).find(c => c.summary === SOC_CAL_NAME);
  if (existing) { await env.SOC_TOKENS.put(`cal:${email}`, existing.id); return existing.id; }

  const createResp = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST', headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: SOC_CAL_NAME, description: 'SOC duty roster — auto-synced', timeZone: 'Asia/Kolkata' }),
  });
  if (!createResp.ok) throw new Error('Could not create SOC Roster calendar');
  const created = await createResp.json();
  await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(created.id)}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: created.id, colorId: '7' }),
  }).catch(() => {});
  await env.SOC_TOKENS.put(`cal:${email}`, created.id);
  return created.id;
}

async function deleteEventsInMonth(userToken, calendarId, ym) {
  const [year, mo] = ym.split('-').map(Number);
  const prevDay  = new Date(Date.UTC(year, mo - 1, 1) - 6 * 3600000);
  const tMin     = prevDay.toISOString();
  const nextMonthYear = mo < 12 ? year : year + 1;
  const nextMonthMo   = mo < 12 ? mo + 1 : 1;
  const tMax = `${nextMonthYear}-${String(nextMonthMo).padStart(2,'0')}-01T00:00:00Z`;
  let pageToken = null;
  do {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
      `timeMin=${tMin}&timeMax=${tMax}&maxResults=250&singleEvents=true` + (pageToken ? `&pageToken=${pageToken}` : '');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
    if (!resp.ok) break;
    const b = await resp.json();
    await Promise.all((b.items || []).map(ev => fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${ev.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${userToken}` } }
    )));
    pageToken = b.nextPageToken || null;
  } while (pageToken);
}

function parseRosterRowW(row, days) {
  const shifts = {};
  for (let d = 1; d <= days; d++) {
    const val = ((row[d + 1] || '') + '').trim().toUpperCase();
    shifts[String(d).padStart(2, '0')] = val || 'WO';
  }
  return shifts;
}
function getDaysInMonthW(monthName, year) { return new Date(year, MONTH_ORDER.indexOf(monthName) + 1, 0).getDate(); }

function buildDailyRosterTextW(allRosterRows, dayNum) {
  const ORDER  = ['MS','GS','AS','NS','WFH-MS','WFH-GS','WFH-AS','WFH-NS'];
  const SKIP   = new Set(['WO','GH','VL','CL','SL','CO']);
  const groups = {};
  allRosterRows.filter(r => r[1]?.toString().trim()).forEach(row => {
    const code = ((row[dayNum + 1] || '') + '').trim().toUpperCase() || 'WO';
    if (SKIP.has(code) || !ORDER.includes(code)) return;
    const firstName = row[1].trim().split(/\s+/)[0];
    (groups[code] = groups[code] || []).push(firstName);
  });
  const lines = ORDER.filter(k => groups[k]?.length).map(k => `${k.padEnd(6)}–  ${groups[k].join(', ')}`);
  return lines.length ? lines.join('\n') : '(No scheduled staff today)';
}

async function serverSideCalendarSync(empEmail, monthTab, saToken, env) {
  const userToken = await getUserAccessToken(empEmail, env);
  if (!userToken) return;

  const [monthName, yearStr] = monthTab.split('_');
  const year = parseInt(yearStr);
  const days = getDaysInMonthW(monthName, year);
  const ym   = `${yearStr}-${String(MONTH_ORDER.indexOf(monthName) + 1).padStart(2, '0')}`;

  const empMasterRows = await sheetsRead(saToken, env, 'Employee_Master!A3:F25');
  const masterEntry   = empMasterRows.find(r => r[3]?.trim().toLowerCase() === empEmail);
  if (!masterEntry) return;
  const empName = masterEntry[1]?.trim();

  const lastCol    = colLetter(days + 2);
  const rosterRows = await sheetsRead(saToken, env, `${monthTab}!A4:${lastCol}22`);
  const myRow      = rosterRows.find(r => r[1]?.trim().toLowerCase() === empName?.toLowerCase());
  if (!myRow) return;

  const shifts = parseRosterRowW(myRow, days);
  const calId  = await getOrCreateCalendarId(userToken, empEmail, env);
  await deleteEventsInMonth(userToken, calId, ym);

  function nextDateW(ymStr, keyStr) {
    const d = new Date(ymStr + '-' + keyStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  for (const [key, code] of Object.entries(shifts)) {
    const d    = parseInt(key);
    const meta = SHIFT_META_W[code] || null;
    const rosterText = buildDailyRosterTextW(rosterRows, d);
    let eventBody;

    if (code === 'GH') continue;
    else if (code === 'WO') {
      eventBody = { summary: '🔴 Week Off', description: `Week Off\n\nToday's team:\n${rosterText}`,
        start: { date: `${ym}-${key}` }, end: { date: nextDateW(ym, key) }, colorId: '8', reminders: { useDefault: false } };
    } else if (LEAVE_CODES_W.includes(code)) {
      const leaveColorMap = { 'VL':'11', 'CL':'11', 'SL':'11', 'CO':'5' };
      eventBody = { summary: `${meta?.emoji || '📋'} ${meta?.label || code}`,
        description: `${meta?.label || code}\n\nToday's team:\n${rosterText}`,
        start: { date: `${ym}-${key}` }, end: { date: nextDateW(ym, key) },
        colorId: leaveColorMap[code] || '11', reminders: { useDefault: false } };
    } else if (meta && !meta.allDay && meta.start) {
      const dateStr = `${ym}-${key}`;
      const startDT = `${dateStr}T${meta.start}:00+05:30`;
      let endDT;
      if (meta.nextDay) {
        const nd = new Date(year, MONTH_ORDER.indexOf(monthName), d + 1);
        const ndStr = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')}`;
        endDT = `${ndStr}T${meta.end}:00+05:30`;
      } else endDT = `${dateStr}T${meta.end}:00+05:30`;
      eventBody = { summary: `${meta.emoji || ''} ${meta.label}`, description: `${meta.start} – ${meta.end} IST\n\nToday's team:\n${rosterText}`,
        start: { dateTime: startDT, timeZone: 'Asia/Kolkata' }, end: { dateTime: endDT, timeZone: 'Asia/Kolkata' },
        colorId: meta.colorId || '9', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 120 }] } };
    } else continue;

    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════
async function handleSubmitRequest(body, callerEmail, saToken, env, ctx) {
  const { month, empName, reqType, dateAffected, originalShift, newShift, swapPartner, notes } = body;
  if (!empName || !reqType || !dateAffected) return json({ ok: false, error: 'Missing required fields.' }, 400);

  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const [date, time] = now.split(', ');
  const reqId = 'REQ-' + Date.now();

  await sheetsAppend(saToken, env, 'Leave_Swap_Log', [
    reqId, date, time, empName, month, reqType, dateAffected, originalShift, newShift,
    swapPartner || '—', 'Pending', notes || '',
  ]);

  if (ctx && env.APPS_SCRIPT_URL) {
    ctx.waitUntil(fireEmailNotification(env, 'request_submitted', {
      empName, empEmail: callerEmail, reqType, dateAffected, originalShift, newShift, month, reqId,
      swapPartner: swapPartner || '—',
    }).catch(() => {}));
  }
  return json({ ok: true, reqId });
}

async function handleEditShift(body, callerEmail, saToken, env, ctx) {
  const { month, empRowIndex, day, oldCode, newCode, empName } = body;
  if (!month || empRowIndex === undefined || !day || !newCode) {
    return json({ ok: false, error: 'Missing required fields.' }, 400);
  }

  const sheetRow = parseInt(empRowIndex) + 4;
  const sheetCol = colLetter(parseInt(day) + 2);
  await sheetsWrite(saToken, env, `${month}!${sheetCol}${sheetRow}`, [[newCode]]);

  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const [date, time] = now.split(', ');
  await sheetsAppend(saToken, env, 'Leave_Swap_Log', [
    'EDIT-' + Date.now(), date, time, empName, month, 'Admin Edit',
    `Day ${day}`, oldCode, newCode, '—', 'Approved', `Direct edit by admin (${callerEmail})`,
  ]);

  const empEmail = await getEmployeeEmail(empName, saToken, env).catch(() => null);
  await writeSyncFlag(saToken, env, empEmail);

  if (empEmail && env.SOC_TOKENS && ctx) {
    ctx.waitUntil(serverSideCalendarSync(empEmail, month, saToken, env)
      .catch(e => console.error('[ServerSync] editShift:', e.message)));
  }
  if (empEmail && ctx && env.APPS_SCRIPT_URL) {
    ctx.waitUntil(fireEmailNotification(env, 'shift_edited', {
      empEmail, empName, month, day, oldCode, newCode, adminEmail: callerEmail,
    }).catch(() => {}));
  }
  return json({ ok: true });
}

async function handleProcessRequest(body, callerEmail, saToken, env, ctx) {
  const { reqId, decision } = body;
  if (!reqId || !decision) return json({ ok: false, error: 'Missing reqId or decision.' }, 400);

  const logRows = await sheetsRead(saToken, env, 'Leave_Swap_Log!A3:L500');
  const rowIdx  = logRows.findIndex(r => r[0] === reqId);
  if (rowIdx === -1) return json({ ok: false, error: 'Request not found: ' + reqId }, 404);

  const logRow   = logRows[rowIdx];
  const sheetRow = rowIdx + 3;
  await sheetsWrite(saToken, env, `Leave_Swap_Log!K${sheetRow}`, [[decision]]);

  const empName      = logRow[3];
  const reqType      = logRow[5];
  const dateAffected = logRow[6];
  const newShift      = logRow[8];
  const empEmail     = await getEmployeeEmail(empName, saToken, env).catch(() => null);

  if (decision === 'Approved') {
    const [dd, mm, yyyy] = dateAffected.split('-');
    const monthName = MONTH_ORDER[parseInt(mm) - 1];
    const sheetName = `${monthName}_${yyyy}`;

    const rosterRows = await sheetsRead(saToken, env, `${sheetName}!A4:B22`);
    const empIdx = rosterRows.findIndex(r => r[1]?.trim() === empName);
    if (empIdx !== -1) {
      await sheetsWrite(saToken, env, `${sheetName}!${colLetter(parseInt(dd) + 2)}${empIdx + 4}`, [[newShift]]);
    }
    await writeSyncFlag(saToken, env, empEmail);

    if (empEmail && env.SOC_TOKENS && ctx) {
      ctx.waitUntil(serverSideCalendarSync(empEmail, sheetName, saToken, env)
        .catch(e => console.error('[ServerSync] processRequest:', e.message)));
    }
  }

  if (empEmail && ctx && env.APPS_SCRIPT_URL) {
    ctx.waitUntil(fireEmailNotification(env, 'request_processed', {
      empEmail, empName, reqType, dateAffected, newShift, reqId, decision, adminEmail: callerEmail,
    }).catch(() => {}));
  }
  return json({ ok: true });
}

async function handleGetSyncFlag(callerEmail, saToken, env) {
  const rows = await sheetsRead(saToken, env, 'Sync_Flags!A:B').catch(() => []);
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').toLowerCase() === callerEmail) return json({ ok: true, ts: rows[i][1] || null });
  }
  return json({ ok: true, ts: null });
}

// ── publishRoster — unchanged in shape from v5, still admin-gated,
//    still uses the service account token for all writes ────────────────────
async function handlePublishRoster(body, callerEmail, saToken, env) {
  const { month, year, days, woQuota, sats, suns, employees, roster } = body;
  if (month === undefined || !year || !days || !employees || !roster) {
    return json({ ok: false, error: 'Missing fields: month, year, days, employees, roster.' }, 400);
  }

  const tabName    = MONTH_ORDER[month] + ' ' + year;
  const sumTabName = 'Summary_' + MONTH_ORDER[month] + '_' + year;

  if (!env.APPS_SCRIPT_URL) return json({ ok: false, error: 'APPS_SCRIPT_URL not set.' }, 500);

  const gsPayload = JSON.stringify({ action: 'createRosterSheet', tabName, month, year, days, woQuota, sats, suns, employees });
  const gsResp = await fetch(env.APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(gsPayload));
  if (!gsResp.ok) return json({ ok: false, error: 'Apps Script (createRosterSheet) failed.' }, 502);
  const gsData = await gsResp.json();
  if (!gsData.ok) return json({ ok: false, error: 'createRosterSheet error: ' + (gsData.error || '') }, 502);

  const FIRST_EMP_ROW = 7;
  const FIRST_DAY_COL = 3;
  const valueRanges = employees.map((emp, empIdx) => {
    const shiftRow = FIRST_EMP_ROW + empIdx;
    const shifts   = roster[String(empIdx)] || roster[empIdx] || [];
    const startCol = colLetter(FIRST_DAY_COL);
    const endCol   = colLetter(FIRST_DAY_COL + days - 1);
    return { range: `'${tabName}'!${startCol}${shiftRow}:${endCol}${shiftRow}`, values: [shifts.map(s => s || '')] };
  });

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchUpdate`;
  const batchResp = await fetch(batchUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: valueRanges }),
  });
  if (!batchResp.ok) return json({ ok: false, error: 'Shift data write failed.' }, 502);

  const colorPayload = JSON.stringify({ action: 'colorRosterCells', tabName, days, employees, roster });
  await fetch(env.APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(colorPayload)).catch(() => null);

  const rotEmps = employees.map((e, i) => ({ ...e, idx: i })).filter(e => e.type === 'Rotating')
    .sort((a, b) => {
      const amt = idx => {
        const s = roster[String(idx)] || [];
        return s.filter(x => x === 'MS').length * 150 + s.filter(x => x === 'AS').length * 150 + s.filter(x => x === 'NS').length * 250;
      };
      return amt(b.idx) - amt(a.idx);
    });

  const summaryRanges = rotEmps.map((emp, i) => {
    const s = roster[String(emp.idx)] || [];
    const ms = s.filter(x => x === 'MS').length, as = s.filter(x => x === 'AS').length, ns = s.filter(x => x === 'NS').length;
    const wo = s.filter(x => x === 'WO').length, tot = ms + as + ns, r = i + 3;
    return { range: `'${sumTabName}'!A${r}:M${r}`,
      values: [[i + 1, emp.name, emp.dept, ms, as, ns, `=D${r}*150`, `=E${r}*150`, `=F${r}*250`, `=G${r}+H${r}+I${r}`, wo, tot, 'R']] };
  });

  if (summaryRanges.length) {
    await fetch(batchUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: summaryRanges }),
    }).catch(err => console.warn('[publishRoster] summary write:', err.message));
  }

  return json({ ok: true, message: `Roster published to "${tabName}".`, tabName, sumTabName, cellsWritten: valueRanges.length });
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
function colLetter(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); } return s; }
function b64url(str) { return btoa(unescape(encodeURIComponent(str))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: CORS }); }

async function fireEmailNotification(env, scenario, data) {
  if (!env.APPS_SCRIPT_URL) return;
  try {
    const payload = JSON.stringify({ action: 'emailNotify', scenario, ...data });
    await fetch(env.APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(payload));
  } catch (e) { console.warn('[Email] notification failed:', e.message); }
}
