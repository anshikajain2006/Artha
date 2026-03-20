import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchNews } from './_news';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const result = await fetchNews();
    return res.status(200).json(result);
  } catch (err) {
    const error = err as Error;
    return res.status(500).json({ error: error.message });
  }
}
