import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { marked } from 'marked';
import { getMockPrice } from '../lib/mockPrices';
import type { PortfolioStock } from './PortfolioEntry';
import type { LivePrice } from '../lib/prices';
import type { UserContext } from '../lib/gemini';
import { useSessionContext } from '../lib/sessionContext';

marked.use({ breaks: true, gfm: true } as Parameters<typeof marked.use>[0]);

// ── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  bg:     '#0a0a0b',
  s1:     '#111113',
  s2:     '#18181b',
  gold:   '#d4a843',
  text:   '#f0efe8',
  muted:  '#9b9a94',
  subtle: '#5a5955',
  border: '#2a2a2f',
  green:  '#4ead84',
  red:    '#e05252',
  amber:  '#f59e0b',
} as const;

// ── Scenarios ─────────────────────────────────────────────────────────────────

type ScenarioId = 'bull-run' | 'rbi-rate-hike' | 'sector-crash' | 'recession' | 'commodity-surge' | 'budget-shock';

interface Scenario {
  id:         ScenarioId;
  icon:       string;
  name:       string;
  desc:       string;
  badge:      string;
  badgeColor: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'bull-run',        icon: '📈', name: 'Bull Run',        desc: 'Nifty rallies 20–30%',             badge: 'Bullish',   badgeColor: C.green },
  { id: 'rbi-rate-hike',   icon: '🏦', name: 'RBI Rate Hike',   desc: 'Rates up 100–150bps',              badge: 'Bearish',   badgeColor: C.red   },
  { id: 'sector-crash',    icon: '⚡', name: 'Sector Crash',    desc: 'Coal/PSU stocks fall 40%',         badge: 'High Risk', badgeColor: C.red   },
  { id: 'recession',       icon: '🌧', name: 'Recession',       desc: 'GDP slows to 4–5%',                badge: 'Cautious',  badgeColor: C.amber },
  { id: 'commodity-surge', icon: '🪙', name: 'Commodity Surge', desc: 'Silver, metals up 30%',            badge: 'Bullish',   badgeColor: C.green },
  { id: 'budget-shock',    icon: '🗳', name: 'Budget Shock',    desc: 'Pro-renewables, anti-coal policy', badge: 'Mixed',     badgeColor: C.amber },
];

// ── Sector map (heuristic approximation) ─────────────────────────────────────

const SECTOR_MAP: Record<string, string> = {
  HDFCBANK: 'Banking', ICICIBANK: 'Banking', SBIN: 'Banking', KOTAKBANK: 'Banking', AXISBANK: 'Banking', INDUSINDBK: 'Banking',
  RELIANCE: 'Energy',  ONGC: 'Energy',       BPCL: 'Energy',  IOC: 'Energy',
  COALINDIA: 'Coal',
  NTPC: 'Power',       POWERGRID: 'Power',   TATAPOWER: 'Power',
  TCS: 'IT',           INFY: 'IT',           WIPRO: 'IT',     HCLTECH: 'IT',        TECHM: 'IT',        LTI: 'IT',
  HINDUNILVR: 'FMCG',  ITC: 'FMCG',         NESTLEIND: 'FMCG', BRITANNIA: 'FMCG', DABUR: 'FMCG',
  SUNPHARMA: 'Pharma', DRREDDY: 'Pharma',   CIPLA: 'Pharma', DIVISLAB: 'Pharma',
  GOLDETF: 'Gold',     SILVERIETF: 'Silver', NIFTYBEES: 'Index', JUNIORBEES: 'Index', BANKBEES: 'Index',
  TATASTEEL: 'Metals', HINDALCO: 'Metals',  JSWSTEEL: 'Metals', SAIL: 'Metals',
  MARUTI: 'Auto',      TATAMOTORS: 'Auto',  M_M: 'Auto',      BAJAJ_AUTO: 'Auto',
  ADANIGREEN: 'Renewables', TORNTPOWER: 'Renewables',
};

function getSectors(holdings: SandboxHolding[]): number {
  const sectors = new Set(holdings.map((h) => SECTOR_MAP[h.ticker.toUpperCase()] ?? 'Other'));
  return sectors.size;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SandboxHolding {
  id:           string;
  name:         string;
  ticker:       string;
  shares:       number;
  avgBuyPrice:  number;
  currentPrice: number;
}

interface EnrichedHolding extends SandboxHolding {
  currentValue: number;
  invested:     number;
  pnl:          number;
  pnlPct:       number;
  weight:       number;
}

interface ComparisonData {
  current: { score: number; projectedImpact: string; goalStatus: string };
  sandbox: { score: number; projectedImpact: string; goalStatus: string };
  verdict: string;
}

interface AnalysisState {
  loading:    boolean;
  text:       string | null;
  rawText:    string | null;
  comparison: ComparisonData | null;
  error:      string | null;
}

interface Props {
  portfolio:                PortfolioStock[];
  livePrices:               Record<string, LivePrice | null>;
  userContext:              UserContext;
  onApplyToRealPortfolio?:  (stocks: PortfolioStock[]) => void;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background:  C.s2,
  border:      `1px solid ${C.border}`,
  borderRadius: 7,
  color:        C.text,
  fontSize:     12,
  padding:      '6px 10px',
  outline:      'none',
  width:        130,
  fontFamily:  '"DM Sans", system-ui, sans-serif',
};

const pillStyle: React.CSSProperties = {
  background:   'none',
  border:       `1px solid ${C.border}`,
  borderRadius: 99,
  color:        C.muted,
  fontSize:     12,
  padding:      '5px 14px',
  cursor:       'pointer',
  fontFamily:  '"DM Sans", system-ui, sans-serif',
  transition:   'border-color 0.15s, color 0.15s',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function initSandbox(
  portfolio:  PortfolioStock[],
  livePrices: Record<string, LivePrice | null>,
): SandboxHolding[] {
  return portfolio.map((s) => ({
    id:           s.id,
    name:         s.name,
    ticker:       s.ticker,
    shares:       s.shares,
    avgBuyPrice:  s.avgBuyPrice,
    currentPrice: livePrices[s.ticker.toUpperCase()]?.price ?? getMockPrice(s.ticker) ?? s.avgBuyPrice,
  }));
}

function computeEnriched(holdings: SandboxHolding[]): EnrichedHolding[] {
  const total = holdings.reduce((a, h) => a + h.shares * h.currentPrice, 0);
  return holdings.map((h) => {
    const currentValue = h.shares * h.currentPrice;
    const invested     = h.shares * h.avgBuyPrice;
    const pnl          = currentValue - invested;
    const pnlPct       = invested > 0 ? (pnl / invested) * 100 : 0;
    const weight       = total > 0 ? (currentValue / total) * 100 : 0;
    return { ...h, currentValue, invested, pnl, pnlPct, weight };
  });
}

function parseAnalysis(text: string): { comparison: ComparisonData | null; narrative: string } {
  const lines = text.split('\n');
  let comparison: ComparisonData | null = null;
  let narrativeStart = 0;

  for (let i = 0; i < Math.min(6, lines.length); i++) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        comparison    = JSON.parse(line) as ComparisonData;
        narrativeStart = i + 1;
        break;
      } catch { /* continue */ }
    }
  }

  const narrative = lines.slice(narrativeStart).join('\n').trim();
  return { comparison, narrative };
}


// ── useDebounce hook ──────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Score comparison bar ──────────────────────────────────────────────────────

function ScoreBar({ current, sandbox }: { current: number; sandbox: number }) {
  const diff  = sandbox - current;
  const color = diff > 2 ? C.green : diff < -2 ? C.red : C.amber;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: C.subtle, width: 60, flexShrink: 0 }}>Current</span>
        <div style={{ flex: 1, background: C.bg, borderRadius: 99, height: 6, overflow: 'hidden' }}>
          <div style={{ width: `${current}%`, height: '100%', background: C.muted, borderRadius: 99, transition: 'width 0.6s' }} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.muted, width: 28, textAlign: 'right', flexShrink: 0 }}>{current}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: C.gold, width: 60, flexShrink: 0 }}>Sandbox</span>
        <div style={{ flex: 1, background: C.bg, borderRadius: 99, height: 6, overflow: 'hidden' }}>
          <div style={{ width: `${sandbox}%`, height: '100%', background: color, borderRadius: 99, transition: 'width 0.6s' }} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color, width: 28, textAlign: 'right', flexShrink: 0 }}>{sandbox}</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ScenarioSimulator({ portfolio, livePrices, userContext, onApplyToRealPortfolio }: Props) {
  const { updateScenario, addUserAction } = useSessionContext();
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>('bull-run');
  const [sandbox,          setSandbox]           = useState<SandboxHolding[]>(() => initSandbox(portfolio, livePrices));
  const [analysis,         setAnalysis]          = useState<AnalysisState>({ loading: false, text: null, rawText: null, comparison: null, error: null });
  const [editingId,        setEditingId]         = useState<string | null>(null);
  const [editingVal,       setEditingVal]        = useState('');
  const [addForm,          setAddForm]           = useState({ name: '', ticker: '', shares: '', avgPrice: '' });
  const [showAddForm,      setShowAddForm]       = useState(false);
  const [applyStatus,      setApplyStatus]       = useState<string | null>(null);
  const [scenarioExpanded, setScenarioExpanded]  = useState(false);
  const [scenarioSummary,  setScenarioSummary]   = useState<string | null>(null);
  const [summaryLoading,   setSummaryLoading]    = useState(false);

  const abortRef           = useRef<AbortController | null>(null);
  const activeScenarioRef  = useRef(activeScenarioId);
  const sandboxRef         = useRef(sandbox);
  const portfolioRef       = useRef(portfolio);
  const livePricesRef      = useRef(livePrices);
  const userContextRef     = useRef(userContext);
  const sandboxInitialized = useRef(false);

  useEffect(() => { activeScenarioRef.current = activeScenarioId; }, [activeScenarioId]);
  useEffect(() => { sandboxRef.current = sandbox; }, [sandbox]);
  useEffect(() => { portfolioRef.current = portfolio; }, [portfolio]);
  useEffect(() => { livePricesRef.current = livePrices; }, [livePrices]);
  useEffect(() => { userContextRef.current = userContext; }, [userContext]);

  const debouncedSandbox = useDebounce(sandbox, 1500);

  // ── runAnalysis ─────────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async () => {
    const scenario       = SCENARIOS.find((s) => s.id === activeScenarioRef.current)!;
    const currentSandbox = sandboxRef.current;
    const ctx            = userContextRef.current;
    if (currentSandbox.length === 0) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    setAnalysis((prev) => ({ ...prev, loading: true, error: null }));
    setScenarioExpanded(false);
    setScenarioSummary(null);
    setSummaryLoading(false);

    try {
      const sandboxEnriched  = computeEnriched(currentSandbox);
      computeEnriched(initSandbox(portfolioRef.current, livePricesRef.current));

      const totalInvested = sandboxEnriched.reduce((a, h) => a + h.invested, 0);
      const totalVal      = sandboxEnriched.reduce((a, h) => a + h.currentValue, 0);
      const totalPnl      = totalVal - totalInvested;
      const portfolioData = {
        holdings: sandboxEnriched.map((h) => ({
          name: h.name, ticker: h.ticker, shares: h.shares, avgBuyPrice: h.avgBuyPrice,
          currentPrice: h.currentPrice, invested: h.invested, currentValue: h.currentValue,
          pnl: h.pnl, pnlPct: h.pnlPct, weight: h.weight, changePercent: null,
        })),
        totalInvested,
        totalValue:          totalVal,
        totalPnl,
        totalPnlPct:         totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
        healthScore:         0,
        diversificationScore: 0,
        concentrationScore:  0,
        profitabilityScore:  0,
        scenarios: { bull: totalVal * 1.2, base: totalVal, bear: totalVal * 0.8 },
      };

      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type:                'scenario',
          portfolioData,
          userContext:         ctx,
          scenarioName:        scenario.name,
          scenarioDescription: scenario.desc,
        }),
        signal,
      });
      if (signal.aborted) return;

      const data = await res.json() as { text?: string; error?: string };
      if (signal.aborted) return;

      if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`);

      const { comparison, narrative } = parseAnalysis(data.text ?? '');
      const analysisText = narrative || (data.text ?? '');
      setAnalysis({ loading: false, text: analysisText, rawText: data.text ?? null, comparison, error: null });
      updateScenario(activeScenarioRef.current, data.text ?? '');

      // Reset expand state and fetch 2-sentence summary
      setScenarioExpanded(false);
      setScenarioSummary(null);
      setSummaryLoading(true);
      try {
        const summaryRes = await fetch('/api/analyze', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'priority',
            portfolioData,
            userContext: {
              ...ctx,
              customPrompt: `From this scenario analysis, write exactly 2 sentences summarising: 1) the estimated portfolio impact in ₹ and %, 2) the single most important action. Be direct. Use actual numbers.\n\nAnalysis: ${analysisText}`,
            },
          }),
          signal,
        });
        if (!signal.aborted && summaryRes.ok) {
          const summaryData = await summaryRes.json() as { text?: string };
          if (!signal.aborted) setScenarioSummary(summaryData.text ?? null);
        }
      } catch { /* summary is best-effort — ignore errors */ }
      finally { setSummaryLoading(false); }
    } catch (err) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : 'Analysis failed';
      setAnalysis((prev) => ({ ...prev, loading: false, error: msg }));
    }
  }, [updateScenario]); // updateScenario is stable (useCallback with no deps)

  // Scenario change → immediate
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void runAnalysis(); }, [activeScenarioId]);

  // Sandbox change → debounced (skip initial mount)
  useEffect(() => {
    if (!sandboxInitialized.current) { sandboxInitialized.current = true; return; }
    void runAnalysis();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSandbox]);

  // ── Sandbox actions ─────────────────────────────────────────────────────────

  function removeHolding(id: string) {
    setSandbox((prev) => prev.filter((h) => h.id !== id));
  }

  function commitEdit(id: string) {
    const val = parseFloat(editingVal);
    if (!isNaN(val) && val > 0) {
      setSandbox((prev) => prev.map((h) => h.id === id ? { ...h, shares: val } : h));
    }
    setEditingId(null);
    setEditingVal('');
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const ticker   = addForm.ticker.trim().toUpperCase();
    const shares   = parseFloat(addForm.shares);
    const avgPrice = parseFloat(addForm.avgPrice);
    if (!ticker || isNaN(shares) || isNaN(avgPrice) || shares <= 0 || avgPrice <= 0) return;

    const price = livePrices[ticker]?.price ?? getMockPrice(ticker) ?? avgPrice;
    setSandbox((prev) => [...prev, {
      id:           `manual-${ticker}-${Date.now()}`,
      name:         addForm.name.trim() || ticker,
      ticker,
      shares,
      avgBuyPrice:  avgPrice,
      currentPrice: price,
    }]);
    setAddForm({ name: '', ticker: '', shares: '', avgPrice: '' });
    setShowAddForm(false);
  }

  function equalWeight() {
    setSandbox((prev) => {
      const total = prev.reduce((a, h) => a + h.shares * h.currentPrice, 0);
      const targetValue = total / prev.length;
      return prev.map((h) => ({ ...h, shares: Math.max(1, Math.round(targetValue / h.currentPrice)) }));
    });
  }

  function removeLosers() {
    setSandbox((prev) => prev.filter((h) => h.currentPrice >= h.avgBuyPrice));
  }

  function resetToOriginal() {
    setSandbox(initSandbox(portfolioRef.current, livePricesRef.current));
  }

  async function handleApplyRecommendations() {
    if (!analysis.text) return;
    setApplyStatus('Extracting actions…');
    try {
      const rawQuery = `From this scenario analysis, extract the specific portfolio changes suggested. Return ONLY a JSON array with no other text:
[{"action":"reduce"|"remove"|"add","ticker":"NSE_TICKER","reason":"one sentence"}]

Analysis text:
${analysis.text}`;

      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type:          'micro',
          portfolioData: {
            holdings: sandbox.map((h) => ({
              name: h.name, ticker: h.ticker, shares: h.shares, avgBuyPrice: h.avgBuyPrice,
              currentPrice: h.currentPrice, invested: h.shares * h.avgBuyPrice,
              currentValue: h.shares * h.currentPrice, pnl: 0, pnlPct: 0, weight: 0, changePercent: null,
            })),
            totalInvested: 0, totalValue: 0, totalPnl: 0, totalPnlPct: 0,
            healthScore: 0, diversificationScore: 0, concentrationScore: 0, profitabilityScore: 0,
            scenarios: { bull: 0, base: 0, bear: 0 },
          },
          userContext: { goals: [], investmentHorizon: '', riskLevel: '', monthlyInvestment: 0 },
          rawQuery,
        }),
      });

      const data = await res.json() as { text?: string };
      const text = data.text ?? '';
      const jsonMatch = text.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const actions = JSON.parse(jsonMatch[0]) as Array<{ action: 'reduce' | 'remove' | 'add'; ticker: string; reason: string }>;
      if (!Array.isArray(actions) || actions.length === 0) {
        setApplyStatus('No actions found. Try again.');
        setTimeout(() => setApplyStatus(null), 3000);
        return;
      }

      setSandbox((prev) => {
        let updated = [...prev];
        for (const act of actions) {
          if (act.action === 'remove') {
            updated = updated.filter((h) => h.ticker !== act.ticker);
          } else if (act.action === 'reduce') {
            updated = updated.map((h) => h.ticker === act.ticker
              ? { ...h, shares: Math.max(1, Math.round(h.shares * 0.5)) }
              : h);
          } else if (act.action === 'add' && !updated.find((h) => h.ticker === act.ticker)) {
            const price = getMockPrice(act.ticker) ?? 100;
            updated.push({
              id:           `ai-${act.ticker}-${Date.now()}`,
              name:         act.ticker,
              ticker:       act.ticker,
              shares:       0,
              avgBuyPrice:  price,
              currentPrice: price,
            });
          }
        }
        return updated;
      });

      setApplyStatus(`Applied ${actions.length} change${actions.length !== 1 ? 's' : ''} to sandbox`);
      addUserAction(`Applied AI recommendations in scenario simulator (${actions.length} changes)`);
      setTimeout(() => setApplyStatus(null), 4000);
    } catch (e) {
      console.error('Apply recommendations error:', e);
      setApplyStatus('Could not extract actions. Try again.');
      setTimeout(() => setApplyStatus(null), 3000);
    }
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  const enriched     = useMemo(() => computeEnriched(sandbox), [sandbox]);
  const totalValue   = useMemo(() => enriched.reduce((a, h) => a + h.currentValue, 0), [enriched]);
  const largestWeight = useMemo(() => (enriched.length > 0 ? Math.max(...enriched.map((h) => h.weight)) : 0), [enriched]);
  const sectorCount  = useMemo(() => getSectors(sandbox), [sandbox]);
  const activeScenario = SCENARIOS.find((s) => s.id === activeScenarioId)!;

  const isSandboxModified = useMemo(() => {
    const orig = initSandbox(portfolio, livePrices);
    if (orig.length !== sandbox.length) return true;
    const origById = new Map(orig.map((h) => [h.id, h]));
    return sandbox.some((h) => { const o = origById.get(h.id); return !o || o.shares !== h.shares; });
  }, [sandbox, portfolio, livePrices]);
  const goal           = userContext.goals[0];
  const goalProgress   = goal ? Math.min(100, (totalValue / goal.targetAmount) * 100) : 0;

  // ── Empty state ─────────────────────────────────────────────────────────────

  if (portfolio.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 400, gap: 12 }}>
        <span style={{ color: C.border, fontSize: 48 }}>◇</span>
        <p style={{ color: C.muted, fontSize: 13 }}>Add holdings to use the scenario simulator.</p>
      </div>
    );
  }

  // ── Comparison verdict banner ───────────────────────────────────────────────

  const compDiff = analysis.comparison
    ? analysis.comparison.sandbox.score - analysis.comparison.current.score
    : null;
  const bannerBg     = !isSandboxModified ? 'rgba(90,89,85,0.08)' : compDiff === null ? 'transparent' : compDiff > 2 ? 'rgba(78,173,132,0.08)' : compDiff < -2 ? 'rgba(224,82,82,0.08)' : 'rgba(245,158,11,0.08)';
  const bannerBorder = !isSandboxModified ? C.subtle : compDiff === null ? C.border : compDiff > 2 ? C.green : compDiff < -2 ? C.red : C.amber;
  const bannerMsg    = !isSandboxModified
    ? 'Make changes to the sandbox to see the difference'
    : compDiff === null ? '' : compDiff > 2
    ? `Your changes improve resilience by ${compDiff} points`
    : compDiff < -2
    ? `Your changes make things worse. See recommendations below.`
    : `No meaningful difference between versions`;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .sim-layout { display: flex; flex: 1; }
        .sim-left   { width: 280px; flex-shrink: 0; border-right: 1px solid ${C.border}; }
        .sim-right  { width: 320px; flex-shrink: 0; border-left: 1px solid ${C.border}; }
        .sim-mid    { flex: 1; min-width: 0; }
        @media (max-width: 768px) {
          .sim-layout { flex-direction: column; }
          .sim-left   { width: 100%; border-right: none; border-bottom: 1px solid ${C.border}; }
          .sim-right  { width: 100%; border-left: none; border-top: 1px solid ${C.border}; }
          .scenario-list { flex-direction: row !important; overflow-x: auto; flex-wrap: nowrap !important; padding-bottom: 4px; }
          .scenario-list::-webkit-scrollbar { display: none; }
        }
        .scenario-btn:hover { border-color: ${C.border + 'a0'} !important; }
        .sandbox-row:hover  { background: ${C.s2}; }
        .sim-add-input:focus { border-color: ${C.gold} !important; }
        .pill-btn:hover { color: ${C.text} !important; border-color: ${C.border + 'ff'} !important; }
      `}</style>

      <div className="sim-layout" style={{ minHeight: '78vh' }}>

        {/* ═══════════════════════════════════════════════════════════════════
            LEFT — Scenario picker + goal context
        ══════════════════════════════════════════════════════════════════════ */}
        <div
          className="sim-left"
          style={{ overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          {/* Section label */}
          <div>
            <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.subtle, marginBottom: 10 }}>
              Pick a scenario
            </p>
            <div className="scenario-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SCENARIOS.map((sc) => {
                const active = sc.id === activeScenarioId;
                return (
                  <button
                    key={sc.id}
                    className="scenario-btn"
                    onClick={() => setActiveScenarioId(sc.id)}
                    style={{
                      background:   active ? '#1a1508' : C.s1,
                      border:       `1px solid ${active ? C.gold : C.border}`,
                      borderRadius: 10,
                      padding:      '11px 13px',
                      cursor:       'pointer',
                      textAlign:    'left',
                      transition:   'border-color 0.15s, background 0.15s',
                      flexShrink:   0,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: active ? C.text : C.muted, fontWeight: active ? 500 : 400 }}>
                        {sc.icon} {sc.name}
                      </span>
                      <span style={{
                        fontSize: 9, fontWeight: 600, letterSpacing: '0.05em',
                        color: sc.badgeColor, background: `${sc.badgeColor}1a`,
                        padding: '2px 7px', borderRadius: 99, flexShrink: 0,
                      }}>
                        {sc.badge}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, color: C.subtle, display: 'block', marginTop: 3 }}>{sc.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: C.border }} />

          {/* Goal context */}
          <div>
            <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.subtle, marginBottom: 10 }}>
              Your goal
            </p>
            <div style={{
              background: C.s2, border: `1px solid ${C.border}`, borderRadius: 10,
              padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 7,
            }}>
              {goal ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.subtle, fontSize: 11 }}>Target</span>
                    <span style={{ color: C.text, fontSize: 12, fontWeight: 500 }}>₹{fmt(goal.targetAmount, 0)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: C.subtle, fontSize: 11 }}>By</span>
                    <span style={{ color: C.text, fontSize: 12 }}>{goal.targetDate}</span>
                  </div>
                  {userContext.monthlyInvestment > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: C.subtle, fontSize: 11 }}>Monthly SIP</span>
                      <span style={{ color: C.text, fontSize: 12 }}>₹{fmt(userContext.monthlyInvestment, 0)}</span>
                    </div>
                  )}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ fontSize: 10, color: C.subtle }}>Progress</span>
                      <span style={{ fontSize: 10, color: C.muted }}>{goalProgress.toFixed(1)}%</span>
                    </div>
                    <div style={{ background: C.bg, borderRadius: 99, height: 5, overflow: 'hidden' }}>
                      <div style={{
                        width:      `${Math.min(100, goalProgress)}%`,
                        height:     '100%',
                        background: goalProgress >= 100 ? C.green : C.gold,
                        borderRadius: 99,
                        transition: 'width 0.6s ease',
                      }} />
                    </div>
                  </div>
                </>
              ) : (
                <p style={{ color: C.subtle, fontSize: 11 }}>No goal set. Add one in the Goal Tracker tab.</p>
              )}
            </div>
            <p style={{ color: C.subtle, fontSize: 11, lineHeight: 1.7, marginTop: 10 }}>
              The simulator recommends changes that improve your odds of hitting{' '}
              {goal ? `₹${fmt(goal.targetAmount, 0)}` : 'your goal'} — not just surviving the scenario.
            </p>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            MIDDLE — Sandbox portfolio editor
        ══════════════════════════════════════════════════════════════════════ */}
        <div
          className="sim-mid"
          style={{ overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          {/* Header */}
          <div>
            <h2 style={{ fontFamily: '"Fraunces", serif', fontSize: 18, fontWeight: 300, color: C.text, marginBottom: 4 }}>
              Your sandbox portfolio
            </h2>
            <p style={{ color: C.subtle, fontSize: 12 }}>Make changes here. Nothing affects your real portfolio.</p>
          </div>

          {/* Table */}
          <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {['Stock', 'Ticker', 'Shares', 'Avg ₹', 'Current ₹', 'Weight', ''].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left', padding: '9px 13px',
                          fontSize: 10, fontWeight: 500, letterSpacing: '0.10em',
                          textTransform: 'uppercase', color: C.subtle,
                          fontFamily: '"DM Sans", system-ui, sans-serif',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((row) => {
                    const isEditing  = editingId === row.id;
                    const pnlColor   = row.pnl >= 0 ? C.green : C.red;
                    return (
                      <tr key={row.id} className="sandbox-row" style={{ borderBottom: `1px solid ${C.border}`, transition: 'background 0.1s' }}>
                        <td style={{ padding: '9px 13px', color: C.text, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row.name}
                        </td>
                        <td style={{ padding: '9px 13px', color: C.muted, fontFamily: 'monospace', fontSize: 11 }}>
                          {row.ticker}
                        </td>
                        <td style={{ padding: '9px 13px' }}>
                          {isEditing ? (
                            <input
                              type="number"
                              value={editingVal}
                              onChange={(e) => setEditingVal(e.target.value)}
                              onBlur={() => commitEdit(row.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter')  commitEdit(row.id);
                                if (e.key === 'Escape') { setEditingId(null); setEditingVal(''); }
                              }}
                              autoFocus
                              style={{
                                background: C.s2, border: `1px solid ${C.gold}`,
                                borderRadius: 6, color: C.text, fontSize: 12,
                                padding: '3px 8px', width: 72, outline: 'none',
                              }}
                            />
                          ) : (
                            <span
                              onClick={() => { setEditingId(row.id); setEditingVal(String(row.shares)); }}
                              title="Click to edit"
                              style={{
                                color: C.text, cursor: 'text',
                                borderBottom: `1px dashed ${C.border}`, paddingBottom: 1,
                              }}
                            >
                              {row.shares}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '9px 13px', color: C.muted }}>₹{fmt(row.avgBuyPrice, 0)}</td>
                        <td style={{ padding: '9px 13px' }}>
                          <span style={{ color: C.text }}>₹{fmt(row.currentPrice, 0)}</span>
                          <span style={{ color: pnlColor, fontSize: 10, marginLeft: 5 }}>
                            {row.pnlPct >= 0 ? '+' : ''}{row.pnlPct.toFixed(1)}%
                          </span>
                        </td>
                        <td style={{ padding: '9px 13px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ background: C.s2, borderRadius: 99, height: 5, width: 52, overflow: 'hidden' }}>
                              <div style={{
                                width:        `${Math.min(100, row.weight)}%`,
                                height:       '100%',
                                background:   C.gold,
                                borderRadius: 99,
                                transition:   'width 0.3s',
                              }} />
                            </div>
                            <span style={{ color: C.muted, fontSize: 10 }}>{row.weight.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={{ padding: '9px 13px' }}>
                          <button
                            onClick={() => removeHolding(row.id)}
                            title="Remove from sandbox"
                            style={{
                              color: C.subtle, background: 'none', border: 'none',
                              cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px',
                              transition: 'color 0.12s',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = C.red)}
                            onMouseLeave={(e) => (e.currentTarget.style.color = C.subtle)}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {enriched.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        style={{ padding: '24px', textAlign: 'center', color: C.subtle, fontSize: 12, fontStyle: 'italic' }}
                      >
                        Sandbox is empty — reset to original or add a stock below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Add stock row */}
            <div style={{ borderTop: `1px solid ${C.border}`, padding: '11px 13px' }}>
              {!showAddForm ? (
                <button
                  onClick={() => setShowAddForm(true)}
                  style={{ color: C.gold, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}
                >
                  + Add a stock to test
                </button>
              ) : (
                <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    placeholder="Stock name"
                    value={addForm.name}
                    onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                    className="sim-add-input"
                    style={inputStyle}
                  />
                  <input
                    placeholder="TICKER"
                    value={addForm.ticker}
                    onChange={(e) => setAddForm((f) => ({ ...f, ticker: e.target.value.toUpperCase() }))}
                    className="sim-add-input"
                    style={{ ...inputStyle, width: 86, fontFamily: 'monospace', textTransform: 'uppercase' }}
                  />
                  <input
                    placeholder="Shares"
                    value={addForm.shares}
                    onChange={(e) => setAddForm((f) => ({ ...f, shares: e.target.value }))}
                    type="number" min="1"
                    className="sim-add-input"
                    style={{ ...inputStyle, width: 76 }}
                  />
                  <input
                    placeholder="Avg price ₹"
                    value={addForm.avgPrice}
                    onChange={(e) => setAddForm((f) => ({ ...f, avgPrice: e.target.value }))}
                    type="number" min="0.01" step="0.01"
                    className="sim-add-input"
                    style={{ ...inputStyle, width: 106 }}
                  />
                  <button
                    type="submit"
                    style={{
                      background: C.gold, color: '#0a0a0b', border: 'none',
                      borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddForm(false); setAddForm({ name: '', ticker: '', shares: '', avgPrice: '' }); }}
                    style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 12 }}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
          </div>

          {/* Quick rebalance pills */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="pill-btn" onClick={equalWeight}     style={pillStyle}>Equal weight</button>
            <button className="pill-btn" onClick={removeLosers}    style={pillStyle}>Remove losers</button>
            <button
              className="pill-btn"
              onClick={resetToOriginal}
              style={{ ...pillStyle, color: C.gold, borderColor: `${C.gold}50` }}
            >
              ↺ Reset to original
            </button>
          </div>

          {/* Live stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {[
              { label: 'Total Value',      value: `₹${fmt(totalValue, 0)}` },
              { label: 'Holdings',         value: String(sandbox.length)   },
              { label: 'Largest Position', value: `${largestWeight.toFixed(1)}%` },
              { label: 'Sectors',          value: String(sectorCount)      },
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  background:    C.s1,
                  border:        `1px solid ${C.border}`,
                  borderRadius:  10,
                  padding:       '10px 12px',
                  display:       'flex',
                  flexDirection: 'column',
                  gap:           3,
                }}
              >
                <span style={{
                  fontSize: 9, fontWeight: 500, letterSpacing: '0.10em',
                  textTransform: 'uppercase', color: C.subtle,
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                }}>
                  {stat.label}
                </span>
                <span style={{ color: C.text, fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 17 }}>
                  {stat.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════
            RIGHT — AI Analysis panel
        ══════════════════════════════════════════════════════════════════════ */}
        <div
          className="sim-right"
          style={{ overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {/* Header */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h2 style={{ fontFamily: '"Fraunces", serif', fontSize: 16, fontWeight: 300, color: C.text }}>
                Scenario Analysis
              </h2>
              {analysis.loading && (
                <span style={{
                  display: 'inline-block', width: 14, height: 14, flexShrink: 0,
                  border: `2px solid ${C.border}`, borderTopColor: C.gold,
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite',
                }} />
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: C.muted }}>Analysing:</span>
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: activeScenario.badgeColor,
                background: `${activeScenario.badgeColor}1a`,
                padding: '2px 8px', borderRadius: 99,
              }}>
                {activeScenario.icon} {activeScenario.name}
              </span>
            </div>
          </div>

          {/* Comparison cards */}
          {analysis.comparison && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Score bar */}
              <div style={{
                background: C.s2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 13px',
              }}>
                <p style={{ fontSize: 10, color: C.subtle, marginBottom: 8, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Scenario score /100
                </p>
                <ScoreBar
                  current={analysis.comparison.current.score}
                  sandbox={analysis.comparison.sandbox.score}
                />
              </div>

              {/* 2-col cards */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(['current', 'sandbox'] as const).map((key) => {
                  const d          = analysis.comparison![key];
                  const isSandbox  = key === 'sandbox';
                  const impactPos  = d.projectedImpact.startsWith('+');
                  const statusCol  = d.goalStatus === 'On Track' || d.goalStatus === 'Ahead' ? C.green : C.red;
                  return (
                    <div
                      key={key}
                      style={{
                        background:   C.s2,
                        border:       `1px solid ${isSandbox ? `${C.gold}50` : C.border}`,
                        borderRadius: 10,
                        padding:      '11px 12px',
                      }}
                    >
                      <p style={{
                        fontSize: 9, color: isSandbox ? C.gold : C.muted,
                        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8,
                      }}>
                        {isSandbox ? 'Sandbox' : 'Current'}
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div>
                          <span style={{ fontSize: 9, color: C.subtle, display: 'block' }}>Projected impact</span>
                          <span style={{ fontSize: 14, fontWeight: 600, color: impactPos ? C.green : C.red }}>
                            {d.projectedImpact}
                          </span>
                        </div>
                        <div>
                          <span style={{ fontSize: 9, color: C.subtle, display: 'block' }}>Goal</span>
                          <span style={{ fontSize: 11, color: statusCol }}>{d.goalStatus}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Banner */}
              {(compDiff !== null || !isSandboxModified) && bannerMsg && (
                <div style={{
                  background:   bannerBg,
                  borderLeft:   `3px solid ${bannerBorder}`,
                  borderRadius: '0 8px 8px 0',
                  padding:      '9px 12px',
                }}>
                  <p style={{ fontSize: 12, color: !isSandboxModified ? C.muted : C.text, margin: 0, fontStyle: !isSandboxModified ? 'italic' : 'normal' }}>{bannerMsg}</p>
                  {!isSandboxModified && <p style={{ fontSize: 11, color: C.subtle, margin: '4px 0 0' }}>Try removing a risky stock or adding a new one →</p>}
                </div>
              )}

              {/* Verdict */}
              {analysis.comparison.verdict && (
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.7, padding: '0 2px' }}>
                  {analysis.comparison.verdict}
                </p>
              )}
            </div>
          )}

          {/* Loading pulse */}
          {analysis.loading && (
            <p style={{ fontSize: 12, color: C.subtle, animation: 'pulse 1.5s ease infinite' }}>
              Analysing your changes…
            </p>
          )}

          {/* Error */}
          {analysis.error && (
            <div style={{
              background:   'rgba(224,82,82,0.07)',
              border:       '1px solid rgba(224,82,82,0.25)',
              borderRadius: 10,
              padding:      '10px 12px',
            }}>
              <p style={{ fontSize: 12, color: C.red }}>{analysis.error}</p>
              <button
                onClick={runAnalysis}
                style={{ marginTop: 6, fontSize: 11, color: C.gold, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                ↻ Retry
              </button>
            </div>
          )}

          {/* AI narrative — collapsed summary / expanded full text */}
          {analysis.text && (
            <div style={{ opacity: analysis.loading ? 0.45 : 1, transition: 'opacity 0.3s' }}>

              {/* Collapsed: 2-sentence summary */}
              {!scenarioExpanded && (
                <div>
                  {summaryLoading && (
                    <p style={{ fontSize: 12, color: C.subtle, animation: 'pulse 1.5s ease infinite' }}>
                      Summarising…
                    </p>
                  )}
                  {!summaryLoading && scenarioSummary && (
                    <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.8, margin: 0 }}>
                      {scenarioSummary}
                    </p>
                  )}
                  <button
                    onClick={() => setScenarioExpanded(true)}
                    style={{
                      fontSize: 12, color: C.gold, background: 'none', border: 'none',
                      cursor: 'pointer', textDecoration: 'underline', padding: 0,
                      display: 'block', marginTop: 8,
                    }}
                  >
                    Read full analysis →
                  </button>
                </div>
              )}

              {/* Expanded: full markdown */}
              <div style={{
                maxHeight:  scenarioExpanded ? '2000px' : '0',
                overflow:   'hidden',
                transition: 'max-height 0.4s ease',
              }}>
                {scenarioExpanded && (
                  <button
                    onClick={() => setScenarioExpanded(false)}
                    style={{
                      fontSize: 12, color: C.gold, background: 'none', border: 'none',
                      cursor: 'pointer', textDecoration: 'underline', padding: 0,
                      display: 'block', marginBottom: 8,
                    }}
                  >
                    ← Show summary
                  </button>
                )}
                <div
                  className="ai-output"
                  dangerouslySetInnerHTML={{ __html: marked(analysis.text) as string }}
                />
              </div>

            </div>
          )}

          {/* Apply to sandbox button */}
          {analysis.text && !analysis.loading && (
            <div style={{ marginTop: 4 }}>
              <button
                onClick={() => void handleApplyRecommendations()}
                style={{
                  width:        '100%',
                  background:   C.gold,
                  color:        '#0a0a0b',
                  border:       'none',
                  borderRadius: 10,
                  padding:      '10px 16px',
                  fontSize:     12,
                  fontWeight:   700,
                  cursor:       'pointer',
                  fontFamily:  '"DM Sans", system-ui, sans-serif',
                  letterSpacing: '0.01em',
                }}
              >
                Apply AI recommendations to sandbox →
              </button>
              {applyStatus && (
                <p style={{ fontSize: 11, color: C.green, marginTop: 6, textAlign: 'center' }}>
                  {applyStatus}
                </p>
              )}
            </div>
          )}

          {/* Apply sandbox to real portfolio */}
          {onApplyToRealPortfolio && (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => {
                  const stocks: PortfolioStock[] = sandbox.map((h) => ({
                    id:          h.id,
                    name:        h.name,
                    ticker:      h.ticker,
                    shares:      h.shares,
                    avgBuyPrice: h.avgBuyPrice,
                  }));
                  onApplyToRealPortfolio(stocks);
                  addUserAction('Applied sandbox to real portfolio');
                }}
                style={{
                  width:        '100%',
                  background:   'transparent',
                  color:        C.gold,
                  border:       `1px solid ${C.gold}55`,
                  borderRadius: 10,
                  padding:      '9px 16px',
                  fontSize:     12,
                  fontWeight:   600,
                  cursor:       'pointer',
                  fontFamily:   '"DM Sans", system-ui, sans-serif',
                  letterSpacing: '0.01em',
                  transition:   'background 0.15s',
                }}
                onMouseOver={(e) => (e.currentTarget.style.background = `${C.gold}12`)}
                onMouseOut={(e)  => (e.currentTarget.style.background  = 'transparent')}
              >
                Apply sandbox to real portfolio →
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
