#!/usr/bin/env python3
"""
能登復興関連ニュースを取得してD1に格納（topic='noto'）
"""
import urllib.request, urllib.parse, json, subprocess, sys, uuid

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

KEYWORDS = [
    '能登', '能登半島', '能登地震', '能登復興',
    '輪島', '珠洲', '七尾', '穴水', '志賀',
    '石川県 震災', '石川県 復興', '被災地 石川',
]

PROGRAMS = [('ｽRW9', 'ストレイトニュース'), ('ｼ1ML', 'バンキシャ'), ('ﾐLR6', 'ミヤネ屋')]
QUARTERS = [
    ('2025-01-01', '2025-03-31'),
    ('2025-04-01', '2025-06-30'),
    ('2025-07-01', '2025-09-30'),
    ('2025-10-01', '2025-12-28'),
]

def fetch_corners(title_id, date_from, date_to):
    tid_enc = urllib.parse.quote(title_id, safe='')
    url = f"{NTV_BASE}/programs/{tid_enc}/details?date_from={date_from}&date_to={date_to}&include=corners"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    hits = []
    for b in data.get('broadcasts', []):
        for c in b.get('corners', []):
            headline = c.get('headline', '')
            if any(k in headline for k in KEYWORDS):
                hits.append({
                    'date': b.get('onair_date', ''),
                    'headline': headline.replace("'", "''"),
                })
    return hits

print("=== Step1: データ収集 ===")
all_articles = []
for tid, pname in PROGRAMS:
    for dfrom, dto in QUARTERS:
        try:
            hits = fetch_corners(tid, dfrom, dto)
            print(f"  {pname} {dfrom[:7]}: {len(hits)}件")
            for h in hits:
                h['program'] = pname
                h['id'] = str(uuid.uuid4())
            all_articles.extend(hits)
        except Exception as e:
            print(f"  {pname} {dfrom[:7]}: ERR {e}")

print(f"\n合計 {len(all_articles)} 件収集\n")

if len(all_articles) == 0:
    print("データが見つかりませんでした。")
    sys.exit(0)

print("=== Step2: D1に格納 ===")
success = 0
for article in all_articles:
    cmd = (
        f"INSERT OR IGNORE INTO scored_articles "
        f"(id, program, headline, date, score_y, score_z, score_color, topic) "
        f"VALUES ('{article['id']}', '{article['program']}', '{article['headline']}', "
        f"'{article['date']}', 0.0, 0.0, 0.0, 'noto');"
    )
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local', '--command', cmd],
        capture_output=True, text=True
    )
    if '1 command' in result.stdout:
        success += 1

print(f"D1格納完了: {success}/{len(all_articles)}件")

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', "SELECT COUNT(*) as cnt FROM scored_articles WHERE topic='noto';"],
    capture_output=True, text=True
)
print(result.stdout[-200:])
