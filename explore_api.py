#!/usr/bin/env python3
"""NTV APIの構造を探索する"""
import urllib.request, urllib.parse, json

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

def get(path):
    url = f"{NTV_BASE}{path}"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r), r.status
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception as e:
        return None, str(e)

# よくありそうなエンドポイントを試す
endpoints = [
    '/programs',
    '/programs/',
    '/titles',
    '/channels',
    '/broadcasts',
    '/',
    '/programs?limit=100',
    '/programs/list',
]

print("=== APIエンドポイント探索 ===\n")
for ep in endpoints:
    data, status = get(ep)
    if data is not None:
        print(f"✓ {ep} → {status}")
        if isinstance(data, list):
            print(f"  配列 {len(data)}件")
            if len(data) > 0:
                print(f"  サンプル: {json.dumps(data[0], ensure_ascii=False)[:200]}")
        elif isinstance(data, dict):
            print(f"  キー: {list(data.keys())}")
            print(f"  内容: {json.dumps(data, ensure_ascii=False)[:300]}")
    else:
        print(f"✗ {ep} → {status}")
    print()
