#!/usr/bin/env python3
"""
外国人労働者・技能実習関連ニュースを取得してD1に格納（topic='foreign_worker'）
"""
import urllib.request, urllib.parse, json, subprocess, sys, uuid

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

KEYWORDS = [
    '技能実習', '外国人労働者', '外国人実習生', '特定技能',
    '実習制度', '技能実習制度', '外国人雇用', '外国人就労',
    '労働搾取', '強制労働', '人権侵害', '失踪実習生',
    '送出し機関', '監理団体', '外国人受入', '育成就労',
    '入管', '技能実習生', '不法就労', '外国人共生',
]

PROGRAMS = [('ｽRW9', 'ストレイトニュース'), ('ｼ1ML', 'バンキシャ'), ('ﾐLR6', 'ミヤネ屋')]
QUARTERS = [
    ('2025-01-01', '2025-03-31'),
    ('2025-04-01', '2025-06-30'),
    ('2025-07-01', '2025-09-30'),
    ('2025-10-01', '2025-12-28'),
]

# ─── Step1: データ収集 ────────────────────────────────────────────────────────

def fetch_corners(title_id, date_from, date_to):
    tid_enc = urllib.parse.quote(title_id, safe='')
    url = f"{NTV_BASE}/programs/{tid_enc}/details?date_from={date_from}&date_to={date_to}&include=corners"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    hits = []
    for b in data.get('broadcasts', []):
        for c in b.get('corners', []):
            text = c.get('headline', '') + c.get('memo', '')
            if any(k in text for k in KEYWORDS):
                hits.append({
                    'date': b.get('onair_date', ''),
                    'headline': c.get('headline', '').replace("'", "''"),
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

# ─── Step2: D1に格納（topic='foreign_worker'） ────────────────────────────────

print("=== Step2: D1に格納 ===")
success = 0
for article in all_articles:
    cmd = (
        f"INSERT OR IGNORE INTO scored_articles "
        f"(id, program, headline, date, score_y, score_z, score_color, topic) "
        f"VALUES ('{article['id']}', '{article['program']}', '{article['headline']}', "
        f"'{article['date']}', 0.0, 0.0, 0.0, 'foreign_worker');"
    )
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local', '--command', cmd],
        capture_output=True, text=True
    )
    if 'success' in result.stdout or '1 command' in result.stdout:
        success += 1
    else:
        # エラー内容を表示（デバッグ用）
        if result.stderr:
            print(f"  ERR: {result.stderr[:100]}")

print(f"D1格納完了: {success}/{len(all_articles)}件")

# ─── 確認 ─────────────────────────────────────────────────────────────────────

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', "SELECT COUNT(*) as cnt FROM scored_articles WHERE topic='foreign_worker';"],
    capture_output=True, text=True
)
print(result.stdout[-300:])
