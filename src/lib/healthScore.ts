/**
 * Deterministic health score calculation.
 * This is the ONLY source of the health score — never derived from AI output.
 */

export interface HealthBreakdown {
  total: number;
  diversification: number;
  concentration: number;
  profitability: number;
}

/**
 * Calculate a deterministic portfolio health score from holdings.
 *
 * Dimensions:
 *   Diversification  — 25 pts   (based on number of holdings)
 *   Concentration    — 35 pts   (based on max single-holding weight)
 *   Profitability    — 40 pts   (% of holdings in profit)
 *
 * Total: 100 pts
 */
export function calculateHealthScore(holdings: Record<string, unknown>[]): HealthBreakdown {
  if (!holdings || holdings.length === 0) {
    return { total: 0, diversification: 0, concentration: 0, profitability: 0 };
  }

  // ── Diversification (25 pts) ──────────────────────────────────────────────
  const count = holdings.length;
  let diversification: number;
  if      (count >= 15) diversification = 25;
  else if (count >= 10) diversification = 20;
  else if (count >= 7)  diversification = 15;
  else if (count >= 4)  diversification = 10;
  else                  diversification = 5;

  // ── Concentration (35 pts) ───────────────────────────────────────────────
  // Compute each holding's weight by current value (shares × livePrice ?? buyPrice)
  const values = holdings.map((h: Record<string, unknown>) => {
    const price  = (h.livePrice as number) ?? (h.buyPrice as number) ?? 0;
    const shares = (h.shares as number) ?? (h.quantity as number) ?? 0;
    return Math.max(0, price * shares);
  });
  const totalVal = values.reduce((s: number, v: number) => s + v, 0);
  let concentration: number;
  if (totalVal === 0) {
    concentration = 35; // can't compute — assume OK
  } else {
    const maxWeight = Math.max(...values) / totalVal; // fraction 0–1
    if      (maxWeight <= 0.10) concentration = 35;
    else if (maxWeight <= 0.20) concentration = 28;
    else if (maxWeight <= 0.30) concentration = 20;
    else if (maxWeight <= 0.40) concentration = 12;
    else if (maxWeight <= 0.50) concentration = 6;
    else                        concentration = 0;
  }

  // ── Profitability (40 pts) ────────────────────────────────────────────────
  const pricedHoldings = holdings.filter((h: Record<string, unknown>) => h.livePrice != null);
  let profitability: number;
  if (pricedHoldings.length === 0) {
    profitability = 20; // no price data — give neutral score
  } else {
    const profitable = pricedHoldings.filter(
      (h: Record<string, unknown>) => ((h.livePrice as number) ?? 0) >= ((h.buyPrice as number) ?? 0),
    ).length;
    const pct = profitable / pricedHoldings.length; // 0–1
    if      (pct >= 0.80) profitability = 40;
    else if (pct >= 0.60) profitability = 30;
    else if (pct >= 0.40) profitability = 20;
    else if (pct >= 0.20) profitability = 10;
    else                  profitability = 0;
  }

  const total = diversification + concentration + profitability;
  return { total, diversification, concentration, profitability };
}
