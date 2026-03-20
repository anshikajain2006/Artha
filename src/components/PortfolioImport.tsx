import { useState, useRef, useCallback } from 'react';
import { importScreenshot, type ImportedHolding } from '../lib/gemini';
import type { PortfolioStock } from './PortfolioEntry';

// ── Types ──────────────────────────────────────────────────────────────────────

interface EditableHolding extends ImportedHolding {
  _id:      string;
  selected: boolean;
}

interface Props {
  onImport: (stocks: PortfolioStock[]) => void;
  onCancel: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function isValidFile(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) return 'Only JPEG, PNG, and WebP images are supported.';
  if (file.size > 10 * 1024 * 1024) return 'Image must be under 10 MB.';
  return null;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

const C = {
  bg:     '#0a0a0b',
  s1:     '#111113',
  s2:     '#18181b',
  gold:   '#d4a843',
  text:   '#f0efe8',
  muted:  '#9b9a94',
  subtle: '#5a5955',
  border: '#2a2a2f',
  red:    '#e05252',
} as const;

function EditCell({
  value,
  type = 'text',
  onChange,
}: {
  value:    string;
  type?:    'text' | 'number';
  onChange: (v: string) => void;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ backgroundColor: C.s2, borderColor: C.border, color: C.text, colorScheme: 'dark' }}
      className="w-full border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-white/20"
    />
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PortfolioImport({ onImport, onCancel }: Props) {
  const inputRef                                  = useRef<HTMLInputElement>(null);
  const [dragging,   setDragging]                 = useState(false);
  const [preview,    setPreview]                  = useState<string | null>(null);   // data URL for <img>
  const [extracting, setExtracting]               = useState(false);
  const [error,      setError]                    = useState<string | null>(null);
  const [holdings,   setHoldings]                 = useState<EditableHolding[] | null>(null);

  // ── File processing ─────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    const validationError = isValidFile(file);
    if (validationError) { setError(validationError); return; }

    setError(null);
    setHoldings(null);

    const [dataUrl, base64] = await Promise.all([fileToDataUrl(file), fileToBase64(file)]);
    setPreview(dataUrl);
    setExtracting(true);

    try {
      const extracted = await importScreenshot(base64, file.type);

      if (extracted.length === 0) {
        setError('No holdings found in this screenshot. Try a clearer image of your portfolio page.');
        setExtracting(false);
        return;
      }

      setHoldings(
        extracted.map((h, i) => ({
          ...h,
          ticker:   h.ticker.trim().toUpperCase(),
          _id:      `import-${Date.now()}-${i}`,
          selected: true,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extraction failed. Please try again.');
    } finally {
      setExtracting(false);
    }
  }, []);

  // ── Drag-and-drop ───────────────────────────────────────────────────────────

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void processFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
    e.target.value = '';
  }

  // ── Editable table helpers ──────────────────────────────────────────────────

  function updateHolding(id: string, field: keyof ImportedHolding, raw: string) {
    setHoldings((prev) =>
      prev?.map((h) =>
        h._id !== id ? h : {
          ...h,
          [field]: field === 'shares' || field === 'avgBuyPrice' ? Number(raw) : raw,
        },
      ) ?? null,
    );
  }

  function toggleSelected(id: string) {
    setHoldings((prev) =>
      prev?.map((h) => h._id === id ? { ...h, selected: !h.selected } : h) ?? null,
    );
  }

  function toggleAll(checked: boolean) {
    setHoldings((prev) => prev?.map((h) => ({ ...h, selected: checked })) ?? null);
  }

  // ── Confirm import ──────────────────────────────────────────────────────────

  function handleConfirm() {
    const selected = holdings?.filter((h) => h.selected) ?? [];
    if (selected.length === 0) return;

    const stocks: PortfolioStock[] = selected.map((h) => ({
      id:          `${Date.now()}-${Math.random()}`,
      name:        h.name.trim()   || h.ticker,
      ticker:      h.ticker.trim().toUpperCase(),
      shares:      Number(h.shares)      || 0,
      avgBuyPrice: Number(h.avgBuyPrice) || 0,
    }));

    onImport(stocks);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const selectedCount = holdings?.filter((h) => h.selected).length ?? 0;
  const allSelected   = !!holdings && holdings.every((h) => h.selected);

  return (
    <div style={{ backgroundColor: C.s1, borderColor: C.border }} className="rounded-2xl border flex flex-col gap-5 p-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p style={{ color: C.text }} className="text-sm font-semibold">Import from screenshot</p>
          <p style={{ color: C.muted }} className="text-xs mt-0.5">Upload a screenshot of your brokerage or portfolio app — Artha AI will extract your holdings automatically.</p>
        </div>
        <button onClick={onCancel} style={{ color: C.muted }} className="hover:text-white transition-colors text-xl leading-none shrink-0 ml-4" aria-label="Close import">×</button>
      </div>

      {/* Drop zone — only shown before extraction */}
      {!holdings && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            borderColor:     dragging ? C.gold : C.border,
            backgroundColor: dragging ? `${C.gold}0a` : C.s2,
            cursor:          extracting ? 'default' : 'pointer',
          }}
          className="border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 py-10 transition-colors select-none"
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(',')}
            className="hidden"
            onChange={handleFileInput}
          />

          {extracting ? (
            <>
              {preview && (
                <img src={preview} alt="Uploaded screenshot" className="max-h-28 rounded-lg opacity-50 object-contain" />
              )}
              <div className="flex items-center gap-2">
                <span
                  className="w-4 h-4 rounded-full border-2 animate-spin shrink-0"
                  style={{ borderColor: `${C.gold} transparent ${C.gold} transparent` }}
                />
                <span style={{ color: C.muted }} className="text-sm">Extracting holdings with AI…</span>
              </div>
            </>
          ) : (
            <>
              {preview ? (
                <img src={preview} alt="Uploaded screenshot" className="max-h-28 rounded-lg object-contain" />
              ) : (
                <span style={{ color: C.muted }} className="text-3xl select-none">↑</span>
              )}
              <div className="text-center">
                <p style={{ color: C.text }} className="text-sm font-medium">
                  {preview ? 'Upload a different image' : 'Drop an image here, or click to browse'}
                </p>
                <p style={{ color: C.muted }} className="text-xs mt-0.5">JPEG, PNG, WebP · max 10 MB</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{ borderColor: 'rgba(248,113,113,0.25)', backgroundColor: 'rgba(248,113,113,0.06)' }}
          className="border rounded-xl px-4 py-3 flex items-start gap-2"
        >
          <span style={{ color: C.red }} className="text-xs shrink-0 mt-0.5">⚠</span>
          <p style={{ color: C.red }} className="text-xs leading-relaxed">{error}</p>
        </div>
      )}

      {/* Extracted holdings preview table */}
      {holdings && holdings.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p style={{ color: C.text }} className="text-xs font-semibold uppercase tracking-widest">
              {holdings.length} holding{holdings.length !== 1 ? 's' : ''} extracted — review and edit before importing
            </p>
            <button
              onClick={() => { setHoldings(null); setPreview(null); setError(null); }}
              style={{ color: C.muted }}
              className="text-xs hover:text-white transition-colors"
            >
              ↩ Try again
            </button>
          </div>

          <div style={{ borderColor: C.border }} className="rounded-xl border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ backgroundColor: C.s2, borderBottomColor: C.border }} className="border-b">
                  <th className="px-3 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => toggleAll(e.target.checked)}
                      className="accent-yellow-400"
                    />
                  </th>
                  {['Company name', 'Ticker', 'Shares', 'Avg buy price (₹)'].map((h) => (
                    <th key={h} style={{ color: C.muted }} className="text-left font-medium tracking-widest uppercase px-3 py-2.5">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr
                    key={h._id}
                    style={{ borderBottomColor: C.border, opacity: h.selected ? 1 : 0.4 }}
                    className="border-b last:border-b-0 transition-opacity"
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={h.selected}
                        onChange={() => toggleSelected(h._id)}
                        className="accent-yellow-400"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <EditCell value={h.name} onChange={(v) => updateHolding(h._id, 'name', v)} />
                    </td>
                    <td className="px-3 py-2">
                      <EditCell value={h.ticker} onChange={(v) => updateHolding(h._id, 'ticker', v)} />
                    </td>
                    <td className="px-3 py-2">
                      <EditCell value={String(h.shares)} type="number" onChange={(v) => updateHolding(h._id, 'shares', v)} />
                    </td>
                    <td className="px-3 py-2">
                      <EditCell value={String(h.avgBuyPrice)} type="number" onChange={(v) => updateHolding(h._id, 'avgBuyPrice', v)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <p style={{ color: C.muted }} className="text-xs">
              {selectedCount} of {holdings.length} selected
            </p>
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                style={{ borderColor: C.border, color: C.muted }}
                className="border rounded-lg px-4 py-2 text-xs font-medium hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={selectedCount === 0}
                style={{
                  backgroundColor: selectedCount > 0 ? C.gold : C.s2,
                  color:           selectedCount > 0 ? C.bg   : C.muted,
                  cursor:          selectedCount > 0 ? 'pointer' : 'not-allowed',
                }}
                className="rounded-lg px-4 py-2 text-xs font-semibold transition-colors"
              >
                Add {selectedCount > 0 ? `${selectedCount} ` : ''}holding{selectedCount !== 1 ? 's' : ''} →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
