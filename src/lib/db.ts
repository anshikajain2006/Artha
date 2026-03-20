/**
 * Supabase database helpers — all portfolio persistence logic lives here.
 */
import { supabase } from './supabase';
import type { PortfolioStock } from '../components/PortfolioEntry';

// ── Email preferences initialization ──────────────────────────────────────────

/**
 * Insert a default email_preferences row for a new user.
 * Uses ignoreDuplicates so it never overwrites an existing preference.
 */
export async function initEmailPreferences(userId: string, email: string): Promise<void> {
  await supabase
    .from('email_preferences')
    .upsert(
      { user_id: userId, email, weekly_digest_enabled: true },
      { onConflict: 'user_id', ignoreDuplicates: true },
    );
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export async function loadPortfolio(userId: string): Promise<PortfolioStock[] | null> {
  const { data, error } = await supabase
    .from('portfolios')
    .select('holdings')
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;

  try {
    const raw = typeof data.holdings === 'string' ? JSON.parse(data.holdings) : data.holdings;
    return Array.isArray(raw) ? (raw as PortfolioStock[]) : null;
  } catch {
    return null;
  }
}

export async function savePortfolio(
  userId:   string,
  holdings: PortfolioStock[],
): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('portfolios')
    .upsert(
      { user_id: userId, holdings, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  return error ? { error: error.message } : {};
}

export async function hasPortfolio(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', userId)
    .single();
  return Boolean(data);
}

// ── Health Score History ───────────────────────────────────────────────────────

export interface HealthScoreEntry {
  id:             string;
  user_id:        string;
  score:          number;
  breakdown:      Record<string, number>;
  trigger_action: string;
  created_at:     string;
}

export async function saveHealthScore(
  userId:        string,
  score:         number,
  breakdown:     Record<string, number>,
  triggerAction: string,
): Promise<void> {
  await supabase.from('health_scores').insert({
    user_id:        userId,
    score,
    breakdown,
    trigger_action: triggerAction,
  });
}

// ── Goal data ─────────────────────────────────────────────────────────────────

export interface GoalContextData {
  goal_amount:               number | null;
  horizon:                   string | null;
  horizon_months:            number | null;
  sip_amount:                number | null;
  risk_appetite:             string | null;
  short_term_goal_amount:    number | null;
  short_term_goal_horizon:   number | null;
  monthly_capital_to_invest: number | null;
  can_afford_to_lose_percent: number | null;
  investment_experience:     string | null;
}

export async function loadGoalData(userId: string): Promise<GoalContextData | null> {
  const { data } = await supabase
    .from('portfolios')
    .select('goal_amount, horizon, horizon_months, sip_amount, risk_appetite, short_term_goal_amount, short_term_goal_horizon, monthly_capital_to_invest, can_afford_to_lose_percent, investment_experience')
    .eq('user_id', userId)
    .single();
  return (data as GoalContextData | null) ?? null;
}

/** Save goal data to the portfolios table and user metadata. */
export async function saveGoalData(
  userId:                string,
  goalAmount:            number,
  horizon:               string,
  horizonMonths:         number,
  sipAmount:             number,
  riskAppetite?:         string,
  shortTermGoalAmount?:  number,
  shortTermGoalHorizon?: number,
  canAffordToLosePct?:   number,
  investmentExperience?: string,
): Promise<void> {
  // Persist dedicated columns in the portfolios table
  await supabase
    .from('portfolios')
    .upsert(
      {
        user_id:                     userId,
        goal_amount:                 goalAmount,
        horizon,
        horizon_months:              horizonMonths,
        sip_amount:                  sipAmount,
        monthly_capital_to_invest:   sipAmount,
        risk_appetite:               riskAppetite               ?? null,
        short_term_goal_amount:      shortTermGoalAmount        ?? null,
        short_term_goal_horizon:     shortTermGoalHorizon       ?? null,
        can_afford_to_lose_percent:  canAffordToLosePct         ?? null,
        investment_experience:       investmentExperience       ?? null,
        updated_at:                  new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  // Mirror key fields in user metadata for quick in-session access
  await supabase.auth.updateUser({
    data: { goal_amount: goalAmount, horizon, sip_amount: sipAmount },
  });
}

/** Mark onboarding as complete in user metadata. */
export async function markOnboardingComplete(): Promise<void> {
  await supabase.auth.updateUser({
    data: { onboarding_complete: true },
  });
}

export async function loadScoreHistory(userId: string): Promise<HealthScoreEntry[]> {
  const { data } = await supabase
    .from('health_scores')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(30);
  return (data as HealthScoreEntry[]) ?? [];
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export interface WatchlistRow {
  id:           string;
  user_id:      string;
  stock_name:   string;
  ticker:       string;
  target_price: number | null;
  notes:        string | null;
  ai_signal:    string | null;
  ai_reason:    string | null;
  added_at:     string;
}

export async function loadWatchlist(userId: string): Promise<WatchlistRow[]> {
  const { data } = await supabase
    .from('watchlist')
    .select('*')
    .eq('user_id', userId)
    .order('added_at', { ascending: false });
  return (data as WatchlistRow[]) ?? [];
}

export async function addWatchlistItem(
  userId:      string,
  stockName:   string,
  ticker:      string,
  targetPrice: number | null,
): Promise<WatchlistRow | null> {
  const { data, error } = await supabase
    .from('watchlist')
    .insert({ user_id: userId, stock_name: stockName, ticker, target_price: targetPrice })
    .select()
    .single();
  if (error || !data) return null;
  return data as WatchlistRow;
}

export async function removeWatchlistItem(itemId: string): Promise<void> {
  await supabase.from('watchlist').delete().eq('id', itemId);
}

export async function updateWatchlistSignal(
  itemId: string,
  signal: string,
  reason: string,
): Promise<void> {
  await supabase
    .from('watchlist')
    .update({ ai_signal: signal, ai_reason: reason })
    .eq('id', itemId);
}

// ── Daily insight ─────────────────────────────────────────────────────────────

export interface DailyInsightData {
  text:   string | null;
  date:   string | null;
  action: string | null;
}

export async function loadDailyInsight(userId: string): Promise<DailyInsightData> {
  const { data } = await supabase
    .from('portfolios')
    .select('daily_insight, daily_insight_date, daily_insight_action')
    .eq('user_id', userId)
    .single();
  const row = data as { daily_insight?: string | null; daily_insight_date?: string | null; daily_insight_action?: string | null } | null;
  return {
    text:   row?.daily_insight        ?? null,
    date:   row?.daily_insight_date   ?? null,
    action: row?.daily_insight_action ?? null,
  };
}

export async function saveDailyInsight(
  userId: string,
  text:   string,
  action: string | null,
): Promise<void> {
  await supabase
    .from('portfolios')
    .update({
      daily_insight:        text,
      daily_insight_date:   new Date().toISOString().split('T')[0],
      daily_insight_action: action,
    })
    .eq('user_id', userId);
}

// ── Goals ─────────────────────────────────────────────────────────────────────

export interface GoalRow {
  id:            string;
  user_id:       string;
  name:          string;
  target_amount: number;
  target_date:   string;
  created_at:    string;
}

export async function loadGoals(userId: string): Promise<GoalRow[]> {
  const { data } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return (data as GoalRow[]) ?? [];
}

export async function saveGoal(
  userId:       string,
  goal: { id: string; name: string; targetAmount: number; targetDate: string },
): Promise<void> {
  await supabase.from('goals').upsert(
    {
      id:            goal.id,
      user_id:       userId,
      name:          goal.name,
      target_amount: goal.targetAmount,
      target_date:   goal.targetDate,
    },
    { onConflict: 'id' },
  );
}

export async function deleteGoal(goalId: string): Promise<void> {
  await supabase.from('goals').delete().eq('id', goalId);
}

// ── Email preferences ─────────────────────────────────────────────────────────

export interface EmailPreference {
  user_id:               string;
  email:                 string;
  weekly_digest_enabled: boolean;
  last_sent_at:          string | null;
}

export async function getEmailPreference(userId: string): Promise<EmailPreference | null> {
  const { data } = await supabase
    .from('email_preferences')
    .select('*')
    .eq('user_id', userId)
    .single();
  return (data as EmailPreference | null) ?? null;
}

export async function upsertEmailPreference(
  userId:               string,
  email:                string,
  weeklyDigestEnabled:  boolean,
): Promise<void> {
  await supabase
    .from('email_preferences')
    .upsert(
      { user_id: userId, email, weekly_digest_enabled: weeklyDigestEnabled },
      { onConflict: 'user_id' },
    );
}
