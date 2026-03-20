/**
 * Session-level AI memory — keeps all four AI features in sync.
 * Lives in React Context (session only — not persisted).
 */
import { createContext, useContext, useState, useCallback, createElement, type ReactNode } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HealthAnalysisMemory {
  response:    string;
  score:       number;
  topProblems: string[];
  timestamp:   number;
}

export interface ScenarioMemory {
  scenario:  string;
  response:  string;
  timestamp: number;
}

export interface PicksMemory {
  response:         string;
  suggestedTickers: string[];
  horizon:          'long' | 'short';
  timestamp:        number;
}

export interface GoalAnalysisMemory {
  response:  string;
  verdict:   string;
  timestamp: number;
}

export interface UserActionMemory {
  action:    string;
  timestamp: number;
}

export interface SessionMemory {
  healthAnalysis:  HealthAnalysisMemory | null;
  scenariosTested: ScenarioMemory[];
  picksGenerated:  PicksMemory | null;
  goalAnalysis:    GoalAnalysisMemory | null;
  userActions:     UserActionMemory[];
}

const EMPTY_MEMORY: SessionMemory = {
  healthAnalysis:  null,
  scenariosTested: [],
  picksGenerated:  null,
  goalAnalysis:    null,
  userActions:     [],
};

interface SessionContextValue {
  context:        SessionMemory;
  updateHealth:   (response: string, score: number) => void;
  updateScenario: (scenario: string, response: string) => void;
  updatePicks:    (response: string) => void;
  updateGoal:     (response: string) => void;
  addUserAction:  (action: string) => void;
}

// ── Key-fact extractors ────────────────────────────────────────────────────────

/** Pull up to 3 problem headlines from the health response. */
function extractTopProblems(text: string): string[] {
  // Look for "## The 3 Biggest Problems" section, grab numbered items
  const sectionMatch = text.match(/##\s*The\s*3\s*Biggest\s*Problems[\s\S]*?(?=##|$)/i);
  if (!sectionMatch) {
    // Fallback: find lines starting with 1. 2. 3.
    const lines = text.split('\n');
    const numbered = lines.filter((l) => /^[1-3]\.\s/.test(l.trim())).slice(0, 3);
    return numbered.map((l) => l.replace(/^[1-3]\.\s*/, '').trim()).filter(Boolean);
  }
  const section = sectionMatch[0];
  const items = section.match(/^(?:\d\.|[-*])\s+.+/gm) ?? [];
  // Also catch lines after "Problem:" label
  const problemLabels = section.match(/(?:Problem|Issue):\s*([^\n]+)/gi) ?? [];
  const candidates = [...items, ...problemLabels]
    .map((l) => l.replace(/^(?:\d\.|[-*]|Problem:|Issue:)\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return candidates.length > 0 ? candidates : ['See full analysis'];
}

/** Extract NSE tickers from AI picks response. */
function extractSuggestedTickers(text: string): string[] {
  const matches = [...text.matchAll(/NSE:\s*([A-Z0-9]{2,15})/g)];
  return [...new Set(matches.map((m) => m[1]))].slice(0, 6);
}

/** Pull the verdict line from a goal analysis. */
function extractVerdict(text: string): string {
  const m = text.match(/\*{0,2}Verdict[^:]*:\*{0,2}\s*([^\n]+)/i)
    ?? text.match(/\b(On Track|Slightly Behind|Significantly Behind|Goal Needs Revision)\b[^\n]*/i);
  return m ? m[1].trim().slice(0, 120) : 'See full analysis';
}

// ── React Context ──────────────────────────────────────────────────────────────

const Ctx = createContext<SessionContextValue | null>(null);

export function useSessionContext(): SessionContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSessionContext must be used inside SessionContextProvider');
  return v;
}

export function SessionContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<SessionMemory>(EMPTY_MEMORY);

  const updateHealth = useCallback((response: string, score: number) => {
    const topProblems = extractTopProblems(response);
    setContext((prev) => ({
      ...prev,
      healthAnalysis: { response, score, topProblems, timestamp: Date.now() },
    }));
  }, []);

  const updateScenario = useCallback((scenario: string, response: string) => {
    setContext((prev) => ({
      ...prev,
      scenariosTested: [
        ...prev.scenariosTested,
        { scenario, response, timestamp: Date.now() },
      ].slice(-5), // keep last 5
    }));
  }, []);

  const updatePicks = useCallback((response: string) => {
    const suggestedTickers = extractSuggestedTickers(response);
    setContext((prev) => ({
      ...prev,
      picksGenerated: {
        response,
        suggestedTickers,
        horizon: 'long',
        timestamp: Date.now(),
      },
    }));
  }, []);

  const updateGoal = useCallback((response: string) => {
    const verdict = extractVerdict(response);
    setContext((prev) => ({
      ...prev,
      goalAnalysis: { response, verdict, timestamp: Date.now() },
    }));
  }, []);

  const addUserAction = useCallback((action: string) => {
    setContext((prev) => ({
      ...prev,
      userActions: [
        ...prev.userActions,
        { action, timestamp: Date.now() },
      ].slice(-20), // cap at 20 actions
    }));
  }, []);

  return createElement(Ctx.Provider, {
    value: { context, updateHealth, updateScenario, updatePicks, updateGoal, addUserAction },
    children,
  });
}
