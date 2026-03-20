import type { VercelRequest, VercelResponse } from '@vercel/node';
import { geminiGenerate } from './_gemini';

// ── Types ─────────────────────────────────────────────────────────────────────

interface HoldingInput {
  name: string; ticker: string; shares: number; avgBuyPrice: number;
  currentPrice: number; currentValue: number; pnl: number; pnlPct: number; weight: number;
}

interface UserContextInput {
  goals:             { name: string; targetAmount: number; targetDate: string }[];
  investmentHorizon: string;
  monthlyInvestment: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function holdingLines(holdings: HoldingInput[]): string {
  if (holdings.length === 0) return '(empty)';
  return holdings.map((h) =>
    `  • ${h.name} (${h.ticker}): ${h.shares} shares | avg ₹${h.avgBuyPrice.toFixed(0)} | now ₹${h.currentPrice.toFixed(0)} | value ₹${h.currentValue.toFixed(0)} | ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct.toFixed(1)}% P&L | weight ${h.weight.toFixed(1)}%`,
  ).join('\n');
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { scenarioName, scenarioDesc, currentHoldings, sandboxHoldings, userContext } = req.body as {
    scenarioName:    string;
    scenarioDesc:    string;
    currentHoldings: HoldingInput[];
    sandboxHoldings: HoldingInput[];
    userContext:     UserContextInput;
  };

  if (!scenarioName || !currentHoldings || !sandboxHoldings) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const goalLine   = userContext?.goals?.length > 0
    ? `₹${userContext.goals[0].targetAmount.toLocaleString('en-IN')} by ${userContext.goals[0].targetDate}`
    : 'no goal set';
  const sip        = userContext?.monthlyInvestment > 0
    ? `₹${userContext.monthlyInvestment.toLocaleString('en-IN')}/month`
    : 'not set';
  const horizon    = userContext?.investmentHorizon || 'not specified';
  const currentTotal = currentHoldings.reduce((a, h) => a + h.currentValue, 0);
  const sandboxTotal = sandboxHoldings.reduce((a, h) => a + h.currentValue, 0);

  const prompt = `You are Artha's scenario simulator for Indian retail investors. Compare two portfolio versions under the same market scenario to determine which is better positioned.

VOICE RULES — non-negotiable:
- Audience: Smart 22-year-old on Groww. Not a finance professional.
- Short sentences. Max 20 words each. Plain English only.
- Always pair ₹ amounts with percentages.
- NSE-listed Indian stocks and SEBI-registered Indian funds ONLY. Never suggest US stocks, S&P 500, or NASDAQ.
- Be direct and honest. No fluff.

SCENARIO: ${scenarioName}
What this means: ${scenarioDesc}

INVESTOR CONTEXT:
Goal: ${goalLine}
Monthly SIP: ${sip}
Investment horizon: ${horizon}

CURRENT PORTFOLIO (real, unmodified):
${holdingLines(currentHoldings)}
Total value: ₹${currentTotal.toFixed(0)}

SANDBOX PORTFOLIO (user's modified version):
${holdingLines(sandboxHoldings)}
Total value: ₹${sandboxTotal.toFixed(0)}

OUTPUT STRUCTURE — follow this exactly:

PART 1 — Output this JSON on one line. No markdown fence. No extra text before it. Valid JSON only:
{"current":{"score":<integer 0-100 — how well this portfolio survives the ${scenarioName} scenario>,"projectedImpact":"<eg -14% or +8% — estimated portfolio impact in this scenario>","goalStatus":"<On Track|Behind|Ahead — given this scenario, will they still hit ${goalLine}?>"},"sandbox":{"score":<integer 0-100>,"projectedImpact":"<eg -9% or +12%>","goalStatus":"<On Track|Behind|Ahead>"},"verdict":"<one honest sentence max 20 words comparing which version is better and why>"}

PART 2 — After the JSON, use these exact section headers:

## What happens to each holding

For EACH holding in the SANDBOX portfolio, one line only:
**[TICKER]** — [↑ or ↓ or →] [percentage eg +18% or -25%] — [one sentence: specific reason this stock reacts this way in a ${scenarioName} scenario]

Use ↑ for positive impact, ↓ for negative, → for neutral.

## The verdict on your goal

Is the CURRENT portfolio or the SANDBOX portfolio better positioned to reach ${goalLine} in a ${scenarioName} scenario? State which one directly. Then explain in 2–3 sentences using actual ₹ amounts and ticker names.

## 3 optimal changes to survive this scenario

Exactly 3 specific moves. NSE stocks and Indian funds ONLY. Format each as:
**[Add/Remove/Reduce]:** [Full stock name (NSE:TICKER)] — [2 sentences: why this helps in ${scenarioName} AND keeps them on track for ${goalLine}]

---
⚠️ AI-generated, not SEBI-registered advice. Verify before acting.`;

  try {
    const text = await geminiGenerate(apiKey, [{ text: prompt }]);
    return res.status(200).json({ text });
  } catch (err) {
    const error = err as { message?: string; status?: number };
    console.error('Gemini scenario-simulate error:', error.message, error.status);
    return res.status(502).json({ error: `Gemini API error: ${error.message ?? 'Unknown error'}` });
  }
}
