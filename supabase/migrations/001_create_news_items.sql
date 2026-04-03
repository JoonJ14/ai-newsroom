-- AI Newsroom: Initial schema
-- Creates the news_items table for storing aggregated AI news

CREATE TABLE IF NOT EXISTS news_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  source_category TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  summary TEXT,
  authors TEXT,
  tags TEXT[] DEFAULT '{}',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

-- Prevent duplicate URLs within the same source
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_items_url_source
  ON news_items(url, source);

-- Fast lookups by source and category
CREATE INDEX IF NOT EXISTS idx_news_items_source
  ON news_items(source);
CREATE INDEX IF NOT EXISTS idx_news_items_source_category
  ON news_items(source_category);

-- Fast time-range queries (for get_new_since, cleanup)
CREATE INDEX IF NOT EXISTS idx_news_items_fetched_at
  ON news_items(fetched_at DESC);

-- Full-text search on title and summary
CREATE INDEX IF NOT EXISTS idx_news_items_search
  ON news_items USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '')));

-- Enable Row Level Security (public read, service-key write)
ALTER TABLE news_items ENABLE ROW LEVEL SECURITY;

-- Anyone can read
CREATE POLICY "Public read access"
  ON news_items FOR SELECT
  USING (true);

-- Only service role can insert/update/delete
CREATE POLICY "Service role write access"
  ON news_items FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
