// Launch Radar v5 — the build-time audit.
//
// Double-entry bookkeeping for the build. lib/model.ts produces the
// board one way; this module produces it a second way, from the raw
// snapshot and the fitted stages' published terms, sharing no code
// with the model beyond the type definitions. main.ts runs the
// audit on every build and refuses to write a dossier when the two
// paths disagree on a single rank — a build that cannot reproduce
// itself does not ship.
//
// The dashboard runs the same audit a third time, in the reader's
// browser (dashboard/refit.js). Three implementations of one set of
// rules, kept honest by being compared, not by being trusted.

import type { Protocol, RadarData, Snapshot } from './model.ts';

export interface AuditResult {
  rows_checked: number;
  ranks_identical: number;
  max_drift: number;
  watchlist_covered: number;
}

const EXCLUDED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const FAMS = ['Lending', 'Dexs', 'Yield', 'Curators', 'Derivatives', 'Stablecoins', 'RWA', 'Staking', 'Chain'] as const;

function houseExcluded(p: Protocol): boolean {
  return EXCLUDED_CATS.has(p.category)
    || /(^|\s)(V2|v2|2\.0|V3|v3)$/.test(p.name.trim())
    || /\b(wrapped|staked|staking)\b/i.test(p.name)
    || EXCHANGES.some((e) => p.name.startsWith(`${e} `) || p.name === e);
}
const tokenRecorded = (p: Protocol): boolean => !!(p.symbol || p.gecko_id);
const priced = (p: Protocol): boolean => typeof p.mcap_usd === 'number' && p.mcap_usd > 0;

function family(p: Protocol): string {
  const c = p.category;
  if (['Lending', 'Uncollateralized Lending', 'Collateral Markets'].includes(c)) return 'Lending';
  if (['Dexs', 'Liquidity Manager'].includes(c)) return 'Dexs';
  if (['Yield', 'Yield Aggregator', 'Farm', 'Leveraged Farming'].includes(c)) return 'Yield';
  if (['Risk Curators', 'Onchain Capital Allocator'].includes(c)) return 'Curators';
  if (['Derivatives', 'Basis Trading', 'Options', 'Interest Rate Derivatives', 'Options Vault', 'Synthetics'].includes(c)) return 'Derivatives';
  if (['CDP', 'CDP Manager', 'Algo-Stables', 'Dual-Token Stablecoin', 'Stablecoin Issuer', 'Stablecoin Wrapper'].includes(c)) return 'Stablecoins';
  if (c === 'RWA') return 'RWA';
  if (['Restaking', 'Staking Pool'].includes(c)) return 'Staking';
  if (c === 'Chain') return 'Chain';
  return 'Other';
}

function ageYears(asOf: string, p: Protocol): number | null {
  if (!p.listed_at) return null;
  const days = (new Date(`${asOf}T00:00:00Z`).getTime() - new Date(`${p.listed_at}T00:00:00Z`).getTime()) / 86_400_000;
  return Math.max(0, days / 365.25);
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function ageFill(asOf: string, rows: Protocol[]): number {
  return median(rows.filter((p) => ageYears(asOf, p) !== null).map((p) => Math.log(1 + ageYears(asOf, p)!)));
}
function ageFeat(asOf: string, p: Protocol, fill: number): number {
  const a = ageYears(asOf, p);
  return a === null ? fill : Math.log(1 + a);
}
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

// Refit the odds stage from the snapshot, on the terms the build
// published, and return a predictor. Gradient descent exactly as
// specified for the model: step 0.05, L2 lambda 3, 3000 passes.
function refitOdds(snapshot: Snapshot, terms: string[]): (p: Protocol) => number {
  const asOf = snapshot.as_of;
  const peers = snapshot.protocols.filter((p) => !houseExcluded(p));
  const fill = ageFill(asOf, peers);
  const feats = (p: Protocol): number[] => {
    const f = [1];
    if (terms.includes('lntvl')) f.push((Math.log(p.tvl_usd) - 17) / 2);
    if (terms.includes('age')) f.push(ageFeat(asOf, p, fill) - 1.5);
    if (terms.includes('chains')) f.push(p.chains.length - 1);
    if (terms.includes('growth')) f.push(Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10)));
    if (terms.includes('family')) for (const fm of FAMS) f.push(family(p) === fm ? 1 : 0);
    return f;
  };
  const X = peers.map(feats);
  const y = peers.map((p) => (tokenRecorded(p) ? 1 : 0));
  const d = X[0]!.length;
  const w = new Array<number>(d).fill(0);
  for (let it = 0; it < 3000; it++) {
    const g = new Array<number>(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const pr = sigmoid(X[i]!.reduce((s, v, j) => s + v * w[j]!, 0));
      for (let j = 0; j < d; j++) g[j]! += (pr - y[i]!) * X[i]![j]!;
    }
    for (let j = 0; j < d; j++) w[j]! -= 0.05 * (g[j]! / X.length + (j === 0 ? 0 : (3.0 * w[j]!) / X.length));
  }
  return (p) => sigmoid(feats(p).reduce((s, v, j) => s + v * w[j]!, 0));
}

// Refit the value stage: OLS on log market cap over the priced
// comparables the house did not exclude as exchanges.
function refitValue(snapshot: Snapshot, terms: string[]): (p: Protocol) => number {
  const asOf = snapshot.as_of;
  const comps = snapshot.protocols.filter((p) => priced(p) && p.category !== 'CEX');
  const fill = ageFill(asOf, comps);
  const feats = (p: Protocol): number[] => {
    const f = [1, Math.log(p.tvl_usd)];
    if (terms.includes('age')) f.push(ageFeat(asOf, p, fill));
    if (terms.includes('growth')) f.push(Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10)));
    return f;
  };
  const X = comps.map(feats);
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const d = X[0]!.length;
  const A = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) {
    b[j]! += X[i]![j]! * y[i]!;
    for (let k = 0; k < d; k++) A[j]![k]! += X[i]![j]! * X[i]![k]!;
  }
  for (let j = 0; j < d; j++) A[j]![j]! += 1e-4;
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < d; k++) A[r]![k]! -= f * A[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const beta = b.map((v, j) => v / A[j]![j]!);
  return (p) => Math.exp(feats(p).reduce((s, v, j) => s + v * beta[j]!, 0));
}

// The audit itself: rebuild the board set by the ledger rules,
// re-derive every implied value through the refits above, and diff
// against the board the model shipped.
export function auditBoard(snapshot: Snapshot, radar: RadarData): AuditResult {
  const ranked: Protocol[] = [];
  for (const p of snapshot.protocols) {
    if (priced(p) || tokenRecorded(p)) continue;
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') continue;
    if (['Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(p.category)) continue;
    if (p.category === 'CEX') continue;
    if (houseExcluded(p)) continue;
    ranked.push(p);
  }
  ranked.sort((a, b) => b.tvl_usd - a.tvl_usd);
  const boardSet = ranked.slice(0, 200);
  const odds = refitOdds(snapshot, radar.odds.terms);
  const value = refitValue(snapshot, radar.value.terms);
  const mine = boardSet
    .map((p) => ({ slug: p.slug, implied: odds(p) * value(p) }))
    .sort((a, b) => b.implied - a.implied);
  const bySlug = new Map(mine.map((m) => [m.slug, m.implied]));
  let ranksIdentical = 0;
  let maxDrift = 0;
  radar.rows.forEach((r, i) => {
    if (mine[i] && mine[i]!.slug === r.slug) ranksIdentical++;
    const m = bySlug.get(r.slug);
    if (m !== undefined) maxDrift = Math.max(maxDrift, Math.abs(m - r.implied_value_usd) / r.implied_value_usd);
  });
  const watchlist = new Set(snapshot.watchlist);
  return {
    rows_checked: radar.rows.length,
    ranks_identical: ranksIdentical,
    max_drift: maxDrift,
    watchlist_covered: radar.rows.filter((r) => watchlist.has(r.slug)).length,
  };
}
