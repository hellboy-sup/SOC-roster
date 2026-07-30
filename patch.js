const fs = require('fs');

let html = fs.readFileSync('frontend/index.html', 'utf8');

// 1. Add config.js script tag in head
html = html.replace('</title>', '</title>\n<script src="config.js"></script>');

// 2. Replace configuration block
const configRegex = /const SHEET_ID[\s\S]*?const SCOPES\s*=\s*'[^']+';/;
const newConfig = `const SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send';`;
html = html.replace(configRegex, newConfig);

// 3. Replace callAppsScript definition with callWorker
html = html.replace(/async function callAppsScript\(payload\) \{[\s\S]*?body: JSON.stringify\(\{ \.\.\.payload, token: token \}\)[\s\S]*?\}\n/,
`async function callWorker(payload) {
  const resp = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${token}\` },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error('Worker HTTP ' + resp.status);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Worker error');
  return data;
}
`);

// Rename all remaining callAppsScript to callWorker
html = html.replace(/callAppsScript/g, 'callWorker');

// 4. Remove sheetsRead, sheetsWrite, sheetsAppend definitions
const sheetsFuncsRegex = /async function sheetsRead\(range\) \{[\s\S]*?\}\s*async function sheetsWrite\(range, values\) \{[\s\S]*?\}\s*async function sheetsAppend\(sheetName, values\) \{[\s\S]*?catch\(e\) \{\s*console\.error\('sheetsAppend error:', e\);\s*throw e;\s*\}\s*\}/;
html = html.replace(sheetsFuncsRegex, '');

// 5. Update sheetsRead usages
html = html.replace("const empRows = await sheetsRead('Employee_Master!A3:F25');", "const resEmp = await callWorker({ action: 'getEmployeeMaster' });\n    const empRows = resEmp.data;");
html = html.replace("const rows = await sheetsRead(`${month}!A4:${lastCol}22`);", "const resRost = await callWorker({ action: 'getRoster', month });\n    const rows = resRost.data;");
html = html.replace("const rows = await sheetsRead('Leave_Swap_Log!A3:L500');", "const resLog = await callWorker({ action: 'getLeaveLog' });\n    const rows = resLog.data;");

// 6. Update initApp availableMonths fetching
const getAvailableMonthsRegex = /const meta = await\s*apiFetch\(`https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/\$\{SHEET_ID\}\?fields=sheets\.properties\.title`\);\s*availableMonths = meta\.sheets\s*\.map\(s => s\.properties\.title\)\s*\.filter\(t => MONTH_ORDER\.some\(m => t === m \+ '_' \+ t\.split\('_'\)\[1\] && \/^\d\{4\}\$\/\.test\(t\.split\('_'\)\[1\]\)\)\)\s*\.sort\(\(a, b\) => \{\s*const \[ma, ya\] = a\.split\('_'\), \[mb, yb\] = b\.split\('_'\);\s*return ya !== yb \? \+ya - \+yb : MONTH_ORDER\.indexOf\(ma\) - MONTH_ORDER\.indexOf\(mb\);\s*\}\);/;
html = html.replace(getAvailableMonthsRegex, `const metaResp = await callWorker({ action: 'getAvailableMonths' });\n    availableMonths = metaResp.data;`);

// 7. Update handleToken to use checkAdminStatus
const handleTokenRegex = /isAdmin\s*=\s*userEmail\.toLowerCase\(\)\s*===\s*ADMIN_EMAIL\.toLowerCase\(\);[\s\S]*?await initApp\(\);/;
const newHandleToken = `const adminResp = await callWorker({ action: 'checkAdminStatus' });
      isAdmin = adminResp.isAdmin;
      
      // Also check Employee_Master for admin flag (supports multiple admins)
      // This is re-checked after employeeMaster loads in initApp()
      await initApp();`;
html = html.replace(handleTokenRegex, newHandleToken);

fs.writeFileSync('frontend/index.html', html, 'utf8');
console.log('Patched frontend/index.html successfully');
