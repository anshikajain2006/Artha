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

  const { prompt } = req.body as { prompt: string };
  if (!prompt) {
    return res.status(400).json({ error: 'Missing required field: prompt' });
  }

  try {
    const text = await geminiGenerate(apiKey, [{ text: prompt }]);
    return res.status(200).json({ text });
  } catch (err) {
    const error = err as { message?: string; status?: number };
    console.error('Gemini error:', error.message, error.status);
    return res.status(502).json({ error: `Gemini API error: ${error.message ?? 'Unknown error'}` });
  }
}
