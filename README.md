# Artha — AI Portfolio Intelligence

A premium portfolio analytics platform for Indian retail investors. Built with React, Vite, TypeScript, and Tailwind CSS. AI analysis is powered by Google Gemini 2.0 Flash running entirely on the server — **users of the deployed app never need their own API key.**

## Features

- **Portfolio entry** — add holdings manually or import from a brokerage screenshot via Gemini Vision
- **Live NSE/US prices** — Yahoo Finance integration with 5-minute cache
- **Health Score** — diversification, concentration risk, and profitability scoring
- **Scenario modelling** — bull / base / bear projections
- **AI analysis** — deep portfolio health, scenario interpretation, stock picks, and goal coaching
- **Goal Tracker** — SIP planning with AI coaching

## Security model

The Gemini API key lives **only** on the server (`/api/*.ts` serverless functions). It is read from `process.env.GEMINI_API_KEY` at request time and never sent to the browser. The frontend calls `/api/analyze` and `/api/import-screenshot` — plain HTTP endpoints with no credentials in the bundle.

## Deploying to Vercel

### Step 1 — Get a free Gemini API key

Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), sign in with a Google account, and create a new API key. The free tier is sufficient for personal use.

### Step 2 — Add the key in Vercel

1. Open your project in the [Vercel dashboard](https://vercel.com/dashboard)
2. Go to **Settings → Environment Variables**
3. Add a new variable:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** your key from Step 1
   - **Environment:** Production (and Preview if you want AI in preview deploys)
4. Click **Save**

### Step 3 — Deploy

```bash
vercel --prod
```

That's it. Anyone who visits the deployed URL gets full AI features — no setup required on their end.

## Local development

For frontend-only work (portfolio entry, price charts, health score):

```bash
npm install
npm run dev
```

For full AI features locally, use the Vercel CLI so the serverless functions run alongside the frontend:

```bash
npm install -g vercel
vercel dev
```

`vercel dev` reads `GEMINI_API_KEY` from `.env.local` and serves everything on a single port. Copy `.env.example` to `.env.local` and fill in your key:

```bash
cp .env.example .env.local
# then edit .env.local and set GEMINI_API_KEY=your-key-here
```

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, TypeScript, Tailwind CSS v4 |
| Routing | React Router v7 |
| AI | Google Gemini 2.0 Flash (`@google/generative-ai`) |
| API | Vercel serverless functions (`/api/*.ts`) |
| Prices | Yahoo Finance v8 chart API (proxied) |
| Fonts | Fraunces (display) + DM Sans (body) |

## Project structure

```
├── api/
│   ├── analyze.ts           # AI portfolio analysis — reads GEMINI_API_KEY server-side
│   └── import-screenshot.ts # Gemini Vision OCR — reads GEMINI_API_KEY server-side
├── src/
│   ├── components/
│   │   ├── PortfolioEntry.tsx
│   │   └── PortfolioImport.tsx
│   ├── hooks/
│   │   └── useArtha.ts
│   ├── lib/
│   │   ├── gemini.ts        # fetch wrapper only — no API key, no SDK
│   │   ├── prices.ts
│   │   └── mockPrices.ts
│   └── pages/
│       └── Dashboard.tsx
├── .env.example             # documents GEMINI_API_KEY (no VITE_ prefix)
└── vercel.json
```
