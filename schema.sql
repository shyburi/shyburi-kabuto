-- イベント（地震・事件など）
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 市民が投稿した写真
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  taken_at TEXT,
  r2_key TEXT,
  caption TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- 市民の仮説
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT,
  lat REAL,
  lng REAL,
  upvotes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- デモ用イベントデータ（能登半島地震）
INSERT OR IGNORE INTO events (id, name, description, lat, lng, occurred_at) VALUES
  ('noto-2024', '能登半島地震', '2024年1月1日に発生したM7.6の地震', 37.2, 137.0, '2024-01-01T16:10:00+09:00');
