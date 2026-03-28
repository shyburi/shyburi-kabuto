#!/usr/bin/env python3
"""
NTVコーナーデータを取得→opencodeでバッチスコアリング→D1に格納
"""
import urllib.request, urllib.parse, json, subprocess, sys, uuid

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

KEYWORDS = ['性犯罪','性被害','強制わいせつ','痴漢','盗撮','セクハラ','性的暴行','不同意性交','性加害','わいせつ','AV','性的搾取','レイプ','強姦','性的','強制性交']
PROGRAMS = [('ｽRW9','ストレイトニュース'), ('ｼ1ML','バンキシャ'), ('ﾐLR6','ミヤネ屋')]
QUARTERS = [('2025-01-01','2025-03-31'), ('2025-04-01','2025-06-30'), ('2025-10-01','2025-12-28')]

# ─── Step1: コーナーデータ収集 ───────────────────────────────────────────────

def fetch_corners(title_id, date_from, date_to):
    tid_enc = urllib.parse.quote(title_id, safe='')
    url = f"{NTV_BASE}/programs/{tid_enc}/details?date_from={date_from}&date_to={date_to}&include=corners"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    hits = []
    for b in data.get('broadcasts', []):
        for c in b.get('corners', []):
            text = c.get('headline', '') + c.get('memo', '')
            if any(k in text for k in KEYWORDS):
                hits.append({
                    'date': b.get('onair_date', ''),
                    'headline': c.get('headline', '').replace("'", "''"),
                })
    return hits

print("=== Step1: データ収集 ===")
all_articles = []
for tid, pname in PROGRAMS:
    for dfrom, dto in QUARTERS:
        try:
            hits = fetch_corners(tid, dfrom, dto)
            print(f"  {pname} {dfrom[:7]}: {len(hits)}件")
            for h in hits:
                h['program'] = pname
                h['id'] = str(uuid.uuid4())
            all_articles.extend(hits)
        except Exception as e:
            print(f"  {pname} {dfrom[:7]}: ERR {e}")

print(f"\n合計 {len(all_articles)} 件収集\n")

# ─── Step2: opncodeでバッチスコアリング ──────────────────────────────────────

def opencode_score(articles_batch):
    """10件ずつバッチでスコアリング"""
    headlines_json = json.dumps(
        [{"i": i, "title": a['headline']} for i, a in enumerate(articles_batch)],
        ensure_ascii=False
    )
    prompt = f"""以下のニュースタイトルリストを3つの軸でスコアリングしてください。
各タイトルについて -1.0 から 1.0 の数値を返してください。

軸の定義:
- y: 個人・特定事案への焦点=-1.0, 社会構造・制度問題への焦点=+1.0
- z: 被害者・サバイバー視点=-1.0, 司法・加害者・捜査視点=+1.0
- c: 批判・告発・問題提起=-1.0, 解決・支援・改善志向=+1.0

タイトルリスト:
{headlines_json}

必ずJSON配列のみで返してください（説明不要）:
[{{"i":0,"y":0.0,"z":0.0,"c":0.0}}, ...]"""

    result = subprocess.run(
        ['opencode', 'run', '--format', 'json', prompt],
        capture_output=True, text=True, timeout=120
    )
    # --format json: テキストは type="text" イベントの part.text に入る
    output = ''
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
            if e.get('type') == 'text':
                output += e.get('part', {}).get('text', '')
        except:
            pass

    # JSON配列を抽出
    start = output.find('[')
    end = output.rfind(']') + 1
    if start == -1 or end == 0:
        return None
    try:
        return json.loads(output[start:end])
    except:
        return None

print("=== Step2: スコアリングスキップ（/admin/rescoreで後処理） ===")
scored = {a['id']: {'y': 0.0, 'z': 0.0, 'c': 0.0} for a in all_articles}
print(f"スコア初期化: {len(scored)}件（全て0）\n")

# ─── Step3: D1に格納 ─────────────────────────────────────────────────────────

print("=== Step3: D1に格納 ===")
success = 0
for article in all_articles:
    aid = article['id']
    s = scored.get(aid, {'y': 0.0, 'z': 0.0, 'c': 0.0})
    cmd = (
        f"INSERT OR IGNORE INTO scored_articles "
        f"(id, program, headline, date, score_y, score_z, score_color) "
        f"VALUES ('{aid}', '{article['program']}', '{article['headline']}', "
        f"'{article['date']}', {s['y']}, {s['z']}, {s['c']});"
    )
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local', '--command', cmd],
        capture_output=True, text=True
    )
    if 'success' in result.stdout:
        success += 1

print(f"D1格納完了: {success}/{len(all_articles)}件")

# ─── 確認 ─────────────────────────────────────────────────────────────────────
result = subprocess.run(
    ['npx', 'wrangler', 'd1', 'execute', 'blog', '--local',
     '--command', 'SELECT COUNT(*) as cnt FROM scored_articles;'],
    capture_output=True, text=True
)
print(result.stdout[-200:])
