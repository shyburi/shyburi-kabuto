#!/usr/bin/env python3
"""トランプ関税関連ニュースを全番組から取得してD1に格納（topic='trump'）"""
import urllib.request, urllib.parse, json, subprocess, sys, uuid

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

KEYWORDS = ['トランプ', '関税', '米中', '貿易戦争', '通商', '米国関税', 'ＵＳＭＣＡ']

NEWS_KEYWORDS = ['ニュース', 'news', 'ｅｖｅｒｙ', 'バンキシャ', 'ミヤネ', 'ストレイト', 'ジグザグ', 'シューイチ', 'ＺＩＰ', 'ＤａｙＤａｙ', 'Ｏｈａ', 'ｂｉｚ']

QUARTERS = [
    ('2025-01-01', '2025-03-31'),
    ('2025-04-01', '2025-06-30'),
    ('2025-10-01', '2025-12-28'),
]

def get_news_programs():
    url = f"{NTV_BASE}/programs"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    return [p for p in data['items'] if any(k in p.get('title_name', '') for k in NEWS_KEYWORDS)]

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
                hits.append({'date': b.get('onair_date', ''), 'headline': headline.replace("'", "''")})
    return hits

print("=== Step1: 番組リスト取得 ===")
programs = get_news_programs()
print(f"{len(programs)}番組を対象\n")

print("=== Step2: データ収集 ===")
all_articles = []
for p in programs:
    tid = p['title_id']
    pname = p['title_name']
    count = 0
    for dfrom, dto in QUARTERS:
        try:
            hits = fetch_corners(tid, dfrom, dto)
            for h in hits:
                h['program'] = pname
                h['id'] = str(uuid.uuid4())
            all_articles.extend(hits)
            count += len(hits)
        except: pass
    if count > 0:
        print(f"  {pname}: {count}件")

print(f"\n合計 {len(all_articles)} 件収集\n")
if len(all_articles) == 0:
    sys.exit(0)

print("=== Step3: D1に格納 ===")
success = 0
for a in all_articles:
    cmd = (f"INSERT OR IGNORE INTO scored_articles (id, program, headline, date, score_y, score_z, score_color, topic) "
           f"VALUES ('{a['id']}', '{a['program']}', '{a['headline']}', '{a['date']}', 0.0, 0.0, 0.0, 'trump');")
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'blog', '--local', '--command', cmd], capture_output=True, text=True)
    if '1 command' in r.stdout: success += 1

print(f"完了: {success}/{len(all_articles)}件")
