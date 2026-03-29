#!/usr/bin/env python3
"""gpt-5-nanoで全スコアリングを一括実行する（並列版）"""
import urllib.request, json, subprocess, os, time, sys, re
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# バッファリング無効化（リアルタイム出力）
sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
OPENAI_KEY = env['OPENAI_API_KEY']

TOPICS = {
    'fuji_tv': {
        'name': 'フジテレビ・中居問題',
        'prompt': lambda text: f"""以下の日本語ニュースを分析してください。JSONのみ返してください。

テキスト: {text}

{{
  "score_z": -1.0〜+1.0（-1=批判的・問題提起、+1=解決・改革志向）,
  "sentiment": -1.0〜+1.0（-1=ネガティブ、+1=ポジティブ）,
  "urgency": 0.0〜1.0（0=低、1=非常に煽り度が高い）
}}"""
    },
    'trump': {
        'name': 'トランプ関税',
        'prompt': lambda text: f"""以下の日本語ニュースを分析してください。JSONのみ返してください。

テキスト: {text}

{{
  "score_z": -1.0〜+1.0（-1=懸念・批判、+1=対応・適応志向）,
  "sentiment": -1.0〜+1.0（-1=ネガティブ、+1=ポジティブ）,
  "urgency": 0.0〜1.0（0=低、1=非常に煽り度が高い）
}}"""
    },
    'ukraine': {
        'name': 'ウクライナ',
        'prompt': lambda text: f"""以下の日本語ニュースを分析してください。JSONのみ返してください。

テキスト: {text}

{{
  "score_z": -1.0〜+1.0（-1=悲観・批判、+1=解決・和平志向）,
  "sentiment": -1.0〜+1.0（-1=ネガティブ、+1=ポジティブ）,
  "urgency": 0.0〜1.0（0=低、1=非常に煽り度が高い）
}}"""
    },
}

def call_openai(prompt: str) -> dict:
    for attempt in range(3):
        body = json.dumps({
            'model': 'gpt-5-nano',
            'messages': [
                {'role': 'system', 'content': 'あなたはニュース分析アシスタントです。JSONのみ返してください。'},
                {'role': 'user', 'content': prompt}
            ],
            'max_completion_tokens': 2000,
        }).encode()
        req = urllib.request.Request(
            'https://api.openai.com/v1/chat/completions',
            data=body,
            headers={
                'Authorization': f'Bearer {OPENAI_KEY}',
                'Content-Type': 'application/json',
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.load(r)
            text = resp['choices'][0]['message']['content']
            m = re.search(r'\{[^}]+\}', text, re.DOTALL)
            return json.loads(m.group()) if m else {}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1))  # rate limit → リトライ
                continue
            raise
    return {}

def score_article(a):
    topic_cfg = TOPICS.get(a['topic'])
    if not topic_cfg:
        return None
    # 全て0以外の値があればスキップ（0は未スコア扱いで再処理）
    sz = a.get('score_z_gpt') or 0
    sg = a.get('sentiment_gpt') or 0
    ug = a.get('urgency_gpt') or 0
    if sz != 0 or sg != 0 or ug != 0:
        return 'skip'
    text = f"見出し: {a['headline']}"
    if a.get('memo'):
        text += f"\n詳細: {a['memo']}"
    scores = call_openai(topic_cfg['prompt'](text))
    clamp = lambda v, lo, hi: max(lo, min(hi, float(v or 0)))
    return {
        'id': a['id'],
        'score_z_gpt': round(clamp(scores.get('score_z', 0), -1, 1), 3),
        'sentiment_gpt': round(clamp(scores.get('sentiment', 0), -1, 1), 3),
        'urgency_gpt': round(clamp(scores.get('urgency', 0), 0, 1), 3),
    }

# ローカルから全件取得
print("=== データ取得 ===")
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', 'SELECT id, headline, memo, topic, score_z_gpt, sentiment_gpt, urgency_gpt FROM scored_articles;',
     '--json'],
    capture_output=True, text=True
)
articles = json.loads(result.stdout)[0]['results']
print(f"  {len(articles)}件取得")

# 途中保存ファイル（失敗時の再開用）
SAVE_FILE = 'openai_scores_partial.json'

# 既存の途中保存があれば読み込んでスキップ対象に追加
saved_ids = set()
saved_results = []
if os.path.exists(SAVE_FILE):
    with open(SAVE_FILE, 'r') as f:
        saved_results = json.load(f)
    saved_ids = {r['id'] for r in saved_results}
    print(f"  途中保存から{len(saved_results)}件を復元")

# 並列スコアリング
print("\n=== スコアリング開始 (20並列 / GPT専用列) ===")
results = list(saved_results)
errors = 0
skipped = 0
done = 0
lock = threading.Lock()

# 既に途中保存済みのIDはスキップ
target_articles = [a for a in articles if a['id'] not in saved_ids]

with ThreadPoolExecutor(max_workers=20) as executor:
    futures = {executor.submit(score_article, a): a for a in target_articles}
    for future in as_completed(futures):
        with lock:
            done += 1
            try:
                r = future.result()
                if r is None:
                    pass
                elif r == 'skip':
                    skipped += 1
                else:
                    results.append(r)
            except Exception:
                errors += 1
            # 100件ごとにローカル保存
            if done % 100 == 0:
                with open(SAVE_FILE, 'w') as f:
                    json.dump(results, f)
                print(f"  {done}/{len(target_articles)}件処理 (成功:{len(results)} スキップ:{skipped} エラー:{errors}) [保存済]")

print(f"\n完了: {len(results)}件スコアリング (スキップ:{skipped}件 エラー:{errors}件)")

# SQLファイルに書き出してリモートに投入（GPT専用列のみ更新）
print("\n=== リモートDBに投入 ===")
sql_file = 'openai_scores.sql'
with open(sql_file, 'w', encoding='utf-8') as f:
    for r in results:
        f.write(
            f"UPDATE scored_articles SET score_z_gpt={r['score_z_gpt']}, sentiment_gpt={r['sentiment_gpt']}, urgency_gpt={r['urgency_gpt']} "
            f"WHERE id='{r['id']}';\n"
        )

result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--remote', '--file', sql_file],
    capture_output=True, text=True, input='yes\n'
)
if 'changes' in result.stdout:
    print(f"完了: {len(results)}件を更新しました")
    # 成功したら途中保存ファイルを削除
    if os.path.exists(SAVE_FILE):
        os.remove(SAVE_FILE)
else:
    print("エラー:", result.stderr[:200])
    print(f"途中保存ファイル {SAVE_FILE} に{len(results)}件保存済み。再実行で続きから再開できます。")

os.remove(sql_file)
