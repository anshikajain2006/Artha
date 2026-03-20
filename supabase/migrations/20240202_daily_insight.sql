-- Add daily insight caching to portfolios table
ALTER TABLE portfolios
  ADD COLUMN IF NOT EXISTS daily_insight        text,
  ADD COLUMN IF NOT EXISTS daily_insight_date   date,
  ADD COLUMN IF NOT EXISTS daily_insight_action text;
