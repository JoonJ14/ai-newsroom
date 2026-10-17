-- AI Newsroom: AI editor judgments (ranking rebuild, step 2 of 4)
--
-- One judgment per row, written once by `npm run editor` (src/editor/) and never
-- by collection: the collector upsert names its columns explicitly and none of
-- these are among them (src/utils/supabase.ts, toUpsertRow; tested in
-- src/editor/editor.test.ts).
--
-- Run by hand in the Supabase SQL Editor. Safe to re-run: every statement is
-- guarded, nothing is dropped, and no existing row is changed. The new columns
-- start NULL, which the editor reads as "not judged yet".
--
-- RLS is unchanged: the table's existing policies cover new columns, so the
-- judgments are publicly readable (the preview reads them with the anon key)
-- and only the service role can write them.

ALTER TABLE news_items
  ADD COLUMN IF NOT EXISTS editor_type TEXT,
  ADD COLUMN IF NOT EXISTS editor_importance SMALLINT,
  ADD COLUMN IF NOT EXISTS editor_audience TEXT,
  ADD COLUMN IF NOT EXISTS editor_headline TEXT,
  ADD COLUMN IF NOT EXISTS editor_why TEXT,
  ADD COLUMN IF NOT EXISTS editor_story_key TEXT,
  ADD COLUMN IF NOT EXISTS editor_followup BOOLEAN,
  ADD COLUMN IF NOT EXISTS editor_model TEXT,
  ADD COLUMN IF NOT EXISTS editor_version TEXT,
  ADD COLUMN IF NOT EXISTS editor_judged_at TIMESTAMPTZ;

-- The value sets the editor writes (src/editor/judgment.ts). NOT VALID skips
-- checking existing rows, which are all NULL anyway, so adding them takes no
-- long scan; new writes are checked. NULL passes every check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_items_editor_type_check') THEN
    ALTER TABLE news_items ADD CONSTRAINT news_items_editor_type_check CHECK (editor_type IN (
      'model_release', 'product_launch', 'policy_regulation', 'safety', 'business', 'legal',
      'research', 'tool_release', 'opinion', 'tutorial', 'patch_release', 'other'
    )) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_items_editor_importance_check') THEN
    ALTER TABLE news_items ADD CONSTRAINT news_items_editor_importance_check
      CHECK (editor_importance BETWEEN 1 AND 10) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_items_editor_audience_check') THEN
    ALTER TABLE news_items ADD CONSTRAINT news_items_editor_audience_check
      CHECK (editor_audience IN ('general', 'builder')) NOT VALID;
  END IF;
END
$$;

-- "Recent and not judged yet": the editor's work queue on every run.
CREATE INDEX IF NOT EXISTS idx_news_items_unjudged
  ON news_items (fetched_at DESC)
  WHERE editor_judged_at IS NULL;

-- Grouping copies and follow-ups of one story (step 3's digest, step 4's MCP).
CREATE INDEX IF NOT EXISTS idx_news_items_editor_story_key
  ON news_items (editor_story_key)
  WHERE editor_story_key IS NOT NULL;
