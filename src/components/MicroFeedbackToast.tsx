import { useState, useEffect, useRef, useCallback } from 'react';
import type { PortfolioChange } from '../lib/portfolioDiff';

// ── Design tokens ──────────────────────────────────────────────────────────────

const C = {
  bg:     '#0a0a0b',
  s1:     '#111113',
  gold:   '#d4a843',
  text:   '#f0efe8',
  muted:  '#9b9a94',
  subtle: '#5a5955',
  border: '#2a2a2f',
  green:  '#4ead84',
  red:    '#e05252',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MicroResult {
  verdict:     string;
  aiScore:     number | null;
  nextAction:  string;
}

/** Parse the AI's micro-analysis response into structured fields. */
export function parseMicroResult(text: string): MicroResult {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const verdictLine    = lines.find((l) => l.startsWith('VERDICT:'));
  const scoreLine      = lines.find((l) => l.startsWith('SCORE:'));
  const nextLine       = lines.find((l) => l.startsWith('NEXT:'));

  const verdict    = verdictLine ? verdictLine.replace(/^VERDICT:\s*/i, '') : text.slice(0, 120);
  const scoreMatch = scoreLine?.match(/\d+/);
  const aiScore    = scoreMatch ? Math.min(100, Math.max(0, parseInt(scoreMatch[0], 10))) : null;
  const nextAction = nextLine   ? nextLine.replace(/^NEXT:\s*/i, '')    : '';

  return { verdict, aiScore, nextAction };
}

// ── Dot pulse loader ───────────────────────────────────────────────────────────

function DotPulse() {
  return (
    <>
      <style>{`
        @keyframes dot-pulse {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%            { opacity: 1;   transform: scale(1); }
        }
        .dot-pulse span {
          display: inline-block;
          width: 5px; height: 5px;
          border-radius: 50%;
          background: ${C.muted};
          margin: 0 2px;
          animation: dot-pulse 1.2s ease-in-out infinite;
        }
        .dot-pulse span:nth-child(2) { animation-delay: 0.2s; }
        .dot-pulse span:nth-child(3) { animation-delay: 0.4s; }
      `}</style>
      <span className="dot-pulse" style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' }}>
        <span /><span /><span />
      </span>
    </>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

const DISMISS_MS = 8000;

interface Props {
  previousScore: number;
  currentScore:  number;
  changes:       PortfolioChange[];
  result:        MicroResult | null;   // null = still loading
  onDismiss:     () => void;
}

export default function MicroFeedbackToast({
  previousScore,
  currentScore,
  changes,
  result,
  onDismiss,
}: Props) {
  const [progress,  setProgress]  = useState(100);
  const [visible,   setVisible]   = useState(false);
  const [exiting,   setExiting]   = useState(false);
  const hovering   = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Slide in on mount
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(onDismiss, 300);
  }, [onDismiss]);

  // Auto-dismiss countdown
  useEffect(() => {
    const TICK = 100;
    const step = (TICK / DISMISS_MS) * 100;

    intervalRef.current = setInterval(() => {
      if (hovering.current) return;
      setProgress((prev) => {
        const next = prev - step;
        if (next <= 0) {
          clearInterval(intervalRef.current!);
          dismiss();
          return 0;
        }
        return next;
      });
    }, TICK);

    return () => clearInterval(intervalRef.current!);
  }, [dismiss]);

  // Score display
  const scoreDelta = currentScore - previousScore;
  const scoreColor =
    scoreDelta > 0 ? C.green :
    scoreDelta < 0 ? C.red   : C.gold;

  // Change summary (max 2 lines)
  const changeSummary = changes
    .slice(0, 2)
    .map((c) => {
      if (c.type === 'added')     return `+ ${c.stockName}`;
      if (c.type === 'removed')   return `− ${c.stockName}`;
      if (c.type === 'increased') return `↑ ${c.stockName}`;
      if (c.type === 'decreased') return `↓ ${c.stockName}`;
      if (c.type === 'goal_set')  return `✦ Goal: ${c.stockName}`;
      return c.stockName;
    })
    .join('  ·  ');
  const extraCount = changes.length > 2 ? ` +${changes.length - 2} more` : '';

  const slideStyle: React.CSSProperties = {
    position:  'fixed',
    bottom:    24,
    right:     24,
    width:     320,
    background: C.s1,
    border:    `1px solid ${C.border}`,
    borderLeft: `3px solid ${C.gold}`,
    borderRadius: 12,
    padding:   '16px 20px 0',
    zIndex:    9999,
    overflow:  'hidden',
    transform: visible && !exiting ? 'translateY(0)' : 'translateY(24px)',
    opacity:   visible && !exiting ? 1 : 0,
    transition: 'transform 0.3s ease, opacity 0.3s ease',
  };

  return (
    <>
      <style>{`
        @keyframes micro-toast-in {
          from { transform: translateY(24px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .micro-result-enter {
          animation: micro-toast-in 0.25s ease forwards;
        }
      `}</style>

      <div
        style={slideStyle}
        onMouseEnter={() => { hovering.current = true; }}
        onMouseLeave={() => { hovering.current = false; }}
      >
        {/* Dismiss button */}
        <button
          onClick={dismiss}
          style={{
            position:   'absolute',
            top:        10,
            right:      12,
            background: 'none',
            border:     'none',
            color:      C.subtle,
            fontSize:   18,
            cursor:     'pointer',
            lineHeight: 1,
            padding:    '0 2px',
            fontFamily: 'inherit',
          }}
          onMouseOver={(e) => (e.currentTarget.style.color = C.text)}
          onMouseOut={(e)  => (e.currentTarget.style.color = C.subtle)}
          aria-label="Dismiss"
        >×</button>

        {/* Header */}
        <p style={{
          fontSize:      11,
          fontWeight:    500,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color:         C.gold,
          margin:        '0 0 10px',
        }}>
          ✦ Portfolio updated
        </p>

        {/* Change summary */}
        {changeSummary && (
          <p style={{ fontSize: 11, color: C.subtle, margin: '0 0 10px', lineHeight: 1.5 }}>
            {changeSummary}{extraCount}
          </p>
        )}

        {/* Score change — only show when score actually changed */}
        {scoreDelta !== 0 && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
            <span style={{
              fontFamily: '"Fraunces", serif',
              fontWeight: 300,
              fontSize:   20,
              color:      scoreColor,
              lineHeight: 1,
            }}>
              {previousScore} → {currentScore}
            </span>
            <span style={{ fontSize: 12, color: C.muted }}>
              {scoreDelta > 0 ? `▲ +${scoreDelta}` : `▼ ${scoreDelta}`} pts
            </span>
          </div>
        )}

        {/* AI content — only show when loading or successful result */}
        {(!result || !result.verdict.startsWith('Analysis unavailable')) && (
          <div style={{ minHeight: 52 }}>
            {!result ? (
              <p style={{ fontSize: 13, color: C.subtle, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                Analysing your changes&nbsp;<DotPulse />
              </p>
            ) : (
              <div className="micro-result-enter">
                <p style={{ fontSize: 13, color: C.muted, margin: '0 0 8px', lineHeight: 1.6 }}>
                  {result.verdict}
                </p>
                {result.nextAction && (
                  <p style={{ fontSize: 12, color: C.text, margin: 0, lineHeight: 1.5 }}>
                    <span style={{ color: C.gold }}>Next:</span> {result.nextAction}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Progress bar */}
        <div style={{
          position:   'absolute',
          bottom:     0,
          left:       0,
          right:      0,
          height:     3,
          background: C.border,
        }}>
          <div style={{
            height:     '100%',
            width:      `${progress}%`,
            background: C.gold,
            transition: 'width 0.1s linear',
          }} />
        </div>

        {/* Bottom padding so progress bar doesn't overlap text */}
        <div style={{ height: 12 }} />
      </div>
    </>
  );
}
