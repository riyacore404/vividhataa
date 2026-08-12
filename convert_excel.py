"""
convert_excel.py
Run this to regenerate the embedded data inside gaming-sports/round1.html.

Security model:
  - Emails are stored as SHA-256 hashes (irreversible).
  - Names are stored in plain text (needed for the welcome message).
  - The output is injected directly into round1.html — no external JSON fetch.

Usage:
  python convert_excel.py
"""

import json
import hashlib
import re
import openpyxl

XLSX_FILE    = "Final_list.xlsx"
HTML_FILE    = "gaming-sports/round1.html"
TEAM_KEYWORD = "Gaming and Sports Team"

# Marker comments in the HTML that wrap the injected data block
MARKER_START = "/* __DATA_START__ */"
MARKER_END   = "/* __DATA_END__ */"


def sha256_email(email: str) -> str:
    """Return lowercase SHA-256 hex digest of the normalised email."""
    normalised = email.strip().lower()
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


# ── Read Excel ────────────────────────────────────────────────────────────────
wb = openpyxl.load_workbook(XLSX_FILE)
ws = wb.active

candidates = []
for row in ws.iter_rows(min_row=2, values_only=True):
    name  = row[1]   # Col B
    email = row[2]   # Col C
    pref1 = row[3]   # Col D
    pref2 = row[4]   # Col E
    branch = row[7]  # Col H
    section = row[9] # Col J

    if not email:
        continue

    pref1_str = str(pref1).strip() if pref1 else ""
    pref2_str = str(pref2).strip() if pref2 else ""

    is_pref1 = TEAM_KEYWORD in pref1_str
    is_pref2 = TEAM_KEYWORD in pref2_str

    if is_pref1 or is_pref2:
        candidates.append({
            "name":      str(name).strip() if name else "Candidate",
            "emailHash": sha256_email(str(email)),
            "branch":    str(branch).strip() if branch else "N/A",
            "section":   str(section).strip() if section else "N/A",
            "pref":      1 if is_pref1 else 2
        })

print(f"[+] {len(candidates)} Gaming & Sports candidates found.")
print(f"    Pref 1: {sum(1 for c in candidates if c['pref'] == 1)}")
print(f"    Pref 2: {sum(1 for c in candidates if c['pref'] == 2)}")

# ── Inject into HTML ──────────────────────────────────────────────────────────
with open(HTML_FILE, "r", encoding="utf-8") as f:
    html = f.read()

data_js = f"const CANDIDATES = {json.dumps(candidates, ensure_ascii=False, separators=(',', ':'))};"

pattern = re.compile(
    re.escape(MARKER_START) + r".*?" + re.escape(MARKER_END),
    re.DOTALL
)

replacement = f"{MARKER_START}\n        {data_js}\n        {MARKER_END}"

if not re.search(pattern, html):
    print("[!] Markers not found in HTML. Make sure the HTML has the marker comments.")
else:
    html_new = re.sub(pattern, replacement, html)
    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(html_new)
    print(f"[+] Injected hashed data into {HTML_FILE}")
    print("[+] Done! No plain-text emails stored anywhere.")
