#!/usr/bin/env python3
"""urgencyスコアを辞書で計算してリモートDBに格納する"""
import json, subprocess, os

URGENCY = [
    '緊急', '速報', '深刻', '重大', '危機', '最悪', '急激', '異常', '衝撃',
    '爆発的', '急騰', '暴落', '崩壊', '壊滅', '激化', '悪化', '拡大',
    '警戒', '警告', '脅威', '切迫', '致命', '取り返し', '돌이킬',
]

def calc_urgency(text: str) -> float:
    if not text:
        return 0.0
    matched = sum(1 for w in URGENCY if w in text)
    # 最大5語マッチで1.0になるよう正規化
    return round(min(matched / 5, 1.0), 3)

print("=== ローカルからデータ取得 ===")
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', 'SELECT id, headline, memo FROM scored_articles;',
     '--json'],
    capture_output=True, text=True
)
articles = json.loads(result.stdout)[0]['results']
print(f"  {len(articles)}件取得")

print("=== urgencyスコア計算 ===")
for a in articles:
    text = (a['headline'] or '') + ' ' + (a['memo'] or '')
    a['urgency'] = calc_urgency(text)

scores = [a['urgency'] for a in articles]
print(f"  0(低): {sum(1 for s in scores if s == 0)}件")
print(f"  0〜0.5: {sum(1 for s in scores if 0 < s <= 0.5)}件")
print(f"  0.5〜1.0: {sum(1 for s in scores if s > 0.5)}件")

print("\n=== サンプル（高urgency上位5件） ===")
for a in sorted(articles, key=lambda x: x['urgency'], reverse=True)[:5]:
    print(f"  {a['urgency']:.2f} | {a['headline'][:50]}")

print("\n=== リモートDBに投入 ===")
sql_file = 'urgency.sql'
with open(sql_file, 'w', encoding='utf-8') as f:
    for a in articles:
        f.write(f"UPDATE scored_articles SET urgency={a['urgency']} WHERE id='{a['id']}';\n")

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote', '--file', sql_file],
    capture_output=True, text=True, input='yes\n'
)
if 'changes' in result.stdout:
    print(f"完了: {len(articles)}件を更新しました")
else:
    print("エラー:", result.stderr[:200])

os.remove(sql_file)
