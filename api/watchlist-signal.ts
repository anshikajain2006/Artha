import type { VercelRequest, VercelResponse } from '@vercel/node';
import { geminiGenerate } from './_gemini';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  const { stockName, ticker, currentPrice, targetPrice, portfolioSummary } = req.body as {
    stockName:        string;
    ticker:           string;
    currentPrice:     number | null;
    targetPrice?:     number;
    portfolioSummary: string;
  };

  if (!stockName || !ticker) {
    return res.status(400).json({ error: 'Missing required fields: stockName, ticker' });
  }

  const priceStr    = currentPrice != null ? `₹${currentPrice.toLocaleString('en-IN')}` : 'unavailable';
  const targetStr   = targetPrice   ? `\nUser's target buy price: ₹${targetPrice.toLocaleString('en-IN')}` : '';
  const portfolioStr = portfolioSummary || 'No existing portfolio data';

  const prompt = `You are Artha's watchlist analyst for Indian retail investors.

Stock: ${stockName} (${ticker})
Current market price: ${priceStr}${targetStr}
User's existing portfolio: ${portfolioStr}

Give a concise buy/wait/avoid signal. Consider: current valuation relative to any target price provided, the user's existing sector/stock exposure, and Indian market context (NSE/BSE, SEBI, tax implications).

Respond with ONLY valid JSON. No markdown fences, no extra text, nothing else:
{"signal":"Buy","reason":"One or two sentences max. Be specific about the actual stock name and current price, not generic platitudes."}

The signal field must be exactly one of: "Buy", "Wait", or "Avoid".`;

  try {
    const raw = (await geminiGenerate(apiKey, [{ text: prompt }])).trim();

    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: { signal: 'Buy' | 'Wait' | 'Avoid'; reason: string };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({
        error: 'Gemini returned non-JSON output.',
        raw:   cleaned.slice(0, 300),
      });
    }

    if (!['Buy', 'Wait', 'Avoid'].includes(parsed.signal)) {
      return res.status(502).json({ error: 'Invalid signal value from Gemini.', raw: cleaned });
    }

    return res.status(200).json({ signal: parsed.signal, reason: parsed.reason });
  } catch (err) {
    const error = err as { message?: string; status?: number };
    console.error('Gemini error:', error.message, error.status);
    return res.status(502).json({ error: `Gemini API error: ${error.message ?? 'Unknown error'}` });
  }
}
