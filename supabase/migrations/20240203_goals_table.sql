-- Goals table — individual goal cards per user
CREATE TABLE IF NOT EXISTS goals (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name          text NOT NULL,
  target_amount bigint NOT NULL,
  target_date   date NOT NULL,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own goals" ON goals;
CREATE POLICY "Users manage own goals" ON goals
  FOR ALL USING (auth.uid() = user_id);
