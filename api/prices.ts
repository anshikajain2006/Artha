import type { VercelRequest, VercelResponse } from '@vercel/node'

const SKIP = new Set(['TATAAMLTAT','TATAAMTAT','TATAAMLTATSILV',
  'TATAAMLTATAGOLD','UNKNOWN','NA'])

const CORRECTIONS: Record<string,string> = {
  SILVERIETF:'SILVERIETF', ICICIPRAMC:'SILVERIETF',
  GOLDETF:'GOLDBEES', GOLDIETF:'GOLDBEES',
  BHARATCOAL:'BHARATCOAL', PARADEEPPH:'PARADEEPPH',
  GROWW:'NYKAA', BILLIONBRAINS:'NYKAA',
  PATEL:'PATELENG', JSW:'JSWCEMENT',
  ENGINEERS:'ENGINERSIN', MMTC:'MMTC', GAIL:'GAIL',
  IDEA:'IDEA', CIPLA:'CIPLA', SUZLON:'SUZLON',
  BHARTIARTL:'BHARTIARTL', HDFCBANK:'HDFCBANK',
  INFY:'INFY', TCS:'TCS', RELIANCE:'RELIANCE',
}

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.nseindia.com',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function getPriceFromNSE(ticker: string): Promise<{ price: number; change: number } | null> {
  try {
    const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(ticker)}`
    const r = await fetch(url, {
      headers: NSE_HEADERS,
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    const json = await r.json() as {
      priceInfo?: {
        lastPrice?: number
        pChange?: number
      }
    }
    const price = json?.priceInfo?.lastPrice
    const change = json?.priceInfo?.pChange
    if (!price || price <= 0 || isNaN(price)) return null
    return {
      price: Math.round(price * 100) / 100,
      change: Math.round((change ?? 0) * 100) / 100,
    }
  } catch { return null }
}

async function getPriceFromStooq(ticker: string): Promise<{ price: number; change: number } | null> {
  const suffixes = ['.ns', '.bo']
  for (const suffix of suffixes) {
    try {
      const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}${suffix}&i=d`
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000),
      })
      if (!r.ok) continue
      const text = await r.text()
      const lines = text.trim().split('\n').filter(l => l.trim())
      if (lines.length < 3) continue
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
      const closeIdx = headers.indexOf('close')
      if (closeIdx === -1) continue
      const todayVals = lines[lines.length - 1].split(',')
      const prevVals  = lines[lines.length - 2].split(',')
      const close     = parseFloat(todayVals[closeIdx])
      const prevClose = parseFloat(prevVals[closeIdx])
      if (!close || close <= 0 || isNaN(close)) continue
      const change = prevClose > 0
        ? Math.round(((close - prevClose) / prevClose) * 10000) / 100
        : 0
      return { price: Math.round(close * 100) / 100, change }
    } catch { continue }
  }
  return null
}

async function getPrice(ticker: string, avg: number) {
  const t = CORRECTIONS[ticker.toUpperCase()] ?? ticker.toUpperCase()
  if (SKIP.has(t)) return { ticker, price: avg, change: 0, source: 'unavailable' }

  // Primary: NSE India API
  const nse = await getPriceFromNSE(t)
  if (nse) return { ticker, price: nse.price, change: nse.change, source: 'live' }

  // Fallback: Stooq daily history
  const stooq = await getPriceFromStooq(t)
  if (stooq) return { ticker, price: stooq.price, change: stooq.change, source: 'live' }

  // Last resort: cost basis
  return { ticker, price: avg, change: 0, source: 'unavailable' }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' })

  const { holdings } = req.body as {
    holdings?: { ticker: string; avgPrice: number }[]
  }

  if (!Array.isArray(holdings) || !holdings.length)
    return res.status(400).json({ error: 'holdings required' })

  const results = []
  for (let i = 0; i < holdings.length; i += 3) {
    const batch = holdings.slice(i, i + 3)
    const r = await Promise.all(
      batch.map(h => getPrice(h.ticker, h.avgPrice || 0))
    )
    results.push(...r)
    if (i + 3 < holdings.length)
      await new Promise(r => setTimeout(r, 200))
  }

  return res.status(200).json({ prices: results })
}
