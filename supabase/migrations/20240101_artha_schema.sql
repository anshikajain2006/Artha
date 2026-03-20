-- ============================================================
-- Artha — complete schema + RLS policies
-- Run this in Supabase SQL Editor: Dashboard > SQL Editor
-- ============================================================

-- portfolios table
CREATE TABLE IF NOT EXISTS portfolios (
  id                          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                     uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  holdings                    jsonb NOT NULL DEFAULT '[]',
  goal_amount                 bigint,
  horizon                     text,
  horizon_months              integer,
  sip_amount                  integer,
  risk_appetite               text,
  short_term_goal_amount      bigint,
  short_term_goal_horizon     integer,
  monthly_capital_to_invest   integer,
  can_afford_to_lose_percent  integer,
  investment_experience       text,
  updated_at                  timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own portfolio" ON portfolios;
CREATE POLICY "Users manage own portfolio" ON portfolios
  FOR ALL USING (auth.uid() = user_id);

-- health_scores table
CREATE TABLE IF NOT EXISTS health_scores (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  score          integer NOT NULL,
  breakdown      jsonb NOT NULL DEFAULT '{}',
  trigger_action text NOT NULL DEFAULT 'manual',
  created_at     timestamptz DEFAULT now()
);

ALTER TABLE health_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own health scores" ON health_scores;
CREATE POLICY "Users manage own health scores" ON health_scores
  FOR ALL USING (auth.uid() = user_id);

-- watchlist table
CREATE TABLE IF NOT EXISTS watchlist (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  stock_name   text NOT NULL,
  ticker       text NOT NULL,
  target_price numeric,
  notes        text,
  ai_signal    text,
  ai_reason    text,
  added_at     timestamptz DEFAULT now()
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own watchlist" ON watchlist;
CREATE POLICY "Users manage own watchlist" ON watchlist
  FOR ALL USING (auth.uid() = user_id);

-- email_preferences table
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                 text NOT NULL,
  weekly_digest_enabled boolean NOT NULL DEFAULT true,
  last_sent_at          timestamptz
);

ALTER TABLE email_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own preferences" ON email_preferences;
CREATE POLICY "Users manage own preferences" ON email_preferences
  FOR ALL USING (auth.uid() = user_id);
