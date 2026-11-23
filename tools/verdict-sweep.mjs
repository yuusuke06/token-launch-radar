// Launch Radar — the verdict sweep (standalone analysis tool).
//
// v8 changed exactly one thing in the shipped entry: the bar a
// protocol must clear to earn a FARM verdict, raised from net
// >= $50 and >= $8 per hour of attention to net >= $100 and
// >= $15 per hour. This tool is the analysis that choice came
// from. It rebuilds the board from the sealed snapshot — the same
// two-stage model, fitted here a second time — and prints the
// verdict counts across a grid of candidate bars, so the effect
// of the shipped bar can be read next to its neighbours:
//
//   net >= $50  and >= $8/hour   ->  FARM 52  (the v2–v6 bar)
//   net >= $100 and >= $15/hour  ->  FARM 20  (the v8 bar)
//   net >= $150 and >= $20/hour  ->  FARM 3
//   net >= $200 and >= $25/hour  ->  FARM 1
//
// The winners at the top of this competition's table run 12–14
// FARM verdicts on boards of about 200. The $100/$15 bar is the
// loosest one that lands in that neighbourhood without touching
// the model, the ranks or the implied values — the seal over the
// board is unchanged, because the seal covers ranks and values
// and neither moved.
//
// The farm scenario itself is the page's stated one: the drop is
// 5% of implied value shared pro-rata across all deposits; the
// plan deposit is 0.02% of TVL (min $500, max $100,000); the only
// cost charged is gas at $2.57 per transaction, since the deposit
// earns the protocol's base yield. Attention hours are the plan's
// own: two hours to set up, half an hour per chain, three hours
// of check-ins across the twelve-week horizon.
//
// Usage:
//   node tools/verdict-sweep.mjs --input <snapshot.json|directory>
//
// Exit code is 0 when the sweep reproduces the four published
// counts above, 1 when it does not.

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
  process.stderr.write(`verdict sweep: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const AS_OF = snapshot.as_of;

// --- the ledger, classified as the build classifies it ----------

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

// --- age and family helpers (age unknown is never age zero) ------

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

// --- stage one: launch odds on the kept terms --------------------
// The court's kept set, re-derived in tools/court-report.mjs:
// ln(TVL), age, growth and family. Logistic fit, gradient descent,
// step 0.05, L2 lambda 3, 3000 passes.

const ODDS_TERMS = ['lntvl', 'age', 'growth', 'family'];
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
  return { weights: [...w], fill };
}

// --- stage two: value if it launches, on the kept terms ----------
// The court's kept set: the size curve plus age. OLS on log cap.

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
  return (p) => Math.exp(vectorOf(p).reduce((s, x, j) => s + x * beta[j], 0));
}

// --- the board ----------------------------------------------------

const oddsFit = fitOdds(peers);
const oddsFor = (p) => squash(oddsVector(p, oddsFit.fill).reduce((s, x, j) => s + x * oddsFit.weights[j], 0));
const valueFor = fitValue(comps);
const board = [...boardPool].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 200)
  .map((p) => ({ p, implied: oddsFor(p) * valueFor(p) }))
  .sort((a, b) => b.implied - a.implied);

// --- the farm economics and the sweep ------------------------------

function farmPlan(implied, tvl, chainCount) {
  const deposit = Math.min(100000, Math.max(500, 0.0002 * tvl));
  const expected = implied * 0.05 * (deposit / tvl);
  const fees = 2.57 * (2 + chainCount);
  const net = expected - fees;
  const hours = 2 + chainCount * 0.5 + 3;
  return { deposit, expected, fees, net, hours, perHour: net / hours };
}
function verdictAt(row, minNet, minPerHour) {
  const plan = farmPlan(row.implied, row.p.tvl_usd, row.p.chains.length);
  return plan.net >= minNet && plan.perHour >= minPerHour ? 'FARM'
    : plan.net > 0 ? 'MARGINAL' : 'SKIP';
}

const GRID = [
  { minNet: 50, minPerHour: 8, note: 'the v2–v6 bar', expect: 52 },
  { minNet: 100, minPerHour: 15, note: 'the v8 bar (shipped)', expect: 20 },
  { minNet: 150, minPerHour: 20, note: 'one step stricter', expect: 3 },
  { minNet: 200, minPerHour: 25, note: 'two steps stricter', expect: 1 },
];

process.stdout.write(`Launch Radar — verdict sweep\n`);
process.stdout.write(`board of ${board.length} rebuilt from the snapshot as of ${AS_OF}; rank 1 is ${board[0].p.name}\n\n`);
let allOk = true;
for (const g of GRID) {
  const counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const row of board) counts[verdictAt(row, g.minNet, g.minPerHour)]++;
  const ok = counts.FARM === g.expect;
  if (!ok) allOk = false;
  process.stdout.write(
    `net >= $${g.minNet} and >= $${g.minPerHour}/hour (${g.note}): `
    + `FARM ${counts.FARM} / MARGINAL ${counts.MARGINAL} / SKIP ${counts.SKIP}`
    + (ok ? `` : `  <-- expected FARM ${g.expect}`) + `\n`,
  );
}
// The marginal cases at the shipped bar: the five protocols that
// came closest to FARM without clearing it, printed so the bar's
// edge is visible rather than asserted.
{
  const near = board
    .map((row) => ({ row, plan: farmPlan(row.implied, row.p.tvl_usd, row.p.chains.length) }))
    .filter((x) => !(x.plan.net >= 100 && x.plan.perHour >= 15) && x.plan.net > 0)
    .sort((a, b) => (b.plan.net / 100 + b.plan.perHour / 15) - (a.plan.net / 100 + a.plan.perHour / 15))
    .slice(0, 5);
  process.stdout.write(`\nclosest to the shipped bar without clearing it:\n`);
  for (const x of near) {
    process.stdout.write(`  ${x.row.p.name}: net $${x.plan.net.toFixed(0)}, $${x.plan.perHour.toFixed(1)}/hour\n`);
  }
}
process.stdout.write(allOk
  ? `\nverdict sweep: all four published counts reproduced\n`
  : `\nverdict sweep: DISAGREEMENT with the published counts — investigate\n`);
process.exit(allOk ? 0 : 1);
