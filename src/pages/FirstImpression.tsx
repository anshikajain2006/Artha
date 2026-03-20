import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuth from '../hooks/useAuth';
import { loadPortfolio } from '../lib/db';
import { getMockPrice } from '../lib/mockPrices';
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

// ── Count-up hook ──────────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 2000, delay = 500): number {
  const [value, setValue] = useState(0);
  const rafRef            = useRef<number>(0);

  useEffect(() => {
    setValue(0);
    const timeout = setTimeout(() => {
      const start = performance.now();
      function step(now: number) {
        const elapsed  = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased    = 1 - Math.pow(1 - progress, 3); // cubic ease-out
        setValue(parseFloat((eased * target).toFixed(2)));
        if (progress < 1) rafRef.current = requestAnimationFrame(step);
      }
      rafRef.current = requestAnimationFrame(step);
    }, delay);
    return () => { clearTimeout(timeout); cancelAnimationFrame(rafRef.current); };
  }, [target, duration, delay]);

  return value;
}

// ── First Impression ──────────────────────────────────────────────────────────

export default function FirstImpression() {
  const navigate       = useNavigate();
  const { user }       = useAuth();
  const [ready,  setReady]  = useState(false);
  const [pnlPct, setPnlPct] = useState(0);
  const [niftyPct]          = useState(12); // assumed annual Nifty benchmark
  const [stockCount, setStockCount] = useState(0);

  // Load portfolio and compute P&L%
  useEffect(() => {
    async function load() {
      let holdings: PortfolioStock[] | null = null;

      if (user) {
        holdings = await loadPortfolio(user.id).catch(() => null);
      }
      if (!holdings) {
        const local = localStorage.getItem('artha_portfolio');
        if (local) holdings = JSON.parse(local) as PortfolioStock[];
      }

      if (!holdings || holdings.length === 0) {
        // No data — just go to dashboard
        localStorage.setItem('artha_first_impression_shown', '1');
        navigate('/dashboard', { replace: true });
        return;
      }

      let totalInvested = 0;
      let totalValue    = 0;
      for (const h of holdings) {
        const price     = getMockPrice(h.ticker) ?? h.avgBuyPrice;
        totalInvested  += h.avgBuyPrice * h.shares;
        totalValue     += price * h.shares;
      }

      const pct = totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0;
      setPnlPct(pct);
      setStockCount(holdings.length);
      setReady(true);
    }
    void load();
  }, [user, navigate]);

  const countedPnl   = useCountUp(pnlPct,    2000, 600);
  const countedNifty = useCountUp(niftyPct,   1800, 500);
  const countedCount = useCountUp(stockCount, 1200, 400);

  function enter() {
    localStorage.setItem('artha_first_impression_shown', '1');
    navigate('/dashboard', { replace: true });
  }

  if (!ready) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: C.gold, fontFamily: '"Fraunces", Georgia, serif', fontSize: 24, fontStyle: 'italic' }}>Artha</span>
      </div>
    );
  }

  const portfolioColor = pnlPct >= niftyPct ? C.green : pnlPct >= 0 ? C.gold : C.red;
  const niftyColor     = C.muted;
  const beatNifty      = pnlPct >= niftyPct;

  return (
    <div style={{
      width:           '100vw',
      height:          '100vh',
      background:      C.bg,
      display:         'flex',
      flexDirection:   'column',
      alignItems:      'center',
      justifyContent:  'center',
      padding:         '24px',
      overflow:        'hidden',
    }}>
      <style>{`
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .fi-title { animation: fadeUp 0.6s ease 0.1s both; }
        .fi-sub   { animation: fadeUp 0.6s ease 0.3s both; }
        .fi-cards { animation: fadeUp 0.7s ease 0.5s both; }
        .fi-cta   { animation: fadeUp 0.6s ease 2.8s both; }
        .fi-badge { animation: fadeIn 0.5s ease 3.2s both; }
      `}</style>

      {/* Branding */}
      <p className="fi-title" style={{
        fontFamily: '"Fraunces", Georgia, serif',
        fontSize:   14,
        color:      C.gold,
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        marginBottom: 28,
        fontStyle:  'italic',
      }}>
        Artha
      </p>

      {/* Headline */}
      <h1 className="fi-sub" style={{
        fontFamily: '"Fraunces", Georgia, serif',
        fontSize:   'clamp(26px, 5vw, 48px)',
        fontWeight: 300,
        color:      C.text,
        textAlign:  'center',
        marginBottom: 12,
        lineHeight:  1.2,
      }}>
        Here's what your money<br />has been up to.
      </h1>

      <p className="fi-sub" style={{ color: C.muted, fontSize: 15, marginBottom: 48, textAlign: 'center' }}>
        Tracking {Math.round(countedCount)} stocks in your portfolio
      </p>

      {/* Comparison cards */}
      <div className="fi-cards" style={{
        display:   'grid',
        gridTemplateColumns: '1fr 1fr',
        gap:        16,
        width:      '100%',
        maxWidth:   420,
        marginBottom: 48,
      }}>
        {/* Portfolio card */}
        <div style={{
          background:   C.s1,
          border:       `1px solid ${portfolioColor}40`,
          borderRadius: 20,
          padding:      '28px 20px',
          textAlign:    'center',
        }}>
          <p style={{ color: C.muted, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>
            Your portfolio
          </p>
          <p style={{
            fontFamily: '"Fraunces", serif',
            fontSize:   40,
            fontWeight: 700,
            color:      portfolioColor,
            lineHeight:  1,
            marginBottom: 6,
          }}>
            {countedPnl >= 0 ? '+' : ''}{countedPnl.toFixed(1)}%
          </p>
          <p style={{ color: C.subtle, fontSize: 11 }}>total return</p>
        </div>

        {/* Nifty card */}
        <div style={{
          background:   C.s1,
          border:       `1px solid ${C.border}`,
          borderRadius: 20,
          padding:      '28px 20px',
          textAlign:    'center',
        }}>
          <p style={{ color: C.muted, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }}>
            Nifty avg
          </p>
          <p style={{
            fontFamily: '"Fraunces", serif',
            fontSize:   40,
            fontWeight: 700,
            color:      niftyColor,
            lineHeight:  1,
            marginBottom: 6,
          }}>
            +{countedNifty.toFixed(1)}%
          </p>
          <p style={{ color: C.subtle, fontSize: 11 }}>annual benchmark</p>
        </div>
      </div>

      {/* Verdict */}
      <p className="fi-badge" style={{
        color:        beatNifty ? C.green : C.gold,
        fontSize:     13,
        fontWeight:   600,
        marginBottom: 36,
        textAlign:    'center',
        background:   beatNifty ? 'rgba(78,173,132,0.1)' : 'rgba(212,168,67,0.1)',
        border:       `1px solid ${beatNifty ? C.green : C.gold}40`,
        borderRadius: 24,
        padding:      '8px 20px',
      }}>
        {beatNifty ? '✦ Beating the market — let\'s keep it that way' : '✦ Room to grow — let\'s find out how'}
      </p>

      {/* CTA */}
      <button
        className="fi-cta"
        onClick={enter}
        style={{
          background:   C.gold,
          color:        '#0a0a0b',
          border:       'none',
          borderRadius: 14,
          padding:      '15px 40px',
          fontSize:     15,
          fontWeight:   700,
          cursor:       'pointer',
          fontFamily:   '"DM Sans", sans-serif',
          letterSpacing: '0.01em',
        }}
      >
        Show me why →
      </button>
    </div>
  );
}
