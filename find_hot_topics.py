#!/usr/bin/env python3
"""
全番組の2025年コーナーデータを総浚いして、
頻出キーワード・トピックをランキングする
"""
import urllib.request, urllib.parse, json
from collections import defaultdict

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

def get(path):
    url = f"{NTV_BASE}{path}"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

# ─── Step1: 全番組リスト取得 ──────────────────────────────────────────────────
print("=== Step1: 全番組リスト取得 ===")
data = get('/programs')
programs = data['items']
# 対象番組を絞る
NEWS_KEYWORDS = ['ニュース', 'news', 'ｅｖｅｒｙ', 'バンキシャ', 'ミヤネ', 'ストレイト', 'ジグザグ', 'シューイチ', 'ＺＩＰ', 'ＤａｙＤａｙ', 'Ｏｈａ', 'ｂｉｚ']
regulars = [p for p in programs if any(k in p.get('title_name', '') for k in NEWS_KEYWORDS)]
print(f"全番組: {len(programs)}件 / ニュース番組: {len(regulars)}件")
for p in regulars:
    print(f"  - {p['title_name']}")
print()

# ─── Step2: 各番組のコーナーデータ収集 ────────────────────────────────────────
print("=== Step2: コーナーデータ収集（Q1〜Q2のみ） ===")

QUARTERS = [('2025-01-01', '2025-03-31'), ('2025-04-01', '2025-06-30')]

all_headlines = []
program_counts = {}

for p in regulars:
    tid = urllib.parse.quote(p['title_id'], safe='')
    pname = p['title_name']
    count = 0
    for dfrom, dto in QUARTERS:
        try:
            url = f"/programs/{tid}/details?date_from={dfrom}&date_to={dto}&include=corners"
            d = get(url)
            for b in d.get('broadcasts', []):
                for c in b.get('corners', []):
                    h = c.get('headline', '')
                    if h:
                        all_headlines.append({
                            'program': pname,
                            'date': b.get('onair_date', ''),
                            'headline': h,
                        })
                        count += 1
        except:
            pass
    if count > 0:
        program_counts[pname] = count
        print(f"  {pname}: {count}件")

print(f"\n総コーナー数: {len(all_headlines)}件\n")

# ─── Step3: キーワード頻度集計 ────────────────────────────────────────────────
print("=== Step3: キーワード頻度ランキング ===")

# 注目キーワードリスト
KEYWORDS = [
    'トランプ',
    '関税',
    'フジテレビ',
    '中居',
    'ウクライナ',
    'イスラエル',
    '地震',
    '能登',
    '物価',
]

keyword_stats = {}
for kw in KEYWORDS:
    matches = [h for h in all_headlines if kw in h['headline']]
    if matches:
        by_program = defaultdict(int)
        by_month = defaultdict(int)
        for m in matches:
            by_program[m['program']] += 1
            by_month[m['date'][:7]] += 1
        keyword_stats[kw] = {
            'total': len(matches),
            'by_program': dict(by_program),
            'months': sorted(by_month.keys()),
            'month_counts': dict(by_month),
        }

# 件数順にソート
ranked = sorted(keyword_stats.items(), key=lambda x: x[1]['total'], reverse=True)

print(f"\n{'キーワード':<15} {'件数':>5}  {'期間':<20}  番組別")
print("-" * 80)
for kw, s in ranked[:30]:
    months = f"{s['months'][0]}〜{s['months'][-1]}" if s['months'] else '-'
    prog_str = ', '.join(f"{k}:{v}" for k, v in sorted(s['by_program'].items(), key=lambda x: -x[1])[:3])
    print(f"{kw:<15} {s['total']:>5}件  {months:<20}  {prog_str}")

# ─── Step4: 月別推移トップ10 ──────────────────────────────────────────────────
print("\n=== Step4: 月別推移（上位10キーワード） ===")
top10 = [kw for kw, _ in ranked[:10]]
months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']

header = f"{'キーワード':<15} " + '  '.join(f"{m[5:]:>4}" for m in months)
print(header)
print("-" * 60)
for kw in top10:
    s = keyword_stats[kw]
    row = f"{kw:<15} " + '  '.join(f"{s['month_counts'].get(m, 0):>4}" for m in months)
    print(row)
