#!/usr/bin/env python3
"""ローカルのscore_articlesを全フィールド込みでリモートに一括投入する"""
import json, subprocess, os

# ローカルから全件取得（memo, duration, genre, corner_start_time含む）
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', 'SELECT id, program, headline, date, topic, memo, duration, genre, corner_start_time FROM scored_articles;',
     '--json'],
    capture_output=True, text=True
)
articles = json.loads(result.stdout)[0]['results']
print(f"ローカル: {len(articles)}件をリモートに投入します")

# SQLファイルに書き出し
sql_file = 'update_remote.sql'
with open(sql_file, 'w', encoding='utf-8') as f:
    for a in articles:
        memo = (a['memo'] or '').replace("'", "''")
        genre = (a['genre'] or '').replace("'", "''")
        corner_start_time = (a['corner_start_time'] or '').replace("'", "''")
        duration = a['duration'] or 0
        f.write(
            f"UPDATE scored_articles SET "
            f"memo='{memo}', duration={duration}, genre='{genre}', corner_start_time='{corner_start_time}' "
            f"WHERE id='{a['id']}';\n"
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
else:
    print(f"完了: {len(articles)}件を更新しました")

os.remove(sql_file)
