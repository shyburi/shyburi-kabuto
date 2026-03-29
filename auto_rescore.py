#!/usr/bin/env python3
"""スコアリングURLを自動で繰り返し叩き続ける"""
import urllib.request, json, time, sys

BASE = 'https://ntv-hackason.allnabeko03.workers.dev'
HEADERS = {'User-Agent': 'Mozilla/5.0'}

# (topic, mode) の順に実行
TASKS = [
    ('fuji_tv', 'sentiment'),
    ('trump',   'sentiment'),
    ('fuji_tv', 'rescore'),
    ('trump',   'rescore'),
]

def get_scored_count(topic, mode):
    url = f"{BASE}/api/scored?topic={topic}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    total = len(data)
    if mode == 'sentiment':
        scored = sum(1 for a in data if a.get('sentiment', 0) != 0)
    else:
        scored = sum(1 for a in data if a.get('score_z', 0) != 0)
    return scored, total

def rescore(topic, mode):
    if mode == 'sentiment':
        url = f"{BASE}/admin/sentiment?topic={topic}&limit=20"
    else:
        url = f"{BASE}/admin/ai-rescore?topic={topic}&limit=20"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)

for topic, mode in TASKS:
    print(f"\n=== {topic} / {mode} ===")
    attempt = 0
    while True:
        attempt += 1
        scored, total = get_scored_count(topic, mode)
        print(f"  [{attempt}回目] スコア済み: {scored}/{total}", end=' ', flush=True)
        if scored >= total:
            print("→ 完了!")
            break
        try:
            result = rescore(topic, mode)
            print(f"→ updated: {result.get('updated', '?')}")
        except Exception as e:
            print(f"→ タイムアウト/エラー、リトライ ({e})")
            time.sleep(5)
            continue
        time.sleep(2)

print("\n全タスク完了!")
