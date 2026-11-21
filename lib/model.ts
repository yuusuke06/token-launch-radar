// Launch Radar v3 model: two fitted stages over the sealed snapshot.
//
// Stage 1 prices the chance that a pre-token protocol records a token at
// all: a logistic fit on the snapshot's own peers (protocols that are not
// wrapped, staked, bridged or exchange products), where the outcome — a
// token symbol or Gecko id on the record — is known for every peer.
// Stage 2 prices a launch if it happens: a log-log size curve with an age
// term, fitted on the snapshot's priced token-bearing protocols.
//
// Every candidate term in both stages faces the same court: it is kept
// only if it lowers the held-out error in two different tests (ten-fold
// cross-validation and a time split for the odds; leave-one-out and a
// walk-forward split for the value). The ablation tables ship with the
// dashboard, kept and rejected terms alike. Implied value is the product
// of the two stages. Ranges come from the value model's leave-one-out
// residuals; rank ranges from 150 bootstrap refits of the value stage.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) throw new Error('snapshot: protocols and watchlist must be arrays');
  return raw;
}

const EXCLUDED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** The house's own exclusions: wrapped, staked, bridged or exchange products of tokens that already trade. */
export function houseExcluded(p: SnapshotProtocol): boolean {
  if (EXCLUDED_CATS.has(p.category)) return true;
  if (/(^|\s)(V2|v2|2\.0|V3|v3)$/.test(p.name.trim())) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  if (EXCHANGES.some((e) => p.name.startsWith(e + ' ') || p.name === e)) return true;
  return false;
}

export const tokenRecorded = (p: SnapshotProtocol): boolean => !!(p.symbol || p.gecko_id);
const priced = (p: SnapshotProtocol): boolean => typeof p.mcap_usd === 'number' && p.mcap_usd > 0;

/** Age in years at the snapshot date; null when DefiLlama records no listing date (113 of 758). */
export function ageYears(asOf: string, p: SnapshotProtocol): number | null {
  if (!p.listed_at) return null;
  const days = (new Date(asOf + 'T00:00:00Z').getTime() - new Date(p.listed_at + 'T00:00:00Z').getTime()) / 864e5;
  return Math.max(0, days / 365.25);
}
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
/** ln(1 + age), with the median of the dated rows standing in where the date is missing. */
const ageFeat = (asOf: string, p: SnapshotProtocol, fill: number): number => { const a = ageYears(asOf, p); return a === null ? fill : Math.log(1 + a); };
const ageFill = (asOf: string, rows: SnapshotProtocol[]): number => median(rows.filter((p) => ageYears(asOf, p) !== null).map((p) => Math.log(1 + ageYears(asOf, p)!)));

export function family(p: SnapshotProtocol): string {
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
const FAMS = ['Lending', 'Dexs', 'Yield', 'Curators', 'Derivatives', 'Stablecoins', 'RWA', 'Staking', 'Chain'];

// ---------- stage 1: launch odds ----------
interface LogitFit { w: number[]; fill: number }
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

// Placebo control values, set by buildRadar before the ablation runs:
// a real number from the record that cannot cause this protocol's own
// outcome (the next protocol's growth, in slug order). A control term
// faces the same two tests as every real term and must not pass them.
let placeboOdds: Map<string, number> | null = null;
let placeboValue: Map<string, number> | null = null;

function oddsFeatures(asOf: string, p: SnapshotProtocol, terms: string[], fill: number): number[] {
  const f = [1];
  if (terms.includes('lntvl')) f.push((Math.log(p.tvl_usd) - 17) / 2);
  if (terms.includes('age')) f.push(ageFeat(asOf, p, fill) - 1.5);
  if (terms.includes('chains')) f.push(p.chains.length - 1);
  if (terms.includes('growth')) f.push(Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10)));
  if (terms.includes('family')) for (const fm of FAMS) f.push(family(p) === fm ? 1 : 0);
  if (terms.includes('placebo')) f.push(Math.max(-2, Math.min(10, (placeboOdds?.get(p.slug) ?? 0) / 10)));
  return f;
}

function fitLogit(asOf: string, rows: SnapshotProtocol[], terms: string[], lambda = 3.0): LogitFit {
  const fill = ageFill(asOf, rows);
  const X = rows.map((p) => oddsFeatures(asOf, p, terms, fill));
  const y = rows.map((p) => (tokenRecorded(p) ? 1 : 0));
  const d = X[0]!.length;
  const w = new Array(d).fill(0);
  for (let it = 0; it < 3000; it++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const pr = sigmoid(X[i]!.reduce((s, v, j) => s + v * w[j]!, 0));
      for (let j = 0; j < d; j++) g[j]! += (pr - y[i]!) * X[i]![j]!;
    }
    for (let j = 0; j < d; j++) w[j]! -= 0.05 * (g[j]! / X.length + (j === 0 ? 0 : (lambda * w[j]!) / X.length));
  }
  return { w, fill };
}

const predictOdds = (asOf: string, fit: LogitFit, p: SnapshotProtocol, terms: string[]): number =>
  sigmoid(oddsFeatures(asOf, p, terms, fit.fill).reduce((s, v, j) => s + v * fit.w[j]!, 0));

interface AblationRow { term: string; loo: number; wf: number; kept: boolean }

function oddsTests(asOf: string, peers: SnapshotProtocol[], terms: string[]): { cv: number; ts: number } {
  const brier = (rows: SnapshotProtocol[], fit: LogitFit): number =>
    rows.reduce((s, p) => s + (predictOdds(asOf, fit, p, terms) - (tokenRecorded(p) ? 1 : 0)) ** 2, 0) / rows.length;
  const sorted = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  let cv = 0;
  for (let k = 0; k < 10; k++) {
    const test = sorted.filter((_, i) => i % 10 === k);
    const train = sorted.filter((_, i) => i % 10 !== k);
    cv += brier(test, fitLogit(asOf, train, terms)) * test.length;
  }
  cv /= sorted.length;
  const dated = peers.filter((p) => p.listed_at);
  const tr = dated.filter((p) => p.listed_at! < '2025-01-01');
  const te = dated.filter((p) => p.listed_at! >= '2025-01-01');
  return { cv, ts: brier(te, fitLogit(asOf, tr, terms)) };
}

// ---------- stage 2: value if it launches ----------
function ols(rows: SnapshotProtocol[], feats: (p: SnapshotProtocol) => number[]): number[] {
  const X = rows.map(feats);
  const y = rows.map((p) => Math.log(p.mcap_usd!));
  const d = X[0]!.length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) { b[j]! += X[i]![j]! * y[i]!; for (let k = 0; k < d; k++) A[j]![k]! += X[i]![j]! * X[i]![k]!; }
  for (let j = 0; j < d; j++) A[j]![j]! += 1e-4;
  for (let c = 0; c < d; c++) {
    let piv = c; for (let r = c + 1; r < d; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!]; [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < d; r++) { if (r === c) continue; const f = A[r]![c]! / A[c]![c]!; for (let k = c; k < d; k++) A[r]![k]! -= f * A[c]![k]!; b[r]! -= f * b[c]!; }
  }
  return b.map((v, j) => v / A[j]![j]!);
}

function groupMultipliers(rows: SnapshotProtocol[], beta: number[], keyFn: (p: SnapshotProtocol) => string): Map<string, number> {
  const res = new Map<string, number[]>();
  for (const p of rows) {
    const r = Math.log(p.mcap_usd!) - (beta[0]! + beta[1]! * Math.log(p.tvl_usd));
    const k = keyFn(p);
    if (!res.has(k)) res.set(k, []);
    res.get(k)!.push(r);
  }
  const mult = new Map<string, number>();
  for (const [c, rs] of res) { const n = rs.length; mult.set(c, Math.exp((rs.reduce((s, v) => s + v, 0) / n) * (n / (n + 6)))); }
  return mult;
}

const multKey = (terms: string[]): ((p: SnapshotProtocol) => string) | null =>
  terms.includes('category') ? (p) => p.category : terms.includes('family') ? family : null;

interface ValueFit { beta: number[]; fill: number; predict: (p: SnapshotProtocol) => number }

function fitValue(asOf: string, rows: SnapshotProtocol[], terms: string[]): ValueFit {
  const fill = ageFill(asOf, rows);
  const feats = (p: SnapshotProtocol): number[] => {
    const f = [1, Math.log(p.tvl_usd)];
    if (terms.includes('age')) f.push(ageFeat(asOf, p, fill));
    if (terms.includes('growth')) f.push(Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10)));
    if (terms.includes('placebo')) f.push(placeboValue?.get(p.slug) ?? 0);
    return f;
  };
  const beta = ols(rows, feats);
  const k = multKey(terms);
  const mult = k ? groupMultipliers(rows, beta, k) : new Map<string, number>();
  const predict = (p: SnapshotProtocol): number => Math.exp(feats(p).reduce((s, v, j) => s + v * beta[j]!, 0)) * (k ? (mult.get(k(p)) ?? 1) : 1);
  return { beta, fill, predict };
}

const missFactor = (rows: SnapshotProtocol[], predict: (p: SnapshotProtocol) => number): number => {
  const e = rows.map((p) => Math.abs(Math.log(p.mcap_usd! / predict(p)))).sort((a, b) => a - b);
  return Math.exp(e[Math.floor(e.length / 2)]!);
};

// Ridge variant of the value fit: the size curve and age stay free, one
// intercept per category is shrunk by the penalty lambda. This is the
// formulation several rivals ship; it faces the same two tests.
function fitValueRidge(asOf: string, rows: SnapshotProtocol[], lambda: number): ValueFit {
  const fill = ageFill(asOf, rows);
  const levels = [...new Set(rows.map((p) => p.category))];
  const feats = (p: SnapshotProtocol): number[] => {
    const f = [1, Math.log(p.tvl_usd), ageFeat(asOf, p, fill)];
    for (const lv of levels) f.push(p.category === lv ? 1 : 0);
    return f;
  };
  const X = rows.map(feats);
  const y = rows.map((p) => Math.log(p.mcap_usd!));
  const d = X[0]!.length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) { b[j]! += X[i]![j]! * y[i]!; for (let k = 0; k < d; k++) A[j]![k]! += X[i]![j]! * X[i]![k]!; }
  for (let j = 0; j < 3; j++) A[j]![j]! += 1e-4;
  for (let j = 3; j < d; j++) A[j]![j]! += lambda;
  for (let c = 0; c < d; c++) {
    let piv = c; for (let r = c + 1; r < d; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!]; [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < d; r++) { if (r === c) continue; const f = A[r]![c]! / A[c]![c]!; for (let k = c; k < d; k++) A[r]![k]! -= f * A[c]![k]!; b[r]! -= f * b[c]!; }
  }
  const beta = b.map((v, j) => v / A[j]![j]!);
  const predict = (p: SnapshotProtocol): number => Math.exp(feats(p).reduce((s, v, j) => s + v * beta[j]!, 0));
  return { beta, fill, predict };
}

function valueRidgeTests(asOf: string, comps: SnapshotProtocol[], lambda: number): { loo: number; wf: number } {
  const errs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const m = fitValueRidge(asOf, comps.filter((_, j) => j !== i), lambda);
    errs.push(Math.abs(Math.log(comps[i]!.mcap_usd! / m.predict(comps[i]!))));
  }
  errs.sort((a, b) => a - b);
  const loo = Math.exp(errs[Math.floor(errs.length / 2)]!);
  const dated = [...comps].filter((p) => p.listed_at).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wf = missFactor(dated.slice(half), fitValueRidge(asOf, dated.slice(0, half), lambda).predict);
  return { loo, wf };
}

function valueTests(asOf: string, comps: SnapshotProtocol[], terms: string[]): { loo: number; wf: number } {
  const errs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const m = fitValue(asOf, comps.filter((_, j) => j !== i), terms);
    errs.push(Math.abs(Math.log(comps[i]!.mcap_usd! / m.predict(comps[i]!))));
  }
  errs.sort((a, b) => a - b);
  const loo = Math.exp(errs[Math.floor(errs.length / 2)]!);
  const dated = [...comps].filter((p) => p.listed_at).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wf = missFactor(dated.slice(half), fitValue(asOf, dated.slice(0, half), terms).predict);
  return { loo, wf };
}

// ---------- farm plans ----------
const money = (n: number): string => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));
export interface Econ { deposit: number; expected: number; fees: number; net: number; hours: number; netPerHour: number; verdict: string }
export function farmEconomics(implied: number, tvl: number, chainCount: number): Econ {
  const deposit = Math.min(100000, Math.max(500, 0.0002 * tvl));
  const expected = implied * 0.05 * (deposit / tvl);
  const fees = 2.57 * (2 + chainCount);
  const net = expected - fees;
  const hours = 2 + chainCount * 0.5 + 3;
  const netPerHour = net / hours;
  return { deposit, expected, fees, net, hours, netPerHour, verdict: net >= 50 && netPerHour >= 8 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP' };
}

const ACTION: Record<string, string> = {
  Lending: 'supply the base asset into the main money market and keep the receipt token in the same wallet',
  Dexs: 'provide liquidity to the flagship pool in a tight but sane range and leave the position untouched between check-ins',
  Yield: 'deposit into the flagship vault so the position accrues the program points the vault passes through',
  Curators: 'allocate into the flagship curated vault; curator vaults are where this family concentrates its points',
  Derivatives: 'open a small hedged position (long spot, short perp of equal size) so volume and open interest accrue without directional risk',
  Stablecoins: 'mint or deposit the stablecoin and hold it in the wallet the program tracks; do not loop it through wrappers it cannot see',
  RWA: 'complete the KYC the issuer requires, then subscribe to the flagship tokenised treasury or credit product',
  Staking: 'stake through the protocol own interface rather than a third-party wrapper, so the stake is attributed to your wallet',
  Chain: 'bridge a working balance to the chain, keep it there, and transact weekly so the address reads as a real user',
  Other: 'make the core deposit the product is built around and keep the position visible in one wallet',
};

export function farmSteps(p: SnapshotProtocol, econ: Econ): string[] {
  const chains = p.chains.slice(0, 3).join(', ') + (p.chains.length > 3 ? ` and ${p.chains.length - 3} more` : '');
  const act = ACTION[family(p)] ?? ACTION.Other!;
  return [
    `Set up one clean wallet for ${p.name} and fund it on ${chains}; a single wallet keeps every point the program awards in one place. Budget about 30 minutes and one bridge fee if the main chain is not where your funds sit.`,
    `Acquire ${money(econ.deposit)} of the base asset ${p.name} takes (the plan size is 0.02% of its ${money(p.tvl_usd)} TVL). Buy on a centralised exchange and withdraw on the cheapest supported chain; exchange withdrawal fees run $1-10.`,
    `Make the core position: ${act}. At this size the transaction fees come to about $${econ.fees.toFixed(2)} across ${p.chains.length} chain${p.chains.length === 1 ? '' : 's'} at the model's $2.57 average.`,
    `Register for the points or rewards program in the ${p.name} interface if it has one, and screenshot the position and the points balance; if the terms change later, the screenshot is your evidence. Ten minutes.`,
    `Check in weekly for about 15 minutes: confirm the position still earns, claim any distributions into the same wallet, and rebalance only if the position drifts out of the program's eligible set. Twelve weeks of check-ins are in the plan's ${econ.hours.toFixed(1)} hours.`,
    `Watch the official ${p.name} channels for a snapshot or token announcement. Points programs usually snapshot without warning, so the position must be live every day of the horizon, not rebuilt when news lands.`,
    `At a token launch, claim on day one and sell into the first liquid market rather than holding for a better price: the plan's expected value, ${money(Math.max(0, econ.expected))} before fees at the model scenario, is priced on the launch, not on a later rally. If no token arrives inside 12 weeks, withdraw and recycle the deposit.`,
  ];
}

// ---------- board assembly ----------
export interface BoardRow { slug: string; name: string; rank: number; implied_value_usd: number; farm_steps: string[] }
export interface PeerComp { name: string; tvl_usd: number; mcap_usd: number; model_usd: number }
export interface RadarRow {
  rank: number; rank_best: number; rank_worst: number; slug: string; name: string; category: string; family: string;
  chains: string[]; tvl_usd: number; change_7d: number | null; age_years: number | null; watchlist: boolean;
  odds: number; if_launches_usd: number; implied_value_usd: number; p25_usd: number; p75_usd: number;
  deposit: number; expected: number; fees: number; net: number; hours: number; net_per_hour: number; verdict: string;
  farm_steps: string[];
  peers: PeerComp[];
}
export interface AblationOut { term: string; test1: number; test2: number; kept: boolean }
export interface RadarData {
  as_of: string;
  ledger: { total: number; ranked: number; board: number; priced_comp: number; comps_used: number; token_no_cap: number; out_bridge: number; out_staking: number; out_cex: number; out_other: number; dated_comps: number };
  odds: { terms: string[]; base_rate: number; peers: number; weights: number[]; ablation: AblationOut[]; final_cv: number; final_ts: number };
  value: { terms: string[]; beta: number[]; flat_median: number; flat_miss: number; ablation: AblationOut[]; final_loo: number; final_wf: number; se_slope: number; se_mult100: number };
  spread: { p25: number; p75: number; p10: number; p90: number; honesty_2575: number; honesty_1090: number; honesty_old_2575: number; honesty_new_2575: number; honesty_old_1090: number; honesty_new_1090: number; split_n: number };
  calibration: { pred: number; actual: number; n: number }[];
  seal: string;
  verdicts: Record<string, number>;
  rows: RadarRow[];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const watch = new Set(snapshot.watchlist);
  const groups = { ranked: [] as SnapshotProtocol[], pricedComp: [] as SnapshotProtocol[], tokenNoCap: 0, outBridge: 0, outStaking: 0, outCex: 0, outOther: 0 };
  for (const p of snapshot.protocols) {
    if (priced(p)) { groups.pricedComp.push(p); continue; }
    if (tokenRecorded(p)) { groups.tokenNoCap++; continue; }
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') { groups.outBridge++; continue; }
    if (['Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(p.category)) { groups.outStaking++; continue; }
    if (p.category === 'CEX') { groups.outCex++; continue; }
    if (houseExcluded(p)) { groups.outOther++; continue; }
    groups.ranked.push(p);
  }
  groups.ranked.sort((a, b) => b.tvl_usd - a.tvl_usd);
  const boardSet = groups.ranked.slice(0, 200);
  const peers = snapshot.protocols.filter((p) => !houseExcluded(p));
  { // placebo control for the odds stage: each peer is handed the next
    // peer's 7-day growth, in slug order — a real number from the record
    // that cannot have caused this peer to record a token.
    const bySlug = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
    placeboOdds = new Map(bySlug.map((p, i) => [p.slug, bySlug[(i + 1) % bySlug.length]!.change_7d ?? 0]));
  }

  // stage 1 with ablation
  const oddsAblation: AblationOut[] = [];
  let oddsTerms: string[] = [];
  {
    let cur = oddsTests(asOf, peers, oddsTerms);
    oddsAblation.push({ term: 'base rate only', test1: cur.cv, test2: cur.ts, kept: true });
    for (const t of ['lntvl', 'age', 'chains', 'growth', 'family']) {
      const trial = [...oddsTerms, t];
      const r = oddsTests(asOf, peers, trial);
      const kept = r.cv < cur.cv && r.ts < cur.ts;
      oddsAblation.push({ term: '+ ' + t, test1: r.cv, test2: r.ts, kept });
      if (kept) { oddsTerms = trial; cur = r; }
    }
    { // the control faces the same court; it is never adopted either way
      const r = oddsTests(asOf, peers, [...oddsTerms, 'placebo']);
      oddsAblation.push({ term: '+ control: the next protocol\u2019s 7-day growth (placebo \u2014 must not help)', test1: r.cv, test2: r.ts, kept: r.cv < cur.cv && r.ts < cur.ts });
    }
    var oddsFinal = cur;
  }
  const oddsFit = fitLogit(asOf, peers, oddsTerms);
  // out-of-fold calibration: every peer is scored by a fit that never
  // saw it (the ten-fold split), then predictions are binned in fifths.
  const calibration: { pred: number; actual: number; n: number }[] = [];
  {
    const bySlug = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
    const oof = bySlug.map((p, i) => {
      const fold = i % 10;
      const train = bySlug.filter((_, j) => j % 10 !== fold);
      return { pred: predictOdds(asOf, fitLogit(asOf, train, oddsTerms), p, oddsTerms), y: tokenRecorded(p) ? 1 : 0 };
    }).sort((a, b) => a.pred - b.pred);
    for (let b = 0; b < 5; b++) {
      const bin = oof.slice(Math.floor((b * oof.length) / 5), Math.floor(((b + 1) * oof.length) / 5));
      calibration.push({ pred: +(bin.reduce((s, x) => s + x.pred, 0) / bin.length).toFixed(3), actual: +(bin.reduce((s, x) => s + x.y, 0) / bin.length).toFixed(3), n: bin.length });
    }
  }

  // stage 2 with ablation
  const comps = groups.pricedComp.filter((p) => p.category !== 'CEX');
  { // placebo control for the value stage: each comparable is handed the
    // next comparable's ln(TVL), in slug order.
    const bySlug = [...comps].sort((a, b) => (a.slug < b.slug ? -1 : 1));
    placeboValue = new Map(bySlug.map((p, i) => [p.slug, Math.log(bySlug[(i + 1) % bySlug.length]!.tvl_usd)]));
  }
  const flatMedian = median(comps.map((p) => p.mcap_usd! / p.tvl_usd));
  const flatMiss = missFactor(comps, (p) => p.tvl_usd * flatMedian);
  const valueAblation: AblationOut[] = [{ term: `flat median multiple ${flatMedian.toFixed(3)}x`, test1: flatMiss, test2: flatMiss, kept: true }];
  let valueTerms: string[] = [];
  let valueFinal = valueTests(asOf, comps, valueTerms);
  valueAblation.push({ term: 'size curve ln(TVL)', test1: valueFinal.loo, test2: valueFinal.wf, kept: true });
  for (const t of ['family', 'category', 'age', 'growth']) {
    const trial = [...valueTerms, t];
    const r = valueTests(asOf, comps, trial);
    const kept = r.loo < valueFinal.loo && r.wf < valueFinal.wf;
    valueAblation.push({ term: '+ ' + t, test1: r.loo, test2: r.wf, kept });
    if (kept) { valueTerms = trial; valueFinal = r; }
  }
  { // the formulation rivals ship — a ridge-shrunk intercept per category
    // (penalty 8, the walk-forward-best of the grid 4..256) — faces the
    // same court, and so does the placebo control. Neither is adopted
    // unless it lowers both held-out misses; the numbers ship either way.
    const rr = valueRidgeTests(asOf, comps, 8);
    valueAblation.push({ term: '+ category effect \u00b7 ridge \u03bb=8 (walk-forward-best penalty)', test1: rr.loo, test2: rr.wf, kept: rr.loo < valueFinal.loo && rr.wf < valueFinal.wf });
    const rp = valueTests(asOf, comps, [...valueTerms, 'placebo']);
    valueAblation.push({ term: '+ control: the next protocol\u2019s ln(TVL) (placebo \u2014 must not help)', test1: rp.loo, test2: rp.wf, kept: rp.loo < valueFinal.loo && rp.wf < valueFinal.wf });
  }
  const VM = fitValue(asOf, comps, valueTerms);

  // held-out residual spread
  const looPairs = comps.map((p, i) => ({ resid: Math.log(p.mcap_usd! / fitValue(asOf, comps.filter((_, j) => j !== i), valueTerms).predict(p)), listed: p.listed_at }));
  const looResid = looPairs.map((x) => x.resid).sort((a, b) => a - b);
  const quantile = (arr: number[], t: number): number => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(t * arr.length)))]!;
  const spread = { p25: Math.exp(quantile(looResid, 0.25)), p75: Math.exp(quantile(looResid, 0.75)), p10: Math.exp(quantile(looResid, 0.10)), p90: Math.exp(quantile(looResid, 0.90)) };
  const shareIn = (lo: number, hi: number): number => looResid.filter((r) => Math.exp(r) >= lo && Math.exp(r) <= hi).length / looResid.length;
  // split-half honesty: the same coverages on the older and newer halves
  // of the dated comparables, so a range that only works on old tokens
  // cannot hide inside the pooled figure.
  const datedPairs = looPairs.filter((x) => x.listed).sort((a, b) => (a.listed! < b.listed! ? -1 : 1));
  const halfN = Math.floor(datedPairs.length / 2);
  const cover = (xs: { resid: number }[], lo: number, hi: number): number => xs.filter((x) => Math.exp(x.resid) >= lo && Math.exp(x.resid) <= hi).length / Math.max(1, xs.length);
  const honestySplit = {
    old2575: cover(datedPairs.slice(0, halfN), spread.p25, spread.p75), new2575: cover(datedPairs.slice(halfN), spread.p25, spread.p75),
    old1090: cover(datedPairs.slice(0, halfN), spread.p10, spread.p90), new1090: cover(datedPairs.slice(halfN), spread.p10, spread.p90),
    n: datedPairs.length,
  };

  // rows
  const raw = boardSet.map((p) => {
    const odds = predictOdds(asOf, oddsFit, p, oddsTerms);
    const val = VM.predict(p);
    return { p, odds, val, implied: odds * val };
  });
  raw.sort((a, b) => b.implied - a.implied);
  // bootstrap rank ranges (value stage refit on resampled comps, odds fixed)
  let seed = 1234567;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const samples: number[][] = raw.map(() => []);
  const betaSamples: number[][] = [];
  for (let b = 0; b < 150; b++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rnd() * comps.length)]!);
    const m = fitValue(asOf, sample, valueTerms);
    betaSamples.push(m.beta);
    raw.map((r, i) => ({ i, v: r.odds * m.predict(r.p) })).sort((a, c) => c.v - a.v).forEach((s, rank) => samples[s.i]!.push(rank + 1));
  }
  const sd = (xs: number[]): number => { const m = xs.reduce((s, v) => s + v, 0) / xs.length; return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length); };
  const seSlope = sd(betaSamples.map((b) => b[1]!));
  const seMult100 = Math.exp(sd(betaSamples.map((b) => b[0]! + b[1]! * Math.log(1e8) + (valueTerms.includes('age') ? b[2]! * VM.fill : 0))));
  const nearestPeers = (p: SnapshotProtocol): PeerComp[] => {
    // Same category first, but only inside a sane size window (within
    // x4.5 of TVL): a category with a single tiny comparable must not
    // crowd out the genuinely near protocols.
    const dist = (c: SnapshotProtocol): number => Math.abs(Math.log(c.tvl_usd / p.tvl_usd));
    const byDist = [...comps].sort((a, b) => dist(a) - dist(b));
    const near = byDist.filter((c) => c.category === p.category && dist(c) <= 1.5);
    const picked = [...near, ...byDist.filter((c) => !near.includes(c))].slice(0, 3);
    return picked.map((c) => ({ name: c.name, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd!, model_usd: Math.round(VM.predict(c)) }));
  };
  const rows: RadarRow[] = raw.map((r, i) => {
    const s = samples[i]!.sort((a, b) => a - b);
    const econ = farmEconomics(r.implied, r.p.tvl_usd, r.p.chains.length);
    return {
      rank: i + 1, rank_best: s[Math.floor(0.25 * s.length)]!, rank_worst: s[Math.floor(0.75 * s.length)]!,
      slug: r.p.slug, name: r.p.name, category: r.p.category, family: family(r.p), chains: r.p.chains,
      tvl_usd: r.p.tvl_usd, change_7d: r.p.change_7d, age_years: ageYears(asOf, r.p), watchlist: watch.has(r.p.slug),
      odds: +r.odds.toFixed(4), if_launches_usd: Math.round(r.val), implied_value_usd: Math.round(r.implied),
      p25_usd: Math.round(r.implied * spread.p25), p75_usd: Math.round(r.implied * spread.p75),
      deposit: Math.round(econ.deposit), expected: +econ.expected.toFixed(2), fees: +econ.fees.toFixed(2),
      net: +econ.net.toFixed(2), hours: +econ.hours.toFixed(1), net_per_hour: +econ.netPerHour.toFixed(2), verdict: econ.verdict,
      farm_steps: farmSteps(r.p, econ),
      peers: nearestPeers(r.p),
    };
  });
  // seal: an FNV-1a hash of the board's canonical rows. The dashboard
  // recomputes it from the data it renders and prints both copies; a
  // page whose table disagreed with the build would show the mismatch.
  const seal = ((): string => {
    let h = 0x811c9dc5;
    const s = rows.map((r) => `${r.rank}:${r.slug}:${r.implied_value_usd}`).join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  })();
  const board: BoardRow[] = rows.map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied_value_usd, farm_steps: r.farm_steps }));
  const radar: RadarData = {
    as_of: asOf,
    ledger: { total: snapshot.protocols.length, ranked: groups.ranked.length, board: rows.length, priced_comp: groups.pricedComp.length, comps_used: comps.length, token_no_cap: groups.tokenNoCap, out_bridge: groups.outBridge, out_staking: groups.outStaking, out_cex: groups.outCex, out_other: groups.outOther, dated_comps: comps.filter((p) => p.listed_at).length },
    odds: { terms: oddsTerms, base_rate: peers.filter(tokenRecorded).length / peers.length, peers: peers.length, weights: oddsFit.w, ablation: oddsAblation, final_cv: oddsFinal.cv, final_ts: oddsFinal.ts },
    value: { terms: valueTerms, beta: VM.beta, flat_median: flatMedian, flat_miss: flatMiss, ablation: valueAblation, final_loo: valueFinal.loo, final_wf: valueFinal.wf, se_slope: +seSlope.toFixed(3), se_mult100: +seMult100.toFixed(2) },
    spread: { ...spread, honesty_2575: shareIn(spread.p25, spread.p75), honesty_1090: shareIn(spread.p10, spread.p90), honesty_old_2575: honestySplit.old2575, honesty_new_2575: honestySplit.new2575, honesty_old_1090: honestySplit.old1090, honesty_new_1090: honestySplit.new1090, split_n: honestySplit.n },
    calibration,
    seal,
    verdicts: rows.reduce<Record<string, number>>((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {}),
    rows,
  };
  return { board, radar };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `board holds ${board.length} rows, under the 100-row floor`;
  const slugs = new Set(board.map((r) => r.slug));
  for (const s of snapshot.watchlist) if (!slugs.has(s)) return `watchlist slug ${s} is missing from the board`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return 'ranks are not exactly 1..N';
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises with rank';
  for (const r of board) {
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `row ${r.slug}: implied value is not a positive whole number`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug}: farm_steps holds ${r.farm_steps.length} steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `row ${r.slug}: a farm step is outside 20-600 characters`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
