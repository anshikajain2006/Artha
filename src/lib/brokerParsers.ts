/**
 * Broker-aware parser hub.
 *
 * Supports:
 *   groww-pnl      — Groww P&L Excel (Unrealised trades section)
 *   groww-holdings — Groww Holdings CSV export
 *   zerodha        — Zerodha Kite Holdings CSV
 *   upstox         — Upstox Holdings CSV
 *   angel          — Angel One Holdings CSV
 *   unknown        — Not recognised; caller should show column mapper
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type BrokerFormat =
  | 'groww-pnl'
  | 'groww-holdings'
  | 'zerodha'
  | 'upstox'
  | 'angel'
  | 'unknown';

export interface Holding {
  stockName:     string;
  ticker:        string;
  shares:        number;
  avgPrice:      number;
  currentPrice?: number;
  currentValue?: number;
  investedValue?: number;
  pnl?:          number;
  buyDate?:      string; // raw date string from broker export, e.g. "30/07/2025"
}

export type BrokerParseResult =
  | { ok: true;  format: BrokerFormat; holdings: Holding[] }
  | { ok: false; error: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

export function num(v: string | undefined): number {
  if (!v) return 0;
  return parseFloat(v.replace(/[₹$€£,\s]/g, '')) || 0;
}

export function str(v: string | undefined): string {
  return (v ?? '').trim();
}

function orUndef(n: number): number | undefined {
  return n !== 0 ? n : undefined;
}

// ── Ticker generation ─────────────────────────────────────────────────────────

const TICKER_OVERRIDES: [RegExp, string][] = [
  [/BILLIONBRAINS/i,                    'GROWW'],
  [/VODAFONE IDEA/i,                    'IDEA'],
  [/ICICIPRAMC.*SILVE/i,                'SILVERIETF'],
  [/ICICISILVE/i,                       'SILVERIETF'],
  [/SILVER.*ETF|ETF.*SILVER/i,          'SILVERIETF'],
  [/GOLD.*ETF|ETF.*GOLD|GOLDBEES/i,     'GOLDETF'],
  [/NIFTYBEES|NIFTY.*ETF|ETF.*NIFTY/i, 'NIFTYBEES'],
  [/BHARAT COKING/i,                    'BHARATCOAL'],
  [/PARADEEP PHOSPH/i,                  'PARADEEPPH'],
];

export function generateTicker(name: string): string {
  const upper = name.toUpperCase();
  for (const [re, ticker] of TICKER_OVERRIDES) {
    if (re.test(upper)) return ticker;
  }
  const cleaned = name
    .replace(/\bLIMITED\b/gi,      '')
    .replace(/\bLTD\.?\b/gi,       '')
    .replace(/\bPVT\.?\b/gi,       '')
    .replace(/\bPRIVATE\b/gi,      '')
    .replace(/\bINDIA\b/gi,        '')
    .replace(/\bTECHNOLOGIES\b/gi, '')
    .replace(/\bINDUSTRIES\b/gi,   '')
    .replace(/\bVN\s*L\b/gi,       '')
    .trim();
  const first = cleaned.split(/\s+/)[0] ?? '';
  return first.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

// ── Broker detection ──────────────────────────────────────────────────────────

/**
 * Detects broker from CSV headers + first few data rows.
 * For Excel files with section markers, use detectExcelBroker instead.
 */
export function detectBroker(
  headers:      string[],
  firstFewRows: Record<string, string>[],
): BrokerFormat {
  const lc = headers.map((h) => h.trim().toLowerCase());

  // Groww Holdings CSV: "Stock Name", "Avg. Cost Price", "Current Value"
  if (
    lc.some((h) => h === 'stock name') &&
    lc.some((h) => /avg\.?\s*cost\s*price/i.test(h)) &&
    lc.some((h) => h === 'current value')
  ) return 'groww-holdings';

  // Zerodha Kite: "tradingsymbol", "average_price"
  if (lc.includes('tradingsymbol') && lc.includes('average_price'))
    return 'zerodha';

  // Upstox: "Symbol", "Avg. Cost", "LTP"
  if (
    lc.some((h) => h === 'symbol') &&
    lc.some((h) => /avg\.?\s*cost/i.test(h)) &&
    lc.some((h) => h === 'ltp')
  ) return 'upstox';

  // Angel One: "Trading Symbol", "Net Qty", "Avg. Price"
  if (
    lc.some((h) => h === 'trading symbol') &&
    lc.some((h) => h === 'net qty')
  ) return 'angel';

  // Scan first 5 rows for Groww P&L markers (CSV fallback — rare)
  const sampleText = firstFewRows
    .slice(0, 5)
    .flatMap((r) => Object.values(r))
    .join(' ');
  if (/unreali[sz]ed\s+trades/i.test(sampleText)) return 'groww-pnl';

  return 'unknown';
}

/**
 * Detects broker from a raw Excel 2D array (before header parsing).
 */
export function detectExcelBroker(rows: string[][]): BrokerFormat {
  const flatText = rows
    .slice(0, 50)
    .flatMap((r) => r.map((c) => String(c)))
    .join(' ');

  if (/unreali[sz]ed\s+trades/i.test(flatText) || /reali[sz]ed\s+trades/i.test(flatText))
    return 'groww-pnl';

  // Try to find a header row and delegate to detectBroker
  const HEADER_RE = /name|stock|scrip|ticker|symbol|qty|quantity|shares|price|cost|avg|tradingsymbol/i;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const nonEmpty = rows[i].filter((c) => String(c).trim() !== '');
    if (nonEmpty.length >= 2 && nonEmpty.some((c) => HEADER_RE.test(String(c)))) {
      const headers = rows[i].map((h) => String(h).trim());
      const detected = detectBroker(headers, []);
      if (detected !== 'unknown') return detected;
      break;
    }
  }
  return 'unknown';
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a raw date string from broker exports into a Date.
 * Handles: "dd/mm/yyyy", "mm/dd/yyyy", "dd-MMM-yy", "dd-MMM-yyyy", ISO strings.
 */
export function parseFlexDate(s: string): Date | null {
  if (!s) return null;
  const clean = s.trim();

  // ISO or native JS-parseable (e.g. "2025-07-30", "Jul 30, 2025")
  const direct = new Date(clean);
  if (!isNaN(direct.getTime()) && direct.getFullYear() > 1970) return direct;

  // dd/mm/yyyy (Indian) — distinct from mm/dd/yyyy by day > 12 check later
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean);
  if (slash) {
    // Attempt both interpretations; prefer dd/mm if day > 12
    const [, a, b, y] = slash;
    const aNum = parseInt(a);
    const asDD = new Date(`${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`); // dd/mm/yyyy
    const asMM = new Date(`${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`); // mm/dd/yyyy
    if (aNum > 12 && !isNaN(asDD.getTime())) return asDD; // must be dd/mm
    if (!isNaN(asDD.getTime())) return asDD; // default: Indian dd/mm
    if (!isNaN(asMM.getTime())) return asMM;
  }

  // dd-MMM-yy or dd-MMM-yyyy  (e.g. "30-Jul-25", "30-Jul-2025")
  const dmy = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(clean);
  if (dmy) {
    const year = parseInt(dmy[3]) < 100 ? 2000 + parseInt(dmy[3]) : parseInt(dmy[3]);
    const d = new Date(`${dmy[1]} ${dmy[2]} ${year}`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

function pickEarlierDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const da = parseFlexDate(a), db = parseFlexDate(b);
  if (!da) return b;
  if (!db) return a;
  return da <= db ? a : b;
}

// ── Groww P&L Excel parser ────────────────────────────────────────────────────

export function parseGrowwPnlExcel(rows: string[][]): BrokerParseResult {
  // 1. Find the "Unrealised trades" section
  const unrealisedIdx = rows.findIndex((r) =>
    r.some((c) => /unreali[sz]ed\s+trades/i.test(String(c))),
  );

  if (unrealisedIdx === -1) {
    const hasRealised = rows.some((r) =>
      r.some((c) => /reali[sz]ed\s+trades/i.test(String(c))),
    );
    return {
      ok:    false,
      error: hasRealised
        ? 'This looks like a P&L report showing only realised trades. Please export your current Holdings from Groww instead, or ensure the file includes the Unrealised trades section.'
        : 'Could not find the "Unrealised trades" section. Please upload a Groww P&L or Holdings Excel export.',
    };
  }

  // 2. Find column header row
  let headerIdx = -1;
  for (let i = unrealisedIdx + 1; i < Math.min(unrealisedIdx + 6, rows.length); i++) {
    if (rows[i].filter((c) => String(c).trim() !== '').length >= 3) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, error: 'Found "Unrealised trades" section but could not locate column headers.' };
  }

  const headers = rows[headerIdx].map((c) => String(c).trim());
  const cell = (row: string[], col: string): string => {
    const idx = headers.findIndex((h) => h.toLowerCase() === col.toLowerCase());
    return idx >= 0 ? String(row[idx] ?? '').trim() : '';
  };

  // 3. Parse data rows
  const rawHoldings: Holding[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.filter((c) => String(c).trim() !== '').length === 0) break;
    if (row.some((c) => /disclaimer/i.test(String(c)))) break;

    const stockName = cell(row, 'Stock name');
    if (!stockName) continue;

    const shares = num(cell(row, 'Quantity'));
    if (shares <= 0) continue;

    const rawBuyDate = cell(row, 'Buy date').trim() || undefined;

    rawHoldings.push({
      stockName,
      ticker:       generateTicker(stockName),
      shares,
      avgPrice:     num(cell(row, 'Buy price')),
      currentValue: orUndef(num(cell(row, 'Closing value'))),
      pnl:          orUndef(num(cell(row, 'Unrealised P&L'))),
      buyDate:      rawBuyDate,
    });
  }

  // 4. Merge duplicate stock names (weighted average buy price)
  const merged = new Map<string, Holding>();
  for (const h of rawHoldings) {
    const ex = merged.get(h.stockName);
    if (ex) {
      const totalShares = ex.shares + h.shares;
      // Keep the earlier buy date when merging lots
      const earlierDate = pickEarlierDate(ex.buyDate, h.buyDate);
      merged.set(h.stockName, {
        ...h,
        shares:       totalShares,
        avgPrice:     ((ex.shares * ex.avgPrice) + (h.shares * h.avgPrice)) / totalShares,
        currentValue: (ex.currentValue ?? 0) + (h.currentValue ?? 0) || undefined,
        pnl:          (ex.pnl ?? 0)          + (h.pnl ?? 0)          || undefined,
        buyDate:      earlierDate,
      });
    } else {
      merged.set(h.stockName, { ...h });
    }
  }

  const holdings = Array.from(merged.values());
  if (holdings.length === 0) {
    return { ok: false, error: 'No holdings found in the Unrealised trades section. The file may be empty or in an unexpected format.' };
  }

  return { ok: true, format: 'groww-pnl', holdings };
}

// ── Groww Holdings CSV ────────────────────────────────────────────────────────

export function parseGrowwHoldings(rows: Record<string, string>[]): Holding[] {
  return rows
    .map((r) => {
      const avgCol = Object.keys(r).find((k) => /avg.*cost.*price/i.test(k)) ?? 'Avg. Cost Price';
      const stockName = str(r['Stock Name']);
      return {
        stockName,
        ticker:        generateTicker(stockName),
        shares:        num(r['Quantity']),
        avgPrice:      num(r[avgCol]),
        currentValue:  orUndef(num(r['Current Value'])),
        investedValue: orUndef(num(r['Invested Value'])),
        pnl:           orUndef(num(r['P&L'])),
      };
    })
    .filter((h) => h.stockName && h.shares > 0);
}

// ── Zerodha Kite ──────────────────────────────────────────────────────────────

export function parseZerodha(rows: Record<string, string>[]): Holding[] {
  return rows
    .map((r) => ({
      stockName:    str(r['tradingsymbol']),
      ticker:       str(r['tradingsymbol']).toUpperCase(),
      shares:       num(r['quantity']),
      avgPrice:     num(r['average_price']),
      currentPrice: orUndef(num(r['last_price'])),
      pnl:          orUndef(num(r['pnl'])),
    }))
    .filter((h) => h.stockName && h.shares > 0);
}

// ── Upstox ────────────────────────────────────────────────────────────────────

export function parseUpstox(rows: Record<string, string>[]): Holding[] {
  return rows
    .map((r) => {
      const ticker     = str(r['Symbol']).toUpperCase();
      const stockName  = str(r['Instrument']) || ticker;
      const avgCostKey = Object.keys(r).find((k) => /avg\.?\s*cost/i.test(k)) ?? 'Avg. Cost';
      const pnlKey     = Object.keys(r).find((k) => /^p&l$|^pnl$/i.test(k)) ?? 'P&L';
      return {
        stockName,
        ticker,
        shares:       num(r['Qty']),
        avgPrice:     num(r[avgCostKey]),
        currentPrice: orUndef(num(r['LTP'])),
        pnl:          orUndef(num(r[pnlKey])),
      };
    })
    .filter((h) => h.stockName && h.shares > 0);
}

// ── Angel One ─────────────────────────────────────────────────────────────────

export function parseAngel(rows: Record<string, string>[]): Holding[] {
  return rows
    .map((r) => {
      const ticker = str(r['Trading Symbol']).toUpperCase();
      return {
        stockName:    ticker,
        ticker,
        shares:       num(r['Net Qty']),
        avgPrice:     num(r['Avg. Price']),
        currentPrice: orUndef(num(r['LTP'])),
        currentValue: orUndef(num(r['Current Value'])),
        pnl:          orUndef(num(r['P&L'])),
      };
    })
    .filter((h) => h.stockName && h.shares > 0);
}

// ── CSV dispatch ──────────────────────────────────────────────────────────────

export function parseBrokerCSV(
  format: BrokerFormat,
  rows:   Record<string, string>[],
): Holding[] {
  switch (format) {
    case 'groww-holdings': return parseGrowwHoldings(rows);
    case 'zerodha':        return parseZerodha(rows);
    case 'upstox':         return parseUpstox(rows);
    case 'angel':          return parseAngel(rows);
    default:               return [];
  }
}
