const RosterBuilder = (function() {

// ═══════════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════════
const MN=['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

const SC_MAP={
  MS:'s-MS',AS:'s-AS',NS:'s-NS',GS:'s-GS',WO:'s-WO',
  CO:'s-CO',SL:'s-SL',CL:'s-CL',VL:'s-VL',HL:'s-HL',
  GH:'s-GH',EX:'s-EX',RH:'s-RH',WFH:'s-WFH',
  'WFH-MS':'s-WFH-MS','WFH-AS':'s-WFH-AS','WFH-NS':'s-WFH-NS',
  '':'s-empty'
};
const ALL_CODES=['MS','AS','NS','GS','WO','WFH-MS','WFH-AS','WFH-NS',
  'WFH','CO','SL','CL','VL','HL','GH','EX','RH',''];



let emps = [];
let carry={};
let roster={};
let cfg={month:4,year:2026,days:31,woQ:10,sats:5,suns:5};
let nxtId=25;
let filt='ALL';

// Pre-generation known leave/unavailability: preLeave[empId] = { day:number -> code:string }
// Applied BEFORE the generation engine runs (see TASK-1 block inside generate()).
let preLeave={};
const LEAVE_CODES=['SL','CL','VL','HL','GH','RH','EX','CO'];

// ── TASK-2: Pre-assigned / Locked Week Offs ────────────────────────────────
// preWO[empId] = Set of day-numbers the employee has requested as a fixed WO
// (e.g. pre-approved personal commitments). Seeded into tl[] exactly like
// preLeave (STEP 0 of generate()), so:
//   - NS eligibility (isFreeForNS) automatically excludes them from any NS
//     team slot overlapping a locked WO day (tl cell is non-null → not free)
//   - Block-length gap-fill automatically shortens/splits shift blocks
//     around the locked day
//   - The >6-consecutive repair treats it as a hard break, same as any WO
// The ONE place that needs an explicit exception is the WO-count rebalancer
// (Step 3 + Step 8): it must never convert a locked WO into a shift to hit
// quota — it should only ever move the OTHER (auto-placed) WO days around.
let preWO={};

// NS team configuration:
//   NS_SENIOR_NAMES — experienced employees prioritized for NS over newer ones.
//                     Matched by case-insensitive substring.
const NS_SENIOR_NAMES = ['ritisha','susmita','navoneel','supratim','mehul','shreya','swagat','priya'];

// ═══════════════════════════════════════════════════════════════
// MANUAL NS TEAM ASSIGNMENT  (NS Teams tab)
// ═══════════════════════════════════════════════════════════════
// manualNSTeams[slotIndex] = { digi:[empId,empId], nsoc:empId }
// Only slots the user has fully filled (both Digi + the NSOC member) are
// honored by buildNSTeams() — any slot left blank/partial still falls back
// to the existing seniority-based auto-selection logic.
let manualNSTeams = {};
// ── NS carryover lock (Task-2 fix) ─────────────────────────────────────────
// When set, Team 1 for THIS month is a continuation of an NS block that
// started last month — not a fresh 5-night block. Populated by the
// "Confirm NS Carryover & Lock Team 1" button on the Carryover tab.
//   { digi:[id,id], nsoc:id, remaining:N, finishDay:N }
// remaining = NS nights still owed this month (5 - last month's carry.shifts)
// finishDay = first day Team 1's members are free again (remaining nights
//             + 2 mandatory WOs + 1), i.e. where Team 2's stride begins.
let nsCarryLock = null;

// Snapshot of the teams actually placed by the most recent generate() call —
// {members:[id,id,id], start, manual:bool} — used purely for the "NS Team
// Composition" confirmation panel on the Roster page so you can verify a
// manual pick was honored, versus getting the same trio auto would pick too.
let lastNSTeamsPlaced = [];

// Whether to persist the current team pairings (by employee id) to
// localStorage so they pre-fill the NS Teams tab again next month. OFF by
// default — each month starts as a fresh, blank assignment unless the user
// explicitly ticks this.
let rememberNSPairings = (function () {
  try { return localStorage.getItem('nsRememberPairings') === '1'; }
  catch (e) { return false; }
})();

// Compute the NS team slots (start day of each 5-night block) for a given
// month length. This is the single source of truth shared by the NS Teams
// tab (for display + manual assignment) and buildNSTeams() (for actual
// generation), so they can never disagree on how many teams exist or where
// each one starts.
//   Forward pass: 1, 6, 11, 16, ... (stride=5, no shared day between teams)
//   Last team is anchored so its block ends exactly on DAYS.
// Pure, strictly non-overlapping 5-night stride starting at `startFrom`.
// The LAST block of the month may be SHORTER than 5 nights if the month
// doesn't divide evenly — that's fine and expected: those nights carry
// over into next month (via the "Confirm NS Carryover & Lock Team 1"
// button), exactly like Team 1 does at the start of THIS month when
// nsCarryLock is set. There is never any overlap and never any gap.
function computeNSTeamSlots(DAYS, startFrom = 1) {
  const slots = [];
  let sd = Math.max(1, startFrom);
  while (sd <= DAYS) {
    slots.push({ start: sd, end: Math.min(sd + 4, DAYS) });
    sd += 5;
  }
  return slots;
}

// Full list of NS team slots for the month, accounting for a locked
// carryover Team 1 if one is set. Shared by the NS Teams tab (rendering +
// manual assignment) and buildNSTeams() (actual generation) so they always
// agree on how many teams exist, in what order, and where each starts.
function getNSSlots(DAYS) {
  if (nsCarryLock) {
    const lockedSlot = { start: 1, end: Math.min(nsCarryLock.remaining, DAYS), locked: true };
    return [lockedSlot, ...computeNSTeamSlots(DAYS, nsCarryLock.finishDay)];
  }
  return computeNSTeamSlots(DAYS, 1);
}

// ── Confirm NS Carryover & Lock Team 1 ──────────────────────────────────
// Scans the carry{} values entered on this tab for exactly one NS
// carryover team (2 Digiglass + 1 NSOC, all type 'NS', matching shift
// counts) and locks them as Team 1 for the month.
function confirmNSCarryoverLock() {
  const nsCarry = emps.filter(e => e.type === 'Rotating')
    .filter(e => carry[e.id] && carry[e.id].type === 'NS' && carry[e.id].shifts > 0);

  const statusEl = document.getElementById('nsLockStatus');

  if (nsCarry.length === 0) {
    statusEl.style.color = 'var(--warn-t)';
    statusEl.textContent = '⚠ No employees have an NS carryover set above — nothing to lock.';
    return;
  }
  const digi = nsCarry.filter(e => e.dept === 'Digiglass');
  const nsoc = nsCarry.filter(e => e.dept === 'NSOC');
  if (digi.length !== 2 || nsoc.length !== 1) {
    statusEl.style.color = 'var(--warn-t)';
    statusEl.textContent = `⚠ Expected exactly 2 Digiglass + 1 NSOC with NS carryover, found ${digi.length} Digiglass + ${nsoc.length} NSOC. Fix the values above and try again.`;
    return;
  }
  const shiftCounts = [...digi, ...nsoc].map(e => carry[e.id].shifts);
  if (new Set(shiftCounts).size !== 1) {
    statusEl.style.color = 'var(--warn-t)';
    statusEl.textContent = `⚠ Carryover shift counts don't match across the team (${shiftCounts.join(', ')}) — an NS team starts/ends together. Fix the values above and try again.`;
    return;
  }

  // NS blocks are hard-capped at 5 consecutive nights. A stored value of 5
  // (or, defensively, anything >5 from a stale/manual entry) means the
  // block was ALREADY COMPLETE at month-end — there are 0 nights left to
  // continue, only the 2 mandatory WOs are owed at the start of this month.
  //
  // BUGFIX: this used to be `Math.max(1, 5 - shiftCounts[0])`, which forced
  // a minimum of 1 "remaining" night even when the block was fully done
  // (5/5). That created a locked Team-1 slot spanning Day 1 with nobody
  // actually scheduled NS that day (the per-employee carryover step
  // correctly placed their 2 WOs, not an NS shift) — so the later
  // NS-coverage rebalancing pass would see an "uncovered" NS-team day and
  // pull in an unrelated employee to fill it. That's the phantom NS shift
  // on Day 1. Clamping to 0 here, and skipping the lock entirely when
  // there's nothing left to continue, removes the mismatch at the source.
  const cappedShifts = Math.min(5, shiftCounts[0]);
  const remaining = Math.max(0, 5 - cappedShifts);

  if (remaining === 0) {
    nsCarryLock = null;
    statusEl.style.color = 'var(--ok-t)';
    statusEl.textContent = `✓ ${digi[0].name}, ${digi[1].name}, ${nsoc[0].name} already completed their full 5-night NS block last month — no lock needed. They'll automatically get their 2 mandatory WO days at the start of this month, and Team 1 for this month will be freshly auto-selected from Day 1.`;
    document.getElementById('nsLockBtn').style.display = '';
    document.getElementById('nsUnlockBtn').style.display = 'none';
    renderNSTeamsPage();
    return;
  }

  // IMPORTANT: the next team starts the day AFTER Team 1's NS nights end —
  // NOT after Team 1's own 2 mandatory WOs. In every normal (non-carryover)
  // handoff, Team N+1's NS block already starts the moment Team N's NS
  // nights finish, and it's Team N+1's presence that covers Team N's WO
  // days. Starting Team 2 any later (e.g. after Team 1's WOs finish) would
  // recreate exactly the "zero NS coverage" gap this fix exists to prevent.
  const finishDay = remaining + 1;
  nsCarryLock = {
    digi: [digi[0].id, digi[1].id],
    nsoc: nsoc[0].id,
    remaining,
    finishDay,
  };
  // Reindex any existing manual picks for slots 1+ is unnecessary — they
  // stay keyed the same way (index 0 is now reserved for the locked team).
  statusEl.style.color = 'var(--ok-t)';
  statusEl.textContent = `✓ Team 1 locked: ${digi[0].name}, ${digi[1].name}, ${nsoc[0].name} — ${remaining} NS night${remaining!==1?'s':''} remaining, Team 2 starts Day ${finishDay}.`;
  document.getElementById('nsLockBtn').style.display = 'none';
  document.getElementById('nsUnlockBtn').style.display = '';
  renderNSTeamsPage();
}

function unlockNSCarryover() {
  nsCarryLock = null;
  document.getElementById('nsLockBtn').style.display = '';
  document.getElementById('nsUnlockBtn').style.display = 'none';
  document.getElementById('nsLockStatus').textContent = '';
  renderNSTeamsPage();
}

function saveNSPairingDefaults() {
  try {
    const list = Object.values(manualNSTeams)
      .filter(t => t && t.digi && t.digi.length === 2 && t.nsoc)
      .map(t => ({ digi: t.digi.slice(), nsoc: t.nsoc }));
    localStorage.setItem('nsTeamPairingDefaults', JSON.stringify(list));
  } catch (e) { /* localStorage unavailable — silently skip persistence */ }
}

function loadNSPairingDefaults() {
  try {
    const raw = localStorage.getItem('nsTeamPairingDefaults');
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function toggleRememberNS(checked) {
  rememberNSPairings = checked;
  try { localStorage.setItem('nsRememberPairings', checked ? '1' : '0'); } catch (e) {}
  if (checked) saveNSPairingDefaults();
  renderNSTeamsPage();
}

// Called whenever a slot's Digi/NSOC dropdown changes.
function setNSTeamMember(slotIdx, role, empId) {
  const id = empId ? +empId : null;
  if (!manualNSTeams[slotIdx]) manualNSTeams[slotIdx] = { digi: [null, null], nsoc: null };
  if (role === 'nsoc') manualNSTeams[slotIdx].nsoc = id;
  else if (role === 'digi0') manualNSTeams[slotIdx].digi[0] = id;
  else if (role === 'digi1') manualNSTeams[slotIdx].digi[1] = id;
  if (rememberNSPairings) saveNSPairingDefaults();
  renderNSTeamsPage();
}

function clearNSTeamSlot(slotIdx) {
  delete manualNSTeams[slotIdx];
  if (rememberNSPairings) saveNSPairingDefaults();
  renderNSTeamsPage();
}

function clearAllNSTeams() {
  manualNSTeams = {};
  if (rememberNSPairings) saveNSPairingDefaults();
  renderNSTeamsPage();
}

// Renders the "NS Teams" tab: one card per required team slot for the
// currently-selected month, each with 2 Digiglass + 1 NSOC dropdown.
// Pre-fills from saved defaults (if rememberNSPairings is on and the slot
// is otherwise blank) or from whatever the user has already picked this
// session for slots beyond the saved-default count.
// ── NS Teams tab: dropdown eligibility rules ──────────────────────────────
// Computed fresh on every render so it always reflects the current state of
// manualNSTeams + the locked carryover team. Three rules enforced purely in
// the UI (the generation engine already enforces its own version of these
// via isFreeForNS / nsCnt, so this just keeps the dropdown lists honest and
// prevents the user from picking something the engine would reject anyway):
//   1. No consecutive NS blocks — an employee placed in team i cannot be
//      offered again for team i+1's dropdown (they reappear from i+2 on).
//   2. The locked carryover Team 1's members count as "already used" for
//      rule 1 and rule 3, exactly like any other team — so they're excluded
//      from Team 2's dropdowns, and count toward their 2-block cap.
//   3. An employee already placed in 2 NS teams this month (locked +
//      manual, combined) is removed from every remaining team's dropdown.
function computeNSEligibility(slots) {
  // membersAtSlot[i] = Set of employee ids sitting in that slot right now
  // (locked team's fixed members, or whatever's been manually picked so far —
  // partially-filled teams still count for the members chosen).
  const membersAtSlot = slots.map((sl, i) => {
    if (sl.locked) return new Set([...nsCarryLock.digi, nsCarryLock.nsoc]);
    const m = manualNSTeams[i];
    const ids = new Set();
    if (m) {
      if (m.digi[0]) ids.add(m.digi[0]);
      if (m.digi[1]) ids.add(m.digi[1]);
      if (m.nsoc) ids.add(m.nsoc);
    }
    return ids;
  });

  // Rule 3: total NS-block count across the whole month so far.
  const usageCount = {};
  membersAtSlot.forEach(set => {
    set.forEach(id => { usageCount[id] = (usageCount[id] || 0) + 1; });
  });

  // Per-slot excluded set = previous team's members (rule 1/2) ∪ anyone
  // who has already hit the 2-block cap (rule 3).
  const excludedForSlot = slots.map((sl, i) => {
    const excl = new Set();
    if (i > 0) membersAtSlot[i - 1].forEach(id => excl.add(id));
    Object.keys(usageCount).forEach(id => {
      if (usageCount[id] >= 2) excl.add(+id);
    });
    return excl;
  });

  return { membersAtSlot, usageCount, excludedForSlot };
}

function renderNSTeamsPage() {
  const grid = document.getElementById('nsTeamsGrid');
  if (!grid) return;
  const DAYS = cfg.days;
  const slots = getNSSlots(DAYS);
  const digiR = emps.filter(e => e.type === 'Rotating' && e.dept === 'Digiglass');
  const nsocR = emps.filter(e => e.type === 'Rotating' && e.dept === 'NSOC');

  // Auto pre-fill from saved defaults only where the user hasn't already
  // touched that slot this session (manualNSTeams[i] is still undefined).
  // Skip index 0 when it's the locked carryover team — that's never
  // auto-filled from saved pairing defaults.
  if (rememberNSPairings) {
    const defaults = loadNSPairingDefaults();
    // Track eligibility as we go, slot by slot, exactly like computeNSEligibility
    // does for rendering — a saved pairing from a previous month should not be
    // silently reintroduced if it now breaks the consecutive-block or
    // 2-block-cap rules against whatever's already locked/placed this month.
    const usageCount = {};
    if (nsCarryLock) {
      [...nsCarryLock.digi, nsCarryLock.nsoc].forEach(id => { usageCount[id] = (usageCount[id] || 0) + 1; });
    }
    let prevMembers = nsCarryLock ? new Set([...nsCarryLock.digi, nsCarryLock.nsoc]) : new Set();
    slots.forEach((sl, i) => {
      if (sl.locked) return; // prevMembers/usageCount already seeded above
      if (manualNSTeams[i] !== undefined) {
        // Already user-picked this session — just fold it into the running state
        const m = manualNSTeams[i];
        const ids = [m.digi[0], m.digi[1], m.nsoc].filter(Boolean);
        ids.forEach(id => { usageCount[id] = (usageCount[id] || 0) + 1; });
        prevMembers = new Set(ids);
        return;
      }
      const d = defaults[i];
      if (!d) { prevMembers = new Set(); return; }
      const excluded = id => prevMembers.has(id) || (usageCount[id] || 0) >= 2;
      const digiOk = d.digi.every(id => digiR.some(e => e.id === id)) && d.digi.every(id => !excluded(id));
      const nsocOk = nsocR.some(e => e.id === d.nsoc) && !excluded(d.nsoc);
      if (digiOk && nsocOk) {
        manualNSTeams[i] = { digi: d.digi.slice(), nsoc: d.nsoc };
        [...d.digi, d.nsoc].forEach(id => { usageCount[id] = (usageCount[id] || 0) + 1; });
        prevMembers = new Set([...d.digi, d.nsoc]);
      } else {
        prevMembers = new Set(); // default skipped — nothing carries forward as "previous"
      }
    });
  }

  const rememberChk = document.getElementById('nsRememberChk');
  if (rememberChk) rememberChk.checked = rememberNSPairings;

  const elig = computeNSEligibility(slots);

  grid.innerHTML = slots.map((sl, i) => {
    // ── Locked carryover Team 1 — read-only summary card ─────────────
    if (sl.locked) {
      const dNames = nsCarryLock.digi.map(id => emps.find(e => e.id === id)?.name || '?');
      const nName  = emps.find(e => e.id === nsCarryLock.nsoc)?.name || '?';
      return `<div class="ccard imported" style="border-color:var(--ok-b)">
        <div class="ccard-name">🔒 Team 1 <span style="color:var(--ok-t);font-weight:400;font-size:9px">(carried over)</span>
          <span style="float:right;font-size:9px;color:var(--text3);font-weight:400">Day ${sl.start}–${sl.end} (${nsCarryLock.remaining} night${nsCarryLock.remaining!==1?'s':''})</span>
        </div>
        <div style="font-size:11px;color:var(--text);line-height:1.7">
          ${dNames[0]}<br>${dNames[1]}<br>${nName}
        </div>
        <div class="ccard-hint" style="color:var(--ok-t)">Locked — continuing last month's NS block. Team 2 starts Day ${nsCarryLock.finishDay}.</div>
      </div>`;
    }

    const m = manualNSTeams[i] || { digi: [null, null], nsoc: null };
    // Exclude: anyone in the immediately-previous team (rule 1/2) or at
    // their 2-block cap (rule 3) — but never hide an option that is this
    // exact dropdown's own current selection, so an existing pick never
    // silently vanishes if a later edit elsewhere makes it ineligible.
    const excl = elig.excludedForSlot[i];
    const digiOptFor = (sel, otherSel) => `<option value="">— Auto —</option>` +
      digiR.filter(e => e.id === sel || (!excl.has(e.id) && e.id !== otherSel))
        .map(e => `<option value="${e.id}" ${sel === e.id ? 'selected' : ''}>${e.name}</option>`).join('');
    const nsocOptFor = (sel) => `<option value="">— Auto —</option>` +
      nsocR.filter(e => e.id === sel || !excl.has(e.id))
        .map(e => `<option value="${e.id}" ${sel === e.id ? 'selected' : ''}>${e.name}</option>`).join('');
    const filled = m.digi[0] && m.digi[1] && m.nsoc;
    const nightLabel = (sl.end - sl.start + 1) === 5 ? '5 nights' : `${sl.end - sl.start + 1} night${(sl.end-sl.start+1)!==1?'s':''} — continues next month`;
    return `<div class="ccard${filled ? ' imported' : ''}">
      <div class="ccard-name">Team ${i + 1}
        <span style="float:right;font-size:9px;color:var(--text3);font-weight:400">Day ${sl.start}–${sl.end} (${nightLabel})</span>
      </div>
      <div class="frow" style="margin:0 0 6px 0;gap:6px">
        <div class="fg" style="flex:1">
          <label>Digiglass A</label>
          <select onchange="setNSTeamMember(${i},'digi0',this.value)">${digiOptFor(m.digi[0], m.digi[1])}</select>
        </div>
        <div class="fg" style="flex:1">
          <label>Digiglass B</label>
          <select onchange="setNSTeamMember(${i},'digi1',this.value)">${digiOptFor(m.digi[1], m.digi[0])}</select>
        </div>
      </div>
      <div class="frow" style="margin:0;gap:6px">
        <div class="fg" style="flex:1">
          <label>NSOC</label>
          <select onchange="setNSTeamMember(${i},'nsoc',this.value)">${nsocOptFor(m.nsoc)}</select>
        </div>
        <div class="fg" style="justify-content:flex-end">
          <button class="btn xs" onclick="clearNSTeamSlot(${i})">✕ Clear</button>
        </div>
      </div>
      ${filled ? '' : '<div class="ccard-hint" style="color:var(--text3)">Left blank — auto-selection will fill this team</div>'}
    </div>`;
  }).join('');
}


// Import state
let importedCarry=null;   // { derived:{[empId]:{shifts,type,exhausted}}, unmatched:[] }
let _nsCarryTeams=[];     // detected NS carry-teams from last month's Excel

// ═══════════════════════════════════════════════════════════════
// MONTH HELPERS
// ═══════════════════════════════════════════════════════════════
function recalc(){
  const m=+document.getElementById('selM').value;
  const y=+document.getElementById('selY').value;
  const days=new Date(y,m+1,0).getDate();
  let s=0,u=0;
  for(let d=1;d<=days;d++){const w=dow(d,m,y);if(w===6)s++;if(w===0)u++;}
  const monthChanged = !cfg || cfg.month!==m || cfg.year!==y;
  cfg={month:m,year:y,days,woQ:s+u,sats:s,suns:u};
  document.getElementById('dDays').value=days;
  document.getElementById('dWO').value=s+u;
  document.getElementById('dSat').value=s;
  document.getElementById('dSun').value=u;
  // Slot count/meaning is month-length-dependent — a fresh month always
  // starts with a blank NS Teams tab (renderNSTeamsPage() re-applies saved
  // defaults afterwards if "remember pairings" is ticked).
  if(monthChanged){
    manualNSTeams={};
    nsCarryLock=null;
    const lb=document.getElementById('nsLockBtn'); if(lb) lb.style.display='';
    const ub=document.getElementById('nsUnlockBtn'); if(ub) ub.style.display='none';
    const st=document.getElementById('nsLockStatus'); if(st) st.textContent='';
    renderNSTeamsPage();
  }
  renderLockedWOPage();
  const smt=document.getElementById('sysMonthTxt');
  if(smt) smt.textContent=`MONTH: ${MN[m].slice(0,3).toUpperCase()} ${y}`;
}
function dow(d,m,y){m=m??cfg.month;y=y??cfg.year;return new Date(y,m,d).getDay();}
function isWE(d){const w=dow(d);return w===0||w===6;}
function dn(d){return['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow(d)];}

// ═══════════════════════════════════════════════════════════════
// SETUP PAGE
// ═══════════════════════════════════════════════════════════════
function renderEmps(){
  const tb=document.getElementById('empTb');tb.innerHTML='';
  emps.forEach((e,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="color:var(--text3);font-family:'JetBrains Mono',monospace">${i+1}</td>
      <td style="font-weight:500">${e.name}</td>
      <td><span class="${e.dept==='NSOC'?'b-nsoc':'b-digi'}">${e.dept}</span></td>
      <td><span class="${e.type==='Rotating'?'b-rot':'b-gen'}">${e.type}</span></td>
      <td><button class="btn xs danger" onclick="removeEmp(${e.id})">Remove</button></td>`;
    tb.appendChild(tr);
  });
  document.getElementById('empCt').textContent=emps.length+' employees';
}
function removeEmp(id){emps=emps.filter(e=>e.id!==id);renderEmps();}
function openAddModal(){document.getElementById('addModal').classList.add('open');}
function closeAddModal(){document.getElementById('addModal').classList.remove('open');}
function confirmAdd(){
  const name=document.getElementById('neName').value.trim();
  if(!name)return;
  const newEmp={id:nxtId++,name,
    dept:document.getElementById('neDept').value,
    type:document.getElementById('neType').value};
  if(newEmp.type==='Rotating'){
    // Insert just before the first General employee so rotating employees
    // always appear above the General section.
    const firstGenIdx=emps.findIndex(e=>e.type==='General');
    if(firstGenIdx===-1) emps.push(newEmp);
    else emps.splice(firstGenIdx,0,newEmp);
  } else {
    // General employees: insert at the top of the existing General block.
    const firstGenIdx=emps.findIndex(e=>e.type==='General');
    if(firstGenIdx===-1) emps.push(newEmp);
    else emps.splice(firstGenIdx,0,newEmp);
  }
  closeAddModal();
  document.getElementById('neName').value='';
  renderEmps();
}

// ═══════════════════════════════════════════════════════════════
// CARRYOVER PAGE
// ═══════════════════════════════════════════════════════════════
function renderCarry(){
  const grid=document.getElementById('carryGrid');grid.innerHTML='';
  emps.filter(e=>e.type==='Rotating').forEach(e=>{
    if(!carry[e.id]) carry[e.id]={shifts:0,type:'MS'};
    const c=carry[e.id];
    // Check import status
    const imported=importedCarry?.derived?.[e.id];
    const missed=importedCarry&&!imported;
    const d=document.createElement('div');
    d.className='ccard'+(imported?' imported':missed?' imported-warn':'');
    d.innerHTML=`
      <div class="ccard-name">${e.name}${imported?'<span style="float:right;font-size:9px;color:var(--ok-t);font-weight:400">▶ from file</span>':missed?'<span style="float:right;font-size:9px;color:var(--warn-t);font-weight:400">⚠ manual</span>':''}</div>
      <div style="margin-bottom:9px"><span class="${e.dept==='NSOC'?'b-nsoc':'b-digi'}">${e.dept}</span></div>
      <div class="frow" style="margin:0;gap:8px">
        <div class="fg" style="flex:1">
          <label>Consecutive Shifts</label>
          <select onchange="updC(${e.id},'shifts',this.value)">
            ${(c.type==='NS'?[0,1,2,3,4,5]:[0,1,2,3,4,5,6]).map(n=>`<option value="${n}" ${c.shifts==n?'selected':''}>${n===0?'0 — fresh start':n}</option>`).join('')}
          </select>
        </div>
        <div class="fg" style="flex:1">
          <label>Shift Type</label>
          <select onchange="updC(${e.id},'type',this.value)">
            <option value="MS" ${c.type==='MS'?'selected':''}>MS — Morning</option>
            <option value="AS" ${c.type==='AS'?'selected':''}>AS — Afternoon</option>
            <option value="GS" ${c.type==='GS'?'selected':''}>GS — General</option>
            <option value="NS" ${c.type==='NS'?'selected':''}>NS — Night</option>
          </select>
        </div>
      </div>
      <div class="ccard-hint" id="ch-${e.id}"></div>`;
    grid.appendChild(d);
    renderHint(e.id);
  });
}
function updC(id,k,v){
  if(!carry[id]) carry[id]={shifts:0,type:'MS'};
  carry[id][k]=k==='shifts'?+v:v;
  // NS blocks are hard-capped at 5 consecutive nights (unlike MS/AS, which
  // can run up to 6) — if the type is switched to NS while a stale value
  // of 6 is still set (e.g. left over from an MS/AS entry), clamp it down
  // so it can never silently imply a 6th NS night that doesn't exist.
  if(k==='type'&&v==='NS'&&carry[id].shifts>5) carry[id].shifts=5;
  if(k==='type'){ renderCarry(); renderCarryImpact(); return; } // dropdown range depends on type — full re-render
  renderHint(id);renderCarryImpact();
}
function renderHint(id){
  const c=carry[id];if(!c)return;
  const el=document.getElementById('ch-'+id);if(!el)return;
  if(c.shifts===0){el.textContent='→ Fresh start on Day 1';return;}
  const mx=c.type==='NS'?5:6, rem=mx-c.shifts;
  el.textContent=rem<=0
    ?`→ Block done. WO Day 1–2, shifts from Day 3`
    :`→ ${rem}× ${c.type}, then WO Day ${rem+1}–${rem+2}`;
}
function renderCarryImpact(){
  const html=emps.filter(e=>e.type==='Rotating').map(e=>{
    const c=carry[e.id]||{shifts:0,type:'MS'};
    const mx=c.type==='NS'?5:6, rem=Math.max(0,mx-c.shifts);
    return`<div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:9px 13px;min-width:155px">
      <div style="font-weight:600;font-size:12px;margin-bottom:3px">${e.name.split(' ')[0]}</div>
      <div style="font-size:10px;color:var(--text2);font-family:'JetBrains Mono',monospace">
        ${c.shifts===0?'Fresh start':`${rem>0?rem+'× '+c.type+' →':''} WO Day ${Math.max(rem,0)+1}–${Math.max(rem,0)+2}`}
      </div>
    </div>`;
  }).join('');
  document.getElementById('carryImpact').innerHTML=
    `<div style="display:flex;flex-wrap:wrap;gap:8px">${html}</div>`;
}

// ═══════════════════════════════════════════════════════════════
// LEAVE / UNAVAILABILITY PAGE  (TASK-1: pre-generation input)
// ═══════════════════════════════════════════════════════════════
// Parses strings like "5,6,12-14, 20" into a sorted array of unique day numbers
// clamped to the current month's day count.
function parseDaySpec(spec){
  const days=new Set();
  spec.split(',').forEach(tok=>{
    tok=tok.trim();if(!tok)return;
    const rangeM=tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if(rangeM){
      let a=+rangeM[1],b=+rangeM[2];
      if(a>b)[a,b]=[b,a];
      for(let d=a;d<=b;d++) if(d>=1&&d<=cfg.days) days.add(d);
    } else if(/^\d+$/.test(tok)){
      const d=+tok; if(d>=1&&d<=cfg.days) days.add(d);
    }
  });
  return[...days].sort((a,b)=>a-b);
}

function renderLeavePage(){
  const grid=document.getElementById('leaveGrid');if(!grid)return;
  grid.innerHTML='';
  emps.forEach(e=>{
    if(!preLeave[e.id]) preLeave[e.id]={};
    const entries=Object.entries(preLeave[e.id]).sort((a,b)=>(+a[0])-(+b[0]));
    const d=document.createElement('div');
    d.className='ccard';
    d.innerHTML=`
      <div class="ccard-name">${e.name}
        <span style="float:right;font-size:9px;color:var(--text3);font-weight:400">${e.dept} · ${e.type}</span>
      </div>
      <div class="frow" style="margin:0 0 8px 0;gap:8px">
        <div class="fg" style="flex:2">
          <label>Day(s)</label>
          <input type="text" id="lv-days-${e.id}" placeholder="e.g. 5,6,12-14"/>
        </div>
        <div class="fg" style="flex:1">
          <label>Code</label>
          <select id="lv-code-${e.id}">
            ${LEAVE_CODES.map(c=>`<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="fg" style="justify-content:flex-end">
          <button class="btn sm" onclick="addLeaveEntry(${e.id})">+ Add</button>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:5px" id="lv-chips-${e.id}">
        ${entries.length?entries.map(([day,code])=>
          `<span class="shc s-${code}" style="cursor:pointer;width:auto;padding:0 8px"
             title="Click to remove" onclick="removeLeaveEntry(${e.id},${day})">D${day}:${code} ✕</span>`
        ).join(''):'<span style="font-size:10px;color:var(--text3)">No leave marked</span>'}
      </div>`;
    grid.appendChild(d);
  });
}
function addLeaveEntry(empId){
  const daysInput=document.getElementById('lv-days-'+empId);
  const codeInput=document.getElementById('lv-code-'+empId);
  const days=parseDaySpec(daysInput.value);
  if(!days.length)return;
  if(!preLeave[empId]) preLeave[empId]={};
  days.forEach(d=>{preLeave[empId][d]=codeInput.value;});
  daysInput.value='';
  renderLeavePage();
}
function removeLeaveEntry(empId,day){
  if(preLeave[empId]) delete preLeave[empId][day];
  renderLeavePage();
}

// ═══════════════════════════════════════════════════════════════
// TASK-2: LOCKED / PRE-ASSIGNED WEEK-OFF PAGE
// ═══════════════════════════════════════════════════════════════
function renderLockedWOPage(){
  const grid=document.getElementById('lockedWOGrid');if(!grid)return;
  const hint=document.getElementById('lvWoQHint');
  if(hint) hint.textContent=cfg.woQ;
  grid.innerHTML='';
  emps.filter(e=>e.type==='Rotating').forEach(e=>{
    if(!preWO[e.id]) preWO[e.id]=new Set();
    const days=[...preWO[e.id]].sort((a,b)=>a-b);
    const over=days.length>cfg.woQ;
    const d=document.createElement('div');
    d.className='ccard'+(days.length?(over?' imported-warn':' imported'):'');
    d.innerHTML=`
      <div class="ccard-name">${e.name}
        <span style="float:right;font-size:9px;color:var(--text3);font-weight:400">${e.dept}</span>
      </div>
      <div class="frow" style="margin:0 0 8px 0;gap:8px">
        <div class="fg" style="flex:2">
          <label>Day(s) — locked as WO</label>
          <input type="text" id="wo-days-${e.id}" placeholder="e.g. 9,10"/>
        </div>
        <div class="fg" style="justify-content:flex-end">
          <button class="btn sm" onclick="addLockedWOEntry(${e.id})">+ Add</button>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:5px" id="wo-chips-${e.id}">
        ${days.length?days.map(day=>
          `<span class="shc s-WO" style="cursor:pointer;width:auto;padding:0 8px"
             title="Click to remove" onclick="removeLockedWOEntry(${e.id},${day})">D${day}:WO ✕</span>`
        ).join(''):'<span style="font-size:10px;color:var(--text3)">No locked WOs</span>'}
      </div>
      ${over?`<div class="ccard-hint" style="color:var(--warn-t)">⚠ ${days.length} locked WOs exceeds this month's quota of ${cfg.woQ} — remove some or they will absorb the employee's entire WO allowance.</div>`:''}`;
    grid.appendChild(d);
  });
}
function addLockedWOEntry(empId){
  const daysInput=document.getElementById('wo-days-'+empId);
  const days=parseDaySpec(daysInput.value);
  if(!days.length)return;
  if(!preWO[empId]) preWO[empId]=new Set();
  days.forEach(d=>preWO[empId].add(d));
  daysInput.value='';
  renderLockedWOPage();
}
function removeLockedWOEntry(empId,day){
  if(preWO[empId]) preWO[empId].delete(day);
  renderLockedWOPage();
}

// ═══════════════════════════════════════════════════════════════
// ███ GENERATION ENGINE ███
// ═══════════════════════════════════════════════════════════════
function generate(){
  roster={};
  const{days:DAYS,woQ:WO_Q}=cfg;

  // GENERAL: Mon–Fri = GS, weekends = WO
  emps.filter(e=>e.type==='General').forEach(e=>{
    roster[e.id]=[];
    for(let d=1;d<=DAYS;d++) roster[e.id].push(isWE(d)?'WO':'GS');
    // TASK-1: overlay any pre-known leave onto General employees' base pattern
    const lv=preLeave[e.id];
    if(lv) for(const day in lv) if(+day>=1&&+day<=DAYS) roster[e.id][+day-1]=lv[day];
  });

  const rot=emps.filter(e=>e.type==='Rotating');
  const N=rot.length;
  if(!N){renderGrid();renderSum();showPage('roster');
  if(gAuthToken){const pb=document.getElementById('btnPush');if(pb)pb.disabled=false;}
  return;}

  // ── STEP 0 (TASK-1): Pre-seed known leave/unavailability ──────────────────
  // Any day marked in preLeave for a Rotating employee is locked into their
  // timeline BEFORE carryover / NS-team / MS-AS block-fill run. Every later
  // step (isFreeForNS, the gap-fill loop, coverage rebalancing) already treats
  // any non-null tl cell as "occupied", so pre-seeding here is enough to make
  // the whole engine schedule shifts and WOs around real, known unavailability
  // instead of assigning shifts over it and requiring a manual patch-up.
  const tl={};
  rot.forEach(e=>{
    tl[e.id]=new Array(DAYS+1).fill(null);
    const lv=preLeave[e.id];
    if(lv) for(const day in lv){
      const d=+day;
      if(d>=1&&d<=DAYS) tl[e.id][d]=lv[day];
    }
    // TASK-2: seed locked/pre-assigned WO days. These take the same
    // "already occupied, never overwritten" treatment as preLeave days —
    // NS eligibility, block-length gap-fill, and the >6-consecutive repair
    // all already respect any non-null tl cell, so this alone is enough to
    // guarantee the day stays WO and NS never lands on it.
    const wo=preWO[e.id];
    if(wo) wo.forEach(d=>{
      if(d>=1&&d<=DAYS&&tl[e.id][d]===null) tl[e.id][d]='WO';
    });
  });

  // ── STEP 1a: Init timelines — NS-carryover ONLY ───────────────────────────
  // BUGFIX (v15): previously this step placed EVERY rotating employee's
  // carryover continuation (both MS/AS *and* NS) into tl[] before NS teams
  // were built. In real month-to-month rollovers almost every rotating
  // employee carries over some MS/AS shift count, so by the time
  // buildNSTeams() ran, every Digiglass/NSOC candidate for the next NS team
  // slot (e.g. Day 2–6) already had MS/AS occupying those days — leaving
  // ZERO eligible candidates and producing a silent zero-NS-coverage block.
  //
  // Fix: only the (at most 3) employees continuing an NS block from last
  // month — i.e. exactly the nsCarryLock "Team 1" — are seeded now. That
  // commitment is fixed/locked and must exist before buildNSTeams() runs.
  // Everyone else's cEnd defaults to 1 (immediately eligible for NS) and
  // their MS/AS carryover continuation is placed afterward in STEP 1b, once
  // NS teams have already claimed whatever days they need — so a pending
  // MS/AS block no longer starves NS team selection of candidates.
  const cEnd={};
  rot.forEach(e=>{ cEnd[e.id]=1; });
  rot.forEach(e=>{
    const c=carry[e.id]||{shifts:0,type:'MS'};
    if(c.shifts===0||c.type!=='NS') return; // MS/AS handled in STEP 1b, below
    const rem=Math.max(0,5-Math.min(5,c.shifts)); // NS block hard-capped at 5 nights
    let d=1,placed=0;
    while(placed<rem&&d<=DAYS){
      if(tl[e.id][d]===null){tl[e.id][d]=c.type;placed++;}
      d++;
    }
    let woPlaced=0;
    while(woPlaced<2&&d<=DAYS){
      if(tl[e.id][d]===null){tl[e.id][d]='WO';woPlaced++;}
      d++;
    }
    cEnd[e.id]=d;
  });

  // ── STEP 2: Team-based NS placement ───────────────────────────────────────
  // Rules:
  //   a. NS is always a fixed 5-consecutive-night block for a team of
  //      exactly 2 Digiglass + 1 NSOC employees who all start and end together
  //   b. After 5 NS nights, those 3 employees get exactly 2 mandatory WOs
  //   c. Teams hand over by overlapping: the next team starts on the LAST
  //      night of the current team (stride=5, not 7) — zero NS coverage gaps
  //   d. Last team is anchored so its NS block ends on DAYS (month-end)
  //   e. Employee selection: least-used NS count first, then earliest available

  const nsTeamDays=new Set(); // 0-based day indices where an NS team is active
  const placedNSTeams=buildNSTeams(rot,cEnd,tl,DAYS);
  lastNSTeamsPlaced=placedNSTeams; // exposed for the roster-page confirmation panel
  placedNSTeams.forEach(team=>{
    const teamEnd = team.end || (team.start + 4);
    for(let d=team.start; d<=teamEnd; d++){
      const di=d-1;
      if(di>=0&&di<DAYS) nsTeamDays.add(di);
    }
  });

  // ── STEP 1b: Init timelines — MS/AS carryover continuation ────────────────
  // Now that NS teams have already claimed whatever tl[] days they need
  // (STEP 2, just above), place every OTHER rotating employee's carryover
  // MS/AS block + mandatory 2 WOs. This runs the same "skip pre-seeded /
  // already-occupied days" logic as before, so if an employee happened to
  // be picked for an NS team, their MS/AS continuation simply resumes on
  // the next free day afterward instead of pre-blocking the NS slot.
  rot.forEach(e=>{
    const c=carry[e.id]||{shifts:0,type:'MS'};
    if(c.shifts===0||c.type==='NS') return; // fresh-start / NS-carry already handled
    const rem=Math.max(0,6-c.shifts);
    let d=1,placed=0;
    // Fill remaining shifts of their carryover block (skip pre-seeded/NS-team days)
    while(placed<rem&&d<=DAYS){
      if(tl[e.id][d]===null){tl[e.id][d]=c.type;placed++;}
      d++;
    }
    // Mandatory 2 WOs after block completes — regardless of weekday/weekend
    let woPlaced=0;
    while(woPlaced<2&&d<=DAYS){
      if(tl[e.id][d]===null){tl[e.id][d]='WO';woPlaced++;}
      d++;
    }
    cEnd[e.id]=d;
  });

  // ── STEP 3: Fill remaining days with MS/AS blocks ─────────────────────────
  // Rules:
  //   a. Each block is 5 or 6 consecutive MS or AS shifts (interchangeable)
  //   b. After each block: exactly 2 mandatory WOs
  //   c. Alternating MS/AS between blocks per employee (phase-offset by empIdx)
  //   d. Small trailing gaps (≤2 days): use as shifts with no WOs
  //   e. WO placement prefers days where fewer employees are already on WO
  //      to avoid end-of-month pile-up

  // Pre-count concurrent WOs per day (from carryover + NS post-WOs already placed)
  const woPD=new Array(DAYS+2).fill(0);
  rot.forEach(e=>{
    for(let d=1;d<=DAYS;d++) if(tl[e.id][d]==='WO') woPD[d]++;
  });

  rot.forEach((e,ei)=>{
    // Phase offset: even-indexed start MS, odd-indexed start AS
    // This distributes MS vs AS coverage across the month
    let useMS=(ei%2===0);
    let d=1;
    while(d<=DAYS){
      if(tl[e.id][d]!==null){d++;continue;}
      // Measure contiguous free block
      let bl=0;
      for(let k=d;k<=DAYS&&tl[e.id][k]===null;k++) bl++;
      if(bl<=0){d++;continue;}

      let sc,wc;
      if(bl<=2){
        // Tiny tail — fill as shifts, no WOs (end of month)
        sc=bl; wc=0;
      } else if(bl<=7){
        // Small gap — fit shifts + WOs
        sc=Math.min(6,bl-2); wc=bl-sc;
      } else {
        // Normal block: 5 or 6 shifts then 2 WOs
        // Prefer 5+2=7 to keep WO budget manageable
        sc=5; wc=2;
      }

      const st=useMS?'MS':'AS'; useMS=!useMS;

      // For WO placement: try to find a 2-day window with fewest concurrent WOs
      // within a small lookahead, so WOs don't all land on the same days
      let ss=d;
      if(wc===2&&bl>7){
        let bestWOLoad=Infinity;
        for(let td=d;td<=Math.min(d+3,DAYS-sc-1);td++){
          const load=(woPD[td+sc]||0)+(woPD[td+sc+1]||0);
          if(load<bestWOLoad){bestWOLoad=load;ss=td;}
        }
      }

      for(let k=ss;k<ss+sc&&k<=DAYS;k++){
        if(tl[e.id][k]===null) tl[e.id][k]=st;
      }
      for(let k=ss+sc;k<ss+sc+wc&&k<=DAYS;k++){
        if(tl[e.id][k]===null){tl[e.id][k]='WO';woPD[k]++;}
      }
      d=ss+sc+wc;
    }
    // Mop up any remaining nulls
    for(let i=1;i<=DAYS;i++){
      if(tl[e.id][i]===null) tl[e.id][i]=(ei%2===0?'MS':'AS');
    }
    roster[e.id]=Array.from({length:DAYS},(_,i)=>tl[e.id][i+1]||'MS');
  });

  // -- Unified Sequence Validator --
  function isValidSequence(s) {
    let consecWork = 0;
    let consecNS = 0;
    for (let i = 0; i < s.length; i++) {
      const isWork = (s[i] === 'MS' || s[i] === 'AS' || s[i] === 'NS' || s[i] === 'GS');
      if (isWork) {
        consecWork++;
        if (consecWork > 6) return false;
      } else {
        consecWork = 0;
      }
      if (s[i] === 'NS') {
        consecNS++;
      } else {
        if (i > 0 && s[i - 1] === 'NS') {
          if (s[i] !== 'WO') return false;
          if (consecNS >= 5) {
            if (i + 1 < s.length && s[i + 1] !== 'WO') return false;
          }
        }
        consecNS = 0;
      }
    }
    return true;
  }

  function canApplyChange(s, changes) {
    const oldVals = changes.map(c => s[c.i]);
    changes.forEach(c => { s[c.i] = c.v; });
    const valid = isValidSequence(s);
    changes.forEach((c, idx) => { s[c.i] = oldVals[idx]; });
    return valid;
  }

  rot.forEach(e=>{
    const s=roster[e.id];
    let diff=s.filter(x=>x==='WO').length-WO_Q;

    if(diff>0){
      // TASK-2: never convert a locked/pre-assigned WO day back into a
      // shift to bring an over-quota employee down — only auto-placed WO
      // days are fair game here.
      const lockedDays=preWO[e.id]||new Set();
      const cands=s.map((v,i)=>i).filter(i=>s[i]==='WO'&&!lockedDays.has(i+1))
        .sort((a,b)=>{
          const woA=rot.filter(ex=>roster[ex.id]&&roster[ex.id][a]==='WO').length;
          const woB=rot.filter(ex=>roster[ex.id]&&roster[ex.id][b]==='WO').length;
          return woB-woA;
        });
      for(const i of cands){
        if(diff<=0) break;
        if(!canApplyChange(s,[{i,v:'MS'}])) continue;
        const mc=rot.reduce((a,ex)=>a+(roster[ex.id][i]==='MS'?1:0),0);
        const ac=rot.reduce((a,ex)=>a+(roster[ex.id][i]==='AS'?1:0),0);
        s[i]=mc<=ac?'MS':'AS'; diff--;
      }
    } else if(diff<0){
      const cands=s.map((v,i)=>({i,v})).filter(({i, v})=>(v==='MS'||v==='AS')&&canApplyChange(s, [{ i: i, v: 'WO' }]))
        .sort((a,b)=>{
          const woA=rot.filter(ex=>roster[ex.id]&&roster[ex.id][a.i]==='WO').length;
          const woB=rot.filter(ex=>roster[ex.id]&&roster[ex.id][b.i]==='WO').length;
          if(woA!==woB) return woA-woB;
          const ca=rot.reduce((acc,ex)=>acc+(roster[ex.id]&&roster[ex.id][a.i]===a.v?1:0),0);
          const cb=rot.reduce((acc,ex)=>acc+(roster[ex.id]&&roster[ex.id][b.i]===b.v?1:0),0);
          return cb-ca;
        });
      for(const{i,v}of cands){
        if(diff>=0) break;
        const on=rot.filter(ex=>roster[ex.id][i]===v);
        const da=on.filter(ex=>ex.dept==='Digiglass').length-(e.dept==='Digiglass'?1:0);
        const na=on.filter(ex=>ex.dept==='NSOC').length-(e.dept==='NSOC'?1:0);
        if(da>=2&&na>=1){s[i]='WO';diff++;}
      }
    }
  });

  // STEP 3.5: Post-fill consecutive-sequence repair
  rot.forEach(e=>{
    const s=roster[e.id];
    for(let attempt=0;attempt<10;attempt++){
      let fixed=false;
      let consecWork=0, runStart=0;
      for(let i=0;i<=DAYS;i++){
        const isWork=i<DAYS&&['MS','AS','NS','GS'].includes(s[i]);
        if(isWork){if(!consecWork)runStart=i;consecWork++;}
        else{
          if(consecWork>6){
            let insertAt=-1;
            const mid=runStart+Math.floor(consecWork/2);
            for(let delta=0;delta<=consecWork&&insertAt===-1;delta++){
              for(const cand of[mid-delta,mid+delta]){
                if(cand<runStart||cand>=runStart+consecWork) continue;
                if(s[cand]==='NS') continue;
                if(cand>0&&s[cand-1]==='NS') continue;
                insertAt=cand; break;
              }
            }
            if(insertAt!==-1){s[insertAt]='WO';fixed=true;}
          }
          consecWork=0;
        }
      }
      if(!fixed) break;
    }
    roster[e.id]=s;
  });

  // STEP 4: Hard WO budget enforcement
  function gc(di){
    const r={MS:{D:0,N:0},AS:{D:0,N:0},NS:{D:0,N:0}};
    rot.forEach(e=>{const s=roster[e.id][di];if(r[s])r[s][e.dept==='NSOC'?'N':'D']++;});
    return r;
  }

  // STEP 5: Multi-pass rebalancing — skip NS on non-team days
  for(let pass=0;pass<5;pass++){
    let chg=false;
    for(let di=0;di<DAYS;di++){
      for(const tgt of['NS','MS','AS']){
        // NS only rebalanced on days where an NS team is scheduled
        if(tgt==='NS'&&!nsTeamDays.has(di)) continue;
        let ct=gc(di);
        if(ct[tgt].D>=2&&ct[tgt].N>=1) continue;
        for(const e of rot){
          const cur=roster[e.id][di];
          if(cur===tgt||cur==='NS') continue;
          const dk=e.dept==='NSOC'?'N':'D';
          const nd=ct[tgt].D<2, nn=ct[tgt].N<1;
          if(!(nd&&dk==='D')&&!(nn&&dk==='N')) continue;
          let mv=false;
          if(cur==='WO'){
            if(roster[e.id].filter(x=>x==='WO').length>WO_Q&&canApplyChange(roster[e.id], [{ i: di, v: tgt }])) mv=true;
          } else if(cur==='MS'||cur==='AS'){
            const sr=gc(di);
            const da=sr[cur].D-(dk==='D'?1:0);
            const na=sr[cur].N-(dk==='N'?1:0);
            if(da>=2&&na>=1&&canApplyChange(roster[e.id], [{ i: di, v: tgt }])) mv=true;
          }
          if(mv){
            roster[e.id][di]=tgt; chg=true;
            ct=gc(di);
            if(ct[tgt].D>=2&&ct[tgt].N>=1) break;
          }
        }
      }
    }
    if(!chg) break;
  }

  // STEP 6: Cross-day WO swap — skip NS on non-team days
  for(let pass=0;pass<5;pass++){
    let chg=false;
    for(let di=0;di<DAYS;di++){
      for(const tgt of['MS','AS','NS']){
        // NS only swapped on days where an NS team is scheduled
        if(tgt==='NS'&&!nsTeamDays.has(di)) continue;
        const ct=gc(di);
        if(ct[tgt].D>=2&&ct[tgt].N>=1) continue;
        for(const e of rot){
          if(roster[e.id][di]!=='WO') continue;
          const dk=e.dept==='NSOC'?'N':'D';
          if(!(ct[tgt].D<2&&dk==='D')&&!(ct[tgt].N<1&&dk==='N')) continue;
          let sDay=-1;
          for(let od=0;od<DAYS;od++){
            if(od===di) continue;
            const curO=roster[e.id][od];
            if(curO!=='MS'&&curO!=='AS') continue;
            const sr=gc(od);
            const dA=sr[curO].D-(dk==='D'?1:0);
            const nA=sr[curO].N-(dk==='N'?1:0);
            if(dA>=2&&nA>=1){
              if(canApplyChange(roster[e.id], [{ i: di, v: tgt }, { i: od, v: 'WO' }])){ sDay=od; break; }
            }
          }
          if(sDay!==-1){
            roster[e.id][di]=tgt; roster[e.id][sDay]='WO'; chg=true; break;
          }
        }
      }
    }
    if(!chg) break;
  }

  // STEP 7: 3-way NS mutation — only on NS team days
  for(let pass=0;pass<5;pass++){
    let chg=false;
    for(let di=0;di<DAYS;di++){
      // Only attempt NS mutation on days where a team is expected
      if(!nsTeamDays.has(di)) continue;
      const ct=gc(di);
      if(ct['NS'].D>=2&&ct['NS'].N>=1) continue;
      for(const e of rot){
        const cur=roster[e.id][di];
        if(cur==='NS'||cur==='WO') continue;
        if(di+1>=DAYS) continue;
        const dk=e.dept==='NSOC'?'N':'D';
        const needD=ct['NS'].D<2, needN=ct['NS'].N<1;
        if(!(needD&&dk==='D')&&!(needN&&dk==='N')) continue;
        const nextShift=roster[e.id][di+1];
        if(nextShift!=='MS'&&nextShift!=='AS') continue;
        const srcCt=gc(di);
        if(srcCt[cur].D-(dk==='D'?1:0)<2||srcCt[cur].N-(dk==='N'?1:0)<1) continue;
        const nxCt=gc(di+1);
        if(nxCt[nextShift].D-(dk==='D'?1:0)<2||nxCt[nextShift].N-(dk==='N'?1:0)<1) continue;
        let reclaim=-1;
        for(let fd=di+2;fd<DAYS;fd++){
          if(roster[e.id][fd]!=='WO') continue;
          const prev=fd>0?roster[e.id][fd-1]:'';
          if(prev==='NS') continue;
          const twoPrev=fd>1?roster[e.id][fd-2]:'';
          if(twoPrev==='NS'&&prev==='WO') continue;
          const rclShift=(roster[e.id][fd-1]==='MS'||(fd+1<DAYS&&roster[e.id][fd+1]==='MS'))?'MS':'AS';
          const testSeq=roster[e.id].slice();
          testSeq[di]='NS'; testSeq[di+1]='WO'; testSeq[fd]=rclShift;
          if(isValidSequence(testSeq)){reclaim=fd;break;}
        }
        if(reclaim===-1) continue;
        const rclShift=(roster[e.id][reclaim-1]==='MS'||(reclaim+1<DAYS&&roster[e.id][reclaim+1]==='MS'))?'MS':'AS';
        roster[e.id][di]='NS';
        roster[e.id][di+1]='WO';
        roster[e.id][reclaim]=rclShift;
        chg=true;
        break;
      }
    }
    if(!chg) break;
  }

  // ── STEP 8: Final Hard WO Quota Reconciliation ──────────────────────────
  // Steps 1-7 usually land every rotating employee on exactly WO_Q week-offs,
  // but tightly-constrained edge cases (heavy NS scheduling, pre-seeded leave
  // days, sequence limits) can leave a handful of employees short or over —
  // this was the root cause of the Aug-2026 export shorting Supratim Lekry,
  // Mehul Bhattacharya and Abirlal Bera by 1 WO each. This pass makes the
  // WO_Q match an absolute guarantee: it retries with progressively relaxed
  // constraints (first respecting both the "no >6 consecutive work days"
  // rule and the 2-Digi/1-NSOC staffing minimum, then relaxing the run-length
  // preference, then finally the staffing minimum) instead of silently
  // leaving someone off-quota.
  rot.forEach(e=>{
    const s=roster[e.id];
    let diff=s.filter(x=>x==='WO').length-WO_Q;
    if(diff===0) return;

    // TASK-2: locked/pre-assigned WO days are never candidates for
    // conversion back to a shift, at any relaxation level — the whole
    // point of locking them is that they stay WO no matter what.
    const lockedDays=preWO[e.id]||new Set();

    const tryConvertToWork=(relaxSeq)=>{
      const cands=s.map((v,i)=>i).filter(i=>s[i]==='WO'&&!lockedDays.has(i+1))
        .sort((a,b)=>{
          const woA=rot.filter(ex=>roster[ex.id]&&roster[ex.id][a]==='WO').length;
          const woB=rot.filter(ex=>roster[ex.id]&&roster[ex.id][b]==='WO').length;
          return woB-woA;
        });
      for(const i of cands){
        if(!relaxSeq && !canApplyChange(s,[{i,v:'MS'}])) continue;
        const mc=rot.reduce((a,ex)=>a+(roster[ex.id][i]==='MS'?1:0),0);
        const ac=rot.reduce((a,ex)=>a+(roster[ex.id][i]==='AS'?1:0),0);
        s[i]=mc<=ac?'MS':'AS';
        return true;
      }
      return false;
    };

    const tryConvertToWO=(relaxStaff)=>{
      const cands=s.map((v,i)=>({i,v})).filter(({v})=>v==='MS'||v==='AS')
        .sort((a,b)=>{
          const woA=rot.filter(ex=>roster[ex.id]&&roster[ex.id][a.i]==='WO').length;
          const woB=rot.filter(ex=>roster[ex.id]&&roster[ex.id][b.i]==='WO').length;
          return woA-woB;
        });
      for(const{i,v}of cands){
        if(!canApplyChange(s,[{i,v:'WO'}])) continue;
        if(!relaxStaff){
          const on=rot.filter(ex=>roster[ex.id][i]===v);
          const da=on.filter(ex=>ex.dept==='Digiglass').length-(e.dept==='Digiglass'?1:0);
          const na=on.filter(ex=>ex.dept==='NSOC').length-(e.dept==='NSOC'?1:0);
          if(!(da>=2&&na>=1)) continue;
        }
        s[i]='WO';
        return true;
      }
      return false;
    };

    let guard=0;
    while(diff>0&&guard<60){
      guard++;
      if(tryConvertToWork(false)){diff--;continue;}
      if(tryConvertToWork(true)){diff--;continue;}
      break; // truly no day left to convert (shouldn't happen in practice)
    }
    guard=0;
    while(diff<0&&guard<60){
      guard++;
      if(tryConvertToWO(false)){diff++;continue;}
      if(tryConvertToWO(true)){diff++;continue;}
      break;
    }
    roster[e.id]=s;
  });

  renderGrid();renderSum();showPage('roster');
  if(gAuthToken){const pb=document.getElementById('btnPush');if(pb)pb.disabled=false;}
  const sgt=document.getElementById('sysGenTxt'), sgd=document.getElementById('sysDotGen');
  if(sgt) sgt.textContent='GEN: v16';
  if(sgd) sgd.className='dot ok';
}

// ═══════════════════════════════════════════════════════════════
// TEAM-BASED NS BLOCK PLACEMENT  v8
//
// KEY RULES:
//   1. Each NS team = exactly 2 Digiglass + 1 NSOC rotating employees
//   2. All 3 team members share the same NS start and end day
//   3. After a FULL 5-night block: exactly 2 mandatory WOs for all 3
//      members. A block truncated by month-end does NOT get the 2 WOs
//      here — those nights + WOs continue into next month instead
//      (see nsCarryLock / "Confirm NS Carryover & Lock Team 1").
//   4. STRICTLY NON-OVERLAPPING, NO-GAP blocks: teams run back-to-back,
//      stride = 5 nights, starting immediately where the previous team's
//      block ends. There is never a day with zero NS teams on duty, and
//      never a day with more than one NS team on duty.
//   5. If this month opens with an NS carryover (nsCarryLock set), Team 1
//      is exactly that continuing team — its remaining nights were
//      already placed by the per-employee carryover step (STEP 1) before
//      buildNSTeams() ever runs, so it is NOT re-selected or re-placed
//      here. Team 2 onward starts the stride from nsCarryLock.finishDay.
//   6. The LAST team of the month may end up with fewer than 5 nights if
//      the month doesn't divide evenly — that's expected, not a bug; use
//      "Confirm NS Carryover & Lock Team 1" next month to continue it.
//   7. Employee selection (Digiglass slots):
//      Senior employees (NS_SENIOR_NAMES) before newer ones → fewest
//      prior NS blocks → earliest available → stable id order.
//   8. Hard NS_MAX cap: no employee gets more than 2 NS blocks per month.
// ═══════════════════════════════════════════════════════════════
function buildNSTeams(rot, cEnd, tl, DAYS) {
  const digiR = rot.filter(e => e.dept === 'Digiglass');
  const nsocR = rot.filter(e => e.dept === 'NSOC');
  if (digiR.length < 2 || nsocR.length < 1) return [];

  // ── NS block counter (month + carryover) ───────────────────────────────
  const NS_MAX = 2;
  const nsCnt = {};
  rot.forEach(e => { nsCnt[e.id] = 0; });
  (_nsCarryTeams || []).forEach(team => {
    team.members.forEach(id => { if (nsCnt[id] !== undefined) nsCnt[id]++; });
  });

  // ── Seniority check (case-insensitive substring) ───────────────────────
  const isSenior = e => NS_SENIOR_NAMES.some(n => e.name.toLowerCase().includes(n));

  // ── Availability check for a given slot {start,end} ─────────────────────
  // strict=true  → also requires cEnd satisfied (primary selection)
  // strict=false → only requires the slot's own days to be free (fallback)
  const isFreeForNS = (e, slot, strict = true) => {
    if (nsCnt[e.id] >= NS_MAX) return false;
    if (strict && (cEnd[e.id] || 1) > slot.start) return false;
    for (let k = slot.start; k <= slot.end; k++) {
      if (tl[e.id][k] !== null) return false;
    }
    return true;
  };

  // ── Sort comparator ────────────────────────────────────────────────────
  // Senior employees → fewest NS blocks → earliest cEnd → stable id
  const sortFn = (a, b) => {
    const sa = isSenior(a) ? 0 : 1, sb = isSenior(b) ? 0 : 1;
    return sa - sb ||
      nsCnt[a.id] - nsCnt[b.id] ||
      (cEnd[a.id] || 1) - (cEnd[b.id] || 1) ||
      a.id - b.id;
  };

  // Shared with the NS Teams tab so the manual-assignment UI and the
  // engine always agree on how many team slots exist and where each
  // starts — including the locked carryover Team 1, if any.
  const slots = getNSSlots(DAYS);

  const placedTeams = [];

  for (let ti = 0; ti < slots.length; ti++) {
    const slot = slots[ti];

    // ── Locked carryover Team 1 ─────────────────────────────────────────
    // Its remaining NS nights (+ mandatory WOs, if the block completes
    // this month) were already placed per-employee by the carryover step
    // before buildNSTeams() ran. Just record it for the confirmation
    // panel and reserve one NS-block slot against NS_MAX — do not touch
    // tl[] or re-select members, and do not let any other team be placed
    // on these same nights.
    if (slot.locked) {
      const team = [
        digiR.find(e => e.id === nsCarryLock.digi[0]),
        digiR.find(e => e.id === nsCarryLock.digi[1]),
        nsocR.find(e => e.id === nsCarryLock.nsoc),
      ].filter(Boolean);
      team.forEach(e => { nsCnt[e.id]++; });
      placedTeams.push({ members: team.map(e => e.id), start: slot.start, end: slot.end, manual: true, locked: true });
      continue;
    }

    const startDay = slot.start;

    // ── Manual NS Teams tab override ────────────────────────────────────
    // If the user explicitly assigned all 3 roles (2 Digiglass + 1 NSOC)
    // for this slot on the "NS Teams" tab, honor that pairing directly and
    // skip auto-selection below entirely. Falls through to auto-selection
    // if the manual pick is missing/incomplete, or if the chosen employees
    // are no longer actually free for this slot (e.g. a leave day now
    // blocks them) — a manual assignment overrides only where it's usable.
    const manual = manualNSTeams[ti];
    if (manual && manual.digi && manual.digi.length === 2 && manual.nsoc) {
      const mDigi = manual.digi.map(id => digiR.find(e => e.id === id)).filter(Boolean);
      const mNsoc = nsocR.find(e => e.id === manual.nsoc);
      const allFree = mDigi.length === 2 && mNsoc &&
        isFreeForNS(mDigi[0], slot, false) &&
        isFreeForNS(mDigi[1], slot, false) &&
        isFreeForNS(mNsoc, slot, false);
      if (allFree) {
        placeNSTeam([mDigi[0], mDigi[1], mNsoc], slot, DAYS, tl, cEnd, nsCnt);
        placedTeams.push({ members: [mDigi[0], mDigi[1], mNsoc].map(e => e.id), start: startDay, end: slot.end, manual: true });
        continue; // slot fully handled — skip auto-selection for this team
      }
      // manual pick unusable this month (conflict) — fall through to auto-fill
    }

    // ── Digiglass selection (pure seniority / fewest-NS-blocks order) ──
    let freeDigi = digiR
      .filter(e => isFreeForNS(e, slot, true))
      .sort(sortFn);

    let chosenDigi = [];
    for (const e of freeDigi) {
      if (chosenDigi.length >= 2) break;
      chosenDigi.push(e);
    }

    // Fallback: relax cEnd if still short
    if (chosenDigi.length < 2) {
      const fallbackDigi = digiR
        .filter(e => !new Set(chosenDigi.map(x=>x.id)).has(e.id)
          && isFreeForNS(e, slot, false))
        .sort(sortFn);
      for (const e of fallbackDigi) {
        if (chosenDigi.length >= 2) break;
        chosenDigi.push(e);
      }
    }

    // ── NSOC selection ─────────────────────────────────────────────────
    let chosenNsoc = nsocR.filter(e => isFreeForNS(e, slot, true)).sort(sortFn);
    if (chosenNsoc.length < 1) {
      chosenNsoc = nsocR.filter(e => isFreeForNS(e, slot, false)).sort(sortFn);
    }

    if (chosenDigi.length < 2 || chosenNsoc.length < 1) continue; // skip if can't staff

    const team = [chosenDigi[0], chosenDigi[1], chosenNsoc[0]];
    placeNSTeam(team, slot, DAYS, tl, cEnd, nsCnt);
    placedTeams.push({ members: team.map(e => e.id), start: startDay, end: slot.end });
  }

  return placedTeams;
}

// ── Place one NS team's nights (+ mandatory WOs if the block is a full
// 5 nights) atomically. A slot shorter than 5 nights (only possible as
// the very last slot of the month) does NOT get the mandatory WOs here —
// those nights/WOs continue into next month via the carryover-lock flow.
function placeNSTeam(team, slot, DAYS, tl, cEnd, nsCnt) {
  const blockLen = slot.end - slot.start + 1;
  team.forEach(e => {
    for (let k = slot.start; k <= slot.end; k++) tl[e.id][k] = 'NS';
    if (blockLen >= 5) {
      for (let k = slot.end + 1; k <= Math.min(slot.end + 2, DAYS); k++) {
        if (tl[e.id][k] === null) tl[e.id][k] = 'WO';
      }
      if ((cEnd[e.id] || 1) < slot.end + 3) cEnd[e.id] = slot.end + 3;
    } else {
      if ((cEnd[e.id] || 1) < slot.end + 1) cEnd[e.id] = slot.end + 1;
    }
    nsCnt[e.id]++;
  });
}

// ═══════════════════════════════════════════════════════════════
// ROSTER GRID
// ═══════════════════════════════════════════════════════════════
function renderGrid(){
  const{days:DAYS,month:M,year:Y,woQ:WO_Q}=cfg;
  const tbl=document.getElementById('rTbl');tbl.innerHTML='';
  document.getElementById('rTitle').textContent=`Roster — ${MN[M]} ${Y}`;

  const thead=document.createElement('thead');
  let h=`<tr><th class="sc">#</th><th class="nc">Employee</th>`;
  for(let d=1;d<=DAYS;d++){
    const we=isWE(d);
    h+=`<th class="${we?'we':''}" style="${we?'color:#7c3aed':''}">
      <div class="dh">${dn(d)}</div><div class="dn">${d}</div></th>`;
  }
  h+=`<th class="xc">MS</th><th class="xc">AS</th><th class="xc">NS</th>
      <th class="xc">GS</th><th class="xc">WO</th><th class="xc">Shifts</th>
      <th class="xc" style="min-width:68px">₹ Total</th></tr>`;
  thead.innerHTML=h;tbl.appendChild(thead);

  const tbody=document.createElement('tbody');
  const filtered=filt==='ALL'?emps:emps.filter(e=>e.type===filt);

  filtered.forEach((e,idx)=>{
    const s=roster[e.id]||new Array(DAYS).fill('');
    const tr=document.createElement('tr');
    let row=`<td class="sc">${idx+1}</td>`;
    row+=`<td class="nc"><span style="font-weight:500">${e.name}</span>
      <span class="${e.dept==='NSOC'?'b-nsoc':'b-digi'}" style="margin-left:5px;font-size:9px">${e.dept}</span></td>`;

    for(let d=0;d<DAYS;d++){
      const sv=s[d]||'';
      const cls=SC_MAP[sv]||'s-empty';
      const dayN=d+1;
      const warnCls=shiftNeedsWarn(sv,dayN)?' s-WARN':'';
      row+=`<td class="${isWE(dayN)?'we':''}">
        <div class="shc ${cls}${warnCls}" onclick="openDD(event,${e.id},${d})"
          title="${sv||'—'} — ${MN[M]} ${dayN}">${sv||'—'}</div></td>`;
    }

    const ms=s.filter(x=>x==='MS').length;
    const as=s.filter(x=>x==='AS').length;
    const ns=s.filter(x=>x==='NS').length;
    const gs=s.filter(x=>x==='GS').length;
    const wo=s.filter(x=>x==='WO').length;
    const tot=ms+as+ns+gs;
    const amt=ms*150+as*150+ns*250;
    const woOk=e.type==='Rotating'?wo===WO_Q:true;
    row+=`<td class="xc" style="color:var(--ms-t)">${ms}</td>`;
    row+=`<td class="xc" style="color:var(--as-t)">${as}</td>`;
    row+=`<td class="xc" style="color:var(--ns-t)">${ns}</td>`;
    row+=`<td class="xc" style="color:var(--gs-t)">${gs}</td>`;
    row+=`<td class="xc" style="color:${woOk?'var(--wo-t)':'var(--warn-t)'}" title="${e.type==='Rotating'?'WO: '+wo+'/'+WO_Q:''}">${wo}${e.type==='Rotating'?'/'+WO_Q:''}</td>`;
    row+=`<td class="xc" style="color:var(--text2)">${tot}</td>`;
    row+=`<td class="xc" style="color:#15803d;font-size:10px">₹${amt.toLocaleString()}</td>`;
    tr.innerHTML=row;tbody.appendChild(tr);
  });

  const sep=document.createElement('tr');sep.className='sep-r';
  sep.innerHTML=`<td colspan="${DAYS+9}"></td>`;tbody.appendChild(sep);

  [{code:'MS',lbl:'Total MS',cls:'t-MS'},{code:'AS',lbl:'Total AS',cls:'t-AS'},
   {code:'NS',lbl:'Total NS',cls:'t-NS'},{code:'GS',lbl:'Total GS',cls:'t-GS'}
  ].forEach(({code,lbl,cls})=>{
    const tr=document.createElement('tr');tr.className='trow';
    let row=`<td></td><td class="nc" style="color:var(--text2);font-size:10px;letter-spacing:.3px">${lbl}</td>`;
    for(let d=1;d<=DAYS;d++){
      const cnt=emps.reduce((a,e)=>a+((roster[e.id]||[])[d-1]===code?1:0),0);
      const bad=code!=='GS'&&shiftNeedsWarn(code,d);
      row+=`<td class="${bad?'sep-r':''}" style="${bad?'background:rgba(239,68,68,.15)':''}">
        <span class="${cls}" style="font-size:10px${bad?';color:#dc2626':''}">${cnt}</span></td>`;
    }
    row+=`<td colspan="7"></td>`;
    tr.innerHTML=row;tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  renderNSTeamsPanel();renderWarn();renderStats();
}

function shiftNeedsWarn(shift,day){
  if(!['MS','AS','NS'].includes(shift)) return false;
  const on=emps.filter(e=>(roster[e.id]||[])[day-1]===shift);
  // Zero coverage is the MOST severe case — always flag it, never
  // silently pass it through just because there's no one to compare against.
  if(!on.length) return true;
  return on.filter(e=>e.dept==='Digiglass').length<2||on.filter(e=>e.dept==='NSOC').length<1;
}

// Confirmation panel — shows exactly which employees ended up on each NS
// team block this generation, and whether that team came from your manual
// NS Teams tab pick or from auto-selection. This exists so a manual pick
// that happens to match what auto would've chosen anyway (e.g. picking the
// same Swagat+Priya pairing) doesn't look like "nothing changed" — you can
// see directly here that it WAS honored, it just landed on the same trio.
function renderNSTeamsPanel(){
  const p=document.getElementById('nsTeamsPanel');
  if(!p) return;
  if(!lastNSTeamsPlaced||!lastNSTeamsPlaced.length){ p.innerHTML=''; return; }
  const rows=lastNSTeamsPlaced.map((t,i)=>{
    const names=t.members.map(id=>{
      const e=emps.find(ex=>ex.id===id);
      return e?e.name:'?';
    }).join(', ');
    const end=t.end!=null?t.end:Math.min(t.start+4,cfg.days);
    const tag=t.locked
      ?'<span style="color:var(--ok-t);font-weight:700">LOCKED (carryover)</span>'
      :t.manual
      ?'<span style="color:var(--ok-t);font-weight:700">MANUAL</span>'
      :'<span style="color:var(--text3)">auto</span>';
    return `<div class="warn-item" style="color:var(--text2)">Team ${i+1} (Day ${t.start}–${end}): ${names} — ${tag}</div>`;
  }).join('');
  p.innerHTML=`<div class="info-panel">
    <div style="font-weight:700;color:#6d28d7;margin-bottom:4px">🌙 NS Team Composition (this generation)</div>
    ${rows}
  </div>`;
}

function renderWarn(){
  const{days:DAYS}=cfg;const warns=[];const zeroWarns=[];

  // ── Staffing checks: zero-coverage (severe) vs. understaffed ────────────
  for(let d=1;d<=DAYS;d++){
    ['MS','AS','NS'].forEach(sh=>{
      const on=emps.filter(e=>(roster[e.id]||[])[d-1]===sh);
      if(!on.length){
        zeroWarns.push(`Day ${String(d).padStart(2,'0')} ${dn(d)} — ${sh}: NO ONE assigned (0 employees)`);
        return;
      }
      const dg=on.filter(e=>e.dept==='Digiglass').length;
      const nc=on.filter(e=>e.dept==='NSOC').length;
      if(dg<2) warns.push(`Day ${String(d).padStart(2,'0')} ${dn(d)} — ${sh}: ${dg} Digiglass (need ≥2)`);
      if(nc<1) warns.push(`Day ${String(d).padStart(2,'0')} ${dn(d)} — ${sh}: 0 NSOC (need ≥1)`);
    });
  }

  // ── >6 consecutive shift check (TASK-3) ──────────────────────────────────
  // Step 3.5 tries to repair any run this long during generation, but a
  // constrained month (heavy locked leave/WO, tight NS scheduling) can
  // still leave a run unresolved after its retry budget — surface it here
  // rather than let it pass silently.
  const consecWarns=[];
  emps.forEach(e=>{
    const s=roster[e.id];if(!s)return;
    let run=0,runStart=0;
    for(let d=0;d<=DAYS;d++){
      const isWork=d<DAYS&&['MS','AS','NS','GS'].includes(s[d]);
      if(isWork){if(!run)runStart=d+1;run++;}
      else{
        if(run>6) consecWarns.push(`${e.name} — ${run} consecutive shifts (Day ${runStart}–${runStart+run-1}), exceeds max of 6`);
        run=0;
      }
    }
  });

  const p=document.getElementById('warnPanel');
  const totalIssues=zeroWarns.length+warns.length+consecWarns.length;

  const swt=document.getElementById('sysWarnTxt'), swd=document.getElementById('sysDotWarn');
  if(swt) swt.textContent=`WARN: ${totalIssues}`;
  if(swd) swd.className='dot'+(totalIssues?' warn':' ok');

  if(!totalIssues){
    p.innerHTML='<div class="ok-panel">All shifts meet minimum staffing (2 Digiglass + 1 NSOC per shift) and no employee exceeds 6 consecutive shifts</div>';
    return;
  }

  const nsocCount=emps.filter(e=>e.type==='Rotating'&&e.dept==='NSOC').length;
  const note=nsocCount<4
    ?`<div class="info-panel" style="margin-top:8px">ℹ ${nsocCount} NSOC rotating employees cannot cover all 3 shifts every day. Use manual override (click any red cell) for critical days.</div>`:'';

  let html='';
  if(zeroWarns.length){
    html+=`<div class="warn-panel" style="border-color:#fecaca;background:#fef2f2">
      <div class="warn-title">🔴 ${zeroWarns.length} ZERO-COVERAGE shift${zeroWarns.length>1?'s':''} — no rotating employee assigned at all</div>
      ${zeroWarns.slice(0,35).map(w=>`<div class="warn-item">${w}</div>`).join('')}
      ${zeroWarns.length>35?`<div class="warn-item" style="color:var(--text3)">…and ${zeroWarns.length-35} more</div>`:''}
    </div>`;
  }
  if(consecWarns.length){
    html+=`<div class="warn-panel">
      <div class="warn-title">⚠ ${consecWarns.length} consecutive-shift violation${consecWarns.length>1?'s':''} (&gt;6 in a row)</div>
      ${consecWarns.map(w=>`<div class="warn-item">${w}</div>`).join('')}
    </div>`;
  }
  if(warns.length){
    html+=`<div class="warn-panel">
      <div class="warn-title">⚠ ${warns.length} staffing warning${warns.length>1?'s':''} — click any 🔴 cell to override</div>
      ${warns.slice(0,35).map(w=>`<div class="warn-item">${w}</div>`).join('')}
      ${warns.length>35?`<div class="warn-item" style="color:var(--text3)">…and ${warns.length-35} more</div>`:''}
    </div>`;
  }
  p.innerHTML=html+note;
}

function renderStats(){
  const{days:DAYS}=cfg;
  document.getElementById('statsRow').innerHTML=
    [{k:'MS',l:'Morning',c:'var(--ms-t)'},{k:'AS',l:'Afternoon',c:'var(--as-t)'},
     {k:'NS',l:'Night',c:'var(--ns-t)'},{k:'GS',l:'General',c:'var(--gs-t)'}]
    .map(t=>{
      let tot=0;
      for(let d=1;d<=DAYS;d++) tot+=emps.filter(e=>(roster[e.id]||[])[d-1]===t.k).length;
      return`<div class="stat" style="--stat-color:${t.c}"><div class="sv" style="color:${t.c}">${tot}</div>
        <div class="sl">${t.l} Shifts (month total)</div></div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════════
// DROPDOWN
// ═══════════════════════════════════════════════════════════════
function openDD(ev,empId,dayIdx){
  ev.stopPropagation();
  const r=ev.target.getBoundingClientRect();
  const dd=document.getElementById('ddMenu');
  dd.innerHTML=ALL_CODES.map(c=>`
    <div class="ddi shc ${SC_MAP[c]||'s-empty'}" onclick="setS(${empId},${dayIdx},'${c}')">${c||'—'}</div>`).join('');
  dd.style.top=Math.min(r.bottom+4,window.innerHeight-220)+'px';
  dd.style.left=Math.min(r.left,window.innerWidth-205)+'px';
  dd.classList.add('open');
  document.getElementById('ddOver').classList.add('open');
}
function closeDD(){
  document.getElementById('ddMenu').classList.remove('open');
  document.getElementById('ddOver').classList.remove('open');
}
function setS(id,di,sh){
  if(!roster[id]) roster[id]=new Array(cfg.days).fill('');
  roster[id][di]=sh;
  closeDD();renderGrid();renderSum();
}
function setFilter(el,f){
  filt=f;
  document.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');renderGrid();
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY PAGE
// ═══════════════════════════════════════════════════════════════
function renderSum(){
  const tb=document.getElementById('sumTb');
  const ft=document.getElementById('sumFt');
  tb.innerHTML='';ft.innerHTML='';
  let T={ms:0,as:0,ns:0,gs:0,wo:0,sl:0,cl:0,co:0,tot:0,mA:0,aA:0,nA:0,amt:0};

  emps.forEach((e,i)=>{
    const s=roster[e.id]||[];
    const ms=s.filter(x=>x==='MS'||x==='WFH-MS').length;
    const as=s.filter(x=>x==='AS'||x==='WFH-AS').length;
    const ns=s.filter(x=>x==='NS'||x==='WFH-NS').length;
    const gs=s.filter(x=>x==='GS'||x==='WFH').length;
    const wo=s.filter(x=>x==='WO').length;
    const sl=s.filter(x=>x==='SL').length;
    const cl=s.filter(x=>x==='CL').length;
    const co=s.filter(x=>x==='CO').length;
    const tot=ms+as+ns+gs;
    const mA=ms*150,aA=as*150,nA=ns*250,amt=mA+aA+nA;
    T.ms+=ms;T.as+=as;T.ns+=ns;T.gs+=gs;T.wo+=wo;
    T.sl+=sl;T.cl+=cl;T.co+=co;T.tot+=tot;T.mA+=mA;T.aA+=aA;T.nA+=nA;T.amt+=amt;
    const woOk=e.type==='Rotating'?wo===cfg.woQ:true;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="color:var(--text3);font-family:'JetBrains Mono',monospace">${i+1}</td>
      <td style="font-weight:500">${e.name}</td>
      <td><span class="${e.dept==='NSOC'?'b-nsoc':'b-digi'}">${e.dept}</span></td>
      <td class="mono" style="color:var(--ms-t)">${ms}</td>
      <td class="mono" style="color:var(--as-t)">${as}</td>
      <td class="mono" style="color:var(--ns-t)">${ns}</td>
      <td class="mono" style="color:var(--gs-t)">${gs}</td>
      <td class="mono" style="color:var(--text)">${tot}</td>
      <td class="mono" style="color:${woOk?'var(--text2)':'var(--warn-t)'};font-weight:${woOk?600:700}">${wo}${e.type==='Rotating'?' /'+cfg.woQ:''}</td>
      <td class="mono" style="color:var(--text2)">${sl}</td>
      <td class="mono" style="color:var(--text2)">${cl}</td>
      <td class="mono" style="color:var(--text2)">${co}</td>
      <td class="amt">₹${mA.toLocaleString()}</td>
      <td class="amt">₹${aA.toLocaleString()}</td>
      <td class="amt">₹${nA.toLocaleString()}</td>
      <td class="amt" style="font-size:13px">₹${amt.toLocaleString()}</td>`;
    tb.appendChild(tr);
  });

  const ftr=document.createElement('tr');ftr.className='tot';
  ftr.innerHTML=`
    <td colspan="3" style="font-weight:700;color:var(--text2);font-size:11px;padding:8px 10px;letter-spacing:.5px">TOTAL</td>
    <td class="mono" style="color:var(--ms-t)">${T.ms}</td>
    <td class="mono" style="color:var(--as-t)">${T.as}</td>
    <td class="mono" style="color:var(--ns-t)">${T.ns}</td>
    <td class="mono" style="color:var(--gs-t)">${T.gs}</td>
    <td class="mono">${T.tot}</td><td class="mono">${T.wo}</td>
    <td class="mono">${T.sl}</td><td class="mono">${T.cl}</td><td class="mono">${T.co}</td>
    <td class="amt">₹${T.mA.toLocaleString()}</td>
    <td class="amt">₹${T.aA.toLocaleString()}</td>
    <td class="amt">₹${T.nA.toLocaleString()}</td>
    <td class="amt" style="font-size:14px">₹${T.amt.toLocaleString()}</td>`;
  ft.appendChild(ftr);
}

// ═══════════════════════════════════════════════════════════════
// EXCEL EXPORT  — reliable SheetJS AOA path (free CDN compatible)
// ═══════════════════════════════════════════════════════════════

const SHIFT_CLR={
  'MS':    ['C6EFCE','276221'], 'AS':    ['FFEB9C','9C6500'],
  'NS':    ['BDD7EE','1F4E79'], 'GS':    ['E2EFDA','375623'],
  'WO':    ['D9D9D9','595959'], 'CO':    ['FFD7A8','843C0C'],
  'SL':    ['FCE4D6','833300'], 'CL':    ['FCE4D6','833300'],
  'VL':    ['FCE4D6','833300'], 'HL':    ['FCE4D6','833300'],
  'GH':    ['FFFFCC','7B6000'], 'EX':    ['EAD1DC','4A235A'],
  'RH':    ['D5E8D4','2D6B30'], 'WFH':   ['E1D5E7','5B2C6F'],
  'WFH-MS':['C6EFCE','276221'], 'WFH-AS':['FFEB9C','9C6500'],
  'WFH-NS':['BDD7EE','1F4E79'],
};

function doExport(){
  const XLWB=XLSX.utils.book_new();
  const{days:DAYS,month:M,year:Y,woQ:WO_Q}=cfg;

  const DC=2, SC=DC+DAYS;
  const C_MS=SC,C_GS=SC+1,C_AS=SC+2,C_NS=SC+3;
  const C_AMS=SC+4,C_AAS=SC+5,C_ANS=SC+6,C_TOT=SC+7;
  const C_GH=SC+8,C_WO=SC+9,C_EX=SC+10,C_WFH=SC+11;
  const C_CO=SC+12,C_RH=SC+13,C_HL=SC+14,C_SL=SC+15;
  const C_CL=SC+16,C_VL=SC+17, LAST=C_VL;

  function colL(i){return XLSX.utils.encode_col(i);}
  function ref(r1,c0){return XLSX.utils.encode_cell({r:r1-1,c:c0});}

  const startD=new Date(Y,M,1), endD=new Date(Y,M,DAYS);
  const fmtD=d=>`${String(d.getDate()).padStart(2,'0')}-${MN[d.getMonth()].slice(0,3)}-${d.getFullYear()}`;
  const NCOLS=LAST+1;
  const e=()=>new Array(NCOLS).fill('');

  const aoa=[];

  const r1=e(); r1[0]=`SOC Duty Roster for the Month of  ${MN[M].toUpperCase()}  ${Y}`; aoa.push(r1);
  aoa.push(e());
  const r3=e();
  r3[0]='Start Date:'; r3[2]=fmtD(startD);
  r3[7]='End Date:';   r3[9]=fmtD(endD);
  r3[14]='Total Days:';r3[16]=DAYS;
  r3[19]='WOs / Employee:'; r3[21]=WO_Q;
  aoa.push(r3);
  aoa.push(e());

  const r5=e();
  r5[0]='Sl\nNo.'; r5[1]='Employee Name';
  for(let d=1;d<=DAYS;d++) r5[DC+d-1]=dn(d);
  ['Total\nMS','Total\nGS','Total\nAS','Total\nNS',
   'Amt\nMS(₹)','Amt\nAS(₹)','Amt\nNS(₹)','Total\nAmt(₹)',
   'GH','WO','EX','WFH','CO','RH','HL','SL','CL','VL'
  ].forEach((h,i)=>r5[SC+i]=h);
  aoa.push(r5);

  const r6=e();
  for(let d=1;d<=DAYS;d++) r6[DC+d-1]=d;
  aoa.push(r6);

  const EMP_R1=7;
  emps.forEach((e2,ei)=>{
    const s=roster[e2.id]||new Array(DAYS).fill('');
    const row=new Array(NCOLS).fill('');
    row[0]=ei+1;
    row[1]=e2.name+(e2.dept==='NSOC'?' - NSOC':'');
    for(let d=0;d<DAYS;d++) row[DC+d]=s[d]||'';
    const fc=colL(DC), lc=colL(DC+DAYS-1);
    const er=EMP_R1+ei;
    const rng=`${fc}${er}:${lc}${er}`;
    const msC=colL(C_MS),asC=colL(C_AS),nsC=colL(C_NS);
    const amsC=colL(C_AMS),aasC=colL(C_AAS),ansC=colL(C_ANS);
    row[C_MS] ={f:`COUNTIF(${rng},"MS")+COUNTIF(${rng},"WFH-MS")`,t:'n',v:0};
    row[C_GS] ={f:`COUNTIF(${rng},"GS")+COUNTIF(${rng},"WFH")`,t:'n',v:0};
    row[C_AS] ={f:`COUNTIF(${rng},"AS")+COUNTIF(${rng},"WFH-AS")`,t:'n',v:0};
    row[C_NS] ={f:`COUNTIF(${rng},"NS")+COUNTIF(${rng},"WFH-NS")`,t:'n',v:0};
    row[C_AMS]={f:`${msC}${er}*150`,t:'n',v:0};
    row[C_AAS]={f:`${asC}${er}*150`,t:'n',v:0};
    row[C_ANS]={f:`${nsC}${er}*250`,t:'n',v:0};
    row[C_TOT]={f:`${amsC}${er}+${aasC}${er}+${ansC}${er}`,t:'n',v:0};
    row[C_GH] ={f:`COUNTIF(${rng},"GH")`,t:'n',v:0};
    row[C_WO] ={f:`COUNTIF(${rng},"WO")`,t:'n',v:0};
    row[C_EX] ={f:`COUNTIF(${rng},"EX")`,t:'n',v:0};
    row[C_WFH]={f:`COUNTIF(${rng},"WFH")`,t:'n',v:0};
    row[C_CO] ={f:`COUNTIF(${rng},"CO")`,t:'n',v:0};
    row[C_RH] ={f:`COUNTIF(${rng},"RH")`,t:'n',v:0};
    row[C_HL] ={f:`COUNTIF(${rng},"HL")`,t:'n',v:0};
    row[C_SL] ={f:`COUNTIF(${rng},"SL")`,t:'n',v:0};
    row[C_CL] ={f:`COUNTIF(${rng},"CL")`,t:'n',v:0};
    row[C_VL] ={f:`COUNTIF(${rng},"VL")`,t:'n',v:0};
    aoa.push(row);
  });

  const TOT_R1=EMP_R1+emps.length;
  [['Total MS','MS'],['Total GS','GS'],['Total AS','AS'],['Total NS','NS']].forEach(([lbl,code])=>{
    const row=e(); row[1]=lbl;
    for(let d=1;d<=DAYS;d++){
      const cl=colL(DC+d-1);
      row[DC+d-1]={f:`COUNTIF(${cl}${EMP_R1}:${cl}${EMP_R1+emps.length-1},"${code}")`,t:'n',v:0};
    }
    aoa.push(row);
  });

  aoa.push(e());
  aoa.push(['Code','Description','Shift Hrs']);
  [['WO','Week Off','—'],['MS','Morning Shift','9'],['GS','General Shift','9'],
   ['NS','Night Shift','9'],['AS','Afternoon Shift','9'],['GH','Gazetted Holiday','—'],
   ['CO','Comp Off','—'],['CL','Casual Leave','—'],['VL','Vacation Leave','—'],
   ['SL','Sick Leave','—'],['HL','Half Day','4.5'],['WFH','Work From Home','9'],
   ['EX','Exam Leave','—'],['RH','Restricted Holiday','—'],
  ].forEach(r=>aoa.push(r));

  const ws=XLSX.utils.aoa_to_sheet(aoa,{sheetStubs:true});

  ws['!cols']=[{wch:5.5},{wch:25},...Array(DAYS).fill({wch:5.2}),
    ...[7,7,7,7,9,9,9,11,4.5,4.5,4.5,4.5,4.5,4.5,4.5,4.5,4.5,4.5].map(w=>({wch:w}))];

  ws['!rows']=[{hpt:32},{hpt:4},{hpt:18},{hpt:4},{hpt:30},{hpt:16},
    ...emps.map(()=>({hpt:17})),
    ...Array(4).fill({hpt:16}),{hpt:8},{hpt:18},...Array(14).fill({hpt:15}),
  ];

  const merges=[];
  merges.push({s:{r:0,c:0},e:{r:0,c:LAST}});
  merges.push({s:{r:4,c:0},e:{r:5,c:0}});
  merges.push({s:{r:4,c:1},e:{r:5,c:1}});
  for(let i=0;i<18;i++) merges.push({s:{r:4,c:SC+i},e:{r:5,c:SC+i}});
  ws['!merges']=merges;

  ws['!freeze']={xSplit:2,ySplit:6,topLeftCell:'C7'};

  XLSX.utils.book_append_sheet(XLWB,ws,`${MN[M]} ${Y}`);

  const rot2=emps.filter(e2=>e2.type==='Rotating').map(e2=>{
    const s=roster[e2.id]||[];
    const ms=s.filter(x=>x==='MS'||x==='WFH-MS').length;
    const as=s.filter(x=>x==='AS'||x==='WFH-AS').length;
    const ns=s.filter(x=>x==='NS'||x==='WFH-NS').length;
    const wo=s.filter(x=>x==='WO').length;
    return{...e2,ms,as,ns,wo,tot:ms+as+ns,amt:ms*150+as*150+ns*250};
  }).sort((a,b)=>b.amt-a.amt);
  const gen2=emps.filter(e2=>e2.type==='General').map(e2=>{
    const s=roster[e2.id]||[];
    return{...e2,ms:0,as:0,ns:0,wo:s.filter(x=>x==='WO').length,
      tot:s.filter(x=>x==='GS').length,amt:0};
  });
  const all2=[...rot2,...gen2];
  const N2=all2.length;

  const sa=[];
  sa.push([`SOC TRAVELLING ALLOWANCE — ${MN[M].toUpperCase()} ${Y}`]);
  sa.push(['Sl No.','Employee Name','Department','MS Count','AS Count','NS Count',
    'MS Amount(₹)','AS Amount(₹)','NS Amount(₹)','Total Amount(₹)','WO Count','Total Shifts','Type']);
  all2.forEach((e2,i)=>{
    sa.push([i+1,e2.name,e2.dept,e2.ms,e2.as,e2.ns,
      {f:`D${i+3}*150`,t:'n',v:0},{f:`E${i+3}*150`,t:'n',v:0},{f:`F${i+3}*250`,t:'n',v:0},
      {f:`G${i+3}+H${i+3}+I${i+3}`,t:'n',v:0},
      e2.wo,e2.tot,e2.type[0]]);
  });
  sa.push(['','TOTAL','',
    {f:`SUM(D3:D${N2+2})`,t:'n',v:0},{f:`SUM(E3:E${N2+2})`,t:'n',v:0},
    {f:`SUM(F3:F${N2+2})`,t:'n',v:0},{f:`SUM(G3:G${N2+2})`,t:'n',v:0},
    {f:`SUM(H3:H${N2+2})`,t:'n',v:0},{f:`SUM(I3:I${N2+2})`,t:'n',v:0},
    {f:`SUM(J3:J${N2+2})`,t:'n',v:0},'','','']);

  const ws2=XLSX.utils.aoa_to_sheet(sa);
  ws2['!cols']=[{wch:5},{wch:26},{wch:11},...Array(10).fill({wch:11})];
  ws2['!merges']=[{s:{r:0,c:0},e:{r:0,c:12}}];
  ws2['!freeze']={xSplit:0,ySplit:2,topLeftCell:'A3'};
  XLSX.utils.book_append_sheet(XLWB,ws2,'Summary');

  const wbout=XLSX.write(XLWB,{bookType:'xlsx',type:'array',bookSST:false});
  injectStylesAndDownload(wbout,ws,ws2,`SOC_ROSTER_${MN[M].toUpperCase()}_${Y}.xlsx`,
    DAYS,DC,SC,EMP_R1,emps,TOT_R1,WO_Q,N2,LAST,aoa,sa);
}

function injectStylesAndDownload(wbout,ws,ws2,filename,DAYS,DC,SC,EMP_R1,empList,TOT_R1,WO_Q,N2,LAST,aoa,sa){
  const NAVY='1F3864', MNAV='2F5496', STEEL='D6DCE4';
  const WHT='FFFFFF', WE_H='F4B183', WE_C='FCE4D6', NBLU='EBF3FB';
  const YLW='FFF2CC', EVEN='F2F7FB', META='EBF3FB';
  const GRY9='595959', BLU1='1F3864', BRN='5C4A1E';

  const STBL=[
    {bg:'FFFFFF',fg:'000000',bold:false,sz:10,border:false,numFmt:'General'},
    {bg:NAVY,fg:WHT,bold:true,sz:14,border:true,numFmt:'General',halign:'center'},
    {bg:MNAV,fg:WHT,bold:true,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:MNAV,fg:WHT,bold:true,sz:8,border:true,numFmt:'General',halign:'center',wrap:true},
    {bg:STEEL,fg:BLU1,bold:true,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:WE_H,fg:'7B1515',bold:true,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:NBLU,fg:BLU1,bold:true,sz:10,border:true,numFmt:'General',halign:'left'},
    {bg:EVEN,fg:GRY9,bold:false,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:'FFFFFF',fg:GRY9,bold:false,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:WE_C,fg:GRY9,bold:false,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:'FFF0E8',fg:GRY9,bold:false,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:YLW,fg:BRN,bold:true,sz:9,border:true,numFmt:'General',halign:'left'},
    {bg:YLW,fg:BRN,bold:true,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:META,fg:'8497B0',bold:false,sz:10,border:false,numFmt:'General',halign:'left'},
    {bg:META,fg:BLU1,bold:true,sz:10,border:false,numFmt:'General',halign:'left'},
    {bg:MNAV,fg:WHT,bold:true,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:EVEN,fg:GRY9,bold:false,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:'FFFFFF',fg:GRY9,bold:false,sz:9,border:true,numFmt:'General',halign:'center'},
    {bg:MNAV,fg:WHT,bold:true,sz:10,border:true,numFmt:'General',halign:'center'},
    {bg:EVEN,fg:BLU1,bold:true,sz:10,border:true,numFmt:'General',halign:'left'},
    {bg:'E8F5E9',fg:'1B5E20',bold:false,sz:9,border:true,numFmt:'#,##0',halign:'center'},
    {bg:'E8F5E9',fg:'1B5E20',bold:true,sz:10,border:true,numFmt:'#,##0',halign:'center'},
    {bg:YLW,fg:'7B6000',bold:true,sz:10,border:true,numFmt:'#,##0',halign:'center'},
    {bg:'FFCCCC',fg:'990000',bold:true,sz:9,border:true,numFmt:'General',halign:'center'},
  ];
  const SHIFT_KEYS=['MS','AS','NS','GS','WO','CO','SL','CL','VL','HL','GH','EX','RH','WFH','WFH-MS','WFH-AS','WFH-NS'];
  const SHIFT_S_START=STBL.length;
  SHIFT_KEYS.forEach(k=>{
    const[bg,fg]=SHIFT_CLR[k];
    STBL.push({bg,fg,bold:k!=='WO'&&k!=='GH',sz:9,border:true,numFmt:'General',halign:'center'});
  });
  const SUM_STBL_START=STBL.length;
  [['C6EFCE','276221'],['E2EFDA','375623'],['FFEB9C','9C6500'],['BDD7EE','1F4E79']].forEach(([bg,fg])=>{
    STBL.push({bg,fg,bold:true,sz:9,border:true,numFmt:'General',halign:'center'});
  });
  [['C6EFCE','276221'],['FFEB9C','9C6500'],['BDD7EE','1F4E79'],['FFF2CC','7B6000']].forEach(([bg,fg])=>{
    STBL.push({bg,fg,bold:true,sz:9,border:true,numFmt:'#,##0',halign:'center'});
  });
  [['FFFFCC','7B6000'],['D9D9D9','595959'],['EAD1DC','4A235A'],['E1D5E7','5B2C6F'],
   ['FFD7A8','843C0C'],['D5E8D4','2D6B30'],['FCE4D6','833300'],['FCE4D6','833300'],
   ['FCE4D6','833300'],['FCE4D6','833300'],
  ].forEach(([bg,fg])=>{
    STBL.push({bg,fg,bold:false,sz:9,border:true,numFmt:'General',halign:'center'});
  });

  const fontEntries=[];
  const fillEntries=['FFFFFF'];
  const fontMap={};
  STBL.forEach(s=>{
    const fk=`${s.bold?1:0}_${s.fg}_${s.sz||10}`;
    if(!(fk in fontMap)){fontMap[fk]=fontEntries.length;fontEntries.push(s);}
    if(s.bg!=='FFFFFF'&&!fillEntries.includes(s.bg)) fillEntries.push(s.bg);
  });

  const fontsXml=fontEntries.map(s=>{
    const b=s.bold?'<b/>':'';
    const sz=s.sz||10;
    return `<font>${b}<sz val="${sz}"/><color rgb="FF${s.fg}"/><name val="Calibri"/><family val="2"/></font>`;
  }).join('');

  let fillsXml='<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>';
  fillsXml+=fillEntries.slice(2).map(bg=>
    `<fill><patternFill patternType="solid"><fgColor rgb="FF${bg}"/><bgColor indexed="64"/></patternFill></fill>`
  ).join('');

  const bdrThin='<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>';
  const bdrThick='<border><left style="medium"><color rgb="FF8497B0"/></left><right style="medium"><color rgb="FF8497B0"/></right><top style="medium"><color rgb="FF8497B0"/></top><bottom style="medium"><color rgb="FF8497B0"/></bottom><diagonal/></border>';
  const bordersXml='<border><left/><right/><top/><bottom/><diagonal/></border>'+bdrThin+bdrThick;

  const numFmtsXml='<numFmt numFmtId="164" formatCode="#,##0"/>';
  const xfsXml=STBL.map(s=>{
    const fk=`${s.bold?1:0}_${s.fg}_${s.sz||10}`;
    const fi=fontMap[fk];
    const fli=s.bg==='FFFFFF'?0:(fillEntries.indexOf(s.bg));
    const bdi=s.border?1:0;
    const nfi=s.numFmt==='#,##0'?164:0;
    const ha=s.halign||'center';
    const wrap=s.wrap?'wrapText="1" ':'';
    return `<xf numFmtId="${nfi}" fontId="${fi}" fillId="${fli}" borderId="${bdi}" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${ha}" vertical="center" ${wrap}/></xf>`;
  }).join('');

  const stylesXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1">${numFmtsXml}</numFmts>
<fonts count="${fontEntries.length}">${fontsXml}</fonts>
<fills count="${fillEntries.length}">${fillsXml}</fills>
<borders count="3">${bordersXml}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${STBL.length}">${xfsXml}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function getStyleIdx(sheetType,rowIdx,colIdx,code,extra){
    if(sheetType==='main'){
      const r1=rowIdx+1;
      if(r1===1) return 1;
      if(r1===3){
        if(colIdx===0||colIdx===7||colIdx===14||colIdx===19) return 13;
        if(colIdx===2||colIdx===9||colIdx===16||colIdx===21) return 14;
        return 0;
      }
      if(r1===5){
        if(colIdx===0||colIdx===1) return 2;
        if(colIdx>=DC&&colIdx<DC+DAYS){
          const dname=dn(colIdx-DC+1);
          return (dname==='Sat'||dname==='Sun')?5:2;
        }
        if(colIdx>=SC) return 3;
        return 2;
      }
      if(r1===6){
        if(colIdx===0||colIdx===1) return 2;
        if(colIdx>=DC&&colIdx<DC+DAYS){
          const dname=dn(colIdx-DC+1);
          return (dname==='Sat'||dname==='Sun')?5:4;
        }
        return 0;
      }
      if(r1>=EMP_R1&&r1<EMP_R1+empList.length){
        const ei=r1-EMP_R1;
        if(colIdx===0) return ei%2===0?16:17;
        if(colIdx===1) return 6;
        if(colIdx>=DC&&colIdx<DC+DAYS){
          if(code&&SHIFT_CLR[code]) return SHIFT_S_START+SHIFT_KEYS.indexOf(code);
          const dname=dn(colIdx-DC+1);
          return (dname==='Sat'||dname==='Sun')?(ei%2===0?9:10):(ei%2===0?7:8);
        }
        const sci=colIdx-SC;
        if(sci>=0&&sci<=3) return SUM_STBL_START+sci;
        if(sci>=4&&sci<=7) return SUM_STBL_START+4+sci-4;
        if(sci>=8) return SUM_STBL_START+8+sci-8;
        return 0;
      }
      if(r1>=TOT_R1&&r1<TOT_R1+4){
        if(colIdx===1) return 11;
        if(colIdx>=DC&&colIdx<DC+DAYS){
          const dname=dn(colIdx-DC+1);
          const ti=r1-TOT_R1;
          if(dname==='Sat'||dname==='Sun') return 9;
          return SUM_STBL_START+ti;
        }
        return 12;
      }
      const LEG_HDR=TOT_R1+5;
      if(r1===LEG_HDR) return 15;
      if(r1>LEG_HDR){
        const lcode=extra;
        if(lcode&&SHIFT_CLR[lcode]) return SHIFT_S_START+SHIFT_KEYS.indexOf(lcode);
        return 0;
      }
      return 0;
    }
    if(rowIdx===0) return 1;
    if(rowIdx===1) return 18;
    const lastDataRow=extra;
    if(rowIdx===lastDataRow) return 22;
    if(colIdx===1) return 19;
    if(colIdx>=6&&colIdx<=9) return colIdx===9?21:20;
    return 7;
  }

  const legCodes=['WO','MS','GS','NS','AS','GH','CO','CL','VL','SL','HL','WFH','EX','RH'];
  const LEG_HDR_R=TOT_R1+5;

  function buildSheetXml(aoaData,colWidthsXml,mergesXml,freezeXml,sheetType,extra){
    let rowsXml='';
    aoaData.forEach((rowData,ri)=>{
      const r1=ri+1;
      let cellsXml='';
      rowData.forEach((val,ci)=>{
        const addr=XLSX.utils.encode_cell({r:ri,c:ci});
        let code='';
        if(sheetType==='main'&&r1>=EMP_R1&&r1<EMP_R1+empList.length&&ci>=DC&&ci<DC+DAYS){
          code=typeof val==='string'?val:'';
        }
        if(sheetType==='main'&&r1>LEG_HDR_R){
          const li=r1-LEG_HDR_R-1;
          if(ci===0&&li>=0&&li<legCodes.length) code=legCodes[li];
        }
        const si=getStyleIdx(sheetType,ri,ci,code,extra);
        if(val===''||val===null||val===undefined){
          if(si>0) cellsXml+=`<c r="${addr}" s="${si}"/>`;
          return;
        }
        const isFormula=val&&typeof val==='object'&&'f' in val;
        if(isFormula){
          cellsXml+=`<c r="${addr}" t="n" s="${si}"><f>${val.f}</f><v>0</v></c>`;
        } else if(typeof val==='number'){
          cellsXml+=`<c r="${addr}" t="n" s="${si}"><v>${val}</v></c>`;
        } else {
          const escaped=String(val).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          cellsXml+=`<c r="${addr}" t="inlineStr" s="${si}"><is><t>${escaped}</t></is></c>`;
        }
      });
      if(cellsXml) rowsXml+=`<row r="${r1}">${cellsXml}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0">${freezeXml}</sheetView></sheetViews>
${colWidthsXml}
<sheetData>${rowsXml}</sheetData>
${mergesXml}
</worksheet>`;
  }

  let colXml='<cols>';
  colXml+=`<col min="1" max="1" width="6.33" customWidth="1"/>`;
  colXml+=`<col min="2" max="2" width="26" customWidth="1"/>`;
  for(let d=0;d<DAYS;d++) colXml+=`<col min="${3+d}" max="${3+d}" width="5.5" customWidth="1"/>`;
  const sumW=[7,7,7,7,9,9,9,11,5,5,5,5,5,5,5,5,5,5];
  sumW.forEach((w,i)=>{ colXml+=`<col min="${DC+DAYS+1+i}" max="${DC+DAYS+1+i}" width="${w}" customWidth="1"/>`;});
  colXml+='</cols>';

  let mergesXmlStr='<mergeCells>';
  mergesXmlStr+=`<mergeCell ref="A1:${XLSX.utils.encode_col(LAST)}1"/>`;
  mergesXmlStr+=`<mergeCell ref="A5:A6"/><mergeCell ref="B5:B6"/>`;
  for(let i=0;i<18;i++){
    const cl=XLSX.utils.encode_col(SC+i);
    mergesXmlStr+=`<mergeCell ref="${cl}5:${cl}6"/>`;
  }
  mergesXmlStr+='</mergeCells>';

  const freezeXml1=`<pane xSplit="2" ySplit="6" topLeftCell="C7" activePane="bottomRight" state="frozen"/>`;
  const freezeXml2=`<pane ySplit="2" topLeftCell="A3" activePane="bottomRight" state="frozen"/>`;

  let s2ColXml='<cols>';
  s2ColXml+=`<col min="1" max="1" width="5.5" customWidth="1"/>`;
  s2ColXml+=`<col min="2" max="2" width="27" customWidth="1"/>`;
  for(let i=3;i<=13;i++) s2ColXml+=`<col min="${i}" max="${i}" width="12" customWidth="1"/>`;
  s2ColXml+='</cols>';
  const s2MergesXml='<mergeCells><mergeCell ref="A1:M1"/></mergeCells>';

  const sheet1Xml=buildSheetXml(aoa,colXml,mergesXmlStr,freezeXml1,'main',null);
  const sheet2Xml=buildSheetXml(sa,s2ColXml,s2MergesXml,freezeXml2,'summary',N2+2);

  patchZipAndDownload(wbout, {
    'xl/styles.xml': stylesXml,
    'xl/worksheets/sheet1.xml': sheet1Xml,
    'xl/worksheets/sheet2.xml': sheet2Xml,
  }, filename);
}

function patchZipAndDownload(zipBuf, replacements, filename){
  const u8=new Uint8Array(zipBuf);
  const view=new DataView(zipBuf);

  const fileOffsets={};
  let i=0;
  while(i<u8.length-4){
    if(view.getUint32(i,true)===0x04034b50){
      const fnLen=view.getUint16(i+26,true);
      const extraLen=view.getUint16(i+28,true);
      const fnBytes=u8.slice(i+30,i+30+fnLen);
      const fn=new TextDecoder().decode(fnBytes);
      const dataStart=i+30+fnLen+extraLen;
      const compSize=view.getUint32(i+18,true);
      const uncompSize=view.getUint32(i+22,true);
      const method=view.getUint16(i+8,true);
      fileOffsets[fn]={headerStart:i,dataStart,compSize,uncompSize,method,fnLen,extraLen};
      i=dataStart+compSize;
    } else { i++; }
  }

  const parts=[];
  const centralDir=[];
  let offset=0;
  const allFiles=Object.keys(fileOffsets);

  allFiles.forEach(fn=>{
    const info=fileOffsets[fn];
    let data;
    if(fn in replacements){
      data=new TextEncoder().encode(replacements[fn]);
    } else {
      data=u8.slice(info.dataStart,info.dataStart+info.compSize);
    }
    const method=(fn in replacements)?0:info.method;
    const crc=(fn in replacements)?crc32(data):view.getUint32(info.headerStart+14,true);
    const fnBytes=new TextEncoder().encode(fn);

    const lhLen=30+fnBytes.length;
    const lh=new Uint8Array(lhLen);
    const lhView=new DataView(lh.buffer);
    lhView.setUint32(0,0x04034b50,true);
    lhView.setUint16(4,20,true);
    lhView.setUint16(6,0,true);
    lhView.setUint16(8,method,true);
    lhView.setUint16(10,0,true);
    lhView.setUint16(12,0,true);
    lhView.setUint32(14,crc,true);
    lhView.setUint32(18,data.length,true);
    lhView.setUint32(22,fn in replacements?data.length:info.uncompSize,true);
    lhView.setUint16(26,fnBytes.length,true);
    lhView.setUint16(28,0,true);
    lh.set(fnBytes,30);

    const cdLen=46+fnBytes.length;
    const cd=new Uint8Array(cdLen);
    const cdView=new DataView(cd.buffer);
    cdView.setUint32(0,0x02014b50,true);
    cdView.setUint16(4,20,true);cdView.setUint16(6,20,true);
    cdView.setUint16(8,0,true);cdView.setUint16(10,method,true);
    cdView.setUint16(12,0,true);cdView.setUint16(14,0,true);
    cdView.setUint32(16,crc,true);
    cdView.setUint32(20,data.length,true);
    cdView.setUint32(24,fn in replacements?data.length:info.uncompSize,true);
    cdView.setUint16(28,fnBytes.length,true);
    cdView.setUint16(30,0,true);cdView.setUint16(32,0,true);
    cdView.setUint16(34,0,true);cdView.setUint16(36,0,true);
    cdView.setUint32(38,0,true);cdView.setUint32(42,offset,true);
    cd.set(fnBytes,46);

    parts.push(lh,data);
    centralDir.push(cd);
    offset+=lhLen+data.length;
  });

  const cdOffset=offset;
  const cdData=concat(centralDir);
  const eocd=new Uint8Array(22);
  const eocdView=new DataView(eocd.buffer);
  eocdView.setUint32(0,0x06054b50,true);
  eocdView.setUint16(4,0,true);eocdView.setUint16(6,0,true);
  eocdView.setUint16(8,allFiles.length,true);
  eocdView.setUint16(10,allFiles.length,true);
  eocdView.setUint32(12,cdData.length,true);
  eocdView.setUint32(16,cdOffset,true);
  eocdView.setUint16(20,0,true);

  const finalZip=concat([...parts,...centralDir,eocd]);
  const blob=new Blob([finalZip],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function concat(arrays){
  const total=arrays.reduce((s,a)=>s+a.length,0);
  const out=new Uint8Array(total);
  let offset=0;
  for(const a of arrays){out.set(a,offset);offset+=a.length;}
  return out;
}

function crc32(data){
  let crc=0xFFFFFFFF;
  for(let i=0;i<data.length;i++){
    crc^=data[i];
    for(let j=0;j<8;j++) crc=(crc>>>1)^(crc&1?0xEDB88320:0);
  }
  return (crc^0xFFFFFFFF)>>>0;
}

// ═══════════════════════════════════════════════════════════════
// EXCEL CARRYOVER IMPORT
// ═══════════════════════════════════════════════════════════════

function handleFileDrop(ev){
  const f=ev.dataTransfer?.files?.[0];
  if(f) handleFileSelect(f);
}

function handleFileSelect(file){
  if(!file) return;
  const badge=document.getElementById('importBadge');
  badge.textContent='⏳ Parsing…';
  badge.style.cssText='display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;background:var(--bg4);color:var(--text2);border:1px solid var(--border2)';
  document.getElementById('importResults').style.display='none';
  document.getElementById('applyImportBtn').style.display='none';
  document.getElementById('clearImportBtn').style.display='none';

  parseExcelCarryover(file).then(parsed=>{
    importedCarry=parsed;
    _nsCarryTeams=detectNSCarryTeams(parsed);
    renderImportResults(parsed);
    const n=Object.keys(parsed.derived||{}).length;
    badge.textContent=`✓ ${n} employee${n!==1?'s':''} derived`;
    badge.style.cssText='display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;background:var(--ok-bg);color:var(--ok-t);border:1px solid var(--ok-b)';
    document.getElementById('applyImportBtn').style.display='';
    document.getElementById('clearImportBtn').style.display='';
    document.getElementById('importResults').style.display='';
  }).catch(err=>{
    badge.textContent='✗ '+err.message;
    badge.style.cssText='display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;background:var(--warn-bg);color:var(--warn-t);border:1px solid var(--warn-b)';
    document.getElementById('clearImportBtn').style.display='';
  });
}

// ── Parse uploaded .xlsx/.xlsm file ───────────────────────────
// Works with both the v4 export format (xlsx) and legacy xlsm
// format by robustly detecting the day-number header row.
function parseExcelCarryover(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('File read error'));
    reader.onload=ev=>{
      try{
        const data=new Uint8Array(ev.target.result);
        const wb=XLSX.read(data,{type:'array'});
        const wsName=wb.SheetNames[0];
        const ws=wb.Sheets[wsName];
        const aoa=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});

        // ── Locate the day-number header row ──────────────────
        // Look for a row containing consecutive integers 1,2,3…≥28
        // starting from any column. Handles both v4 and xlsm layouts.
        let dayNumRow=-1, dayColStart=-1, dayCount=0;
        for(let r=0;r<Math.min(aoa.length,14)&&dayNumRow===-1;r++){
          const row=aoa[r];
          let seq=0, startCol=-1;
          for(let c=0;c<row.length;c++){
            const raw=row[c];
            const n=typeof raw==='number'?raw:parseFloat(String(raw));
            if(!isNaN(n)&&Number.isInteger(n)&&n===seq+1){
              if(seq===0) startCol=c;
              seq++;
            } else if(seq>0) break;
          }
          if(seq>=28){dayNumRow=r;dayColStart=startCol;dayCount=seq;}
        }
        if(dayNumRow===-1){
          reject(new Error('Cannot locate day-number header row (expected a row with 1,2,3…28+). Make sure you are uploading a roster generated by this tool.'));
          return;
        }

        const empRowStart=dayNumRow+1;
        const lastDayCol=dayColStart+dayCount-1;
        const LOOKBACK=6; // read last 6 days to handle 6-day streaks

        // ── Build name→empId lookup (case-insensitive, trimmed) ──
        const nameMap={};
        emps.filter(e=>e.type==='Rotating').forEach(e=>{
          nameMap[normalizeName(e.name)]=e.id;
        });

        const derived={};
        const unmatched=[];

        for(let r=empRowStart;r<aoa.length;r++){
          const row=aoa[r];
          if(!row||(!row[1]&&!row[0])) continue;
          // Name column: usually col 1; strip " - NSOC" suffix from export
          let rawName=String(row[1]||row[0]||'')
            .replace(/\s*[-–]\s*NSOC\s*$/i,'').trim();
          if(!rawName) continue;
          // Skip total/legend rows
          const lc=rawName.toLowerCase();
          if(lc.startsWith('total')||lc==='code'||lc==='sl no'||lc==='sl\nno.') continue;

          const norm=normalizeName(rawName);
          let empId=nameMap[norm];

          // Fuzzy fallback: word-token overlap
          if(!empId){
            let best=null,bestScore=0;
            for(const[key,id] of Object.entries(nameMap)){
              const score=nameTokenScore(norm,key);
              if(score>bestScore&&score>=2){bestScore=score;best=id;}
            }
            empId=best;
          }

          if(!empId){
            if(rawName.length>1) unmatched.push(rawName);
            continue;
          }

          // Read last LOOKBACK day columns
          const cells=[];
          for(let i=LOOKBACK;i>=1;i--){
            const col=lastDayCol-(i-1);
            if(col<dayColStart){cells.push('');continue;}
            const raw=row[col];
            // SheetJS may give back the string value or leave it blank for empty cells
            cells.push(String(raw||'').trim().toUpperCase());
          }
          // cells[0]=6 days ago, cells[5]=last day of month

          derived[empId]=deriveStreakFromCells(cells);
        }

        if(Object.keys(derived).length===0){
          reject(new Error('No matching employees found. Ensure the file uses the same employee names as the current roster.'));
          return;
        }

        resolve({derived,unmatched});
      }catch(err){reject(new Error('Parse error: '+err.message));}
    };
    reader.readAsArrayBuffer(file);
  });
}

function normalizeName(s){
  return s.toLowerCase().replace(/\s+/g,' ').trim();
}

function nameTokenScore(a,b){
  // Count matching word tokens (each token must be ≥3 chars)
  const wa=a.split(' ').filter(w=>w.length>=3);
  const wb=b.split(' ').filter(w=>w.length>=3);
  let score=0;
  for(const w of wa){
    if(wb.some(wb2=>wb2.startsWith(w)||w.startsWith(wb2))) score++;
  }
  return score;
}

// ── Derive streak from the last 6 day-cell values ─────────────
// cells = [d-5, d-4, d-3, d-2, d-1, d] (oldest→newest)
// Returns { shifts: N, type: 'MS'|'AS'|'GS'|'NS', exhausted: bool }
function deriveStreakFromCells(cells){
  // GS is included here because rotating employees are sometimes assigned
  // a General shift (instead of MS/AS) to reduce shift allowance cost — a
  // trailing run of GS days in the export is just as much an active
  // carryover block as MS/AS, and needs to continue (+ mandatory 2 WOs)
  // exactly the same way. Previously GS wasn't recognized as a "working"
  // day here at all, so a rotating employee's last-6-days streak silently
  // broke/reset at any GS day instead of counting through it.
  const WORK=['MS','AS','GS','NS'];

  // Find the rightmost non-WO/empty day (end of the streak)
  let lastWorkIdx=-1;
  for(let i=cells.length-1;i>=0;i--){
    if(WORK.includes(cells[i])){lastWorkIdx=i;break;}
  }

  // All cells are WO or empty → fresh start
  if(lastWorkIdx===-1) return{shifts:0,type:'MS',exhausted:false};

  const streakType=cells[lastWorkIdx];
  let streakLen=0;

  // Count consecutive identical shifts walking leftward from lastWorkIdx
  for(let i=lastWorkIdx;i>=0;i--){
    if(cells[i]===streakType) streakLen++;
    else break; // WO, empty, or different type — streak boundary
  }

  // NS blocks are hard-capped at 5 consecutive nights (MS/AS blocks can run
  // up to 6) — so an NS streak can never legitimately be longer than 5.
  // Reading a 6th trailing NS-labeled day here (which shouldn't happen
  // under normal scheduling, but can if a stale/manually-edited export is
  // dropped in) must never be allowed to imply a 6th night is still owed;
  // that off-by-one was the root cause of a phantom NS shift getting
  // forced onto Day 1 of the new month. Clamp it down to the real max.
  if(streakType==='NS'&&streakLen>5) streakLen=5;

  // exhausted = we read the full relevant window and it was all the same
  // type → the actual streak could extend further back than what we read.
  // For NS this window is capped at 5 (the block length); for MS/AS it's
  // the full 6-cell lookback.
  const windowLen=streakType==='NS'?5:cells.length;
  const exhausted=(streakLen>=windowLen&&lastWorkIdx===cells.length-1);

  return{shifts:streakLen,type:streakType,exhausted};
}

// ── Detect NS carry-teams (employees sharing an NS tail) ───────
// Since NS teams are non-overlapping, at most ONE team can be
// mid-block at month-end. All employees with NS carry are
// from that same team.
function detectNSCarryTeams(parsed){
  const{derived}=parsed||{};
  if(!derived) return[];

  const nsIds=Object.keys(derived)
    .filter(id=>derived[id].type==='NS'&&derived[id].shifts>0)
    .map(Number);

  if(nsIds.length===0) return[];

  const digiNS=nsIds.filter(id=>emps.find(e=>e.id===id)?.dept==='Digiglass');
  const nsocNS=nsIds.filter(id=>emps.find(e=>e.id===id)?.dept==='NSOC');

  if(digiNS.length>=2&&nsocNS.length>=1){
    const shifts=derived[nsIds[0]].shifts;
    return[{members:[digiNS[0],digiNS[1],nsocNS[0]],shifts}];
  }
  return[];
}

// ── Render derivation results table ───────────────────────────
function renderImportResults(parsed){
  const{derived,unmatched}=parsed||{};
  const el=document.getElementById('importResults');

  const rows=emps.filter(e=>e.type==='Rotating').map(e=>{
    const r=derived?.[e.id];
    if(!r){
      return `<div class="import-row warn">
        <span class="import-name">${e.name}</span>
        <span class="${e.dept==='NSOC'?'b-nsoc':'b-digi'}">${e.dept}</span>
        <span class="import-miss">⚠ Not found in file — manual card kept</span>
      </div>`;
    }
    const exNote=r.exhausted
      ?`<span class="import-exhausted">⚠ 6-day window full — verify streak length manually</span>`:'';
    const desc=r.shifts===0
      ?`<span style="color:var(--ok-t)">Fresh start (0 shifts)</span>`
      :`<span style="color:var(--text)">${r.shifts}× <strong style="font-family:'JetBrains Mono',monospace">${r.type}</strong></span>`;
    return`<div class="import-row ok">
      <span class="import-name">${e.name}</span>
      <span class="${e.dept==='NSOC'?'b-nsoc':'b-digi'}">${e.dept}</span>
      <span class="import-streak">${desc}${exNote}</span>
    </div>`;
  });

  // NS carry-team box
  const teams=detectNSCarryTeams(parsed);
  let teamHtml='';
  if(teams.length>0){
    const entries=teams.map(t=>{
      const names=t.members.map(id=>{
        const e=emps.find(ex=>ex.id===id);
        return e?`${e.name} (${e.dept})`:'?';
      }).join(', ');
      return`<div class="import-team-entry">NS Carry-Team: ${names} — ${t.shifts} shift${t.shifts!==1?'s':''} remaining</div>`;
    });
    teamHtml=`<div class="import-team-box">
      <div class="import-team-lbl">🌙 NS Carry-Team Detected</div>
      ${entries.join('')}
      <div style="font-size:10px;color:var(--text3);margin-top:4px">These employees were mid-NS-block at month-end. Their remaining shifts + WO will be placed at the start of the new month.</div>
    </div>`;
  }

  let unmatchedHtml='';
  if(unmatched?.length){
    unmatchedHtml=`<div style="margin-top:8px;font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace">
      ⚠ Unrecognised rows skipped: ${unmatched.slice(0,8).join(', ')}${unmatched.length>8?'…':''}
    </div>`;
  }

  el.innerHTML=`<div class="import-rows">${rows.join('')}</div>${teamHtml}${unmatchedHtml}`;
}

// ── Apply derived values to carry{} ───────────────────────────
function applyImport(){
  if(!importedCarry?.derived) return;

  emps.filter(e=>e.type==='Rotating').forEach(e=>{
    const r=importedCarry.derived[e.id];
    if(r){
      // Use derived value
      carry[e.id]={shifts:r.shifts,type:r.type};
    } else {
      // Not found in last month's file → fresh start (Q5)
      carry[e.id]={shifts:0,type:'MS'};
    }
  });

  // Sync carry-teams for generate()
  _nsCarryTeams=detectNSCarryTeams(importedCarry);

  // Re-render carry cards to reflect new values with import badges
  renderCarry();
  renderCarryImpact();

  const btn=document.getElementById('applyImportBtn');
  btn.textContent='✓ Applied';
  btn.className='btn success';
  setTimeout(()=>{
    if(btn){btn.textContent='⚡ Apply Carryover from File';btn.className='btn primary';}
  },2000);
}

function clearImport(){
  importedCarry=null;
  _nsCarryTeams=[];
  const fi=document.getElementById('xlsxInput');
  if(fi) fi.value='';
  document.getElementById('importResults').style.display='none';
  document.getElementById('importResults').innerHTML='';
  document.getElementById('applyImportBtn').style.display='none';
  document.getElementById('clearImportBtn').style.display='none';
  const badge=document.getElementById('importBadge');
  badge.textContent='';
  badge.style.display='none';
  // Re-render carry cards without import badges
  renderCarry();
}

// ═══════════════════════════════════════════════════════════════
// NAV
// ═══════════════════════════════════════════════════════════════
function showPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  document.getElementById('tab-'+id).classList.add('active');
  if(id==='carryover'){renderCarry();renderCarryImpact();}
  if(id==='leave'){renderLeavePage();renderLockedWOPage();}
  if(id==='nsteams'){renderNSTeamsPage();}
  if(id==='summary'&&Object.keys(roster).length) renderSum();
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE SHEETS INTEGRATION
// ═══════════════════════════════════════════════════════════════

const WORKER_URL   = 'https://soc-roster-proxy.navoneel-itorizin-87e.workers.dev';
const GOOGLE_CLIENT_ID = ''; // Paste your OAuth Client ID here

let gAuthToken  = null;
let gUserEmail  = null;
let gIsAdmin    = false;

function initGoogleAuth() {
  if (!GOOGLE_CLIENT_ID) return;
  google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/userinfo.email ' +
           'https://www.googleapis.com/auth/userinfo.profile',
    callback: handleTokenResponse,
  });

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback:  handleIdToken,
    auto_select: true,
  });
  google.accounts.id.renderButton(
    document.getElementById('googleSignInBtn'),
    { theme:'filled_blue', size:'large', text:'signin_with', shape:'pill' }
  );
}

function handleIdToken(response) {
  const parts   = response.credential.split('.');
  const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/userinfo.email',
    callback: (tokenResp) => {
      if (tokenResp.access_token) {
        gAuthToken   = tokenResp.access_token;
        gUserEmail   = payload.email;
        showAuthBar(payload);
      }
    },
  });
  client.requestAccessToken({ prompt: '' });
}

function handleTokenResponse(resp) {
  if (!resp.access_token) return;
  gAuthToken = resp.access_token;
  fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + gAuthToken }
  }).then(r => r.json()).then(info => {
    gUserEmail = info.email;
    showAuthBar(info);
  });
}

function showAuthBar(userInfo) {
  document.getElementById('signInOverlay').style.display = 'none';
  document.getElementById('authBar').style.display = 'flex';
  document.getElementById('authName').textContent  = userInfo.name || userInfo.email;
  document.getElementById('authBadge').textContent = gIsAdmin ? 'Admin' : 'User';
  document.getElementById('authBadge').className   = 'auth-badge ' + (gIsAdmin?'admin':'user');
  document.getElementById('btnSignOut').style.display = '';
  if (userInfo.picture) {
    document.getElementById('authAvatar').src = userInfo.picture;
    document.getElementById('authAvatar').style.display = '';
  }
  if (WORKER_URL) {
    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getSyncFlag', token: gAuthToken }),
    }).then(r => r.json()).then(d => {
      gIsAdmin = true;
      document.getElementById('btnPush').style.display = '';
      if (Object.keys(roster).length > 0) {
        document.getElementById('btnPush').disabled = false;
      }
    }).catch(() => {});
  }
}

function signOut() {
  gAuthToken = null; gUserEmail = null; gIsAdmin = false;
  document.getElementById('authBar').style.display = 'none';
  document.getElementById('btnPush').style.display = 'none';
  if (GOOGLE_CLIENT_ID) {
    google.accounts.id.disableAutoSelect();
  }
}

async function pushToSheets() {
  if (!gAuthToken) {
    document.getElementById('signInOverlay').style.display = 'flex';
    return;
  }
  if (!Object.keys(roster).length) {
    setPushStatus('Generate the roster first.', 'err');
    return;
  }
  if (!WORKER_URL) {
    setPushStatus('WORKER_URL not configured.', 'err');
    return;
  }

  const btn = document.getElementById('btnPush');
  btn.disabled = true;
  setPushStatus('Building roster data…', 'loading');

  const indexedRoster = {};
  emps.forEach((e, i) => {
    indexedRoster[String(i)] = roster[e.id] || new Array(cfg.days).fill('WO');
  });

  const payload = {
    action:    'publishRoster',
    token:     gAuthToken,
    month:     cfg.month,
    year:      cfg.year,
    days:      cfg.days,
    woQuota:   cfg.woQ,
    sats:      cfg.sats,
    suns:      cfg.suns,
    employees: emps.map(e => ({ name: e.name, dept: e.dept, type: e.type })),
    roster:    indexedRoster,
  };

  setPushStatus('Connecting to Google Sheets…', 'loading');

  try {
    const resp = await fetch(WORKER_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.ok) {
      setPushStatus(
        `✓ Published to "${data.tabName}" — ${data.cellsWritten} employees written.`,
        'ok'
      );
    } else {
      setPushStatus('Error: ' + (data.error || 'Unknown error'), 'err');
    }
  } catch(err) {
    setPushStatus('Network error: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function setPushStatus(msg, type) {
  const el = document.getElementById('pushStatus');
  el.style.display = '';
  el.textContent   = msg;
  el.className     = 'push-status ' + (type||'');
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
  return {
    initEmps: function(empMaster) {
       emps = empMaster.map(e => ({
         id: e.slNo,
         name: e.name,
         dept: e.shiftGroup,
         type: e.role === 'SOC Analyst' ? 'Rotating' : 'General'
       }));
       
       const now = new Date();
       const selM = document.getElementById('selM');
       const selY = document.getElementById('selY');
       if (selM) selM.value = now.getMonth();
       if (selY) selY.value = now.getFullYear();
       
       recalc();
       renderEmps();
       renderCarryImpact();
       renderLeavePage();
       renderLockedWOPage();
    },
    buildRoster: buildRoster
  };
})();