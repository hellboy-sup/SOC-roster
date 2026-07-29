const RosterBuilderUI = `
<div id="rb-container">


<!-- NAV -->
<div class="nav">
  <div class="brand"><span class="hi">SOC</span><span class="lo">::ROSTER</span></div>
  <div class="sysbar" id="sysBar">
    <span class="dot" id="sysDotGen"></span><span id="sysGenTxt">GEN: idle</span>
    <span style="opacity:.3">·</span>
    <span id="sysMonthTxt">MONTH: —</span>
    <span style="opacity:.3">·</span>
    <span class="dot" id="sysDotWarn"></span><span id="sysWarnTxt">WARN: —</span>
  </div>
  <div class="ntab active" onclick="showPage('setup')" id="tab-setup">Setup</div>
  <div class="ntab" onclick="showPage('carryover')" id="tab-carryover">Carryover</div>
  <div class="ntab" onclick="showPage('leave')" id="tab-leave">Leave / Unavailability</div>
  <div class="ntab" onclick="showPage('nsteams')" id="tab-nsteams">NS Teams</div>
  <div class="ntab" onclick="showPage('roster')" id="tab-roster">Roster Grid</div>
  <div class="ntab" onclick="showPage('summary')" id="tab-summary">Summary</div>
  <div class="nav-r">
    <button class="btn success" onclick="generate()">⚡ Auto-Generate</button>
    <button class="btn primary" onclick="doExport()">⬇ Export Excel</button>
  </div>
</div>

<!-- AUTH BAR -->
<div class="auth-bar" id="authBar" style="display:none">
  <div class="auth-user" id="authUser">
    <img class="auth-avatar" id="authAvatar" src="" alt=""/>
    <span class="auth-name" id="authName"></span>
    <span class="auth-badge" id="authBadge">user</span>
  </div>
  <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
    <span class="push-status" id="pushStatus" style="display:none"></span>
    <button class="btn sheets" id="btnPush" onclick="pushToSheets()" style="display:none" disabled>
      ☁ Push to Google Sheets
    </button>
    <button class="btn sm danger" onclick="signOut()" id="btnSignOut" style="display:none">Sign Out</button>
  </div>
</div>

<!-- SIGN IN OVERLAY -->
<div id="signInOverlay" style="display:none;position:fixed;inset:0;background:rgba(8,12,18,.92);
  z-index:300;align-items:center;justify-content:center;flex-direction:column;gap:20px">
  <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:12px;
    padding:32px 40px;text-align:center;max-width:400px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:700;
      margin-bottom:6px"><span style="color:var(--accent)">SOC</span><span style="color:var(--text2)">::ROSTER</span></div>
    <p style="font-size:12px;color:var(--text2);margin-bottom:24px;line-height:1.6">
      Sign in with your Google account to push<br>the generated roster to Google Sheets.
    </p>
    <div id="googleSignInBtn"></div>
    <p style="font-size:10px;color:var(--text3);margin-top:16px">
      You can still use the app offline — sign in only needed to push to Sheets.
    </p>
  </div>
</div>

<!-- DROPDOWN -->
<div class="ddover" id="ddOver" onclick="closeDD()"></div>
<div class="ddmenu" id="ddMenu"></div>

<!-- ADD EMP MODAL -->
<div class="mdbg" id="addModal">
  <div class="md">
    <h3>Add Employee</h3>
    <div class="frow">
      <div class="fg" style="flex:2">
        <label>Full Name</label>
        <input type="text" id="neName" placeholder="Employee full name"/>
      </div>
    </div>
    <div class="frow">
      <div class="fg" style="flex:1">
        <label>Department</label>
        <select id="neDept">
          <option value="Digiglass">Digiglass</option>
          <option value="NSOC">NSOC</option>
        </select>
      </div>
      <div class="fg" style="flex:1">
        <label>Type</label>
        <select id="neType">
          <option value="Rotating">Rotating</option>
          <option value="General">General</option>
        </select>
      </div>
    </div>
    <div class="md-ft">
      <button class="btn" onclick="closeAddModal()">Cancel</button>
      <button class="btn primary" onclick="confirmAdd()">Add Employee</button>
    </div>
  </div>
</div>

<!-- ══ SETUP ══ -->
<div class="page active" id="page-setup">
  <div class="card">
    <div class="card-hd">Month Configuration</div>
    <div class="frow">
      <div class="fg">
        <label>Month</label>
        <select id="selM" onchange="recalc()">
          <option value="0">January</option><option value="1">February</option>
          <option value="2">March</option><option value="3">April</option>
          <option value="4">May</option><option value="5">June</option>
          <option value="6">July</option><option value="7">August</option>
          <option value="8">September</option><option value="9">October</option>
          <option value="10">November</option><option value="11">December</option>
        </select>
      </div>
      <div class="fg">
        <label>Year</label>
        <input type="number" id="selY" value="2026" onchange="recalc()" style="width:88px"/>
      </div>
      <div class="fg">
        <label>Total Days</label>
        <input id="dDays" readonly style="width:64px"/>
      </div>
      <div class="fg">
        <label>WO / Employee</label>
        <input id="dWO" readonly style="width:64px"/>
      </div>
      <div class="fg">
        <label>Saturdays</label>
        <input id="dSat" readonly style="width:54px"/>
      </div>
      <div class="fg">
        <label>Sundays</label>
        <input id="dSun" readonly style="width:54px"/>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-hd">
      Employee Roster
      <span class="ct" id="empCt">21 employees</span>
      <button class="btn sm primary" style="margin-left:auto" onclick="openAddModal()">+ Add Employee</button>
    </div>
    <table class="etbl">
      <thead>
        <tr>
          <th style="width:34px">#</th>
          <th>Name</th><th>Department</th><th>Type</th>
          <th style="width:80px">Action</th>
        </tr>
      </thead>
      <tbody id="empTb"></tbody>
    </table>
  </div>
</div>

<!-- ══ CARRYOVER ══ -->
<div class="page" id="page-carryover">

  <!-- ── EXCEL IMPORT PANEL ── -->
  <div class="card" id="importCard">
    <div class="card-hd">
      📂 Auto-Derive from Last Month's Roster
      <span id="importBadge" style="display:none;padding:2px 10px;border-radius:20px;
        font-size:10px;font-weight:600;text-transform:none;letter-spacing:0"></span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn sm danger" id="clearImportBtn" onclick="clearImport()" style="display:none">✕ Clear</button>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:14px;line-height:1.65">
      Upload last month's exported <strong style="color:var(--text)">.xlsx</strong> or
      <strong style="color:var(--text)">.xlsm</strong> file.
      The app reads the last <strong style="color:var(--accent)">6 days</strong> of each rotating
      employee's row and auto-derives carryover streaks.
      Manual cards below remain as fallback overrides for unmatched / new employees.
    </p>
    <div class="drop-zone" id="dropZone"
      onclick="document.getElementById('xlsxInput').click()"
      ondragover="event.preventDefault();this.classList.add('dz-over')"
      ondragleave="this.classList.remove('dz-over')"
      ondrop="event.preventDefault();this.classList.remove('dz-over');handleFileDrop(event)">
      <div style="font-size:26px;margin-bottom:8px">📂</div>
      <div style="font-size:12px;font-weight:600;color:var(--text2)">Drop .xlsx / .xlsm here or click to browse</div>
      <div style="font-size:10px;color:var(--text3);margin-top:4px">Supports v4 export format and legacy .xlsm</div>
    </div>
    <input type="file" id="xlsxInput" accept=".xlsx,.xlsm" style="display:none"
      onchange="handleFileSelect(this.files[0])">
    <div id="importResults" style="margin-top:12px;display:none"></div>
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center" id="importActions">
      <button class="btn primary" id="applyImportBtn" onclick="applyImport()" style="display:none">
        ⚡ Apply Carryover from File
      </button>
    </div>
  </div>

  <div class="card">
    <div class="card-hd">Previous Month Carryover — Manual Override</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:16px;line-height:1.65">
      Set the number of consecutive shifts each rotating employee finished last month with, and the shift type.<br>
      <strong style="color:var(--accent)">0 = fresh start</strong> — no obligations at start of month.
      Values auto-filled by Excel import above; edit here to override.
    </p>
    <div class="carry-grid" id="carryGrid"></div>
    <div class="sep"></div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn primary" id="nsLockBtn" onclick="confirmNSCarryoverLock()">
        🔒 Confirm NS Carryover &amp; Lock Team 1
      </button>
      <button class="btn sm danger" id="nsUnlockBtn" onclick="unlockNSCarryover()" style="display:none">
        🔓 Unlock Team 1
      </button>
      <span id="nsLockStatus" style="font-size:11px;color:var(--text2)"></span>
    </div>
    <p style="font-size:10px;color:var(--text3);margin-top:8px;line-height:1.6">
      Click this once you've entered NS carryover values above for the 3 employees (2 Digiglass + 1 NSOC)
      continuing an NS block from last month. This locks them as <strong style="color:var(--text)">Team 1</strong>
      on the NS Teams tab for their remaining nights only — Team 2 onward will automatically start the day
      after Team 1's block (+ mandatory 2 WOs) finishes, so NS blocks never overlap.
    </p>
  </div>
  <div class="card">
    <div class="card-hd">Impact Summary</div>
    <div id="carryImpact" style="font-size:12px;color:var(--text2)">Set values above to see impact.</div>
  </div>
</div>

<!-- ══ LEAVE / UNAVAILABILITY (pre-generation) ══ -->
<div class="page" id="page-leave">
  <div class="card">
    <div class="card-hd">Known Leave / Unavailability — Applied Before Generation</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:16px;line-height:1.65">
      Mark any days an employee is already known to be unavailable
      (<strong style="color:var(--text)">SL, CL, VL, HL, GH, RH, EX, CO</strong>) for this month
      <strong style="color:var(--accent)">before</strong> clicking Auto-Generate. The engine will treat
      these days as pre-filled — Rotating employees' shift blocks, NS team placement, and WO quota
      math will all be built around them, instead of you having to hand-patch the grid afterward.
    </p>
    <div class="carry-grid" id="leaveGrid"></div>
  </div>
  <div class="card">
    <div class="card-hd">Pre-Assigned / Locked Week Offs — Applied Before Generation</div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:16px;line-height:1.65">
      If a Rotating employee has requested specific day(s) off this month (e.g. a personal
      commitment), lock those exact days as <strong style="color:var(--text)">WO</strong> here.
      The engine will guarantee these days stay WO, and will redistribute the
      <strong style="color:var(--accent)">rest</strong> of their WO quota across the remaining days
      of the month so their total WO count still matches everyone else's
      (<span id="lvWoQHint">—</span> per employee this month). A locked WO day also automatically
      rules that employee out of any NS team block overlapping it, since an NS block requires
      5 unbroken nights.
    </p>
    <div class="carry-grid" id="lockedWOGrid"></div>
  </div>
</div>

<!-- ══ NS TEAMS ══ -->
<div class="page" id="page-nsteams">
  <div class="card">
    <div class="card-hd">
      NS Team Assignment — Manual Override
      <div style="margin-left:auto;display:flex;gap:14px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);font-weight:600;cursor:pointer">
          <input type="checkbox" id="nsRememberChk" onchange="toggleRememberNS(this.checked)"/>
          Remember these pairings for next month
        </label>
        <button class="btn sm danger" onclick="clearAllNSTeams()">✕ Clear All</button>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:16px;line-height:1.65">
      The month is automatically split into 5-night NS team slots below (stride-5, non-overlapping,
      last slot anchored to month-end). Assign 2 Digiglass + 1 NSOC employee to any slot you want to
      fix in advance — the generator will honor that exact team for those nights.
      <strong style="color:var(--text)">Any slot left as "— Auto —" is filled automatically</strong>
      the same way as before (fixed pairs → seniority → availability).
      By default every month starts blank — tick <strong style="color:var(--accent)">"Remember these
      pairings"</strong> above if you want the same trios to pre-fill again next month.
    </p>
    <div class="carry-grid" id="nsTeamsGrid"></div>
  </div>
</div>

<!-- ══ ROSTER ══ -->
<div class="page" id="page-roster">
  <div class="toolbar">
    <div class="toolbar-t" id="rTitle">Roster — Not Generated</div>
    <div class="chips" style="margin-left:auto">
      <div class="chip active" onclick="setFilter(this,'ALL')">All</div>
      <div class="chip" onclick="setFilter(this,'Rotating')">Rotating</div>
      <div class="chip" onclick="setFilter(this,'General')">General</div>
    </div>
  </div>
  <div class="leg">
    <span style="font-size:10px;color:var(--text3);font-weight:700;letter-spacing:.5px">LEGEND</span>
    <span class="leg-i"><span class="shc s-MS">MS</span>Morning</span>
    <span class="leg-i"><span class="shc s-AS">AS</span>Afternoon</span>
    <span class="leg-i"><span class="shc s-NS">NS</span>Night</span>
    <span class="leg-i"><span class="shc s-GS">GS</span>General</span>
    <span class="leg-i"><span class="shc s-WO">WO</span>Week Off</span>
    <span class="leg-i"><span class="shc s-CO">CO</span>Comp Off</span>
    <span class="leg-i"><span class="shc s-SL">SL</span>Sick</span>
    <span class="leg-i"><span class="shc s-GH">GH</span>Gazette</span>
    <span class="leg-i"><span class="shc s-WFH">WFH</span>WFH</span>
    <span style="font-size:10px;color:var(--warn-t);margin-left:6px">🔴 Red border = understaffed shift</span>
  </div>
  <div id="nsTeamsPanel"></div>
  <div id="warnPanel"></div>
  <div class="stats-row" id="statsRow"></div>
  <div class="rwrap">
    <table class="rtbl" id="rTbl"></table>
  </div>
</div>

<!-- ══ SUMMARY ══ -->
<div class="page" id="page-summary">
  <div class="card">
    <div class="card-hd">Shift &amp; Travel Allowance Summary</div>
    <table class="stbl">
      <thead>
        <tr>
          <th>#</th><th>Employee</th><th>Dept</th>
          <th>MS</th><th>AS</th><th>NS</th><th>GS</th>
          <th>Total<br>Shifts</th><th>Total<br>WO</th>
          <th>SL</th><th>CL</th><th>CO</th>
          <th>MS ₹</th><th>AS ₹</th><th>NS ₹</th><th>Total ₹</th>
        </tr>
      </thead>
      <tbody id="sumTb"></tbody>
      <tfoot id="sumFt"></tfoot>
    </table>
  </div>
</div>


</div>
`;
