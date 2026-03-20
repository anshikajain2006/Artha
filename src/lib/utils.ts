// ── Money formatting ──────────────────────────────────────────────────────────

/** Format a number with Indian comma-grouping and fixed decimals. */
export function fmt(n: number, dec = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** Format a percentage with a leading + for positives. */
export function fmtPct(n: number, decimals = 2): string {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(decimals) + '%';
}

/** Format a rupee amount in Indian notation: Cr / L / raw. */
export function fmtMoney(n: number): string {
  if (n == null || isNaN(n)) return '—';
  if (n >= 10_000_000) return '₹' + (n / 10_000_000).toFixed(2) + ' Cr';
  if (n >= 100_000)    return '₹' + (n / 100_000).toFixed(1) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/** @deprecated Use fmtMoney() instead. */
export function formatIndianCurrency(amount: number): string {
  return fmtMoney(amount);
}

// ── Display name lookup ───────────────────────────────────────────────────────

const DISPLAY_NAMES: Record<string, string> = {
  SILVERIETF:  'ICICI Silver ETF',
  ICICIPRAMC:  'ICICI Silver ETF',
  BHARATCOAL:  'Bharat Coking Coal',
  PARADEEPPH:  'Paradeep Phosphates',
  GROWW:       'Groww (Finvasia)',
  GOLDETF:     'Gold ETF',
  GOLDBEES:    'Nippon Gold ETF',
  GOLDIETF:    'SBI Gold ETF',
  SILVERBEES:  'Nippon Silver ETF',
  SILVEREIETF: 'Silver ETF',
  NIFTYBEES:   'Nippon Nifty 50 ETF',
  JUNIORBEES:  'Nippon Junior Bees',
  SETFNIF50:   'SBI Nifty 50 ETF',
};

export function getDisplayName(ticker: string, name: string): string {
  return DISPLAY_NAMES[ticker.toUpperCase()] ?? name.split(' ').slice(0, 3).join(' ');
}
