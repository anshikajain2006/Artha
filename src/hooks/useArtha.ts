import { useState, useCallback, useEffect, useRef } from 'react';
import { generateAnalysis, type AnalysisType, type PortfolioData, type UserContext } from '../lib/gemini';
import { useSessionContext } from '../lib/sessionContext';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ArthaResult {
  response:       string | null;
  loading:        boolean;
  error:          string | null;
  retryCountdown: number | null;
  execute:        (type: AnalysisType, portfolio: PortfolioData, context?: UserContext) => Promise<void>;
}

// ── Score parser ───────────────────────────────────────────────────────────────

export function parseHealthScore(text: string): number | null {
  const patterns = [
    /Health\s*Score[:\s]+(\d{1,3})\s*\/\s*100/i,
    /(?:total|overall|score)[:\s*]+(\d{1,3})\s*\/\s*100/i,
    /\*{0,2}(\d{1,3})\*{0,2}\s*\/\s*100/,
    /(\d{1,3})\s*out of\s*100/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useArtha(onHealthScore?: (score: number, text: string) => void): ArthaResult {
  const [response,       setResponse]       = useState<string | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);

  const pendingRetryRef = useRef<[AnalysisType, PortfolioData, UserContext | undefined] | null>(null);

  const { context, updateHealth, updateScenario, updatePicks, updateGoal } = useSessionContext();

  const execute = useCallback(async (
    type:      AnalysisType,
    portfolio: PortfolioData,
    userCtx?:  UserContext,
  ) => {
    setLoading(true);
    setError(null);
    setResponse(null);
    setRetryCountdown(null);

    try {
      const text = await generateAnalysis(type, portfolio, userCtx, context);
      setResponse(text);

      // Update session memory
      switch (type) {
        case 'health': {
          const score = parseHealthScore(text) ?? 0;
          updateHealth(text, score);
          if (onHealthScore && score > 0) onHealthScore(score, text);
          break;
        }
        case 'scenario':
          updateScenario('Scenario analysis', text);
          break;
        case 'picks':
          updatePicks(text);
          break;
        case 'goal':
          updateGoal(text);
          break;
      }
    } catch (e) {
      if ((e as { isRateLimit?: boolean }).isRateLimit === true) {
        pendingRetryRef.current = [type, portfolio, userCtx];
        setRetryCountdown(60);
      } else {
        setError(e instanceof Error ? e.message : 'An unknown error occurred.');
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, updateHealth, updateScenario, updatePicks, updateGoal]);

  // Countdown timer — updates error message each second, auto-retries at 0
  useEffect(() => {
    if (retryCountdown === null) return;
    if (retryCountdown > 0) {
      setError(`Rate limit — retry in ${retryCountdown}s`);
      const t = window.setTimeout(() => setRetryCountdown((c) => (c !== null ? c - 1 : null)), 1000);
      return () => window.clearTimeout(t);
    }
    // Reached 0 — auto-retry
    const args = pendingRetryRef.current;
    pendingRetryRef.current = null;
    if (args) void execute(...args);
  }, [retryCountdown, execute]);

  return { response, loading, error, retryCountdown, execute };
}
