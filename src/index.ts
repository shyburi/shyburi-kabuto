import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Env = {
  Bindings: {
    DB: D1Database
    AI: any
  }
}

const app = new Hono<Env>()
app.use('*', cors())

// ─── Frontend ────────────────────────────────────────────────────────────────

app.get('/', (c) => c.html(FRONTEND_HTML))

// ─── API: Scored Articles ─────────────────────────────────────────────────────

app.get('/api/scored', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM scored_articles ORDER BY date ASC, program ASC'
  ).all()
  return c.json(results)
})

// ─── Admin: Keyword-based rescoring (one-time setup) ─────────────────────────

function computeScore(h: string): { y: number; z: number; c: number } {
  let y = 0, z = 0, c = 0

  // Y axis: 個人事案(-1) ↔ 社会・制度問題(+1)
  // 個人事案
  if (h.includes('逮捕') || h.includes('容疑者') || h.includes('被告') || h.includes('起訴')) y -= 0.6
  if (h.includes('判決') || h.includes('実刑') || h.includes('有罪') || h.includes('無罪')) y -= 0.55
  if (h.includes('わいせつか') || h.includes('性的暴行か') || h.includes('強制わいせつか')) y -= 0.3
  // 社会・制度
  if (h.includes('法改正') || h.includes('刑法改正') || h.includes('不同意性交等罪')) y += 0.8
  if (h.includes('制度') || h.includes('法案') || h.includes('法律')) y += 0.65
  if (h.includes('対策') || h.includes('防止') || h.includes('根絶') || h.includes('撲滅')) y += 0.55
  if (h.includes('社会') || h.includes('構造') || h.includes('キャンペーン')) y += 0.45
  if (h.includes('第三者委員会') || h.includes('調査報告') || h.includes('報告書')) y += 0.4

  // Z axis: 被害者視点(-1) ↔ 司法・加害者視点(+1)
  // 被害者側
  if (h.includes('被害者') || h.includes('被害女性') || h.includes('被害者の会')) z -= 0.7
  if (h.includes('告発') || h.includes('訴え') || h.includes('声を上げ') || h.includes('MeToo')) z -= 0.65
  if (h.includes('二次被害') || h.includes('トラウマ') || h.includes('心のケア')) z -= 0.6
  if (h.includes('被害') && (h.includes('女性') || h.includes('女子') || h.includes('児童') || h.includes('女児'))) z -= 0.45
  if (h.includes('イベント') && (h.includes('被害') || h.includes('防止'))) z -= 0.35
  // 司法・加害者側
  if (h.includes('逮捕') || h.includes('容疑者') || h.includes('加害者') || h.includes('被告')) z += 0.55
  if (h.includes('捜査') || h.includes('検察') || h.includes('警察') || h.includes('刑事')) z += 0.5
  if (h.includes('判決') || h.includes('裁判') || h.includes('公判') || h.includes('起訴')) z += 0.6
  if (h.includes('失職') || h.includes('懲戒') || h.includes('処分')) z += 0.4

  // C axis: 批判・問題提起(-1) ↔ 解決・改善志向(+1)
  // 解決・改善
  if (h.includes('法改正') || h.includes('根絶') || h.includes('撲滅')) c += 0.6
  if (h.includes('防止') || h.includes('対策') || h.includes('支援') || h.includes('救済')) c += 0.55
  if (h.includes('相談窓口') || h.includes('ワンストップ') || h.includes('センター')) c += 0.6
  if (h.includes('認定マーク') || h.includes('取り組み') || h.includes('イベント')) c += 0.45
  // 批判・問題
  if (h.includes('批判') || h.includes('抗議') || h.includes('不満') || h.includes('隠蔽')) c -= 0.65
  if (h.includes('再犯') || h.includes('増加') || h.includes('急増') || h.includes('多発')) c -= 0.6
  if (h.includes('二次被害') || h.includes('不当') || h.includes('問題')) c -= 0.45
  if (h.includes('調査報告') || h.includes('第三者委員会')) c -= 0.35

  const rnd = () => (Math.random() - 0.5) * 0.08
  return {
    y: Math.round(Math.max(-1, Math.min(1, y || rnd())) * 1000) / 1000,
    z: Math.round(Math.max(-1, Math.min(1, z || rnd())) * 1000) / 1000,
    c: Math.round(Math.max(-1, Math.min(1, c || rnd())) * 1000) / 1000,
  }
}

app.get('/admin/rescore', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, headline FROM scored_articles'
  ).all()

  const stmts = results.map(a => {
    const s = computeScore(a.headline as string)
    return c.env.DB.prepare(
      'UPDATE scored_articles SET score_y=?, score_z=?, score_color=? WHERE id=?'
    ).bind(s.y, s.z, s.c, a.id)
  })

  await c.env.DB.batch(stmts)
  return c.json({ ok: true, updated: stmts.length })
})

// ─── Admin: AI-based full rescoring (Workers AI, all 3 axes) ─────────────────

app.get('/admin/ai-rescore', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, headline FROM scored_articles ORDER BY date ASC'
  ).all()

  let updated = 0
  const stmts = []

  for (const a of results) {
    try {
      const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{
          role: 'system',
          content: 'You are a Japanese news scoring assistant. Reply with only JSON, no explanation.'
        }, {
          role: 'user',
          content: `Score this Japanese news headline on 3 axes (-1.0 to +1.0). Reply only: {"y":number,"z":number,"c":number}

y: -1=individual crime case focus, +1=social/systemic/legal reform focus
z: -1=victim/survivor perspective, +1=judicial/perpetrator/investigation perspective
c: -1=critical/accusatory tone, +1=solution/improvement oriented tone

Headline: ${a.headline}`
        }],
        max_tokens: 50
      })
      const text = (resp as any).response ?? ''
      const m = text.match(/\{[^}]+\}/)
      if (m) {
        const s = JSON.parse(m[0])
        const clamp = (v: number) => Math.max(-1, Math.min(1, v || 0))
        stmts.push(c.env.DB.prepare(
          'UPDATE scored_articles SET score_y=?, score_z=?, score_color=? WHERE id=?'
        ).bind(clamp(s.y), clamp(s.z), clamp(s.c), a.id))
        updated++
      }
    } catch { /* skip on error */ }
  }

  if (stmts.length > 0) await c.env.DB.batch(stmts)
  return c.json({ ok: true, total: results.length, updated })
})

// ─── API: Custom Axis Rescoring (Workers AI) ──────────────────────────────────

app.post('/api/rescore', async (c) => {
  const body = await c.req.json<{ axis_neg: string; axis_pos: string; limit?: number }>()
  const maxItems = Math.min(body.limit ?? 40, 60)

  const { results } = await c.env.DB.prepare(
    'SELECT id, headline FROM scored_articles ORDER BY date ASC LIMIT ?'
  ).bind(maxItems).all()

  const scored: { id: string; score: number }[] = []
  for (const a of results) {
    try {
      const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{
          role: 'system',
          content: 'You are a news scoring assistant. Reply with only JSON.'
        }, {
          role: 'user',
          content: `Score the following Japanese news headline on a scale from -1.0 to +1.0, where -1.0 means "${body.axis_neg}" and +1.0 means "${body.axis_pos}". Reply with only: {"s": <number>}\n\nHeadline: ${a.headline}`
        }],
        max_tokens: 30
      })
      const text = (resp as any).response ?? ''
      const m = text.match(/"s"\s*:\s*([-\d.]+)/)
      const s = m ? Math.max(-1, Math.min(1, parseFloat(m[1]))) : 0
      scored.push({ id: a.id as string, score: s })
    } catch {
      scored.push({ id: a.id as string, score: 0 })
    }
  }
  return c.json(scored)
})

export default app

// ─── Frontend HTML ────────────────────────────────────────────────────────────

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>鏡 — NTV 性犯罪報道スタンス分析</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Helvetica Neue', 'Hiragino Kaku Gothic ProN', Arial, sans-serif;
      background: #080c18;
      color: #c8d8f0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Top bar ─────────────────────────────────────────── */
    #topbar {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 10px 20px;
      background: #0c1220;
      border-bottom: 1px solid #1a2840;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    #topbar .logo {
      font-size: 22px;
      font-weight: 900;
      letter-spacing: 6px;
      color: #a0c8ff;
      white-space: nowrap;
    }
    #topbar .logo span {
      font-size: 11px;
      letter-spacing: 3px;
      color: #4a7090;
      font-weight: 400;
      margin-left: 6px;
    }
    #topbar .subtitle {
      font-size: 11px;
      color: #3a5870;
      white-space: nowrap;
    }
    #topbar .spacer { flex: 1; }
    #stats {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: #4a7090;
    }
    #stats .val { color: #6ab0ff; font-weight: bold; }
    #filters {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    #filters label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    #filters input[type="checkbox"] { cursor: pointer; accent-color: #4a9eff; }
    .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

    /* ── Plot area ───────────────────────────────────────── */
    #plot-wrap {
      flex: 1;
      position: relative;
      min-height: 0;
    }
    #plot { width: 100%; height: 100%; }

    /* ── Axis legend (fixed overlay) ─────────────────────── */
    #axis-legend {
      position: absolute;
      top: 12px; left: 16px;
      background: rgba(8,12,24,0.85);
      border: 1px solid #1a2840;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 11px;
      pointer-events: none;
      z-index: 10;
    }
    #axis-legend .al-row { margin: 3px 0; color: #6090b8; }
    #axis-legend .al-key { color: #a0c8ff; font-weight: bold; margin-right: 4px; }
    #axis-legend .al-range { color: #3a5870; }

    /* ── Info card (click popup) ─────────────────────────── */
    #info-card {
      position: absolute;
      bottom: 12px; left: 16px;
      width: 300px;
      background: rgba(12,18,32,0.95);
      border: 1px solid #2a3a5a;
      border-radius: 10px;
      padding: 14px 16px;
      display: none;
      z-index: 20;
      backdrop-filter: blur(6px);
    }
    #info-card .ic-program {
      font-size: 10px;
      letter-spacing: 2px;
      color: #4a7090;
      text-transform: uppercase;
      margin-bottom: 5px;
    }
    #info-card .ic-headline {
      font-size: 14px;
      color: #d8e8ff;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    #info-card .ic-date { font-size: 11px; color: #3a5870; }
    #info-card .ic-scores {
      display: flex;
      gap: 12px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #1a2840;
    }
    .score-item { text-align: center; }
    .score-item .s-label { font-size: 9px; color: #3a5870; letter-spacing: 1px; margin-bottom: 3px; }
    .score-item .s-val { font-size: 16px; font-weight: bold; }
    #info-close {
      position: absolute;
      top: 10px; right: 12px;
      background: none; border: none;
      color: #3a5870; font-size: 16px;
      cursor: pointer; padding: 2px 6px;
    }
    #info-close:hover { color: #8ab0d8; }

    /* ── Bottom panel ────────────────────────────────────── */
    #bottom {
      flex-shrink: 0;
      background: #0c1220;
      border-top: 1px solid #1a2840;
      padding: 12px 20px;
    }
    #axis-form {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    #axis-form .af-label {
      font-size: 11px;
      color: #4a7090;
      letter-spacing: 1px;
      white-space: nowrap;
    }
    #axis-form input {
      background: #080c18;
      border: 1px solid #2a3a5a;
      border-radius: 6px;
      padding: 6px 10px;
      color: #c8d8f0;
      font-size: 12px;
      font-family: inherit;
      width: 160px;
    }
    #axis-form input:focus { outline: none; border-color: #4a9eff; }
    #axis-form .arrow { color: #3a5870; font-size: 18px; }
    #axis-form button {
      background: #1a3060;
      color: #6ab0ff;
      border: 1px solid #2a4a80;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    #axis-form button:hover { background: #1e3a78; }
    #axis-form button:disabled { opacity: 0.5; cursor: not-allowed; }
    #rescore-status {
      font-size: 11px;
      color: #4a8080;
      margin-left: 8px;
    }

    /* ── Custom axis result ──────────────────────────────── */
    #custom-result {
      display: none;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #1a2840;
    }
    #custom-result .cr-title {
      font-size: 10px;
      color: #4a7090;
      letter-spacing: 2px;
      margin-bottom: 8px;
    }
    #custom-result-list {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cr-item {
      background: #0a1020;
      border: 1px solid #1a2840;
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 11px;
      max-width: 200px;
    }
    .cr-item .cr-score { font-weight: bold; margin-right: 5px; }
    .cr-item .cr-text { color: #6090b8; }
  </style>
</head>
<body>

  <!-- ── Top bar ─────────────────────────────────────────── -->
  <div id="topbar">
    <div class="logo">鏡<span>KAGAMI</span></div>
    <div class="subtitle">NTV 性犯罪報道スタンス 3D可視化</div>
    <div class="spacer"></div>
    <div id="stats">
      <span>コーナー数 <span class="val" id="stat-total">–</span></span>
      <span>期間 <span class="val">2025年 Q1〜Q4</span></span>
    </div>
    <div id="filters">
      <label><input type="checkbox" data-prog="ストレイトニュース" checked><div class="dot" style="background:#4a9eff"></div>ストレイトニュース</label>
      <label><input type="checkbox" data-prog="バンキシャ" checked><div class="dot" style="background:#ff9e4a"></div>バンキシャ</label>
      <label><input type="checkbox" data-prog="ミヤネ屋" checked><div class="dot" style="background:#bf6aff"></div>ミヤネ屋</label>
    </div>
  </div>

  <!-- ── Plot area ──────────────────────────────────────── -->
  <div id="plot-wrap">
    <div id="plot"></div>

    <!-- Axis legend overlay -->
    <div id="axis-legend">
      <div class="al-row"><span class="al-key">X軸</span> 日付 <span class="al-range">(2025年)</span></div>
      <div class="al-row"><span class="al-key">Y軸</span> 報道フォーカス <span class="al-range">個人事案↔社会・制度</span></div>
      <div class="al-row"><span class="al-key">Z軸</span> 視点 <span class="al-range">被害者↔司法・加害者</span></div>
      <div class="al-row"><span class="al-key">色</span> トーン <span class="al-range">批判・告発(赤)↔解決・改善(緑)</span></div>
    </div>

    <!-- Click info card -->
    <div id="info-card">
      <button id="info-close">✕</button>
      <div class="ic-program" id="ic-program"></div>
      <div class="ic-headline" id="ic-headline"></div>
      <div class="ic-date" id="ic-date"></div>
      <div class="ic-scores">
        <div class="score-item">
          <div class="s-label">個人↔社会</div>
          <div class="s-val" id="ic-sy"></div>
        </div>
        <div class="score-item">
          <div class="s-label">被害者↔司法</div>
          <div class="s-val" id="ic-sz"></div>
        </div>
        <div class="score-item">
          <div class="s-label">トーン</div>
          <div class="s-val" id="ic-sc"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Bottom: custom axis form ───────────────────────── -->
  <div id="bottom">
    <div id="axis-form">
      <div class="af-label">カスタム軸を追加</div>
      <input id="axis-neg" placeholder="否定的端（例：批判的）" value="">
      <div class="arrow">←→</div>
      <input id="axis-pos" placeholder="肯定的端（例：支持的）" value="">
      <button id="rescore-btn">AI分析</button>
      <span id="rescore-status"></span>
    </div>
    <div id="custom-result">
      <div class="cr-title" id="cr-title"></div>
      <div id="custom-result-list"></div>
    </div>
  </div>

  <script>
  // ── Data & state ────────────────────────────────────────
  let ALL_DATA = []
  let VISIBLE = { 'ストレイトニュース': true, 'バンキシャ': true, 'ミヤネ屋': true }

  const PROG_COLORS = {
    'ストレイトニュース': '#4a9eff',
    'バンキシャ':         '#ff9e4a',
    'ミヤネ屋':           '#bf6aff'
  }
  const PROGRAMS = ['ストレイトニュース', 'バンキシャ', 'ミヤネ屋']

  // Convert date string to days since 2025-01-01
  function dateToDays(s) {
    const base = Date.UTC(2025, 0, 1)
    const d = Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10))
    return Math.round((d - base) / 86400000)
  }

  // Format days back to date label
  function daysToLabel(n) {
    const d = new Date(Date.UTC(2025, 0, 1) + n * 86400000)
    return d.getUTCFullYear() + '/' + String(d.getUTCMonth()+1).padStart(2,'0') + '/' + String(d.getUTCDate()).padStart(2,'0')
  }

  function scoreColor(v) {
    if (v > 0.3) return '#44cc88'
    if (v < -0.3) return '#ff5555'
    return '#aaaaaa'
  }

  // ── Build Plotly traces ─────────────────────────────────
  function buildTraces(data) {
    const traces = []
    PROGRAMS.forEach((prog, pi) => {
      if (!VISIBLE[prog]) return
      const arts = data.filter(a => a.program === prog).sort((a, b) => a.date.localeCompare(b.date))
      if (arts.length === 0) return

      const xs = arts.map(a => dateToDays(a.date))
      const ys = arts.map(a => a.score_y)
      const zs = arts.map(a => a.score_z)
      const cs = arts.map(a => a.score_color)
      const texts = arts.map(a =>
        '<b>' + a.headline + '</b><br>' +
        a.date + ' | ' + prog + '<br>' +
        '個人↔社会: ' + (a.score_y >= 0 ? '+' : '') + a.score_y.toFixed(2) +
        '  視点: ' + (a.score_z >= 0 ? '+' : '') + a.score_z.toFixed(2) +
        '  トーン: ' + (a.score_color >= 0 ? '+' : '') + a.score_color.toFixed(2)
      )

      // Markers + line trace (combined)
      traces.push({
        type: 'scatter3d',
        mode: 'lines+markers',
        name: prog,
        x: xs, y: ys, z: zs,
        text: texts,
        hovertemplate: '%{text}<extra></extra>',
        customdata: arts.map(a => a.id),
        marker: {
          size: 3,
          color: cs,
          colorscale: [
            [0,   '#ff4444'],
            [0.25,'#ff8844'],
            [0.5, '#888888'],
            [0.75,'#66cc88'],
            [1,   '#22ee88']
          ],
          cmin: -1, cmax: 1,
          showscale: pi === 0,
          colorbar: pi === 0 ? {
            title: { text: 'トーン<br>批判↓ 解決↑', font: { size: 10, color: '#6090b8' } },
            len: 0.5, thickness: 12, x: 1.02,
            tickfont: { size: 9, color: '#6090b8' },
            tickvals: [-1, 0, 1], ticktext: ['批判', 'ニュートラル', '解決']
          } : undefined,
          line: { color: 'rgba(0,0,0,0.2)', width: 0.5 },
          opacity: 0.9
        },
        line: { color: PROG_COLORS[prog], width: 1.5 }
      })
    })
    return traces
  }

  // ── Plotly layout ───────────────────────────────────────
  const LAYOUT = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor:  'rgba(0,0,0,0)',
    margin: { l: 0, r: 40, t: 10, b: 0 },
    legend: {
      x: 0.01, y: 0.98,
      bgcolor: 'rgba(12,18,32,0.8)',
      bordercolor: '#1a2840',
      borderwidth: 1,
      font: { color: '#8ab0d8', size: 11 }
    },
    scene: {
      bgcolor: 'rgba(8,12,24,1)',
      xaxis: {
        title: { text: '日付 (2025年)', font: { color: '#4a7090', size: 11 } },
        gridcolor: '#1a2840', zerolinecolor: '#2a3a5a',
        tickfont: { color: '#3a5870', size: 9 },
        tickvals: [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
        ticktext: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月','']
      },
      yaxis: {
        title: { text: '報道フォーカス  個人事案↔社会・制度', font: { color: '#4a7090', size: 11 } },
        gridcolor: '#1a2840', zerolinecolor: '#2a3a5a',
        tickfont: { color: '#3a5870', size: 9 },
        range: [-1.2, 1.2]
      },
      zaxis: {
        title: { text: '報道視点  被害者↔司法・加害者', font: { color: '#4a7090', size: 11 } },
        gridcolor: '#1a2840', zerolinecolor: '#2a3a5a',
        tickfont: { color: '#3a5870', size: 9 },
        range: [-1.2, 1.2]
      },
      camera: {
        eye: { x: 1.6, y: -1.6, z: 0.8 }
      },
      aspectmode: 'manual',
      aspectratio: { x: 4, y: 1, z: 1 }
    }
  }

  const PLOTLY_CONFIG = {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
    displaylogo: false
  }

  // ── Render chart ────────────────────────────────────────
  function render() {
    const traces = buildTraces(ALL_DATA)
    if (traces.length === 0) {
      document.getElementById('plot').innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#3a5870;font-size:14px">データなし</div>'
      return
    }
    Plotly.react('plot', traces, LAYOUT, PLOTLY_CONFIG)
  }

  // ── Click handler ───────────────────────────────────────
  document.getElementById('plot').addEventListener('plotly_click', (e) => {
    const pt = e.detail?.points?.[0] ?? e.points?.[0]
    if (!pt || !pt.customdata) return
    const id = pt.customdata
    const art = ALL_DATA.find(a => a.id === id)
    if (!art) return
    showInfoCard(art)
  })

  // Attach plotly_click after render
  function attachClick() {
    const el = document.getElementById('plot')
    el.on('plotly_click', (data) => {
      const pt = data.points?.[0]
      if (!pt || !pt.customdata) return
      const id = pt.customdata
      const art = ALL_DATA.find(a => a.id === id)
      if (!art) return
      showInfoCard(art)
    })
  }

  function showInfoCard(art) {
    document.getElementById('ic-program').textContent = art.program
    document.getElementById('ic-headline').textContent = art.headline
    document.getElementById('ic-date').textContent = art.date
    const sy = document.getElementById('ic-sy')
    const sz = document.getElementById('ic-sz')
    const sc = document.getElementById('ic-sc')
    sy.textContent = (art.score_y >= 0 ? '+' : '') + art.score_y.toFixed(2)
    sz.textContent = (art.score_z >= 0 ? '+' : '') + art.score_z.toFixed(2)
    sc.textContent = (art.score_color >= 0 ? '+' : '') + art.score_color.toFixed(2)
    sy.style.color = scoreColor(art.score_y)
    sz.style.color = scoreColor(art.score_z)
    sc.style.color = scoreColor(art.score_color)
    document.getElementById('info-card').style.display = 'block'
  }

  document.getElementById('info-close').addEventListener('click', () => {
    document.getElementById('info-card').style.display = 'none'
  })

  // ── Filters ─────────────────────────────────────────────
  document.querySelectorAll('#filters input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      VISIBLE[cb.dataset.prog] = cb.checked
      render()
    })
  })

  // ── Load data ────────────────────────────────────────────
  async function loadData() {
    const res = await fetch('/api/scored')
    ALL_DATA = await res.json()
    document.getElementById('stat-total').textContent = ALL_DATA.length
    render()
    attachClick()
  }

  // ── Custom axis rescoring ────────────────────────────────
  document.getElementById('rescore-btn').addEventListener('click', async () => {
    const neg = document.getElementById('axis-neg').value.trim()
    const pos = document.getElementById('axis-pos').value.trim()
    if (!neg || !pos) { alert('両端のラベルを入力してください'); return }

    const btn = document.getElementById('rescore-btn')
    const status = document.getElementById('rescore-status')
    btn.disabled = true
    status.textContent = 'AI分析中…'

    try {
      const res = await fetch('/api/rescore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axis_neg: neg, axis_pos: pos, limit: 40 })
      })
      const scores = await res.json()

      // Map id → score
      const scoreMap = {}
      scores.forEach(s => { scoreMap[s.id] = s.score })

      // Show top/bottom 5
      const scored = ALL_DATA
        .filter(a => scoreMap[a.id] !== undefined)
        .map(a => ({ ...a, custom_score: scoreMap[a.id] }))
        .sort((a, b) => b.custom_score - a.custom_score)

      const top5 = scored.slice(0, 5)
      const bot5 = scored.slice(-5).reverse()
      const items = [
        ...top5.map(a => ({ s: a.custom_score, text: a.headline, prog: a.program })),
        ...bot5.map(a => ({ s: a.custom_score, text: a.headline, prog: a.program }))
      ]

      document.getElementById('cr-title').textContent =
        neg + ' ←→ ' + pos + ' （上位・下位5件）'
      document.getElementById('custom-result-list').innerHTML = items.map(it => {
        const c = scoreColor(it.s)
        return '<div class="cr-item">' +
          '<span class="cr-score" style="color:' + c + '">' + (it.s >= 0 ? '+' : '') + it.s.toFixed(2) + '</span>' +
          '<span class="cr-text">' + it.text.slice(0, 40) + (it.text.length > 40 ? '…' : '') + '</span>' +
          '</div>'
      }).join('')
      document.getElementById('custom-result').style.display = 'block'
      status.textContent = scores.length + '件分析完了'
    } catch (e) {
      status.textContent = 'エラー: ' + e.message
    } finally {
      btn.disabled = false
    }
  })

  // ── Init ─────────────────────────────────────────────────
  loadData()
  </script>
</body>
</html>`
