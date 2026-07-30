
import re

with open('soc_roster_final_v20.html', 'r', encoding='utf-8') as f:
    html = f.read()

css_match = re.search(r'<style>([\s\S]*?)</style>', html)
css = css_match.group(1) if css_match else ''

script_match = re.search(r'<script>([\s\S]*?)</script>', html)
js = script_match.group(1) if script_match else ''

body_match = re.search(r'<body[^>]*>([\s\S]*?)<script>', html)
body = body_match.group(1) if body_match else ''

# Clean CSS
lines = css.split('\n')
out_lines = []
for line in lines:
    if line.strip().startswith('@') or not line.strip():
        out_lines.append(line)
        continue
    if '{' in line:
        out_lines.append('#rb-container ' + line.strip())
    else:
        out_lines.append(line)

clean_css = '\n'.join(out_lines)
clean_css = clean_css.replace('body {', '#rb-container {')
clean_css = clean_css.replace('table {', '#rb-container table {')

with open('frontend/styles/roster-builder.css', 'w', encoding='utf-8') as f:
    f.write(clean_css)

# Clean JS
# Remove EMPS_DEFAULT and let emps =
js = re.sub(r'const EMPS_DEFAULT\s*=\s*\[[\s\S]*?\];', '', js)
js = re.sub(r'let emps\s*=\s*JSON\.parse\(JSON\.stringify\(EMPS_DEFAULT\)\);', 'let emps = [];', js)

clean_js = f"""const RosterBuilder = (function() {{
{js}

  return {{
    initEmps: function(empMaster) {{
       emps = empMaster.map(e => ({{
         id: e.slNo,
         name: e.name,
         dept: e.shiftGroup,
         type: e.role === 'SOC Analyst' ? 'Rotating' : 'General'
       }}));
       renderEmpTable();
       resetCarryUI();
       initUI();
    }},
    buildRoster: buildRoster
  }};
}})();"""

with open('frontend/modules/admin/roster-engine.js', 'w', encoding='utf-8') as f:
    f.write(clean_js)

# HTML UI
ui_js = f"""const RosterBuilderUI = `
<div id="rb-container">
{body}
</div>
`;
"""
with open('frontend/modules/admin/roster-builder-ui.js', 'w', encoding='utf-8') as f:
    f.write(ui_js)

print("Extraction complete.")
