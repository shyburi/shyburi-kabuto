#!/usr/bin/env python3
"""コーナーデータの構造を確認する"""
import urllib.request, urllib.parse, json

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

tid = urllib.parse.quote('ｽRW9', safe='')
url = f"{NTV_BASE}/programs/{tid}/details?date_from=2025-01-01&date_to=2025-03-31&include=corners"
req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
with urllib.request.urlopen(req, timeout=30) as r:
    data = json.load(r)

# フジテレビ関連コーナーのmemoとgenreを確認
print("=== フジテレビ関連コーナー（memo・genre確認） ===")
count = 0
genres = set()
for b in data['broadcasts']:
    for c in b.get('corners', []):
        genres.add(c.get('headline_genre', ''))
        if 'フジ' in c.get('headline', '') or '中居' in c.get('headline', ''):
            print(f"\n日付: {b['onair_date']}")
            print(f"見出し: {c['headline']}")
            print(f"ジャンル: {c['headline_genre']}")
            print(f"duration: {c['duration']}秒")
            print(f"memo: {c['memo'][:200] if c['memo'] else '(空)'}")
            count += 1
            if count >= 5:
                break
    if count >= 5:
        break

print(f"\n=== 全ジャンル一覧 ===")
for g in sorted(genres):
    print(f"  {g}")
