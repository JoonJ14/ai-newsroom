-- Digest state: stores key-value pairs for digest tracking (e.g. last_digest_at)
-- Replaces the .last-digest file which doesn't persist across GitHub Actions runs.

CREATE TABLE IF NOT EXISTS digest_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE digest_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only"
  ON digest_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
