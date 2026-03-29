#!/usr/bin/env python3
import urllib.request, urllib.parse, json

BASE = open('.dev.vars').read()
env = dict(line.strip().split('=', 1) for line in BASE.splitlines() if '=' in line)
NTV_BASE = env['NTV_API_BASE_URL'].rstrip('/')
NTV_KEY  = env['NTV_API_KEY']

tid = urllib.parse.quote('ｽRW9', safe='')

for year_from, year_to in [('2023-01-01', '2023-03-31'), ('2024-01-01', '2024-03-31'), ('2024-10-01', '2024-12-31')]:
    url = f"{NTV_BASE}/programs/{tid}/details?date_from={year_from}&date_to={year_to}&include=corners"
    req = urllib.request.Request(url, headers={'X-API-Key': NTV_KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        broadcasts = data.get('broadcasts', [])
        print(f"{year_from[:7]}〜{year_to[:7]}: {len(broadcasts)}件")
        if broadcasts:
            print(f"  最古: {broadcasts[0].get('onair_date')}  最新: {broadcasts[-1].get('onair_date')}")
    except Exception as e:
        print(f"{year_from[:7]}〜{year_to[:7]}: ERR {e}")
