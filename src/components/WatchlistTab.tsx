import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchLivePrices, type LivePrice } from '../lib/prices';
import {
  loadWatchlist,
  addWatchlistItem,
  removeWatchlistItem,
  updateWatchlistSignal,
  type WatchlistRow,
} from '../lib/db';

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

export interface WatchlistItem {
  id:           string;
  stockName:    string;
  ticker:       string;
  targetPrice?: number;
  addedAt:      string;
  notes?:       string;
}

export interface WatchlistSignal {
  signal:    'Buy' | 'Wait' | 'Avoid';
  reason:    string;
  fetchedAt: string;
}

interface Props {
  userId:           string;
  portfolioSummary: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SIGNAL_COLORS: Record<'Buy' | 'Wait' | 'Avoid', { text: string; bg: string }> = {
  Buy:   { text: C.green,   bg: 'rgba(78,173,132,0.12)'  },
  Wait:  { text: C.gold,    bg: 'rgba(212,168,67,0.12)'  },
  Avoid: { text: C.red,     bg: 'rgba(224,82,82,0.12)'   },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function rowToItem(r: WatchlistRow): WatchlistItem {
  return {
    id:          r.id,
    stockName:   r.stock_name,
    ticker:      r.ticker,
    targetPrice: r.target_price ?? undefined,
    addedAt:     r.added_at,
    notes:       r.notes ?? undefined,
  };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function WatchlistTab({ userId, portfolioSummary }: Props) {
  const [items,          setItems]          = useState<WatchlistItem[]>([]);
  const [signals,        setSignals]        = useState<Record<string, WatchlistSignal>>({});
  const [livePrices,     setLivePrices]     = useState<Record<string, LivePrice | null>>({});
  const [loadingSignal,  setLoadingSignal]  = useState<Record<string, boolean>>({});
  const [dbLoading,      setDbLoading]      = useState(true);
  const [formName,       setFormName]       = useState('');
  const [formTicker,     setFormTicker]     = useState('');
  const [formTarget,     setFormTarget]     = useState('');
  const [formError,      setFormError]      = useState('');
  const [adding,         setAdding]         = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load from Supabase on mount ───────────────────────────────────────────────

  useEffect(() => {
    loadWatchlist(userId).then((rows) => {
      const mapped = rows.map(rowToItem);
      setItems(mapped);

      // Reconstruct signals from persisted ai_signal / ai_reason
      const sigs: Record<string, WatchlistSignal> = {};
      for (const r of rows) {
        if (r.ai_signal && r.ai_reason) {
          const s = r.ai_signal as 'Buy' | 'Wait' | 'Avoid';
          if (s === 'Buy' || s === 'Wait' || s === 'Avoid') {
            sigs[r.id] = { signal: s, reason: r.ai_reason, fetchedAt: r.added_at };
          }
        }
      }
      setSignals(sigs);
      setDbLoading(false);
    });
  }, [userId]);

  // ── Live price fetching ──────────────────────────────────────────────────────

  const refreshPrices = useCallback(async (watchItems: WatchlistItem[]) => {
    if (watchItems.length === 0) return;
    const tickers = watchItems.map((i) => i.ticker);
    const prices  = await fetchLivePrices(tickers);
    setLivePrices((prev) => ({ ...prev, ...prices }));
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    refreshPrices(items);
    refreshTimer.current = setInterval(() => refreshPrices(items), 5 * 60 * 1_000);
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, [items, refreshPrices]);

  // ── AI signal fetch ──────────────────────────────────────────────────────────

  const fetchSignal = useCallback(async (
    item:         WatchlistItem,
    currentPrice: number | null,
  ) => {
    setLoadingSignal((prev) => ({ ...prev, [item.id]: true }));
    try {
      const res = await fetch('/api/watchlist-signal', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          stockName:        item.stockName,
          ticker:           item.ticker,
          currentPrice,
          targetPrice:      item.targetPrice,
          portfolioSummary,
        }),
      });
      const data = await res.json();
      if (data.signal && data.reason) {
        setSignals((prev) => ({
          ...prev,
          [item.id]: { signal: data.signal, reason: data.reason, fetchedAt: new Date().toISOString() },
        }));
        // Persist signal to Supabase
        void updateWatchlistSignal(item.id, data.signal, data.reason);
      }
    } catch {
      // silently fail — user can retry via Refresh button
    } finally {
      setLoadingSignal((prev) => ({ ...prev, [item.id]: false }));
    }
  }, [portfolioSummary]);

  // ── Add to watchlist ─────────────────────────────────────────────────────────

  async function handleAdd() {
    const name   = formName.trim();
    const ticker = formTicker.trim().toUpperCase();
    if (!name)   { setFormError('Stock name is required.'); return; }
    if (!ticker) { setFormError('Ticker is required.');     return; }

    setFormError('');
    setAdding(true);

    const targetPriceNum = formTarget ? parseFloat(formTarget) || null : null;
    const row = await addWatchlistItem(userId, name, ticker, targetPriceNum);

    if (!row) {
      setFormError('Failed to save. Please try again.');
      setAdding(false);
      return;
    }

    const item = rowToItem(row);
    setItems((prev) => [item, ...prev]);

    setFormName('');
    setFormTicker('');
    setFormTarget('');
    setAdding(false);

    // Fetch price + signal in the background
    const priceRes = await fetchLivePrices([ticker]);
    const lp       = priceRes[ticker] ?? null;
    setLivePrices((prev) => ({ ...prev, [ticker]: lp }));
    fetchSignal(item, lp?.price ?? null);
  }

  // ── Delete item ──────────────────────────────────────────────────────────────

  function handleDelete(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSignals((prev) => { const n = { ...prev }; delete n[id]; return n; });
    void removeWatchlistItem(id);
  }

  // ── Input style ──────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    background:   C.s1,
    border:       `1px solid ${C.border}`,
    borderRadius: 8,
    padding:      '10px 14px',
    fontSize:     13,
    color:        C.text,
    outline:      'none',
    width:        '100%',
    fontFamily:   '"DM Sans", system-ui, sans-serif',
    colorScheme:  'dark',
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">

      {/* Add form */}
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: '20px 24px' }}>
        <p className="metric-label mb-3">Add to Watchlist</p>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1.5" style={{ flex: '1 1 180px', minWidth: 160 }}>
            <label style={{ fontSize: 10, color: C.subtle, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Stock Name</label>
            <input
              style={inputStyle}
              placeholder="e.g. Reliance Industries"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
            />
          </div>
          <div className="flex flex-col gap-1.5" style={{ flex: '0 1 110px', minWidth: 90 }}>
            <label style={{ fontSize: 10, color: C.subtle, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ticker</label>
            <input
              style={{ ...inputStyle, textTransform: 'uppercase' }}
              placeholder="RELIANCE"
              value={formTicker}
              onChange={(e) => setFormTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
            />
          </div>
          <div className="flex flex-col gap-1.5" style={{ flex: '0 1 140px', minWidth: 110 }}>
            <label style={{ fontSize: 10, color: C.subtle, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Target Price (₹) — optional</label>
            <input
              style={inputStyle}
              type="number"
              placeholder="e.g. 2800"
              value={formTarget}
              onChange={(e) => setFormTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
            />
          </div>
          <button
            onClick={() => void handleAdd()}
            disabled={adding}
            style={{
              background:   C.gold,
              color:        C.bg,
              borderRadius: 8,
              padding:      '10px 20px',
              fontSize:     13,
              fontWeight:   600,
              cursor:       adding ? 'not-allowed' : 'pointer',
              opacity:      adding ? 0.7 : 1,
              whiteSpace:   'nowrap',
              flexShrink:   0,
              border:       'none',
            }}
          >
            {adding ? 'Adding…' : '+ Watch'}
          </button>
        </div>
        {formError && (
          <p style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{formError}</p>
        )}
      </div>

      {/* Loading state */}
      {dbLoading && (
        <div className="flex items-center justify-center" style={{ minHeight: 180 }}>
          <span style={{
            display:     'inline-block',
            width:       20,
            height:      20,
            border:      `2px solid ${C.border}`,
            borderTopColor: C.gold,
            borderRadius: '50%',
            animation:   'spin 0.8s linear infinite',
          }} />
        </div>
      )}

      {/* Empty state */}
      {!dbLoading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2" style={{ minHeight: 260 }}>
          <p style={{ color: C.muted, fontSize: 14 }}>No stocks on your watchlist yet</p>
          <p style={{ color: C.subtle, fontSize: 12 }}>Add stocks you're considering buying and get AI signals</p>
        </div>
      )}

      {/* Cards grid */}
      {!dbLoading && items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {items.map((item) => {
            const lp          = livePrices[item.ticker] ?? null;
            const price       = lp?.price ?? null;
            const change      = lp?.changePercent ?? null;
            const isLive      = lp != null;
            const signal      = signals[item.id] ?? null;
            const isLoading   = loadingSignal[item.id] ?? false;
            const targetHit   = price != null && item.targetPrice != null && price <= item.targetPrice;
            const sigColors   = signal ? SIGNAL_COLORS[signal.signal] : null;

            return (
              <div
                key={item.id}
                style={{
                  background:    C.s1,
                  border:        `1px solid ${C.border}`,
                  borderRadius:  14,
                  padding:       20,
                  position:      'relative',
                  display:       'flex',
                  flexDirection: 'column',
                  gap:           10,
                  transition:    'border-color 0.18s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#38383f')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
              >
                {/* Delete button */}
                <button
                  onClick={() => handleDelete(item.id)}
                  style={{ position: 'absolute', top: 14, right: 14, color: C.subtle, background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
                  aria-label="Remove from watchlist"
                >×</button>

                {/* Name + ticker */}
                <div className="flex items-center gap-2 pr-6">
                  <span style={{ fontFamily: '"Fraunces", serif', fontSize: 16, color: C.text, fontWeight: 300 }}>
                    {item.stockName}
                  </span>
                  <span style={{ fontSize: 10, color: C.muted, background: C.s2, borderRadius: 4, padding: '2px 7px' }}>
                    {item.ticker}
                  </span>
                </div>

                {/* Price row */}
                <div className="flex items-baseline gap-2">
                  {price != null ? (
                    <>
                      <span style={{ fontFamily: '"Fraunces", serif', fontSize: 24, color: C.text, fontWeight: 300, letterSpacing: '-0.5px' }}>
                        ₹{price.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
                      </span>
                      {change != null && (
                        <span style={{ fontSize: 12, color: change >= 0 ? C.green : C.red }}>
                          {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                        </span>
                      )}
                      {isLive && (
                        <span className="flex items-center gap-1" style={{ fontSize: 11, color: C.green, marginLeft: 'auto' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, display: 'inline-block' }} />
                          Live
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ fontSize: 13, color: C.subtle }}>Price unavailable</span>
                  )}
                </div>

                {/* Target price row */}
                {item.targetPrice != null && (
                  <div className="flex items-center gap-2">
                    <span style={{ fontSize: 12, color: C.muted }}>
                      Your target: ₹{item.targetPrice.toLocaleString('en-IN')}
                    </span>
                    {targetHit && (
                      <span style={{ fontSize: 11, color: C.green, background: 'rgba(78,173,132,0.12)', borderRadius: 20, padding: '2px 8px', fontWeight: 500 }}>
                        Target reached
                      </span>
                    )}
                  </div>
                )}

                {/* AI signal */}
                {isLoading ? (
                  <div className="flex items-center gap-2" style={{ fontSize: 12, color: C.subtle }}>
                    <span style={{ display: 'inline-block', width: 12, height: 12, border: `2px solid ${C.border}`, borderTopColor: C.gold, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    Generating signal…
                  </div>
                ) : signal ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span
                        style={{
                          fontSize:      11,
                          fontWeight:    600,
                          color:         sigColors!.text,
                          background:    sigColors!.bg,
                          borderRadius:  20,
                          padding:       '3px 10px',
                          letterSpacing: '0.04em',
                        }}
                      >
                        {signal.signal}
                      </span>
                      <button
                        onClick={() => fetchSignal(item, price)}
                        title="Refresh AI signal"
                        style={{ color: C.subtle, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
                      >
                        ↻
                      </button>
                    </div>
                    <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, margin: 0, WebkitLineClamp: 2, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {signal.reason}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span style={{ fontSize: 12, color: C.subtle }}>No signal yet</span>
                    <button
                      onClick={() => fetchSignal(item, price)}
                      style={{ color: C.gold, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
                    >
                      Generate signal
                    </button>
                  </div>
                )}

                {/* Footer */}
                <p style={{ fontSize: 11, color: C.subtle, marginTop: 2 }}>
                  Added {formatDate(item.addedAt)}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* CSS for spinner */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
