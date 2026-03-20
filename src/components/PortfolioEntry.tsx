import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMockPrice } from '../lib/mockPrices';
import useAuth from '../hooks/useAuth';
import { savePortfolio, hasPortfolio, saveGoalData } from '../lib/db';
import { supabase } from '../lib/supabase';
import { importScreenshot } from '../lib/gemini';
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
      <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase', color: C.subtle }}>
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

// ── Screenshot import component ────────────────────────────────────────────────

function ScreenshotImport({ onAnalyze }: { onAnalyze: (stocks: PortfolioStock[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [preview,  setPreview]  = useState<Array<{ name: string; ticker: string; shares: number; avgBuyPrice: number }> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const holdings = await importScreenshot(base64, file.type || 'image/jpeg');
      if (holdings.length === 0) {
        setError('No holdings found in screenshot. Try a clearer image showing your positions.');
      } else {
        setPreview(holdings);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse screenshot');
    } finally {
      setLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void processFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
  }

  function handleConfirm() {
    if (!preview) return;
    const stocks: PortfolioStock[] = preview.map((h) => ({
      id:          `${Date.now()}-${Math.random()}`,
      name:        h.name,
      ticker:      h.ticker,
      shares:      h.shares,
      avgBuyPrice: h.avgBuyPrice,
    }));
    onAnalyze(stocks);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}>

      {/* Drop zone — only shown before parsing */}
      {!preview && !loading && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border:       `2px dashed ${dragging ? C.gold : C.border}`,
            borderRadius: 14,
            padding:      '48px 24px',
            textAlign:    'center',
            cursor:       'pointer',
            background:   dragging ? '#1a15081a' : C.s1,
            transition:   'border-color 0.15s ease, background 0.15s ease',
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 12 }}>📷</div>
          <p style={{ fontSize: 14, color: C.text, margin: '0 0 6px', fontWeight: 500 }}>
            Drop your portfolio screenshot here
          </p>
          <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>
            Works with Groww, Zerodha, Kite, or any brokerage app — click to browse
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>
      )}

      {/* Scanning state */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: C.muted, fontSize: 14 }}>
          <div style={{
            width:        28,
            height:       28,
            borderRadius: '50%',
            border:       `2px solid ${C.gold}`,
            borderTopColor: 'transparent',
            animation:    'spin 0.8s linear infinite',
            margin:       '0 auto 14px',
          }} />
          Scanning screenshot with AI…
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          color:        C.red,
          fontSize:     13,
          padding:      '12px 16px',
          background:   'rgba(224,82,82,0.06)',
          border:       '1px solid rgba(224,82,82,0.2)',
          borderRadius: 10,
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); fileInputRef.current?.click(); }}
            style={{ background: 'none', border: 'none', color: C.gold, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', fontFamily: 'inherit' }}
          >
            Try again
          </button>
        </div>
      )}

      {/* Preview table */}
      {preview && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: C.gold, margin: 0 }}>
            ✦ Found {preview.length} holding{preview.length !== 1 ? 's' : ''}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preview.map((h, i) => (
              <div
                key={i}
                style={{
                  background:     C.s1,
                  border:         `1px solid ${C.border}`,
                  borderRadius:   10,
                  padding:        '14px 16px',
                  display:        'flex',
                  alignItems:     'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{h.name}</span>
                  <span style={{ fontSize: 12, color: C.muted, marginLeft: 10 }}>{h.ticker}</span>
                </div>
                <span style={{ fontSize: 13, color: C.muted }}>
                  {h.shares} shares · ₹{h.avgBuyPrice > 0 ? fmt(h.avgBuyPrice) : '—'}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              onClick={() => { setPreview(null); setError(null); }}
              style={{
                flex:         1,
                background:   'none',
                border:       `1px solid ${C.border}`,
                borderRadius: 10,
                padding:      '12px 0',
                fontSize:     13,
                color:        C.muted,
                cursor:       'pointer',
                fontFamily:   '"DM Sans", sans-serif',
              }}
            >
              Try different image
            </button>
            <button
              onClick={handleConfirm}
              style={{
                flex:         2,
                background:   C.gold,
                border:       'none',
                borderRadius: 10,
                padding:      '12px 0',
                fontSize:     14,
                fontWeight:   500,
                color:        C.bg,
                cursor:       'pointer',
                fontFamily:   '"DM Sans", sans-serif',
              }}
              onMouseOver={(e) => (e.currentTarget.style.opacity = '0.88')}
              onMouseOut={(e)  => (e.currentTarget.style.opacity = '1')}
            >
              Confirm &amp; Analyse →
            </button>
          </div>
        </div>
      )}
    </div>
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
        <div style={{
          position:     'fixed',
          bottom:       32,
          left:         '50%',
          transform:    'translateX(-50%)',
          background:   'rgba(78,173,132,0.12)',
          border:       '1px solid rgba(78,173,132,0.35)',
          borderRadius: 10,
          padding:      '10px 20px',
          fontSize:     13,
          color:        C.green,
          fontWeight:   500,
          zIndex:       9999,
          whiteSpace:   'nowrap',
          pointerEvents: 'none',
        }}>
          ✓ {addedToast}
        </div>
      )}

      {/* ── Left branding panel ─────────────────────────────────────────────── */}
      <div className="entry-left">
        <div className="entry-left-inner">

          {/* Logo */}
          <h1 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 120, letterSpacing: '-4px', color: C.text, margin: 0, lineHeight: 1 }}>
            Arth<em style={{ color: C.gold, fontStyle: 'italic' }}>a</em>
          </h1>

          {/* Tagline */}
          <p style={{ marginTop: 28, fontSize: 22, color: C.muted, lineHeight: 1.8, margin: '28px 0 0' }}>
            Portfolio intelligence for the Indian investor
          </p>

          {/* Feature pills */}
          <div style={{ marginTop: 52, marginBottom: 60, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', width: '100%' }}>
            {['✦ AI Health Score', '✦ Scenario Simulation', '✦ Goal Tracker'].map((pill) => (
              <span
                key={pill}
                style={{
                  background:   C.s2,
                  border:       `1px solid ${C.border}`,
                  borderRadius: 99,
                  padding:      '13px 32px',
                  fontSize:     18,
                  color:        C.muted,
                  width:        'fit-content',
                }}
              >
                {pill}
              </span>
            ))}
          </div>
        </div>

        {/* Bottom footnote */}
        <p
          style={{
            position:   'absolute',
            bottom:     24,
            left:       0,
            right:      0,
            fontSize:   15,
            color:      C.subtle,
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
            <h2 style={{ fontFamily: '"Fraunces", serif', fontWeight: 300, fontSize: 28, letterSpacing: '-0.5px', color: C.text, margin: '0 0 6px' }}>
              Build your portfolio
            </h2>
            <p style={{ fontSize: 12, color: C.muted, margin: '0 0 24px' }}>
              Add holdings below. Live P&amp;L updates automatically.
            </p>
          </div>

          {/* Mode toggle cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {(['manual', 'csv'] as const).map((m) => {
              const active = mode === m;
              const meta = {
                manual: { title: 'Manual',     sub: 'Enter one by one' },
                csv:    { title: 'Import CSV', sub: 'Groww or Zerodha export' },
              };
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    background:    active ? '#1a1508' : C.s1,
                    border:        `1px solid ${active ? C.gold : C.border}`,
                    borderRadius:  10,
                    padding:       '14px 14px',
                    cursor:        'pointer',
                    textAlign:     'left',
                    display:       'flex',
                    flexDirection: 'column',
                    gap:           3,
                    transition:    'border-color 0.15s ease, background 0.15s ease',
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 500, color: C.text }}>{meta[m].title}</span>
                  <span style={{ fontSize: 10, color: C.subtle, marginTop: 2 }}>{meta[m].sub}</span>
                </button>
              );
            })}
          </div>

          {/* ── Manual entry form ─────────────────────────────────────────── */}
          {mode === 'manual' && (
            <>
              <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 16px' }}>
                  <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.subtle, margin: 0 }}>Add a holding</p>
                  <p style={{ fontSize: 11, color: C.subtle, fontStyle: 'italic', margin: 0 }}>Your portfolio is private and never shared.</p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Stock Name"   name="name"        value={form.name}        onChange={handleChange} placeholder="e.g. Reliance Industries" error={errors.name} />
                  <Field label="Ticker"        name="ticker"      value={form.ticker}      onChange={handleChange} placeholder="e.g. RELIANCE"            error={errors.ticker}      helperText="NSE symbol — e.g. RELIANCE, HDFCBANK, INFY" />
                  <Field label="Shares"        name="shares"      value={form.shares}      onChange={handleChange} placeholder="e.g. 10"   type="number"  error={errors.shares} />
                  <Field label="Avg Buy Price" name="avgBuyPrice" value={form.avgBuyPrice} onChange={handleChange} placeholder="e.g. 2,450.00" type="number"  error={errors.avgBuyPrice} helperText="Price per share when you bought it" />
                </div>

                <button
                  type="submit"
                  style={{
                    display:      'block',
                    marginLeft:   'auto',
                    marginTop:    16,
                    width:        'fit-content',
                    background:   C.gold,
                    color:        C.bg,
                    border:       'none',
                    borderRadius: 8,
                    padding:      '10px 24px',
                    fontSize:     13,
                    fontWeight:   500,
                    cursor:       'pointer',
                    fontFamily:   "'DM Sans', sans-serif",
                    transition:   'opacity 0.15s ease',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.opacity = '0.85')}
                  onMouseOut={(e)  => (e.currentTarget.style.opacity = '1')}
                >
                  + Add Stock
                </button>
              </form>

              {/* Holdings list */}
              {portfolio.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <p style={{ fontSize: 15, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, margin: 0 }}>
                    {portfolio.length} holding{portfolio.length !== 1 ? 's' : ''} added
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {rows.map((row) => (
                      <div
                        key={row.id}
                        style={{
                          background:     C.s1,
                          border:         `1px solid ${C.border}`,
                          borderRadius:   12,
                          padding:        '20px 24px',
                          display:        'flex',
                          alignItems:     'center',
                          justifyContent: 'space-between',
                          gap:            20,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 20, fontWeight: 500, color: C.text }}>{row.name}</span>
                          <span style={{ fontSize: 15, color: C.muted, marginLeft: 12 }}>{row.ticker}</span>
                        </div>
                        <span style={{ fontSize: 17, color: C.muted, whiteSpace: 'nowrap' }}>
                          {row.shares} shares · ₹{fmt(row.avgBuyPrice)}
                        </span>
                        <button
                          onClick={() => handleRemove(row.id)}
                          style={{
                            background: 'none',
                            border:     'none',
                            color:      C.subtle,
                            cursor:     'pointer',
                            fontSize:   28,
                            lineHeight: 1,
                            padding:    '0 4px',
                            flexShrink: 0,
                            fontFamily: 'inherit',
                          }}
                          aria-label={`Remove ${row.name}`}
                          onMouseOver={(e) => (e.currentTarget.style.color = C.red)}
                          onMouseOut={(e)  => (e.currentTarget.style.color = C.subtle)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Analyse button */}
                  <button
                    onClick={handleAnalyze}
                    disabled={saving}
                    style={{
                      marginTop:    8,
                      background:   saving ? '#a0803a' : C.gold,
                      color:        C.bg,
                      border:       'none',
                      borderRadius: 14,
                      padding:      '22px 0',
                      fontSize:     20,
                      fontWeight:   500,
                      cursor:       saving ? 'not-allowed' : 'pointer',
                      width:        '100%',
                      fontFamily:   "'DM Sans', sans-serif",
                      transition:   'background 0.15s ease',
                      opacity:      saving ? 0.85 : 1,
                    }}
                    onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#f0c96a'; }}
                    onMouseOut={(e)  => { if (!saving) e.currentTarget.style.background = C.gold; }}
                  >
                    {saving ? 'Saving…' : 'Analyse Portfolio →'}
                  </button>
                </div>
              )}

              {/* Empty state */}
              {portfolio.length === 0 && (
                <p style={{ fontSize: 18, color: C.subtle, textAlign: 'center', padding: '40px 0', margin: 0 }}>
                  Your holdings will appear here once you add a stock.
                </p>
              )}
            </>
          )}

          {/* ── CSV import panel ──────────────────────────────────────────── */}
          {mode === 'csv' && (
            <CSVImport onAnalyze={handleCSVAnalyze} />
          )}

        </div>
      </div>
    </div>
  );
}
