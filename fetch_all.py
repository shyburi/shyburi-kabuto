#!/usr/bin/env python3
"""全トピックのデータを取得してD1に一括格納"""
import urllib.request, urllib.parse, json, subprocess, sys, uuid, os
from collections import Counter

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

NEWS_KEYWORDS = ['ニュース', 'news', 'ｅｖｅｒｙ', 'バンキシャ', 'ミヤネ', 'ストレイト', 'ジグザグ', 'シューイチ', 'ＺＩＰ', 'ＤａｙＤａｙ', 'Ｏｈａ', 'ｂｉｚ']

QUARTERS = [
    ('2025-01-01', '2025-03-31'),
    ('2025-04-01', '2025-06-30'),
    ('2025-10-01', '2025-12-28'),
]

TOPICS = {
    'fuji_tv': ['フジテレビ', '中居正広', '中居', 'フジ・メディア', 'フジＴＶ', '女性トラブル', '第三者委員会'],
    'trump':   ['トランプ', '関税', '米中', '貿易戦争', '通商', '米国関税'],
    'ukraine': ['ウクライナ', 'ロシア軍', '停戦', 'ゼレンスキー', 'ロシア侵攻', 'ウクライナ支援'],
}

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
        return json.load(r)

# ─── Step1: 番組リスト取得 ────────────────────────────────────────────────────
print("=== Step1: 番組リスト取得 ===")
programs = get_news_programs()
print(f"{len(programs)}番組を対象\n")

# ─── Step2: 全番組・全トピックのデータ収集 ────────────────────────────────────
print("=== Step2: データ収集 ===")
all_articles = []

for p in programs:
    pname = p['title_name']
    for dfrom, dto in QUARTERS:
        try:
            data = fetch_corners(p['title_id'], dfrom, dto)
            for b in data.get('broadcasts', []):
                for c in b.get('corners', []):
                    headline = c.get('headline', '')
                    for topic, keywords in TOPICS.items():
                        if any(k in headline for k in keywords):
                            all_articles.append({
                                'id': str(uuid.uuid4()),
                                'program': pname,
                                'headline': headline.replace("'", "''"),
                                'date': b.get('onair_date', ''),
                                'topic': topic,
                                'duration': c.get('duration', 0),
                                'genre': c.get('headline_genre', '').replace("'", "''"),
                                'memo': c.get('memo', '').replace("'", "''"),
                                'corner_start_time': c.get('corner_start_time', ''),
                            })
                            break
        except: pass

topic_counts = Counter(a['topic'] for a in all_articles)
for topic, cnt in topic_counts.items():
    print(f"  {topic}: {cnt}件")
print(f"\n合計 {len(all_articles)} 件収集\n")

if len(all_articles) == 0:
    sys.exit(0)

# ─── Step3: SQLファイルに書き出して一括実行 ───────────────────────────────────
print("=== Step3: D1に一括格納 ===")
sql_file = 'insert_all.sql'

with open(sql_file, 'w', encoding='utf-8') as f:
    for a in all_articles:
        f.write(
            f"INSERT OR IGNORE INTO scored_articles "
            f"(id, program, headline, date, score_y, score_z, score_color, topic, duration, genre, memo, corner_start_time) "
            f"VALUES ('{a['id']}', '{a['program']}', '{a['headline']}', "
            f"'{a['date']}', 0.0, 0.0, 0.0, '{a['topic']}', "
            f"{a['duration']}, '{a['genre']}', '{a['memo']}', '{a['corner_start_time']}');\n"
        )

print(f"SQLファイル生成: {sql_file} ({len(all_articles)}件)")

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local', '--file', sql_file],
    capture_output=True, text=True
)
if '1 command' in result.stdout or 'successfully' in result.stdout:
    print(f"完了: {len(all_articles)}件を一括挿入しました")
else:
    print("エラー:", result.stderr[:200])

os.remove(sql_file)
