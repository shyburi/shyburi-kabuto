-- トピックカラムを追加（既存データはデフォルト 'sexual_crime'）
ALTER TABLE scored_articles ADD COLUMN topic TEXT NOT NULL DEFAULT 'sexual_crime';
