/**
 * Local dev API server — mirrors /api/* Vercel functions for `npm run dev`.
 * Run with: npx tsx dev-server.ts
 * Vite proxies /api/* to this server on port 3333.
 */

import express from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';

// Load .env.local manually
try {
  const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    process.env[key] = val;
  }
} catch {
  console.warn('No .env.local found');
}

const app = express();
app.use(express.json({ limit: '20mb' }));

// Shim VercelRequest/VercelResponse → Express req/res
function makeVercelHandler(handler: Function) {
  return async (req: express.Request, res: express.Response) => {
    const vReq = Object.assign(req, { body: req.body }) as any;
    const vRes = {
      status: (code: number) => ({ json: (data: any) => res.status(code).json(data) }),
    } as any;
    // Allow handler to call res.status(x).json() directly on the real res too
    vRes.json  = (data: any) => res.json(data);
    vRes.status = (code: number) => { res.status(code); return vRes; };
    await handler(vReq, vRes);
  };
}

async function main() {
  const { default: analyzeHandler }          = await import('./api/analyze.js');
  const { default: screenshotHandler }       = await import('./api/import-screenshot.js');
  const { default: watchlistSignalHandler }  = await import('./api/watchlist-signal.js');
  const { default: commentaryHandler }       = await import('./api/commentary.js');
  const { default: scenarioSimHandler }      = await import('./api/scenario-simulate.js');
  const { default: historicalPricesHandler } = await import('./api/historical-prices.js');
  const { default: pricesHandler }           = await import('./api/prices.js');

  app.post('/api/analyze',              makeVercelHandler(analyzeHandler));
  app.post('/api/import-screenshot',    makeVercelHandler(screenshotHandler));
  app.post('/api/watchlist-signal',     makeVercelHandler(watchlistSignalHandler));
  app.post('/api/commentary',           makeVercelHandler(commentaryHandler));
  app.post('/api/scenario-simulate',    makeVercelHandler(scenarioSimHandler));
  app.post('/api/historical-prices',    makeVercelHandler(historicalPricesHandler));
  app.post('/api/prices',               makeVercelHandler(pricesHandler));

  app.listen(3333, () => {
    console.log('Local API server running on http://localhost:3333');
    console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✓ loaded' : '✗ missing');
  });

  // Spawn Vite dev server so a single `npm run dev` starts everything
  const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true });
  vite.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT',  () => { vite.kill('SIGINT');  process.exit(0); });
  process.on('SIGTERM', () => { vite.kill('SIGTERM'); process.exit(0); });
}

main().catch(console.error);
