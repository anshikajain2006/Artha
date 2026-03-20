import { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';

marked.use({ breaks: true, gfm: true } as Parameters<typeof marked.use>[0]);
import { parseFlexDate } from '../lib/brokerParsers';
import type { PortfolioStock } from './PortfolioEntry';

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

interface Props {
  portfolio:        PortfolioStock[];
  totalInvested:    number;
  totalValue:       number;
  totalPnlPct:      number;
  portfolioSummary: string;
}

interface NiftyPoint {
  ts:    number; // Unix seconds
  close: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n)}%`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function periodLabel(start: Date, end: Date): string {
  const months = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 1)  return `${Math.round(months * 30)} days`;
  if (months < 12) return `${months.toFixed(1)} months`;
  return `${(months / 12).toFixed(1)} years`;
}

function rangeForStartDate(start: Date): string {
  const months = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months <= 12) return '1y';
  if (months <= 24) return '2y';
  if (months <= 60) return '5y';
  return '10y';
}

/** Find the Nifty closing price on or just after startDate. */
function priceAtDate(points: NiftyPoint[], targetSec: number): number | null {
  let best: NiftyPoint | null = null;
  let bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(p.ts - targetSec);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  return best?.close ?? null;
}

// ── Comparison bar ─────────────────────────────────────────────────────────────

function CompBar({
  label, value, maxAbs, color,
}: {
  label:  string;
  value:  number;
  maxAbs: number;
  color:  string;
}) {
  const pct = maxAbs > 0 ? (Math.abs(value) / maxAbs) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span style={{ color: C.muted, fontSize: 11, width: 130, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, background: C.s2, borderRadius: 99, height: 8, overflow: 'hidden' }}>
        <div
          style={{
            width:        `${Math.min(pct, 100)}%`,
            height:       '100%',
            background:   color,
            borderRadius: 99,
            transition:   'width 0.6s ease',
          }}
        />
      </div>
      <span style={{ color, fontSize: 12, fontWeight: 600, width: 60, textAlign: 'right', flexShrink: 0 }}>
        {fmtPct(value)}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function VsNiftyCard({
  portfolio, totalInvested, totalValue, totalPnlPct, portfolioSummary,
}: Props) {
  const [niftyReturn,  setNiftyReturn]  = useState<number | null>(null);
  const [niftyAtStart, setNiftyAtStart] = useState<number | null>(null);
  const [niftyCurrent, setNiftyCurrent] = useState<number | null>(null);
  const [startDate,    setStartDate]    = useState<Date | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [fetchError,   setFetchError]   = useState<string | null>(null);
  const [aiText,       setAiText]       = useState<string | null>(null);
  const [aiLoading,    setAiLoading]    = useState(false);
  const [aiError,      setAiError]      = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // ── Derive portfolio start date ────────────────────────────────────────────

  useEffect(() => {
    try {
      const dates = portfolio
        .map((s) => s.buyDate ? parseFlexDate(s.buyDate) : null)
        .filter((d): d is Date => d !== null && !isNaN(d.getTime()));

      if (dates.length === 0) { setLoading(false); return; }
      const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
      setStartDate(earliest);
    } catch {
      setLoading(false);
    }
  }, [portfolio]);

  // ── Fetch Nifty historical data once startDate is known ───────────────────

  useEffect(() => {
    if (!startDate || fetchedRef.current) return;
    fetchedRef.current = true;

    const range = rangeForStartDate(startDate);

    async function fetchNifty() {
      setLoading(true);
      setFetchError(null);
      try {
        const url = `/api/yf/v8/finance/chart/%5ENSEI?interval=1d&range=${range}&includePrePost=false`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body = await res.json() as {
          chart?: {
            result?: Array<{
              timestamp?: number[];
              indicators?: { quote?: Array<{ close?: (number | null)[] }> };
            }>;
          };
        };

        const result     = body.chart?.result?.[0];
        const timestamps = result?.timestamp ?? [];
        const closes     = result?.indicators?.quote?.[0]?.close ?? [];

        if (timestamps.length === 0) throw new Error('No Nifty data returned');

        const points: NiftyPoint[] = timestamps
          .map((ts, i) => ({ ts, close: closes[i] ?? null }))
          .filter((p): p is NiftyPoint => p.close !== null && p.close > 0);

        if (points.length === 0) throw new Error('Empty Nifty series');

        const startSec = Math.floor(startDate!.getTime() / 1000);
        const atStart  = priceAtDate(points, startSec);
        const current  = points[points.length - 1].close;

        if (!atStart) throw new Error('Could not find Nifty price for start date');

        const ret = ((current - atStart) / atStart) * 100;
        setNiftyAtStart(atStart);
        setNiftyCurrent(current);
        setNiftyReturn(ret);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : 'Failed to load Nifty data');
      } finally {
        setLoading(false);
      }
    }

    void fetchNifty();
  }, [startDate]);

  // ── AI commentary ──────────────────────────────────────────────────────────

  async function handleAiAnalysis() {
    if (!startDate || niftyReturn === null) return;
    setAiLoading(true);
    setAiError(null);
    setAiText(null);

    const prompt = `You are Artha, a premium AI portfolio analyst for Indian retail investors.

The user's portfolio has returned ${fmtPct(totalPnlPct)} since ${fmtDate(startDate)}.
The Nifty 50 returned ${fmtPct(niftyReturn)} in the same period.
The gap is ${fmtPct(totalPnlPct - niftyReturn)} (${totalPnlPct >= niftyReturn ? 'outperformance' : 'underperformance'}).
User's holdings by weight: ${portfolioSummary}

In 3-4 sentences: explain the likely reasons for this ${totalPnlPct >= niftyReturn ? 'outperformance' : 'underperformance'}, which specific holdings most likely caused the gap, and the single most important change that would improve performance vs the Nifty 50 going forward. Be direct, specific, and reference actual tickers. No generic advice.

End with: ⚠️ This is AI-generated commentary, not SEBI-registered investment advice.`;

    try {
      const res  = await fetch('/api/commentary', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt }),
      });
      const data = await res.json() as { text?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setAiText(data.text ?? '');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to get AI analysis');
    } finally {
      setAiLoading(false);
    }
  }

  // ── Skeleton states ────────────────────────────────────────────────────────

  if (!loading && !startDate) {
    return (
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14 }} className="artha-card p-5">
        <h2 style={{ fontFamily: '"Fraunces", serif', fontSize: 18, fontWeight: 300, color: C.text }} className="mb-1">
          Your portfolio vs Nifty 50
        </h2>
        <p style={{ color: C.subtle, fontSize: 12 }}>
          Add buy dates to your holdings to enable this comparison. Groww Excel exports include this automatically.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14 }} className="artha-card p-5">
        <div className="flex items-center gap-3">
          <span style={{ display: 'inline-block', width: 14, height: 14, border: `2px solid ${C.border}`, borderTopColor: C.gold, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <span style={{ color: C.muted, fontSize: 13 }}>Fetching Nifty 50 data…</span>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (fetchError || niftyReturn === null) {
    return (
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14 }} className="artha-card p-5">
        <h2 style={{ fontFamily: '"Fraunces", serif', fontSize: 18, fontWeight: 300, color: C.text }} className="mb-2">
          Your portfolio vs Nifty 50
        </h2>
        <p style={{ color: C.muted, fontSize: 13 }}>
          Nifty data unavailable — try refreshing.
          {fetchError && <span style={{ color: C.subtle }}> ({fetchError})</span>}
        </p>
        <button
          onClick={() => { fetchedRef.current = false; setLoading(true); setFetchError(null); }}
          style={{ marginTop: 12, color: C.gold, background: 'none', border: `1px solid ${C.gold}50`, borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}
        >
          ↻ Retry
        </button>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  const hypotheticalNiftyValue = totalInvested * (1 + niftyReturn / 100);
  const actualDifference       = hypotheticalNiftyValue - totalValue;   // >0 = underperformed
  const underperformed         = actualDifference > 0;
  const absDiff                = Math.abs(actualDifference);

  const diff          = totalPnlPct - niftyReturn;
  const outperformed  = diff >= 0;
  const maxAbs        = Math.max(Math.abs(totalPnlPct), Math.abs(niftyReturn), 1);
  const portColor     = totalPnlPct >= 0 ? C.green : C.red;
  const niftyColor    = niftyReturn  >= 0 ? C.green : C.red;
  const verdictBg     = outperformed ? 'rgba(78,173,132,0.07)'  : 'rgba(224,82,82,0.07)';
  const verdictBorder = outperformed ? C.green : C.red;
  const verdictText   = outperformed
    ? `You've beaten Nifty 50 by ${fmt(Math.abs(diff))} percentage points. Your stock picks are working.`
    : `You've underperformed Nifty 50 by ${fmt(Math.abs(diff))} percentage points. A simple index fund would have done better.`;

  return (
    <>
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14 }} className="artha-card">
        {/* Header */}
        <div style={{ borderBottom: `1px solid ${C.border}`, padding: '16px 20px' }} className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 style={{ fontFamily: '"Fraunces", serif', fontSize: 18, fontWeight: 300, color: C.text, marginBottom: 4 }}>
              Your portfolio vs Nifty 50
            </h2>
            <p style={{ color: C.muted, fontSize: 12, margin: 0 }}>
              Since {fmtDate(startDate!)} — your earliest investment
            </p>
          </div>
          <span style={{ fontSize: 11, color: C.muted, background: C.s2, borderRadius: 20, padding: '3px 10px', flexShrink: 0 }}>
            {periodLabel(startDate!, new Date())}
          </span>
        </div>

        <div style={{ padding: '20px' }} className="flex flex-col gap-5">
          {/* Two stat columns */}
          <div className="grid grid-cols-2 gap-4">
            {/* Portfolio column */}
            <div className="flex flex-col gap-1">
              <span className="section-label">Your Return</span>
              <span style={{ fontFamily: '"Fraunces", serif', fontSize: 40, fontWeight: 300, color: portColor, lineHeight: 1.1, letterSpacing: '-1px' }}>
                {fmtPct(totalPnlPct)}
              </span>
              <span style={{ fontSize: 12, color: C.muted }}>
                ₹{fmt(totalValue, 0)} from ₹{fmt(totalInvested, 0)}
              </span>
            </div>

            {/* Nifty column */}
            <div className="flex flex-col gap-1">
              <span className="section-label">Nifty 50 Return</span>
              <span style={{ fontFamily: '"Fraunces", serif', fontSize: 40, fontWeight: 300, color: niftyColor, lineHeight: 1.1, letterSpacing: '-1px' }}>
                {fmtPct(niftyReturn)}
              </span>
              <span style={{ fontSize: 12, color: C.muted }}>
                ₹{fmt(totalInvested, 0)} → ₹{fmt(hypotheticalNiftyValue, 0)} (hypothetical)
              </span>
              {niftyAtStart && niftyCurrent && (
                <span style={{ fontSize: 11, color: C.subtle }}>
                  {fmt(niftyAtStart, 0)} → {fmt(niftyCurrent, 0)} pts
                </span>
              )}
            </div>
          </div>

          {/* ── What-if banner ──────────────────────────────────────────────── */}
          <div style={{
            background:   C.s2,
            borderRadius: 10,
            padding:      '16px 20px',
          }}>
            {underperformed ? (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  {/* Down-right arrow */}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                    <path d="M3 3 L13 13 M13 13 H7 M13 13 V7" stroke={C.red} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.8, margin: 0 }}>
                    If you'd put{' '}
                    <span style={{ color: C.text, fontWeight: 500 }}>₹{fmt(totalInvested, 0)}</span>
                    {' '}into a Nifty 50 index fund on{' '}
                    <span style={{ color: C.text, fontWeight: 500 }}>{fmtDate(startDate!)}</span>,
                    you'd have{' '}
                    <span style={{ color: C.text, fontWeight: 500 }}>₹{fmt(hypotheticalNiftyValue, 0)}</span>
                    {' '}today.
                    <br />
                    That's{' '}
                    <span style={{ color: C.red, fontWeight: 500 }}>₹{fmt(absDiff, 0)}</span>
                    {' '}more than your current portfolio.
                  </p>
                </div>
              </>
            ) : (
              <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.8, margin: 0 }}>
                Your stock picks beat the index by{' '}
                <span style={{ color: C.green, fontWeight: 500 }}>₹{fmt(absDiff, 0)}</span>.
                {' '}That's what separates active investors from passive ones.
              </p>
            )}
          </div>

          {/* Verdict banner */}
          <div style={{
            background:    verdictBg,
            borderLeft:    `3px solid ${verdictBorder}`,
            borderRadius:  '0 8px 8px 0',
            padding:       '12px 14px',
          }}>
            <p style={{ fontSize: 13, color: C.text, lineHeight: 1.7, margin: 0 }}>
              {verdictText}
            </p>
          </div>

          {/* Comparison bars */}
          <div className="flex flex-col gap-2.5">
            <CompBar label="Your portfolio" value={totalPnlPct} maxAbs={maxAbs} color={portColor} />
            <CompBar label="Nifty 50"       value={niftyReturn}  maxAbs={maxAbs} color={niftyColor} />
          </div>

          {/* AI commentary + Share */}
          <div className="flex flex-col gap-3">
            {/* Button row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {!aiText && (
                <button
                  onClick={() => void handleAiAnalysis()}
                  disabled={aiLoading}
                  style={{
                    display:      'inline-flex',
                    alignItems:   'center',
                    gap:          6,
                    color:        C.gold,
                    background:   'transparent',
                    border:       `1px solid ${C.gold}50`,
                    borderRadius: 8,
                    padding:      '8px 16px',
                    fontSize:     13,
                    cursor:       aiLoading ? 'not-allowed' : 'pointer',
                    opacity:      aiLoading ? 0.7 : 1,
                    fontFamily:   '"DM Sans", system-ui, sans-serif',
                  }}
                >
                  {aiLoading ? (
                    <>
                      <span style={{ display: 'inline-block', width: 12, height: 12, border: `2px solid ${C.gold}40`, borderTopColor: C.gold, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      Analysing gap…
                    </>
                  ) : (
                    '✦ Get AI analysis of this gap →'
                  )}
                </button>
              )}

            </div>

            {aiError && (
              <p style={{ fontSize: 12, color: C.red }}>{aiError}</p>
            )}

            {aiText && (
              <div style={{
                background:   C.s2,
                borderLeft:   `2px solid ${C.gold}`,
                borderRadius: '0 8px 8px 0',
                padding:      '14px 16px',
              }}>
                <div
                  className="ai-output"
                  dangerouslySetInnerHTML={{ __html: marked(aiText) as string }}
                />
                <button
                  onClick={() => setAiText(null)}
                  style={{ marginTop: 10, fontSize: 11, color: C.subtle, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  ↻ Regenerate
                </button>
              </div>
            )}
          </div>
        </div>

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

    </>
  );
}
