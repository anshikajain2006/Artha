/**
 * CSV / Excel parser for portfolio imports.
 *
 * Delegates broker detection and parsing to brokerParsers.ts.
 * Keeps a stable ParseResult shape for CSVImport.tsx backward compat.
 */

import Papa   from 'papaparse';
import * as XLSX from 'xlsx';
import {
  type BrokerFormat,
  type Holding,
  detectBroker,
  detectExcelBroker,
  parseGrowwPnlExcel,
  parseBrokerCSV,
  generateTicker,
} from './brokerParsers';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ParsedHolding {
  name:           string;
  ticker:         string;
  shares:         number;
  avgBuyPrice:    number;
  currentPrice?:  number;
  currentValue?:  number;
  investedValue?: number;
  pnl?:           number;
  buyDate?:       string; // raw date string from broker
}

/** All broker formats + generic fallback + unmapped for column-mapper UI */
export type DetectedFormat = BrokerFormat | 'generic' | 'unmapped';

export interface ColumnMap {
  name:        string;
  ticker:      string | null;
  shares:      string;
  avgBuyPrice: string;
}

export interface ParseResult {
  format:    DetectedFormat;
  holdings:  ParsedHolding[];
  headers:   string[];
  rawRows:   Record<string, string>[];
  columnMap: ColumnMap | null;
  error?:    string;
}

// ── Holding → ParsedHolding bridge ────────────────────────────────────────────

function toLegacy(h: Holding): ParsedHolding {
  return {
    name:          h.stockName,
    ticker:        h.ticker,
    shares:        h.shares,
    avgBuyPrice:   h.avgPrice,
    currentPrice:  h.currentPrice,
    currentValue:  h.currentValue,
    investedValue: h.investedValue,
    pnl:           h.pnl,
    buyDate:       h.buyDate,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function num(v: string | undefined): number {
  if (!v) return 0;
  return parseFloat(v.replace(/[₹$€£,\s]/g, '')) || 0;
}

function str(v: string | undefined): string {
  return (v ?? '').trim();
}

// ── Generic / fuzzy column matching (fallback) ────────────────────────────────

const NAME_RE  = /\b(name|stock|scrip|company)\b/i;
const TICK_RE  = /\b(ticker|symbol|code|isin)\b/i;
const QTY_RE   = /\b(qty|quantity|shares|units|holding)\b/i;
const PRICE_RE = /\b(avg|average|price|cost|rate)\b/i;

export function buildAutoMap(headers: string[]): ColumnMap | null {
  const nameCol  = headers.find((h) => NAME_RE.test(h));
  const tickCol  = headers.find((h) => TICK_RE.test(h));
  const qtyCol   = headers.find((h) => QTY_RE.test(h));
  const priceCol = headers.find((h) => PRICE_RE.test(h));
  if (!nameCol || !qtyCol || !priceCol) return null;
  return { name: nameCol, ticker: tickCol ?? null, shares: qtyCol, avgBuyPrice: priceCol };
}

function applyMap(rows: Record<string, string>[], map: ColumnMap): ParsedHolding[] {
  return rows
    .map((r) => {
      const name = str(r[map.name]);
      return {
        name,
        ticker:      map.ticker ? str(r[map.ticker]).toUpperCase() : generateTicker(name),
        shares:      num(r[map.shares]),
        avgBuyPrice: num(r[map.avgBuyPrice]),
      };
    })
    .filter((h) => h.name && h.shares > 0);
}

// ── Main public API ────────────────────────────────────────────────────────────

export function parseCSV(csvText: string): ParseResult {
  const result = Papa.parse<Record<string, string>>(csvText, {
    header:          true,
    skipEmptyLines:  true,
    transformHeader: (h) => h.trim(),
  });

  const headers = (result.meta.fields ?? []) as string[];
  const rawRows = result.data;
  const broker  = detectBroker(headers, rawRows);

  // Known broker — use broker parser
  if (broker !== 'unknown') {
    const holdings = parseBrokerCSV(broker, rawRows).map(toLegacy);
    return { format: broker, holdings, headers, rawRows, columnMap: null };
  }

  // Generic fuzzy fallback
  const map = buildAutoMap(headers);
  if (map) {
    return { format: 'generic', holdings: applyMap(rawRows, map), headers, rawRows, columnMap: map };
  }

  return { format: 'unmapped', holdings: [], headers, rawRows, columnMap: null };
}

export function parseExcel(arrayBuffer: ArrayBuffer): ParseResult {
  const workbook  = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];

  const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header:  1,
    defval:  '',
    raw:     false,
  }) as string[][];

  const broker = detectExcelBroker(rows);

  // Groww P&L Excel (has section markers, needs special parsing)
  if (broker === 'groww-pnl') {
    const parsed = parseGrowwPnlExcel(rows);
    if (!parsed.ok) {
      return { format: 'unmapped', holdings: [], headers: [], rawRows: [], columnMap: null, error: parsed.error };
    }
    return {
      format:    'groww-pnl',
      holdings:  parsed.holdings.map(toLegacy),
      headers:   [],
      rawRows:   [],
      columnMap: null,
    };
  }

  // All other Excel formats: find header row, build record array, dispatch
  const HEADER_RE = /name|stock|scrip|ticker|symbol|qty|quantity|shares|price|cost|avg|tradingsymbol/i;
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const nonEmpty = rows[i].filter((c) => String(c).trim() !== '');
    if (nonEmpty.length >= 2 && nonEmpty.some((c) => HEADER_RE.test(String(c)))) {
      headerIdx = i;
      break;
    }
  }

  const headers = rows[headerIdx].map((h) => String(h).trim());
  const rawRows = rows
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = String(r[i] ?? '').trim(); });
      return obj;
    });

  const detectedBroker = detectBroker(headers, rawRows);

  if (detectedBroker !== 'unknown') {
    const holdings = parseBrokerCSV(detectedBroker, rawRows).map(toLegacy);
    return { format: detectedBroker, holdings, headers, rawRows, columnMap: null };
  }

  const map = buildAutoMap(headers);
  if (map) {
    return { format: 'generic', holdings: applyMap(rawRows, map), headers, rawRows, columnMap: map };
  }

  return { format: 'unmapped', holdings: [], headers, rawRows, columnMap: null };
}

export function applyColumnMap(
  rawRows: Record<string, string>[],
  map:     ColumnMap,
): ParsedHolding[] {
  return applyMap(rawRows, map);
}

// ── Sample CSV ─────────────────────────────────────────────────────────────────

export const SAMPLE_CSV =
  'Stock Name,Ticker,Shares,Avg Buy Price\n' +
  'Reliance Industries,RELIANCE,10,2500.00\n' +
  'Tata Consultancy Services,TCS,5,3800.00\n';
