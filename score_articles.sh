#!/bin/bash
# NTVコーナーデータをスコアリングしてD1に格納するスクリプト

source .dev.vars

BASE="${NTV_API_BASE_URL%/}"
KEY="$NTV_API_KEY"

PROGRAMS=("ｽRW9" "ｼ1ML" "ﾐLR6")
PROG_NAMES=("ストレイトニュース" "バンキシャ" "ミヤネ屋")
QUARTERS=("2025-01-01:2025-03-31" "2025-04-01:2025-06-30" "2025-10-01:2025-12-28")
KEYWORDS="日銀|金利|日本銀行|利上げ|植田|金融政策|為替|円安|円高|利下げ|物価|インフレ"

PROMPT_Y="次のニュースタイトルを「金融緩和的=-1.0, 引き締め的=+1.0」の軸で-1.0から1.0のfloat値でスコアリング。JSON {\"y\": 数値} のみ返して。タイトル: "
PROMPT_Z="次のニュースタイトルを「市民生活視点=-1.0, 金融市場視点=+1.0」の軸で-1.0から1.0のfloat値でスコアリング。JSON {\"z\": 数値} のみ返して。タイトル: "
PROMPT_C="次のニュースタイトルを「懸念・不安トーン=-1.0, 楽観・好意トーン=+1.0」の軸で-1.0から1.0のfloat値でスコアリング。JSON {\"c\": 数値} のみ返して。タイトル: "

COUNT=0

for i in "${!PROGRAMS[@]}"; do
  TID="${PROGRAMS[$i]}"
  PNAME="${PROG_NAMES[$i]}"
  TID_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TID'))")

  for QTR in "${QUARTERS[@]}"; do
    DFROM="${QTR%%:*}"
    DTO="${QTR##*:}"

    URL="$BASE/programs/$TID_ENC/details?date_from=$DFROM&date_to=$DTO&include=corners"
    DATA=$(curl -s -H "X-API-Key: $KEY" "$URL")

    # キーワードフィルタしてheadlineとdateを抽出
    while IFS="|" read -r DATE HEADLINE; do
      [ -z "$HEADLINE" ] && continue
      echo "[${COUNT}] $DATE | ${HEADLINE:0:50}"

      # 3軸スコアリング
      SY=$(opencode run "${PROMPT_Y}${HEADLINE}" 2>/dev/null | python3 -c "import json,sys; d=json.loads(sys.stdin.read().strip()); print(d.get('y',0))" 2>/dev/null || echo "0")
      SZ=$(opencode run "${PROMPT_Z}${HEADLINE}" 2>/dev/null | python3 -c "import json,sys; d=json.loads(sys.stdin.read().strip()); print(d.get('z',0))" 2>/dev/null || echo "0")
      SC=$(opencode run "${PROMPT_C}${HEADLINE}" 2>/dev/null | python3 -c "import json,sys; d=json.loads(sys.stdin.read().strip()); print(d.get('c',0))" 2>/dev/null || echo "0")

      ID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")
      # D1に挿入
      npx wrangler d1 execute blog --local --command "INSERT OR IGNORE INTO scored_articles (id, program, headline, date, score_y, score_z, score_color) VALUES ('$ID', '$PNAME', '${HEADLINE//\'/\'\'}', '$DATE', $SY, $SZ, $SC);" 2>/dev/null

      COUNT=$((COUNT+1))
    done < <(echo "$DATA" | python3 -c "
import json, sys, re
data = json.load(sys.stdin)
kw = r'$KEYWORDS'
for b in data.get('broadcasts', []):
    for c in b.get('corners', []):
        h = c.get('headline', '')
        if re.search(kw, h):
            print(b.get('onair_date','') + '|' + h)
" 2>/dev/null)

  done
done

echo "完了: ${COUNT}件処理"
