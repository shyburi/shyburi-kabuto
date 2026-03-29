#!/usr/bin/env python3
"""ローカルのscore_articlesを全件リモートに一括投入する"""
import json, subprocess, os

# ローカルから全件取得
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', 'SELECT id, program, headline, date, topic FROM scored_articles;',
     '--json'],
    capture_output=True, text=True
)
articles = json.loads(result.stdout)[0]['results']
print(f"ローカル: {len(articles)}件をリモートに投入します")

# SQLファイルに書き出し
sql_file = 'insert_remote.sql'
with open(sql_file, 'w', encoding='utf-8') as f:
    for a in articles:
        headline = a['headline'].replace("'", "''")
        f.write(
            f"INSERT OR IGNORE INTO scored_articles "
            f"(id, program, headline, date, score_y, score_z, score_color, topic) "
            f"VALUES ('{a['id']}', '{a['program']}', '{headline}', "
            f"'{a['date']}', 0.0, 0.0, 0.0, '{a['topic']}');\n"
        )

print(f"SQLファイル生成: {sql_file}")

# リモートに一括実行
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote', '--file', sql_file],
    capture_output=True, text=True, input='yes\n'
)
print(result.stdout[-300:])
if result.returncode != 0:
    print("エラー:", result.stderr[:200])

os.remove(sql_file)
