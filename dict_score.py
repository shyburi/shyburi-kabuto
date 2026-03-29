#!/usr/bin/env python3
"""辞書スコアを計算してリモートDBに格納する"""
import json, subprocess, os, re

# ─── 辞書定義 ────────────────────────────────────────────────────────────────
NEGATIVE = [
    '懸念', '批判', '打撃', '問題', '失敗', '悪化', 'リスク', '脅威',
    '隠蔽', '圧力', '責任', '追及', '疑惑', '反発', '抗議', '撤退',
    '損失', '被害', '犠牲', '悲劇', '危機', '崩壊', '破綻', '炎上',
]
SOLUTION = [
    '解決', '対策', '合意', '改善', '協議', '前進', '成果', '回復',
    '改革', '再発防止', '第三者委員会', '支援', '復興', '和平', '停戦',
    '対応', '調査', '見直し', '強化', '連携', '協力',
]

def calc_dict_score(text: str) -> float:
    """批判的=-1 ↔ 解決志向=+1"""
    if not text:
        return 0.0
    neg = sum(1 for w in NEGATIVE if w in text)
    sol = sum(1 for w in SOLUTION if w in text)
    total = max(neg + sol, 1)
    return round((sol - neg) / total, 3)

# ─── ローカルから全件取得 ─────────────────────────────────────────────────────
print("=== ローカルからデータ取得 ===")
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', 'SELECT id, headline, memo FROM scored_articles;',
     '--json'],
    capture_output=True, text=True
)
articles = json.loads(result.stdout)[0]['results']
print(f"  {len(articles)}件取得")

# ─── 辞書スコア計算 ───────────────────────────────────────────────────────────
print("=== 辞書スコア計算 ===")
for a in articles:
    text = (a['headline'] or '') + ' ' + (a['memo'] or '')
    a['dict_score'] = calc_dict_score(text)

# 分布確認
scores = [a['dict_score'] for a in articles]
neg_cnt = sum(1 for s in scores if s < 0)
pos_cnt = sum(1 for s in scores if s > 0)
zero_cnt = sum(1 for s in scores if s == 0)
print(f"  負(批判寄り): {neg_cnt}件")
print(f"  正(解決寄り): {pos_cnt}件")
print(f"  ゼロ(中立):   {zero_cnt}件")

# サンプル表示
print("\n=== サンプル（上位5件・下位5件） ===")
sorted_arts = sorted(articles, key=lambda x: x['dict_score'])
for a in sorted_arts[:3] + sorted_arts[-3:]:
    print(f"  {a['dict_score']:+.2f} | {a['headline'][:50]}")

# ─── SQLファイルに書き出してリモートに投入 ─────────────────────────────────────
print("\n=== リモートDBに投入 ===")
sql_file = 'dict_score.sql'
with open(sql_file, 'w', encoding='utf-8') as f:
    for a in articles:
        f.write(f"UPDATE scored_articles SET dict_score={a['dict_score']} WHERE id='{a['id']}';\n")

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote', '--file', sql_file],
    capture_output=True, text=True, input='yes\n'
)
if 'changes' in result.stdout:
    print(f"完了: {len(articles)}件を更新しました")
else:
    print("エラー:", result.stderr[:200])

os.remove(sql_file)
