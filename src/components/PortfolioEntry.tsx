import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMockPrice } from '../lib/mockPrices';
import useAuth from '../hooks/useAuth';
import { savePortfolio, hasPortfolio, saveGoalData } from '../lib/db';
import { supabase } from '../lib/supabase';
import CSVImport from './CSVImport';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PortfolioStock {
  id: string;
  name: string;
  ticker: string;
  shares: number;
  avgBuyPrice: number;
  buyDate?: string; // ISO date string — populated from Groww Excel import
}

interface FormState {
  name: string;
  ticker: string;
  shares: string;
  avgBuyPrice: string;
}

interface FormErrors {
  name?: string;
  ticker?: string;
  shares?: string;
  avgBuyPrice?: string;
}

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

// ── Helpers ────────────────────────────────────────────────────────────────────

const EMPTY_FORM: FormState = { name: '', ticker: '', shares: '', avgBuyPrice: '' };

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = 'Required';
  if (!form.ticker.trim()) errors.ticker = 'Required';
  if (!form.shares || isNaN(Number(form.shares)) || Number(form.shares) <= 0)
    errors.shares = 'Enter a positive number';
  if (!form.avgBuyPrice || isNaN(Number(form.avgBuyPrice)) || Number(form.avgBuyPrice) <= 0)
    errors.avgBuyPrice = 'Enter a positive number';
  return errors;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Field({
  label, name, value, onChange, placeholder, type = 'text', error, helperText,
}: {
  label: string;
  name: keyof FormState;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  type?: string;
  error?: string;
  helperText?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.muted }}>
        {label}
      </label>
      <input
        name={name}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        className={`entry-input${error ? ' error' : ''}`}
        style={{ colorScheme: 'dark' }}
      />
      {error      && <span style={{ color: C.red,    fontSize: 11 }}>{error}</span>}
      {helperText && <span style={{ color: C.subtle, fontSize: 11 }}>{helperText}</span>}
    </div>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      style={{ animation: 'spin 0.8s linear infinite', marginRight: 8, verticalAlign: 'middle' }}
    >
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="40 20" />
    </svg>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function PortfolioEntry() {
  const navigate = useNavigate();
  const { user }  = useAuth();
  const [portfolio,  setPortfolio] = useState<PortfolioStock[]>([]);
  const [form,       setForm]      = useState<FormState>(EMPTY_FORM);
  const [errors,     setErrors]    = useState<FormErrors>({});
  const [submitted,  setSubmitted] = useState(false);
  const [mode,       setMode]      = useState<'manual' | 'csv'>('manual');
  const [saving,     setSaving]    = useState(false);
  const [addedToast, setAddedToast] = useState<string | null>(null);

  // ── Form handlers ────────────────────────────────────────────────────────────

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (submitted) setErrors((prev) => ({ ...prev, [name]: undefined }));
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const errs = validate(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    const stock: PortfolioStock = {
      id:          `${Date.now()}-${Math.random()}`,
      name:        form.name.trim(),
      ticker:      form.ticker.trim().toUpperCase(),
      shares:      Number(form.shares),
      avgBuyPrice: Number(form.avgBuyPrice),
    };

    setPortfolio((prev) => [...prev, stock]);
    setForm(EMPTY_FORM);
    setErrors({});
    setSubmitted(false);

    // Confirmation toast
    const price = getMockPrice(stock.ticker);
    const toastMsg = price !== null
      ? `${stock.ticker} added — current price ₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${stock.ticker} added`;
    setAddedToast(toastMsg);
    setTimeout(() => setAddedToast(null), 2000);
  }

  function handleRemove(id: string) {
    setPortfolio((prev) => prev.filter((s) => s.id !== id));
  }

  async function persistAndNavigate(stocks: PortfolioStock[]) {
    localStorage.setItem('artha_portfolio', JSON.stringify(stocks));
    let isFirstTime = false;
    if (user) {
      isFirstTime = !(await hasPortfolio(user.id));
      const saveResult = await savePortfolio(user.id, stocks);
      if (saveResult.error) {
        console.error('Failed to save portfolio to Supabase:', saveResult.error);
      }
      // Mark onboarding complete so future logins (including Google OAuth) route correctly
      await supabase.auth.updateUser({ data: { onboarding_complete: true } });
      if (isFirstTime) {
        // Seed default goal data so the dashboard is never empty for new users
        await saveGoalData(user.id, 30_000_000, '7 years', 84, 10_000);
      }
    }
    if (isFirstTime) {
      navigate('/onboarding', { state: { portfolio: stocks } });
    } else {
      navigate('/dashboard');
    }
  }

  function handleCSVAnalyze(stocks: PortfolioStock[]) {
    void persistAndNavigate(stocks);
  }

  async function handleAnalyze() {
    setSaving(true);
    await persistAndNavigate(portfolio);
    setSaving(false);
  }

  // ── Derived totals ───────────────────────────────────────────────────────────

  const rows = portfolio.map((stock) => {
    const currentPrice = getMockPrice(stock.ticker);
    const invested     = stock.shares * stock.avgBuyPrice;
    if (currentPrice === null)
      return { ...stock, currentPrice: null, invested, currentValue: null, pnl: null, pnlPct: null };
    const currentValue = stock.shares * currentPrice;
    const pnl          = currentValue - invested;
    const pnlPct       = (pnl / invested) * 100;
    return { ...stock, currentPrice, invested, currentValue, pnl, pnlPct };
  });

  // ── Render ───────────────────────────────────────────────────────────────────

  const hasHoldings = portfolio.length > 0;

  return (
    <div className="entry-split" style={{ margin: 0, padding: 0, border: 'none', position: 'relative' }}>

      {/* Confirmation toast */}
      {addedToast && (
        <div
          className="glass-panel"
          style={{
            position:      'fixed',
            bottom:        32,
            left:          '50%',
            transform:     'translateX(-50%)',
            padding:       '12px 24px',
            fontSize:      13,
            color:         C.green,
            fontWeight:    500,
            zIndex:        9999,
            whiteSpace:    'nowrap',
            pointerEvents: 'none',
            display:       'flex',
            alignItems:    'center',
            gap:           8,
            animation:     'fadeInUp 0.25s ease-out',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: 'rgba(78,173,132,0.15)', fontSize: 11 }}>
            ✓
          </span>
          {addedToast}
        </div>
      )}

      {/* ── Left branding panel ─────────────────────────────────────────────── */}
      <div className="entry-left" style={{ background: '#08080a' }}>
        <div className="entry-left-inner" style={{ position: 'relative', zIndex: 1 }}>

          {/* Animated glow behind logo */}
          <div style={{
            position: 'absolute',
            top: '10%',
            left: '50%',
            transform: 'translate(-50%, -30%)',
            width: 280,
            height: 280,
            borderRadius: '50%',
            background: `radial-gradient(circle, rgba(212,168,67,0.08) 0%, rgba(212,168,67,0.02) 50%, transparent 70%)`,
            filter: 'blur(40px)',
            animation: 'pulseGlow 4s ease-in-out infinite',
            pointerEvents: 'none',
          }} />

          {/* Logo */}
          <h1 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 96, letterSpacing: '-3px', color: C.text, margin: 0, lineHeight: 1, position: 'relative' }}>
            Arth<em style={{ color: C.gold, fontStyle: 'italic' }}>a</em>
          </h1>

          {/* Tagline */}
          <p style={{ marginTop: 20, fontSize: 18, color: C.muted, lineHeight: 1.8, margin: '20px 0 0', letterSpacing: '0.01em' }}>
            Portfolio intelligence for the Indian investor
          </p>

          {/* Divider */}
          <div style={{ width: 48, height: 1, background: `linear-gradient(to right, transparent, ${C.gold}44, transparent)`, margin: '36px 0' }} />

          {/* Feature pills */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', width: '100%' }}>
            {['AI Health Score', 'Scenario Simulation', 'Goal Tracker'].map((pill) => (
              <span
                key={pill}
                style={{
                  background:   'rgba(255,255,255,0.02)',
                  border:       `1px solid ${C.border}`,
                  borderRadius: 99,
                  padding:      '10px 28px',
                  fontSize:     14,
                  color:        C.subtle,
                  width:        'fit-content',
                  letterSpacing: '0.04em',
                  display:      'flex',
                  alignItems:   'center',
                  gap:          8,
                }}
              >
                <span style={{ color: C.gold, fontSize: 10 }}>&#9670;</span>
                {pill}
              </span>
            ))}
          </div>
        </div>

        {/* Bottom footnote */}
        <p
          style={{
            position:   'absolute',
            bottom:     28,
            left:       0,
            right:      0,
            fontSize:   13,
            color:      '#4a4a45',
            fontStyle:  'italic',
            textAlign:  'center',
            padding:    '0 60px',
            margin:     0,
            lineHeight: 1.6,
          }}
        >
          Built for ₹50,000 portfolios and ₹50 crore portfolios alike.
        </p>
      </div>

      {/* ── Right form panel ────────────────────────────────────────────────── */}
      <div
        className="entry-right"
        style={{ justifyContent: hasHoldings ? 'flex-start' : 'center' }}
      >
        <div className="entry-right-inner">

          {/* Heading */}
          <div>
            <h2 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 30, letterSpacing: '-0.5px', color: C.text, margin: '0 0 8px' }}>
              Build your portfolio
            </h2>
            <p style={{ fontSize: 13, color: C.muted, margin: 0, lineHeight: 1.6 }}>
              Add holdings below. Live P&amp;L updates automatically.
            </p>
          </div>

          {/* Mode toggle — pill segmented control */}
          <div style={{
            display:      'flex',
            background:   C.s2,
            border:       `1px solid ${C.border}`,
            borderRadius: 12,
            padding:      4,
            gap:          0,
          }}>
            {(['manual', 'csv'] as const).map((m) => {
              const active = mode === m;
              const labels = { manual: 'Manual Entry', csv: 'Import CSV' };
              const subs   = { manual: 'Add one by one', csv: 'Groww or Zerodha' };
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    flex:           1,
                    background:     active ? C.s1 : 'transparent',
                    border:         'none',
                    borderRadius:   10,
                    padding:        '12px 16px',
                    cursor:         'pointer',
                    textAlign:      'center',
                    transition:     'all 0.2s ease',
                    display:        'flex',
                    flexDirection:  'column',
                    alignItems:     'center',
                    gap:            2,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? C.text : C.muted, transition: 'color 0.2s ease' }}>
                    {labels[m]}
                  </span>
                  <span style={{ fontSize: 10, color: C.subtle }}>
                    {subs[m]}
                  </span>
                </button>
              );
            })}
          </div>

          {/* ── Manual entry form ─────────────────────────────────────────── */}
          {mode === 'manual' && (
            <>
              <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 20px' }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.muted, margin: 0 }}>
                    Add a holding
                  </p>
                  <p style={{ fontSize: 11, color: C.subtle, fontStyle: 'italic', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6 }}>
                      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3v5h-3V7z" fill="currentColor"/>
                    </svg>
                    Your portfolio is private and never shared.
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Field label="Stock Name"   name="name"        value={form.name}        onChange={handleChange} placeholder="e.g. Reliance Industries" error={errors.name} />
                  <Field label="Ticker"        name="ticker"      value={form.ticker}      onChange={handleChange} placeholder="e.g. RELIANCE"            error={errors.ticker}      helperText="NSE symbol — e.g. RELIANCE, HDFCBANK, INFY" />
                  <Field label="Shares"        name="shares"      value={form.shares}      onChange={handleChange} placeholder="e.g. 10"   type="number"  error={errors.shares} />
                  <Field label="Avg Buy Price" name="avgBuyPrice" value={form.avgBuyPrice} onChange={handleChange} placeholder="e.g. 2,450.00" type="number"  error={errors.avgBuyPrice} helperText="Price per share when you bought it" />
                </div>

                <button
                  type="submit"
                  style={{
                    display:      'flex',
                    alignItems:   'center',
                    justifyContent: 'center',
                    gap:          6,
                    marginLeft:   'auto',
                    marginTop:    20,
                    width:        'fit-content',
                    background:   'transparent',
                    color:        C.gold,
                    border:       `1px solid ${C.gold}44`,
                    borderRadius: 10,
                    padding:      '10px 24px',
                    fontSize:     13,
                    fontWeight:   500,
                    cursor:       'pointer',
                    fontFamily:   "'DM Sans', sans-serif",
                    transition:   'all 0.2s ease',
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = `${C.gold}12`; e.currentTarget.style.borderColor = `${C.gold}88`; }}
                  onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = `${C.gold}44`; }}
                >
                  <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add Stock
                </button>
              </form>

              {/* Holdings list */}
              {portfolio.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.muted, margin: 0 }}>
                      {portfolio.length} holding{portfolio.length !== 1 ? 's' : ''} added
                    </p>
                    <p style={{ fontSize: 11, color: C.subtle, margin: 0 }}>
                      ₹{fmt(rows.reduce((s, r) => s + r.invested, 0), 0)} invested
                    </p>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {rows.map((row, idx) => (
                      <div
                        key={row.id}
                        className="artha-card"
                        style={{
                          display:        'flex',
                          alignItems:     'center',
                          justifyContent: 'space-between',
                          gap:            16,
                          padding:        '16px 20px',
                          animation:      `fadeInUp 0.25s ease-out ${idx * 0.05}s both`,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 15, fontWeight: 500, color: C.text }}>{row.name}</span>
                          <span style={{ fontSize: 11, color: C.subtle, fontWeight: 500, letterSpacing: '0.04em' }}>{row.ticker}</span>
                        </div>
                        <span style={{ fontSize: 13, color: C.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          {row.shares} shares &middot; ₹{fmt(row.avgBuyPrice)}
                        </span>
                        <button
                          onClick={() => handleRemove(row.id)}
                          style={{
                            background:   'transparent',
                            border:       '1px solid transparent',
                            color:        C.subtle,
                            cursor:       'pointer',
                            fontSize:     18,
                            lineHeight:   1,
                            padding:      '4px 8px',
                            flexShrink:   0,
                            fontFamily:   'inherit',
                            borderRadius: 6,
                            transition:   'all 0.15s ease',
                            display:      'flex',
                            alignItems:   'center',
                            justifyContent: 'center',
                          }}
                          aria-label={`Remove ${row.name}`}
                          onMouseOver={(e) => { e.currentTarget.style.color = C.red; e.currentTarget.style.background = 'rgba(224,82,82,0.08)'; e.currentTarget.style.borderColor = 'rgba(224,82,82,0.2)'; }}
                          onMouseOut={(e)  => { e.currentTarget.style.color = C.subtle; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
                        >
                          &#215;
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Analyse button */}
                  <button
                    onClick={handleAnalyze}
                    disabled={saving}
                    style={{
                      marginTop:    4,
                      background:   saving ? '#a0803a' : C.gold,
                      color:        C.bg,
                      border:       'none',
                      borderRadius: 14,
                      padding:      '20px 0',
                      fontSize:     17,
                      fontWeight:   600,
                      cursor:       saving ? 'not-allowed' : 'pointer',
                      width:        '100%',
                      fontFamily:   "'DM Sans', sans-serif",
                      transition:   'all 0.2s ease',
                      opacity:      saving ? 0.85 : 1,
                      letterSpacing: '0.01em',
                      display:      'flex',
                      alignItems:   'center',
                      justifyContent: 'center',
                    }}
                    onMouseOver={(e) => { if (!saving) { e.currentTarget.style.background = '#e8bc5a'; e.currentTarget.style.boxShadow = '0 0 20px rgba(212,168,67,0.15)'; } }}
                    onMouseOut={(e)  => { if (!saving) { e.currentTarget.style.background = C.gold; e.currentTarget.style.boxShadow = 'none'; } }}
                  >
                    {saving && <Spinner />}
                    {saving ? 'Saving...' : 'Analyse Portfolio  \u2192'}
                  </button>
                </div>
              )}

              {/* Empty state */}
              {portfolio.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.15 }}>
                    &#9670;
                  </div>
                  <p style={{ fontSize: 15, color: C.subtle, margin: '0 0 6px', lineHeight: 1.6 }}>
                    No holdings yet
                  </p>
                  <p style={{ fontSize: 13, color: '#3a3a36', margin: 0, lineHeight: 1.6 }}>
                    Add your first stock above to get started.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── CSV import panel ──────────────────────────────────────────── */}
          {mode === 'csv' && (
            <CSVImport onAnalyze={handleCSVAnalyze} />
          )}

        </div>
      </div>

      {/* Inline keyframes */}
      <style>{`
        @keyframes pulseGlow {
          0%, 100% { opacity: 0.6; transform: translate(-50%, -30%) scale(1); }
          50% { opacity: 1; transform: translate(-50%, -30%) scale(1.08); }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
