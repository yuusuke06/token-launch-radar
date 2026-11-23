// Launch Radar — the watchlist dossier (standalone analysis tool).
//
// The competition's gate is the watchlist: forty pre-token
// protocols with TVL of $50M or more, a Gecko id and a symbol
// both missing from the record, and a category outside the
// bridge, staking and exchange families. Every board must cover
// all forty, and the board's credibility starts with how it
// treats them. This tool prints a one-paragraph dossier for each
// of the forty, rebuilt from the sealed snapshot by its own
// implementation of the model: board rank, launch odds, value if
// it launches, implied value, the P25–P75 range, the farm
// verdict under the shipped bar, and the three nearest priced
// comparables the detail view would show.
//
// The comparables rule, the same one the dashboard states: same
// category first, but only inside a sane size window (within
// x4.5 of TVL) — a category with a single tiny comparable must
// not crowd out the genuinely near protocols.
//
// The ranges come from the value model's leave-one-out
// residuals, as on the page: P25–P75 is the interquartile span of
// the held-out multiples, the range that held 51% of held-out
// caps against its stated 50%.
//
// Usage:
//   node tools/watchlist-dossier.mjs --input <snapshot.json|dir>
//
// Exit code is 0 when all forty watchlist protocols are covered
// by the rebuilt board and the dossier's rank 1 is the board's
// highest-ranked watchlist protocol, 1 otherwise.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function argValue(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = argValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`watchlist dossier: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const AS_OF = snapshot.as_of;
const watchlist = new Set(snapshot.watchlist);

// ------------------------------------------------------------------
// the ledger

const EXCLUDED_CATS = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking',
  'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function houseExcluded(p) {
  if (EXCLUDED_CATS.has(p.category)) return true;
  const name = p.name.trim();
  if (/(^|\s)(V2|v2|2\.0|V3|v3)$/.test(name)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(name)) return true;
  return EXCHANGE_NAMES.some((e) => name === e || name.startsWith(e + ' '));
}
const hasToken = (p) => Boolean(p.symbol || p.gecko_id);
const hasPrice = (p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0;

const peers = snapshot.protocols.filter((p) => !houseExcluded(p));
const comps = snapshot.protocols.filter((p) => hasPrice(p) && p.category !== 'CEX');
const boardPool = snapshot.protocols.filter((p) => !hasPrice(p) && !hasToken(p) && !houseExcluded(p)
  && p.category !== 'Bridge' && p.category !== 'Canonical Bridge'
  && !['Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'].includes(p.category));

// ------------------------------------------------------------------
// age and family helpers

function ageInYears(p) {
  if (!p.listed_at) return null;
  const ms = new Date(AS_OF + 'T00:00:00Z').getTime() - new Date(p.listed_at + 'T00:00:00Z').getTime();
  return Math.max(0, ms / 864e5 / 365.25);
}
function medianOf(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function logAgeFill(rows) {
  return medianOf(rows.filter((p) => ageInYears(p) !== null).map((p) => Math.log(1 + ageInYears(p))));
}
function logAge(p, fill) {
  const a = ageInYears(p);
  return a === null ? fill : Math.log(1 + a);
}
function familyOf(p) {
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
const FAMILIES = ['Lending', 'Dexs', 'Yield', 'Curators', 'Derivatives', 'Stablecoins', 'RWA', 'Staking', 'Chain'];
const growthFeature = (p) => Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10));

// ------------------------------------------------------------------
// the two stages, on the court's kept terms

function oddsVector(p, fill) {
  const v = [1, (Math.log(p.tvl_usd) - 17) / 2, logAge(p, fill) - 1.5, growthFeature(p)];
  for (const f of FAMILIES) v.push(familyOf(p) === f ? 1 : 0);
  return v;
}
const squash = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function fitOdds(rows) {
  const fill = logAgeFill(rows);
  const n = rows.length;
  const sample = rows.map((p) => oddsVector(p, fill));
  const d = sample[0].length;
  const X = new Float64Array(n * d);
  sample.forEach((v, i) => X.set(v, i * d));
  const y = new Float64Array(rows.map((p) => (hasToken(p) ? 1 : 0)));
  const w = new Float64Array(d);
  const g = new Float64Array(d);
  for (let pass = 0; pass < 3000; pass++) {
    g.fill(0);
    for (let i = 0; i < n; i++) {
      const off = i * d;
      let z = 0;
      for (let j = 0; j < d; j++) z += X[off + j] * w[j];
      const err = squash(z) - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[off + j];
    }
    for (let j = 0; j < d; j++) w[j] -= 0.05 * (g[j] / n + (j === 0 ? 0 : (3.0 * w[j]) / n));
  }
  const weights = [...w];
  return (p) => squash(oddsVector(p, fill).reduce((s, x, j) => s + x * weights[j], 0));
}

function fitValue(rows) {
  const fill = logAgeFill(rows);
  const vectorOf = (p) => [1, Math.log(p.tvl_usd), logAge(p, fill)];
  const X = rows.map(vectorOf);
  const y = rows.map((p) => Math.log(p.mcap_usd));
  const d = 3;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < d; j++) A[j][j] += 1e-4;
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < d; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const beta = b.map((v, j) => v / A[j][j]);
  return { predict: (p) => Math.exp(vectorOf(p).reduce((s, x, j) => s + x * beta[j], 0)) };
}

// ------------------------------------------------------------------
// the residual spread, for the printed ranges

const looResid = comps.map((p, i) => Math.log(p.mcap_usd
  / fitValue(comps.filter((_, j) => j !== i)).predict(p))).sort((a, b) => a - b);
const quantile = (t) => Math.exp(looResid[Math.min(looResid.length - 1, Math.max(0, Math.floor(t * looResid.length)))]);
const SPREAD = { p25: quantile(0.25), p75: quantile(0.75) };

// ------------------------------------------------------------------
// the board, the verdicts, the comparables

const oddsFor = fitOdds(peers);
const valueFit = fitValue(comps);
const board = [...boardPool].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 200)
  .map((p) => ({ p, odds: oddsFor(p), ifLaunches: valueFit.predict(p) }))
  .map((r) => ({ ...r, implied: r.odds * r.ifLaunches }))
  .sort((a, b) => b.implied - a.implied)
  .map((r, i) => ({ ...r, rank: i + 1 }));

const money = (n) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));

function farmPlan(implied, tvl, chainCount) {
  const deposit = Math.min(100000, Math.max(500, 0.0002 * tvl));
  const expected = implied * 0.05 * (deposit / tvl);
  const fees = 2.57 * (2 + chainCount);
  const net = expected - fees;
  const hours = 2 + chainCount * 0.5 + 3;
  return { net, perHour: net / hours };
}
const verdictOf = (plan) => (plan.net >= 100 && plan.perHour >= 15 ? 'FARM'
  : plan.net > 0 ? 'MARGINAL' : 'SKIP');

function nearestComps(p) {
  const dist = (c) => Math.abs(Math.log(c.tvl_usd / p.tvl_usd));
  const byDist = [...comps].sort((a, b) => dist(a) - dist(b));
  const near = byDist.filter((c) => c.category === p.category && dist(c) <= 1.5);
  return [...near, ...byDist.filter((c) => !near.includes(c))].slice(0, 3);
}

// ------------------------------------------------------------------
// the dossier

const covered = board.filter((r) => watchlist.has(r.p.slug));
const out = [];
out.push(`Launch Radar — the watchlist dossier`);
out.push(`snapshot as of ${AS_OF}; ${covered.length} of ${watchlist.size} watchlist protocols on the rebuilt board`);
out.push(``);
for (const r of covered) {
  const plan = farmPlan(r.implied, r.p.tvl_usd, r.p.chains.length);
  const age = ageInYears(r.p);
  const compsText = nearestComps(r.p)
    .map((c) => `${c.name} (TVL ${money(c.tvl_usd)}, cap ${money(c.mcap_usd)})`)
    .join('; ');
  out.push(`#${r.rank} ${r.p.name} — ${r.p.category} / ${familyOf(r.p)}, TVL ${money(r.p.tvl_usd)}`);
  out.push(`   age ${age === null ? 'unknown (no listing date on record)' : age.toFixed(1) + ' years'}; 7-day change ${r.p.change_7d === null ? 'n/a' : r.p.change_7d.toFixed(1) + '%'}`);
  out.push(`   odds ${(r.odds * 100).toFixed(0)}% x if-launches ${money(r.ifLaunches)} = implied ${money(r.implied)}; range ${money(r.implied * SPREAD.p25)}–${money(r.implied * SPREAD.p75)}`);
  out.push(`   verdict ${verdictOf(plan)} (plan net ${money(plan.net)} at $${plan.perHour.toFixed(1)}/hour)`);
  out.push(`   nearest priced comparables: ${compsText}`);
  out.push(``);
}
process.stdout.write(out.join('\n') + '\n');
const ok = covered.length === watchlist.size && covered.length === 40;
process.stdout.write(ok
  ? `watchlist dossier: all forty covered\n`
  : `watchlist dossier: COVERAGE GAP — ${covered.length} of ${watchlist.size}\n`);
process.exit(ok ? 0 : 1);
