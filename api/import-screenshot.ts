import type { VercelRequest, VercelResponse } from '@vercel/node';
import { geminiGenerate } from './_gemini';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ParsedHolding {
  name:         string;
  ticker:       string;
  shares:       number;
  avgBuyPrice:  number;
}

interface ParsedPortfolio {
  holdings: ParsedHolding[];
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a financial data extraction assistant. Your job is to extract portfolio holdings from a screenshot of a brokerage or portfolio app.

Extract every holding you can identify from the image and return ONLY a valid JSON object — no prose, no markdown fences, no explanation.

The JSON must follow this exact schema:
{
  "holdings": [
    {
      "name":        "<full company name>",
      "ticker":      "<exchange ticker symbol, e.g. RELIANCE or AAPL>",
      "shares":      <number of shares as a number>,
      "avgBuyPrice": <average buy / cost price per share as a number>
    }
  ]
}

Rules:
- Use NSE ticker symbols for Indian stocks (e.g. RELIANCE, TCS, INFY, HDFCBANK).
- Use standard NASDAQ/NYSE symbols for US stocks (e.g. AAPL, MSFT).
- If shares or avgBuyPrice are not visible in the image, make a best-effort estimate or set to 0.
- Ticker must be uppercase with no exchange suffix (no .NS, no .BO).
- Return an empty holdings array if no recognisable holdings are found.
- Output ONLY the JSON — absolutely nothing else.`;

// ── Handler ────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  const { imageBase64, mimeType } = req.body as {
    imageBase64: string;
    mimeType:    string;
  };

  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing required fields: imageBase64, mimeType' });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  if (!allowedTypes.includes(mimeType)) {
    return res.status(400).json({ error: `Unsupported image type: ${mimeType}. Use JPEG, PNG, or WebP.` });
  }

  try {
    const raw = (await geminiGenerate(apiKey, [
      { inlineData: { mimeType, data: imageBase64 } },
      { text: SYSTEM_PROMPT + '\n\nExtract all portfolio holdings from this screenshot and return the JSON.' },
    ])).trim();

    // Strip markdown code fences if the model adds them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: ParsedPortfolio;
    try {
      parsed = JSON.parse(cleaned) as ParsedPortfolio;
    } catch {
      return res.status(502).json({
        error: 'Gemini returned non-JSON output. The screenshot may be unreadable.',
        raw: cleaned.slice(0, 500),
      });
    }

    if (!Array.isArray(parsed.holdings)) {
      return res.status(502).json({ error: 'Unexpected response shape from Gemini Vision.' });
    }

    return res.status(200).json({ holdings: parsed.holdings });
  } catch (err) {
    const error = err as { message?: string; status?: number };
    console.error('Gemini error:', error.message, error.status);
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit hit — please wait a minute and try again.' });
    }
    const message = error.message ?? 'Unknown error';
    return res.status(502).json({ error: `Gemini API error: ${message}` });
  }
}
