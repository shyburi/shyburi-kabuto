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
    'SELECT id, headline, memo FROM scored_articles WHERE topic=? AND score_z=0 ORDER BY date ASC LIMIT ?'
  ).bind(topic, limit).all()

  let updated = 0
  const stmts = []

  for (const a of results) {
    let sz = 0.001  // デフォルト = 処理済みマーク
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
        const clamp = (v: number) => {
          const val = Math.max(-1, Math.min(1, v || 0))
          return val === 0 ? 0.001 : val
        }
        sz = clamp(s.z)
        updated++
      }
    } catch { /* エラー時はデフォルト値0.001で処理済みマーク */ }
    // score_zのみ更新（score_yは既存値を保持）
    stmts.push(
      c.env.DB.prepare(
        'UPDATE scored_articles SET score_z=? WHERE id=? AND topic=?'
      ).bind(sz, a.id, topic)
    )
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
  <title>鏡 KAGAMI — NTV Data Art</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700;900&family=Roboto+Mono:wght@300;400;700&display=swap" rel="stylesheet">
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Noto Sans JP', sans-serif;
  background: #f8fafc; 
  color: #334155; height: 100vh;
  display: flex; flex-direction: column; overflow: hidden;
}

/* ── ★ Splash Screen (Startup Animation) ── */
#splash-screen {
  position: fixed; inset: 0; z-index: 9999;
  background: #ffffff;
  display: flex; align-items: center; justify-content: center;
  animation: splashBg 2.5s forwards;
  pointer-events: auto; overflow: hidden;
}
@keyframes splashBg {
  0%, 60% { background: #ffffff; }
  60.1%, 100% { background: transparent; }
}
.splash-logo {
  height: 200px; width: auto; max-width: 80vw; object-fit: contain;
  opacity: 0; z-index: 2; animation: splashLogo 2.5s forwards;
}
@keyframes splashLogo {
  0% { opacity: 0; transform: translateY(10px); }
  12% { opacity: 1; transform: translateY(0); }
  36% { opacity: 1; transform: translateY(0); }
  44% { opacity: 0; transform: translateY(-10px); }
  100% { opacity: 0; }
}
.splash-line {
  position: absolute; top: 50%; left: 0; transform: translateY(-50%);
  height: 4px; background: #ff0a2d; width: 0; z-index: 3; animation: splashLine 2.5s forwards;
}
.splash-line::after {
  content: ''; position: absolute; top: 50%; right: 0; transform: translate(50%, -50%);
  width: 14px; height: 14px; background: #ffffff; border: 3px solid #ff0a2d; border-radius: 50%;
  box-shadow: 0 0 10px rgba(255, 10, 45, 0.5); animation: splashDot 2.5s forwards;
}
@keyframes splashDot {
  0%, 44% { opacity: 1; transform: translate(50%, -50%) scale(1); }
  45%, 100% { opacity: 0; transform: translate(50%, -50%) scale(0); } 
}
@keyframes splashLine {
  0%, 20% { width: 0; height: 4px; opacity: 1; animation-timing-function: cubic-bezier(0.7, 0, 0.3, 1); }
  36% { width: 100vw; height: 4px; opacity: 1; }
  44% { width: 100vw; height: 4px; opacity: 1; animation-timing-function: cubic-bezier(0.7, 0, 0.3, 1); }
  60% { width: 100vw; height: 100vh; opacity: 1; }
  60.1%, 100% { width: 100vw; height: 100vh; opacity: 0; }
}
.splash-hole {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 0; height: 0; border-radius: 50%; box-shadow: 0 0 0 0 transparent; background: transparent; z-index: 1;
  animation: splashHole 2.5s forwards;
}
@keyframes splashHole {
  0%, 60% { box-shadow: 0 0 0 0 transparent; width: 0; height: 0; }
  60.1%, 68% { box-shadow: 0 0 0 150vmax #ff0a2d; width: 0; height: 0; animation-timing-function: cubic-bezier(0.7, 0, 0.3, 1); }
  96%, 100% { box-shadow: 0 0 0 150vmax #ff0a2d; width: 250vmax; height: 250vmax; }
}

/* ── Typography & Globals ── */
.val, .al-key, .s-label, #anim-date, #vc-home, .fp-title { font-family: 'Roboto Mono', monospace !important; }

/* ── Top bar ─────────────────────────────────── */
#topbar {
  display: flex; flex-direction: column;
  background: #ffffff; border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0; z-index: 100; box-shadow: 0 2px 10px rgba(0,0,0,0.03);
}
.topbar-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 24px; width: 100%;
}
.topbar-logo { height: 24px; width: auto; object-fit: contain; }

/* メニュー開閉ボタン（PCでは非表示） */
#mobile-menu-toggle {
  display: none; background: transparent; border: 1px solid #cbd5e1; border-radius: 4px;
  padding: 6px 12px; font-size: 11px; color: #334155; cursor: pointer; font-weight: 700;
}

#topbar-controls {
  display: flex; align-items: center; gap: 16px; padding: 0 24px 12px 24px;
  flex-wrap: wrap; width: 100%;
}

#view-toggle { display: flex; gap: 4px; }
.view-btn, #filters-toggle {
  background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px;
  padding: 6px 14px; font-size: 11px; letter-spacing: 1px; color: #64748b; cursor: pointer;
  transition: all 0.2s ease; white-space: nowrap; font-weight: 500;
}
.view-btn.active { background: #ff0a2d; color: #ffffff; border-color: #ff0a2d; box-shadow: 0 2px 6px rgba(255, 10, 45, 0.3); }
.view-btn:hover:not(.active), #filters-toggle:hover { border-color: #cbd5e1; color: #334155; background: #e2e8f0; }

#axis-selectors { display: flex; gap: 16px; align-items: center; margin: 0 8px; flex-wrap: wrap; flex: 1; }
.ax-group { display: flex; align-items: center; gap: 8px; }
.ax-lbl { font-size: 10px; color: #94a3b8; letter-spacing: 1px; white-space: nowrap; font-weight: 500; }
#axis-selectors select {
  background: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px;
  padding: 4px 24px 4px 8px; color: #334155; font-size: 11px; font-weight: 500;
  cursor: pointer; appearance: none; transition: 0.2s;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center;
}
#axis-selectors select:focus { outline: none; border-color: #ff0a2d; box-shadow: 0 0 0 2px rgba(255, 10, 45, 0.1); }

#stats { font-size: 11px; color: #64748b; letter-spacing: 1px; margin-left: 8px; white-space: nowrap; }
#stats .val { color: #ff0a2d; font-size: 12px; margin-left: 4px; font-weight: 700; }

/* ── Filters Panel ── */
#filters-panel {
  position: absolute; top: 16px; right: 24px;
  background: rgba(255, 255, 255, 0.95); border: 1px solid #e2e8f0; border-radius: 6px;
  padding: 16px; display: none; z-index: 100;
  backdrop-filter: blur(12px); box-shadow: 0 10px 30px rgba(0,0,0,0.08); max-height: 70vh; overflow-y: auto;
}
.fp-title { font-size: 10px; color: #94a3b8; letter-spacing: 1px; margin-bottom: 12px; font-weight: 500; }
.fp-controls { display: flex; gap: 8px; margin-bottom: 12px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; }
.fp-controls button {
  flex: 1; padding: 6px 0; font-size: 10px; color: #64748b; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px;
  cursor: pointer; transition: 0.2s; font-family: 'Noto Sans JP', sans-serif; font-weight: 500;
}
.fp-controls button:hover { background: #e2e8f0; color: #334155; }
#filters-list { display: flex; flex-direction: column; gap: 10px; }
#filters-list label { display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; color: #475569; transition: 0.2s; font-weight: 500; }
#filters-list label:hover { color: #0f172a; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* ── Category Pie Chart ── */
#category-pie-wrap {
  position: absolute; top: 120px; right: 24px; width: 220px; height: 240px;
  background: rgba(255, 255, 255, 0.95); border: 1px solid #e2e8f0; border-top: 3px solid #ff0a2d;
  border-radius: 6px; padding: 12px; display: none; flex-direction: column; z-index: 40;
  box-shadow: 0 10px 30px rgba(0,0,0,0.08); backdrop-filter: blur(12px);
}
.pie-title { font-size: 11px; font-weight: 700; color: #334155; text-align: center; margin-bottom: 8px; letter-spacing: 1px; }
#category-pie { flex: 1; width: 100%; }

/* ── Plot & Legend ────────────────────────────────────── */
#plot-wrap { flex: 1; position: relative; min-height: 0; perspective: 1000px; touch-action: none; }
#plot { width: 100%; height: 100%; touch-action: none; }

#axis-legend {
  position: absolute; top: 16px; left: 24px; background: rgba(255, 255, 255, 0.9);
  border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 16px; font-size: 10px;
  pointer-events: none; z-index: 10; backdrop-filter: blur(8px); box-shadow: 0 4px 15px rgba(0,0,0,0.03);
}
#axis-legend .al-row { margin: 6px 0; color: #64748b; display: flex; gap: 8px; align-items: baseline;}
#axis-legend .al-key { color: #ff0a2d; font-weight: 700; width: 24px; }
#axis-legend .al-range { color: #334155; font-weight: 500; }

#event-telop {
  position: absolute; top: 30px; left: 50%; transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.95); border: 1px solid #e2e8f0;
  border-radius: 6px; padding: 14px 28px; text-align: center;
  box-shadow: 0 10px 30px rgba(0,0,0,0.08); backdrop-filter: blur(12px);
  pointer-events: none; transition: opacity 0.3s, transform 0.3s;
  opacity: 0; z-index: 60; min-width: 300px; max-width: 80%;
}
#event-telop.show { opacity: 1; transform: translate(-50%, 10px); }
.et-date { font-family: 'Roboto Mono', monospace; font-size: 11px; color: #ff0a2d; display: block; margin-bottom: 6px; letter-spacing: 1px; font-weight: 700; }
.et-headline { font-size: 15px; font-weight: 700; color: #1e293b; line-height: 1.6; word-wrap: break-word; }

/* ── ViewCube ──────── */
#viewcube-wrapper { position: absolute; top: 60px; right: 40px; width: 44px; height: 44px; perspective: 600px; z-index: 50; }
#viewcube { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; transform: rotateX(-30deg) rotateY(-45deg); transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1); }
#viewcube-wrapper:has(.vc-front:hover) #viewcube { transform: rotateX(-15deg) rotateY(-20deg); }
#viewcube-wrapper:has(.vc-right:hover) #viewcube { transform: rotateX(-15deg) rotateY(-70deg); }
#viewcube-wrapper:has(.vc-top:hover) #viewcube   { transform: rotateX(-55deg) rotateY(-45deg); }
#viewcube-wrapper:hover #viewcube:not(:has(.vc-face:hover)) { transform: rotateX(-25deg) rotateY(-40deg); }

.vc-face {
  position: absolute; width: 44px; height: 44px;
  background: rgba(255, 255, 255, 0.8); border: 1px solid #cbd5e1;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 500; color: #64748b;
  cursor: pointer; user-select: none; transition: all 0.3s; box-shadow: inset 0 0 5px rgba(0,0,0,0.05);
}
.vc-face:hover { background: #ff0a2d; color: #fff; border-color: #ff0a2d; }
.vc-front { transform: rotateY(0deg) translateZ(22px); }
.vc-right { transform: rotateY(90deg) translateZ(22px); }
.vc-top   { transform: rotateX(90deg) translateZ(22px); }

#vc-home {
  position: absolute; top: -30px; left: -15px;
  background: #ffffff; border: 1px solid #cbd5e1; border-radius: 50%;
  width: 24px; height: 24px; color: #64748b; cursor: pointer;
  font-size: 14px; display: flex; align-items: center; justify-content: center;
  transition: all 0.3s; line-height: 1; box-shadow: 0 2px 5px rgba(0,0,0,0.05);
}
#vc-home:hover { background: #ff0a2d; color: #fff; border-color: #ff0a2d; }

/* ── 2D Animation UI ────────── */
#anim-panel {
  position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); width: 90%; max-width: 500px;
  background: rgba(255, 255, 255, 0.95); border: 1px solid #e2e8f0; border-radius: 30px;
  padding: 8px 24px; display: flex; align-items: center; gap: 15px; z-index: 50;
  backdrop-filter: blur(8px); box-shadow: 0 10px 30px rgba(0,0,0,0.08);
}
#anim-play-btn {
  background: #ff0a2d; color: #fff; border: none; border-radius: 50%;
  width: 32px; height: 32px; font-size: 12px; cursor: pointer; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; transition: 0.3s; outline: none;
  box-shadow: 0 2px 8px rgba(255, 10, 45, 0.4); 
}
#anim-play-btn:hover { transform: scale(1.05); background: #e00927; }
#anim-play-btn.playing { background: #334155; box-shadow: 0 2px 8px rgba(51, 65, 85, 0.4); } 
#anim-date { font-size: 13px; font-weight: 700; color: #334155; width: 75px; text-align: right; flex-shrink: 0; }
.anim-progress-bar { flex: 1; height: 4px; background: #e2e8f0; border-radius: 2px; position: relative; cursor: pointer; }
.anim-progress-fill { height: 100%; background: #ff0a2d; border-radius: 2px; width: 0%; pointer-events: none; transition: width 0.05s linear; }
.anim-progress-bar::after { content:''; position:absolute; top:-10px; bottom:-10px; left:0; right:0; }
#timeline-markers { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
.tl-marker {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 12px; height: 12px; background: #ffffff; border: 2px solid #ff0a2d; border-radius: 50%;
  transition: 0.2s; pointer-events: auto; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
.tl-marker:hover { transform: translate(-50%, -50%) scale(1.3); background: #ff0a2d; z-index: 10; }
.tl-lbl {
  position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
  font-size: 10px; font-weight: 700; color: #64748b; font-family: 'Roboto Mono', monospace;
  white-space: nowrap; pointer-events: none;
}

/* ── Info card ─────── */
#info-card {
  position: absolute; bottom: 24px; left: 24px; width: 320px; max-width: 90vw;
  background: rgba(255, 255, 255, 0.95); border: 1px solid #e2e8f0; border-top: 3px solid #ff0a2d; border-radius: 6px;
  padding: 20px; display: none; z-index: 20; backdrop-filter: blur(12px); box-shadow: 0 10px 40px rgba(0,0,0,0.08);
}
#info-card .ic-program { font-size: 10px; letter-spacing: 1px; color: #ff0a2d; margin-bottom: 6px; font-weight: 700; }
#info-card .ic-headline { font-size: 15px; font-weight: 700; color: #1e293b; line-height: 1.5; margin-bottom: 12px; }
#info-card .ic-date { font-size: 11px; color: #64748b; margin-bottom: 16px; font-weight: 500; }
#info-card .ic-scores { display: flex; gap: 16px; padding-top: 16px; border-top: 1px solid #f1f5f9; }
.score-item { flex: 1; }
.score-item .s-label { font-size: 9px; color: #94a3b8; margin-bottom: 4px; font-weight: 500; }
.score-item .s-val { font-size: 18px; font-weight: 700; color: #334155; }
#info-close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; transition: 0.2s; }
#info-close:hover { color: #334155; }

/* ── ★ Responsive (スマホ向け) ── */
@media (max-width: 768px) {
  .topbar-header { padding: 10px 16px; }
  .topbar-logo { height: 20px; }
  
  #mobile-menu-toggle { display: block; }
  #topbar-controls { display: none; padding: 0 16px 12px 16px; flex-direction: column; align-items: stretch; gap: 12px; }
  #topbar-controls.open { display: flex; }
  
  #axis-selectors { flex-direction: column; align-items: stretch; width: 100%; margin: 0; }
  .ax-group { width: 100%; justify-content: space-between; }
  #axis-selectors select { width: 70%; }
  
  #view-toggle { justify-content: flex-start; }
  #stats { display: none; }
  
  /* ViewCubeを上部に移動 */
  #viewcube-wrapper { top: 60px; right: 16px; width: 36px; height: 36px; perspective: 400px; }
  .vc-face { width: 36px; height: 36px; font-size: 10px; }
  .vc-front { transform: rotateY(0deg) translateZ(18px); }
  .vc-right { transform: rotateY(90deg) translateZ(18px); }
  .vc-top   { transform: rotateX(90deg) translateZ(18px); }
  #vc-home { top: -26px; left: -10px; width: 22px; height: 22px; font-size: 12px; }
  
  #axis-legend { top: auto; bottom: 80px; left: 10px; padding: 8px 12px; font-size: 9px; background: rgba(255, 255, 255, 0.8); z-index: 5; }
  #category-pie-wrap { top: 110px; right: 10px; width: 150px; height: 180px; padding: 8px; }
  .pie-title { font-size: 10px; margin-bottom: 4px; }

  #info-card { left: 5%; bottom: 20px; width: 90%; padding: 16px; z-index: 100; }
  #info-card .ic-headline { font-size: 14px; }
}
  </style>
</head>
<body>

  <div id="splash-screen">
    <img src="data:image/png;base64,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" alt="日テレ NEWS" class="splash-logo">
    <div class="splash-line"></div>
    <div class="splash-hole"></div>
  </div>

  <div id="topbar">
    <div class="topbar-header">
      <img src="data:image/png;base64,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" alt="鏡 KAGAMI" class="topbar-logo">
      <button id="mobile-menu-toggle">メニューを開く ▼</button>
    </div>

    <div id="topbar-controls">
      <div id="axis-selectors">
        <div class="ax-group">
          <div class="ax-lbl">トピック</div>
          <select id="sel-topic">
            <option value="fuji_tv" selected>フジテレビ・中居問題</option>
            <option value="trump">トランプ関税</option>
            <option value="ukraine">ウクライナ</option>
          </select>
        </div>

        <div class="ax-group">
          <div class="ax-lbl">Y軸</div>
          <select id="sel-y">
            <option value="sentiment" selected>感情スコア(Llama)</option>
            <option value="combined_z">批判↔解決(辞書+AI)</option>
            <option value="duration">放送時間(秒)</option>
            <option value="coverage">報道割合</option>
            <option value="sentiment_gpt">感情スコア(GPT)</option>
            <option value="score_z_gpt">批判↔解決(GPT)</option>
            <option value="urgency_gpt">緊急度(GPT)</option>
          </select>
        </div>
        
        <div class="ax-group">
          <div class="ax-lbl">Z軸</div>
          <select id="sel-z">
            <option value="sentiment">感情スコア(Llama)</option>
            <option value="combined_z" selected>批判↔解決(辞書+AI)</option>
            <option value="duration">放送時間(秒)</option>
            <option value="coverage">報道割合</option>
            <option value="sentiment_gpt">感情スコア(GPT)</option>
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
        <span>データ数: <span class="val" id="stat-total">読込中...</span></span>
      </div>
      
      <button id="filters-toggle">番組フィルター ▾</button>
    </div>
  </div>

  <div id="plot-wrap">
    <div id="plot"></div>
    <div id="no-data-msg" style="display:none; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#888; font-family:'Roboto Mono',monospace; font-size:14px; letter-spacing:2px; z-index:5; pointer-events:none;">DATA NOT FOUND</div>
    
    <div id="event-telop">
      <span class="et-date" id="et-date"></span>
      <div class="et-headline" id="et-headline"></div>
    </div>

    <div id="filters-panel">
      <div class="fp-title">表示番組の切り替え</div>
      <div class="fp-controls">
        <button id="btn-check-all">すべて選択</button>
        <button id="btn-uncheck-all">すべて解除</button>
      </div>
      <div id="filters-list"></div>
    </div>

    <div id="category-pie-wrap">
      <div class="pie-title">カテゴリ分布</div>
      <div id="category-pie"></div>
    </div>

    <div id="axis-legend">
      <div class="al-row"><span class="al-key">X軸</span> <span id="al-x">日付 (2025年)</span></div>
      <div class="al-row"><span class="al-key">Y軸</span> <span id="al-y"></span></div>
      <div class="al-row"><span class="al-key">Z軸</span> <span id="al-z"></span></div>
    </div>

    <div id="viewcube-wrapper">
      <button id="vc-home" title="視点リセット">⌖</button>
      <div id="viewcube">
        <div class="vc-face vc-front" data-cam="front">前</div>
        <div class="vc-face vc-right" data-cam="right">右</div>
        <div class="vc-face vc-top" data-cam="top">上</div>
      </div>
    </div>

    <div id="anim-panel" style="display:none;">
      <button id="anim-play-btn">▶</button>
      <div class="anim-progress-bar" id="anim-progress-bar">
        <div class="anim-progress-fill" id="anim-progress-fill"></div>
        <div id="timeline-markers"></div>
      </div>
      <div id="anim-date">2025/01/01</div>
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

  <script>
let DATA = [];
let PROGRAMS = [];
let VISIBLE = {};
let PROG_COLORS = {};
let TOPIC_TOTAL = 0;
let PROG_TOTAL = {};
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
};

const KNOWN_COLORS = { 'ストレイトニュース': '#2563eb', 'バンキシャ': '#ea580c', 'ミヤネ屋': '#9333ea' };
const FALLBACK_PALETTE = ['#059669', '#dc2626', '#d97706', '#0891b2', '#7c3aed', '#db2777'];

let CURRENT_TOPIC = 'fuji_tv';
let CURRENT_VIEW = 'iso';
let AXIS_SEL = { y: 'sentiment', z: 'combined_z' };
let VIEW_MODE = 'program';

const TOPIC_CONFIG = {
  fuji_tv: {
    yLabel: '被害者・告発側視点 ← → 加害者・組織側視点', zLabel: '批判・問題提起 ← → 解決・改革志向',
    yNeg: '被害者・告発側', yPos: '加害者・組織側', zNeg: '批判・問題提起', zPos: '解決・改革志向',
  },
  trump: {
    yLabel: '日本への影響・国内視点 ← → 国際・外交視点', zLabel: '懸念・批判 ← → 対応・適応志向',
    yNeg: '国内・日本への影響', yPos: '国際・外交', zNeg: '懸念・批判', zPos: '対応・適応',
  },
  ukraine: {
    yLabel: '現場・被害者視点 ← → 政治・外交視点', zLabel: '悲観・批判 ← → 解決・和平志向',
    yNeg: '現場・被害者', yPos: '政治・外交', zNeg: '悲観・批判', zPos: '解決・和平',
  }
};

let animTracerIndices = []; 
let SMOOTH_TRACKS = {}; 
let isPlaying2D = false;
let animProgress = 1.0; 
let lastTime2D = 0;
let animReqId;
const ANIM_DURATION = 15000; 
let AUTO_EVENTS = []; 

PROG_COLORS['日テレ全体'] = '#ff0a2d';

function dateToDays(s) {
  const base = Date.UTC(2025, 0, 1);
  const d = Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10));
  return Math.round((d - base) / 86400000);
}

function getAxisValue(art, axisKey) {
  if (axisKey === 'date') return dateToDays(art.date);
  if (axisKey === 'duration') return art.duration || 0;
  if (axisKey === 'sentiment') return art.sentiment || 0;
  if (axisKey === 'sentiment_gpt') return art.sentiment_gpt || 0;
  if (axisKey === 'score_z_gpt') return art.score_z_gpt || 0;
  if (axisKey === 'urgency_gpt') return art.urgency_gpt || 0;
  if (axisKey === 'combined_z') return art.combined_z !== undefined ? art.combined_z : ((art.dict_score || 0) * 0.2 + (art.score_z || 0) * 0.8);
  if (axisKey === 'coverage') return PROG_TOTAL[art.program] > 0 ? (art.duration || 0) / PROG_TOTAL[art.program] : 0;
  return 0;
}

function getAxisLabel(axisKey) {
  const cfg = TOPIC_CONFIG[CURRENT_TOPIC];
  if (axisKey === 'date') return '日付 (2025年)';
  if (axisKey === 'duration') return '放送時間 (秒)';
  if (axisKey === 'sentiment') return 'ネガティブ ← → ポジティブ (Llama)';
  if (axisKey === 'sentiment_gpt') return 'ネガティブ ← → ポジティブ (GPT)';
  if (axisKey === 'score_z_gpt') return '批判↔解決 (GPT)';
  if (axisKey === 'urgency_gpt') return '緊急度 (GPT)';
  if (axisKey === 'combined_z') return cfg.zLabel + ' (辞書+AI)';
  if (axisKey === 'coverage') return '報道割合 (トピック全体比)';
  return axisKey;
}

function getAxisRange(axisKey) {
  if (axisKey === 'date') return [-10, 375];
  if (['sentiment', 'combined_z', 'sentiment_gpt', 'score_z_gpt'].includes(axisKey)) return [-1.2, 1.2];
  if (axisKey === 'urgency_gpt') return [0, 1.1];
  return null;
}

function scoreColor(v) {
  if (v > 0.3) return '#10b981'; 
  if (v < -0.3) return '#ef4444'; 
  return '#94a3b8'; 
}

function updateAxisLegend() {
  document.getElementById('al-y').textContent = getAxisLabel(AXIS_SEL.y);
  document.getElementById('al-z').textContent = getAxisLabel(AXIS_SEL.z);
  document.getElementById('ic-y-label').textContent = getAxisLabel(AXIS_SEL.y);
  document.getElementById('ic-z-label').textContent = getAxisLabel(AXIS_SEL.z);
}

function extractAutoEvents(data) {
  const byDate = {};
  data.forEach(a => {
    if (!byDate[a.date]) byDate[a.date] = { duration: 0, arts: [] };
    byDate[a.date].duration += (a.duration || 0);
    byDate[a.date].arts.push(a);
  });

  const sortedDays = Object.keys(byDate).sort((a, b) => byDate[b].duration - byDate[a].duration);
  const topDays = sortedDays.slice(0, 6).sort(); 

  AUTO_EVENTS = topDays.map(date => {
    const dayArts = byDate[date].arts.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    let rawHeadline = dayArts[0].headline;
    let cleanHeadline = rawHeadline.replace(/[<＜【\\[][^>＞】\\]]+[>＞】\\]]/g, '').trim();
    if (!cleanHeadline) cleanHeadline = rawHeadline;
    return { date: date, headline: cleanHeadline };
  });

  const container = document.getElementById('timeline-markers');
  if (container) {
    container.innerHTML = '';
    const baseDate = Date.UTC(2025, 0, 1);
    const range = 365 * 86400000;
    AUTO_EVENTS.forEach(ev => {
      const dParts = ev.date.split('-');
      const evDate = Date.UTC(+dParts[0], +dParts[1]-1, +dParts[2]);
      const pct = ((evDate - baseDate) / range) * 100;
      const shortDate = \`\${dParts[1]}/\${dParts[2]}\`;
      
      const marker = document.createElement('div');
      marker.className = 'tl-marker';
      marker.style.left = pct + '%';
      marker.title = \`\${ev.date}\\n\${ev.headline}\`;
      marker.innerHTML = \`<div class="tl-lbl">\${shortDate}</div>\`;
      
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        animProgress = pct / 100;
        updateAnimUI();
        updateTracers();
      });
      
      container.appendChild(marker);
    });
  }
}

function getProcessedData() {
  if (VIEW_MODE === 'program') {
    return { data: DATA, progs: PROGRAMS.filter(p => VISIBLE[p]) };
  } else {
    const byDate = {};
    DATA.forEach(a => {
      if (!byDate[a.date]) byDate[a.date] = { count: 0, duration: 0, sentiment: [], combined_z: [], sentiment_gpt: [], score_z_gpt: [], urgency_gpt: [] };
      byDate[a.date].count++;
      byDate[a.date].duration += (a.duration || 0);
      if (a.sentiment !== undefined && a.sentiment !== null) byDate[a.date].sentiment.push(a.sentiment);
      
      if (a.sentiment_gpt !== undefined && a.sentiment_gpt !== null) byDate[a.date].sentiment_gpt.push(a.sentiment_gpt);
      if (a.score_z_gpt !== undefined && a.score_z_gpt !== null) byDate[a.date].score_z_gpt.push(a.score_z_gpt);
      if (a.urgency_gpt !== undefined && a.urgency_gpt !== null) byDate[a.date].urgency_gpt.push(a.urgency_gpt);

      const cz = (a.dict_score || 0) * 0.2 + (a.score_z || 0) * 0.8;
      if (cz !== undefined && cz !== null) byDate[a.date].combined_z.push(cz);
    });
    
    const avg = arr => arr.length ? arr.reduce((a,b)=>a+b)/arr.length : 0;

    const totalData = Object.keys(byDate).sort().map(d => {
      const entry = byDate[d];
      return {
        id: 'total_' + d, program: '日テレ全体', date: d, headline: \`報道件数: \${entry.count}件\`, 
        duration: entry.duration,
        sentiment: avg(entry.sentiment),
        sentiment_gpt: avg(entry.sentiment_gpt),
        score_z_gpt: avg(entry.score_z_gpt),
        urgency_gpt: avg(entry.urgency_gpt),
        combined_z: avg(entry.combined_z),
        count: entry.count
      };
    });
    return { data: totalData, progs: ['日テレ全体'] };
  }
}

function drawCategoryPie() {
  const catCounts = {};
  let total = 0;
  
  DATA.forEach(a => {
    const cat = a.genre || '未分類';
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    total++;
  });

  if (total === 0) return;

  const labels = Object.keys(catCounts);
  const values = Object.values(catCounts);

  const pieColors = ['#ff0a2d', '#00a0e9', '#facc15', '#10b981', '#9333ea', '#fb923c', '#94a3b8'];

  const trace = [{
    type: 'pie',
    labels: labels,
    values: values,
    hole: 0.45,
    textinfo: 'label+percent',
    textposition: 'inside',
    insidetextorientation: 'radial',
    marker: {
      colors: pieColors,
      line: { color: '#ffffff', width: 2 }
    },
    hoverinfo: 'label+value',
    textfont: { family: 'Noto Sans JP', size: 10, color: '#ffffff', weight: 'bold' }
  }];

  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 0, b: 0, l: 0, r: 0 },
    showlegend: false
  };

  Plotly.react('category-pie', trace, layout, { displayModeBar: false });
}

function generateSmoothPath(arts, segments = 20) {
  if (arts.length < 2) {
    if (arts.length === 1) return { days: [dateToDays(arts[0].date)], y: [getAxisValue(arts[0], AXIS_SEL.y)], z: [getAxisValue(arts[0], AXIS_SEL.z)] };
    return { days: [], y: [], z: [] };
  }
  const getP = (arr, i) => arr[Math.max(0, Math.min(arr.length - 1, i))];
  const oDays = [], oY = [], oZ = [];
  const daysArr = arts.map(a => dateToDays(a.date));
  const yArr = arts.map(a => getAxisValue(a, AXIS_SEL.y));
  const zArr = arts.map(a => getAxisValue(a, AXIS_SEL.z));

  for (let i = 0; i < arts.length - 1; i++) {
    for (let t = 0; t < segments; t++) {
      const st = t / segments, st2 = st * st, st3 = st2 * st;
      const py0 = getP(yArr, i - 1), py1 = getP(yArr, i), py2 = getP(yArr, i + 1), py3 = getP(yArr, i + 2);
      const pz0 = getP(zArr, i - 1), pz1 = getP(zArr, i), pz2 = getP(zArr, i + 1), pz3 = getP(zArr, i + 2);
      const d1 = daysArr[i], d2 = daysArr[i+1];
      const day = d1 + (d2 - d1) * st;
      const sy = 0.5 * ((2 * py1) + (-py0 + py2) * st + (2 * py0 - 5 * py1 + 4 * py2 - py3) * st2 + (-py0 + 3 * py1 - 3 * py2 + py3) * st3);
      const sz = 0.5 * ((2 * pz1) + (-pz0 + pz2) * st + (2 * pz0 - 5 * pz1 + 4 * pz2 - pz3) * st2 + (-pz0 + 3 * pz1 - 3 * pz2 + pz3) * st3);
      oDays.push(day); oY.push(sy); oZ.push(sz);
    }
  }
  const last = arts.length - 1;
  oDays.push(daysArr[last]); oY.push(yArr[last]); oZ.push(zArr[last]);
  return { days: oDays, y: oY, z: oZ };
}

function fmtTooltipVal(val, axisKey) {
  if (axisKey === 'coverage') return (val * 100).toFixed(1) + '%';
  if (axisKey === 'duration') return val + '秒';
  return val.toFixed(2);
}

function buildTraces() {
  const traces = [];
  animTracerIndices = [];
  SMOOTH_TRACKS = {};
  const isSideView = (CURRENT_VIEW === 'right' || CURRENT_VIEW === 'left');
  const { data, progs } = getProcessedData();

  progs.forEach((prog, pi) => {
    const arts = data.filter(a => a.program === prog).sort((a,b) => a.date.localeCompare(b.date));
    if (!arts.length) return;

    const xs = arts.map(a => dateToDays(a.date));
    const ys = arts.map(a => getAxisValue(a, AXIS_SEL.y));
    const zs = arts.map(a => getAxisValue(a, AXIS_SEL.z));
    
    const colors = PROG_COLORS[prog];
    
    const markerSizes3D = VIEW_MODE === 'program' ? 4 : arts.map(a => Math.max(5, Math.min(18, a.count * 1.5)));
    const markerSizes2D = VIEW_MODE === 'program' ? 5 : arts.map(a => Math.max(6, Math.min(20, a.count * 1.5)));
    const markerSizesFeatures = VIEW_MODE === 'program' ? 7 : arts.map(a => Math.max(8, Math.min(22, a.count * 1.5)));

    const textData = VIEW_MODE === 'program'
      ? arts.map(a => \`<b>\${a.headline}</b><br>\${a.date} | \${prog} (放送時間: \${a.duration || 0}秒)<br>\${getAxisLabel(AXIS_SEL.y)}: \${fmtTooltipVal(getAxisValue(a, AXIS_SEL.y), AXIS_SEL.y)}<br>\${getAxisLabel(AXIS_SEL.z)}: \${fmtTooltipVal(getAxisValue(a, AXIS_SEL.z), AXIS_SEL.z)}\`)
      : arts.map(a => \`<b>\${a.date}</b><br>\${prog}<br>報道件数: \${a.count}件 / 累計放送時間: \${a.duration}秒<br>\${getAxisLabel(AXIS_SEL.y)}: \${fmtTooltipVal(getAxisValue(a, AXIS_SEL.y), AXIS_SEL.y)}<br>\${getAxisLabel(AXIS_SEL.z)}: \${fmtTooltipVal(getAxisValue(a, AXIS_SEL.z), AXIS_SEL.z)}\`);

    const cScaleProps = {};

    if (!isSideView) {
      let xData = xs, yData = ys, zData = zs;
      let traceType = 'scatter3d'; 

      if (CURRENT_VIEW === 'top' || CURRENT_VIEW === 'bottom') { traceType = 'scatter'; zData = undefined; } 
      else if (CURRENT_VIEW === 'front' || CURRENT_VIEW === 'back') { traceType = 'scatter'; yData = zs; zData = undefined; }

      const trace = {
        name: prog, mode: 'lines+markers', customdata: arts.map(a => a.id),
        text: textData, hovertemplate: '%{text}<extra></extra>', line: { color: PROG_COLORS[prog], width: VIEW_MODE === 'total' ? 2 : 1.5 }
      };

      if (traceType === 'scatter3d') {
        Object.assign(trace, { type: 'scatter3d', x: xData, y: yData, z: zData, marker: { size: markerSizes3D, color: colors, opacity: 0.9, line: { color: '#ffffff', width: 0.5 }, ...cScaleProps } });
      } else {
        Object.assign(trace, { type: 'scatter', x: xData, y: yData, marker: { size: markerSizes2D, color: colors, opacity: 0.9, line: { color: '#ffffff', width: 0.5 }, ...cScaleProps } });
      }


      traces.push(trace);
    } else {
      SMOOTH_TRACKS[prog] = generateSmoothPath(arts, 20); 

      const lineTraceIdx = traces.length;
      traces.push({
        type: 'scatter', mode: 'lines', name: prog + ' (軌跡)',
        x: [SMOOTH_TRACKS[prog].y[0]], y: [SMOOTH_TRACKS[prog].z[0]],
        line: { color: PROG_COLORS[prog], width: VIEW_MODE === 'total' ? 3 : 2, shape: 'linear' }, hoverinfo: 'none', showlegend: false
      });

      const markerTraceIdx = traces.length;
      traces.push({
        type: 'scatter', mode: 'markers', name: prog + ' (現在)',
        x: [SMOOTH_TRACKS[prog].y[0]], y: [SMOOTH_TRACKS[prog].z[0]],
        marker: { size: 14, color: '#ffffff', line: { color: PROG_COLORS[prog], width: 3 }, symbol: 'circle' }, hoverinfo: 'none', showlegend: false
      });

      traces.push({
        type: 'scatter', mode: 'markers', name: prog + ' (記事)', customdata: arts.map(a => a.id),
        x: ys, y: zs, text: textData, hovertemplate: '%{text}<extra></extra>',
        marker: { size: markerSizesFeatures, color: colors, opacity: 1.0, line: { color: '#ffffff', width: 1.5 }, ...cScaleProps }
      });



      animTracerIndices.push({ line: lineTraceIdx, marker: markerTraceIdx, prog: prog });
    }
  });
  return traces;
}

function getLayout(forceNewPlot = false) {
  const isMobile = window.innerWidth < 768; 
  
  const layout = {
    showlegend: false,
    paper_bgcolor: '#f8fafc', plot_bgcolor: '#f8fafc',
    margin: isMobile ? { l: 20, r: 20, t: 20, b: 60 } : { l: 60, r: 50, t: 50, b: 80 },
    uirevision: 'true' 
  };
  
  const yRange = getAxisRange(AXIS_SEL.y);
  const zRange = getAxisRange(AXIS_SEL.z);
  const axBase = { gridcolor: '#e2e8f0', zerolinecolor: '#cbd5e1', zerolinewidth: 2, tickfont: { color: '#64748b', size: 9 } };

  const axisDate = { ...axBase, title: { text: '日付 (2025年)', font: { color: '#475569', size: 11, weight: 'bold' } }, tickvals: [0,31,59,90,120,151,181,212,243,273,304,334], ticktext: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'], range: [-10, 375], autorange: false };
  const axisY = { ...axBase, title: { text: getAxisLabel(AXIS_SEL.y), font: { color: '#475569', size: 11, weight: 'bold' } }, range: yRange, autorange: yRange === null, constrain: 'domain' };
  const axisZ = { ...axBase, title: { text: getAxisLabel(AXIS_SEL.z), font: { color: '#475569', size: 11, weight: 'bold' } }, range: zRange, autorange: zRange === null, constrain: 'domain' };

  const annotations3D = [];
  const annotations2D = [];
  const shapes2D = [];

  if (AUTO_EVENTS && AUTO_EVENTS.length > 0) {
    AUTO_EVENTS.forEach((ev, i) => {
      const evDays = dateToDays(ev.date);
      const shortDate = ev.date.substring(5).replace('-', '/');
      
      let chunkedHead = '';
      const chunkSize = 11;
      for (let j = 0; j < ev.headline.length; j += chunkSize) {
        chunkedHead += ev.headline.substring(j, j + chunkSize) + '<br>';
      }
      chunkedHead = chunkedHead.replace(/<br>$/, '');

      const labelText = \`<b>\${shortDate}</b><br>\${chunkedHead}\`;

      const yPos = (i % 2 === 0) ? 1.0 : -1.0;
      annotations3D.push({
        x: evDays, y: yPos, z: -1.2,
        text: labelText, showarrow: true, arrowcolor: '#94a3b8', arrowwidth: 1, arrowhead: 0,
        ax: 0, ay: -50, 
        font: { size: 9, color: '#1e293b', family: 'Noto Sans JP' },
        bgcolor: 'rgba(255, 255, 255, 0.9)', bordercolor: '#cbd5e1', borderpad: 4,
        align: 'left'
      });

      shapes2D.push({
        type: 'line', x0: evDays, x1: evDays, y0: -1.2, y1: 1.2,
        line: { color: '#94a3b8', width: 1, dash: 'dot' }
      });
      annotations2D.push({
        x: evDays, y: 1.1, text: labelText, showarrow: false,
        font: { size: 9, color: '#1e293b', family: 'Noto Sans JP' },
        textangle: -90, xanchor: 'right', yanchor: 'top', 
        bgcolor: 'rgba(255, 255, 255, 0.9)', bordercolor: '#cbd5e1', borderpad: 4,
        align: 'left' 
      });
    });
  }

  if (CURRENT_VIEW === 'iso') {
    // ★ 3Dビューのデフォルトドラッグモードを 'turntable' (回転)に固定。
    // スマホではこれにより、1本指＝回転、2本指＝移動（Pan）、ピンチ＝ズーム が自動適用されます。
    const sceneConfig = { 
      uirevision: 'true', bgcolor: '#f8fafc', dragmode: 'turntable', xaxis: axisDate, yaxis: axisY, zaxis: axisZ, 
      aspectmode: 'manual', aspectratio: { x: 4, y: 1, z: 1 },
      annotations: annotations3D 
    };

    const plotDiv = document.getElementById('plot');
    if (forceNewPlot) {
      sceneConfig.camera = { eye: { x: 1.6, y: -1.6, z: 0.8 }, up: { x: 0, y: 0, z: 1 } };
    } else if (plotDiv && plotDiv.layout && plotDiv.layout.scene && plotDiv.layout.scene.camera) {
      sceneConfig.camera = plotDiv.layout.scene.camera;
    }

    return {
      ...layout,
      margin: isMobile ? { l: 0, r: 10, t: 10, b: 0 } : { l: 0, r: 40, t: 10, b: 0 }, 
      scene: sceneConfig
    };
  } else {
    // 2Dビューでは常に移動（pan）モード
    layout.dragmode = 'pan'; 
    if (CURRENT_VIEW === 'top' || CURRENT_VIEW === 'bottom') {
      layout.xaxis = axisDate; layout.yaxis = axisY; layout.title = { text: '【上面ビュー】 時間 × Y軸', font: { color: '#334155', size: 14 } };
      layout.annotations = annotations2D; layout.shapes = shapes2D;
    } else if (CURRENT_VIEW === 'front' || CURRENT_VIEW === 'back') {
      layout.xaxis = axisDate; layout.yaxis = axisZ; layout.title = { text: '【正面ビュー】 時間 × Z軸', font: { color: '#334155', size: 14 } };
      layout.annotations = annotations2D; layout.shapes = shapes2D;
    } else if (CURRENT_VIEW === 'right' || CURRENT_VIEW === 'left') {
      layout.xaxis = axisY; layout.yaxis = axisZ;
      if(yRange !== null && zRange !== null) { layout.yaxis.scaleanchor = "x"; layout.yaxis.scaleratio = 1; }
      layout.title = { text: '【側面ビュー】 Y軸 × Z軸 (時系列アニメーション対応)', font: { color: '#334155', size: 14 } };
    }
    return layout;
  }
}

function animLoop(timestamp) {
  if (!lastTime2D) lastTime2D = timestamp;
  const dt = timestamp - lastTime2D;
  lastTime2D = timestamp;
  if (isPlaying2D) {
    animProgress += dt / ANIM_DURATION;
    if (animProgress > 1) animProgress = 0;
    updateAnimUI(); updateTracers();
  }
  animReqId = requestAnimationFrame(animLoop);
}

function updateAnimUI() {
  document.getElementById('anim-progress-fill').style.width = (animProgress * 100) + '%';
  const currentDayOffset = Math.floor(animProgress * 365);
  const baseDate = new Date(Date.UTC(2025, 0, 1));
  baseDate.setUTCDate(baseDate.getUTCDate() + currentDayOffset);
  const y = baseDate.getUTCFullYear();
  const m = String(baseDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(baseDate.getUTCDate()).padStart(2, '0');
  const currentDateStr = \`\${y}-\${m}-\${d}\`;
  document.getElementById('anim-date').textContent = currentDateStr.replace(/-/g, '/');

  const telop = document.getElementById('event-telop');
  const activeEvent = AUTO_EVENTS.find(e => e.date === currentDateStr);
  if (activeEvent) {
    document.getElementById('et-date').textContent = activeEvent.date.replace(/-/g, '/');
    document.getElementById('et-headline').textContent = activeEvent.headline;
    telop.classList.add('show');
  } else {
    telop.classList.remove('show');
  }
}

function updateTracers() {
  if (animTracerIndices.length === 0) return;
  const plotDiv = document.getElementById('plot');
  if (!plotDiv.data) return;

  const currentDay = animProgress * 365; 
  const updateData = { x: [], y: [] };
  const traceIndices = [];

  animTracerIndices.forEach(item => {
    const track = SMOOTH_TRACKS[item.prog];
    if (!track || track.days.length === 0) return;

    let sliceEnd = 0;
    for (let i = 0; i < track.days.length; i++) {
      if (track.days[i] <= currentDay) sliceEnd = i;
      else break;
    }
    
    let currX = track.y[sliceEnd]; let currY = track.z[sliceEnd];
    let lineXs = track.y.slice(0, sliceEnd + 1); let lineYs = track.z.slice(0, sliceEnd + 1);

    if (sliceEnd < track.days.length - 1 && track.days[sliceEnd] <= currentDay) {
      const d1 = track.days[sliceEnd], d2 = track.days[sliceEnd + 1];
      if (d2 > d1) {
        const t = (currentDay - d1) / (d2 - d1);
        currX = track.y[sliceEnd] + (track.y[sliceEnd+1] - track.y[sliceEnd]) * t;
        currY = track.z[sliceEnd] + (track.z[sliceEnd+1] - track.z[sliceEnd]) * t;
        lineXs.push(currX); lineYs.push(currY);
      }
    }
    updateData.x.push(lineXs, [currX]); updateData.y.push(lineYs, [currY]);
    traceIndices.push(item.line, item.marker);
  });
  Plotly.restyle(plotDiv, updateData, traceIndices);
}

document.getElementById('anim-play-btn').addEventListener('click', () => {
  isPlaying2D = !isPlaying2D;
  const btn = document.getElementById('anim-play-btn');
  if (isPlaying2D) { btn.textContent = '⏸'; btn.classList.add('playing'); } 
  else { btn.textContent = '▶'; btn.classList.remove('playing'); }
});

const pBar = document.getElementById('anim-progress-bar');
pBar.addEventListener('click', (e) => {
  const rect = pBar.getBoundingClientRect();
  animProgress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  updateAnimUI(); updateTracers();
});

function render(forceNewPlot = false) {
  updateAxisLegend();
  const traces = buildTraces();
  const noDataMsg = document.getElementById('no-data-msg');
  if (!traces.length) noDataMsg.style.display = 'block';
  else noDataMsg.style.display = 'none';

  const layout = getLayout(forceNewPlot);
  const config = { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: true };
  const isSideView = (CURRENT_VIEW === 'right' || CURRENT_VIEW === 'left');

  document.getElementById('filters-toggle').style.display = VIEW_MODE === 'total' ? 'none' : '';

  const pieWrap = document.getElementById('category-pie-wrap');
  if (VIEW_MODE === 'total') {
    pieWrap.style.display = 'flex';
    drawCategoryPie();
  } else {
    pieWrap.style.display = 'none';
  }

  if (isSideView) {
    document.getElementById('anim-panel').style.display = 'flex';
    if (!animReqId) {
      animProgress = 1.0; updateAnimUI();
      lastTime2D = performance.now(); animReqId = requestAnimationFrame(animLoop);
    }
  } else {
    document.getElementById('anim-panel').style.display = 'none';
    document.getElementById('event-telop').classList.remove('show'); 
    if (animReqId) { cancelAnimationFrame(animReqId); animReqId = null; }
    isPlaying2D = false;
    document.getElementById('anim-play-btn').textContent = '▶'; document.getElementById('anim-play-btn').classList.remove('playing');
  }

  const p = forceNewPlot ? Plotly.newPlot('plot', traces, layout, config) : Plotly.react('plot', traces, layout, config);
  p.then(() => { attachClickEvent(); if (isSideView) updateTracers(); });
}

function attachClickEvent() {
  const plotDiv = document.getElementById('plot');
  if (plotDiv.removeAllListeners) plotDiv.removeAllListeners('plotly_click');
  plotDiv.on('plotly_click', data => {
    const pt = data.points?.[0];
    if (!pt?.customdata) return;
    
    let art;
    if (VIEW_MODE === 'program') {
      art = DATA.find(a => a.id === pt.customdata);
    } else {
      const { data: totalData } = getProcessedData();
      art = totalData.find(a => a.id === pt.customdata);
    }
    
    if (!art) return;
    showInfo(art);
  });
}

document.querySelectorAll('.vc-face').forEach(face => {
  face.addEventListener('click', (e) => {
    CURRENT_VIEW = e.target.dataset.cam;
    if (CURRENT_VIEW === 'right' || CURRENT_VIEW === 'left') animProgress = 1.0;
    render(true);
  });
});

document.getElementById('vc-home').addEventListener('click', () => { CURRENT_VIEW = 'iso'; render(true); });

document.getElementById('sel-topic').addEventListener('change', (e) => {
  CURRENT_TOPIC = e.target.value;
  document.getElementById('info-card').style.display = 'none';
  document.getElementById('filters-panel').style.display = 'none';
  
  if (window.innerWidth <= 768) {
    document.getElementById('topbar-controls').classList.remove('open');
    document.getElementById('mobile-menu-toggle').textContent = 'メニューを開く ▼';
  }
  
  loadData();
});

;['y', 'z'].forEach(axis => {
  document.getElementById('sel-' + axis).addEventListener('change', (e) => {
    AXIS_SEL[axis] = e.target.value;
    document.getElementById('info-card').style.display = 'none';
    document.getElementById('filters-panel').style.display = 'none';
    render(true); 
  });
});

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    VIEW_MODE = btn.dataset.view;
    document.getElementById('info-card').style.display = 'none';
    document.getElementById('filters-panel').style.display = 'none';
    
    if (window.innerWidth <= 768) {
      document.getElementById('topbar-controls').classList.remove('open');
      document.getElementById('mobile-menu-toggle').textContent = 'メニューを開く ▼';
    }
    render(true);
  });
});

document.getElementById('filters-toggle').addEventListener('click', () => {
  const panel = document.getElementById('filters-panel');
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
});

document.getElementById('mobile-menu-toggle').addEventListener('click', (e) => {
  const controls = document.getElementById('topbar-controls');
  controls.classList.toggle('open');
  if (controls.classList.contains('open')) {
    e.target.textContent = 'メニューを閉じる ▲';
  } else {
    e.target.textContent = 'メニューを開く ▼';
  }
});

document.getElementById('btn-check-all').addEventListener('click', () => {
  PROGRAMS.forEach(prog => VISIBLE[prog] = true);
  document.querySelectorAll('#filters-list input[type="checkbox"]').forEach(cb => cb.checked = true);
  render(false);
});

document.getElementById('btn-uncheck-all').addEventListener('click', () => {
  PROGRAMS.forEach(prog => VISIBLE[prog] = false);
  document.querySelectorAll('#filters-list input[type="checkbox"]').forEach(cb => cb.checked = false);
  render(false);
});

function showInfo(art) {
  document.getElementById('ic-program').textContent = art.program;
  document.getElementById('ic-headline').textContent = VIEW_MODE === 'program' ? art.headline : \`報道件数: \${art.count}件\`;
  document.getElementById('ic-date').textContent = art.date + (art.duration ? \` (放送時間: \${art.duration}秒)\` : '');

  const formatVal = (v, axisKey) => {
    if (axisKey === 'duration') return \`<span style="font-size:10px; color:#94a3b8; font-weight:500; display:block; margin-bottom:2px; letter-spacing:1px;">放送時間</span>\${v || 0}秒\`;
    if (axisKey === 'coverage') return \`<span style="font-size:10px; color:#94a3b8; font-weight:500; display:block; margin-bottom:2px; letter-spacing:1px;">報道割合</span>\${(v * 100).toFixed(1)}%\`;

    const num = +v || 0;
    const sign = num >= 0 ? '+' : '';
    const cfg = TOPIC_CONFIG[CURRENT_TOPIC];
    
    let negText = 'ネガティブ', posText = 'ポジティブ';
    if (axisKey === 'combined_z' || axisKey === 'score_z_gpt') { negText = cfg.zNeg; posText = cfg.zPos; }
    if (axisKey === 'urgency_gpt') return \`<span style="font-size:10px; color:#94a3b8; font-weight:500; display:block; margin-bottom:2px; letter-spacing:1px;">緊急度</span>\${num.toFixed(2)}\`;
    
    const label = num <= -0.2 ? negText : (num >= 0.2 ? posText : '中立');
    return \`<span style="font-size:10px; color:#94a3b8; font-weight:500; display:block; margin-bottom:2px; letter-spacing:1px;">\${label}</span>\${sign}\${num.toFixed(2)}\`;
  };

  const sy = document.getElementById('ic-sy');
  sy.innerHTML = formatVal(getAxisValue(art, AXIS_SEL.y), AXIS_SEL.y);
  sy.style.color = (AXIS_SEL.y === 'duration' || AXIS_SEL.y === 'coverage' || AXIS_SEL.y === 'urgency_gpt') ? '#334155' : scoreColor(getAxisValue(art, AXIS_SEL.y));

  const sz = document.getElementById('ic-sz');
  sz.innerHTML = formatVal(getAxisValue(art, AXIS_SEL.z), AXIS_SEL.z);
  sz.style.color = (AXIS_SEL.z === 'duration' || AXIS_SEL.z === 'coverage' || AXIS_SEL.z === 'urgency_gpt') ? '#334155' : scoreColor(getAxisValue(art, AXIS_SEL.z));

  document.getElementById('info-card').style.display = 'block';
}

document.getElementById('info-close').addEventListener('click', () => { document.getElementById('info-card').style.display = 'none'; });

function loadData() {
  document.getElementById('stat-total').textContent = '読込中...';
  fetch('/api/scored?topic=' + CURRENT_TOPIC)
    .then(res => res.json())
    .then(data => {
      DATA = data;
      extractAutoEvents(DATA);

      PROGRAMS = [...new Set(DATA.map(a => a.program))].sort();
      const filtersDiv = document.getElementById('filters-list');
      filtersDiv.innerHTML = '';
      
      TOPIC_TOTAL = DATA.reduce((s, a) => s + (a.duration || 0), 0);
      
      PROGRAMS.forEach((prog, i) => {
         PROG_COLORS[prog] = KNOWN_COLORS[prog] || FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
         VISIBLE[prog] = true;
         PROG_TOTAL[prog] = KNOWN_PROG_SEC[prog] ?? DATA.filter(a => a.program === prog).reduce((s, a) => s + (a.duration || 0), 0);
         
         const lbl = document.createElement('label');
         lbl.innerHTML = \`<input type="checkbox" checked><div class="dot" style="background:\${PROG_COLORS[prog]}"></div>\${prog}\`;
         const cb = lbl.querySelector('input');
         cb.addEventListener('change', () => { VISIBLE[prog] = cb.checked; render(false); });
         filtersDiv.appendChild(lbl);
      });

      document.getElementById('stat-total').textContent = DATA.length;
      render(true);
    })
    .catch(e => {
      document.getElementById('plot').innerHTML = \`<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444;flex-direction:column;gap:12px;font-family:'Roboto Mono'"><div>データ取得に失敗しました</div><div style="font-size:12px;color:#64748b">\${e.message}</div></div>\`;
    });
}

window.addEventListener('resize', () => {
  clearTimeout(window.resizeTimer);
  window.resizeTimer = setTimeout(() => { render(false); }, 200);
});

// スマホでのタッチ操作（ズーム・カメラ移動）をブラウザスクロールに奪われないよう防止
const plotWrap = document.getElementById('plot-wrap');
plotWrap.addEventListener('touchstart', (e) => { if (e.touches.length > 0) e.preventDefault(); }, { passive: false });
plotWrap.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });

window.addEventListener('load', () => {
  setTimeout(() => {
    const splash = document.getElementById('splash-screen');
    if (splash) splash.remove();
  }, 2600);
});

loadData();
  </script>
</body>
</html>`
