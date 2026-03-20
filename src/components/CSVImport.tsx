import { useState, useRef, useCallback } from 'react';
import {
  parseCSV,
  parseExcel,
  applyColumnMap,
  buildAutoMap,
  SAMPLE_CSV,
  type ParseResult,
  type ColumnMap,
  type DetectedFormat,
} from '../lib/csvParser';
import type { PortfolioStock } from './PortfolioEntry';

// ── Design tokens ──────────────────────────────────────────────────────────────

const C = {
  bg:     '#0a0a0b',
  s1:     '#111113',
  s2:     '#18181b',
  gold:   '#d4a843',
  text:   '#f0efe8',
  muted:  '#9b9a94',
  subtle: '#5a5955',
  border: '#2a2a2f',
  green:  '#4ead84',
  red:    '#e05252',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

interface EditableRow {
  _id:          string;
  name:         string;
  ticker:       string;
  shares:       string;
  avgBuyPrice:  string;
  currentValue?: string;
  pnl?:         string;
  buyDate?:     string;
}

interface Props {
  onAnalyze: (stocks: PortfolioStock[]) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const FORMAT_LABELS: Record<DetectedFormat, string> = {
  'groww-pnl':      'Groww P&L',
  'groww-holdings': 'Groww Holdings',
  zerodha:          'Zerodha Kite',
  upstox:           'Upstox',
  angel:            'Angel One',
  generic:          'Generic CSV',
  unknown:          'Unknown',
  unmapped:         'Unknown',
};

function downloadSampleCSV() {
  const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'artha-portfolio-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function toEditable(holdings: ParseResult['holdings']): EditableRow[] {
  return holdings.map((h, i) => ({
    _id:          `row-${i}-${Date.now()}`,
    name:         h.name,
    ticker:       h.ticker,
    shares:       String(h.shares),
    avgBuyPrice:  String(h.avgBuyPrice),
    currentValue: h.currentValue != null ? String(h.currentValue) : undefined,
    pnl:          h.pnl         != null ? String(h.pnl)          : undefined,
    buyDate:      h.buyDate,
  }));
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function EditCell({
  value, type = 'text', onChange, mono = false,
}: {
  value:    string;
  type?:    'text' | 'number';
  onChange: (v: string) => void;
  mono?:    boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        backgroundColor: C.s2,
        borderColor:     C.border,
        color:           C.text,
        colorScheme:     'dark',
        fontFamily:      mono ? 'monospace' : undefined,
      }}
      className="w-full border rounded-[6px] px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-white/20 transition-colors"
    />
  );
}

function FormatBadge({ format }: { format: DetectedFormat }) {
  const isUnknown = format === 'unmapped' || format === 'unknown';
  const colors: Record<DetectedFormat, string> = {
    'groww-pnl':      '#4ead84',
    'groww-holdings': '#4ead84',
    zerodha:          '#60b0f4',
    upstox:           '#a78bfa',
    angel:            '#f97316',
    generic:          '#9b9a94',
    unknown:          '#d4a843',
    unmapped:         '#d4a843',
  };
  const col   = colors[format] ?? '#9b9a94';
  const label = isUnknown
    ? 'Format not recognised — map manually'
    : `✓ ${FORMAT_LABELS[format]} format detected`;
  return (
    <span
      style={{ color: col, backgroundColor: `${col}18`, borderColor: `${col}40` }}
      className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-0.5 rounded-full border"
    >
      {label}
    </span>
  );
}

// ── Column Mapper ──────────────────────────────────────────────────────────────

function ColumnMapper({
  headers,
  initial,
  onApply,
}: {
  headers:  string[];
  initial:  ColumnMap | null;
  onApply:  (map: ColumnMap) => void;
}) {
  const blank = { name: '', ticker: null, shares: '', avgBuyPrice: '' };
  const [map, setMap] = useState<ColumnMap>(initial ?? blank);

  const field = (
    label:    string,
    key:      keyof ColumnMap,
    required: boolean,
  ) => (
    <div className="flex flex-col gap-1">
      <label className="metric-label">{label}{!required && <span style={{ color: C.subtle }}> (optional)</span>}</label>
      <select
        value={(map[key] as string | null) ?? ''}
        onChange={(e) =>
          setMap((p) => ({ ...p, [key]: e.target.value || null }))
        }
        style={{ backgroundColor: C.s2, borderColor: C.border, color: map[key] ? C.text : C.subtle, colorScheme: 'dark' }}
        className="border rounded-[8px] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-white/20"
      >
        <option value="">— select column —</option>
        {headers.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </div>
  );

  const canApply = map.name && map.shares && map.avgBuyPrice;

  return (
    <div
      style={{ backgroundColor: C.s1, borderColor: `${C.gold}50` }}
      className="border rounded-[14px] p-5 flex flex-col gap-4"
    >
      <div>
        <p style={{ color: C.text }} className="text-sm font-semibold">Map your columns</p>
        <p style={{ color: C.muted }} className="text-xs mt-0.5">
          We couldn't detect the format automatically. Tell us which columns map to what.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {field('Stock name',      'name',        true)}
        {field('Ticker / Symbol', 'ticker',      false)}
        {field('Shares / Qty',    'shares',      true)}
        {field('Avg buy price',   'avgBuyPrice', true)}
      </div>
      <div className="flex justify-end">
        <button
          onClick={() => canApply && onApply(map)}
          disabled={!canApply}
          style={{
            backgroundColor: canApply ? C.gold : C.s2,
            color:           canApply ? C.bg  : C.subtle,
            cursor:          canApply ? 'pointer' : 'not-allowed',
          }}
          className="text-sm font-semibold px-5 py-2 rounded-[10px] transition-colors"
        >
          Apply mapping
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CSVImport({ onAnalyze }: Props) {
  const inputRef                              = useRef<HTMLInputElement>(null);
  const [dragging,  setDragging]              = useState(false);
  const [result,    setResult]                = useState<ParseResult | null>(null);
  const [rows,      setRows]                  = useState<EditableRow[]>([]);
  const [error,     setError]                 = useState<string | null>(null);

  // ── File processing ──────────────────────────────────────────────────────────

  const processFile = useCallback((file: File) => {
    const name = file.name.toLowerCase();
    const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
    const isCSV   = name.endsWith('.csv') || file.type === 'text/csv';

    if (!isExcel && !isCSV) {
      setError('Please upload a .csv, .xlsx, or .xls file.');
      return;
    }
    setError(null);

    const reader = new FileReader();

    if (isExcel) {
      reader.onload = (e) => {
        try {
          const parsed = parseExcel(e.target?.result as ArrayBuffer);
          if (parsed.error) { setError(parsed.error); return; }
          setResult(parsed);
          if (parsed.format !== 'unmapped' && parsed.format !== 'unknown') setRows(toEditable(parsed.holdings));
        } catch {
          setError('Failed to parse Excel file. Make sure it has a header row.');
        }
      };
      reader.onerror = () => setError('Failed to read file.');
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => {
        const text   = e.target?.result as string;
        const parsed = parseCSV(text);
        setResult(parsed);
        if (parsed.format !== 'unmapped' && parsed.format !== 'unknown') setRows(toEditable(parsed.holdings));
      };
      reader.onerror = () => setError('Failed to read file.');
      reader.readAsText(file);
    }
  }, []);

  // ── Event handlers ───────────────────────────────────────────────────────────

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  }

  function handleMapApply(map: ColumnMap) {
    if (!result) return;
    const holdings = applyColumnMap(result.rawRows, map);
    setResult((r) => r ? { ...r, format: 'generic', holdings, columnMap: map } : r);
    setRows(toEditable(holdings));
  }

  // ── Editable table helpers ───────────────────────────────────────────────────

  function updateRow(id: string, field: keyof Omit<EditableRow, '_id'>, value: string) {
    setRows((prev) =>
      prev.map((r) => r._id === id ? { ...r, [field]: value } : r),
    );
  }

  function deleteRow(id: string) {
    setRows((prev) => prev.filter((r) => r._id !== id));
  }

  // ── Confirm ──────────────────────────────────────────────────────────────────

  function handleAnalyze() {
    const validRows = rows.filter((r) => r.name.trim() && Number(r.shares) > 0);
    if (validRows.length === 0) return;

    const stocks: PortfolioStock[] = validRows.map((r) => ({
      id:          `${Date.now()}-${Math.random()}`,
      name:        r.name.trim(),
      ticker:      r.ticker.trim().toUpperCase() || r.name.trim().split(/\s+/)[0].toUpperCase(),
      shares:      Number(r.shares)      || 0,
      avgBuyPrice: Number(r.avgBuyPrice) || 0,
      buyDate:     r.buyDate || undefined,
    }));

    onAnalyze(stocks);
  }

  // ── Reset ────────────────────────────────────────────────────────────────────

  function reset() {
    setResult(null);
    setRows([]);
    setError(null);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const isUnmapped   = result?.format === 'unmapped' || result?.format === 'unknown';
  const showMapper   = !!result && isUnmapped;
  const showPreview  = rows.length > 0;
  const showDropZone = !result || isUnmapped;

  return (
    <div className="flex flex-col gap-4">

      {/* Drop zone */}
      {showDropZone && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            borderColor:     dragging ? C.gold : C.border,
            backgroundColor: dragging ? `${C.gold}0a` : C.s1,
          }}
          className="border-2 border-dashed rounded-[14px] flex flex-col items-center justify-center gap-3 py-12 cursor-pointer transition-colors select-none"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={handleFileInput}
          />
          <span style={{ color: C.subtle }} className="text-3xl">↑</span>
          <div className="text-center">
            <p style={{ color: C.text }} className="text-sm font-medium">
              Drop your CSV here, or click to browse
            </p>
            <p style={{ color: C.muted }} className="text-xs mt-1">
              Supports CSV &amp; Excel (.xlsx, .xls) — Groww, Zerodha, Upstox, Angel One auto-detected
            </p>
          </div>

          {/* Sample download — stops propagation so it doesn't trigger the file picker */}
          <button
            onClick={(e) => { e.stopPropagation(); downloadSampleCSV(); }}
            style={{ color: C.gold, borderColor: `${C.gold}50` }}
            className="mt-1 flex items-center gap-1.5 border rounded-full px-3 py-1 text-xs font-medium hover:opacity-80 transition-opacity"
          >
            ↓ Download sample CSV
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{ borderColor: 'rgba(224,82,82,0.25)', backgroundColor: 'rgba(224,82,82,0.06)' }}
          className="border rounded-[14px] px-4 py-3 flex items-center gap-2"
        >
          <span style={{ color: C.red }} className="text-xs shrink-0">⚠</span>
          <p style={{ color: C.red }} className="text-xs">{error}</p>
        </div>
      )}

      {/* Format badge + re-upload trigger */}
      {result && result.format !== 'unmapped' && (
        <div className="flex items-center justify-between">
          <FormatBadge format={result.format} />
          <button onClick={reset} style={{ color: C.muted }} className="text-xs hover:text-white transition-colors">
            ↩ Upload different file
          </button>
        </div>
      )}

      {/* Column mapper for unknown formats */}
      {showMapper && result && (
        <>
          <div className="flex items-center justify-between">
            <FormatBadge format="unmapped" />
            <button onClick={reset} style={{ color: C.muted }} className="text-xs hover:text-white transition-colors">
              ↩ Upload different file
            </button>
          </div>
          <ColumnMapper
            headers={result.headers}
            initial={buildAutoMap(result.headers)}
            onApply={handleMapApply}
          />
        </>
      )}

      {/* Preview table */}
      {showPreview && (() => {
        const hasExtra = rows.some((r) => r.currentValue != null);
        const cols = hasExtra
          ? ['Stock name', 'Ticker', 'Shares', 'Avg buy price (₹)', 'Curr. value (₹)', 'P&L (₹)', '']
          : ['Stock name', 'Ticker', 'Shares', 'Avg buy price (₹)', ''];
        return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="metric-label">{rows.length} stock{rows.length !== 1 ? 's' : ''} found — edit any cell before analysing</p>
            <button onClick={reset} style={{ color: C.muted }} className="text-xs hover:text-white transition-colors">
              ↩ Upload different file
            </button>
          </div>

          <div style={{ borderColor: C.border }} className="rounded-[14px] border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: C.s2, borderBottomColor: C.border }} className="border-b">
                  {cols.map((h) => (
                    <th key={h} className="table-head text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row._id}
                    style={{ borderBottomColor: C.border }}
                    className="border-b last:border-b-0 hover:bg-[#18181b] transition-colors"
                  >
                    <td className="px-3 py-2.5 w-[28%]">
                      <EditCell value={row.name}        onChange={(v) => updateRow(row._id, 'name',        v)} />
                    </td>
                    <td className="px-3 py-2.5 w-[12%]">
                      <EditCell value={row.ticker}      onChange={(v) => updateRow(row._id, 'ticker',      v)} mono />
                    </td>
                    <td className="px-3 py-2.5 w-[10%]">
                      <EditCell value={row.shares}      onChange={(v) => updateRow(row._id, 'shares',      v)} type="number" />
                    </td>
                    <td className="px-3 py-2.5 w-[15%]">
                      <EditCell value={row.avgBuyPrice} onChange={(v) => updateRow(row._id, 'avgBuyPrice', v)} type="number" />
                    </td>
                    {hasExtra && (
                      <>
                        <td className="px-3 py-2.5 w-[15%]">
                          <span style={{ color: C.muted, fontSize: 12 }}>
                            {row.currentValue ? `₹${Number(row.currentValue).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 w-[12%]">
                          {row.pnl != null && (
                            <span style={{ color: Number(row.pnl) >= 0 ? C.green : C.red, fontSize: 12 }}>
                              {Number(row.pnl) >= 0 ? '+' : ''}₹{Number(row.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </span>
                          )}
                        </td>
                      </>
                    )}
                    <td className="px-3 py-2.5 w-[8%] text-center">
                      <button
                        onClick={() => deleteRow(row._id)}
                        style={{ color: C.subtle }}
                        className="hover:opacity-60 transition-opacity text-base leading-none"
                        aria-label="Remove row"
                      >×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={handleAnalyze}
            disabled={rows.length === 0}
            style={{ backgroundColor: C.gold, color: C.bg }}
            className="w-full font-semibold text-sm py-3.5 rounded-[14px] hover:opacity-90 active:scale-[0.99] transition-all"
          >
            Analyse Portfolio →
          </button>
        </div>
        );
      })()}
    </div>
  );
}
