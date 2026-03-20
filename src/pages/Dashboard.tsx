import { useState, useEffect, useMemo, useCallback, useRef, Component, type Dispatch, type SetStateAction } from 'react';
import type { ReactNode } from 'react';
import { marked } from 'marked';
import { useNavigate, useLocation } from 'react-router-dom';
import { getMockPrice } from '../lib/mockPrices';
import type { PortfolioStock } from '../components/PortfolioEntry';
import useAuth from '../hooks/useAuth';
import { loadPortfolio, savePortfolio, saveHealthScore, loadGoalData, addWatchlistItem, loadDailyInsight, saveDailyInsight, loadGoals, saveGoal, deleteGoal, type GoalContextData, type GoalRow } from '../lib/db';
import { SessionContextProvider, useSessionContext } from '../lib/sessionContext';
import { diffPortfolios, type PortfolioChange } from '../lib/portfolioDiff';
import { generateAnalysis, type MicroContext } from '../lib/gemini';
import MicroFeedbackToast, { parseMicroResult, type MicroResult } from '../components/MicroFeedbackToast';
import { useArtha } from '../hooks/useArtha';
import { fetchLivePrices, clearPriceCache, type LivePrice } from '../lib/prices';
import type { PortfolioData, UserContext } from '../lib/gemini';
import WatchlistTab        from '../components/WatchlistTab';
import VsNiftyCard         from '../components/VsNiftyCard';
import ScenarioSimulator   from '../components/ScenarioSimulator';
import PerformanceChart    from '../components/PerformanceChart';
import { getDisplayName }  from '../lib/utils';
import { calculateHealthScore } from '../lib/healthScore';

// ── Markdown renderer ──────────────────────────────────────────────────────────

marked.use({ breaks: true, gfm: true } as Parameters<typeof marked.use>[0]);

function renderMarkdown(text: string): string {
  return marked(text) as string;
}

// ── Design tokens ──────────────────────────────────────────────────────────────

const C = {
  bg:          '#0a0a0b',
  s1:          '#111113',
  s2:          '#18181b',
  gold:        '#d4a843',
  text:        '#f0efe8',
  muted:       '#9b9a94',
  subtle:      '#5a5955',
  border:      '#2a2a2f',
  borderHover: '#38383f',
  green:       '#4ead84',
  red:         '#e05252',
} as const;

// ── Signal helper ───────────────────────────────────────────────────────────

function getSignal(pnlPct: number, weight: number): { label: string; color: string; bg: string } {
  if (weight > 30)   return { label: 'Reduce', color: '#f97316', bg: 'rgba(249,115,22,0.12)'  };
  if (pnlPct < -12)  return { label: 'Exit',   color: C.red,     bg: 'rgba(224,82,82,0.12)'   };
  if (pnlPct > 20)   return { label: 'Trim',   color: C.gold,    bg: 'rgba(212,168,67,0.12)'  };
  if (pnlPct < 0 && weight < 8)
                     return { label: 'Add',    color: C.green,   bg: 'rgba(78,173,132,0.12)'  };
  return             { label: 'Hold',  color: C.muted,   bg: 'rgba(155,154,148,0.08)' };
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface EnrichedRow {
  id: string; name: string; ticker: string; shares: number; avgBuyPrice: number;
  currentPrice: number | null; invested: number;
  currentValue: number | null; pnl: number | null; pnlPct: number | null;
  weight: number | null;
  changePercent: number | null; // 1-day % change; null when using mock price
  priceSource: 'live' | 'unavailable' | null;
}

interface PricedRow {
  id: string; name: string; ticker: string; shares: number; avgBuyPrice: number;
  currentPrice: number; invested: number;
  currentValue: number; pnl: number; pnlPct: number; weight: number;
  changePercent: number | null; // null = mock price, not a live quote
}

interface HealthBreakdown {
  total: number;
  diversification: number; diversificationMax: number;
  concentration: number; concentrationMax: number;
  profitability: number; profitabilityMax: number;
  recommendations: [string, string, string];
}

interface ScenarioData {
  rows: { ticker: string; name: string; projected: number }[];
  total: number;
}

interface Goal { id: string; name: string; targetAmount: number; targetDate: string; }
interface GoalFormState { name: string; targetAmount: string; targetDate: string; }
type TabId = 'portfolio' | 'analyse' | 'plan';

// ── Constants ──────────────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string }[] = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'analyse',   label: 'Analyse'   },
  { id: 'plan',      label: 'Plan'      },
];

// ── AI request queue ───────────────────────────────────────────────────────────
// Prevents concurrent Gemini calls that would hit the 5 RPM free tier limit.

const aiQueue = {
  pending: false,
  async run(fn: () => Promise<void>, onBusy?: () => void): Promise<void> {
    if (this.pending) {
      onBusy?.();
      return;
    }
    this.pending = true;
    try { await fn(); }
    finally { this.pending = false; }
  },
};



// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n)}%`;
}

/** Format a rupee amount into a human-readable Cr / L / ₹ string. */
function formatAmount(n: number): string {
  if (n >= 1_00_00_000) {
    const crore = n / 1_00_00_000;
    return `₹${crore % 1 === 0 ? crore.toFixed(0) : crore.toFixed(2)} Cr`;
  }
  if (n >= 1_00_000) {
    const lakh = n / 1_00_000;
    return `₹${lakh % 1 === 0 ? lakh.toFixed(0) : lakh.toFixed(2)} L`;
  }
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function computeEnrichedRows(
  portfolio: PortfolioStock[],
  livePrices: Record<string, LivePrice | null> = {},
): { all: EnrichedRow[]; priced: PricedRow[] } {
  const withoutWeight = portfolio.map((s) => {
    const t = s.ticker.trim().toUpperCase();
    const live = livePrices[t];
    // Live price takes precedence; mock price is the fallback
    const currentPrice   = live?.price         ?? getMockPrice(s.ticker);
    const changePercent  = live?.changePercent  ?? null;

    const priceSource = live?.source ?? null;
    const invested = s.shares * s.avgBuyPrice;
    if (currentPrice === null) {
      // Use cost basis as fallback so portfolio total value is never ₹0
      const currentValue = invested;
      return { ...s, currentPrice: null, invested, currentValue, pnl: null, pnlPct: null, changePercent: null, priceSource: null };
    }
    const currentValue = s.shares * currentPrice;
    const pnl          = currentValue - invested;
    const pnlPct       = (pnl / invested) * 100;
    return { ...s, currentPrice, invested, currentValue, pnl, pnlPct, changePercent, priceSource };
  });

  const totalValue = withoutWeight.reduce((acc, r) => (r.currentValue ?? 0) + acc, 0);

  const all: EnrichedRow[] = withoutWeight.map((r) => ({
    ...r,
    weight: r.currentValue !== null && totalValue > 0 ? (r.currentValue / totalValue) * 100 : null,
  }));

  const priced: PricedRow[] = all.filter(
    (r): r is PricedRow =>
      r.currentPrice !== null && r.currentValue !== null &&
      r.pnl !== null && r.pnlPct !== null && r.weight !== null,
  );

  return { all, priced };
}

function computeHealthScore(priced: PricedRow[]): HealthBreakdown {
  const n = priced.length;

  const empty = (msg: string): HealthBreakdown => ({
    total: 0,
    diversification: 0, diversificationMax: 25,
    concentration:   0, concentrationMax:   35,
    profitability:   0, profitabilityMax:   40,
    recommendations: [msg, msg, msg],
  });

  if (n === 0) return empty('Add holdings to generate your health score.');

  const totalValue = priced.reduce((a, r) => a + r.currentValue, 0);
  if (totalValue === 0) return empty('No portfolio value detected.');

  // Deterministic scores from calculateHealthScore
  const holdingsForScore = priced.map((r) => ({
    livePrice: r.currentPrice,
    buyPrice:  r.avgBuyPrice,
    shares:    r.shares,
  }));
  const { total, diversification, concentration, profitability } = calculateHealthScore(holdingsForScore);

  // Recommendations (text only — score comes from calculateHealthScore above)
  const maxW     = Math.max(...priced.map((r) => r.weight));
  const heaviest = priced.reduce((a, b) => (a.weight > b.weight ? a : b));
  const rec0 = heaviest && maxW > 30
    ? `${heaviest.ticker} is ${fmt(heaviest.weight, 1)}% of your portfolio. Consider trimming toward a ≤20% target weight.`
    : 'Your largest position is within a healthy weight band. No urgent rebalancing needed.';

  const rec1 = n < 5
    ? `You hold ${n} position${n !== 1 ? 's' : ''}. Spreading across 6–10 uncorrelated holdings can meaningfully reduce single-stock risk.`
    : n < 10
    ? 'Diversification looks decent. One or two uncorrelated additions could further cushion downside.'
    : 'Portfolio is well-spread across positions. Turn attention to sector and geography balance.';

  const profitable = priced.filter((r) => r.pnl > 0).length;
  const profPct    = Math.round((profitable / n) * 100);
  const rec2 = profPct === 100
    ? 'All holdings are in profit — consider locking in partial gains on your biggest winners.'
    : profPct >= 66
    ? `${profitable} of ${n} holdings are profitable. Revisit loss-making positions for a thesis change.`
    : profPct >= 33
    ? 'Mixed P&L — distinguish between value opportunities and a broken thesis before averaging down.'
    : 'Most holdings are underwater. Check whether underperformance is macro-driven or company-specific.';

  return {
    total,
    diversification, diversificationMax: 25,
    concentration,   concentrationMax:   35,
    profitability,   profitabilityMax:   40,
    recommendations: [rec0, rec1, rec2],
  };
}

function computeScenarios(priced: PricedRow[]): Record<'bull' | 'base' | 'bear', ScenarioData> {
  function build(mult: number): ScenarioData {
    const rows = priced.map((r) => ({ ticker: r.ticker, name: r.name, projected: r.currentValue * mult }));
    return { rows, total: rows.reduce((a, r) => a + r.projected, 0) };
  }
  return { bull: build(1.2), base: build(1.0), bear: build(0.8) };
}

// SVG gauge
function polarToXY(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
  if (sweepDeg <= 0) return '';
  const sweep = Math.min(sweepDeg, 299.9999);
  const s = polarToXY(cx, cy, r, startDeg);
  const e = polarToXY(cx, cy, r, startDeg + sweep);
  const large = sweep > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

const GCX = 100, GCY = 90, GR = 72, G_START = 120, G_SWEEP = 300;

// ── Micro-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, pnl }: { label: string; value: string; sub?: string; pnl?: number }) {
  return (
    <div style={{ backgroundColor: C.s1 }} className="artha-card rounded-[14px] border p-5 flex flex-col gap-1">
      <span className="metric-label">{label}</span>
      <span style={{ color: C.text }} className="display-num text-2xl">{value}</span>
      {sub !== undefined && pnl !== undefined && (
        <span style={{ color: pnl >= 0 ? C.green : C.red }} className="text-sm font-medium">{sub}</span>
      )}
    </div>
  );
}

function PnlBadge({ value, pct }: { value: number; pct: number }) {
  const pos = value >= 0;
  return (
    <span
      style={{
        color:           pos ? C.green : C.red,
        backgroundColor: pos ? 'rgba(78,173,132,0.12)' : 'rgba(224,82,82,0.12)',
      }}
      className="inline-flex items-center gap-0.5 text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
    >
      {pos ? '▲' : '▼'} {pos ? '+' : '-'}₹{fmt(Math.abs(value))} ({fmtPct(pct)})
    </span>
  );
}

function SubScoreBar({ label, score, max }: { label: string; score: number; max: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between">
        <span style={{ color: C.text }} className="text-sm font-medium">{label}</span>
        <span style={{ color: C.muted }} className="text-xs">{score} / {max}</span>
      </div>
      <div style={{ backgroundColor: C.s2 }} className="h-2 rounded-full overflow-hidden">
        <div style={{ width: `${max > 0 ? (score / max) * 100 : 0}%`, backgroundColor: C.gold, transition: 'width 0.8s ease' }} className="h-full rounded-full" />
      </div>
    </div>
  );
}

function RecCard({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ backgroundColor: C.s2, borderColor: C.border }} className="border rounded-xl px-4 py-3 flex gap-3 items-start">
      <span style={{ color: C.gold }} className="mt-0.5 text-sm leading-none shrink-0">{icon}</span>
      <p style={{ color: C.muted }} className="text-sm leading-relaxed">{text}</p>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3">
      <span style={{ color: C.border }} className="text-5xl">◇</span>
      <p style={{ color: C.muted }} className="text-sm text-center max-w-xs">{msg}</p>
    </div>
  );
}

function RateLimitError({ seconds }: { seconds: number }) {
  return (
    <div style={{ background: '#1a1508', border: `1px solid ${C.gold}`, borderRadius: 14, padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⏱</span>
      <div style={{ flex: 1 }}>
        <p style={{ color: C.gold, fontSize: 13, margin: '0 0 4px', lineHeight: 1.5 }}>
          Rate limit reached. Gemini allows 5 free requests per minute.
        </p>
        <p style={{ color: C.muted, fontSize: 12, margin: 0 }}>
          {seconds > 0 ? `Retrying automatically in ${seconds}s…` : 'Retrying now…'}
        </p>
      </div>
    </div>
  );
}

// ── Price Status Bar ───────────────────────────────────────────────────────────

function PriceStatusBar({ enrichedRows, fetching, lastFetched, onRefresh }: {
  enrichedRows:  EnrichedRow[];
  fetching:      boolean;
  lastFetched:   number | null;
  onRefresh:     () => void;
}) {
  const [now, setNow] = useState(Date.now());
  // Tick every 30 s so the "X min ago" label stays accurate
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const liveCount = enrichedRows.filter((r) => r.changePercent !== null).length;
  const total     = enrichedRows.length;

  let timeLabel = '';
  if (lastFetched !== null) {
    const sec = Math.floor((now - lastFetched) / 1_000);
    timeLabel = sec < 60 ? 'just now' : `${Math.floor(sec / 60)}m ago`;
  }

  return (
    <div
      style={{ backgroundColor: C.s1, borderColor: C.border }}
      className="border rounded-xl px-4 py-2.5 flex items-center justify-between gap-4"
    >
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        {fetching ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ backgroundColor: C.gold }} />
            <span style={{ color: C.muted }} className="text-xs truncate">Fetching live prices…</span>
          </>
        ) : liveCount > 0 ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: C.green }} />
            <span style={{ color: C.text }}  className="text-xs font-medium shrink-0">Live</span>
            <span style={{ color: C.muted }} className="text-xs truncate">
              {liveCount}/{total} ticker{total !== 1 ? 's' : ''} · NSE · {timeLabel}
            </span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
            <span style={{ color: C.muted }} className="text-xs truncate">Mock prices — press Refresh for live NSE data</span>
          </>
        )}
      </div>

      <button
        onClick={onRefresh}
        disabled={fetching}
        style={{ color: fetching ? C.muted : C.gold, cursor: fetching ? 'not-allowed' : 'pointer' }}
        className="text-xs font-semibold shrink-0 hover:opacity-75 transition-opacity"
      >
        {fetching ? '…' : '↻ Refresh'}
      </button>
    </div>
  );
}

// ── Artha AI Panel ─────────────────────────────────────────────────────────────

function ArthaPanel({ label, onGenerate, loading, error, response, dataAction }: {
  label:       string;
  onGenerate:  () => void;
  loading:     boolean;
  error:       string | null;
  response:    string | null;
  dataAction?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        data-action={dataAction}
        onClick={onGenerate}
        disabled={loading}
        style={{
          borderColor:     C.gold,
          color:           loading ? C.muted : C.gold,
          backgroundColor: 'transparent',
          cursor:          loading ? 'not-allowed' : 'pointer',
          opacity:         loading ? 0.65 : 1,
        }}
        className="flex items-center justify-center gap-2 border rounded-xl px-4 py-3 text-sm font-semibold transition-all hover:bg-[#d4a843]/10 active:scale-[0.99]"
      >
        {loading ? (
          <>
            <span
              className="w-3.5 h-3.5 rounded-full border-2 animate-spin shrink-0"
              style={{ borderColor: `${C.gold} transparent ${C.gold} transparent` }}
            />
            Analysing…
          </>
        ) : (
          <>
            <span style={{ color: C.gold }} className="text-base leading-none">✦</span>
            {label}
          </>
        )}
      </button>

      {error && (() => {
        const match = error.match(/retry in ([\d.]+)s/);
        const retrySeconds = match ? Math.round(parseFloat(match[1])) : null;
        return retrySeconds !== null ? (
          <RateLimitError key="rate-limit" seconds={retrySeconds} />
        ) : (
          <div
            style={{ borderColor: 'rgba(224,82,82,0.25)', backgroundColor: 'rgba(224,82,82,0.06)' }}
            className="border rounded-[14px] px-4 py-3 flex flex-col gap-1"
          >
            <p style={{ color: C.red }} className="text-xs font-semibold">Error</p>
            <p style={{ color: C.muted }} className="text-xs leading-relaxed">{error}</p>
          </div>
        );
      })()}

      {response && (
        <div
          style={{ backgroundColor: C.s2, borderColor: `${C.gold}40` }}
          className="border rounded-xl p-4 flex flex-col gap-3"
        >
          <div className="flex items-center gap-1.5">
            <span style={{ color: C.gold }} className="text-xs leading-none">✦</span>
            <span style={{ color: C.gold }} className="text-xs font-semibold tracking-widest uppercase">Artha AI</span>
          </div>
          <div
            className="ai-output"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(response) }}
          />
        </div>
      )}
    </div>
  );
}

// ── Picks card (expandable accordion) ────────────────────────────────────────

function PickCard({ section }: { section: string }) {
  const [expanded, setExpanded] = useState(false);

  const headerMatch = section.match(/^## (.+?) — NSE:([A-Z0-9]+)/);
  if (!headerMatch) return null;

  const name   = headerMatch[1].trim();
  const ticker = headerMatch[2].trim();

  // Support both new format ('Monthly allocation') and legacy ('Suggested allocation')
  const allocMatch = section.match(/\*\*(?:Monthly|Suggested) allocation:\*\*\s*₹([^\n]+)/i);
  const fillsMatch = section.match(/\*\*This fills:\*\*\s*([^\n]+)/);

  const allocation = allocMatch ? `₹${allocMatch[1].replace(/\*\*/g, '').trim()}` : '—';
  const fills      = fillsMatch ? fillsMatch[1].replace(/\*\*/g, '').trim() : null;

  return (
    <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 18, color: C.text }}>
            {name}
          </span>
          <span style={{
            fontSize: 10, color: C.gold, background: 'rgba(212,168,67,0.12)',
            borderRadius: 4, padding: '3px 8px', fontWeight: 600, letterSpacing: '0.04em',
          }}>
            NSE:{ticker}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 10, color: C.subtle, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>
              Monthly
            </div>
            <div style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>{allocation}</div>
          </div>
          {fills && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: C.subtle, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>
                Fills gap
              </div>
              <div style={{ fontSize: 12, color: C.gold, lineHeight: 1.4 }}>{fills}</div>
            </div>
          )}
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: 'none', border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '6px 14px', fontSize: 11, color: C.muted, cursor: 'pointer',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.color = C.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted; }}
        >
          {expanded ? 'Close analysis ↑' : 'View full analysis ↓'}
        </button>
      </div>

      <div style={{ maxHeight: expanded ? '3000px' : '0', overflow: 'hidden', transition: 'max-height 0.35s ease' }}>
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '20px 24px', background: C.s2 }}>
          <div className="ai-output" dangerouslySetInnerHTML={{ __html: renderMarkdown(section) }} />
        </div>
      </div>
    </div>
  );
}

// ── Portfolio gap analysis (client-side, instant, no API) ────────────────────

interface PortfolioGap {
  title:       string;
  description: string;
  impact:      string;
  severity:    'critical' | 'moderate' | 'opportunity';
}

const GAP_SECTOR_MAP: Record<string, string> = {
  SILVERIETF: 'Commodities', SILVERBEES: 'Commodities', SILVEREIETF: 'Commodities',
  GOLDETF: 'Commodities', GOLDIETF: 'Commodities', GOLDBEES: 'Commodities',
  BHARATCOAL: 'Energy', MMTC: 'Trading', COALINDIA: 'Energy',
  CIPLA: 'Healthcare', SUNPHARMA: 'Healthcare', DRREDDY: 'Healthcare',
  APOLLOHOSP: 'Healthcare', BIOCON: 'Healthcare', AUROPHARMA: 'Healthcare',
  SUZLON: 'Energy', ADANIGREEN: 'Energy', TATAPOWER: 'Energy',
  GAIL: 'Energy', ONGC: 'Energy', RELIANCE: 'Energy', BPCL: 'Energy', IOC: 'Energy',
  IDEA: 'Telecom', BHARTIARTL: 'Telecom', VODAFONEIDEA: 'Telecom',
  PARADEEPPH: 'Chemicals', COROMANDEL: 'Chemicals', UPL: 'Chemicals', PIDILITIND: 'Chemicals',
  HDFCBANK: 'Banking', ICICIBANK: 'Banking', KOTAKBANK: 'Banking', AXISBANK: 'Banking',
  SBIN: 'Banking', AUBANK: 'Banking', INDUSINDBK: 'Banking', BANDHANBNK: 'Banking',
  INFY: 'IT', TCS: 'IT', WIPRO: 'IT', HCLTECH: 'IT', TECHM: 'IT', LTIM: 'IT', MPHASIS: 'IT',
  HINDUNILVR: 'FMCG', ITC: 'FMCG', NESTLEIND: 'FMCG', BRITANNIA: 'FMCG', DABUR: 'FMCG', MARICO: 'FMCG',
  MARUTI: 'Auto', TATAMOTORS: 'Auto', HEROMOTOCO: 'Auto', EICHERMOT: 'Auto',
  DLF: 'Real Estate', PRESTIGE: 'Real Estate', BRIGADE: 'Real Estate',
  LT: 'Infrastructure', ADANIPORTS: 'Infrastructure', NTPC: 'Infrastructure', POWERGRID: 'Infrastructure',
  NIFTYBEES: 'Index Fund', SETFNIF50: 'Index Fund', JUNIORBEES: 'Index Fund', MAFSETF50: 'Index Fund',
};

const LARGE_CAP_SET = new Set([
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'SBIN', 'BAJFINANCE',
  'KOTAKBANK', 'BHARTIARTL', 'LT', 'AXISBANK', 'NESTLEIND', 'MARUTI', 'SUNPHARMA',
  'WIPRO', 'TECHM', 'HCLTECH', 'TITAN', 'NTPC', 'ONGC', 'POWERGRID', 'TATAMOTORS',
  'DRREDDY', 'CIPLA', 'GAIL', 'COALINDIA', 'BRITANNIA', 'EICHERMOT', 'HEROMOTOCO', 'ITC',
  'BPCL', 'ADANIPORTS', 'DABUR', 'APOLLOHOSP',
]);

function computePortfolioGaps(rows: PricedRow[]): PortfolioGap[] {
  if (rows.length === 0) return [];
  const gaps: PortfolioGap[] = [];
  const sectorWeight = new Map<string, number>();
  let largecapWeight = 0;

  for (const row of rows) {
    const key    = row.ticker.toUpperCase().replace(/-/g, '_').replace(/\./g, '');
    const sector = GAP_SECTOR_MAP[key] ?? 'Other';
    sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + row.weight);
    if (LARGE_CAP_SET.has(key)) largecapWeight += row.weight;
  }

  const KEY_CHECKS: { sector: string; severity: PortfolioGap['severity']; description: string; impact: string }[] = [
    {
      sector:      'Banking',
      severity:    'critical',
      description: "Banking is 28% of Nifty 50. Zero banking exposure means you're structurally underweight India's largest sector and its biggest credit-growth driver.",
      impact:      "This gap alone could reduce your long-term returns by 2–3% annually vs a Nifty-balanced portfolio.",
    },
    {
      sector:      'IT',
      severity:    'critical',
      description: "Indian IT earns in USD and pays in INR — a natural rupee hedge. It's 15% of Nifty 50 and historically one of the strongest wealth creators for Indian retail investors.",
      impact:      "Missing IT leaves you exposed when global risk-on sentiment drives large FII flows into India's tech sector.",
    },
    {
      sector:      'FMCG',
      severity:    'moderate',
      description: "FMCG is the defensive anchor of Indian portfolios — demand for everyday goods doesn't fall in a recession. It cushions market crashes.",
      impact:      "Without FMCG, a 20% market correction would hit your portfolio harder than a balanced portfolio.",
    },
    {
      sector:      'Infrastructure',
      severity:    'opportunity',
      description: "India's infrastructure push is a decade-long tailwind backed by government capex cycles. This sector outperforms during economic expansion.",
      impact:      "Adding infra exposure aligns you with India's single most visible long-term growth story.",
    },
    {
      sector:      'Index Fund',
      severity:    'moderate',
      description: "A Nifty 50 index fund is the lowest-cost way to participate in India's broad market. Without one, you're relying 100% on individual stock picking.",
      impact:      "Even 20% in a Nifty index fund would dramatically reduce your single-stock risk and lower portfolio volatility.",
    },
  ];

  for (const check of KEY_CHECKS) {
    if ((sectorWeight.get(check.sector) ?? 0) < 2) {
      gaps.push({ title: `Missing: ${check.sector} exposure`, description: check.description, impact: check.impact, severity: check.severity });
    }
  }

  // Concentration gap (prepend — highest priority)
  if (rows.length > 0) {
    const heaviest = rows.reduce((a, b) => a.weight > b.weight ? a : b);
    const totalVal = rows.reduce((a, r) => a + r.currentValue, 0);
    if (heaviest.weight > 40) {
      gaps.unshift({
        title:       `Critical: ${heaviest.ticker} is ${fmt(heaviest.weight, 0)}% of your portfolio`,
        description: `Over 40% in one stock means one bad quarter destroys months of gains. Your entire portfolio rises and falls with ${heaviest.name}.`,
        impact:      `If ${heaviest.ticker} drops 20%, your portfolio loses ${fmt(heaviest.weight * 0.2, 1)}% — roughly ₹${fmt(totalVal * heaviest.weight * 0.002)} from this one position alone.`,
        severity:    'critical',
      });
    } else if (heaviest.weight > 25) {
      gaps.unshift({
        title:       `${heaviest.ticker} overweight at ${fmt(heaviest.weight, 0)}%`,
        description: `${heaviest.name} makes up ${fmt(heaviest.weight, 0)}% of your portfolio — above the 25% healthy ceiling for a single position.`,
        impact:      "Trimming to 20% and redeploying into a missing sector reduces single-stock risk immediately.",
        severity:    'moderate',
      });
    }
  }

  // Large-cap gap
  if (largecapWeight < 25 && rows.length >= 3) {
    gaps.push({
      title:       'Low large-cap exposure',
      description: 'Your portfolio skews toward smaller, more volatile companies. Large-caps provide stability and anchor returns during market turbulence.',
      impact:      'Adding one or two large-cap anchors reduces your drawdown in a market crash by an estimated 10–15%.',
      severity:    'opportunity',
    });
  }

  return gaps.slice(0, 4);
}

// ── Gap card ──────────────────────────────────────────────────────────────────

function GapCard({ gap }: { gap: PortfolioGap }) {
  const borderColor = gap.severity === 'critical' ? C.red : gap.severity === 'moderate' ? C.gold : '#4a9eff';
  const labelText   = gap.severity === 'critical' ? 'Critical' : gap.severity === 'moderate' ? 'Moderate' : 'Opportunity';

  return (
    <div style={{ background: C.s1, borderLeft: `3px solid ${borderColor}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: borderColor, background: `${borderColor}18`, borderRadius: 99, padding: '2px 8px',
        }}>
          {labelText}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{gap.title}</span>
      </div>
      <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, margin: '0 0 6px' }}>{gap.description}</p>
      <p style={{ fontSize: 12, color: C.gold, lineHeight: 1.5, margin: 0 }}>↳ {gap.impact}</p>
    </div>
  );
}

// ── Picks panel (generate button + expandable cards) ──────────────────────────

const US_STOCK_KEYWORDS = [
  'NYSE:', 'NASDAQ:', 'Visa Inc', 'Apple Inc',
  'Amazon', 'Google', 'Tesla', 'Meta Platforms',
  'Microsoft', 'S&P 500',
];

// ── Portfolio data converter ───────────────────────────────────────────────────

function toPortfolioData(
  rows:  PricedRow[],
  hs:    HealthBreakdown,
  sc:    Record<'bull' | 'base' | 'bear', ScenarioData>,
): PortfolioData {
  const totalInvested = rows.reduce((a, r) => a + r.invested, 0);
  const totalValue    = rows.reduce((a, r) => a + r.currentValue, 0);
  const totalPnl      = totalValue - totalInvested;
  const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  return {
    holdings: rows.map((r) => ({
      name:          r.name,
      ticker:        r.ticker,
      shares:        r.shares,
      avgBuyPrice:   r.avgBuyPrice,
      currentPrice:  r.currentPrice,
      invested:      r.invested,
      currentValue:  r.currentValue,
      pnl:           r.pnl,
      pnlPct:        r.pnlPct,
      weight:        r.weight,
      changePercent: r.changePercent,
    })),
    totalInvested,
    totalValue,
    totalPnl,
    totalPnlPct,
    healthScore:          hs.total,
    diversificationScore: hs.diversification,
    concentrationScore:   hs.concentration,
    profitabilityScore:   hs.profitability,
    scenarios: {
      bull: sc.bull.total,
      base: sc.base.total,
      bear: sc.bear.total,
    },
  };
}

// ── Count-up hook ──────────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 1500): number {
  const [value, setValue] = useState(0);
  const rafRef            = useRef<number>(0);

  useEffect(() => {
    // Always animate from 0 — no prevTarget guard that breaks React StrictMode
    const start = performance.now();
    cancelAnimationFrame(rafRef.current);
    function step(now: number) {
      const elapsed  = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3); // cubic ease-out
      setValue(Math.round(eased * target));
      if (progress < 1) rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return value;
}

// ── SVG Gauge ──────────────────────────────────────────────────────────────────

function Gauge({ score }: { score: number }) {
  const counted = useCountUp(score, 1500);
  const track   = arcPath(GCX, GCY, GR, G_START, G_SWEEP);
  const fill    = arcPath(GCX, GCY, GR, G_START, (counted / 100) * G_SWEEP);
  const col     = score >= 70 ? C.green : score >= 40 ? C.gold : C.red;
  const insight = score >= 70 ? 'Well diversified · low risk'
    : score >= 40 ? 'Moderate risk · room to grow'
    : 'High concentration · needs attention';
  const [insightVisible, setInsightVisible] = useState(false);

  useEffect(() => {
    // Fade in insight text 300ms after count completes
    const t = setTimeout(() => setInsightVisible(true), 1500 + 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <style>{`
        @keyframes gaugePulseGreen { 0%,100%{filter:none} 40%{filter:drop-shadow(0 0 12px ${C.green}88)} }
        @keyframes gaugePulseRed   { 0%,100%{filter:none} 40%{filter:drop-shadow(0 0 12px ${C.red}88)} }
        .gauge-pulse-green { animation: gaugePulseGreen 1.2s ease; }
        .gauge-pulse-red   { animation: gaugePulseRed   1.2s ease; }
      `}</style>
      <svg viewBox="0 0 200 155" width="200" height="155" className="mx-auto">
        <path d={track} fill="none" stroke={C.s2}  strokeWidth="14" strokeLinecap="round" />
        {counted > 0 && (
          <path d={fill} fill="none" stroke={col} strokeWidth="14" strokeLinecap="round" />
        )}
        <text x="100" y="95" textAnchor="middle" dominantBaseline="middle"
          fontSize="42" fontWeight="700" fill={col} fontFamily='"Fraunces", serif'>
          {counted}
        </text>
        <text x="100" y="118" textAnchor="middle" fontSize="11" fill={C.muted} fontFamily='"DM Sans", sans-serif'>
          out of 100
        </text>
      </svg>
      <p style={{
        fontSize:   11,
        color:      C.subtle,
        fontStyle:  'italic',
        textAlign:  'center',
        opacity:    insightVisible ? 1 : 0,
        transition: 'opacity 0.4s ease',
      }}>
        {insight}
      </p>
    </div>
  );
}

// ── Navigation ─────────────────────────────────────────────────────────────────

function HealthBadge({ score }: { score: number }) {
  const col = score >= 70 ? C.green : score >= 40 ? C.gold : C.red;
  return (
    <div style={{ borderColor: col, color: col }} className="flex flex-col items-center justify-center w-11 h-11 rounded-full border-2 shrink-0">
      <span className="text-xs font-bold leading-none">{score}</span>
      <span className="text-[9px] leading-none opacity-60">score</span>
    </div>
  );
}

// ── Toast notification ────────────────────────────────────────────────────────

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4500);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div style={{
      position:     'fixed',
      bottom:       24,
      right:        24,
      zIndex:       9999,
      background:   C.s1,
      border:       `1px solid ${C.green}`,
      borderRadius: 10,
      padding:      '12px 18px',
      color:        C.text,
      fontSize:     13,
      display:      'flex',
      alignItems:   'center',
      gap:          10,
      boxShadow:    '0 4px 28px rgba(0,0,0,0.5)',
      maxWidth:     320,
      animation:    'slideUp 0.25s ease',
    }}>
      <span style={{ color: C.green, fontSize: 16 }}>✓</span>
      {message}
      <button
        onClick={onDismiss}
        style={{ marginLeft: 8, background: 'none', border: 'none', color: C.subtle, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
      >
        ×
      </button>
      <style>{`@keyframes slideUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 24 }}>
      <style>{`@keyframes shimmer { 0%{opacity:.45} 50%{opacity:.9} 100%{opacity:.45} }`}</style>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {[1,2,3,4].map((i) => (
          <div key={i} style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, height: 88, animation: `shimmer 1.6s ease infinite` }} />
        ))}
      </div>
      {/* Table placeholder */}
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, height: 280, animation: `shimmer 1.6s ease infinite` }} />
      {/* Chart placeholder */}
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, height: 140, animation: `shimmer 1.6s ease infinite` }} />
    </div>
  );
}

// ── User avatar + dropdown menu ───────────────────────────────────────────────

function UserMenu({ email, onEditPortfolio, onSettings, onSignOut }: {
  email:           string;
  onEditPortfolio: () => void;
  onSettings:      () => void;
  onSignOut:       () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const initial = email.charAt(0).toUpperCase();

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width:        32,
          height:       32,
          borderRadius: '50%',
          background:   `${C.gold}22`,
          border:       `1px solid ${C.gold}60`,
          color:        C.gold,
          fontSize:     13,
          fontWeight:   600,
          cursor:       'pointer',
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'center',
          flexShrink:   0,
          fontFamily:  '"DM Sans", system-ui, sans-serif',
        }}
        title={email}
      >
        {initial}
      </button>

      {open && (
        <div style={{
          position:   'absolute',
          top:        40,
          right:      0,
          background: C.s1,
          border:     `1px solid ${C.border}`,
          borderRadius: 10,
          overflow:   'hidden',
          zIndex:     200,
          minWidth:   172,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
            <p style={{ fontSize: 11, color: C.subtle, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email}
            </p>
          </div>
          {[
            { label: '← Edit portfolio', action: onEditPortfolio },
            { label: 'Settings',         action: onSettings },
            { label: 'Sign out',         action: onSignOut,       danger: true },
          ].map(({ label, action, danger }) => (
            <button
              key={label}
              onClick={() => { setOpen(false); action(); }}
              style={{
                display:    'block',
                width:      '100%',
                textAlign:  'left',
                background: 'none',
                border:     'none',
                padding:    '10px 14px',
                fontSize:   13,
                color:      danger ? C.red : C.text,
                cursor:     'pointer',
                fontFamily: '"DM Sans", system-ui, sans-serif',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.s2)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StickyNav({ activeTab, onTabChange, healthScore, onEditPortfolio, onSettings, user, onSignOut }: {
  activeTab:       TabId;
  onTabChange:     (t: TabId) => void;
  healthScore:     number;
  onEditPortfolio: () => void;
  onSettings:      () => void;
  user:            import('@supabase/supabase-js').User | null;
  onSignOut:       () => void;
}) {
  return (
    <header style={{ backgroundColor: `${C.bg}ee`, borderBottomColor: C.border }} className="sticky top-0 z-50 border-b backdrop-blur-md">
      <div className="w-full max-w-[1100px] mx-auto px-4">
        {/* Logo row */}
        <div className="flex items-center justify-between h-14">
          <span style={{ fontFamily: '"Fraunces", serif', color: C.text, fontWeight: 300, letterSpacing: '-0.5px' }} className="text-xl select-none">
            Arth<em style={{ color: C.gold, fontStyle: 'italic' }}>a</em>
          </span>
          <div className="flex items-center gap-3">
            <HealthBadge score={healthScore} />
            {user ? (
              <UserMenu
                email={user.email ?? '?'}
                onEditPortfolio={onEditPortfolio}
                onSettings={onSettings}
                onSignOut={onSignOut}
              />
            ) : (
              <button onClick={onEditPortfolio} style={{ color: C.muted }} className="text-xs hover:text-white transition-colors hidden sm:block">
                ← Edit portfolio
              </button>
            )}
          </div>
        </div>
        {/* Tab bar */}
        <div className="flex overflow-x-auto gap-1.5 pb-2.5 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          {TABS.map((t) => {
            const active = t.id === activeTab;
            return (
              <button
                key={t.id}
                data-tab={t.id}
                onClick={() => onTabChange(t.id)}
                style={{
                  backgroundColor: active ? '#222226' : C.s2,
                  color:           active ? C.text    : C.muted,
                  borderColor:     C.border,
                }}
                className="px-4 py-1.5 text-xs font-medium rounded-full whitespace-nowrap shrink-0 border transition-colors hover:text-white"
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}

// ── Surface wrapper ─────────────────────────────────────────────────────────────

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div style={{ backgroundColor: C.s1 }} className={`artha-card rounded-[14px] border ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottomColor: C.border }} className="px-5 py-4 border-b">
      <h2 style={{ color: C.text, fontFamily: '"Fraunces", serif' }} className="text-base font-semibold">{title}</h2>
    </div>
  );
}

// ── Proactive Alert Banner ────────────────────────────────────────────────────

function ProactiveAlert({ pricedRows, onHealthTab: _onHealthTab }: {
  pricedRows:  PricedRow[];
  onHealthTab: () => void;
}) {
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('artha_alert_dismissed') === '1',
  );

  const top = [...pricedRows]
    .filter((r) => r.changePercent !== null && Math.abs(r.changePercent) >= 3)
    .sort((a, b) => Math.abs(b.changePercent!) - Math.abs(a.changePercent!))[0];

  if (!top || dismissed) return null;

  const isUp  = top.changePercent! > 0;
  const col   = isUp ? C.green : C.red;
  const arrow = isUp ? '▲' : '▼';

  function dismiss() {
    sessionStorage.setItem('artha_alert_dismissed', '1');
    setDismissed(true);
  }

  return (
    <div style={{
      background:   `${col}0d`,
      borderBottom: `1px solid ${col}30`,
      padding:      '10px 20px',
      display:      'flex',
      alignItems:   'center',
      gap:          10,
      fontSize:     13,
    }}>
      <span style={{ color: col, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{arrow}</span>
      <span style={{ color: C.text, flex: 1 }}>
        <strong>{getDisplayName(top.ticker, top.name)}</strong> is {isUp ? 'up' : 'down'}{' '}
        <span style={{ color: col }}>{Math.abs(top.changePercent!).toFixed(1)}%</span> today.{' '}
        <span style={{ color: C.muted }}>
          {isUp ? 'Could be a good time to review your position.' : 'You may want to check your risk exposure.'}
        </span>
      </span>
      <button
        onClick={() => {
          document.querySelector<HTMLButtonElement>('[data-tab="analyse"]')?.click();
          setTimeout(() => {
            document.querySelector<HTMLButtonElement>('[data-action="analyse-health"]')?.click();
          }, 400);
        }}
        style={{ background: 'none', border: 'none', color: col, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', padding: '4px 0', flexShrink: 0 }}
      >
        Tell me more →
      </button>
      <button
        onClick={dismiss}
        style={{ background: 'none', border: 'none', color: C.subtle, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  );
}

// ── Daily Insight ─────────────────────────────────────────────────────────────

function DailyInsight({ text, action, loading }: {
  text:    string | null;
  action:  string | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div style={{
        background:   C.s1,
        border:       `1px solid ${C.border}`,
        borderRadius: 14,
        padding:      '20px 22px',
        height:       80,
        animation:    'shimmer 1.6s ease infinite',
      }} />
    );
  }

  if (!text) return null;

  return (
    <div style={{
      background:    C.s1,
      border:        `1px solid ${C.border}`,
      borderRadius:  14,
      padding:       '18px 22px',
      display:       'flex',
      flexDirection: 'column',
      gap:           14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ color: C.gold, fontSize: 14, flexShrink: 0, marginTop: 2 }}>✦</span>
        <p style={{ color: C.text, fontSize: 14, lineHeight: 1.75, fontStyle: 'italic', margin: 0 }}>
          {text}
        </p>
      </div>
      {action && (
        <div style={{
          background:   C.gold,
          borderRadius: 10,
          padding:      '13px 18px',
        }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#0a0a0b', lineHeight: 1.5 }}>
            Your action today: {action}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Section divider ────────────────────────────────────────────────────────────

function SectionDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
      <span style={{
        fontFamily:     '"Fraunces", serif',
        fontWeight:     300,
        fontSize:       15,
        color:          C.muted,
        whiteSpace:     'nowrap',
        letterSpacing:  '-0.2px',
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

// ── Share Card ────────────────────────────────────────────────────────────────

function ShareModal({ pricedRows, healthScore, onClose }: {
  pricedRows:  PricedRow[];
  healthScore: number;
  onClose:     () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied,  setCopied] = useState(false);

  const totalInvested = pricedRows.reduce((a, r) => a + r.invested, 0);
  const totalValue    = pricedRows.reduce((a, r) => a + r.currentValue, 0);
  const totalPnlPct   = totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0;
  const pnlSign       = totalPnlPct >= 0 ? '+' : '';
  const niftyBench    = 12;
  const beatNifty     = totalPnlPct >= niftyBench;

  // Draw canvas on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 1200, H = 630;
    canvas.width  = W;
    canvas.height = H;

    // Background
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, W, H);

    // Subtle grid lines
    ctx.strokeStyle = '#18181b';
    ctx.lineWidth   = 1;
    for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Top bar accent
    const accent = ctx.createLinearGradient(0, 0, W, 0);
    accent.addColorStop(0, '#d4a843');
    accent.addColorStop(1, '#4ead84');
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 4);

    // Branding — "Artha"
    ctx.fillStyle  = '#d4a843';
    ctx.font       = 'italic 300 28px Georgia, serif';
    ctx.textAlign  = 'left';
    ctx.fillText('Artha', 80, 72);

    // Tagline
    ctx.fillStyle = '#5a5955';
    ctx.font      = '400 16px "Arial", sans-serif';
    ctx.fillText('AI-powered portfolio analytics', 80, 98);

    // Portfolio return — main number
    const mainCol = totalPnlPct >= 0 ? '#4ead84' : '#e05252';
    ctx.fillStyle = mainCol;
    ctx.font      = 'bold 120px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${pnlSign}${totalPnlPct.toFixed(1)}%`, W / 2, 340);

    // Label above
    ctx.fillStyle = '#9b9a94';
    ctx.font      = '400 20px "Arial", sans-serif';
    ctx.fillText('MY PORTFOLIO RETURN', W / 2, 220);

    // vs Nifty comparison
    ctx.fillStyle = '#5a5955';
    ctx.font      = '400 18px "Arial", sans-serif';
    ctx.fillText(`vs Nifty avg ${niftyBench}% annual benchmark`, W / 2, 410);

    // Verdict badge
    const verdictText = beatNifty ? '✦ Beating the market' : '✦ Below market average';
    const verdictCol  = beatNifty ? '#4ead84' : '#d4a843';
    ctx.fillStyle     = verdictCol;
    ctx.font          = '600 22px "Arial", sans-serif';
    ctx.fillText(verdictText, W / 2, 468);

    // Bottom strip
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, H - 90, W, 90);

    // Health score
    const hsCol = healthScore >= 70 ? '#4ead84' : healthScore >= 40 ? '#d4a843' : '#e05252';
    ctx.fillStyle = hsCol;
    ctx.font      = 'bold 32px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${healthScore}`, 80, H - 40);
    ctx.fillStyle = '#5a5955';
    ctx.font      = '400 14px "Arial", sans-serif';
    ctx.fillText('/100 health score', 80 + 40, H - 40);

    // Holdings count
    ctx.fillStyle = '#9b9a94';
    ctx.font      = '400 14px "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${pricedRows.length} holdings tracked`, W / 2, H - 40);

    // Portfolio value
    const valStr = totalValue >= 10_000_000
      ? `₹${(totalValue / 10_000_000).toFixed(2)} Cr`
      : totalValue >= 100_000
        ? `₹${(totalValue / 100_000).toFixed(2)} L`
        : `₹${totalValue.toLocaleString('en-IN')}`;
    ctx.fillStyle = '#f0efe8';
    ctx.font      = '600 18px "Arial", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(valStr, W - 80, H - 50);
    ctx.fillStyle = '#5a5955';
    ctx.font      = '400 12px "Arial", sans-serif';
    ctx.fillText('portfolio value', W - 80, H - 30);
  }, [pricedRows, healthScore, totalPnlPct, beatNifty, pnlSign]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link    = document.createElement('a');
    link.download = 'artha-portfolio.png';
    link.href     = canvas.toDataURL('image/png');
    link.click();
  }

  function copyCaption() {
    const caption = `My portfolio is ${pnlSign}${totalPnlPct.toFixed(1)}% vs Nifty's ${niftyBench}% annual average — tracked with Artha 📊 Health score: ${healthScore}/100`;
    void navigator.clipboard.writeText(caption).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: C.s1, borderRadius: 20, border: `1px solid ${C.border}`, overflow: 'hidden', maxWidth: 640, width: '100%', boxShadow: '0 24px 80px rgba(0,0,0,0.7)' }}>
        {/* Preview */}
        <div style={{ position: 'relative', paddingBottom: '52.5%', background: C.bg, overflow: 'hidden' }}>
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
          />
        </div>

        {/* Actions */}
        <div style={{ padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 12, borderTop: `1px solid ${C.border}` }}>
          <p style={{ color: C.muted, fontSize: 12, flex: 1, lineHeight: 1.5 }}>
            Share your portfolio performance with the world.
          </p>
          <button
            onClick={copyCaption}
            style={{
              background: 'none', border: `1px solid ${C.border}`, color: copied ? C.green : C.text,
              borderRadius: 10, padding: '9px 16px', fontSize: 13, cursor: 'pointer',
            }}
          >
            {copied ? '✓ Copied' : 'Copy caption'}
          </button>
          <button
            onClick={download}
            style={{
              background: C.gold, border: 'none', color: '#0a0a0b',
              borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Download PNG
          </button>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: C.subtle, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px' }}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

// ── One Thing Bar ─────────────────────────────────────────────────────────────

function OneThingBar({ portfolioData, userContext }: {
  portfolioData: PortfolioData;
  userContext:   UserContext;
}) {
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('artha_onethinbar_dismissed') === '1',
  );
  const [priority, setPriority] = useState<string | null>(
    () => localStorage.getItem('artha_top_priority'),
  );
  const [loading, setLoading] = useState(false);
  const fetchedRef            = useRef(false);

  useEffect(() => {
    if (priority || fetchedRef.current || portfolioData.holdings.length === 0 || userContext.goals.length === 0) return;
    fetchedRef.current = true;
    setLoading(true);
    generateAnalysis('priority', portfolioData, userContext)
      .then((text) => {
        setPriority(text.trim());
        localStorage.setItem('artha_top_priority', text.trim());
      })
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (dismissed) return null;
  if (!priority && !loading) return null;

  function dismiss() {
    sessionStorage.setItem('artha_onethinbar_dismissed', '1');
    setDismissed(true);
  }

  return (
    <div style={{
      position:      'fixed',
      bottom:        0,
      left:          0,
      right:         0,
      zIndex:        50,
      height:        48,
      background:    C.s1,
      borderTop:     `1px solid ${C.border}`,
      display:       'flex',
      alignItems:    'center',
      padding:       '0 20px',
      gap:           10,
      boxShadow:     '0 -4px 20px rgba(0,0,0,0.4)',
    }}>
      <span style={{ color: C.gold, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
        This week →
      </span>
      <p style={{ color: C.text, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
        {loading ? <span style={{ color: C.subtle, fontStyle: 'italic' }}>Thinking…</span> : priority}
      </p>
      <button
        onClick={dismiss}
        style={{ background: 'none', border: 'none', color: C.subtle, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  );
}

// ── Edit Portfolio Drawer ─────────────────────────────────────────────────────

function EditPortfolioDrawer({
  open,
  portfolio,
  onSave,
  onClose,
}: {
  open:      boolean;
  portfolio: PortfolioStock[];
  onSave:    (holdings: PortfolioStock[]) => void;
  onClose:   () => void;
}) {
  const [holdings, setHoldings] = useState<(PortfolioStock & { _shares: string; _price: string })[]>([]);
  const [newForm,  setNewForm]  = useState({ name: '', ticker: '', shares: '', price: '' });

  useEffect(() => {
    if (open) {
      setHoldings(portfolio.map((h) => ({ ...h, _shares: String(h.shares), _price: String(h.avgBuyPrice) })));
      setNewForm({ name: '', ticker: '', shares: '', price: '' });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave() {
    const valid = holdings
      .map((h) => ({
        id:          h.id,
        name:        h.name,
        ticker:      h.ticker,
        shares:      parseFloat(h._shares) || h.shares,
        avgBuyPrice: parseFloat(h._price)  || h.avgBuyPrice,
        buyDate:     h.buyDate,
      }))
      .filter((h) => h.shares > 0);
    onSave(valid);
    onClose();
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const shares = parseFloat(newForm.shares);
    const price  = parseFloat(newForm.price);
    if (!newForm.name.trim() || !newForm.ticker.trim() || !shares || !price) return;
    setHoldings((prev) => [...prev, {
      id:          `new-${Date.now()}`,
      name:        newForm.name.trim(),
      ticker:      newForm.ticker.trim().toUpperCase(),
      shares,
      avgBuyPrice: price,
      _shares:     newForm.shares,
      _price:      newForm.price,
    }]);
    setNewForm({ name: '', ticker: '', shares: '', price: '' });
  }

  const inp: React.CSSProperties = {
    background:  C.s1,
    border:      `1px solid ${C.border}`,
    borderRadius: 6,
    color:       C.text,
    fontSize:    12,
    padding:     '5px 10px',
    width:       '100%',
    fontFamily:  '"DM Sans", system-ui, sans-serif',
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 100 }} />

      {/* Panel */}
      <div style={{
        position:      'fixed',
        top:           0,
        right:         0,
        height:        '100vh',
        width:         440,
        maxWidth:      '100vw',
        background:    C.s1,
        borderLeft:    `1px solid ${C.border}`,
        zIndex:        101,
        display:       'flex',
        flexDirection: 'column',
        overflow:      'hidden',
        boxShadow:     '-8px 0 32px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 18, color: C.text, margin: 0 }}>
            Edit Portfolio
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 0 }}>×</button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {holdings.length === 0 && (
            <p style={{ color: C.subtle, fontSize: 12, textAlign: 'center', padding: '24px 0' }}>No holdings yet. Add one below.</p>
          )}
          {holdings.map((h, i) => (
            <div key={h.id} style={{ background: C.s2, borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{h.name}</span>
                  <span style={{ fontSize: 10, color: C.gold, background: `${C.gold}18`, borderRadius: 4, padding: '2px 6px' }}>{h.ticker}</span>
                </div>
                <button
                  onClick={() => setHoldings((prev) => prev.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}
                  title="Remove"
                >×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={{ fontSize: 10, color: C.subtle, display: 'block', marginBottom: 3 }}>Shares</label>
                  <input
                    value={h._shares}
                    onChange={(e) => setHoldings((prev) => prev.map((r, j) => j === i ? { ...r, _shares: e.target.value } : r))}
                    type="number"
                    style={inp}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: C.subtle, display: 'block', marginBottom: 3 }}>Avg buy ₹</label>
                  <input
                    value={h._price}
                    onChange={(e) => setHoldings((prev) => prev.map((r, j) => j === i ? { ...r, _price: e.target.value } : r))}
                    type="number"
                    style={inp}
                  />
                </div>
              </div>
            </div>
          ))}

          {/* Add new holding */}
          <form onSubmit={handleAdd} style={{ background: C.s2, borderRadius: 10, padding: '14px', marginTop: 4 }}>
            <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 10px' }}>
              Add holding
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              {[
                { key: 'name',   label: 'Stock name',   placeholder: 'e.g. Infosys', type: 'text'   },
                { key: 'ticker', label: 'Ticker',        placeholder: 'e.g. INFY',    type: 'text'   },
                { key: 'shares', label: 'Shares',        placeholder: '10',           type: 'number' },
                { key: 'price',  label: 'Avg buy ₹',    placeholder: '1500',         type: 'number' },
              ].map(({ key, label, placeholder, type }) => (
                <div key={key}>
                  <label style={{ fontSize: 10, color: C.subtle, display: 'block', marginBottom: 3 }}>{label}</label>
                  <input
                    value={newForm[key as keyof typeof newForm]}
                    onChange={(e) => setNewForm((p) => ({ ...p, [key]: e.target.value }))}
                    placeholder={placeholder}
                    type={type}
                    style={inp}
                  />
                </div>
              ))}
            </div>
            <button
              type="submit"
              style={{ background: C.gold, border: 'none', borderRadius: 8, color: '#0a0a0b', fontSize: 12, fontWeight: 600, padding: '8px 18px', cursor: 'pointer', fontFamily: '"DM Sans", sans-serif' }}
            >
              + Add
            </button>
          </form>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.muted, fontSize: 13, padding: '9px 20px', cursor: 'pointer', fontFamily: '"DM Sans", sans-serif' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{ background: C.gold, border: 'none', borderRadius: 10, color: '#0a0a0b', fontSize: 13, fontWeight: 600, padding: '9px 22px', cursor: 'pointer', fontFamily: '"DM Sans", sans-serif' }}
          >
            Save changes
          </button>
        </div>
      </div>
    </>
  );
}

// ── Tab: Portfolio (was Overview) ─────────────────────────────────────────────

function PortfolioTab({
  enrichedRows, pricedRows, pricesFetching, pricesLastFetched, onRefreshPrices,
  portfolio, portfolioData, userContext, healthScore,
  dailyInsight, dailyAction, insightLoading, onEditPortfolio,
}: {
  enrichedRows:      EnrichedRow[];
  pricedRows:        PricedRow[];
  pricesFetching:    boolean;
  pricesLastFetched: number | null;
  onRefreshPrices:   () => void;
  portfolio:         PortfolioStock[];
  portfolioData:     PortfolioData;
  userContext:       UserContext;
  healthScore:       number;
  dailyInsight:      string | null;
  dailyAction:       string | null;
  insightLoading:    boolean;
  onEditPortfolio:   () => void;
}) {
  if (enrichedRows.length === 0) return <Empty msg="No holdings found. Add your portfolio to get started." />;

  const totalInvested = pricedRows.reduce((a, r) => a + r.invested, 0);
  const totalValue    = pricedRows.reduce((a, r) => a + r.currentValue, 0);
  const totalPnl      = totalValue - totalInvested;
  const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const scoreCol      = healthScore >= 70 ? C.green : healthScore >= 40 ? C.gold : C.red;
  const scoreLabel    = healthScore >= 70 ? 'Strong' : healthScore >= 40 ? 'Moderate' : 'At Risk';

  return (
    <div className="flex flex-col gap-5 pb-16">

      {/* ── Hero snapshot ─────────────────────────────────────────────────── */}
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: '24px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 20 }}>
          {/* Left: value + P&L */}
          <div>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 6px' }}>
              Portfolio Value
            </p>
            <p style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 44, letterSpacing: '-2px', color: C.text, margin: 0, lineHeight: 1 }}>
              ₹{fmt(totalValue, 0)}
            </p>
            <p style={{ marginTop: 10, fontSize: 15, color: totalPnl >= 0 ? C.green : C.red, fontWeight: 500, margin: '10px 0 0' }}>
              {totalPnl >= 0 ? '+' : '−'}₹{fmt(Math.abs(totalPnl), 0)}{' '}
              <span style={{ fontSize: 13, opacity: 0.8 }}>({fmtPct(totalPnlPct)})</span>
            </p>
          </div>
          {/* Right: health score ring */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              border: `3px solid ${scoreCol}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: scoreCol, lineHeight: 1 }}>{healthScore}</span>
              <span style={{ fontSize: 9, color: scoreCol, opacity: 0.65, letterSpacing: '0.06em' }}>SCORE</span>
            </div>
            <span style={{ fontSize: 10, color: scoreCol, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              {scoreLabel}
            </span>
          </div>
        </div>
      </div>

      {/* ── Daily insight ─────────────────────────────────────────────────── */}
      <DailyInsight text={dailyInsight} action={dailyAction} loading={insightLoading} />

      {/* ── Live price status ─────────────────────────────────────────────── */}
      <PriceStatusBar
        enrichedRows={enrichedRows}
        fetching={pricesFetching}
        lastFetched={pricesLastFetched}
        onRefresh={onRefreshPrices}
      />

      {/* ── Holdings table ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Holdings" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottomColor: C.border }} className="border-b">
                {['Stock', 'Ticker', 'Shares', 'Avg Buy', 'Current', 'Day %', 'Value', 'P&L', 'Weight', 'Signal'].map((h) => (
                  <th key={h} className="table-head text-left px-4 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {enrichedRows.map((row) => (
                <tr key={row.id} style={{ borderBottomColor: C.border }} className="border-b last:border-b-0 hover:bg-[#18181b] transition-colors">
                  <td style={{ color: C.text }}  className="px-4 py-3 font-medium whitespace-nowrap">{row.name}</td>
                  <td style={{ color: C.muted }} className="px-4 py-3 font-mono text-xs">{row.ticker}</td>
                  <td style={{ color: C.text }}  className="px-4 py-3">{row.shares}</td>
                  <td style={{ color: C.text }}  className="px-4 py-3">{fmt(row.avgBuyPrice)}</td>
                  <td className="px-4 py-3">
                    {row.currentPrice !== null
                      ? <span style={{ color: C.text }}>{fmt(row.currentPrice)}</span>
                      : <span style={{ color: C.subtle }} className="text-xs">₹{fmt(row.avgBuyPrice)} <span style={{ color: C.subtle, fontStyle: 'italic' }}>est.</span></span>}
                  </td>
                  <td className="px-4 py-3">
                    {row.changePercent != null ? (
                      <span style={{ color: row.changePercent >= 0 ? C.green : C.red }} className="text-xs font-medium">
                        {row.changePercent >= 0 ? '+' : ''}{fmt(row.changePercent, 2)}%
                      </span>
                    ) : (
                      <span style={{ color: C.muted }} className="text-xs">—</span>
                    )}
                  </td>
                  <td style={{ color: C.text }}  className="px-4 py-3">{row.currentValue !== null ? fmt(row.currentValue) : <span style={{ color: C.muted }}>—</span>}</td>
                  <td className="px-4 py-3">
                    {row.pnl !== null && row.pnlPct !== null ? (
                      row.pnl === 0 && row.priceSource === 'unavailable'
                        ? <span style={{ color: C.muted }}>—</span>
                        : row.pnl === 0
                          ? <span style={{ color: C.subtle, fontSize: 12 }}>₹0.00</span>
                          : <PnlBadge value={row.pnl} pct={row.pnlPct} />
                    ) : (
                      <span style={{ color: C.muted }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.weight !== null ? (
                      <div className="flex items-center gap-2">
                        <div style={{ backgroundColor: C.s2 }} className="w-14 h-1.5 rounded-full overflow-hidden">
                          <div style={{ width: `${row.weight}%`, backgroundColor: C.gold }} className="h-full rounded-full" />
                        </div>
                        <span style={{ color: C.muted }} className="text-xs">{fmt(row.weight, 1)}%</span>
                      </div>
                    ) : <span style={{ color: C.muted }}>—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {row.pnlPct !== null && row.weight !== null ? (() => {
                      const sig = getSignal(row.pnlPct, row.weight);
                      return (
                        <span style={{ color: sig.color, backgroundColor: sig.bg }} className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap">
                          {sig.label}
                        </span>
                      );
                    })() : <span style={{ color: C.muted }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {enrichedRows.length > pricedRows.length && (
          <div style={{ borderTopColor: C.border }} className="px-5 py-3 border-t">
            <p style={{ color: C.subtle, fontSize: 11 }} className="italic">
              Live prices unavailable for {enrichedRows.length - pricedRows.length} holding{enrichedRows.length - pricedRows.length !== 1 ? 's' : ''} — showing estimated values
            </p>
          </div>
        )}
      </Card>

      {/* ── Portfolio vs Nifty chart ───────────────────────────────────────── */}
      <PerformanceChart portfolio={portfolio} />

      {/* ── Edit portfolio button ─────────────────────────────────────────── */}
      <button
        onClick={onEditPortfolio}
        style={{
          background:     'none',
          border:         `1px solid ${C.border}`,
          borderRadius:   14,
          color:          C.muted,
          fontSize:       13,
          fontWeight:     500,
          padding:        '14px 20px',
          cursor:         'pointer',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          gap:            8,
          fontFamily:     '"DM Sans", system-ui, sans-serif',
          transition:     'border-color 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.color = C.gold; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted; }}
      >
        ← Edit portfolio
      </button>
    </div>
  );
}

// ── Tab: Health Score ──────────────────────────────────────────────────────────

function HealthTab({ healthScore, pricedRows, portfolioData, userContext, onHealthScore }: {
  healthScore:   HealthBreakdown;
  pricedRows:    PricedRow[];
  portfolioData: PortfolioData;
  userContext:   UserContext;
  onHealthScore: (score: number, text: string) => void;
}) {
  const { total, diversification, diversificationMax, concentration, concentrationMax, profitability, profitabilityMax, recommendations } = healthScore;
  const scoreLabel = total >= 70 ? 'Strong' : total >= 40 ? 'Moderate' : 'At Risk';
  const scoreCol   = total >= 70 ? C.green : total >= 40 ? C.gold : C.red;
  const icons = ['⚖', '◈', '◉'] as const;
  const ai = useArtha(onHealthScore);

  return (
    <div className="flex flex-col gap-5 pb-12">
      {/* 1 — AI button + response */}
      <Card className="p-5">
        <ArthaPanel
          label="Run Health Analysis"
          onGenerate={() => ai.execute('health', portfolioData, userContext)}
          loading={ai.loading}
          error={ai.error}
          response={ai.response}
          dataAction="analyse-health"
        />
      </Card>

      {/* 2 — Divider */}
      <div style={{ height: 1, background: C.border, margin: '4px 0' }} />

      {/* 3 — Score ring + label */}
      <Card className="p-6 flex flex-col items-center gap-2">
        <Gauge score={total} />
        <span style={{ color: scoreCol }} className="text-sm font-semibold uppercase tracking-widest">{scoreLabel}</span>
        {pricedRows.length === 0 && (
          <p style={{ color: C.muted }} className="text-xs mt-1">Add holdings with recognised tickers to generate your score.</p>
        )}
      </Card>

      {/* 4 — Sub-score breakdown + recommendations */}
      <Card className="p-6 flex flex-col gap-5">
        <h2 style={{ color: C.text, fontFamily: '"Fraunces", serif' }} className="text-base font-semibold">Score breakdown</h2>
        <SubScoreBar label="Diversification"    score={diversification} max={diversificationMax} />
        <SubScoreBar label="Concentration Risk" score={concentration}   max={concentrationMax}  />
        <SubScoreBar label="Profitability"       score={profitability}   max={profitabilityMax}  />
        <div style={{ borderTopColor: C.border }} className="border-t pt-4">
          <SubScoreBar label="Overall Score" score={total} max={100} />
        </div>
      </Card>
      <Card className="p-6 flex flex-col gap-4">
        <h2 style={{ color: C.text, fontFamily: '"Fraunces", serif' }} className="text-base font-semibold">Recommendations</h2>
        {recommendations.map((rec, i) => (
          <RecCard key={i} icon={icons[i as 0 | 1 | 2]} text={rec} />
        ))}
      </Card>

    </div>
  );
}

// ── Tab: Analyse (Health + Scenarios + AI Picks) ──────────────────────────────

function AnalyseTab({
  healthScore, pricedRows, portfolioData, userContext, onHealthScore,
  portfolio, livePrices, onApplyToRealPortfolio, userId,
}: {
  healthScore:            HealthBreakdown;
  pricedRows:             PricedRow[];
  portfolioData:          PortfolioData;
  userContext:            UserContext;
  onHealthScore:          (score: number, text: string) => void;
  portfolio:              PortfolioStock[];
  livePrices:             Record<string, import('../lib/prices').LivePrice | null>;
  onApplyToRealPortfolio: (stocks: PortfolioStock[]) => void;
  userId:                 string;
}) {
  return (
    <div className="flex flex-col gap-5 pb-16">
      <SectionDivider label="Portfolio Health" />
      <HealthTab
        healthScore={healthScore}
        pricedRows={pricedRows}
        portfolioData={portfolioData}
        userContext={userContext}
        onHealthScore={onHealthScore}
      />

      <SectionDivider label="Scenarios" />
      <ScenarioSimulator
        portfolio={portfolio}
        livePrices={livePrices}
        userContext={userContext}
        onApplyToRealPortfolio={onApplyToRealPortfolio}
      />

      <SectionDivider label="AI Picks" />
      <AIPicksErrorBoundary>
        <AiPicksTab
          pricedRows={pricedRows}
          portfolioData={portfolioData}
          userContext={userContext}
          userId={userId}
        />
      </AIPicksErrorBoundary>
    </div>
  );
}

// ── Tab: Plan (Goals + Watchlist) ─────────────────────────────────────────────

function PlanTab({
  goals, setGoals, goalForm, setGoalForm, totalValue, portfolioData, userContext, onGoalAdded,
  userId, portfolioSummary,
}: {
  goals:          Goal[];
  setGoals:       Dispatch<SetStateAction<Goal[]>>;
  goalForm:       GoalFormState;
  setGoalForm:    Dispatch<SetStateAction<GoalFormState>>;
  totalValue:     number;
  portfolioData:  PortfolioData;
  userContext:    UserContext;
  onGoalAdded:    (goalName: string, amount: number) => void;
  userId:         string;
  portfolioSummary: string;
}) {
  return (
    <div className="flex flex-col gap-5 pb-16">
      <SectionDivider label="Goals" />
      <GoalTrackerTab
        goals={goals} setGoals={setGoals}
        goalForm={goalForm} setGoalForm={setGoalForm}
        totalValue={totalValue}
        portfolioData={portfolioData}
        userContext={userContext}
        onGoalAdded={onGoalAdded}
        userId={userId}
      />

      <SectionDivider label="Watchlist" />
      <WatchlistTab userId={userId} portfolioSummary={portfolioSummary} />
    </div>
  );
}

// ── Market Intelligence types ──────────────────────────────────────────────────

interface MacroThemeItem {
  theme:           string;
  explanation:     string;
  affectedSectors: string[];
  direction:       'Positive' | 'Negative' | 'Mixed';
  confidence:      'High' | 'Medium' | 'Low';
  sourceHeadline:  string;
}
interface PortfolioImpactItem {
  ticker:         string;
  stockName:      string;
  impact:         'Positive' | 'Negative' | 'Neutral';
  reason:         string;
  action:         'Hold' | 'Watch' | 'Consider exit' | 'Consider adding';
  sourceHeadline: string;
}
interface NewsPickItem {
  stockName:      string;
  ticker:         string;
  catalyst:       string;
  reason:         string;
  risk:           string;
  timeHorizon:    'Days' | 'Weeks' | 'Months';
  sourceHeadline: string;
}
interface NewsHeadlineItem {
  title: string; description: string; pubDate: string; link: string; source: string;
}
interface MacroTheme {
  title:           string;
  what:            string;
  portfolioImpact: string;
  direction:       'Positive' | 'Negative' | 'Neutral';
  affectedTicker:  string | null;
}

interface MacroData {
  themes?:          MacroTheme[];
  lastUpdated?:     string;
  macroThemes?:     MacroThemeItem[];
  portfolioImpacts?: PortfolioImpactItem[];
  newsBasedPicks?:  NewsPickItem[];
  headlinesUsed?:   NewsHeadlineItem[];
  noNewsAvailable?: boolean;
}

// ── Market Intelligence helpers ───────────────────────────────────────────────

const CATALYST_KW = ['results','earnings','q4','agr','spectrum','fundraise','merger','acquisition','approval','order','contract','judgment','verdict','stake','investment'];
function hasCatalyst(hl: string) { const l = hl.toLowerCase(); return CATALYST_KW.some((k) => l.includes(k)); }
function timeAgoStr(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2)  return 'Live — updated just now';
  if (m < 60) return `Updated ${m}m ago`;
  const h = Math.round(m / 60); return `Updated ${h}h ago`;
}
function dirColor(d: 'Positive' | 'Negative' | 'Mixed'): string {
  return d === 'Positive' ? C.green : d === 'Negative' ? C.red : C.gold;
}
function impactArrow(i: 'Positive' | 'Negative' | 'Neutral'): { a: string; c: string } {
  return i === 'Positive' ? { a: '↑', c: C.green } : i === 'Negative' ? { a: '↓', c: C.red } : { a: '→', c: C.gold };
}
function actionBadgeStyle(action: string): { color: string; bg: string } {
  if (action === 'Consider adding') return { color: C.green, bg: `${C.green}1a` };
  if (action === 'Consider exit')   return { color: C.red,   bg: `${C.red}1a` };
  if (action === 'Watch' || action.startsWith('Watch')) return { color: C.gold, bg: `${C.gold}1a` };
  return { color: C.muted, bg: `${C.muted}18` };
}

// ── Market Intelligence component ─────────────────────────────────────────────

function MarketIntelligence({ pricedRows, portfolioData, userContext, userId }: { pricedRows: PricedRow[]; portfolioData: PortfolioData; userContext: UserContext; userId: string }) {
  const [data,            setData]            = useState<MacroData | null>(null);
  const [loading,         setLoading]         = useState(false);
  const [updating,        setUpdating]        = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [headlinesOpen,   setHeadlinesOpen]   = useState(false);
  const [lastFetched,     setLastFetched]     = useState<number | null>(null);
  const [expandedPick,    setExpandedPick]    = useState<number | null>(null);
  const [watchlistAdded,  setWatchlistAdded]  = useState<Set<string>>(new Set());
  const [watchlistToast,  setWatchlistToast]  = useState<string | null>(null);

  async function handleAddToWatchlist(stockName: string, ticker: string) {
    if (watchlistAdded.has(ticker) || !userId) return;
    const result = await addWatchlistItem(userId, stockName, ticker, null);
    if (result) {
      setWatchlistAdded((prev) => new Set([...prev, ticker]));
      setWatchlistToast(`${stockName} added to watchlist`);
      setTimeout(() => setWatchlistToast(null), 3000);
    }
  }

  useEffect(() => {
    const raw = sessionStorage.getItem('artha_market_intel');
    if (raw) {
      try {
        const c = JSON.parse(raw) as { data: MacroData; fetchedAt: number };
        setData(c.data);
        setLastFetched(c.fetchedAt);
        if (Date.now() - c.fetchedAt > 30 * 60 * 1000) void doFetch(true);
      } catch { void doFetch(); }
    } else {
      void doFetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doFetch(background = false) {
    if (!portfolioData?.holdings?.length) return;
    background ? setUpdating(true) : (setLoading(true), setError(null));
    try {
      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'macro', portfolioData, userContext }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const json = await res.json() as { text?: string };
      const text = json.text ?? '';
      // Parse JSON from the response text
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let parsed: MacroData;
      try {
        parsed = JSON.parse(cleaned) as MacroData;
      } catch {
        // If not valid JSON, create a single theme from the text
        parsed = { themes: [] } as MacroData;
      }
      // Normalize: ensure themes array exists and noNewsAvailable check
      if (!parsed.themes) parsed = { themes: [], noNewsAvailable: true } as MacroData;
      setData(parsed);
      const now = Date.now();
      setLastFetched(now);
      sessionStorage.setItem('artha_market_intel', JSON.stringify({ data: parsed, fetchedAt: now }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load market intelligence');
    } finally { setLoading(false); setUpdating(false); }
  }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
      <h2 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 20, color: C.text, margin: 0 }}>
        Market Intelligence
      </h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {lastFetched && (
          <span style={{ fontSize: 10, color: C.subtle, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 99, padding: '3px 10px' }}>
            {updating ? 'Updating…' : timeAgoStr(lastFetched)}
          </span>
        )}
        <button
          onClick={() => void doFetch()}
          disabled={loading || updating}
          style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '5px 12px', fontSize: 11, color: loading || updating ? C.subtle : C.muted, cursor: loading || updating ? 'not-allowed' : 'pointer', fontFamily: '"DM Sans", sans-serif' }}
        >
          Refresh →
        </button>
      </div>
    </div>
  );

  if (loading) return (
    <Card className="p-5">
      {header}
      <div style={{ textAlign: 'center', padding: '32px 0', color: C.muted, fontSize: 13 }}>
        <div style={{ width: 24, height: 24, borderRadius: '50%', border: `2px solid ${C.gold}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
        Fetching live news and analysing your portfolio…
      </div>
    </Card>
  );

  // On API failure with no cached data — hide quietly per spec
  if (error && !data) return null;

  if (!data) return null;

  if (data.noNewsAvailable) return (
    <Card className="p-5">
      {header}
      <p style={{ color: C.muted, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>Market news unavailable right now. Try again later.</p>
    </Card>
  );

  const impactedTickers = new Set((data.portfolioImpacts ?? []).map((i) => i.ticker));
  const unaffected      = pricedRows.filter((r) => !impactedTickers.has(r.ticker));

  return (
    <Card className="p-5">
      {header}

      {/* Watchlist success toast */}
      {watchlistToast && (
        <div style={{ position: 'fixed', bottom: 80, right: 24, zIndex: 9999, background: C.s1, border: `1px solid ${C.green}`, borderRadius: 10, padding: '10px 16px', color: C.text, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
          <span style={{ color: C.green }}>✓</span> {watchlistToast}
        </div>
      )}

      {/* 3-column grid — collapses on narrow screens (old format) */}
      {(data.macroThemes || data.portfolioImpacts || data.newsBasedPicks) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, alignItems: 'start' }}>

          {/* ── Column 1: Macro Themes ── */}
          {data.macroThemes && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 12px' }}>What's moving markets</p>
              {data.macroThemes.length === 0
                ? <p style={{ fontSize: 12, color: C.muted }}>No macro themes from today's news.</p>
                : data.macroThemes.map((t, i) => (
                  <div key={i} style={{ background: C.s2, borderLeft: `3px solid ${dirColor(t.direction)}`, borderRadius: 8, padding: '12px 14px', marginBottom: 10, position: 'relative' }}>
                    <span style={{ position: 'absolute', top: 10, right: 10, fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: dirColor(t.direction), background: `${dirColor(t.direction)}1a`, borderRadius: 99, padding: '2px 7px' }}>
                      {t.confidence}
                    </span>
                    <p style={{ fontSize: 13, fontWeight: 500, color: C.text, margin: '0 0 4px', paddingRight: 56 }}>{t.theme}</p>
                    <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.7, margin: '0 0 10px' }}>{t.explanation}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {t.affectedSectors.map((s) => (
                        <span key={s} style={{ fontSize: 10, color: C.muted, background: C.s1, border: `1px solid ${C.border}`, borderRadius: 99, padding: '2px 8px' }}>{s}</span>
                      ))}
                    </div>
                  </div>
                ))
              }
            </div>
          )}

          {/* ── Column 2: Portfolio Impact ── */}
          {data.portfolioImpacts && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 12px' }}>How your holdings are affected</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.portfolioImpacts.map((imp, i) => {
                  const { a: arrow, c: ac } = impactArrow(imp.impact);
                  const catalystOverride    = imp.action === 'Consider exit' && hasCatalyst(imp.sourceHeadline);
                  const displayAction       = catalystOverride ? 'Watch closely — catalyst ahead' : imp.action;
                  const badge               = actionBadgeStyle(displayAction);
                  return (
                    <div key={i} style={{ background: C.s2, borderRadius: 8, padding: '12px 14px' }}>
                      {catalystOverride && (
                        <div style={{ background: `${C.gold}15`, border: `1px solid ${C.gold}50`, borderRadius: 6, padding: '5px 9px', marginBottom: 8, fontSize: 11, color: C.gold, lineHeight: 1.5 }}>
                          ⚡ Near-term catalyst detected — wait before deciding
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 15, color: ac, lineHeight: 1 }}>{arrow}</span>
                          <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{imp.stockName}</span>
                          <span style={{ fontSize: 10, color: C.muted }}>{imp.ticker}</span>
                        </div>
                        <span style={{ fontSize: 9, fontWeight: 600, color: badge.color, background: badge.bg, borderRadius: 99, padding: '3px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {displayAction}
                        </span>
                      </div>
                      <p style={{ fontSize: 12, color: C.muted, margin: '4px 0 5px', lineHeight: 1.5 }}>{imp.reason}</p>
                      <p style={{ fontSize: 10, color: C.subtle, margin: 0, fontStyle: 'italic' }}>
                        Based on: {imp.sourceHeadline.slice(0, 60)}{imp.sourceHeadline.length > 60 ? '…' : ''}
                      </p>
                    </div>
                  );
                })}
                {unaffected.map((r) => (
                  <div key={r.ticker} style={{ background: C.s2, borderRadius: 8, padding: '10px 14px', opacity: 0.45 }}>
                    <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>{r.name} — No significant news impact today</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Column 3: News-Driven Picks ── */}
          {data.newsBasedPicks && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 12px' }}>Stocks the news suggests</p>
              {data.newsBasedPicks.length === 0
                ? <p style={{ fontSize: 12, color: C.muted }}>No news-driven picks right now.</p>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {data.newsBasedPicks.map((pick, i) => {
                      const hc     = pick.timeHorizon === 'Days' ? C.red : pick.timeHorizon === 'Weeks' ? C.gold : C.green;
                      const isOpen = expandedPick === i;
                      return (
                        <div key={i} style={{ background: C.s2, borderRadius: 8, padding: '14px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                            <div>
                              <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{pick.stockName}</span>
                              <span style={{ fontSize: 10, color: C.gold, background: `${C.gold}1a`, borderRadius: 4, padding: '1px 6px', marginLeft: 8 }}>NSE:{pick.ticker}</span>
                            </div>
                            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: hc, background: `${hc}1a`, borderRadius: 99, padding: '2px 7px', whiteSpace: 'nowrap', flexShrink: 0 }}>{pick.timeHorizon}</span>
                          </div>
                          <p style={{ fontSize: 12, color: C.muted, margin: '0 0 8px', lineHeight: 1.6 }}>{pick.catalyst}</p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <button onClick={() => setExpandedPick(isOpen ? null : i)} style={{ background: 'none', border: 'none', color: C.gold, fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: '"DM Sans", sans-serif' }}>
                              Why now {isOpen ? '↑' : '→'}
                            </button>
                            <button
                              onClick={() => void handleAddToWatchlist(pick.stockName, pick.ticker)}
                              disabled={watchlistAdded.has(pick.ticker) || !userId}
                              style={{ background: 'none', border: `1px solid ${watchlistAdded.has(pick.ticker) ? C.green : C.border}`, borderRadius: 6, padding: '3px 10px', fontSize: 10, color: watchlistAdded.has(pick.ticker) ? C.green : C.muted, cursor: watchlistAdded.has(pick.ticker) || !userId ? 'default' : 'pointer', fontFamily: '"DM Sans", sans-serif' }}
                            >
                              {watchlistAdded.has(pick.ticker) ? '✓ Added' : '+ Watchlist'}
                            </button>
                          </div>
                          {isOpen && (
                            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                              <p style={{ fontSize: 12, color: C.muted, margin: '0 0 8px', lineHeight: 1.6 }}>{pick.reason}</p>
                              <p style={{ fontSize: 11, color: C.red, margin: 0, background: `${C.red}0d`, borderRadius: 6, padding: '6px 8px' }}>⚠ Risk: {pick.risk}</p>
                            </div>
                          )}
                          <WatchlistButton ticker={pick.ticker} stockName={pick.stockName} />
                        </div>
                      );
                    })}
                  </div>
                )
              }
            </div>
          )}
        </div>
      )}

      {/* New macro themes from /api/analyze */}
      {data.themes && data.themes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {data.themes.map((theme, i) => {
            const col = theme.direction === 'Positive' ? C.green : theme.direction === 'Negative' ? C.red : C.muted;
            return (
              <div key={i} style={{ background: C.s2, borderRadius: 10, padding: '14px 16px', borderLeft: `3px solid ${col}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ color: col, fontSize: 11, fontWeight: 700 }}>{theme.direction.toUpperCase()}</span>
                  <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{theme.title}</span>
                  {theme.affectedTicker && (
                    <span style={{ color: C.gold, fontSize: 10, background: `${C.gold}18`, borderRadius: 4, padding: '2px 6px' }}>{theme.affectedTicker}</span>
                  )}
                </div>
                <p style={{ color: C.muted, fontSize: 12, margin: '0 0 6px', lineHeight: 1.6 }}>{theme.what}</p>
                <p style={{ color: C.text, fontSize: 12, margin: 0, lineHeight: 1.6 }}>
                  <span style={{ color: C.gold }}>Your portfolio: </span>{theme.portfolioImpact}
                </p>
                {theme.affectedTicker && (
                  <WatchlistButton ticker={theme.affectedTicker} stockName={theme.title} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Source headlines — collapsed by default (old format only) */}
      {data.headlinesUsed && data.headlinesUsed.length > 0 && (
        <div style={{ marginTop: 20, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
          <button onClick={() => setHeadlinesOpen((o) => !o)} style={{ background: 'none', border: 'none', color: C.subtle, fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: '"DM Sans", sans-serif', fontStyle: 'italic' }}>
            Based on {data.headlinesUsed.length} headlines from last 48 hours — {headlinesOpen ? 'hide sources' : 'click to see sources'}
          </button>
          {headlinesOpen && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {data.headlinesUsed.map((h, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 10, color: C.subtle, flexShrink: 0 }}>{new Date(h.pubDate).toLocaleDateString('en-IN')}</span>
                  <a href={h.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: C.muted, textDecoration: 'none', lineHeight: 1.5 }} onMouseOver={(e) => (e.currentTarget.style.color = C.gold)} onMouseOut={(e) => (e.currentTarget.style.color = C.muted)}>{h.title}</a>
                  <span style={{ fontSize: 9, color: C.subtle, flexShrink: 0 }}>{h.source}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── AI Picks error boundary ────────────────────────────────────────────────────

class AIPicksErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: '' };
  }
  static getDerivedStateFromError(error: Error) {
    console.error('AI PICKS CRASH:', error);
    return { hasError: true, errorMsg: error.message };
  }
  override render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px 24px', textAlign: 'center' }}>
          <p style={{ color: C.muted, fontSize: 13, margin: '0 0 4px' }}>AI Picks couldn't load.</p>
          {this.state.errorMsg && (
            <p style={{ fontSize: 11, color: C.subtle, margin: '0 0 12px' }}>{this.state.errorMsg}</p>
          )}
          <button
            onClick={() => this.setState({ hasError: false, errorMsg: '' })}
            style={{ padding: '8px 16px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.muted, cursor: 'pointer', fontSize: 12, fontFamily: '"DM Sans", system-ui, sans-serif' }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Watchlist button (localStorage, works without login) ─────────────────────

function WatchlistButton({ ticker, stockName }: { ticker: string; stockName: string }) {
  const [added, setAdded] = useState(false);

  const addToWatchlist = () => {
    const existing = JSON.parse(localStorage.getItem('artha_watchlist') || '[]') as Array<{ ticker: string }>;
    const alreadyExists = existing.some((item) => item.ticker === ticker);
    if (!alreadyExists) {
      const newItem = {
        id:          `${Date.now()}-${ticker}`,
        stockName,
        ticker,
        targetPrice: null,
        notes:       'Added from AI Picks',
        addedAt:     new Date().toISOString(),
      };
      existing.push(newItem as typeof existing[0]);
      localStorage.setItem('artha_watchlist', JSON.stringify(existing));
    }
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  };

  return (
    <button
      onClick={addToWatchlist}
      style={{
        marginTop:    '12px',
        padding:      '6px 14px',
        fontSize:     '11px',
        background:   added ? '#0d1f18' : 'none',
        border:       `1px solid ${added ? '#4ead84' : '#2a2a2f'}`,
        borderRadius: '6px',
        color:        added ? '#4ead84' : '#9b9a94',
        cursor:       'pointer',
        transition:   'all 0.2s',
        display:      'block',
        marginLeft:   'auto',
        fontFamily:   '"DM Sans", system-ui, sans-serif',
      }}
    >
      {added ? '✓ Added to Watchlist' : '+ Watchlist'}
    </button>
  );
}

// ── Tab: AI Picks ──────────────────────────────────────────────────────────────

function AiPicksTab({ pricedRows, portfolioData, userContext, userId }: {
  pricedRows:    PricedRow[];
  portfolioData: PortfolioData;
  userContext:   UserContext;
  userId:        string;
}) {
  const ai            = useArtha();
  const { context }   = useSessionContext();
  const picksResponse = ai.response ?? context.picksGenerated?.response ?? null;
  const [horizonPref, setHorizonPref] = useState<'long' | 'short'>('long');
  const [retryDone,   setRetryDone]   = useState(false);
  const [usStocksErr, setUsStocksErr] = useState<string | null>(null);
  const [macroData,    setMacroData]    = useState<{ themes?: Array<{ sentiment?: string; title?: string; what?: string; portfolioImpact?: string }> } | null>(null);
  const [macroLoading, setMacroLoading] = useState(false);
  const [macroError,   setMacroError]   = useState(false);

  // Null safety guard
  const holdings   = portfolioData?.holdings ?? [];
  const totalValue = portfolioData?.totalValue ?? 0;
  void totalValue; // used in safePData below

  const safeRows  = pricedRows ?? [];
  const safePData = portfolioData ?? { holdings: [], totalValue: 0, totalInvested: 0, totalPnl: 0, totalPnlPct: 0, healthScore: 0, diversificationScore: 0, concentrationScore: 0, profitabilityScore: 0, scenarios: { bull: 0, base: 0, bear: 0 } };

  let gaps: ReturnType<typeof computePortfolioGaps> = [];
  try {
    gaps = computePortfolioGaps(safeRows);
  } catch (e) {
    console.error('Gap calculation error:', (e as Error).message);
    gaps = [];
  }

  const riskFlags = safeRows.filter((r) => r.weight > 40);

  function generatePicks(pref: 'long' | 'short' = horizonPref) {
    setUsStocksErr(null);
    setRetryDone(false);
    void ai.execute('picks', safePData, { ...userContext, horizonPreference: pref });
  }

  // Auto-retry once if US stocks appear in response
  useEffect(() => {
    if (!picksResponse || ai.loading) return;
    const hasUS = US_STOCK_KEYWORDS.some((k) => picksResponse.includes(k));
    if (hasUS && !retryDone) { setRetryDone(true); generatePicks(); }
    else if (hasUS && retryDone) setUsStocksErr('Unable to generate Indian-specific picks right now. Please try again.');
    else { setRetryDone(false); setUsStocksErr(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksResponse, ai.loading]);

  const fetchMacro = async () => {
    setMacroLoading(true);
    setMacroError(false);
    try {
      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'macro', portfolioData, userContext: userContext || {} }),
      });
      const data = await res.json() as { text?: string };
      const text = data.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as typeof macroData;
        setMacroData(parsed);
      }
    } catch (e) {
      console.error('Market intelligence error:', e);
      setMacroError(true);
    } finally {
      setMacroLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchMacro(); }, []);

  const cards = picksResponse
    ? picksResponse.split(/\n(?=## )/).filter((s) => /^## .+ — NSE:[A-Z0-9]+/.test(s))
    : [];

  const longTermGoal = userContext?.goals?.[0];

  if (holdings.length === 0) {
    return (
      <div style={{
        padding:   '40px 24px',
        textAlign: 'center',
        color:     '#9b9a94',
        fontSize:  '13px',
      }}>
        Add stocks to your portfolio to see AI Picks.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-16">
      {/* Market Intelligence */}
      {!macroError && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#5a5955' }}>
              Market Intelligence
            </span>
            <button onClick={() => void fetchMacro()} style={{ background: 'none', border: 'none', color: '#9b9a94', fontSize: '11px', cursor: 'pointer' }}>
              Refresh →
            </button>
          </div>

          {macroLoading && (
            <div style={{ color: '#5a5955', fontSize: '12px', padding: '12px 0' }}>
              Analysing current market conditions...
            </div>
          )}

          {!macroLoading && macroData?.themes?.map((theme, i) => (
            <div key={i} style={{
              background:   '#111113',
              borderLeft:   `3px solid ${theme.sentiment === 'bullish' ? '#4ead84' : theme.sentiment === 'bearish' ? '#e05252' : '#d4a843'}`,
              borderRadius: '0 8px 8px 0',
              padding:      '12px 16px',
              marginBottom: '8px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: '#f0efe8', marginBottom: '4px' }}>
                {theme.title}
              </div>
              <div style={{ fontSize: '12px', color: '#9b9a94', marginBottom: '4px' }}>
                {theme.what}
              </div>
              {theme.portfolioImpact && (
                <div style={{ fontSize: '12px', color: '#d4a843' }}>
                  → {theme.portfolioImpact}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Critical concentration alert */}
      {riskFlags.length > 0 && (
        <div style={{ backgroundColor: 'rgba(224,82,82,0.07)', border: '1px solid rgba(224,82,82,0.25)', borderRadius: 14, padding: '16px 20px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ color: C.red, fontSize: 18, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div>
            <p style={{ color: C.red, fontWeight: 600, fontSize: 13, margin: '0 0 4px' }}>Concentration Risk</p>
            <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.6, margin: 0 }}>
              {riskFlags.map((r) => `${r.ticker} (${fmt(r.weight, 1)}%)`).join(', ')} {riskFlags.length === 1 ? 'exceeds' : 'exceed'} 40% of your portfolio. One bad quarter from this stock could cause major damage.
            </p>
          </div>
        </div>
      )}

      {/* ── STEP 1: Gap cards ───────────────────────────────────────────────── */}
      {gaps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.subtle, margin: '0 0 2px' }}>
            Portfolio gaps identified
          </p>
          {gaps.map((gap, i) => <GapCard key={i} gap={gap} />)}
        </div>
      )}

      {/* ── Main CTA (shown before response) ────────────────────────────────── */}
      {!picksResponse && (
        <button
          type="button"
          onClick={() => generatePicks()}
          disabled={ai.loading}
          style={{
            width: '100%', background: ai.loading ? C.s2 : C.gold,
            color: ai.loading ? C.muted : '#0a0a0b', border: 'none', borderRadius: 14,
            padding: '16px 20px', fontSize: 14, fontWeight: 500,
            cursor: ai.loading ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            transition: 'background 0.15s', fontFamily: '"DM Sans", system-ui, sans-serif',
          }}
        >
          {ai.loading ? (
            <>
              <span style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${C.muted}`, borderTopColor: 'transparent', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
              Analysing your specific situation…
            </>
          ) : (
            <><span style={{ fontSize: 15 }}>✦</span> Show me what to add, based on my goals →</>
          )}
        </button>
      )}

      {/* Error */}
      {(ai.error || usStocksErr) && (
        <div style={{ border: '1px solid rgba(224,82,82,0.25)', backgroundColor: 'rgba(224,82,82,0.06)', borderRadius: 14, padding: '12px 16px' }}>
          <p style={{ color: C.red, fontSize: 12, fontWeight: 600, margin: '0 0 4px' }}>Error</p>
          <p style={{ color: C.muted, fontSize: 12, margin: 0, lineHeight: 1.6 }}>{usStocksErr ?? ai.error}</p>
        </div>
      )}

      {/* ── STEP 2: AI Response ─────────────────────────────────────────────── */}
      {picksResponse && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Regenerate + loading */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!ai.loading && (
              <button
                onClick={() => generatePicks()}
                style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 14px', fontSize: 12, color: C.muted, cursor: 'pointer', fontFamily: '"DM Sans", system-ui, sans-serif' }}
              >
                ↺ Regenerate picks
              </button>
            )}
            {ai.loading && (
              <>
                <span style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${C.gold}`, borderTopColor: 'transparent', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: 13, color: C.muted }}>Generating new picks…</span>
              </>
            )}
          </div>

          {!ai.loading && (
            <>
              {/* Stock pick cards */}
              {cards.length > 0
                ? cards.map((section, i) => <PickCard key={i} section={section} />)
                : (
                  <div style={{ background: C.s2, border: `1px solid ${C.gold}40`, borderRadius: 12, padding: 16 }}>
                    <div className="ai-output" dangerouslySetInnerHTML={{ __html: renderMarkdown(picksResponse) }} />
                  </div>
                )
              }

              {/* Monthly plan + honest truth (non-card sections) */}
              {(() => {
                const planMatch = picksResponse.match(/\n(## Your Complete Monthly Plan[\s\S]*)/);
                if (!planMatch || cards.length === 0) return null;
                return (
                  <div style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 20px' }}>
                    <div className="ai-output" dangerouslySetInnerHTML={{ __html: renderMarkdown(planMatch[1]) }} />
                  </div>
                );
              })()}

              {/* Horizon switch */}
              <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <p style={{ fontSize: 12, color: C.muted, margin: 0, lineHeight: 1.5, flex: 1 }}>
                  {horizonPref === 'long'
                    ? `Picks calibrated for ${longTermGoal?.targetAmount ? `your ₹${fmt(longTermGoal.targetAmount)} goal` : userContext.investmentHorizon || 'long-term'}. Want short-term picks instead?`
                    : 'Showing short-term picks (1–2 years). Switch back to long-term?'}
                </p>
                <button
                  onClick={() => { const next = horizonPref === 'long' ? 'short' : 'long'; setHorizonPref(next); generatePicks(next); }}
                  style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 14px', fontSize: 12, color: C.gold, cursor: 'pointer', fontFamily: '"DM Sans", system-ui, sans-serif', whiteSpace: 'nowrap', fontWeight: 500 }}
                >
                  {horizonPref === 'long' ? 'Switch to short-term view' : 'Switch to long-term view'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <p style={{ color: C.muted, fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>
        AI Picks are illustrative only and not financial advice. Always verify before acting.
      </p>
    </div>
  );
}

// ── Tab: Goal Tracker ──────────────────────────────────────────────────────────

function GoalTrackerTab({ goals, setGoals, goalForm, setGoalForm, totalValue, portfolioData, userContext, onGoalAdded, userId }: {
  goals:         Goal[];
  setGoals:      Dispatch<SetStateAction<Goal[]>>;
  goalForm:      GoalFormState;
  setGoalForm:   Dispatch<SetStateAction<GoalFormState>>;
  totalValue:    number;
  portfolioData: PortfolioData;
  userContext:   UserContext;
  onGoalAdded:   (goalName: string, amount: number) => void;
  userId:        string;
}) {
  const ai = useArtha();
  const { addUserAction } = useSessionContext();
  const [err, setErr] = useState<Partial<Record<keyof GoalFormState, string>>>({});

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setGoalForm((p) => ({ ...p, [name]: value }));
    setErr((p) => ({ ...p, [name]: undefined }));
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const errs: Partial<Record<keyof GoalFormState, string>> = {};
    if (!goalForm.name.trim())       errs.name = 'Required';
    if (!goalForm.targetAmount || isNaN(Number(goalForm.targetAmount)) || Number(goalForm.targetAmount) <= 0)
      errs.targetAmount = 'Enter a positive number';
    if (!goalForm.targetDate)         errs.targetDate = 'Required';
    if (Object.keys(errs).length > 0) { setErr(errs); return; }
    const name     = goalForm.name.trim();
    const amount   = Number(goalForm.targetAmount);
    const newGoal  = { id: `${Date.now()}`, name, targetAmount: amount, targetDate: goalForm.targetDate };
    setGoals((p) => [...p, newGoal]);
    setGoalForm({ name: '', targetAmount: '', targetDate: '' });
    setErr({});
    addUserAction(`Added goal "${name}" (₹${amount.toLocaleString('en-IN')} by ${goalForm.targetDate})`);
    onGoalAdded(name, amount);
    if (userId) void saveGoal(userId, newGoal);
  }

  const fields: { label: string; name: keyof GoalFormState; placeholder: string; type: string }[] = [
    { label: 'Goal name',        name: 'name',         placeholder: 'e.g. Retirement corpus', type: 'text'   },
    { label: 'Target amount (₹)', name: 'targetAmount', placeholder: '5000000',                type: 'number' },
    { label: 'Target date',       name: 'targetDate',   placeholder: '',                       type: 'date'   },
  ];

  return (
    <div className="flex flex-col gap-5 pb-12">
      {/* Form */}
      <form onSubmit={handleAdd}>
        <Card className="p-5 flex flex-col gap-4">
          <h2 style={{ color: C.text, fontFamily: '"Fraunces", serif' }} className="text-base font-semibold">Set a goal</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {fields.map(({ label, name, placeholder, type }) => (
              <div key={name} className="flex flex-col gap-1">
                <label style={{ color: C.muted }} className="text-xs font-medium tracking-widest uppercase">{label}</label>
                <input
                  name={name} type={type} value={goalForm[name]} onChange={handleChange} placeholder={placeholder}
                  style={{ backgroundColor: C.s2, borderColor: err[name] ? 'rgba(248,113,113,0.5)' : C.border, color: C.text, colorScheme: 'dark' }}
                  className="border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-white/10"
                />
                {name === 'targetAmount' && goalForm.targetAmount && !isNaN(Number(goalForm.targetAmount)) && Number(goalForm.targetAmount) > 0 && (
                  <span style={{ color: C.gold, fontSize: 11 }}>{formatAmount(Number(goalForm.targetAmount))}</span>
                )}
                {err[name] && <span style={{ color: C.red }} className="text-xs">{err[name]}</span>}
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <button type="submit" style={{ backgroundColor: C.gold, color: C.bg }} className="text-sm font-semibold px-5 py-2.5 rounded-lg hover:opacity-90 active:scale-95 transition-all">
              + Add goal
            </button>
          </div>
        </Card>
      </form>

      {/* Goal cards */}
      {goals.length === 0 ? (
        <Empty msg="No goals yet. Define a financial target above." />
      ) : (
        <div className="flex flex-col gap-4">
          {goals.map((goal) => {
            const pct       = totalValue > 0 ? (totalValue / goal.targetAmount) * 100 : 0;
            const capped    = Math.min(pct, 100);
            const achieved  = pct >= 100;
            const barColor  = achieved ? C.green : C.gold;
            return (
              <Card key={goal.id} className="p-5 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p style={{ color: C.text }} className="font-semibold">{goal.name}</p>
                    <p style={{ color: C.muted }} className="text-xs mt-0.5">
                      Target {formatAmount(goal.targetAmount)} · Due {goal.targetDate}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {achieved && <span style={{ color: C.green }} className="text-xs font-medium">✓ Achieved</span>}
                    <button onClick={() => { setGoals((p) => p.filter((g) => g.id !== goal.id)); addUserAction(`Removed goal "${goal.name}"`); if (userId) void deleteGoal(goal.id); }} style={{ color: C.muted }} className="text-lg leading-none transition-colors hover:opacity-60" aria-label="Remove goal">×</button>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div style={{ backgroundColor: C.s2 }} className="h-2.5 rounded-full overflow-hidden">
                    <div style={{ width: `${capped}%`, backgroundColor: barColor, transition: 'width 0.8s ease' }} className="h-full rounded-full" />
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: C.muted }} className="text-xs">Current ₹{fmt(totalValue)}</span>
                    <span style={{ color: barColor }} className="text-xs font-medium">{pct >= 1 ? fmt(pct, 1) : pct > 0 ? pct.toFixed(2) : '0'}% {achieved ? 'reached' : 'of goal'}</span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* AI Goal Coach */}
      <Card className="p-5 flex flex-col gap-4">
        <ArthaPanel
          label="Coach Me"
          onGenerate={() => ai.execute('goal', portfolioData, userContext)}
          loading={ai.loading}
          error={ai.error}
          response={ai.response}
        />
      </Card>
    </div>
  );
}

// ── Dashboard (root) ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate           = useNavigate();
  const location           = useLocation();
  const { user, signOut }  = useAuth();

  // ── Portfolio state ─────────────────────────────────────────────────────────
  const [portfolio,             setPortfolio]             = useState<PortfolioStock[]>([]);
  const [portfolioLoading,      setPortfolioLoading]      = useState(true);
  const [portfolioHealthScore,  setPortfolioHealthScore]  = useState(0);
  const [migrationToast,   setMigrationToast]   = useState<string | null>(null);
  const [goalContext,      setGoalContext]       = useState<GoalContextData | null>(null);
  const migrationRan = useRef(false);

  // Show welcome toast when navigating here after completing onboarding
  useEffect(() => {
    const state = location.state as { welcomeToast?: string } | null;
    if (state?.welcomeToast) {
      setMigrationToast(state.welcomeToast);
      // Clear the state so a refresh doesn't re-show the toast
      navigate(location.pathname, { replace: true, state: {} });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clean + quick-load from localStorage on mount ───────────────────────────
  useEffect(() => {
    const raw = localStorage.getItem('artha_portfolio');
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as unknown;
      const all: PortfolioStock[] = Array.isArray(data)
        ? (data as PortfolioStock[])
        : ((data as { holdings?: PortfolioStock[] })?.holdings ?? []);

      // Remove AI-generated fake holdings (underscores in ticker) and invalid rows
      const clean = all.filter(
        (h) => h.ticker && !h.ticker.includes('_') && h.shares > 0 && h.avgBuyPrice > 0,
      );

      // Persist cleaned version back so Supabase migration also gets clean data
      if (clean.length !== all.length) {
        localStorage.setItem('artha_portfolio', JSON.stringify(clean));
      }

      if (clean.length > 0) {
        setPortfolio(clean);
        setPortfolioLoading(false);
      }
    } catch (e) {
      console.error('Portfolio load error:', e);
    }
  }, []); // runs once on mount

  // Recompute health score from raw portfolio whenever it changes (works without live prices)
  useEffect(() => {
    if (!portfolio.length) return;
    const n     = portfolio.length;
    const total = portfolio.reduce((s, h) => s + (h.avgBuyPrice * h.shares), 0);
    const maxW  = total > 0
      ? Math.max(...portfolio.map((h) => (h.avgBuyPrice * h.shares / total) * 100))
      : 100;
    const profitable = portfolio.filter((h) => (h.pnl ?? 0) > 0).length;
    const score = Math.round(
      Math.min(100, (n / 10) * 100) * 0.35 +
      (maxW > 50 ? 15 : maxW > 35 ? 30 : maxW > 25 ? 55 : 80) * 0.35 +
      (profitable / Math.max(n, 1)) * 100 * 0.30,
    );
    setPortfolioHealthScore(score);
  }, [portfolio]);

  // Load from Supabase on mount, fall back to localStorage, migrate if needed
  useEffect(() => {
    if (migrationRan.current) return;
    migrationRan.current = true;

    async function loadPortfolioData() {
      setPortfolioLoading(true);
      try {
        if (user) {
          // Load goal context + goals from Supabase in parallel
          loadGoalData(user.id).then((ctx) => { if (ctx) setGoalContext(ctx); }).catch(() => {});
          loadGoals(user.id).then((rows: GoalRow[]) => {
            if (rows.length > 0) {
              setGoals(rows.map((r) => ({
                id:           r.id,
                name:         r.name,
                targetAmount: r.target_amount,
                targetDate:   r.target_date,
              })));
            }
          }).catch(() => {});

          // Try Supabase first for portfolio
          const supabaseHoldings = await loadPortfolio(user.id);
          if (supabaseHoldings && supabaseHoldings.length > 0) {
            setPortfolio(supabaseHoldings);
            localStorage.setItem('artha_portfolio', JSON.stringify(supabaseHoldings));
            return;
          }

          // Supabase is empty — check for localStorage data to migrate
          const local = localStorage.getItem('artha_portfolio');
          if (local) {
            const parsed = JSON.parse(local) as PortfolioStock[];
            if (parsed.length > 0) {
              await savePortfolio(user.id, parsed);
              setPortfolio(parsed);
              localStorage.removeItem('artha_portfolio');
              setMigrationToast('Your portfolio has been saved to your account');
              return;
            }
          }
        }

        // No user OR Supabase empty and no local data — load from localStorage as fallback
        const local = localStorage.getItem('artha_portfolio');
        if (local) setPortfolio(JSON.parse(local));
      } catch {
        // Supabase failed — silently fall back to localStorage
        try {
          const local = localStorage.getItem('artha_portfolio');
          if (local) setPortfolio(JSON.parse(local));
        } catch { /* ignore */ }
      } finally {
        setPortfolioLoading(false);
      }
    }

    void loadPortfolioData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── Live price state ────────────────────────────────────────────────────────
  const [livePrices,        setLivePrices]    = useState<Record<string, LivePrice | null>>({});
  const [pricesFetching,    setPricesFetching] = useState(false);
  const [pricesLastFetched, setLastFetched]   = useState<number | null>(null);

  const refreshPrices = useCallback(
    async (holdings: PortfolioStock[]) => {
      if (holdings.length === 0) return;
      clearPriceCache();
      setPricesFetching(true);
      try {
        const prices = await fetchLivePrices(holdings);
        setLivePrices(prices);
        setLastFetched(Date.now());
      } finally {
        setPricesFetching(false);
      }
    },
    [],
  );

  // Auto-fetch live prices whenever portfolio loads — pass full objects so
  // avgBuyPrice reaches the server and unavailable tickers fall back to cost basis.
  useEffect(() => {
    if (portfolio.length === 0) return;
    void fetchLivePrices(portfolio).then((prices) => {
      setLivePrices(prices);
      setLastFetched(Date.now());
    });
  }, [portfolio]);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('portfolio');
  const [goals,     setGoals]     = useState<Goal[]>([]);
  const [goalForm,  setGoalForm]  = useState<GoalFormState>({ name: '', targetAmount: '', targetDate: '' });

  // Seed goals[] from Supabase goalContext when they come in (only if goals is empty)
  useEffect(() => {
    if (!goalContext || goals.length > 0) return;
    const amount = goalContext.goal_amount;
    if (!amount || amount <= 0) return;
    const months = goalContext.horizon_months ?? 84;
    const targetDate = new Date();
    targetDate.setMonth(targetDate.getMonth() + months);
    setGoals([{
      id:           'goal-primary',
      name:         'Main Goal',
      targetAmount: amount,
      targetDate:   targetDate.toISOString().split('T')[0],
    }]);
  }, [goalContext]);

  // ── Daily insight state ──────────────────────────────────────────────────────
  const [dailyInsight,   setDailyInsight]   = useState<string | null>(null);
  const [dailyAction,    setDailyAction]    = useState<string | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const insightFetchedRef = useRef(false);

  // ── Drawer state ─────────────────────────────────────────────────────────────
  const [showEditDrawer, setShowEditDrawer] = useState(false);


  // ── Derived data ────────────────────────────────────────────────────────────
  const { all: enrichedRows, priced: pricedRows } = useMemo(
    () => computeEnrichedRows(portfolio, livePrices),
    [portfolio, livePrices],
  );
  const healthScore = useMemo(() => {
    const hs = computeHealthScore(pricedRows);
    // When prices haven't loaded yet, fall back to the raw-portfolio-based score
    if (hs.total === 0 && portfolioHealthScore > 0) return { ...hs, total: portfolioHealthScore };
    return hs;
  }, [pricedRows, portfolioHealthScore]);

  const handleHealthScore = useCallback((_aiScore: number) => {
    if (!user) return;
    // Score is always the deterministic value — save it on every analysis run
    const score     = healthScore.total;
    const breakdown = {
      diversification: healthScore.diversification,
      concentration:   healthScore.concentration,
      profitability:   healthScore.profitability,
    };
    void saveHealthScore(user.id, score, breakdown, 'ai_analysis');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, healthScore.total, healthScore.diversification, healthScore.concentration, healthScore.profitability]);
  const scenarios   = useMemo(() => computeScenarios(pricedRows),   [pricedRows]);
  const totalValue  = pricedRows.reduce((a, r) => a + r.currentValue, 0);

  const portfolioData = useMemo(
    () => toPortfolioData(pricedRows, healthScore, scenarios),
    [pricedRows, healthScore, scenarios],
  );

  const userContext = useMemo<UserContext>(
    () => ({
      goals: goals.map((g) => ({
        name:         g.name,
        targetAmount: g.targetAmount,
        targetDate:   g.targetDate,
        progress:     totalValue > 0 ? (totalValue / g.targetAmount) * 100 : 0,
      })),
      investmentHorizon:    goalContext?.horizon               ?? '',
      riskLevel:            goalContext?.risk_appetite         ?? '',
      monthlyInvestment:    goalContext?.sip_amount            ?? 0,
      riskAppetite:         goalContext?.risk_appetite         ?? undefined,
      canAffordToLosePct:   goalContext?.can_afford_to_lose_percent ?? undefined,
      investmentExperience: goalContext?.investment_experience ?? undefined,
      monthlyCapital:       goalContext?.monthly_capital_to_invest ?? undefined,
    }),
    [goals, totalValue, goalContext],
  );

  const portfolioSummary = useMemo(() => {
    if (pricedRows.length === 0) return 'No existing portfolio';
    const sorted = [...pricedRows].sort((a, b) => b.weight - a.weight);
    const top    = sorted.slice(0, 6).map((r) => `${r.ticker} (${r.weight.toFixed(0)}%)`).join(', ');
    return pricedRows.length > 6 ? `${top} + ${pricedRows.length - 6} more` : top;
  }, [pricedRows]);

  async function handleSignOut() {
    await signOut();
    navigate('/');
  }

  function handleSettings() {
    navigate('/settings');
  }

  // ── Micro-feedback (post-change AI analysis) ─────────────────────────────────

  const [microFeedback, setMicroFeedback] = useState<{
    changes:       PortfolioChange[];
    previousScore: number;
    currentScore:  number;
    result:        MicroResult | null;
    loading:       boolean;
  } | null>(null);

  // Stable ref to latest portfolioData so triggerMicroAnalysis never closes over stale data
  const portfolioDataRef = useRef(portfolioData);
  useEffect(() => { portfolioDataRef.current = portfolioData; }, [portfolioData]);
  const userContextRef2 = useRef(userContext);
  useEffect(() => { userContextRef2.current = userContext; }, [userContext]);

  // Auto-fetch daily insight — wait until live prices are ready so AI gets real data
  useEffect(() => {
    if (!user || pricedRows.length === 0 || insightFetchedRef.current) return;
    insightFetchedRef.current = true;

    async function fetchInsight() {
      if (!user) return;
      const cached = await loadDailyInsight(user.id);
      const today  = new Date().toISOString().split('T')[0];
      if (cached.text && cached.date === today) {
        setDailyInsight(cached.text);
        setDailyAction(cached.action);
        return;
      }
      setInsightLoading(true);
      try {
        const [storyText, priorityText] = await Promise.all([
          generateAnalysis('story',    portfolioDataRef.current, userContextRef2.current),
          generateAnalysis('priority', portfolioDataRef.current, userContextRef2.current),
        ]);
        const text   = storyText.trim();
        const action = priorityText.trim();
        setDailyInsight(text);
        setDailyAction(action);
        await saveDailyInsight(user.id, text, action);
      } catch { /* silent */ }
      finally { setInsightLoading(false); }
    }

    void fetchInsight();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, pricedRows]);

  async function triggerMicroAnalysis(
    changes:      PortfolioChange[],
    prevTotal:    number,
    prevScore:    number,
    currentScore: number,
  ) {
    if (changes.length === 0) return;
    const micro: MicroContext = {
      changes: changes.map((c) => ({
        type:           c.type,
        stockName:      c.stockName,
        ticker:         c.ticker,
        previousShares: c.previousShares,
        newShares:      c.newShares,
      })),
      previousTotal: prevTotal,
      previousScore: prevScore,
    };
    setMicroFeedback({ changes, previousScore: prevScore, currentScore, result: null, loading: true });
    try {
      const text = await generateAnalysis('micro', portfolioDataRef.current, userContextRef2.current, undefined, micro);
      const result = parseMicroResult(text);
      setMicroFeedback((prev) => prev ? { ...prev, result, loading: false } : null);
    } catch {
      setMicroFeedback((prev) => prev ? {
        ...prev,
        result: { verdict: 'Analysis unavailable — check your connection.', aiScore: null, nextAction: '' },
        loading: false,
      } : null);
    }
  }

  // Trigger 1: detect portfolio changes on return from /import
  const microCheckRan = useRef(false);
  useEffect(() => {
    if (portfolioLoading || portfolio.length === 0 || microCheckRan.current) return;
    microCheckRan.current = true;
    const savedStr = sessionStorage.getItem('artha_baseline');
    if (!savedStr) return;
    sessionStorage.removeItem('artha_baseline');
    try {
      const saved = JSON.parse(savedStr) as { portfolio: PortfolioStock[]; score: number };
      const changes = diffPortfolios(saved.portfolio, portfolio);
      if (changes.length === 0) return;
      const prevTotal = saved.portfolio.reduce((a, s) => {
        const price = livePrices[s.ticker]?.price ?? getMockPrice(s.ticker) ?? s.avgBuyPrice;
        return a + s.shares * price;
      }, 0);
      void triggerMicroAnalysis(changes, prevTotal, saved.score, healthScore.total);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolioLoading, portfolio]);

  // Open the inline edit drawer
  function handleEditPortfolio() {
    setShowEditDrawer(true);
  }

  // Save changes from the inline drawer
  async function handleDrawerSave(newHoldings: PortfolioStock[]) {
    const prevPortfolio = portfolio;
    const prevScore     = healthScore.total;
    const prevTotal     = totalValue;

    setPortfolio(newHoldings);
    localStorage.setItem('artha_portfolio', JSON.stringify(newHoldings));
    if (user) void savePortfolio(user.id, newHoldings);

    const changes = diffPortfolios(prevPortfolio, newHoldings);
    if (changes.length > 0) {
      const { priced: newPriced } = computeEnrichedRows(newHoldings, livePrices);
      const newScore = computeHealthScore(newPriced).total;
      void triggerMicroAnalysis(changes, prevTotal, prevScore, newScore);
    }
  }

  // Trigger 2: sandbox applied to real portfolio
  async function handleApplyToRealPortfolio(newStocks: PortfolioStock[]) {
    const prevPortfolio   = portfolio;
    const prevScore       = healthScore.total;
    const prevTotal       = totalValue;

    // Compute new state
    const { priced: newPriced } = computeEnrichedRows(newStocks, livePrices);
    const newScore              = computeHealthScore(newPriced).total;
    const newTotal              = newPriced.reduce((a, r) => a + r.currentValue, 0);

    // Persist
    setPortfolio(newStocks);
    localStorage.setItem('artha_portfolio', JSON.stringify(newStocks));
    if (user) void savePortfolio(user.id, newStocks);

    const changes = diffPortfolios(prevPortfolio, newStocks);
    if (changes.length > 0) {
      void triggerMicroAnalysis(changes, prevTotal > 0 ? prevTotal : newTotal, prevScore, newScore);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <SessionContextProvider>
    <div style={{ backgroundColor: C.bg, color: C.text }} className="min-h-screen w-full flex flex-col">
      <StickyNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        healthScore={healthScore.total}
        onEditPortfolio={handleEditPortfolio}
        onSettings={handleSettings}
        user={user}
        onSignOut={handleSignOut}
      />

      {/* Proactive mover alert */}
      {!portfolioLoading && (
        <ProactiveAlert pricedRows={pricedRows} onHealthTab={() => setActiveTab('analyse')} />
      )}

      {portfolioLoading ? (
        <div className="w-full max-w-[1100px] mx-auto px-4 py-6">
          <LoadingSkeleton />
        </div>
      ) : (
        <main className="w-full max-w-[1100px] mx-auto px-4 py-6">
          {activeTab === 'portfolio' && (
            <PortfolioTab
              enrichedRows={enrichedRows}
              pricedRows={pricedRows}
              pricesFetching={pricesFetching}
              pricesLastFetched={pricesLastFetched}
              onRefreshPrices={() => refreshPrices(portfolio)}
              portfolio={portfolio}
              portfolioData={portfolioData}
              userContext={userContext}
              healthScore={healthScore.total}
              dailyInsight={dailyInsight}
              dailyAction={dailyAction}
              insightLoading={insightLoading}
              onEditPortfolio={() => setShowEditDrawer(true)}
            />
          )}
          {activeTab === 'analyse' && (
            <AnalyseTab
              healthScore={healthScore}
              pricedRows={pricedRows}
              portfolioData={portfolioData}
              userContext={userContext}
              onHealthScore={handleHealthScore}
              portfolio={portfolio}
              livePrices={livePrices}
              onApplyToRealPortfolio={handleApplyToRealPortfolio}
              userId={user?.id ?? ''}
            />
          )}
          {activeTab === 'plan' && (
            <PlanTab
              goals={goals} setGoals={setGoals}
              goalForm={goalForm} setGoalForm={setGoalForm}
              totalValue={totalValue}
              portfolioData={portfolioData}
              userContext={userContext}
              onGoalAdded={(goalName, amount) => {
                void triggerMicroAnalysis(
                  [{ type: 'goal_set', stockName: `${goalName} (${formatAmount(amount)})`, ticker: 'GOAL' }],
                  totalValue, healthScore.total, healthScore.total,
                );
              }}
              userId={user?.id ?? ''}
              portfolioSummary={portfolioSummary}
            />
          )}
        </main>
      )}

      {/* Migration toast */}
      {migrationToast && (
        <Toast
          message={migrationToast}
          onDismiss={() => setMigrationToast(null)}
        />
      )}

      {/* Micro-feedback toast */}
      {microFeedback && (
        <MicroFeedbackToast
          previousScore={microFeedback.previousScore}
          currentScore={microFeedback.currentScore}
          changes={microFeedback.changes}
          result={microFeedback.result}
          onDismiss={() => setMicroFeedback(null)}
        />
      )}

      {/* One Thing Bar — fixed bottom priority strip */}
      {!portfolioLoading && portfolioData.holdings.length > 0 && (
        <OneThingBar portfolioData={portfolioData} userContext={userContext} />
      )}

      {/* Inline edit portfolio drawer */}
      <EditPortfolioDrawer
        open={showEditDrawer}
        portfolio={portfolio}
        onSave={handleDrawerSave}
        onClose={() => setShowEditDrawer(false)}
      />
    </div>
    </SessionContextProvider>
  );
}
