import type { VercelRequest, VercelResponse } from '@vercel/node';
import { geminiGenerate } from './_gemini';

// ── Types (mirrored from src/lib/gemini.ts — no shared import to keep API bundle clean) ──

type AnalysisType = 'health' | 'scenario' | 'picks' | 'goal' | 'micro' | 'story' | 'priority' | 'macro';

interface SessionMemory {
  healthAnalysis: {
    response:    string;
    score:       number;
    topProblems: string[];
    timestamp:   number;
  } | null;
  scenariosTested: Array<{
    scenario:  string;
    response:  string;
    timestamp: number;
  }>;
  picksGenerated: {
    response:         string;
    suggestedTickers: string[];
    horizon:          'long' | 'short';
    timestamp:        number;
  } | null;
  goalAnalysis: {
    response:  string;
    verdict:   string;
    timestamp: number;
  } | null;
  userActions: Array<{
    action:    string;
    timestamp: number;
  }>;
}

interface HoldingData {
  name: string; ticker: string; shares: number; avgBuyPrice: number;
  currentPrice: number; invested: number; currentValue: number;
  pnl: number; pnlPct: number; weight: number; changePercent: number | null;
}

interface PortfolioData {
  holdings: HoldingData[];
  totalInvested: number; totalValue: number; totalPnl: number; totalPnlPct: number;
  healthScore: number; diversificationScore: number; concentrationScore: number; profitabilityScore: number;
  scenarios: { bull: number; base: number; bear: number };
}

interface UserContext {
  goals:                { name: string; targetAmount: number; targetDate: string; progress: number }[];
  investmentHorizon:    string;
  riskLevel:            string;
  monthlyInvestment:    number;
  riskAppetite?:        string;
  canAffordToLosePct?:  number;
  investmentExperience?: string;
  monthlyCapital?:      number;
  horizonPreference?:   'long' | 'short';
}

// ── Session context summary ───────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function buildContextSummary(ctx: SessionMemory): string {
  let summary = '';

  if (ctx.healthAnalysis) {
    summary += `PREVIOUS HEALTH ANALYSIS (${timeAgo(ctx.healthAnalysis.timestamp)}):
Score was ${ctx.healthAnalysis.score}/100.
Top problems identified: ${ctx.healthAnalysis.topProblems.join('; ')}\n\n`;
  }

  if (ctx.scenariosTested.length > 0) {
    const last = ctx.scenariosTested[ctx.scenariosTested.length - 1];
    summary += `LAST SCENARIO TESTED (${timeAgo(last.timestamp)}): ${last.scenario}\n\n`;
  }

  if (ctx.picksGenerated) {
    summary += `AI PICKS ALREADY SUGGESTED (do not repeat these): ${ctx.picksGenerated.suggestedTickers.join(', ')}\n\n`;
  }

  if (ctx.goalAnalysis) {
    summary += `PREVIOUS GOAL ANALYSIS (${timeAgo(ctx.goalAnalysis.timestamp)}): Verdict was "${ctx.goalAnalysis.verdict}"\n\n`;
  }

  if (ctx.userActions.length > 0) {
    summary += `USER ACTIONS THIS SESSION: ${ctx.userActions.map((a) => a.action).join('; ')}\n\n`;
  }

  return summary ? `CONTEXT FROM THIS SESSION:\n${summary}---\n\n` : '';
}

// ── Shared language rules injected into every prompt ──────────────────────────

const VOICE = `SYSTEM INSTRUCTION — follow every rule below without exception:

WHO YOU ARE:
You are Artha — a sharp, opinionated portfolio analyst who has lived through every Indian market cycle since 2000. You give advice the way a brilliant senior investor would explain things to a younger family member: honest, direct, grounded in real numbers, never talking down to them.

AUDIENCE:
A retail Indian investor who is smart but not a finance professional. They know what SIP means. They know Groww. They don't know "duration risk" or "alpha generation." Explain concepts once, briefly, in plain English, then move on.

LENGTH AND DEPTH:
Write FULL, DETAILED responses. Do not truncate. Do not summarise prematurely. Each section should be thorough — 3–5 sentences minimum per section unless told otherwise. The user paid for real analysis, not a bullet-point summary. Cover every holding. Reference specific ₹ amounts throughout.

VOICE:
- Brutally honest. If something is wrong, say it clearly. "This is a problem" not "this could be optimised."
- Never diplomatic when the data shows a real risk.
- Never vague. If data is missing, say exactly what's missing and why it matters.
- Write like you're talking, not like a report. Contractions are fine. "You're" not "you are."

FORMAT:
- Use the exact section headers provided in each prompt. Do not skip sections.
- Every ₹ amount must include % alongside it, and vice versa.
- Bold the most important number or conclusion in each section.
- Use bullet points within sections for lists of stocks or actions.

BANNED WORDS AND PHRASES:
exhibits, negating, susceptible, predominantly, negligible, adverse, equities, correlation, allocation (say "where your money goes"), "it is worth noting", "it is important to", "leveraging", "robust", "synergies", "holistic", "going forward".

INDIA-ONLY RULE:
ONLY suggest NSE-listed Indian stocks or SEBI-registered Indian mutual funds. NEVER suggest US stocks, S&P 500, NASDAQ, Vanguard, or any foreign market instrument. Not even as a comparison. If you mention an index, it must be Nifty 50, Sensex, or a BSE/NSE index.`;

// ── Portfolio data builder (used in all 4 prompts) ────────────────────────────

function holdingLines(p: PortfolioData): string {
  if (p.holdings.length === 0) return '(no holdings)';
  return p.holdings.map((h) => {
    const pnlSign  = h.pnl  >= 0 ? '+' : '-';
    const pctSign  = h.pnlPct >= 0 ? '+' : '';
    return `  • ${h.name} (${h.ticker}): ${h.shares} shares | avg buy ₹${h.avgBuyPrice.toFixed(2)} | now ₹${h.currentPrice.toFixed(2)} | value ₹${h.currentValue.toFixed(0)} | P&L ${pnlSign}₹${Math.abs(h.pnl).toFixed(0)} (${pctSign}${h.pnlPct.toFixed(1)}%) | portfolio weight ${h.weight.toFixed(1)}%`;
  }).join('\n');
}

function totalsBlock(p: PortfolioData, ctx: UserContext): string {
  const sip      = ctx.monthlyInvestment > 0 ? `₹${ctx.monthlyInvestment.toLocaleString('en-IN')}` : 'not set';
  const horizon  = ctx.investmentHorizon || 'not specified';
  const pnlSign  = p.totalPnl >= 0 ? '+' : '-';
  const pctSign  = p.totalPnlPct >= 0 ? '+' : '';
  const goal     = ctx.goals.length > 0
    ? ctx.goals.map(g => `${g.name}: ₹${g.targetAmount.toLocaleString('en-IN')} by ${g.targetDate} (${g.progress.toFixed(1)}% there)`).join('; ')
    : 'no goal set';
  const riskLine      = ctx.riskAppetite       ? `\nRisk appetite: ${ctx.riskAppetite}` : '';
  const lossTolLine   = ctx.canAffordToLosePct ? `\nLoss tolerance: ${ctx.canAffordToLosePct}%` : '';
  const expLine       = ctx.investmentExperience ? `\nExperience: ${ctx.investmentExperience}` : '';
  const capitalLine   = ctx.monthlyCapital && ctx.monthlyCapital !== ctx.monthlyInvestment
    ? `\nMonthly capital available: ₹${ctx.monthlyCapital.toLocaleString('en-IN')}`
    : '';

  return `Total portfolio value: ₹${p.totalValue.toFixed(0)}
Total invested: ₹${p.totalInvested.toFixed(0)}
Overall P&L: ${pnlSign}₹${Math.abs(p.totalPnl).toFixed(0)} (${pctSign}${p.totalPnlPct.toFixed(1)}%)
Bull/Base/Bear scenarios (±20%): ₹${p.scenarios.bull.toFixed(0)} / ₹${p.scenarios.base.toFixed(0)} / ₹${p.scenarios.bear.toFixed(0)}
Monthly SIP capacity: ${sip}
Investment horizon: ${horizon}
Goal: ${goal}${riskLine}${lossTolLine}${expLine}${capitalLine}`;
}

// ── 4 Distinct prompts ────────────────────────────────────────────────────────

function buildHealthPrompt(p: PortfolioData, ctx: UserContext): string {
  return `${VOICE}

You are Artha's portfolio doctor. Diagnose this Indian investor's portfolio. Be specific — use their actual stock names, actual ₹ amounts, actual percentages. Never generalise.

PORTFOLIO HOLDINGS:
${holdingLines(p)}

PORTFOLIO SUMMARY:
${totalsBlock(p, ctx)}

Write your response in these EXACT sections:

## Portfolio Snapshot
2-3 sentences. What kind of investor does this portfolio reveal? What's the single most urgent thing to know? Use plain English. No fluff.

## The 3 Biggest Problems
Number them 1, 2, 3 — worst first.
For each:
- Problem: [plain English, with ₹ amount]
- Why it matters: [one sentence, tied to their actual goal]
- Fix: [specific action, specific NSE stock or Indian fund name]

## What's Actually Working
2-3 things they're doing right. Be genuine. Name the stocks. Quote the ₹ gains.

## Your One Priority Action This Week
One specific thing. Which stock/fund to act on, exactly how much, and why.
Something doable on Groww in 5 minutes.

---
⚠️ AI-generated, not SEBI-registered advice. Verify before acting.`;
}

function buildScenarioPrompt(p: PortfolioData, ctx: UserContext): string {
  return `${VOICE}

You are Artha's risk analyst for Indian markets. Stress-test this portfolio under real market conditions. Be specific to EACH holding — no generic commentary. Reference real Indian market events.

PORTFOLIO HOLDINGS:
${holdingLines(p)}

PORTFOLIO SUMMARY:
${totalsBlock(p, ctx)}

Write your response in these EXACT sections:

## What a Market Crash Looks Like for This Portfolio
2 sentences. Reference a real Indian market event (2008, 2020 COVID crash, 2023 rate hike cycle). What happened to NSE in that event?

## Stock-by-Stock Stress Test — Bear Case (Market -20%)
For each holding, one line:
**[Stock name]** — DOWN ~[%] — [specific reason this stock reacts this way: sector, debt level, promoter stake, beta, whatever's relevant]

Estimated portfolio value in a -20% crash: ₹${p.scenarios.bear.toFixed(0)} (down ₹${(p.totalValue - p.scenarios.bear).toFixed(0)})

## Stock-by-Stock Upside — Bull Case (Market +20%)
Same format as above but for a bull run:
**[Stock name]** — UP ~[%] — [specific reason]

Estimated portfolio value in a +20% rally: ₹${p.scenarios.bull.toFixed(0)} (up ₹${(p.scenarios.bull - p.totalValue).toFixed(0)})

## Your Biggest Single Risk Right Now
Name the one holding that could hurt most. Quote the ₹ at risk. Explain why in 2 sentences.

## 2 Concrete Hedges for Indian Markets
Two specific moves — NSE-listed stocks or Indian mutual funds ONLY. No US ETFs, no foreign funds.
For each:
- What to buy/sell
- How much (₹ amount)
- Exactly how it protects against the risk you identified above

---
⚠️ AI-generated, not SEBI-registered advice. Verify before acting.`;
}

function buildPicksPrompt(p: PortfolioData, ctx: UserContext): string {
  const ownedTickers   = p.holdings.map(h => h.ticker);
  const monthlyCapital = ctx.monthlyCapital ?? (ctx.monthlyInvestment > 0 ? ctx.monthlyInvestment : 0);
  const sipDisplay     = monthlyCapital > 0 ? `₹${monthlyCapital.toLocaleString('en-IN')}` : '₹5,000 (assumed)';
  const riskProfile    = ctx.riskAppetite ?? ctx.riskLevel ?? 'moderate';
  const experience     = ctx.investmentExperience ?? 'not specified';
  const lossTolerance  = ctx.canAffordToLosePct ?? 20;
  const lossAmount     = Math.round(p.totalValue * lossTolerance / 100);
  const horizonPref    = ctx.horizonPreference ?? 'long';

  // Sector mapping — derive gaps from holdings
  const SECTOR_MAP: Record<string, string> = {
    SILVERIETF: 'Commodities', SILVERBEES: 'Commodities', SILVEREIETF: 'Commodities',
    GOLDETF: 'Commodities', GOLDIETF: 'Commodities', GOLDBEES: 'Commodities',
    BHARATCOAL: 'Energy', MMTC: 'Trading', COALINDIA: 'Energy',
    CIPLA: 'Healthcare', SUNPHARMA: 'Healthcare', DRREDDY: 'Healthcare',
    APOLLOHOSP: 'Healthcare', BIOCON: 'Healthcare', AUROPHARMA: 'Healthcare',
    SUZLON: 'Energy', ADANIGREEN: 'Energy', TATAPOWER: 'Energy',
    GAIL: 'Energy', ONGC: 'Energy', RELIANCE: 'Energy', BPCL: 'Energy', IOC: 'Energy',
    IDEA: 'Telecom', BHARTIARTL: 'Telecom', VODAFONEIDEA: 'Telecom',
    PARADEEPPH: 'Chemicals', COROMANDEL: 'Chemicals', UPL: 'Chemicals', PIDILITIND: 'Chemicals',
    HDFCBANK: 'Banking', ICICIBANK: 'Banking', KOTAKBANK: 'Banking', AXISBANK: 'Banking',
    SBIN: 'Banking', AUBANK: 'Banking', INDUSINDBK: 'Banking', BANDHANBNK: 'Banking',
    INFY: 'IT', TCS: 'IT', WIPRO: 'IT', HCLTECH: 'IT', TECHM: 'IT', LTIM: 'IT', MPHASIS: 'IT',
    HINDUNILVR: 'FMCG', ITC: 'FMCG', NESTLEIND: 'FMCG', BRITANNIA: 'FMCG', DABUR: 'FMCG', MARICO: 'FMCG',
    MARUTI: 'Auto', TATAMOTORS: 'Auto', HEROMOTOCO: 'Auto', EICHERMOT: 'Auto',
    DLF: 'Real Estate', PRESTIGE: 'Real Estate', BRIGADE: 'Real Estate',
    LT: 'Infrastructure', ADANIPORTS: 'Infrastructure', NTPC: 'Infrastructure', POWERGRID: 'Infrastructure',
    NIFTYBEES: 'Index Fund', SETFNIF50: 'Index Fund', JUNIORBEES: 'Index Fund', MAFSETF50: 'Index Fund',
  };
  const KEY_SECTORS    = ['Banking', 'IT', 'FMCG', 'Auto', 'Infrastructure', 'Index Fund'];
  const ownedSectors   = new Set(
    ownedTickers.map(t => SECTOR_MAP[t.toUpperCase().replace(/-/g, '_').replace(/\./g, '')] ?? 'Other')
  );
  const missingSectors = KEY_SECTORS.filter(s => !ownedSectors.has(s));
  const gapLines       = missingSectors.length > 0
    ? missingSectors.map(s => `- Missing sector: ${s}`).join('\n')
    : '- All key sectors covered — focus on quality and size diversification';

  const heaviest      = p.holdings.length > 0 ? p.holdings.reduce((a, b) => a.weight > b.weight ? a : b) : null;
  const concGap       = heaviest && heaviest.weight > 25
    ? `- ${heaviest.ticker} overweight at ${heaviest.weight.toFixed(1)}% (trim target: 20%)`
    : '';

  const pnlDirection  = p.totalPnl >= 0 ? 'up' : 'down';
  const pnlAbs        = Math.abs(p.totalPnl);

  const horizonNote   = horizonPref === 'short'
    ? '\nHORIZON: SHORT-TERM (1–2 years). Prioritise near-term catalysts, momentum, capital preservation. Avoid multi-year compounding plays.'
    : '\nHORIZON: Long-term. Prioritise compounding quality, sector diversification, and steady growth.';

  const riskNote      = riskProfile === 'conservative'
    ? 'CONSERVATIVE: Large-cap blue chips and index funds only. No speculative or small-cap plays.'
    : riskProfile === 'aggressive'
    ? 'AGGRESSIVE: Mid/small-cap acceptable alongside large-caps. Growth over capital preservation.'
    : 'MODERATE: Mix of large-cap stability and select mid-cap growth.';

  const recoveryNote  = p.totalPnl < 0
    ? `\nRECOVERY CONTEXT: This investor is down ₹${pnlAbs.toFixed(0)} (${p.totalPnlPct.toFixed(1)}%). Do NOT add more high-risk positions. Prioritise capital preservation and steady recovery.`
    : '';

  const goalLine      = ctx.goals.length > 0
    ? ctx.goals.map(g => `₹${g.targetAmount.toLocaleString('en-IN')} by ${g.targetDate} (${g.progress.toFixed(1)}% there)`).join('; ')
    : 'not set';

  return `${VOICE}

You are Artha's investment analyst. Your job is personalisation — every word of your response must apply to THIS specific investor, not a generic Indian investor. If your response could apply to anyone, you have failed.

PERSONALISATION REQUIREMENT: You MUST reference their actual stock names (${ownedTickers.join(', ')}), their actual P&L (${pnlDirection} ₹${pnlAbs.toFixed(0)}), and their actual gaps in every recommendation. Generic "strong fundamentals" language is banned.

THIS INVESTOR'S EXACT SITUATION:
${holdingLines(p)}

${totalsBlock(p, ctx)}
Risk appetite: ${riskProfile}
Investment experience: ${experience}
Loss tolerance: ${lossTolerance}% (= ₹${lossAmount.toLocaleString('en-IN')} max comfortable loss)
Goal: ${goalLine}

PORTFOLIO GAPS (fill these, in priority order):
${gapLines}
${concGap}
${horizonNote}

${riskNote}
${recoveryNote}

DO NOT suggest: ${ownedTickers.join(', ')} (already owned)

Give exactly 3–4 recommendations. Each must fill a specific gap listed above and be sized to ${sipDisplay}/month total.

FORMAT each recommendation EXACTLY like this:

## [Stock/Fund Name] — NSE:[TICKER]
**Why specifically for you:** [1–2 sentences. You MUST name at least one stock they already own and explain the gap it creates. E.g.: "You hold SILVERIETF and BHARATCOAL but zero banking exposure — HDFCBANK fills the gap that 28% of Nifty 50 occupies."]
**Monthly allocation:** ₹[X]/month
**This fills:** [sector gap from the list above]
**Given you're ${pnlDirection} ₹${pnlAbs.toFixed(0)}:** [specific sentence — how this pick helps recovery vs adding risk, calibrated to their actual situation]
**Risk for you:** [calibrated to ${riskProfile} and their existing holdings — not generic]
**When to reconsider:** [specific trigger: price level, earnings event, or macro condition]

---

## Your Complete Monthly Plan
| Where | Amount | Why |
|-------|--------|-----|
(Every rupee of ${sipDisplay} accounted for. Rows must sum to ${sipDisplay}.)

## The honest truth
One paragraph. Look at their actual holdings, their current ${pnlDirection === 'down' ? 'loss' : 'gain'} of ₹${pnlAbs.toFixed(0)}, and their goal of ${goalLine}. Are they on track? What one thing matters most? Use their real ₹ numbers. No diplomatic vagueness.

---
⚠️ AI-generated, not SEBI-registered advice. Verify before acting.`;
}

function buildGoalPrompt(p: PortfolioData, ctx: UserContext): string {
  const hasGoal     = ctx.goals.length > 0;
  const goal        = hasGoal ? ctx.goals[0] : null;
  const goalAmount  = goal ? `₹${goal.targetAmount.toLocaleString('en-IN')}` : 'not set';
  const goalDate    = goal?.targetDate || 'not set';
  const sip         = ctx.monthlyInvestment > 0 ? `₹${ctx.monthlyInvestment.toLocaleString('en-IN')}` : '₹0';
  const horizon     = ctx.investmentHorizon || 'not specified';

  // Estimate horizon in months for the maths prompt
  const horizonNote = `Investment horizon stated as: ${horizon}`;

  return `${VOICE}

You are Artha's goal coach. Help this investor build a concrete, realistic plan. Be honest — if the goal is unrealistic with current behaviour, say so clearly. Sound like a mentor, not a report generator.

CURRENT SITUATION:
${totalsBlock(p, ctx)}

PORTFOLIO HOLDINGS:
${holdingLines(p)}

${horizonNote}

YOUR TASK — do these calculations first, then write the response:
1. At ${sip}/month, starting from ₹${p.totalValue.toFixed(0)}, at 12% annual CAGR — what is the projected portfolio value at the end of their horizon?
2. To reach ${goalAmount} — what monthly SIP is actually needed, starting from ₹${p.totalValue.toFixed(0)}, at 12% CAGR, in the same horizon?
3. Is the current plan on track, behind, or wildly unrealistic?

Write your response in these EXACT sections:

## The Honest Numbers
| | Amount |
|---|---|
| Portfolio today | ₹${p.totalValue.toFixed(0)} |
| Current P&L | ${p.totalPnl >= 0 ? '+' : '-'}₹${Math.abs(p.totalPnl).toFixed(0)} (${p.totalPnlPct.toFixed(1)}%) |
| Planned monthly SIP | ${sip} |
| Projected value at 12% CAGR | ₹[your calculation] |
| Goal | ${goalAmount} by ${goalDate} |
| Gap | ₹[difference] |
| Monthly SIP needed to hit goal | ₹[your calculation] |

**Verdict in one sentence:** [On Track / Slightly Behind / Significantly Behind / Goal Needs Revision] — [plain English explanation, no fluff]

## Why Your Current Portfolio is Helping or Hurting This Goal
Look at the actual holdings. Are they high-growth? High-risk? Dividend payers?
2-3 sentences. Name specific stocks. Explain in plain English how each category affects goal-reaching.

## The Gap Plan — 3 Specific Actions
Numbered 1-2-3. Each must be a specific, doable action tied to the goal:
- Not "diversify more" — instead: "Move ₹X from [holding] into [specific Indian fund] because..."
- Not "increase SIP" — instead: "Set up a ₹X SIP in [specific NSE fund] — here's exactly how on Groww..."

## What Happens If You Do Nothing
One paragraph. Calculate where this portfolio ends up if they change nothing — same SIP, same holdings, same behaviour. Use actual ₹ projections. Be honest if it's bad.

## The One Decision That Changes Everything
One specific thing — the most impactful single change they could make this month.
Name it, explain why it matters more than anything else.

---
⚠️ AI-generated, not SEBI-registered advice. Verify before acting.`;
}

// ── Portfolio story (80-word narrative) ───────────────────────────────────────

function buildStoryPrompt(p: PortfolioData, ctx: UserContext): string {
  const goal = ctx.goals[0];
  const goalLine = goal ? `Their goal: ₹${goal.targetAmount.toLocaleString('en-IN')} by ${goal.targetDate}.` : '';
  return `You are a wise financial mentor writing a personal note to an Indian investor. Write ONE flowing paragraph of exactly 70–85 words about their portfolio. Use their actual stock names, actual ₹ amounts, actual P&L percentages. Make it feel personal and insightful — not like a report. Start with the most interesting thing about their portfolio. End with one honest observation about where they're headed. Plain English only. No bullet points. No sections. No markdown. No disclaimers.

PORTFOLIO:
${holdingLines(p)}

SUMMARY:
${totalsBlock(p, ctx)}
${goalLine}`;
}

// ── Priority (single most important action) ───────────────────────────────────

function buildPriorityPrompt(p: PortfolioData, ctx: UserContext): string {
  return `You are Artha. Write ONE sentence of maximum 15 words telling this Indian investor the single most important thing to do with their portfolio this week. Use their actual stock names or ₹ amounts. Return only the sentence — no labels, no markdown, no explanation, nothing else.

PORTFOLIO: ${holdingLines(p)}
SUMMARY: ${totalsBlock(p, ctx)}`;
}

// ── Micro-analysis (post-change feedback) ─────────────────────────────────────

interface PortfolioChangeEntry {
  type:      'added' | 'removed' | 'increased' | 'decreased' | 'goal_set';
  stockName: string;
  ticker:    string;
  previousShares?: number;
  newShares?:      number;
}

export interface MicroContext {
  changes:       PortfolioChangeEntry[];
  previousTotal: number;
  previousScore: number;
}

function buildMicroPrompt(p: PortfolioData, ctx: UserContext, micro: MicroContext): string {
  const goal      = ctx.goals[0];
  const goalLine  = goal
    ? `Goal: ₹${goal.targetAmount.toLocaleString('en-IN')} by ${goal.targetDate}`
    : 'No goal set';
  const horizon   = ctx.investmentHorizon || 'not specified';

  const changeLines = micro.changes.length > 0
    ? micro.changes.map((c) => {
        if (c.type === 'goal_set') return `GOAL SET: ${c.stockName}`;
        const shares = c.type === 'added' || c.type === 'removed'
          ? ''
          : ` (${c.previousShares} → ${c.newShares} shares)`;
        return `${c.type.toUpperCase()}: ${c.stockName} (${c.ticker})${shares}`;
      }).join('\n')
    : '(no structural changes — goal or context updated)';

  return `${VOICE}

The user just made these changes to their Artha portfolio:
${changeLines}

Previous portfolio value: ₹${micro.previousTotal.toFixed(0)}
New portfolio value: ₹${p.totalValue.toFixed(0)}
Previous health score: ${micro.previousScore}/100
${goalLine}
Investment horizon: ${horizon}

CURRENT PORTFOLIO AFTER CHANGES:
${holdingLines(p)}

Given these changes, respond in EXACTLY this format — nothing else, no markdown headers:

VERDICT: [One sentence. Was this a good move? Yes or no, direct. Use their actual stock names.]
SCORE: [Estimate their new health score as a single integer 0-100. Consider: number of holdings, largest position weight, P&L mix.]
NEXT: [One specific next action. Format: NSE:TICKER — one-line reason why, plain English.]

Total response must be under 80 words. Plain English. No jargon. No asterisks. No bullet points outside this format.`;
}

// ── Macro / Market Intelligence ───────────────────────────────────────────────

function buildMacroPrompt(p: PortfolioData, _ctx: UserContext): string {
  const tickers = p.holdings.map(h => h.ticker).join(', ');
  return `You are Artha's Indian market analyst. Analyze how current macroeconomic trends in India affect this specific investor's portfolio.

HOLDINGS: ${tickers}
${holdingLines(p)}

Return ONLY valid JSON — no markdown, no code blocks, no explanation. Exact structure:
{
  "themes": [
    {
      "title": "3-5 word theme name",
      "what": "One sentence: what is happening in Indian markets right now",
      "portfolioImpact": "One sentence: how this directly affects one of the investor's holdings — name the stock ticker",
      "sentiment": "bullish",
      "affectedTicker": "NSE ticker or null"
    }
  ]
}

Rules:
- Include exactly 3 themes.
- sentiment must be exactly: "bullish", "bearish", or "neutral".
- Every theme must reference a stock from the investor's actual portfolio above.
- Focus on Indian market drivers: RBI policy, FII/DII flows, India VIX, sector rotation, monsoon impact, Budget implications.
- affectedTicker must be one of: ${tickers} — or null if no match.
- Return only the JSON object. Nothing else.`;
}

// ── Main prompt dispatcher ────────────────────────────────────────────────────

function buildPrompt(
  type:           AnalysisType,
  p:              PortfolioData,
  ctx:            UserContext,
  sessionMemory?: SessionMemory,
  microContext?:  MicroContext,
): string {
  const prefix = sessionMemory ? buildContextSummary(sessionMemory) : '';
  switch (type) {
    case 'health':   return prefix + buildHealthPrompt(p, ctx);
    case 'scenario': return prefix + buildScenarioPrompt(p, ctx);
    case 'picks':    return prefix + buildPicksPrompt(p, ctx);
    case 'goal':     return prefix + buildGoalPrompt(p, ctx);
    case 'micro':    return microContext ? buildMicroPrompt(p, ctx, microContext) : prefix + buildHealthPrompt(p, ctx);
    case 'story':    return buildStoryPrompt(p, ctx);
    case 'priority': return buildPriorityPrompt(p, ctx);
    case 'macro':    return buildMacroPrompt(p, ctx);
  }
}

// ── India-only system instruction for picks ───────────────────────────────────

const PICKS_SYSTEM_PROMPT = `You are Artha, an AI portfolio analyst for Indian retail investors.

ABSOLUTE RULES — NEVER BREAK THESE:
1. ONLY suggest stocks listed on NSE or BSE India
2. NEVER mention: Visa, Apple, Google, Amazon, Tesla, Meta, Microsoft, Netflix, or ANY US/foreign company
3. NEVER use: NYSE, NASDAQ, S&P 500, or any non-Indian index
4. ALL stock suggestions must have an NSE: or BSE: ticker prefix
5. If you cannot find suitable Indian stocks, suggest Indian mutual funds or Nifty/Sensex index funds instead

You write in plain English for non-finance users.
Use ₹ for all amounts. Be specific, not generic.`;

// ── Handler ────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  console.log('API called with type:', req.body?.type);

  const { type, portfolioData, userContext, sessionContext, microContext, rawQuery, scenarioName, scenarioDescription } = req.body as {
    type:                 AnalysisType;
    portfolioData:        PortfolioData;
    userContext:          UserContext;
    sessionContext?:      SessionMemory;
    microContext?:        MicroContext;
    rawQuery?:            string;
    scenarioName?:        string;
    scenarioDescription?: string;
  };

  if (!type || !portfolioData) {
    return res.status(400).json({ error: 'Missing required fields: type, portfolioData' });
  }

  try {
    let text: string;

    if (type === 'micro' && rawQuery) {
      // Direct prompt for extraction tasks (e.g. parse scenario recommendations)
      text = await geminiGenerate(apiKey, [{ text: rawQuery }]);
    } else if (type === 'picks') {
      // Prepend India-only system instruction to the picks prompt
      const userPrompt = PICKS_SYSTEM_PROMPT + '\n\n' + buildPicksPrompt(portfolioData, userContext ?? {});
      text = await geminiGenerate(apiKey, [{ text: userPrompt }]);
    } else {
      let prompt = buildPrompt(type, portfolioData, userContext ?? {}, sessionContext, microContext);
      // Inject scenario context so AI knows which scenario is being analysed
      if (type === 'scenario' && scenarioName) {
        prompt = `Scenario being analysed: **${scenarioName}**${scenarioDescription ? ` — ${scenarioDescription}` : ''}\n\n` + prompt;
      }
      text = await geminiGenerate(apiKey, [{ text: prompt }]);
    }

    return res.status(200).json({ text });
  } catch (err) {
    const error = err as { message?: string; status?: number };
    console.error('Gemini error:', error.message, error.status);
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit hit — please wait a minute and try again.' });
    }
    return res.status(502).json({ error: `Gemini API error: ${error.message ?? 'Unknown error'}` });
  }
}
