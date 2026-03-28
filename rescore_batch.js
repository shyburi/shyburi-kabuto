#!/usr/bin/env node
// Single-pass batch rescoring: 2 wrangler calls total
const { execSync } = require('child_process')

function score(h) {
  let y = 0, z = 0, c = 0

  // Y: 引き締め(+) ↔ 緩和(-)
  if (h.includes('利上げ') || h.includes('引き上げ') || h.includes('引上げ')) y += 0.65
  if (h.includes('金利上昇')) y += 0.4
  if (h.includes('インフレ抑制') || h.includes('物価抑制')) y += 0.3
  if (h.includes('据え置き') || h.includes('現状維持') || h.includes('維持')) y -= 0.5
  if (h.includes('利下げ')) y -= 0.7
  if (h.includes('緩和')) y -= 0.4
  if (h.includes('マイナス金利')) y -= 0.5
  if (h.includes('物価高') || h.includes('インフレ') || h.includes('値上げ')) y += 0.15
  y = Math.max(-1, Math.min(1, y))

  // Z: 市場(+) ↔ 市民(-)
  if (h.includes('株価') || h.includes('株式')) z += 0.55
  if (h.includes('為替') || h.includes('円安') || h.includes('円高')) z += 0.45
  if (h.includes('投資家') || h.includes('ファンド') || h.includes('債券')) z += 0.65
  if (h.includes('エコノミスト') || h.includes('アナリスト') || h.includes('専門家')) z += 0.35
  if (h.includes('市場') || h.includes('マーケット') || h.includes('金融市場')) z += 0.4
  if (h.includes('金融政策') || h.includes('政策金利')) z += 0.25
  if (h.includes('短観') || h.includes('日経平均')) z += 0.4
  if (h.includes('家計') || h.includes('住宅ローン') || h.includes('ローン')) z -= 0.75
  if (h.includes('生活') || h.includes('家庭') || h.includes('世帯') || h.includes('子育て')) z -= 0.6
  if (h.includes('食料') || h.includes('食品') || h.includes('野菜') || h.includes('食材')) z -= 0.55
  if (h.includes('年金') || h.includes('受給者')) z -= 0.65
  if (h.includes('スーパー') || h.includes('買い物') || h.includes('おこめ') || h.includes('コメ')) z -= 0.5
  if (h.includes('旅行') || h.includes('観光') || h.includes('暮らし')) z -= 0.3
  if (h.includes('実質賃金') || h.includes('賃上げ') || h.includes('初任給')) z -= 0.2
  z = Math.max(-1, Math.min(1, z))

  // C: 楽観(+) ↔ 懸念(-)
  if (h.includes('回復') || h.includes('改善') || h.includes('好調') || h.includes('メリット')) c += 0.5
  if (h.includes('安定') || h.includes('達成') || h.includes('目標達成')) c += 0.35
  if (h.includes('最高値') && !h.includes('下落') && !h.includes('急落')) c += 0.3
  if (h.includes('引き上げ') && h.includes('賃')) c += 0.4 // 賃上げ is good
  if (h.includes('懸念') || h.includes('不安') || h.includes('リスク')) c -= 0.55
  if (h.includes('急落') || h.includes('暴落') || h.includes('下落') || h.includes('値下がり')) c -= 0.75
  if (h.includes('負担増') || h.includes('値上がり') || h.includes('高騰')) c -= 0.55
  if (h.includes('ショック') || h.includes('危機') || h.includes('問題') || h.includes('崩壊')) c -= 0.65
  if (h.includes('批判') || h.includes('反発') || h.includes('異論')) c -= 0.45
  if (h.includes('厳しい') || h.includes('深刻') || h.includes('ピンチ')) c -= 0.45
  if (h.includes('混乱') || h.includes('困惑') || h.includes('動揺')) c -= 0.35
  if (h.includes('物価高') && !h.includes('対策') && !h.includes('解消')) c -= 0.3
  if (h.includes('赤字')) c -= 0.4
  c = Math.max(-1, Math.min(1, c))

  // Small jitter for zero values to spread the plot
  const j = () => (Math.random() - 0.5) * 0.08
  if (y === 0) y = j()
  if (z === 0) z = j()
  if (c === 0) c = j()

  return {
    y: Math.round(y * 1000) / 1000,
    z: Math.round(z * 1000) / 1000,
    c: Math.round(c * 1000) / 1000,
  }
}

// Step 1: Fetch all articles
console.log('Fetching articles...')
const raw = execSync(
  'npx wrangler d1 execute blog --local --command "SELECT id, headline FROM scored_articles;" --json 2>/dev/null',
  { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
)
const articles = JSON.parse(raw)[0].results
console.log(`${articles.length} articles found`)

// Step 2: Generate all UPDATEs as one SQL string
const sql = articles.map(a => {
  const s = score(a.headline)
  // Escape single quotes in id
  const id = a.id.replace(/'/g, "''")
  return `UPDATE scored_articles SET score_y=${s.y}, score_z=${s.z}, score_color=${s.c} WHERE id='${id}'`
}).join('; ')

// Step 3: Execute all at once
console.log('Updating D1...')
const r = execSync(
  `npx wrangler d1 execute blog --local --command "${sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" 2>/dev/null`,
  { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
)

if (r.includes('success')) {
  console.log(`✓ Updated ${articles.length} articles`)
} else {
  console.log('Result:', r.slice(0, 300))
}

// Step 4: Show score distribution
const sample = execSync(
  'npx wrangler d1 execute blog --local --command "SELECT program, AVG(score_y) as avg_y, AVG(score_z) as avg_z, AVG(score_color) as avg_c, COUNT(*) as n FROM scored_articles GROUP BY program;" --json 2>/dev/null',
  { encoding: 'utf8' }
)
const dist = JSON.parse(sample)[0].results
console.log('\nScore distribution by program:')
for (const d of dist) {
  console.log(`  ${d.program}: y=${(+d.avg_y).toFixed(2)} z=${(+d.avg_z).toFixed(2)} c=${(+d.avg_c).toFixed(2)} (n=${d.n})`)
}
