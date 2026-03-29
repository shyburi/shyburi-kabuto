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

// ─── Topic configurations ─────────────────────────────────────────────────────

const TOPICS = {
  fuji_tv: {
    name: 'フジテレビ・中居問題',
    yNeg: '被害者・告発側視点',
    yPos: '加害者・組織側視点',
    zNeg: '批判・問題提起',
    zPos: '解決・改革志向',
    prompt: (headline: string) =>
      `Score this Japanese news headline on 2 axes (-1.0 to +1.0). Reply only with JSON: {"y":number,"z":number}

y axis: -1.0 = victim/accusatory side perspective (被害女性・MeToo・二次被害・告発), +1.0 = perpetrator/organization side perspective (中居・フジテレビ・幹部・会社)
z axis: -1.0 = critical/problem-raising tone (隠蔽・圧力・体質批判・責任追及), +1.0 = solution/reform oriented (第三者委員会・制度改革・再発防止・改善)

Headline: ${headline}`,
  },
  trump: {
    name: 'トランプ関税',
    yNeg: '日本への影響・国内視点',
    yPos: '国際・外交視点',
    zNeg: '懸念・批判',
    zPos: '対応・適応志向',
    prompt: (headline: string) =>
      `Score this Japanese news headline on 2 axes (-1.0 to +1.0). Reply only with JSON: {"y":number,"z":number}

y axis: -1.0 = domestic/Japan impact perspective (家計・企業・産業・日本経済への影響), +1.0 = international/diplomatic perspective (米国・交渉・同盟・貿易協定・外交)
z axis: -1.0 = concern/critical tone (打撃・報復・リスク・懸念・悪影響), +1.0 = response/adaptation oriented (交渉・対策・チャンス・適応・対応)

Headline: ${headline}`,
  },
  ukraine: {
    name: 'ウクライナ',
    yNeg: '現場・被害者視点',
    yPos: '政治・外交視点',
    zNeg: '悲観・批判',
    zPos: '解決・和平志向',
    prompt: (headline: string) =>
      `Score this Japanese news headline on 2 axes (-1.0 to +1.0). Reply only with JSON: {"y":number,"z":number}

y axis: -1.0 = field/victim perspective (市民・被災・犠牲者・現地の声), +1.0 = political/diplomatic perspective (NATO・停戦交渉・各国政府・外交)
z axis: -1.0 = pessimistic/critical tone (侵攻・破壊・長期化・犠牲・悲劇), +1.0 = solution/peace oriented (停戦・支援・復興・和平・希望)

Headline: ${headline}`,
  },
} as const

type TopicKey = keyof typeof TOPICS

// ─── Frontend ─────────────────────────────────────────────────────────────────

app.get('/', (c) => c.html(FRONTEND_HTML))

// ─── API: Scored Articles ─────────────────────────────────────────────────────

app.get('/api/scored', async (c) => {
  const topic = (c.req.query('topic') ?? 'sexual_crime') as TopicKey
  if (!(topic in TOPICS)) return c.json({ error: 'Unknown topic' }, 400)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM scored_articles WHERE topic=? ORDER BY date ASC, program ASC'
  ).bind(topic).all()
  return c.json(results)
})

// ─── Admin: AI-based rescoring (Workers AI) ──────────────────────────────────

app.get('/admin/ai-rescore', async (c) => {
  const topic = (c.req.query('topic') ?? 'sexual_crime') as TopicKey
  if (!(topic in TOPICS)) return c.json({ error: 'Unknown topic' }, 400)
  const topicCfg = TOPICS[topic]
  const limit = Math.min(parseInt(c.req.query('limit') ?? '10'), 20)

  const { results } = await c.env.DB.prepare(
    'SELECT id, headline, memo FROM scored_articles WHERE topic=? AND score_y=0 AND score_z=0 ORDER BY date ASC LIMIT ?'
  ).bind(topic, limit).all()

  let updated = 0
  const stmts = []

  for (const a of results) {
    try {
      const text_input = a.memo
        ? `見出し: ${a.headline}\n詳細: ${a.memo}`
        : `見出し: ${a.headline}`
      const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'You are a Japanese news scoring assistant. Reply with only JSON, no explanation.',
          },
          {
            role: 'user',
            content: topicCfg.prompt(text_input as string),
          },
        ],
        max_tokens: 40,
      })
      const text = (resp as any).response ?? ''
      const m = text.match(/\{[^}]+\}/)
      if (m) {
        const s = JSON.parse(m[0])
        const clamp = (v: number) => Math.max(-1, Math.min(1, v || 0))
        stmts.push(
          c.env.DB.prepare(
            'UPDATE scored_articles SET score_y=?, score_z=? WHERE id=? AND topic=?'
          ).bind(clamp(s.y), clamp(s.z), a.id, topic)
        )
        updated++
      }
    } catch {
      /* skip on error */
    }
  }

  if (stmts.length > 0) await c.env.DB.batch(stmts)
  return c.json({ ok: true, total: results.length, updated })
})

// ─── Admin: Sentiment scoring (distilbert-sst-2) ─────────────────────────────

app.get('/admin/sentiment', async (c) => {
  const topic = (c.req.query('topic') ?? 'fuji_tv') as TopicKey
  if (!(topic in TOPICS)) return c.json({ error: 'Unknown topic' }, 400)
  const limit = Math.min(parseInt(c.req.query('limit') ?? '10'), 20)

  const { results } = await c.env.DB.prepare(
    'SELECT id, headline, memo FROM scored_articles WHERE topic=? AND (sentiment IS NULL OR sentiment=0) ORDER BY date ASC LIMIT ?'
  ).bind(topic, limit).all()

  let updated = 0

  for (const a of results) {
    try {
      const text = a.memo
        ? `見出し: ${a.headline}\n詳細: ${a.memo}`
        : `見出し: ${a.headline}`
      const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'You are a sentiment analysis assistant. Reply with only JSON, no explanation.',
          },
          {
            role: 'user',
            content: `以下の日本語ニューステキストの感情トーンを-1.0から+1.0で評価してください。-1.0=非常にネガティブ（批判・悲劇・問題）、0=中立、+1.0=非常にポジティブ（希望・解決・改善）。JSONのみ返してください: {"s": <number>}\n\n${text}`,
          },
        ],
        max_tokens: 20,
      })
      const raw = (resp as any).response ?? ''
      const m = raw.match(/"s"\s*:\s*([-\d.]+)/)
      if (m) {
        const sentiment = Math.max(-1, Math.min(1, parseFloat(m[1])))
        await c.env.DB.prepare(
          'UPDATE scored_articles SET sentiment=? WHERE id=?'
        ).bind(sentiment, a.id).run()
        updated++
      }
    } catch {
      /* skip on error */
    }
  }

  return c.json({ ok: true, total: results.length, updated })
})

// ─── Admin: AI-based filtering (Workers AI) ──────────────────────────────────
// 関係ない記事をAIで判定して削除する

const FILTER_PROMPTS: Record<TopicKey, (headline: string) => string> = {
  fuji_tv: (headline) =>
    `以下の日本語ニュース見出しは「フジテレビ・中居正広・性的トラブル・芸能界の性加害・メディアの隠蔽」に関する報道ですか？
関係ある場合は "yes"、関係ない場合は "no" のみ答えてください。

見出し: ${headline}`,
  trump: (headline) =>
    `以下の日本語ニュース見出しは「トランプ大統領・関税・米国の通商政策・貿易戦争」に関する報道ですか？
関係ある場合は "yes"、関係ない場合は "no" のみ答えてください。

見出し: ${headline}`,
  ukraine: (headline) =>
    `以下の日本語ニュース見出しは「ウクライナ・ロシア・侵攻・停戦・戦争」に関する報道ですか？
関係ある場合は "yes"、関係ない場合は "no" のみ答えてください。

見出し: ${headline}`,
}

app.get('/admin/ai-filter', async (c) => {
  const topic = (c.req.query('topic') ?? 'sexual_crime') as TopicKey
  if (!(topic in TOPICS)) return c.json({ error: 'Unknown topic' }, 400)

  const { results } = await c.env.DB.prepare(
    'SELECT id, headline FROM scored_articles WHERE topic=? ORDER BY date ASC'
  ).bind(topic).all()

  const toDelete: string[] = []
  const toKeep: string[] = []

  for (const a of results) {
    try {
      const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'あなたはニュース分類アシスタントです。"yes" か "no" のみ答えてください。',
          },
          {
            role: 'user',
            content: FILTER_PROMPTS[topic](a.headline as string),
          },
        ],
        max_tokens: 5,
      })
      const text = ((resp as any).response ?? '').toLowerCase()
      if (text.includes('no')) {
        toDelete.push(a.id as string)
      } else {
        toKeep.push(a.id as string)
      }
    } catch {
      toKeep.push(a.id as string) // エラー時は残す
    }
  }

  if (toDelete.length > 0) {
    const stmts = toDelete.map((id) =>
      c.env.DB.prepare('DELETE FROM scored_articles WHERE id=? AND topic=?').bind(id, topic)
    )
    await c.env.DB.batch(stmts)
  }

  return c.json({
    ok: true,
    total: results.length,
    kept: toKeep.length,
    deleted: toDelete.length,
    deleted_ids: toDelete,
  })
})

// ─── API: Custom Axis Rescoring (Workers AI) ─────────────────────────────────

app.post('/api/rescore', async (c) => {
  const body = await c.req.json<{
    axis_neg: string
    axis_pos: string
    topic?: string
    limit?: number
  }>()
  const topic = (body.topic ?? 'sexual_crime') as TopicKey
  if (!(topic in TOPICS)) return c.json({ error: 'Unknown topic' }, 400)
  const maxItems = Math.min(body.limit ?? 40, 60)

  const { results } = await c.env.DB.prepare(
    'SELECT id, headline FROM scored_articles WHERE topic=? ORDER BY date ASC LIMIT ?'
  ).bind(topic, maxItems).all()

  const scored: { id: string; score: number }[] = []
  for (const a of results) {
    try {
      const resp = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'You are a news scoring assistant. Reply with only JSON.' },
          {
            role: 'user',
            content: `Score the following Japanese news headline on a scale from -1.0 to +1.0, where -1.0 means "${body.axis_neg}" and +1.0 means "${body.axis_pos}". Reply with only: {"s": <number>}\n\nHeadline: ${a.headline}`,
          },
        ],
        max_tokens: 30,
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
  <title>鏡 — NTV 報道スタンス分析</title>
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
      gap: 16px;
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
    .spacer { flex: 1; }

    /* ── Topic tabs ──────────────────────────────────────── */
    #topic-tabs { display: flex; gap: 6px; }
    .topic-tab {
      background: #0a1020;
      border: 1px solid #2a3a5a;
      border-radius: 6px;
      padding: 5px 14px;
      font-size: 12px;
      color: #4a7090;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
    }
    .topic-tab.active {
      background: #1a3060;
      border-color: #4a9eff;
      color: #6ab0ff;
    }
    .topic-tab:hover:not(.active) { border-color: #3a5870; color: #6090b8; }

    #stats { display: flex; gap: 16px; font-size: 11px; color: #4a7090; }
    #stats .val { color: #6ab0ff; font-weight: bold; }

    /* ── Axis selectors ──────────────────────────────────── */
    #axis-selectors { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    #axis-selectors .ax-group { display: flex; align-items: center; gap: 4px; }
    #axis-selectors .ax-lbl {
      font-size: 10px; color: #4a7090; letter-spacing: 1px; white-space: nowrap;
    }
    #axis-selectors select {
      background: #0a1020; border: 1px solid #2a3a5a; border-radius: 4px;
      padding: 3px 6px; color: #8ab0d8; font-size: 11px; font-family: inherit;
      cursor: pointer; appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234a7090'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 5px center; padding-right: 18px;
    }
    #axis-selectors select:focus { outline: none; border-color: #4a9eff; }

    #view-toggle { display: flex; gap: 4px; }
    .view-btn {
      background: #0a1020; border: 1px solid #2a3a5a; border-radius: 6px;
      padding: 4px 12px; font-size: 11px; color: #4a7090; cursor: pointer;
      white-space: nowrap; font-family: inherit;
    }
    .view-btn.active { background: #1a3060; border-color: #4a9eff; color: #6ab0ff; }
    .view-btn:hover:not(.active) { border-color: #3a5870; color: #6090b8; }

    #filters-toggle {
      background: #0a1020; border: 1px solid #2a3a5a; border-radius: 6px;
      padding: 4px 12px; font-size: 11px; color: #6090b8; cursor: pointer;
      white-space: nowrap; font-family: inherit;
    }
    #filters-toggle:hover { border-color: #4a9eff; color: #8ab0d8; }
    #filters-panel {
      position: absolute; top: 12px; right: 16px;
      background: rgba(12,18,32,0.97);
      border: 1px solid #2a3a5a; border-radius: 10px;
      padding: 12px 16px;
      display: none; z-index: 30;
      max-height: 70vh; overflow-y: auto;
    }
    #filters-panel .fp-title {
      font-size: 10px; color: #4a7090; letter-spacing: 2px; margin-bottom: 8px;
    }
    #filters { display: flex; flex-direction: column; gap: 6px; }
    #filters label {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    #filters input[type="checkbox"] { cursor: pointer; accent-color: #4a9eff; }
    .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

    /* ── Plot area ───────────────────────────────────────── */
    #plot-wrap { flex: 1; position: relative; min-height: 0; display: flex; flex-direction: column; }
    #plot { flex: 1; width: 100%; min-height: 0; }
    #genre-chart { width: 100%; height: 220px; flex-shrink: 0; }

    /* ── Axis legend ─────────────────────────────────────── */
    #axis-legend {
      position: absolute; top: 12px; left: 16px;
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

    /* ── Info card ───────────────────────────────────────── */
    #info-card {
      position: absolute; bottom: 12px; left: 16px;
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
      font-size: 10px; letter-spacing: 2px; color: #4a7090;
      text-transform: uppercase; margin-bottom: 5px;
    }
    #info-card .ic-headline {
      font-size: 14px; color: #d8e8ff; line-height: 1.5; margin-bottom: 8px;
    }
    #info-card .ic-date { font-size: 11px; color: #3a5870; }
    #info-card .ic-scores {
      display: flex; gap: 12px;
      margin-top: 10px; padding-top: 10px;
      border-top: 1px solid #1a2840;
    }
    .score-item { text-align: center; }
    .score-item .s-label { font-size: 9px; color: #3a5870; letter-spacing: 1px; margin-bottom: 3px; }
    .score-item .s-val { font-size: 16px; font-weight: bold; }
    #info-close {
      position: absolute; top: 10px; right: 12px;
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
    #axis-form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    #axis-form .af-label {
      font-size: 11px; color: #4a7090; letter-spacing: 1px; white-space: nowrap;
    }
    #axis-form input {
      background: #080c18; border: 1px solid #2a3a5a; border-radius: 6px;
      padding: 6px 10px; color: #c8d8f0; font-size: 12px; font-family: inherit; width: 160px;
    }
    #axis-form input:focus { outline: none; border-color: #4a9eff; }
    #axis-form .arrow { color: #3a5870; font-size: 18px; }
    #axis-form button {
      background: #1a3060; color: #6ab0ff;
      border: 1px solid #2a4a80; border-radius: 6px;
      padding: 6px 16px; font-size: 12px; font-family: inherit;
      cursor: pointer; white-space: nowrap;
    }
    #axis-form button:hover { background: #1e3a78; }
    #axis-form button:disabled { opacity: 0.5; cursor: not-allowed; }
    #rescore-status { font-size: 11px; color: #4a8080; margin-left: 8px; }
    #custom-result {
      display: none; margin-top: 10px; padding-top: 10px; border-top: 1px solid #1a2840;
    }
    #custom-result .cr-title {
      font-size: 10px; color: #4a7090; letter-spacing: 2px; margin-bottom: 8px;
    }
    #custom-result-list { display: flex; gap: 8px; flex-wrap: wrap; }
    .cr-item {
      background: #0a1020; border: 1px solid #1a2840;
      border-radius: 6px; padding: 5px 10px; font-size: 11px; max-width: 200px;
    }
    .cr-item .cr-score { font-weight: bold; margin-right: 5px; }
    .cr-item .cr-text { color: #6090b8; }
  </style>
</head>
<body>

  <div id="topbar">
    <div class="logo">鏡<span>KAGAMI</span></div>
    <div id="topic-tabs">
      <button class="topic-tab active" data-topic="fuji_tv">フジテレビ・中居問題</button>
      <button class="topic-tab" data-topic="trump">トランプ関税</button>
      <button class="topic-tab" data-topic="ukraine">ウクライナ</button>
    </div>
    <div class="spacer"></div>
    <div id="axis-selectors">
      <div class="ax-group">
        <div class="ax-lbl">Y軸</div>
        <select id="sel-y">
          <option value="score_y" selected>Yスコア</option>
          <option value="score_z">Zスコア</option>
          <option value="duration">放送時間(秒)</option>
          <option value="sentiment">感情スコア(Llama)</option>
          <option value="sentiment_gpt">感情スコア(GPT)</option>
          <option value="coverage">報道割合</option>
          <option value="combined_z">批判↔解決(辞書+AI)</option>
          <option value="score_z_gpt">批判↔解決(GPT)</option>
          <option value="urgency_gpt">緊急度(GPT)</option>
        </select>
      </div>
      <div class="ax-group">
        <div class="ax-lbl">Z軸</div>
        <select id="sel-z">
          <option value="score_y">Yスコア</option>
          <option value="score_z" selected>Zスコア(Llama)</option>
          <option value="duration">放送時間(秒)</option>
          <option value="sentiment">感情スコア(Llama)</option>
          <option value="sentiment_gpt">感情スコア(GPT)</option>
          <option value="coverage">報道割合</option>
          <option value="combined_z">批判↔解決(辞書+AI)</option>
          <option value="score_z_gpt">批判↔解決(GPT)</option>
          <option value="urgency_gpt">緊急度(GPT)</option>
        </select>
      </div>
    </div>
    <div id="view-toggle">
      <button class="view-btn active" data-view="program">番組別</button>
      <button class="view-btn" data-view="total">全体</button>
    </div>
    <div id="stats">
      <span>コーナー数 <span class="val" id="stat-total">–</span></span>
    </div>
    <button id="filters-toggle">番組 ▾</button>
  </div>

  <div id="plot-wrap">
    <div id="plot"></div>
    <div id="genre-chart"></div>

    <div id="filters-panel">
      <div class="fp-title">番組フィルター</div>
      <div id="filters"></div>
    </div>

    <div id="axis-legend">
      <div class="al-row"><span class="al-key">X軸</span> <span id="al-x"></span></div>
      <div class="al-row"><span class="al-key">Y軸</span> <span id="al-y"></span></div>
      <div class="al-row"><span class="al-key">Z軸</span> <span id="al-z"></span></div>
    </div>

    <div id="info-card">
      <button id="info-close">✕</button>
      <div class="ic-program" id="ic-program"></div>
      <div class="ic-headline" id="ic-headline"></div>
      <div class="ic-date" id="ic-date"></div>
      <div class="ic-scores">
        <div class="score-item">
          <div class="s-label" id="ic-y-label">Y軸</div>
          <div class="s-val" id="ic-sy"></div>
        </div>
        <div class="score-item">
          <div class="s-label" id="ic-z-label">Z軸</div>
          <div class="s-val" id="ic-sz"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="bottom">
    <div id="axis-form">
      <div class="af-label">カスタム軸を追加</div>
      <input id="axis-neg" placeholder="否定的端（例：批判的）">
      <div class="arrow">←→</div>
      <input id="axis-pos" placeholder="肯定的端（例：支持的）">
      <button id="rescore-btn">AI分析</button>
      <span id="rescore-status"></span>
    </div>
    <div id="custom-result">
      <div class="cr-title" id="cr-title"></div>
      <div id="custom-result-list"></div>
    </div>
  </div>

  <script>
  let ALL_DATA = []
  let CURRENT_TOPIC = 'fuji_tv'
  let VISIBLE = {}
  let PROG_COLORS = {}
  let PROGRAMS = []
  let AXIS_SEL = { y: 'score_y', z: 'score_z' }
  let VIEW_MODE = 'program' // 'program' or 'total'
  let PROG_TOTAL = {} // 番組ごとのduration合計
  // 番組の実際の総放送時間（秒）Wikipedia調べ / 部がある番組は部数で均等割り
  const KNOWN_PROG_SEC = {
    'ＺＩＰ！　１部': 11400/3, 'ＺＩＰ！　２部': 11400/3, 'ＺＩＰ！　３部': 11400/3,
    'ＤａｙＤａｙ．　１部': 7500/2, 'ＤａｙＤａｙ．　２部': 7500/2,
    '情報ライブミヤネ屋': 6900,
    'ｎｅｗｓ　ｅｖｅｒｙ．　第１部': 11400/3, 'ｎｅｗｓ　ｅｖｅｒｙ．　第２部': 11400/3, 'ｎｅｗｓ　ｅｖｅｒｙ．　第３部': 11400/3,
    'ｎｅｗｓ　ｅｖｅｒｙ．サタデー': 3600,
    'Ｏｈａ！４ＮＥＷＳ　ＬＩＶＥ　第１部': 4800/2, 'Ｏｈａ！４ＮＥＷＳ　ＬＩＶＥ　第２部': 4800/2,
    '真相報道バンキシャ！': 3300,
    'シューイチ': 7200, 'シューイチ　１部': 7200/2,
    'ストレイトニュース': 300, 'ＮＮＮストレイトニュース': 300,
    'ニュース': 300, 'ＮＮＮニュース': 300,
    'ニュースサタデー': 900, 'ＮＮＮニュースサタデー': 900, 'ＮＮＮニュースサンデー': 900,
    'サタデーＬＩＶＥニュースジグザグ': 3600,
  }

  const COLOR_PALETTE = [
    '#4a9eff', '#ff9e4a', '#bf6aff', '#44cc88', '#ff5555',
    '#ffdd44', '#00cccc', '#ff88bb', '#88aaff', '#ffaa44',
    '#aaffaa', '#ff6688', '#44aaff', '#ccaa44', '#aa88ff',
  ]

  const TOPIC_CONFIG = {
    fuji_tv: {
      yLabel: '被害者・告発側視点 ← → 加害者・組織側視点',
      zLabel: '批判・問題提起 ← → 解決・改革志向',
      yNeg: '被害者・告発側',
      yPos: '加害者・組織側',
      zNeg: '批判・問題提起',
      zPos: '解決・改革志向',
    },
    trump: {
      yLabel: '日本への影響・国内視点 ← → 国際・外交視点',
      zLabel: '懸念・批判 ← → 対応・適応志向',
      yNeg: '国内・日本への影響',
      yPos: '国際・外交',
      zNeg: '懸念・批判',
      zPos: '対応・適応',
    },
    ukraine: {
      yLabel: '現場・被害者視点 ← → 政治・外交視点',
      zLabel: '悲観・批判 ← → 解決・和平志向',
      yNeg: '現場・被害者',
      yPos: '政治・外交',
      zNeg: '悲観・批判',
      zPos: '解決・和平',
    }
  }

  function dateToDays(s) {
    const base = Date.UTC(2025, 0, 1)
    const d = Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10))
    return Math.round((d - base) / 86400000)
  }

  function getAxisValue(art, axisKey) {
    switch(axisKey) {
      case 'date':     return dateToDays(art.date)
      case 'score_y':  return art.score_y || 0
      case 'score_z':  return art.score_z || 0
      case 'duration':   return art.duration || 0
      case 'sentiment':     return art.sentiment || 0
      case 'sentiment_gpt': return art.sentiment_gpt || 0
      case 'score_z_gpt':   return art.score_z_gpt || 0
      case 'urgency_gpt':   return art.urgency_gpt || 0
      case 'coverage':    return PROG_TOTAL[art.program] > 0 ? (art.duration || 0) / PROG_TOTAL[art.program] : 0
      case 'combined_z':  return (art.dict_score || 0) * 0.2 + (art.score_z || 0) * 0.8
      default:            return 0
    }
  }

  function getAxisLabel(axisKey) {
    const cfg = TOPIC_CONFIG[CURRENT_TOPIC]
    switch(axisKey) {
      case 'date':     return '日付 (2025年)'
      case 'score_y':  return cfg.yNeg + ' ← → ' + cfg.yPos
      case 'score_z':  return cfg.zNeg + ' ← → ' + cfg.zPos
      case 'duration':  return '放送時間 (秒)'
      case 'sentiment':     return 'ネガティブ ← → ポジティブ (Llama)'
      case 'sentiment_gpt': return 'ネガティブ ← → ポジティブ (GPT)'
      case 'score_z_gpt':   return '批判↔解決 (GPT)'
      case 'urgency_gpt':   return '緊急度 (GPT)'
      case 'coverage':   return '報道割合 (全体比)'
      case 'combined_z': return '批判↔解決 (辞書+AI)'
      default:           return axisKey
    }
  }

  function scoreColor(v) {
    if (v > 0.3) return '#44cc88'
    if (v < -0.3) return '#ff5555'
    return '#aaaaaa'
  }

  function updateAxisLegend() {
    document.getElementById('al-x').textContent = '日付 (2025年)'
    document.getElementById('al-y').textContent = getAxisLabel(AXIS_SEL.y)
    document.getElementById('al-z').textContent = getAxisLabel(AXIS_SEL.z)
    document.getElementById('ic-y-label').textContent = getAxisLabel(AXIS_SEL.y)
    document.getElementById('ic-z-label').textContent = getAxisLabel(AXIS_SEL.z)
  }

  function buildTotalTrace(data) {
    // 日付ごとに件数・累計放送時間・平均スコアを集計
    const byDate = {}
    data.forEach(a => {
      if (!byDate[a.date]) byDate[a.date] = { count: 0, duration: 0, score_y: [], score_z: [], sentiment: [], sentiment_gpt: [], score_z_gpt: [], urgency_gpt: [], combined_z: [] }
      byDate[a.date].count++
      byDate[a.date].duration += (a.duration || 0)
      if (a.score_y) byDate[a.date].score_y.push(a.score_y)
      if (a.score_z) byDate[a.date].score_z.push(a.score_z)
      if (a.sentiment) byDate[a.date].sentiment.push(a.sentiment)
      if (a.sentiment_gpt) byDate[a.date].sentiment_gpt.push(a.sentiment_gpt)
      if (a.score_z_gpt) byDate[a.date].score_z_gpt.push(a.score_z_gpt)
      if (a.urgency_gpt) byDate[a.date].urgency_gpt.push(a.urgency_gpt)
      const cz = (a.dict_score || 0) * 0.2 + (a.score_z || 0) * 0.8
      if (cz) byDate[a.date].combined_z.push(cz)
    })

    const dates = Object.keys(byDate).sort()
    const avg = arr => arr.length ? arr.reduce((a,b)=>a+b)/arr.length : 0
    const getVal = (d, axisKey) => {
      const entry = byDate[d]
      switch(axisKey) {
        case 'date':       return dateToDays(d)
        case 'duration':   return entry.duration
        case 'score_y':    return avg(entry.score_y)
        case 'score_z':    return avg(entry.score_z)
        case 'sentiment':     return avg(entry.sentiment)
        case 'sentiment_gpt': return avg(entry.sentiment_gpt)
        case 'score_z_gpt':   return avg(entry.score_z_gpt)
        case 'urgency_gpt':   return avg(entry.urgency_gpt)
        case 'combined_z': return avg(entry.combined_z)
        case 'coverage':   return entry.count
        default:           return 0
      }
    }

    const xs = dates.map(d => dateToDays(d))
    const ys = dates.map(d => getVal(d, AXIS_SEL.y))
    const zs = dates.map(d => getVal(d, AXIS_SEL.z))
    const texts = dates.map(d =>
      '<b>' + d + '</b><br>' +
      '報道件数: ' + byDate[d].count + '件<br>' +
      '累計放送時間: ' + byDate[d].duration + '秒<br>' +
      getAxisLabel(AXIS_SEL.y) + ': ' + fmtAxisVal(AXIS_SEL.y, getVal(d, AXIS_SEL.y)) + '<br>' +
      getAxisLabel(AXIS_SEL.z) + ': ' + fmtAxisVal(AXIS_SEL.z, getVal(d, AXIS_SEL.z))
    )

    return [{
      type: 'scatter3d',
      mode: 'lines+markers',
      name: '日テレ全体',
      x: xs, y: ys, z: zs,
      text: texts,
      hovertemplate: '%{text}<extra></extra>',
      marker: {
        size: dates.map(d => Math.max(4, Math.min(16, byDate[d].count * 1.5))),
        color: '#a0c8ff',
        opacity: 0.9,
        line: { color: 'rgba(0,0,0,0.2)', width: 0.5 }
      },
      line: { color: '#a0c8ff', width: 2 }
    }]
  }

  function fmtAxisVal(axisKey, val) {
    if (axisKey === 'duration') return val + '秒'
    if (axisKey === 'date') return val + '日目'
    if (axisKey === 'coverage') return ((val || 0) * 100).toFixed(2) + '%'
    return (val >= 0 ? '+' : '') + (val || 0).toFixed(2)
  }

  function buildTraces(data) {
    const traces = []
    PROGRAMS.forEach((prog) => {
      if (!VISIBLE[prog]) return
      const arts = data.filter(a => a.program === prog).sort((a, b) => a.date.localeCompare(b.date))
      if (arts.length === 0) return

      const xs = arts.map(a => dateToDays(a.date))
      const ys = arts.map(a => getAxisValue(a, AXIS_SEL.y))
      const zs = arts.map(a => getAxisValue(a, AXIS_SEL.z))
      const texts = arts.map(a =>
        '<b>' + a.headline + '</b><br>' +
        a.date + ' | ' + prog + '<br>' +
        getAxisLabel(AXIS_SEL.y) + ': ' + fmtAxisVal(AXIS_SEL.y, getAxisValue(a, AXIS_SEL.y)) + '<br>' +
        getAxisLabel(AXIS_SEL.z) + ': ' + fmtAxisVal(AXIS_SEL.z, getAxisValue(a, AXIS_SEL.z))
      )

      traces.push({
        type: 'scatter3d',
        mode: 'lines+markers',
        name: prog,
        x: xs, y: ys, z: zs,
        text: texts,
        hovertemplate: '%{text}<extra></extra>',
        customdata: arts.map(a => a.id),
        marker: {
          size: 4,
          color: PROG_COLORS[prog],
          opacity: 0.85,
          line: { color: 'rgba(0,0,0,0.2)', width: 0.5 }
        },
        line: { color: PROG_COLORS[prog], width: 1.5 }
      })
    })
    return traces
  }

  function axisLayoutProps(axisKey) {
    const base = {
      title: { text: getAxisLabel(axisKey), font: { color: '#4a7090', size: 10 } },
      gridcolor: '#1a2840', zerolinecolor: '#2a3a5a',
      tickfont: { color: '#3a5870', size: 9 }
    }
    if (axisKey === 'date') {
      return Object.assign(base, {
        title: { text: '日付 (2025年)', font: { color: '#4a7090', size: 11 } },
        tickvals: [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
        ticktext: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月','']
      })
    }
    if (['score_y','score_z','sentiment','sentiment_gpt','score_z_gpt'].includes(axisKey)) {
      return Object.assign(base, { range: [-1.2, 1.2] })
    }
    if (axisKey === 'urgency_gpt') {
      return Object.assign(base, { range: [0, 1.1] })
    }
    if (axisKey === 'coverage') {
      return Object.assign(base, { tickformat: '.1%' })
    }
    // duration: auto range
    return base
  }

  function buildLayout() {
    // aspect ratio: date axis gets wider, score axes narrower, duration auto
    const axisAspect = (k) => k === 'date' ? 4 : k === 'duration' ? 2 : 1
    return {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor:  'rgba(0,0,0,0)',
      margin: { l: 0, r: 20, t: 10, b: 0 },
      legend: {
        x: 0.01, y: 0.98,
        bgcolor: 'rgba(12,18,32,0.8)',
        bordercolor: '#1a2840', borderwidth: 1,
        font: { color: '#8ab0d8', size: 11 }
      },
      scene: {
        bgcolor: 'rgba(8,12,24,1)',
        xaxis: axisLayoutProps('date'),
        yaxis: axisLayoutProps(AXIS_SEL.y),
        zaxis: axisLayoutProps(AXIS_SEL.z),
        camera: { eye: { x: 1.6, y: -1.6, z: 0.8 } },
        aspectmode: 'manual',
        aspectratio: {
          x: 4,
          y: axisAspect(AXIS_SEL.y),
          z: axisAspect(AXIS_SEL.z)
        }
      }
    }
  }

  const PLOTLY_CONFIG = {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
    displaylogo: false
  }

  function render() {
    updateAxisLegend()
    const traces = VIEW_MODE === 'total' ? buildTotalTrace(ALL_DATA) : buildTraces(ALL_DATA)
    if (traces.length === 0) {
      document.getElementById('plot').innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#3a5870;font-size:14px">データなし</div>'
      return
    }
    // 全体モードは番組フィルターを非表示
    document.getElementById('filters-toggle').style.display = VIEW_MODE === 'total' ? 'none' : ''
    if (VIEW_MODE === 'total') document.getElementById('filters-panel').style.display = 'none'
    Plotly.react('plot', traces, buildLayout(), PLOTLY_CONFIG)
  }

  function attachClick() {
    const el = document.getElementById('plot')
    el.on('plotly_click', (data) => {
      const pt = data.points?.[0]
      if (!pt || !pt.customdata) return
      const art = ALL_DATA.find(a => a.id === pt.customdata)
      if (!art) return
      showInfoCard(art)
    })
  }

  function showInfoCard(art) {
    document.getElementById('ic-program').textContent = art.program
    document.getElementById('ic-headline').textContent = art.headline
    document.getElementById('ic-date').textContent = art.date + (art.duration ? '  /  放送時間: ' + art.duration + '秒' : '')
    const sy = document.getElementById('ic-sy')
    const sz = document.getElementById('ic-sz')
    const yVal = getAxisValue(art, AXIS_SEL.y)
    const zVal = getAxisValue(art, AXIS_SEL.z)
    sy.textContent = fmtAxisVal(AXIS_SEL.y, yVal)
    sz.textContent = fmtAxisVal(AXIS_SEL.z, zVal)
    sy.style.color = (AXIS_SEL.y === 'duration') ? '#ffdd44' : scoreColor(yVal)
    sz.style.color = (AXIS_SEL.z === 'duration') ? '#ffdd44' : scoreColor(zVal)
    document.getElementById('info-card').style.display = 'block'
  }

  document.getElementById('info-close').addEventListener('click', () => {
    document.getElementById('info-card').style.display = 'none'
  })

  function buildFilters() {
    const container = document.getElementById('filters')
    container.innerHTML = ''
    PROGRAMS.forEach(prog => {
      const color = PROG_COLORS[prog]
      const label = document.createElement('label')
      label.innerHTML =
        '<input type="checkbox" checked>' +
        '<div class="dot" style="background:' + color + '"></div>' +
        prog
      const cb = label.querySelector('input')
      cb.addEventListener('change', () => {
        VISIBLE[prog] = cb.checked
        render()
      })
      container.appendChild(label)
    })
  }

  document.querySelectorAll('.topic-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.topic-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      CURRENT_TOPIC = tab.dataset.topic
      document.getElementById('info-card').style.display = 'none'
      loadData()
    })
  })

  async function loadData() {
    document.getElementById('stat-total').textContent = '…'
    const res = await fetch('/api/scored?topic=' + CURRENT_TOPIC)
    ALL_DATA = await res.json()
    document.getElementById('stat-total').textContent = ALL_DATA.length

    // 番組リストを動的に構築
    const progSet = [...new Set(ALL_DATA.map(a => a.program))].sort()
    PROGRAMS = progSet
    PROG_COLORS = {}
    VISIBLE = {}
    PROG_TOTAL = {}
    progSet.forEach((prog, i) => {
      PROG_COLORS[prog] = COLOR_PALETTE[i % COLOR_PALETTE.length]
      VISIBLE[prog] = true
      PROG_TOTAL[prog] = KNOWN_PROG_SEC[prog] ?? ALL_DATA.filter(a => a.program === prog).reduce((s, a) => s + (a.duration || 0), 0)
    })
    buildFilters()
    render()
    attachClick()
  }

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
        body: JSON.stringify({ axis_neg: neg, axis_pos: pos, topic: CURRENT_TOPIC, limit: 40 })
      })
      const scores = await res.json()
      const scoreMap = {}
      scores.forEach(s => { scoreMap[s.id] = s.score })

      const scored = ALL_DATA
        .filter(a => scoreMap[a.id] !== undefined)
        .map(a => ({ ...a, custom_score: scoreMap[a.id] }))
        .sort((a, b) => b.custom_score - a.custom_score)

      const top5 = scored.slice(0, 5)
      const bot5 = scored.slice(-5).reverse()
      const items = [
        ...top5.map(a => ({ s: a.custom_score, text: a.headline })),
        ...bot5.map(a => ({ s: a.custom_score, text: a.headline }))
      ]

      document.getElementById('cr-title').textContent = neg + ' ←→ ' + pos + ' （上位・下位5件）'
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

  // ── View mode toggle ─────────────────────────────────────────────────
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      VIEW_MODE = btn.dataset.view
      document.getElementById('info-card').style.display = 'none'
      render()
    })
  })

  // ── Filters panel toggle ─────────────────────────────────────────────
  document.getElementById('filters-toggle').addEventListener('click', () => {
    const panel = document.getElementById('filters-panel')
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block'
  })

  // ── Axis selector events ──────────────────────────────────────────────
  ;['y', 'z'].forEach(axis => {
    document.getElementById('sel-' + axis).addEventListener('change', (e) => {
      AXIS_SEL[axis] = e.target.value
      document.getElementById('info-card').style.display = 'none'
      render()
    })
  })

  loadData()
  </script>
</body>
</html>`
