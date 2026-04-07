import os
import re

dir_path = r'c:\Users\cahya\OneDrive\Desktop\IoT-CarMonitoring'

# Replace sidebar-vehicle-chip in all HTML files
pattern = re.compile(
    r'<div[^>]*?style="margin:\s*12px;[^>]*?border:\s*1px\s*solid\s*rgba\(255,\s*255,\s*255,\s*0\.1\);?"[^>]*>\s*<div[^>]*?>\s*Kendaraan Aktif\s*</div>\s*<div[^>]*?id="sidebar-vehicle-name"[^>]*>.*?</div>\s*<div[^>]*?id="sidebar-device-id"[^>]*>.*?</div>\s*</div>',
    re.DOTALL | re.IGNORECASE
)

replacement = """<div class="sidebar-vehicle-chip">
                <div class="sidebar-vehicle-chip-label">Kendaraan Aktif</div>
                <div class="sidebar-vehicle-chip-name" id="sidebar-vehicle-name">–</div>
                <div class="sidebar-vehicle-chip-id" id="sidebar-device-id">–</div>
            </div>"""

count = 0
for file in os.listdir(dir_path):
    if file.endswith('.html'):
        filepath = os.path.join(dir_path, file)
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        new_content, num_subs = pattern.subn(replacement, content)
        if num_subs > 0:
            count += num_subs
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)

print(f"Updated {count} HTML files with new sidebar-vehicle-chip")

# Fix history.html specific trip-card white color issue
hist_path = os.path.join(dir_path, 'history.html')
if os.path.exists(hist_path):
    with open(hist_path, 'r', encoding='utf-8') as f:
        hist = f.read()

    # The string to replace might have different whitespace, let's use regex
    # Before: .trip-card { background: white; border-radius: 16px; border: 1px solid rgba(226, 232, 240, 0.7);
    trip_card_pattern = re.compile(r'\.trip-card\s*\{\s*background:\s*white;\s*border-radius:\s*16px;\s*border:\s*1px\s*solid\s*rgba\(226,\s*232,\s*240,\s*0\.7\);')
    trip_card_repl = """.trip-card {
            background: var(--surface);
            border-radius: 16px;
            border: 1px solid var(--border-glass);"""
    hist, subs = trip_card_pattern.subn(trip_card_repl, hist)
    if subs > 0:
        with open(hist_path, 'w', encoding='utf-8') as f:
            f.write(hist)
        print("Updated history.html .trip-card styles for dark mode compatibility")
    else:
        print("Did not find .trip-card style pattern in history.html")

