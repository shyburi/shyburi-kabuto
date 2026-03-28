#!/usr/bin/env node
// Keyword-based rescoring for Japanese news headlines about BOJ/monetary policy
// Runs fast without needing AI API

const { execSync } = require('child_process')

function scoreHeadline(headline) {
  const h = headline

  // ── Y axis: 緩和的 (-1) ↔ 引き締め的 (+1) ────────────────
  let y = 0
  // 引き締め side (+)
  if (/利上げ/.test(h)) y += 0.6
  if (/引き上げ|引き上げ|引上げ/.test(h)) y += 0.5
  if (/金利上昇/.test(h)) y += 0.4
  if (/インフレ抑制|物価抑制/.test(h)) y += 0.3
  if (/0\.[1-9]%|[1-9]\.[0-9]%/.test(h) && /利上げ|引き上げ/.test(h)) y += 0.2
  // 緩和 side (-)
  if (/据え置き|現状維持/.test(h)) y -= 0.5
  if (/利下げ/.test(h)) y -= 0.7
  if (/緩和/.test(h)) y -= 0.4
  if (/マイナス金利/.test(h)) y -= 0.5
  // Normalize
  y = Math.max(-1, Math.min(1, y))

  // ── Z axis: 市民・家計 (-1) ↔ 金融市場・投資家 (+1) ─────
  let z = 0
  // 市場 side (+)
  if (/株価|株式市場|株/.test(h)) z += 0.5
  if (/為替|円安|円高/.test(h)) z += 0.4
  if (/投資家|ファンド|債券/.test(h)) z += 0.6
  if (/エコノミスト|アナリスト|専門家/.test(h)) z += 0.3
  if (/市場|マーケット/.test(h)) z += 0.4
  if (/金融政策|政策金利/.test(h)) z += 0.2
  // 市民 side (-)
  if (/家計|住宅ローン|ローン/.test(h)) z -= 0.7
  if (/生活|家庭|世帯|子育て/.test(h)) z -= 0.6
  if (/食料|食品|野菜|物価高/.test(h)) z -= 0.5
  if (/年金|受給者/.test(h)) z -= 0.6
  if (/スーパー|買い物/.test(h)) z -= 0.5
  if (/旅行|観光/.test(h)) z -= 0.2
  z = Math.max(-1, Math.min(1, z))

  // ── Color axis: 懸念 (-1) ↔ 楽観 (+1) ───────────────────
  let c = 0
  // 楽観 side (+)
  if (/回復|改善|好調|メリット/.test(h)) c += 0.5
  if (/安定|達成|目標/.test(h)) c += 0.3
  if (/好意|肯定|支持/.test(h)) c += 0.4
  if (/プラス効果|恩恵/.test(h)) c += 0.5
  // 懸念 side (-)
  if (/懸念|不安|リスク/.test(h)) c -= 0.5
  if (/急落|暴落|下落/.test(h)) c -= 0.7
  if (/負担増|値上がり|高騰/.test(h)) c -= 0.5
  if (/ショック|危機|問題/.test(h)) c -= 0.6
  if (/批判|反発|異論/.test(h)) c -= 0.4
  if (/厳しい|深刻/.test(h)) c -= 0.4
  if (/混乱|困惑/.test(h)) c -= 0.3
  // 物価高騰 is both concerning AND tightening-relevant
  if (/物価高|インフレ/.test(h)) { y += 0.2; c -= 0.3 }
  c = Math.max(-1, Math.min(1, c))

  // Add small jitter to avoid zero clustering
  const jitter = () => (Math.random() - 0.5) * 0.1
  if (y === 0) y = jitter()
  if (z === 0) z = jitter()
  if (c === 0) c = jitter()

  return {
    y: Math.round(y * 100) / 100,
    z: Math.round(z * 100) / 100,
    c: Math.round(c * 100) / 100,
  }
}

// ── Fetch all articles from D1 and rescore ───────────────────────────────────
console.log('Fetching articles from D1...')

const fetchResult = execSync(
  'npx wrangler d1 execute blog --local --command "SELECT id, headline FROM scored_articles;" --json',
  { encoding: 'utf8' }
)

const parsed = JSON.parse(fetchResult)
const articles = parsed[0].results
console.log(`Found ${articles.length} articles`)

let updated = 0
for (const a of articles) {
  const s = scoreHeadline(a.headline)
  const cmd = `UPDATE scored_articles SET score_y=${s.y}, score_z=${s.z}, score_color=${s.c} WHERE id='${a.id}';`
  const res = execSync(
    `npx wrangler d1 execute blog --local --command "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  )
  if (res.includes('success')) updated++
  if (updated % 20 === 0) process.stdout.write(`\r  Updated ${updated}/${articles.length}`)
}

console.log(`\nRescored ${updated}/${articles.length} articles`)

// ── Show sample ───────────────────────────────────────────────────────────────
const sampleResult = execSync(
  'npx wrangler d1 execute blog --local --command "SELECT headline, score_y, score_z, score_color FROM scored_articles WHERE NOT (score_y=0 AND score_z=0 AND score_color=0) LIMIT 8;" --json',
  { encoding: 'utf8' }
)
const sample = JSON.parse(sampleResult)
console.log('\nSample non-zero scores:')
for (const row of sample[0].results) {
  console.log(`  [y=${row.score_y} z=${row.score_z} c=${row.score_color}] ${row.headline.slice(0, 50)}`)
}
