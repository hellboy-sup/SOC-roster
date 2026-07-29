// ═══════════════════════════════════════════════════════════════
//  SOC ROSTER HUB — Google Apps Script  v2
//  Handles all write operations so employees with view-only access
//  can still submit leave/swap requests.
//
//  AUTO-SYNC ADDITION (v2):
//    New action "updateSyncFlag" keeps the Sync_Flags sheet in sync
//    when changes are made via Apps Script instead of the Worker.
//    editShift() and processRequest() now automatically call
//    updateSyncFlag() internally after every applied change.
//
//  Deploy as: Web App | Execute as: Me | Access: Anyone
// ═══════════════════════════════════════════════════════════════

const SHEET_ID = '1MY9aFaaUdSmqUP2V3gXt0emNMONlubgOfVqoV2mLpoY';

const MONTH_ORDER = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// ── JSON response helper (Apps Script does NOT support addHeader) ─────────────
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET handler (ping test + getSyncFlag polling) ─────────────────────────────
function doGet(e) {
  try {
    // No payload = simple ping
    if (!e || !e.parameter || !e.parameter.payload) {
      return jsonResponse({ ok: true, message: 'SOC Roster Hub Apps Script v2 is running!' });
    }

    // Support GET-based payload for polling (avoids CORS preflight)
    var body   = JSON.parse(e.parameter.payload);
    var action = body.action;
    var result;

    if      (action === 'submitRequest')  result = submitRequest(body);
    else if (action === 'processRequest') result = processRequest(body);
    else if (action === 'editShift')      result = editShift(body);
    else if (action === 'updateSyncFlag') result = updateSyncFlag(body);
    else if (action === 'emailNotify')    result = emailNotify(body);
    else if (action === 'ping')           result = { ok: true, message: 'Pong!' };
    else                                  result = { ok: false, error: 'Unknown action: ' + action };

    return jsonResponse(result);

  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ── POST handler (primary path from Cloudflare Worker fallback) ───────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;

    if      (action === 'submitRequest')  result = submitRequest(body);
    else if (action === 'processRequest') result = processRequest(body);
    else if (action === 'editShift')      result = editShift(body);
    else if (action === 'updateSyncFlag') result = updateSyncFlag(body);
    else if (action === 'emailNotify')    result = emailNotify(body);
    else if (action === 'ping')           result = { ok: true, message: 'Apps Script is connected!' };
    else                                  result = { ok: false, error: 'Unknown action: ' + action };

    return jsonResponse(result);

  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  ACTION 1 — Submit Leave / Swap Request
//  Called by ANY employee (viewer access is enough)
//  Appends a row to Leave_Swap_Log
// ═══════════════════════════════════════════════════════════════
function submitRequest(body) {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName('Leave_Swap_Log');

  if (!sheet) throw new Error('Leave_Swap_Log tab not found');

  var reqId = 'REQ-' + new Date().getTime().toString().slice(-6);
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy');

  var row = [
    reqId,                          // A: Request ID
    today,                          // B: Date Raised
    body.month         || '',       // C: Month
    body.empName       || '',       // D: Employee Name
    body.reqType       || '',       // E: Request Type
    body.dateAffected  || '',       // F: Date(s) Affected
    body.originalShift || '',       // G: Original Shift
    body.newShift      || '',       // H: New Shift / Leave Code
    body.swapPartner   || '—',      // I: Swap Partner
    'Pending',                      // J: Status
    '—',                            // K: Approved By
    '—'                             // L: Approval Date
  ];

  sheet.appendRow(row);

  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 10).setBackground('#FFF2CC'); // yellow for Pending

  return {
    ok: true,
    reqId: reqId,
    message: 'Request submitted successfully'
  };
}

// ═══════════════════════════════════════════════════════════════
//  ACTION 2 — Process Request (Approve / Reject)
//  Called by ADMIN only
//  Updates Leave_Swap_Log status + updates roster if approved
// ═══════════════════════════════════════════════════════════════
function processRequest(body) {
  var ss        = SpreadsheetApp.openById(SHEET_ID);
  var logSheet  = ss.getSheetByName('Leave_Swap_Log');

  if (!logSheet) throw new Error('Leave_Swap_Log tab not found');

  var reqId      = body.reqId;
  var action     = body.decision;   // 'Approved' or 'Rejected'
  var adminEmail = body.adminEmail || '';
  var today      = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy');

  var data      = logSheet.getDataRange().getValues();
  var targetRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === reqId) { targetRow = i + 1; break; }
  }
  if (targetRow === -1) throw new Error('Request ' + reqId + ' not found');

  logSheet.getRange(targetRow, 10).setValue(action);
  logSheet.getRange(targetRow, 11).setValue(adminEmail);
  logSheet.getRange(targetRow, 12).setValue(today);

  var statusCell = logSheet.getRange(targetRow, 10);
  if (action === 'Approved') {
    statusCell.setBackground('#E2EFDA');
  } else {
    statusCell.setBackground('#FCE4D6');
  }

  if (action === 'Approved') {
    var rowData       = data[targetRow - 1];
    var monthLabel    = rowData[2];   // col C: Month label e.g. "April 2026"
    var empName       = rowData[3];   // col D
    var dateAffected  = rowData[5];   // col F: "DD-MM-YYYY"
    var newShift      = rowData[7];   // col H

    var sheetTabName  = monthLabel.replace(' ', '_');
    var rosterSheet   = ss.getSheetByName(sheetTabName);

    if (!rosterSheet) {
      return { ok: true, warning: 'Status updated but roster sheet "' + sheetTabName + '" not found' };
    }

    var dayNum     = parseInt(dateAffected.split('-')[0]);
    var rosterData = rosterSheet.getDataRange().getValues();
    var empRow     = -1;

    for (var j = 3; j < rosterData.length; j++) {
      if (rosterData[j][1] && rosterData[j][1].trim().toLowerCase() === empName.trim().toLowerCase()) {
        empRow = j + 1;
        break;
      }
    }

    if (empRow === -1) {
      return { ok: true, warning: 'Status updated but employee "' + empName + '" not found in roster' };
    }

    var shiftCol  = dayNum + 2;
    var cellColor = getShiftColor(newShift);
    var cell      = rosterSheet.getRange(empRow, shiftCol);
    cell.setValue(newShift);
    cell.setBackground(cellColor.bg);
    cell.setFontColor(cellColor.fg);
    cell.setFontWeight('bold');
    cell.setHorizontalAlignment('center');

    // ── AUTO-SYNC: write flag for the affected employee ───────────────────────
    var empEmail = getEmployeeEmail(ss, empName);
    writeSyncFlagInternal(ss, empEmail);
    // ─────────────────────────────────────────────────────────────────────────
  }

  return { ok: true, message: 'Request ' + action.toLowerCase() + ' successfully' };
}

// ═══════════════════════════════════════════════════════════════
//  ACTION 3 — Direct Shift Edit (Admin only)
//  Updates a single cell in the roster + logs to Leave_Swap_Log
// ═══════════════════════════════════════════════════════════════
function editShift(body) {
  var ss          = SpreadsheetApp.openById(SHEET_ID);
  var sheetTab    = body.month;
  var empRowIndex = body.empRowIndex;
  var dayNum      = body.day;
  var newCode     = body.newCode;
  var oldCode     = body.oldCode;
  var empName     = body.empName;
  var adminEmail  = body.adminEmail || 'admin';

  var rosterSheet = ss.getSheetByName(sheetTab);
  if (!rosterSheet) throw new Error('Sheet "' + sheetTab + '" not found');

  var sheetRow  = parseInt(empRowIndex) + 4;
  var shiftCol  = parseInt(dayNum) + 2;
  var cellColor = getShiftColor(newCode);
  var cell      = rosterSheet.getRange(sheetRow, shiftCol);

  cell.setValue(newCode);
  cell.setBackground(cellColor.bg);
  cell.setFontColor(cellColor.fg);
  cell.setFontWeight('bold');
  cell.setHorizontalAlignment('center');

  var logSheet = ss.getSheetByName('Leave_Swap_Log');
  if (logSheet) {
    var editId  = 'EDIT-' + new Date().getTime().toString().slice(-6);
    var today   = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy');
    var month   = sheetTab.replace('_', ' ');
    var moNum   = String(MONTH_ORDER.indexOf(sheetTab.split('_')[0]) + 1).padStart(2, '0');
    var yr      = sheetTab.split('_')[1];
    var dateStr = String(dayNum).padStart(2, '0') + '-' + moNum + '-' + yr;

    logSheet.appendRow([
      editId, today, month, empName, 'Admin Edit',
      dateStr, oldCode, newCode, '—', 'Approved', adminEmail, today
    ]);
    logSheet.getRange(logSheet.getLastRow(), 10).setBackground('#E2EFDA');
  }

  // ── AUTO-SYNC: write flag for the affected employee ─────────────────────────
  var empEmail = getEmployeeEmail(ss, empName);
  writeSyncFlagInternal(ss, empEmail);
  // ───────────────────────────────────────────────────────────────────────────

  return { ok: true, message: empName + ' Day ' + dayNum + ': ' + oldCode + ' → ' + newCode };
}

// ═══════════════════════════════════════════════════════════════
//  ACTION 4 — Update Sync Flag (callable externally or internally)
//  Writes a timestamp to Sync_Flags for a given employee email.
//  Sync_Flags layout: A=email (lowercase), B=ISO timestamp
//  Row 1 = header. Data starts at row 2.
// ═══════════════════════════════════════════════════════════════
function updateSyncFlag(body) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var empEmail = (body.empEmail || '').toLowerCase();
  if (!empEmail) return { ok: false, error: 'empEmail is required' };

  writeSyncFlagInternal(ss, empEmail);
  return { ok: true, message: 'Sync flag updated for ' + empEmail };
}

// ── Internal helper: write/update Sync_Flags for a given email ───────────────
function writeSyncFlagInternal(ss, empEmail) {
  if (!empEmail) return;
  var email = empEmail.toLowerCase();

  var flagSheet = ss.getSheetByName('Sync_Flags');
  if (!flagSheet) {
    flagSheet = ss.insertSheet('Sync_Flags');
    flagSheet.appendRow(['Email', 'Last Updated']);
  }

  var ts   = new Date().toISOString();
  var data = flagSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if ((data[i][0] || '').toString().toLowerCase() === email) {
      flagSheet.getRange(i + 1, 2).setValue(ts);
      return;
    }
  }

  flagSheet.appendRow([email, ts]);
}

// ── Look up employee email by name from Employee_Master ───────────────────────
function getEmployeeEmail(ss, empName) {
  var empSheet = ss.getSheetByName('Employee_Master');
  if (!empSheet) return null;

  var data = empSheet.getDataRange().getValues();
  for (var i = 2; i < data.length; i++) {
    if (data[i][1] && data[i][1].toString().trim().toLowerCase() === empName.trim().toLowerCase()) {
      return (data[i][3] || '').toString().trim().toLowerCase();
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  ACTION 5 — Email Notifications
//  Called by the Cloudflare Worker (via GET ?payload=...) after:
//    'request_submitted' — employee submits a request
//    'request_processed' — admin approves or rejects a request
//    'shift_edited'      — admin directly edits a shift cell
//
//  Uses MailApp.sendEmail() which executes under the script owner's
//  Gmail account. No SMTP setup required.
// ═══════════════════════════════════════════════════════════════
function emailNotify(body) {
  var ss       = SpreadsheetApp.openById(SHEET_ID);
  var empSheet = ss.getSheetByName('Employee_Master');
  if (!empSheet) return { ok: false, error: 'Employee_Master not found' };
  var empData  = empSheet.getDataRange().getValues();

  // ── Collect all admin emails from Employee_Master col F ────────────────────
  function getAdminEmails() {
    var admins = [];
    for (var i = 2; i < empData.length; i++) {
      if (empData[i][5] === 'Yes' && empData[i][3]) {
        admins.push(empData[i][3].toString().trim());
      }
    }
    return admins;
  }

  var scenario = body.scenario;

  // ── Scenario 1: Employee submitted a request ────────────────────────────────
  if (scenario === 'request_submitted') {
    var subject    = '[SOC Roster] New ' + (body.reqType || 'Request') + ' — ' + body.empName;
    var adminBody  =
      'A new request has been submitted.\n\n' +
      'Employee   : ' + body.empName + '\n' +
      'Request ID : ' + body.reqId   + '\n' +
      'Type       : ' + body.reqType + '\n' +
      'Month      : ' + body.month   + '\n' +
      'Date       : ' + body.dateAffected + '\n' +
      'Shift      : ' + body.originalShift + ' → ' + body.newShift +
      (body.swapPartner && body.swapPartner !== '—' ? '\nSwap With  : ' + body.swapPartner : '') +
      '\n\nPlease review and action this request in the SOC Roster Hub Admin Panel.';

    // Notify all admins
    getAdminEmails().forEach(function(adminEmail) {
      try { MailApp.sendEmail(adminEmail, subject, adminBody); } catch(e) {}
    });

    // Confirmation to the employee who submitted
    if (body.empEmail) {
      var empBody =
        'Hi ' + body.empName + ',\n\n' +
        'Your request has been received and is pending admin approval.\n\n' +
        'Request ID : ' + body.reqId + '\n' +
        'Type       : ' + body.reqType + '\n' +
        'Date       : ' + body.dateAffected + '\n' +
        'Shift      : ' + body.originalShift + ' → ' + body.newShift + '\n\n' +
        'You will receive another email once the admin reviews your request.\n\n' +
        '— SOC Roster Hub';
      try {
        MailApp.sendEmail(body.empEmail,
          '[SOC Roster] Request received — ' + body.reqId, empBody);
      } catch(e) {}
    }

  // ── Scenario 2: Admin approved or rejected a request ───────────────────────
  } else if (scenario === 'request_processed') {
    if (!body.empEmail) return { ok: false, error: 'empEmail required for request_processed' };

    var approved  = (body.decision === 'Approved');
    var empBody   =
      'Hi ' + body.empName + ',\n\n' +
      'Your ' + (body.reqType || 'request') + ' has been ' +
      body.decision.toLowerCase() + ' by ' + (body.adminEmail || 'the admin') + '.\n\n' +
      'Request ID : ' + body.reqId + '\n' +
      'Date       : ' + body.dateAffected + '\n' +
      'New Shift  : ' + body.newShift +
      (approved
        ? '\n\nYour roster has been updated. If you have calendar auto-sync enabled, your SOC Roster calendar will refresh automatically.'
        : '\n\nNo changes have been made to your roster. Please contact your admin if you have questions.') +
      '\n\n— SOC Roster Hub';

    try {
      MailApp.sendEmail(body.empEmail,
        '[SOC Roster] Your request has been ' + body.decision + ' — ' + body.reqId,
        empBody);
    } catch(e) {}

  // ── Scenario 3: Admin directly edited a shift ───────────────────────────────
  } else if (scenario === 'shift_edited') {
    if (!body.empEmail) return { ok: false, error: 'empEmail required for shift_edited' };

    var monthLabel = (body.month || '').replace('_', ' ');
    var empBody    =
      'Hi ' + body.empName + ',\n\n' +
      'Your shift has been updated by the admin.\n\n' +
      'Month : ' + monthLabel + '\n' +
      'Day   : ' + body.day   + '\n' +
      'From  : ' + body.oldCode + '\n' +
      'To    : ' + body.newCode + '\n\n' +
      'If you have calendar auto-sync enabled, your SOC Roster calendar will refresh automatically.\n\n' +
      '— SOC Roster Hub';

    try {
      MailApp.sendEmail(body.empEmail,
        '[SOC Roster] Shift updated — ' + monthLabel + ', Day ' + body.day,
        empBody);
    } catch(e) {}

  } else {
    return { ok: false, error: 'Unknown emailNotify scenario: ' + scenario };
  }

  return { ok: true, message: 'Email(s) sent for: ' + scenario };
}

// ═══════════════════════════════════════════════════════════════
//  HELPER — Shift cell colors
// ═══════════════════════════════════════════════════════════════
function getShiftColor(code) {
  var colors = {
    'MS':     { bg: '#9DC3E6', fg: '#000000' },
    'GS':     { bg: '#2F75B6', fg: '#FFFFFF' },
    'AS':     { bg: '#F4B183', fg: '#000000' },
    'NS':     { bg: '#7030A0', fg: '#FFFFFF' },
    'WFH-MS': { bg: '#B8E4F9', fg: '#1F5C7A' },
    'WFH-GS': { bg: '#B8E4F9', fg: '#1F5C7A' },
    'WFH-AS': { bg: '#B8E4F9', fg: '#1F5C7A' },
    'WFH-NS': { bg: '#B8E4F9', fg: '#1F5C7A' },
    'WO':     { bg: '#D9D9D9', fg: '#595959' },
    'VL':     { bg: '#000000', fg: '#FFFFFF' },
    'CL':     { bg: '#FF0000', fg: '#FFFFFF' },
    'CO':     { bg: '#FFFF00', fg: '#000000' },
    'GH':     { bg: '#A9D18E', fg: '#000000' }
  };
  if (code && code.indexOf('WFH') === 0) return colors['WFH-MS'];
  return colors[code] || { bg: '#D9D9D9', fg: '#595959' };
}
