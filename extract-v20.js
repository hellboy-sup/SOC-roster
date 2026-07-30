const fs = require('fs');

const htmlContent = fs.readFileSync('soc_roster_final_v20.html', 'utf8');

const cssMatch = htmlContent.match(/<style>([\s\S]*?)<\/style>/);
const css = cssMatch ? cssMatch[1] : '';

const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/);
const js = scriptMatch ? scriptMatch[1] : '';

// The body is everything between </header> (or <body>) and <script>
// Looking at v20, let's just grab the whole body innerHTML
let bodyHtml = htmlContent.match(/<body[^>]*>([\s\S]*?)<script>/)[1];

// 1. Scoped CSS
let scopedCss = css.split('\n').map(line => {
  if (line.trim().startsWith('@') || line.trim() === '') return line;
  if (line.includes('{')) {
    // Basic prefixing (won't catch all edge cases but good enough for simple CSS)
    return '#rb-container ' + line.trim();
  }
  return line;
}).join('\n');
// We will just do a simpler CSS wrapper using standard CSS nesting or just keep it simple
// Wait, standard CSS doesn't support nesting without a preprocessor or modern CSS.
// Let's just write raw CSS, we'll manually namespace the few global tags like body, table.
let cleanCss = css.replace(/body\s*\{/g, '#rb-container {')
                  .replace(/table\s*\{/g, '#rb-container table {')
                  .replace(/th,\s*td\s*\{/g, '#rb-container th, #rb-container td {')
                  .replace(/button\s*\{/g, '#rb-container button {')
                  .replace(/select\s*\{/g, '#rb-container select {');

fs.writeFileSync('frontend/styles/roster-builder.css', cleanCss);

// 2. IIFE for JS
let cleanJs = `const RosterBuilder = (function() {
${js}

  // Expose initEmps and build
  return {
    initEmps: function(empMaster) {
       // mapping employeeMaster to EMPS_DEFAULT format
       emps = empMaster.map(e => ({
         id: e.slNo,
         name: e.name,
         dept: e.shiftGroup,
         type: e.role === 'SOC Analyst' ? 'Rotating' : 'General'
       }));
       renderEmpTable();
       resetCarryUI();
       initUI();
    },
    buildRoster: buildRoster
  };
})();`;

// Wait, the v20 script has "const EMPS_DEFAULT" and "let emps = ...". 
// We'll replace it.
cleanJs = cleanJs.replace(/const EMPS_DEFAULT = \[[\s\S]*?\];/, '');
cleanJs = cleanJs.replace(/let emps = JSON\.parse\(JSON\.stringify\(EMPS_DEFAULT\)\);/, 'let emps = [];');

fs.writeFileSync('frontend/modules/admin/roster-engine.js', cleanJs);

// 3. HTML 
fs.writeFileSync('frontend/modules/admin/roster-builder-ui.js', `
const RosterBuilderUI = \`
<div id="rb-container">
\${bodyHtml}
</div>
\`;
`);

console.log('Extraction complete');
