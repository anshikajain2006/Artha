# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

- **Dev (full stack):** `npm run dev` — starts Express API server (port 3333) + Vite frontend (port 5173) via `tsx dev-server.ts`
- **Build:** `npm run build` — runs `tsc -b && vite build`
- **Lint:** `npm run lint` — ESLint 9 with flat config + TypeScript strict rules
- **Preview:** `npm run preview` — serves production build locally

No test runner is configured.

## Architecture

Artha is a portfolio intelligence app: React frontend + Vercel serverless backend + Supabase (PostgreSQL) + Claude Haiku 4.5 for AI analysis.

### Frontend (`/src/`)

- **React 19 + React Router v7 + Vite 8 + TypeScript 5.9 (strict)**
- **Styling:** Tailwind CSS v4 with custom design tokens defined in `src/index.css` (dark theme with gold accent)
- **Routing:** React Router v7 with protected routes gated on auth and portfolio existence
- **State:** React Context (`SessionContextProvider`) for in-session AI memory; Supabase auth via `useAuth()` hook; local state otherwise
- **Session memory pattern:** `SessionContextProvider` tracks last health analysis, scenario tests, stock picks, goal verdicts, and recent user actions — passed to AI on each request for conversational continuity. Resets on page reload.

### Backend (`/api/`)

- **Vercel serverless functions** — each file is a separate endpoint
- **`dev-server.ts`** (Express) mirrors Vercel functions locally on port 3333; Vite proxies `/api/*` to it
- **Shared modules:** `_gemini.ts` (Anthropic Claude wrapper), `_news.ts` (market data utils) — prefixed with `_` to indicate non-handler
- **AI model:** Claude Haiku 4.5 via Anthropic SDK (named `_gemini.ts` for historical reasons — it actually uses Anthropic)

### Key API Endpoints

| Endpoint | Purpose |
|---|---|
| `analyze.ts` | Main AI analysis (health, scenario, picks, goal, micro) |
| `import-screenshot.ts` | Gemini Vision OCR for portfolio screenshots |
| `scenario-simulate.ts` | Bull/base/bear projection |
| `watchlist-signal.ts` | AI buy/hold/sell signals |
| `commentary.ts` | Daily personalized insights |
| `prices.ts` | Live prices (NSE → Yahoo → Stooq fallback chain) |
| `weekly-digest.ts` | Cron job (Sundays 06:00 UTC) — email digest via Resend |

### Database (Supabase)

- **Migrations** in `/supabase/`
- **RLS enforced** — users can only access their own data
- **Key tables:** `portfolios` (holdings as JSONB), `health_scores`, `watchlist`, `goals`, `email_preferences`
- **Service role key** used only by cron jobs (weekly digest) to bypass RLS

### Security Model

- **API keys (GEMINI_API_KEY, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY) are server-side only** — no `VITE_` prefix
- **VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are intentionally public** — protected by RLS
- Frontend never has access to AI or service role keys

### Deployment

- **Vercel** — serverless functions auto-deployed from `/api/`
- **Cron:** Weekly digest configured in `vercel.json` (Sundays 06:00 UTC)
- **SPA routing:** Vercel rewrites all non-API requests to `/index.html`
- **Max function duration:** 30 seconds

### Price Data Strategy

Multiple fallback sources for Indian stock prices: NSE direct → Yahoo Finance → Stooq. Client-side 5-minute cache. If all live sources fail, falls back to cost basis (avgBuyPrice).
