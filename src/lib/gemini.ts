/**
 * Gemini AI client — frontend side.
 *
 * The Gemini API key lives ONLY on the server (api/analyze.ts).
 * This module is a thin fetch wrapper that calls /api/analyze.
 * No API key, no SDK import — nothing sensitive reaches the browser.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type AnalysisType = 'health' | 'scenario' | 'picks' | 'goal' | 'micro' | 'story' | 'priority' | 'macro';

export interface HoldingData {
  name:          string;
  ticker:        string;
  shares:        number;
  avgBuyPrice:   number;
  currentPrice:  number;
  invested:      number;
  currentValue:  number;
  pnl:           number;
  pnlPct:        number;
  weight:        number;
  changePercent: number | null;
}

export interface PortfolioData {
  holdings:             HoldingData[];
  totalInvested:        number;
  totalValue:           number;
  totalPnl:             number;
  totalPnlPct:          number;
  healthScore:          number;
  diversificationScore: number;
  concentrationScore:   number;
  profitabilityScore:   number;
  scenarios: {
    bull: number;
    base: number;
    bear: number;
  };
}

export interface UserContext {
  goals:                { name: string; targetAmount: number; targetDate: string; progress: number }[];
  investmentHorizon:    string;
  riskLevel:            string;
  monthlyInvestment:    number;
  riskAppetite?:        string;
  canAffordToLosePct?:  number;
  investmentExperience?: string;
  monthlyCapital?:      number;
  horizonPreference?:   'long' | 'short';
}

// ── API response shape ─────────────────────────────────────────────────────────

interface AnalyzeResponse  { text:  string }
interface AnalyzeErrorBody { error: string }

export interface MicroContext {
  changes: Array<{
    type:            'added' | 'removed' | 'increased' | 'decreased' | 'goal_set';
    stockName:       string;
    ticker:          string;
    previousShares?: number;
    newShares?:      number;
  }>;
  previousTotal: number;
  previousScore: number;
}

export interface ImportedHolding {
  name:        string;
  ticker:      string;
  shares:      number;
  avgBuyPrice: number;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Request an AI analysis from the secure backend proxy.
 * Throws on network error or non-2xx response.
 */
export async function generateAnalysis(
  type:            AnalysisType,
  portfolio:       PortfolioData,
  context:         UserContext = { goals: [], investmentHorizon: '', riskLevel: '', monthlyInvestment: 0 },
  sessionContext?: unknown,
  microContext?:   MicroContext,
): Promise<string> {
  const res = await fetch('/api/analyze', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type, portfolioData: portfolio, userContext: context, sessionContext, microContext }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as AnalyzeErrorBody;
    const msg  = body.error ?? `Server error ${res.status} — ${res.statusText}`;
    if (res.status === 429) throw Object.assign(new Error(msg), { isRateLimit: true });
    throw new Error(msg);
  }

  const data = await res.json() as AnalyzeResponse;
  return data.text;
}

/**
 * Send a portfolio screenshot to the secure backend for OCR parsing.
 * Returns the extracted holdings array.
 */
export async function importScreenshot(
  imageBase64: string,
  mimeType:    string,
): Promise<ImportedHolding[]> {
  const res = await fetch('/api/import-screenshot', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ imageBase64, mimeType }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as AnalyzeErrorBody;
    const msg  = body.error ?? `Server error ${res.status} — ${res.statusText}`;
    if (res.status === 429) throw Object.assign(new Error(msg), { isRateLimit: true });
    throw new Error(msg);
  }

  const data = await res.json() as { holdings: ImportedHolding[] };
  return data.holdings;
}
