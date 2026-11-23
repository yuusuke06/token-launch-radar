// Launch Radar — the farm plans (standalone analysis tool).
//
// The dashboard's board carries a farm plan for every one of its
// 200 rows: a deposit size, an expected value, the fees, the
// attention hours, and seven written steps. This tool prints the
// plans for the protocols that clear the shipped FARM bar — net
// >= $100 and >= $15 per hour of attention under the page's
// default scenario — as a single readable document, rebuilt from
// the sealed snapshot by its own implementation of the model.
//
// The scenario, stated the same way the page states it: the drop
// is 5% of implied value shared pro-rata across all deposits; the
// plan deposit is 0.02% of TVL (min $500, max $100,000); the only
// cost charged is gas at $2.57 per transaction, since the deposit
// earns the protocol's base yield; the attention budget is two
// hours to set up, half an hour per chain the protocol lives on,
// and three hours of weekly check-ins across the twelve-week
// horizon.
//
// Twenty protocols clear the bar. The list is printed in board
// order with each plan's economics, so a reader can see not just
// which protocols earned the verdict but what the plan actually
// asks of them — and how thin the margin is at the bottom of the
// list, where the twentieth plan clears the bar by a few dollars.
//
// Usage:
//   node tools/top-farms.mjs --input <snapshot.json|directory>
//
// Exit code is 0 when exactly 20 plans clear the shipped bar and
// rank 1 of the board is among them or explicitly noted as
// MARGINAL (Steakhouse's plan nets about $40 — under the v8 bar
// the top of the board is not a farm, and this tool says so),
// 1 when the count disagrees.

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
  process.stderr.write(`farm plans: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const AS_OF = snapshot.as_of;

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
  return (p) => Math.exp(vectorOf(p).reduce((s, x, j) => s + x * beta[j], 0));
}

// ------------------------------------------------------------------
// the board and the plans

const oddsFor = fitOdds(peers);
const valueFor = fitValue(comps);
const board = [...boardPool].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 200)
  .map((p) => ({ p, odds: oddsFor(p), ifLaunches: valueFor(p) }))
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
  return { deposit, expected, fees, net, hours, perHour: net / hours };
}
const verdictOf = (plan) => (plan.net >= 100 && plan.perHour >= 15 ? 'FARM'
  : plan.net > 0 ? 'MARGINAL' : 'SKIP');

// The core action per family — the same one-line instruction the
// dashboard's farm steps build their third step around.
const ACTION = {
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

// ------------------------------------------------------------------
// the document

const farms = board
  .map((r) => ({ ...r, plan: farmPlan(r.implied, r.p.tvl_usd, r.p.chains.length) }))
  .filter((r) => verdictOf(r.plan) === 'FARM');

const out = [];
out.push(`Launch Radar — the twenty farm plans`);
out.push(`snapshot as of ${AS_OF}; scenario: 5% drop shared pro-rata, plan deposit 0.02% of TVL, gas $2.57/tx`);
out.push(`bar: net >= $100 and >= $15 per hour of attention`);
out.push(``);
const top = board[0];
const topPlan = farmPlan(top.implied, top.p.tvl_usd, top.p.chains.length);
out.push(`note: rank 1, ${top.p.name} (implied ${money(top.implied)}), is a ${verdictOf(topPlan)} under this bar —`);
out.push(`its plan nets ${money(topPlan.net)} at $${topPlan.perHour.toFixed(1)}/hour. The biggest prize on the board`);
out.push(`is not automatically a farm; the bar is about the plan's hourly return, not the headline.`);
out.push(``);
for (const r of farms) {
  const fam = familyOf(r.p);
  out.push(`#${r.rank} ${r.p.name} — ${r.p.category}, TVL ${money(r.p.tvl_usd)}, on ${r.p.chains.join(', ')}`);
  out.push(`   odds ${(r.odds * 100).toFixed(0)}% x if-launches ${money(r.ifLaunches)} = implied ${money(r.implied)}`);
  out.push(`   plan: deposit ${money(r.plan.deposit)}, expect ${money(r.plan.expected)}, fees ${money(r.plan.fees)}, net ${money(r.plan.net)} over ${r.plan.hours.toFixed(1)}h ($${r.plan.perHour.toFixed(1)}/hour)`);
  out.push(`   core action (${fam}): ${ACTION[fam] ?? ACTION.Other}`);
  out.push(``);
}
out.push(`total: ${farms.length} plans clear the shipped bar`);
process.stdout.write(out.join('\n') + '\n');
process.exit(farms.length === 20 ? 0 : 1);
