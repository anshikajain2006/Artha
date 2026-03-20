import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Chart,
  LineElement,
  PointElement,
  LineController,
  CategoryScale,
  LinearScale,
  Filler,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { PortfolioStock } from './PortfolioEntry';

Chart.register(LineElement, PointElement, LineController, CategoryScale, LinearScale, Filler, Tooltip);

// ── Design tokens ──────────────────────────────────────────────────────────────

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
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChartPoint { date: string; value: number; }

type Range = '1M' | '3M' | '6M' | '1Y';

const RANGE_API: Record<Range, string> = {
  '1M': '1mo',
  '3M': '3mo',
  '6M': '6mo',
  '1Y': '1y',
};

interface Props {
  portfolio: PortfolioStock[];
}

// ── SessionStorage cache ───────────────────────────────────────────────────────

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface Cached {
  portfolio: ChartPoint[];
  nifty:     ChartPoint[];
  ts:        number;
}

function cacheKey(range: Range, tickers: string[]): string {
  return `artha_perf_${range}_${tickers.sort().join(',')}`;
}

function getCached(key: string): Cached | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (Date.now() - c.ts > CACHE_TTL) return null;
    return c;
  } catch { return null; }
}

function setCache(key: string, data: Omit<Cached, 'ts'>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...data, ts: Date.now() }));
  } catch { /* ignore quota errors */ }
}

// ── Normalise series to 100 at first point ────────────────────────────────────

function normalise(points: ChartPoint[]): number[] {
  if (points.length === 0) return [];
  const base = points[0].value;
  if (base === 0) return points.map(() => 100);
  return points.map((p) => (p.value / base) * 100);
}

// ── Returns ────────────────────────────────────────────────────────────────────

function calcReturn(values: number[]): number | null {
  if (values.length < 2) return null;
  const start = values[0];
  const end   = values[values.length - 1];
  if (start === 0) return null;
  return ((end - start) / start) * 100;
}

// ── Line chart canvas ──────────────────────────────────────────────────────────

function LineChart({
  labels,
  portfolioValues,
  niftyValues,
}: {
  labels:          string[];
  portfolioValues: number[];
  niftyValues:     number[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gradient = canvas.getContext('2d')?.createLinearGradient(0, 0, 0, 200);
    gradient?.addColorStop(0,   'rgba(212,168,67,0.18)');
    gradient?.addColorStop(1,   'rgba(212,168,67,0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label:            'Your portfolio',
            data:             portfolioValues,
            borderColor:      C.gold,
            backgroundColor:  gradient ?? 'rgba(212,168,67,0.08)',
            fill:             true,
            tension:          0.4,
            pointRadius:      0,
            pointHoverRadius: 4,
            borderWidth:      2,
          },
          {
            label:            'Nifty 50',
            data:             niftyValues,
            borderColor:      C.muted,
            backgroundColor:  'transparent',
            fill:             false,
            tension:          0.4,
            pointRadius:      0,
            pointHoverRadius: 4,
            borderWidth:      1.5,
            borderDash:       [4, 4],
          },
        ],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode:            'index',
            intersect:       false,
            backgroundColor: '#111113',
            borderColor:     '#2a2a2f',
            borderWidth:     1,
            titleColor:      '#f0efe8',
            bodyColor:       '#9b9a94',
            padding:         10,
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed.y.toFixed(1);
                return `${ctx.dataset.label}: ${val} (indexed)`;
              },
            },
          },
        },
        interaction: {
          mode:      'index',
          intersect: false,
        },
        scales: {
          x: {
            grid:   { display: false },
            border: { display: false },
            ticks:  {
              color:         C.subtle,
              font:          { size: 11 },
              maxTicksLimit: 6,
              maxRotation:   0,
            },
          },
          y: {
            grid:   { color: 'rgba(255,255,255,0.04)' },
            border: { display: false },
            ticks:  {
              color:    C.subtle,
              font:     { size: 11 },
              callback: (val) => Number(val).toFixed(0),
            },
          },
        },
      },
    };

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvas, config);

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [labels, portfolioValues, niftyValues]);

  return (
    <div style={{ position: 'relative', height: 200, width: '100%' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PerformanceChart({ portfolio }: Props) {
  const [range,      setRange]      = useState<Range>('1Y');
  const [portData,   setPortData]   = useState<ChartPoint[]>([]);
  const [niftyData,  setNiftyData]  = useState<ChartPoint[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const tickers = portfolio.map((h) => h.ticker.trim().toUpperCase());

  const fetchData = useCallback(async (r: Range) => {
    const key = cacheKey(r, tickers);
    const cached = getCached(key);
    if (cached) {
      setPortData(cached.portfolio);
      setNiftyData(cached.nifty);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    try {
      const holdings = portfolio.map((h) => ({
        ticker:  h.ticker.trim().toUpperCase(),
        shares:  h.shares,
        buyDate: h.buyDate,
      }));

      const res = await fetch('/api/historical-prices', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ holdings, range: RANGE_API[r] }),
        signal:  ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { portfolio: ChartPoint[]; nifty: ChartPoint[] };
      setPortData(data.portfolio);
      setNiftyData(data.nifty);
      setCache(key, { portfolio: data.portfolio, nifty: data.nifty });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load chart data');
    } finally {
      setLoading(false);
    }
  }, [portfolio]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (portfolio.length === 0) { setLoading(false); return; }
    void fetchData(range);
    return () => abortRef.current?.abort();
  }, [range, fetchData]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const portNorm  = normalise(portData);
  const niftyNorm = normalise(niftyData);

  // Align on the shorter series (portfolio might start later than nifty)
  const minLen    = Math.min(portNorm.length, niftyNorm.length);
  const portSlice = portNorm.slice(-minLen);
  const niftySlice= niftyNorm.slice(-minLen);
  const labels    = portData.slice(-minLen).map((p) => p.date);

  const portReturn  = calcReturn(portSlice);
  const niftyReturn = calcReturn(niftySlice);

  function retColor(v: number | null): string {
    if (v === null) return C.muted;
    return v >= 0 ? C.green : C.red;
  }

  function retLabel(v: number | null): string {
    if (v === null) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  }

  // ── Early returns ──────────────────────────────────────────────────────────

  if (portfolio.length === 0) return null;

  return (
    <div style={{
      background:    C.s1,
      border:        `1px solid ${C.border}`,
      borderRadius:  14,
      padding:       '20px 24px',
      marginBottom:  0,
      display:       'flex',
      flexDirection: 'column',
      gap:           16,
    }}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{
            fontFamily: '"Fraunces", serif',
            fontWeight: 300,
            fontSize:   16,
            color:      C.text,
            margin:     0,
          }}>
            Portfolio vs Nifty 50
          </h2>
          <p style={{ color: C.subtle, fontSize: 11, margin: '2px 0 0' }}>
            Indexed to 100 from your first investment
          </p>
        </div>

        {/* Custom legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 20, height: 2, background: C.gold, borderRadius: 1 }} />
            <span style={{ fontSize: 11, color: C.muted }}>Your portfolio</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="20" height="2" viewBox="0 0 20 2">
              <line x1="0" y1="1" x2="20" y2="1" stroke={C.muted} strokeWidth="1.5" strokeDasharray="4 4" />
            </svg>
            <span style={{ fontSize: 11, color: C.muted }}>Nifty 50</span>
          </div>
        </div>
      </div>

      {/* ── Performance badges ─────────────────────────────────────────────── */}
      {!loading && !error && portReturn !== null && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            background:   C.s2,
            border:       `1px solid ${C.border}`,
            borderRadius: 99,
            padding:      '4px 10px',
            fontSize:     11,
            color:        retColor(portReturn),
          }}>
            Your portfolio: {retLabel(portReturn)}
          </span>
          <span style={{
            background:   C.s2,
            border:       `1px solid ${C.border}`,
            borderRadius: 99,
            padding:      '4px 10px',
            fontSize:     11,
            color:        retColor(niftyReturn),
          }}>
            Nifty 50: {retLabel(niftyReturn)}
          </span>
        </div>
      )}

      {/* ── Chart area ────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{
          height:       200,
          borderRadius: 8,
          background:   C.s2,
          animation:    'perf-shimmer 1.5s ease-in-out infinite',
        }} />
      )}

      {!loading && error && (
        <div style={{
          height:         200,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
        }}>
          <p style={{ fontSize: 13, color: C.subtle, textAlign: 'center', margin: 0 }}>
            Chart data unavailable — prices could not be fetched
          </p>
        </div>
      )}

      {!loading && !error && labels.length < 2 && (
        <div style={{
          height:         200,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
        }}>
          <p style={{ fontSize: 13, color: C.subtle, textAlign: 'center', margin: 0 }}>
            Chart will populate after 2 weeks of data
          </p>
        </div>
      )}

      {!loading && !error && labels.length >= 2 && (
        <LineChart
          labels={labels}
          portfolioValues={portSlice}
          niftyValues={niftySlice}
        />
      )}

      {/* ── Time range pills ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['1M', '3M', '6M', '1Y'] as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            style={{
              background:   range === r ? C.gold : C.s2,
              color:        range === r ? '#0a0a0b' : C.muted,
              border:       'none',
              borderRadius: 99,
              padding:      '4px 12px',
              fontSize:     11,
              fontWeight:   range === r ? 600 : 400,
              cursor:       'pointer',
              transition:   'background 0.15s, color 0.15s',
              fontFamily:   '"DM Sans", system-ui, sans-serif',
            }}
          >
            {r}
          </button>
        ))}
      </div>

      <style>{`
        @keyframes perf-shimmer {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
