#!/usr/bin/env python3
"""リモートDBを全フィールド込みで作り直し、スコアを復元する"""
import json, subprocess, os

def run(cmd, input=None):
    r = subprocess.run(cmd, capture_output=True, text=True, input=input)
    return r.stdout

# ─── Step1: リモートのスコアをバックアップ ───────────────────────────────────
print("=== Step1: スコアバックアップ ===")
out = run(['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote',
           '--command', 'SELECT headline, date, program, topic, score_y, score_z FROM scored_articles WHERE score_y != 0 OR score_z != 0;',
           '--json'])
scores = json.loads(out)[0]['results']
score_map = {(s['headline'], s['date'], s['program'], s['topic']): (s['score_y'], s['score_z']) for s in scores}
print(f"  {len(score_map)}件のスコアを保存")

# ─── Step2: リモートを全削除 ─────────────────────────────────────────────────
print("=== Step2: リモート全削除 ===")
run(['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote',
     '--command', 'DELETE FROM scored_articles;'], input='yes\n')
print("  削除完了")

# ─── Step3: ローカルから全件取得（重複除去） ─────────────────────────────────
print("=== Step3: ローカルデータ取得 ===")
out = run(['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
           '--command', 'SELECT id, program, headline, date, topic, memo, duration, genre, corner_start_time FROM scored_articles GROUP BY headline, date, program, topic;',
           '--json'])
articles = json.loads(out)[0]['results']
print(f"  {len(articles)}件取得（重複除去済み）")

# ─── Step4: スコアを復元しながらSQLを生成 ────────────────────────────────────
print("=== Step4: リモートに投入 ===")
sql_file = 'rebuild.sql'
restored = 0
with open(sql_file, 'w', encoding='utf-8') as f:
    for a in articles:
        memo = (a['memo'] or '').replace("'", "''")
        genre = (a['genre'] or '').replace("'", "''")
        headline = (a['headline'] or '').replace("'", "''")
        program = (a['program'] or '').replace("'", "''")
        corner_start_time = (a['corner_start_time'] or '').replace("'", "''")
        duration = a['duration'] or 0
        key = (a['headline'], a['date'], a['program'], a['topic'])
        score_y, score_z = score_map.get(key, (0.0, 0.0))
        if score_y != 0.0 or score_z != 0.0:
            restored += 1
        f.write(
            f"INSERT OR IGNORE INTO scored_articles "
            f"(id, program, headline, date, score_y, score_z, score_color, topic, duration, genre, memo, corner_start_time) "
            f"VALUES ('{a['id']}', '{program}', '{headline}', '{a['date']}', "
            f"{score_y}, {score_z}, 0.0, '{a['topic']}', "
            f"{duration}, '{genre}', '{memo}', '{corner_start_time}');\n"
        )

print(f"  スコア復元対象: {restored}件")

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote', '--file', sql_file],
    capture_output=True, text=True, input='yes\n'
)
print(result.stdout[-200:])
os.remove(sql_file)
print(f"完了: {len(articles)}件投入、{restored}件スコア復元")
