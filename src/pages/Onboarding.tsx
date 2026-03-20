import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getMockPrice } from '../lib/mockPrices';
import { saveGoalData, markOnboardingComplete } from '../lib/db';
import useAuth from '../hooks/useAuth';
import type { PortfolioStock } from '../components/PortfolioEntry';

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

const HORIZON_OPTIONS = [
  { label: '1 year',   years: 1  },
  { label: '2 years',  years: 2  },
  { label: '3 years',  years: 3  },
  { label: '5 years',  years: 5  },
  { label: '7 years',  years: 7  },
  { label: '10 years', years: 10 },
];

// ── Health score logic (mirrored from Dashboard) ────────────────────────────

interface HealthResult {
  total:           number;
  diversification: number;
  concentration:   number;
  profitability:   number;
  topProblem:      string;
  topAction:       string;
}

function computeOnboardingHealth(portfolio: PortfolioStock[]): HealthResult {
  const fallback: HealthResult = {
    total: 0, diversification: 0, concentration: 0, profitability: 0,
    topProblem: 'Analysing your portfolio…',
    topAction:  'Add holdings to get started.',
  };

  const holdings = portfolio ?? [];
  if (holdings.length === 0) return fallback;

  const priced = holdings
    .map((s) => {
      const price = getMockPrice(s.ticker) ?? s.avgBuyPrice;
      return { ...s, currentPrice: price, currentValue: s.shares * price, pnl: s.shares * (price - s.avgBuyPrice) };
    })
    .filter((s) => s.currentPrice > 0);

  if (priced.length === 0) return fallback;

  const total     = priced.reduce((a, s) => a + s.currentValue, 0);
  const withWeight = priced.map((s) => ({ ...s, weight: total > 0 ? (s.currentValue / total) * 100 : 0 }));

  const n          = withWeight.length;
  const divScore   = n <= 1 ? 5 : n === 2 ? 12 : n === 3 ? 18 : n <= 5 ? 23 : n <= 9 ? 27 : 30;
  const maxW       = n > 0 ? Math.max(...withWeight.map((s) => s.weight)) : 0;
  const conScore   = maxW <= 20 ? 35 : maxW <= 30 ? 27 : maxW <= 40 ? 18 : maxW <= 60 ? 8 : 2;
  const profitable = withWeight.filter((s) => s.pnl > 0).length;
  const profScore  = n > 0 ? Math.round((profitable / n) * 35) : 0;
  const scoreTotal = Math.min(100, divScore + conScore + profScore);

  const heaviest = withWeight.reduce((a, b) => a.weight > b.weight ? a : b);
  let topProblem = '';
  let topAction  = '';

  if (heaviest.weight > 30) {
    topProblem = `${heaviest.ticker} makes up ${heaviest.weight.toFixed(0)}% of your portfolio — that's too much concentration in one stock.`;
    topAction  = `Trim ${heaviest.ticker} to ≤20% weight and move the proceeds into a diversified index fund like NIFTYBEES.`;
  } else if (n < 5) {
    topProblem = `You only hold ${n} position${n !== 1 ? 's' : ''}. With so few stocks, one bad call can hurt your whole portfolio.`;
    topAction  = `Add 2–3 more holdings across different sectors to reduce single-stock risk.`;
  } else if (profScore < 17) {
    const lossCount = n - profitable;
    topProblem = `${lossCount} of your ${n} holdings are currently underwater. That's dragging your overall returns.`;
    topAction  = `Review your loss-making positions. If the thesis has changed, consider cutting losses and redeploying into stronger opportunities.`;
  } else {
    topProblem = `Your portfolio looks reasonably balanced. Focus on consistency and regular SIPs from here.`;
    topAction  = `Keep adding to your winners via SIP. Consider a Nifty 50 index fund as the stable core of your portfolio.`;
  }

  return { total: scoreTotal, diversification: divScore, concentration: conScore, profitability: profScore, topProblem, topAction };
}

function computeCurrentValue(portfolio: PortfolioStock[]): number {
  return (portfolio ?? []).reduce((a, s) => {
    const price = getMockPrice(s.ticker) ?? s.avgBuyPrice;
    return a + s.shares * price;
  }, 0);
}

function computeRequiredSIP(goalAmount: number, years: number, currentValue: number): number {
  if (goalAmount <= 0 || years <= 0) return 0;
  const r        = 0.01; // 12% annual / 12 months
  const months   = years * 12;
  const corpusFV = currentValue * Math.pow(1.12, years);
  const gap      = Math.max(0, goalAmount - corpusFV);
  if (gap === 0) return 0;
  const fvFactor = (Math.pow(1 + r, months) - 1) / r * (1 + r);
  return Math.ceil(gap / fvFactor);
}

// ── SVG Gauge (larger version for onboarding) ──────────────────────────────────

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

function LargeGauge({ score }: { score: number }) {
  const cx = 130, cy = 115, r = 96;
  const startDeg = 120, sweepDeg = 300;
  const track = arcPath(cx, cy, r, startDeg, sweepDeg);
  const fill  = arcPath(cx, cy, r, startDeg, (score / 100) * sweepDeg);
  const col   = score >= 70 ? C.green : score >= 40 ? C.gold : C.red;

  return (
    <svg viewBox="0 0 260 200" width="260" height="200">
      <path d={track} fill="none" stroke={C.s2}  strokeWidth="18" strokeLinecap="round" />
      {score > 0 && (
        <path d={fill}  fill="none" stroke={col} strokeWidth="18" strokeLinecap="round"
          style={{ transition: 'all 0.05s linear' }} />
      )}
      <text x={cx} y={cy + 5} textAnchor="middle" dominantBaseline="middle"
        fontSize="54" fontWeight="700" fill={col} fontFamily='"Fraunces", Georgia, serif'>
        {score}
      </text>
      <text x={cx} y={cy + 34} textAnchor="middle" fontSize="13" fill={C.muted} fontFamily='"DM Sans", Arial, sans-serif'>
        out of 100
      </text>
    </svg>
  );
}

// ── Progress dots ─────────────────────────────────────────────────────────────

function ProgressDots({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          style={{
            width:        n === step ? 24 : 8,
            height:       8,
            borderRadius: 99,
            background:   n < step ? C.gold : n === step ? C.gold : '#2a2a2f',
            transition:   'all 0.3s ease',
            display:      'inline-block',
          }}
        />
      ))}
    </div>
  );
}

// ── Step wrapper with fade transition ─────────────────────────────────────────

function StepWrap({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      opacity:       visible ? 1 : 0,
      transform:     visible ? 'translateY(0)' : 'translateY(10px)',
      transition:    'opacity 0.3s ease, transform 0.3s ease',
      display:       'flex',
      flexDirection: 'column',
      alignItems:    'center',
      gap:           0,
      width:         '100%',
    }}>
      {children}
    </div>
  );
}

// ── Inline loading spinner ─────────────────────────────────────────────────────

function InlineSpinner() {
  return (
    <div style={{
      width:          '100vw',
      height:         '100vh',
      background:     C.bg,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
    }}>
      <div style={{
        fontFamily: '"Fraunces", Georgia, serif',
        fontSize:   '24px',
        color:      C.gold,
        fontStyle:  'italic',
      }}>
        Artha
      </div>
    </div>
  );
}

// ── Number formatter ──────────────────────────────────────────────────────────

function fmt(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function Onboarding() {
  const navigate               = useNavigate();
  const location               = useLocation();
  const { user, loading: authLoading } = useAuth();

  // ── CRASH 4: If auth finishes and there's no user, redirect to auth ──────────
  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth', { replace: true });
    }
  }, [authLoading, user, navigate]);

  // Load portfolio from router state → localStorage fallback
  const portfolio: PortfolioStock[] = (() => {
    const state = location.state as { portfolio?: PortfolioStock[] } | null;
    if (state?.portfolio && state.portfolio.length > 0) return state.portfolio;
    try {
      const raw = localStorage.getItem('artha_portfolio');
      return raw ? (JSON.parse(raw) as PortfolioStock[]) : [];
    } catch { return []; }
  })();

  const health       = computeOnboardingHealth(portfolio ?? []);
  const currentValue = computeCurrentValue(portfolio ?? []);

  // ── Step & transition state ───────────────────────────────────────────────
  const [step,    setStep]    = useState(1);
  const [visible, setVisible] = useState(true);

  function goToStep(n: number) {
    setVisible(false);
    setTimeout(() => { setStep(n); setVisible(true); }, 300);
  }

  // ── CRASH 3 FIX: finishOnboarding always navigates — never leaves user stuck ─

  async function finishOnboarding(dest: 'action' | 'skip') {
    const msg = goalAmount
      ? `Welcome to Artha. Your goal is set. Let's get you to ₹${fmt(Number(goalAmount))}.`
      : 'Welcome to Artha. Your portfolio is ready.';
    try {
      await markOnboardingComplete();
    } catch {
      // Non-fatal — still navigate even if this fails
    }
    // navigate is synchronous — always called regardless of the try/catch above
    navigate('/dashboard', { state: { welcomeToast: msg, actionTaken: dest === 'action' } });
  }

  // ── Step 1 — score count-up animation ────────────────────────────────────
  const [animScore, setAnimScore] = useState(0);
  const animRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (step !== 1) return;
    const target   = health.total ?? 0;
    const duration = 1500;
    const steps    = 60;
    const interval = duration / steps;
    let current    = 0;

    animRef.current = setInterval(() => {
      current += Math.ceil(target / steps);
      if (current >= target) {
        setAnimScore(target);
        clearInterval(animRef.current!);
      } else {
        setAnimScore(current);
      }
    }, interval);

    return () => clearInterval(animRef.current!);
  }, [step, health.total]);

  // ── Step 2 — goal form ────────────────────────────────────────────────────
  const [goalAmount,           setGoalAmount]           = useState('');
  const [horizonYears,         setHorizonYears]         = useState(5);
  const [sipAmount,            setSipAmount]            = useState('');
  const [goalSaving,           setGoalSaving]           = useState(false);
  // New context fields
  const [shortTermGoalAmount,  setShortTermGoalAmount]  = useState('');
  const [shortTermGoalHorizon, setShortTermGoalHorizon] = useState<1 | 2 | null>(null);
  const [riskAppetite,         setRiskAppetite]         = useState<'conservative' | 'moderate' | 'aggressive' | null>(null);
  const [canAffordToLosePct,   setCanAffordToLosePct]   = useState(20);
  const [investmentExperience, setInvestmentExperience] = useState<'beginner' | 'intermediate' | 'experienced' | 'expert' | null>(null);

  const requiredSIP = computeRequiredSIP(Number(goalAmount), horizonYears, currentValue);

  // Auto-fill SIP when goal/horizon changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-fill SIP from computed value
    if (requiredSIP > 0) setSipAmount(String(requiredSIP));
  }, [requiredSIP]);

  async function handleSaveGoal() {
    // CRASH 4: guard — user must exist before Supabase call
    if (!user?.id) { goToStep(3); return; }

    setGoalSaving(true);
    try {
      const amount = Number(goalAmount) || 0;
      const sip    = Number(sipAmount)  || 0;
      const hor    = HORIZON_OPTIONS.find((h) => h.years === horizonYears)?.label ?? `${horizonYears} years`;
      await saveGoalData(
        user.id,
        amount,
        hor,
        horizonYears * 12,
        sip,
        riskAppetite         ?? undefined,
        Number(shortTermGoalAmount) || undefined,
        shortTermGoalHorizon ?? undefined,
        canAffordToLosePct,
        investmentExperience ?? undefined,
      );
    } catch { /* non-fatal */ }
    setGoalSaving(false);
    goToStep(3);
  }

  // ── CRASH 2 FIX: Skip saves safe defaults BEFORE navigating ─────────────────

  const handleSkip = useCallback(async () => {
    try {
      // Save a safe default goal so Dashboard never sees null goal columns
      if (user?.id) {
        await saveGoalData(user.id, 3000000, '7 years', 84, 10000);
      }
      // Mark onboarding done
      await markOnboardingComplete();
    } catch {
      // Non-fatal — navigate anyway so the user never gets stuck
    }
    navigate('/dashboard');
  }, [user?.id, navigate]);

  // ── Score label ──────────────────────────────────────────────────────────
  const scoreLabel = (health.total ?? 0) < 40
    ? 'Your portfolio needs attention.'
    : (health.total ?? 0) <= 60
    ? 'Your portfolio has a solid base, but needs work.'
    : 'Your portfolio is in decent shape.';

  // ── CRASH 5: Show loader while auth is still resolving ────────────────────
  if (authLoading || !user) return <InlineSpinner />;

  // ── CRASH 3: health must be defined before rendering Step 3 ──────────────
  if (!health) return <InlineSpinner />;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight:      '100vh',
      background:     C.bg,
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'flex-start',
      padding:        '48px 24px 80px',
      color:          C.text,
    }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>

      {/* Progress bar */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, marginBottom: 56, width: '100%', maxWidth: 440 }}>
        <ProgressDots step={step} />
        <button
          onClick={() => void handleSkip()}
          style={{ background: 'none', border: 'none', color: C.subtle, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Skip setup →
        </button>
      </div>

      {/* Content area */}
      <div style={{ width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* ── Step 1: Health Score Reveal ─────────────────────────────── */}
        {step === 1 && (
          <StepWrap visible={visible}>
            {/* Large gauge */}
            <LargeGauge score={animScore} />

            {/* Score label */}
            <p style={{
              fontFamily: '"Fraunces", Georgia, serif',
              fontWeight: 300,
              fontSize:   20,
              color:      C.text,
              textAlign:  'center',
              margin:     '8px 0 20px',
              lineHeight: 1.4,
            }}>
              {scoreLabel}
            </p>

            {/* Top problem */}
            <p style={{
              fontSize:   13,
              color:      C.muted,
              lineHeight: 1.8,
              maxWidth:   400,
              textAlign:  'center',
              margin:     '0 0 36px',
            }}>
              <span style={{ color: C.subtle, fontWeight: 500 }}>The main thing holding you back: </span>
              {health.topProblem ?? 'Analysing your portfolio…'}
            </p>

            {/* CTA */}
            <button
              onClick={() => goToStep(2)}
              style={{
                width:        '100%',
                maxWidth:     400,
                background:   C.gold,
                color:        C.bg,
                border:       'none',
                borderRadius: 12,
                padding:      '18px 0',
                fontSize:     16,
                fontWeight:   600,
                cursor:       'pointer',
                fontFamily:   '"DM Sans", Arial, sans-serif',
                transition:   'opacity 0.15s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.opacity = '0.88')}
              onMouseOut={(e)  => (e.currentTarget.style.opacity = '1')}
            >
              Show me what to fix →
            </button>
          </StepWrap>
        )}

        {/* ── Step 2: Set Your Goal ────────────────────────────────────── */}
        {step === 2 && (
          <StepWrap visible={visible}>
            <h2 style={{
              fontFamily: '"Fraunces", Georgia, serif',
              fontWeight: 300,
              fontSize:   28,
              color:      C.text,
              margin:     '0 0 8px',
              textAlign:  'center',
              lineHeight: 1.3,
            }}>
              What are you building toward?
            </h2>
            <p style={{ fontSize: 13, color: C.muted, margin: '0 0 36px', textAlign: 'center' }}>
              This personalises every Artha analysis for you.
            </p>

            {/* Goal amount row */}
            <div style={{ width: '100%', marginBottom: 16 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                Target amount
              </label>
              <div style={{ display: 'flex', alignItems: 'center', background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, padding: '4px 16px', gap: 4 }}>
                <span style={{ fontFamily: '"Fraunces", Georgia, serif', fontSize: 22, color: C.muted }}>₹</span>
                <input
                  type="number"
                  value={goalAmount}
                  onChange={(e) => setGoalAmount(e.target.value)}
                  placeholder="5000000"
                  style={{
                    flex:        1,
                    background:  'none',
                    border:      'none',
                    outline:     'none',
                    fontFamily:  '"Fraunces", Georgia, serif',
                    fontSize:    24,
                    color:       C.text,
                    padding:     '10px 0',
                    colorScheme: 'dark',
                  }}
                />
              </div>
              {goalAmount && (() => {
                const n = Number(goalAmount);
                const hint = n >= 10_000_000
                  ? `= ₹${(n / 10_000_000).toFixed(2)} Cr`
                  : n >= 100_000
                    ? `= ₹${(n / 100_000).toFixed(2)} L`
                    : `= ₹${n.toLocaleString('en-IN')}`;
                return <p style={{ fontSize: 11, color: C.subtle, marginTop: 4 }}>{hint}</p>;
              })()}
            </div>

            {/* Horizon selector */}
            <div style={{ width: '100%', marginBottom: 24 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                In
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {HORIZON_OPTIONS.map((opt) => (
                  <button
                    key={opt.years}
                    onClick={() => setHorizonYears(opt.years)}
                    style={{
                      background:   horizonYears === opt.years ? '#1a1508' : C.s1,
                      border:       `1px solid ${horizonYears === opt.years ? C.gold : C.border}`,
                      borderRadius: 8,
                      padding:      '10px 0',
                      fontSize:     13,
                      color:        horizonYears === opt.years ? C.gold : C.muted,
                      cursor:       'pointer',
                      fontFamily:   '"DM Sans", Arial, sans-serif',
                      transition:   'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Live SIP calculation */}
            {goalAmount && Number(goalAmount) > 0 && (
              <div style={{
                width:        '100%',
                background:   C.s2,
                borderRadius: 10,
                padding:      '14px 16px',
                marginBottom: 20,
              }}>
                {requiredSIP > 0 ? (
                  <p style={{ fontSize: 13, color: C.gold, margin: 0, lineHeight: 1.7 }}>
                    That means saving approximately{' '}
                    <span style={{ fontWeight: 600 }}>₹{fmt(requiredSIP)}/month</span>{' '}
                    at 12% returns, starting from your current ₹{fmt(currentValue)} portfolio.
                  </p>
                ) : (
                  <p style={{ fontSize: 13, color: C.green, margin: 0, lineHeight: 1.7 }}>
                    Great news — your current portfolio is already on track to reach this goal at 12% CAGR. Keep it up.
                  </p>
                )}
              </div>
            )}

            {/* Monthly SIP input */}
            <div style={{ width: '100%', marginBottom: 28 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                I can invest / month
              </label>
              <div style={{ display: 'flex', alignItems: 'center', background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, padding: '4px 16px', gap: 4 }}>
                <span style={{ fontSize: 16, color: C.muted }}>₹</span>
                <input
                  type="number"
                  value={sipAmount}
                  onChange={(e) => setSipAmount(e.target.value)}
                  placeholder="5000"
                  style={{
                    flex:        1,
                    background:  'none',
                    border:      'none',
                    outline:     'none',
                    fontSize:    18,
                    color:       C.text,
                    padding:     '10px 0',
                    fontFamily:  '"DM Sans", Arial, sans-serif',
                    colorScheme: 'dark',
                  }}
                />
                <span style={{ fontSize: 12, color: C.subtle, whiteSpace: 'nowrap' }}>/ month</span>
              </div>
            </div>

            {/* ── Section A: Short-term goal (optional) ─────────────── */}
            <div style={{ width: '100%', marginBottom: 28 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                Short-term goal <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, padding: '4px 12px', gap: 4 }}>
                  <span style={{ fontSize: 14, color: C.muted }}>₹</span>
                  <input
                    type="number"
                    value={shortTermGoalAmount}
                    onChange={(e) => setShortTermGoalAmount(e.target.value)}
                    placeholder="200000"
                    style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 15, color: C.text, padding: '8px 0', fontFamily: '"DM Sans", Arial, sans-serif', colorScheme: 'dark' }}
                  />
                </div>
                {([1, 2] as const).map((yr) => (
                  <button
                    key={yr}
                    onClick={() => setShortTermGoalHorizon(shortTermGoalHorizon === yr ? null : yr)}
                    style={{
                      background:   shortTermGoalHorizon === yr ? '#1a1508' : C.s1,
                      border:       `1px solid ${shortTermGoalHorizon === yr ? C.gold : C.border}`,
                      borderRadius: 8,
                      padding:      '0 16px',
                      fontSize:     13,
                      color:        shortTermGoalHorizon === yr ? C.gold : C.muted,
                      cursor:       'pointer',
                      fontFamily:   '"DM Sans", Arial, sans-serif',
                      whiteSpace:   'nowrap',
                    }}
                  >
                    {yr}yr
                  </button>
                ))}
              </div>
            </div>

            {/* ── Section B: Risk profile ───────────────────────────── */}
            <div style={{ width: '100%', marginBottom: 28 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                Risk appetite
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {([
                  { id: 'conservative', label: 'Conservative', desc: 'Steady & safe' },
                  { id: 'moderate',     label: 'Moderate',     desc: 'Balanced growth' },
                  { id: 'aggressive',   label: 'Aggressive',   desc: 'Max returns' },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setRiskAppetite(riskAppetite === opt.id ? null : opt.id)}
                    style={{
                      background:   riskAppetite === opt.id ? '#1a1508' : C.s1,
                      border:       `1px solid ${riskAppetite === opt.id ? C.gold : C.border}`,
                      borderRadius: 10,
                      padding:      '12px 8px',
                      textAlign:    'center',
                      cursor:       'pointer',
                      fontFamily:   '"DM Sans", Arial, sans-serif',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: riskAppetite === opt.id ? C.gold : C.text, marginBottom: 3 }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: 10, color: C.subtle }}>
                      {opt.desc}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* ── Section C: Loss tolerance slider ─────────────────── */}
            <div style={{ width: '100%', marginBottom: 28 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                I'm okay losing up to{' '}
                <span style={{ color: C.gold, fontWeight: 700, textTransform: 'none', letterSpacing: 0 }}>
                  {canAffordToLosePct}%
                </span>
                {' '}before I panic-sell
              </label>
              <input
                type="range"
                min={5}
                max={50}
                step={5}
                value={canAffordToLosePct}
                onChange={(e) => setCanAffordToLosePct(Number(e.target.value))}
                style={{ width: '100%', accentColor: C.gold, cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 10, color: C.subtle }}>5% (very cautious)</span>
                <span style={{ fontSize: 10, color: C.subtle }}>50% (high tolerance)</span>
              </div>
            </div>

            {/* ── Section D: Investment experience ─────────────────── */}
            <div style={{ width: '100%', marginBottom: 32 }}>
              <label style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.subtle, display: 'block', marginBottom: 8 }}>
                Experience
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {([
                  { id: 'beginner',     label: 'Beginner'      },
                  { id: 'intermediate', label: 'Intermediate'  },
                  { id: 'experienced',  label: 'Experienced'   },
                  { id: 'expert',       label: 'Expert'        },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setInvestmentExperience(investmentExperience === opt.id ? null : opt.id)}
                    style={{
                      background:   investmentExperience === opt.id ? '#1a1508' : C.s1,
                      border:       `1px solid ${investmentExperience === opt.id ? C.gold : C.border}`,
                      borderRadius: 99,
                      padding:      '8px 16px',
                      fontSize:     12,
                      fontWeight:   500,
                      color:        investmentExperience === opt.id ? C.gold : C.muted,
                      cursor:       'pointer',
                      fontFamily:   '"DM Sans", Arial, sans-serif',
                      transition:   'all 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => void handleSaveGoal()}
              disabled={goalSaving}
              style={{
                width:        '100%',
                background:   goalSaving ? '#a0803a' : C.gold,
                color:        C.bg,
                border:       'none',
                borderRadius: 12,
                padding:      '18px 0',
                fontSize:     16,
                fontWeight:   600,
                cursor:       goalSaving ? 'not-allowed' : 'pointer',
                fontFamily:   '"DM Sans", Arial, sans-serif',
                transition:   'opacity 0.15s',
                marginBottom: 12,
              }}
            >
              {goalSaving ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-block', width: 14, height: 14, border: `2px solid ${C.bg}40`, borderTopColor: C.bg, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  Saving…
                </span>
              ) : 'Lock in my goal →'}
            </button>

            <button
              onClick={() => goToStep(3)}
              style={{ background: 'none', border: 'none', color: C.subtle, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Set goal later →
            </button>
          </StepWrap>
        )}

        {/* ── Step 3: One Action ───────────────────────────────────────── */}
        {step === 3 && (
          <StepWrap visible={visible}>
            <h2 style={{
              fontFamily: '"Fraunces", Georgia, serif',
              fontWeight: 300,
              fontSize:   28,
              color:      C.text,
              margin:     '0 0 8px',
              textAlign:  'center',
              lineHeight: 1.3,
            }}>
              Your first move
            </h2>
            <p style={{ fontSize: 13, color: C.muted, margin: '0 0 32px', textAlign: 'center' }}>
              One specific action that will make the biggest difference.
            </p>

            {/* Action card */}
            <div style={{
              width:        '100%',
              background:   C.s1,
              border:       `1px solid ${C.gold}`,
              borderRadius: 14,
              padding:      '24px',
              marginBottom: 28,
            }}>
              <p style={{
                fontSize:      10,
                fontWeight:    500,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color:         C.gold,
                margin:        '0 0 14px',
              }}>
                Recommended action
              </p>
              <p style={{
                fontSize:   14,
                color:      C.text,
                lineHeight: 1.8,
                margin:     '0 0 12px',
              }}>
                {health.topAction ?? 'Keep adding to your winners via SIP.'}
              </p>
              <p style={{ fontSize: 12, color: C.muted, margin: 0, lineHeight: 1.6 }}>
                Addressing this directly improves your health score — starting from{' '}
                <span style={{ color: (health.total ?? 0) >= 70 ? C.green : (health.total ?? 0) >= 40 ? C.gold : C.red, fontWeight: 600 }}>
                  {health.total ?? 0}/100
                </span>
                .
              </p>
            </div>

            {/* CRASH 3 FIX: navigate() called synchronously, no await */}
            <button
              onClick={() => void finishOnboarding('action')}
              style={{
                width:        '100%',
                background:   C.gold,
                color:        C.bg,
                border:       'none',
                borderRadius: 12,
                padding:      '18px 0',
                fontSize:     16,
                fontWeight:   600,
                cursor:       'pointer',
                fontFamily:   '"DM Sans", Arial, sans-serif',
                marginBottom: 12,
                transition:   'opacity 0.15s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.opacity = '0.88')}
              onMouseOut={(e)  => (e.currentTarget.style.opacity = '1')}
            >
              I'll do this →
            </button>

            <button
              onClick={() => void finishOnboarding('skip')}
              style={{
                width:        '100%',
                background:   'transparent',
                color:        C.muted,
                border:       `1px solid ${C.border}`,
                borderRadius: 12,
                padding:      '16px 0',
                fontSize:     15,
                cursor:       'pointer',
                fontFamily:   '"DM Sans", Arial, sans-serif',
              }}
            >
              Skip for now
            </button>
          </StepWrap>
        )}
      </div>
    </div>
  );
}
