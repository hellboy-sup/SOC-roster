// ═══════════════════════════════════════════════════════════════
//  SOC Roster Hub — Cloudflare Worker Proxy  v5
//  URL: soc-roster-proxy.navoneel-itorizin-87e.workers.dev
//
//  Actions handled:
//    submitRequest     — employee submits a leave / swap request
//    editShift         — admin directly edits a shift cell
//    processRequest    — admin approves or rejects a request
//    getSyncFlag       — employee browser polls for admin-triggered changes
//    storeRefreshToken — one-time: exchange OAuth code → store refresh token in KV
//    checkServerSync   — browser checks if KV has a refresh token for this user
//    revokeServerSync  — user revokes background sync (deletes token from KV)
//    publishRoster     — roster generator app pushes a new month roster to Sheets
//
//  TASK 1 — Server-Side Calendar Sync (v4 addition):
//    Employees do a one-time "Enable Background Sync" flow that stores
//    their OAuth refresh_token in Cloudflare KV (SOC_TOKENS namespace).
//    After every admin editShift / processRequest(Approved), the Worker
//    uses the stored refresh_token to get a fresh access_token and calls
//    the Google Calendar API directly — no browser tab required.
//
//  TASK 2 — Roster Generator Push (v5 addition):
//    The standalone SOC Roster Generator HTML app calls publishRoster
//    to push a fully-generated month roster into Google Sheets.
//    Step 1: Apps Script creates the sheet tab with formatting + formulas.
//    Step 2: Worker writes all shift values via batchUpdate (1 request).
//    Step 3: Apps Script colors every shift cell.
//    Step 4: Worker writes the Summary tab data rows.
//
//  Required Cloudflare env bindings (wrangler.toml / dashboard):
//    SOC_TOKENS           — KV namespace (stores refresh tokens & cal IDs)
//    SA_EMAIL             — Service account email  (existing)
//    SA_PRIVATE_KEY       — Service account private key  (existing)
//    GOOGLE_CLIENT_ID     — OAuth Client ID (same as HTML CLIENT_ID const)
//    GOOGLE_CLIENT_SECRET — OAuth Client Secret (from Google Cloud Console)
//    APPS_SCRIPT_URL      — Deployed Apps Script web app URL (existing)
// ═══════════════════════════════════════════════════════════════

const SHEET_ID    = '1MY9aFaaUdSmqUP2V3gXt0emNMONlubgOfVqoV2mLpoY';
const MONTH_ORDER = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const SOC_CAL_NAME = 'SOC Roster';

// Shift metadata duplicated here so the Worker can build calendar events
// server-side without depending on the browser-side SHIFT_META object.
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
const OFF_CODES_W   = ['WO','VL','CL','SL','CO','GH'];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// ── Entry point ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST')    return json({ ok: false, error: 'POST only' });

    try {
      const body  = await request.json();
      const { action, token } = body;

      // 1. Verify the Google OAuth token — confirms who the caller is
      const callerEmail = await verifyUserToken(token);
      if (!callerEmail) return json({ ok: false, error: 'Unauthorized — please sign in again.' });

      // 2. Get a service-account token for Sheets operations
      const saToken = await getServiceAccountToken(env);

      // 3. Route to the correct handler
      // ctx is passed so handlers can use ctx.waitUntil() for background work
      if (action === 'submitRequest')     return await handleSubmitRequest(body, callerEmail, saToken, env, ctx);
      if (action === 'editShift')         return await handleEditShift(body, callerEmail, saToken, env, ctx);
      if (action === 'processRequest')    return await handleProcessRequest(body, callerEmail, saToken, env, ctx);
      if (action === 'getSyncFlag')       return await handleGetSyncFlag(body, callerEmail, saToken);
      if (action === 'storeRefreshToken') return await handleStoreRefreshToken(body, callerEmail, env);
      if (action === 'checkServerSync')   return await handleCheckServerSync(callerEmail, env);
      if (action === 'revokeServerSync')  return await handleRevokeServerSync(callerEmail, env);
      if (action === 'publishRoster')     return await handlePublishRoster(body, callerEmail, saToken, env);

      return json({ ok: false, error: 'Unknown action: ' + action });

    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  }
};

// ── Verify the employee's Google OAuth token ──────────────────────────────────
async function verifyUserToken(token) {
  if (!token) return null;
  const r = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (!r.ok) return null;
  const info = await r.json();
  return info.email ? info.email.toLowerCase() : null;
}

// ── Mint a Service Account access token via JWT ───────────────────────────────
async function getServiceAccountToken(env) {
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
  if (!tokenResp.ok) throw new Error('SA token error: ' + await tokenResp.text());
  return (await tokenResp.json()).access_token;
}

// ── Check admin status from Employee_Master col F ─────────────────────────────
async function checkIsAdmin(email, saToken) {
  const rows = await sheetsRead(saToken, 'Employee_Master!A3:F25');
  for (const row of rows) {
    if (row[3]?.trim().toLowerCase() === email && row[5]?.trim() === 'Yes') return true;
  }
  return false;
}

// ── Look up employee email by name from Employee_Master ───────────────────────
async function getEmployeeEmail(empName, saToken) {
  const rows = await sheetsRead(saToken, 'Employee_Master!A3:F25');
  for (const row of rows) {
    if (row[1]?.trim().toLowerCase() === empName.trim().toLowerCase()) {
      return row[3]?.trim().toLowerCase() || null;
    }
  }
  return null;
}

// ── Google Sheets helpers ─────────────────────────────────────────────────────
async function sheetsRead(saToken, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const r   = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!r.ok) throw new Error('Sheets read failed: ' + (await r.text()));
  return (await r.json()).values || [];
}

async function sheetsWrite(saToken, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error('Sheets write failed: ' + (await r.text()));
}

async function sheetsAppend(saToken, sheetName, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
    `${encodeURIComponent(sheetName + '!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values: [row] }),
  });
  if (!r.ok) throw new Error('Sheets append failed: ' + (await r.text()));
}

// ── Write / update the Sync_Flags sheet for a given employee email ────────────
async function writeSyncFlag(saToken, empEmail) {
  if (!empEmail) return;
  const email = empEmail.toLowerCase();
  const rows  = await sheetsRead(saToken, 'Sync_Flags!A:B').catch(() => []);
  const ts    = new Date().toISOString();
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').toLowerCase() === email) {
      await sheetsWrite(saToken, `Sync_Flags!B${i + 1}`, [[ts]]);
      return;
    }
  }
  await sheetsAppend(saToken, 'Sync_Flags', [email, ts]);
}

// ═══════════════════════════════════════════════════════════════
//  TASK 1 — Refresh Token Storage & Server-Side Calendar Sync
// ═══════════════════════════════════════════════════════════════

// ── ACTION: storeRefreshToken ─────────────────────────────────────────────────
// Browser sends the one-time OAuth authorization code.
// Worker exchanges it for tokens and stores refresh_token in KV.
async function handleStoreRefreshToken(body, callerEmail, env) {
  const { code } = body;
  if (!code) return json({ ok: false, error: 'Missing auth code.' });

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  'postmessage',   // required for GIS popup ux_mode
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    return json({ ok: false, error: 'Token exchange failed: ' + errText });
  }

  const tokens = await tokenResp.json();

  if (!tokens.refresh_token) {
    // Google only returns refresh_token when prompt=consent is used.
    return json({
      ok: false,
      error: 'no_refresh_token',
      message: 'No refresh token returned. Please click Enable Background Sync again to re-grant access.'
    });
  }

  // Store in KV: key "rt:{email}" → refresh_token value
  await env.SOC_TOKENS.put(`rt:${callerEmail}`, tokens.refresh_token);
  // Clear any stale calendar ID so it is rediscovered fresh
  await env.SOC_TOKENS.delete(`cal:${callerEmail}`);

  return json({ ok: true, message: 'Background sync enabled for ' + callerEmail });
}

// ── ACTION: checkServerSync ───────────────────────────────────────────────────
async function handleCheckServerSync(callerEmail, env) {
  const rt = await env.SOC_TOKENS.get(`rt:${callerEmail}`);
  return json({ ok: true, enabled: !!rt });
}

// ── ACTION: revokeServerSync ──────────────────────────────────────────────────
async function handleRevokeServerSync(callerEmail, env) {
  await env.SOC_TOKENS.delete(`rt:${callerEmail}`);
  await env.SOC_TOKENS.delete(`cal:${callerEmail}`);
  return json({ ok: true, message: 'Background sync revoked for ' + callerEmail });
}

// ── Exchange stored refresh token for a fresh user access token ───────────────
async function getUserAccessToken(email, env) {
  const rt = await env.SOC_TOKENS.get(`rt:${email}`);
  if (!rt) return null;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: rt,
      grant_type:    'refresh_token',
    }),
  });

  if (!r.ok) {
    // Token revoked/expired — clean up
    await env.SOC_TOKENS.delete(`rt:${email}`);
    await env.SOC_TOKENS.delete(`cal:${email}`);
    return null;
  }

  return (await r.json()).access_token || null;
}

// ── Find or create the "SOC Roster" calendar for a user ──────────────────────
async function getOrCreateCalendarId(userToken, email, env) {
  // Check KV cache first
  const cached = await env.SOC_TOKENS.get(`cal:${email}`);
  if (cached) {
    const check = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cached)}`,
      { headers: { Authorization: `Bearer ${userToken}` } }
    );
    if (check.ok) return cached;
    await env.SOC_TOKENS.delete(`cal:${email}`);
  }

  // Search calendar list
  const listResp = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  if (!listResp.ok) throw new Error('Could not list calendars');
  const listData = await listResp.json();
  const existing = (listData.items || []).find(c => c.summary === SOC_CAL_NAME);
  if (existing) {
    await env.SOC_TOKENS.put(`cal:${email}`, existing.id);
    return existing.id;
  }

  // Create new calendar
  const createResp = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method:  'POST',
    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      summary:     SOC_CAL_NAME,
      description: 'SOC duty roster shifts — auto-synced from SOC Roster Hub',
      timeZone:    'Asia/Kolkata',
    }),
  });
  if (!createResp.ok) throw new Error('Could not create SOC Roster calendar');
  const created = await createResp.json();

  // Set teal color (colorId 7)
  await fetch(
    `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(created.id)}`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: created.id, colorId: '7' }),
    }
  ).catch(() => {});

  await env.SOC_TOKENS.put(`cal:${email}`, created.id);
  return created.id;
}

// ── Delete all events in a month from the user's SOC Roster calendar ──────────
async function deleteEventsInMonth(userToken, calendarId, ym) {
  const [year, mo] = ym.split('-').map(Number);
  // Extend tMin 6 hours before month start to catch IST-offset events
  const prevDay  = new Date(Date.UTC(year, mo - 1, 1) - 6 * 3600000);
  const tMin     = prevDay.toISOString();
  const nextMonthYear = mo < 12 ? year : year + 1;
  const nextMonthMo   = mo < 12 ? mo + 1 : 1;
  const tMax = `${nextMonthYear}-${String(nextMonthMo).padStart(2,'0')}-01T00:00:00Z`;

  let pageToken = null;
  do {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
      `timeMin=${tMin}&timeMax=${tMax}&maxResults=250&singleEvents=true` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
    if (!resp.ok) break;
    const body = await resp.json();
    await Promise.all((body.items || []).map(ev =>
      fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${ev.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${userToken}` } }
      )
    ));
    pageToken = body.nextPageToken || null;
  } while (pageToken);
}

// ── Parse a roster row into { "01": "MS", "02": "WO", ... } ──────────────────
function parseRosterRowW(row, days) {
  const shifts = {};
  for (let d = 1; d <= days; d++) {
    const val = ((row[d + 1] || '') + '').trim().toUpperCase();
    shifts[String(d).padStart(2, '0')] = val || 'WO';
  }
  return shifts;
}

function getDaysInMonthW(monthName, year) {
  return new Date(year, MONTH_ORDER.indexOf(monthName) + 1, 0).getDate();
}

// ── SERVER-SIDE CALENDAR SYNC ─────────────────────────────────────────────────
// Called (non-blocking) after every admin editShift / processRequest(Approved).
// Uses the employee's stored refresh_token to sync their Google Calendar
// without them needing to have any browser tab open.
async function serverSideCalendarSync(empEmail, monthTab, saToken, env) {
  // Step 1: get fresh user access token
  const userToken = await getUserAccessToken(empEmail, env);
  if (!userToken) return;  // no refresh token stored — skip silently

  const [monthName, yearStr] = monthTab.split('_');
  const year = parseInt(yearStr);
  const days = getDaysInMonthW(monthName, year);
  const ym   = `${yearStr}-${String(MONTH_ORDER.indexOf(monthName) + 1).padStart(2, '0')}`;

  // Step 2: find the employee's roster row
  const empMasterRows = await sheetsRead(saToken, 'Employee_Master!A3:F25');
  const masterEntry   = empMasterRows.find(r => r[3]?.trim().toLowerCase() === empEmail);
  if (!masterEntry) return;
  const empName = masterEntry[1]?.trim();

  const lastCol    = colLetter(days + 2);
  const rosterRows = await sheetsRead(saToken, `${monthTab}!A4:${lastCol}22`);
  const myRow      = rosterRows.find(r => r[1]?.trim().toLowerCase() === empName?.toLowerCase());
  if (!myRow) return;

  const shifts = parseRosterRowW(myRow, days);

  // Step 3: find or create the SOC Roster calendar
  const calId = await getOrCreateCalendarId(userToken, empEmail, env);

  // Step 4: clean slate — delete all existing events for this month
  await deleteEventsInMonth(userToken, calId, ym);

  // Step 5: create fresh events for ALL days — shifts, WO, leaves.
  // GH (Gazetted Holiday) is skipped — already in user's India holidays calendar.
  // All-day events use end = start + 1 day (Google Calendar API requirement).
  const allShiftDays = Object.entries(shifts);

  function nextDateW(ymStr, keyStr) {
    const d = new Date(ymStr + '-' + keyStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  for (const [key, code] of allShiftDays) {
    const d           = parseInt(key);
    const meta        = SHIFT_META_W[code] || null;
    // Build daily team roster — zero extra API calls, uses already-loaded rosterRows
    const rosterText  = buildDailyRosterTextW(rosterRows, d);
    let eventBody;

    if (code === 'GH') {
      continue; // Skip: already in user's India holidays calendar
    } else if (code === 'WO') {
      // All-day Week Off — end = start + 1 day (required by Google Calendar API)
      eventBody = {
        summary:     '🔴 Week Off',
        description: `Week Off — no shift today\n\nToday's team:\n${rosterText}`,
        start:       { date: `${ym}-${key}` },
        end:         { date: nextDateW(ym, key) },
        colorId:     '8',
        reminders:   { useDefault: false },
      };
    } else if (LEAVE_CODES_W.includes(code)) {
      // All-day leave — end = start + 1 day
      const leaveColorMap = { 'VL':'11', 'CL':'11', 'SL':'11', 'CO':'5' };
      eventBody = {
        summary:     `${meta?.emoji || '📋'} ${meta?.label || code}`,
        description: `${meta?.label || code} — SOC Roster\n\nToday's team:\n${rosterText}`,
        start:       { date: `${ym}-${key}` },
        end:         { date: nextDateW(ym, key) },
        colorId:     leaveColorMap[code] || '11',
        reminders:   { useDefault: false },
      };
    } else if (meta && !meta.allDay && meta.start) {
      // Working shift — timed event, 2-hour popup reminder
      const dateStr = `${ym}-${key}`;
      const startDT = `${dateStr}T${meta.start}:00+05:30`;
      let endDT;
      if (meta.nextDay) {
        const nd    = new Date(year, MONTH_ORDER.indexOf(monthName), d + 1);
        const ndStr = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')}`;
        endDT = `${ndStr}T${meta.end}:00+05:30`;
      } else {
        endDT = `${dateStr}T${meta.end}:00+05:30`;
      }
      eventBody = {
        summary:     `${meta.emoji || ''} ${meta.label}`,
        description: `${meta.start} – ${meta.end} IST\n\nToday's team:\n${rosterText}`,
        start:       { dateTime: startDT, timeZone: 'Asia/Kolkata' },
        end:         { dateTime: endDT,   timeZone: 'Asia/Kolkata' },
        colorId:     meta.colorId || '9',
        reminders:   { useDefault: false, overrides: [{ method: 'popup', minutes: 120 }] },
      };
    } else {
      continue;
    }

    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(eventBody),
      }
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  EXISTING ACTIONS (updated to fire server-side sync)
// ═══════════════════════════════════════════════════════════════

// ── ACTION 1: Employee submits a leave / swap request ─────────────────────────
async function handleSubmitRequest(body, callerEmail, saToken, env, ctx) {
  const { month, empName, reqType, dateAffected, originalShift, newShift, swapPartner, notes } = body;
  if (!empName || !reqType || !dateAffected) return json({ ok: false, error: 'Missing required fields.' });

  const now          = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const [date, time] = now.split(', ');
  const reqId        = 'REQ-' + Date.now();

  const row = [
    reqId, date, time, empName, month, reqType,
    dateAffected, originalShift, newShift, swapPartner || '—', 'Pending', notes || '',
  ];
  await sheetsAppend(saToken, 'Leave_Swap_Log', row);

  // Fire email: confirmation to employee + notification to all admins (non-blocking)
  if (ctx && env.APPS_SCRIPT_URL) {
    ctx.waitUntil(
      fireEmailNotification(env, 'request_submitted', {
        empName, empEmail: callerEmail, reqType,
        dateAffected, originalShift, newShift, month, reqId,
        swapPartner: swapPartner || '—',
      }).catch(() => {})
    );
  }

  return json({ ok: true });
}

// ── ACTION 2: Admin directly edits a shift cell ───────────────────────────────
async function handleEditShift(body, callerEmail, saToken, env, ctx) {
  if (!await checkIsAdmin(callerEmail, saToken)) return json({ ok: false, error: 'Admin access required.' });

  const { month, empRowIndex, day, oldCode, newCode, empName } = body;
  if (!month || empRowIndex === undefined || !day || !newCode) return json({ ok: false, error: 'Missing required fields.' });

  const sheetRow = parseInt(empRowIndex) + 4;
  const sheetCol = colLetter(parseInt(day) + 2);
  await sheetsWrite(saToken, `${month}!${sheetCol}${sheetRow}`, [[newCode]]);

  // Audit log
  const now          = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const [date, time] = now.split(', ');
  await sheetsAppend(saToken, 'Leave_Swap_Log', [
    'EDIT-' + Date.now(), date, time, empName, month, 'Admin Edit',
    `Day ${day}`, oldCode, newCode, '—', 'Approved',
    `Direct edit by admin (${callerEmail})`,
  ]);

  // Browser poller sync flag
  const empEmail = await getEmployeeEmail(empName, saToken).catch(() => null);
  await writeSyncFlag(saToken, empEmail);

  // ── Server-side calendar sync via ctx.waitUntil ───────────────────────────
  if (empEmail && env.SOC_TOKENS && ctx) {
    ctx.waitUntil(
      serverSideCalendarSync(empEmail, month, saToken, env)
        .catch(e => console.error('[ServerSync] editShift:', e.message))
    );
  }

  // ── Email notification: inform affected employee of the direct edit ────────
  if (empEmail && ctx && env.APPS_SCRIPT_URL) {
    ctx.waitUntil(
      fireEmailNotification(env, 'shift_edited', {
        empEmail, empName, month, day, oldCode, newCode, adminEmail: callerEmail,
      }).catch(() => {})
    );
  }

  return json({ ok: true });
}

// ── ACTION 3: Admin approves or rejects a request ─────────────────────────────
async function handleProcessRequest(body, callerEmail, saToken, env, ctx) {
  if (!await checkIsAdmin(callerEmail, saToken)) return json({ ok: false, error: 'Admin access required.' });

  const { reqId, decision } = body;
  if (!reqId || !decision) return json({ ok: false, error: 'Missing reqId or decision.' });

  const logRows = await sheetsRead(saToken, 'Leave_Swap_Log!A3:L500');
  const rowIdx  = logRows.findIndex(r => r[0] === reqId);
  if (rowIdx === -1) return json({ ok: false, error: 'Request not found: ' + reqId });

  const logRow   = logRows[rowIdx];
  const sheetRow = rowIdx + 3;
  await sheetsWrite(saToken, `Leave_Swap_Log!K${sheetRow}`, [[decision]]);

  // Read these before the if-block so they're available for both branches
  const empName      = logRow[3];
  const reqType      = logRow[5];
  const dateAffected = logRow[6];
  const newShift     = logRow[8];
  const empEmail     = await getEmployeeEmail(empName, saToken).catch(() => null);

  if (decision === 'Approved') {
    const [dd, mm, yyyy] = dateAffected.split('-');
    const monthName   = MONTH_ORDER[parseInt(mm) - 1];
    const sheetName   = `${monthName}_${yyyy}`;

    const rosterRows = await sheetsRead(saToken, `${sheetName}!A4:B22`);
    const empIdx     = rosterRows.findIndex(r => r[1]?.trim() === empName);
    if (empIdx !== -1) {
      await sheetsWrite(saToken, `${sheetName}!${colLetter(parseInt(dd) + 2)}${empIdx + 4}`, [[newShift]]);
    }

    await writeSyncFlag(saToken, empEmail);

    // ── Server-side calendar sync via ctx.waitUntil ─────────────────────────
    if (empEmail && env.SOC_TOKENS && ctx) {
      ctx.waitUntil(
        serverSideCalendarSync(empEmail, sheetName, saToken, env)
          .catch(e => console.error('[ServerSync] processRequest:', e.message))
      );
    }
  }

  // ── Email notification: inform employee of approval or rejection ───────────
  if (empEmail && ctx && env.APPS_SCRIPT_URL) {
    ctx.waitUntil(
      fireEmailNotification(env, 'request_processed', {
        empEmail, empName, reqType, dateAffected, newShift, reqId,
        decision, adminEmail: callerEmail,
      }).catch(() => {})
    );
  }

  return json({ ok: true });
}

// ── ACTION 4: Employee browser polls for admin-triggered changes ──────────────
async function handleGetSyncFlag(body, callerEmail, saToken) {
  const rows = await sheetsRead(saToken, 'Sync_Flags!A:B').catch(() => []);
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').toLowerCase() === callerEmail) {
      return json({ ok: true, ts: rows[i][1] || null });
    }
  }
  return json({ ok: true, ts: null });
}

// ═══════════════════════════════════════════════════════════════
//  TASK 2 — Roster Generator Push (v5 addition)
// ═══════════════════════════════════════════════════════════════

// ── ACTION: publishRoster ─────────────────────────────────────────────────────
// Called by the SOC Roster Generator HTML app (soc_roster_final_v3.html).
//
// body = {
//   action   : 'publishRoster',
//   token    : '<Google OAuth access_token from GIS>',
//   month    : 5,           // 0-based (May=4, June=5, etc.)
//   year     : 2026,
//   days     : 30,
//   woQuota  : 8,
//   sats     : 4,
//   suns     : 4,
//   employees: [ { name, dept, type }, ... ],  // same order as grid rows
//   roster   : { "0":["MS","WO",...], "1":[...], ... }
//              // keys are employee array indices (0-based strings)
// }
//
// Steps:
//   1  Admin-only guard
//   2  Call Apps Script → createRosterSheet  (tab structure + formatting + formulas)
//   3  Write all shift values via Sheets API batchUpdate  (single request)
//   4  Call Apps Script → colorRosterCells  (per-cell background + font colors)
//   5  Write Summary tab data rows via batchUpdate
//   6  Return { ok, tabName, sumTabName, cellsWritten }
// ─────────────────────────────────────────────────────────────────────────────
async function handlePublishRoster(body, callerEmail, saToken, env) {

  // ── 1. Admin check ────────────────────────────────────────────────────────
  if (!await checkIsAdmin(callerEmail, saToken)) {
    return json({ ok: false, error: 'Admin access required to publish roster.' });
  }

  const { month, year, days, woQuota, sats, suns, employees, roster } = body;
  if (month === undefined || !year || !days || !employees || !roster) {
    return json({ ok: false, error: 'Missing fields: month, year, days, employees, roster.' });
  }

  const tabName    = MONTH_ORDER[month] + ' ' + year;              // e.g. "June 2026"
  const sumTabName = 'Summary_' + MONTH_ORDER[month] + '_' + year; // e.g. "Summary_June_2026"

  if (!env.APPS_SCRIPT_URL) {
    return json({ ok: false, error: 'APPS_SCRIPT_URL not set in Worker environment.' });
  }

  // ── 2. Apps Script → createRosterSheet ───────────────────────────────────
  // Creates the tab with title, config row, day headers, employee name column,
  // empty shift cells (WO default color), summary formulas, totals rows, legend.
  const gsPayload = JSON.stringify({
    action: 'createRosterSheet',
    tabName, month, year, days, woQuota, sats, suns, employees,
  });

  const gsResp = await fetch(
    env.APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(gsPayload)
  );
  if (!gsResp.ok) {
    const errText = await gsResp.text();
    return json({ ok: false, error: 'Apps Script (createRosterSheet) failed: ' + errText });
  }
  const gsData = await gsResp.json();
  if (!gsData.ok) {
    return json({ ok: false, error: 'createRosterSheet error: ' + (gsData.error || JSON.stringify(gsData)) });
  }

  // ── 3. Write shift values — single batchUpdate call ──────────────────────
  // Layout: Sl No = col A(1), Name = col B(2), Day 1 = col C(3)
  //         Employee i → sheet row (7 + i)
  const FIRST_EMP_ROW = 7;
  const FIRST_DAY_COL = 3; // col C

  const valueRanges = employees.map((emp, empIdx) => {
    const shiftRow = FIRST_EMP_ROW + empIdx;
    const shifts   = roster[String(empIdx)] || roster[empIdx] || [];
    const startCol = colLetter(FIRST_DAY_COL);
    const endCol   = colLetter(FIRST_DAY_COL + days - 1);
    return {
      range:  `'${tabName}'!${startCol}${shiftRow}:${endCol}${shiftRow}`,
      values: [shifts.map(s => s || '')],
    };
  });

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`;
  const batchResp = await fetch(batchUrl, {
    method:  'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ valueInputOption: 'USER_ENTERED', data: valueRanges }),
  });
  if (!batchResp.ok) {
    return json({ ok: false, error: 'Shift data write failed: ' + await batchResp.text() });
  }

  // ── 4. Apps Script → colorRosterCells ────────────────────────────────────
  // Applies per-cell background + font colors matching shift type.
  // Runs after values are written — cosmetic only, non-blocking on error.
  const colorPayload = JSON.stringify({
    action: 'colorRosterCells',
    tabName, days, employees, roster,
  });
  await fetch(
    env.APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(colorPayload)
  ).catch(() => null); // silent failure — data is already written

  // ── 5. Write Summary tab data rows ────────────────────────────────────────
  // Rotating employees only, sorted by total amount desc.
  const summaryRanges = [];
  const rotEmps = employees
    .map((e, i) => ({ ...e, idx: i }))
    .filter(e => e.type === 'Rotating')
    .sort((a, b) => {
      const amt = idx => {
        const s = roster[String(idx)] || [];
        return s.filter(x => x === 'MS').length * 150 +
               s.filter(x => x === 'AS').length * 150 +
               s.filter(x => x === 'NS').length * 250;
      };
      return amt(b.idx) - amt(a.idx);
    });

  rotEmps.forEach((emp, i) => {
    const s   = roster[String(emp.idx)] || [];
    const ms  = s.filter(x => x === 'MS').length;
    const as  = s.filter(x => x === 'AS').length;
    const ns  = s.filter(x => x === 'NS').length;
    const wo  = s.filter(x => x === 'WO').length;
    const tot = ms + as + ns;
    const r   = i + 3; // header at row 2, data starts row 3
    summaryRanges.push({
      range:  `'${sumTabName}'!A${r}:M${r}`,
      values: [[
        i + 1, emp.name, emp.dept,
        ms, as, ns,
        `=D${r}*150`, `=E${r}*150`, `=F${r}*250`,
        `=G${r}+H${r}+I${r}`,
        wo, tot, 'R',
      ]],
    });
  });

  if (summaryRanges.length > 0) {
    await fetch(batchUrl, {
      method:  'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ valueInputOption: 'USER_ENTERED', data: summaryRanges }),
    }).catch(err => console.warn('[publishRoster] summary write:', err.message));
  }

  return json({
    ok:           true,
    message:      `Roster published to "${tabName}" in Google Sheets.`,
    tabName,
    sumTabName,
    cellsWritten: valueRanges.length,
  });
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function colLetter(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); }
  return s;
}
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function json(data) {
  return new Response(JSON.stringify(data), { headers: CORS });
}

// ── Build daily team roster string for calendar event descriptions ─────────────
// allRosterRows : full roster rows array (all employees, all days)
// dayNum        : integer 1–31
// Output: "MS  –  Ariv, Bhaskar\nGS  –  Kranthi, Pritam\n..."
function buildDailyRosterTextW(allRosterRows, dayNum) {
  const ORDER  = ['MS','GS','AS','NS','WFH-MS','WFH-GS','WFH-AS','WFH-NS'];
  const SKIP   = new Set(['WO','GH','VL','CL','SL','CO']);
  const groups = {};

  allRosterRows
    .filter(r => r[1]?.toString().trim())
    .forEach(row => {
      const code = ((row[dayNum + 1] || '') + '').trim().toUpperCase() || 'WO';
      if (SKIP.has(code) || !ORDER.includes(code)) return;
      const firstName = row[1].trim().split(/\s+/)[0];
      (groups[code] = groups[code] || []).push(firstName);
    });

  const lines = ORDER
    .filter(k => groups[k]?.length)
    .map(k => `${k.padEnd(6)}–  ${groups[k].join(', ')}`);

  return lines.length ? lines.join('\n') : '(No scheduled staff today)';
}

// ── Fire email notification via Apps Script (non-blocking, background) ─────────
// Scenarios:
//   'request_submitted' — user submits request → confirm to user + notify all admins
//   'request_processed' — admin approves/rejects → confirm to user
//   'shift_edited'      — admin directly edits shift → notify affected user
//
// Requires APPS_SCRIPT_URL env secret (the deployed Apps Script web app URL).
// Fails silently if the env var is not set — email is always optional.
async function fireEmailNotification(env, scenario, data) {
  if (!env.APPS_SCRIPT_URL) return; // email feature disabled if URL not configured
  try {
    const payload = JSON.stringify({ action: 'emailNotify', scenario, ...data });
    await fetch(env.APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(payload));
  } catch(e) {
    console.warn('[Email] notification failed:', e.message);
  }
}