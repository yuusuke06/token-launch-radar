// Launch Radar — the stability report (standalone analysis tool).
//
// The board's two softest numbers are the ones this tool checks:
// the rank ranges (each row's interquartile ranks over 150
// bootstrap refits of the value stage) and the time-split
// stability counts (how much of the board survives a model that
// was only ever shown the past). Both are printed on the
// dashboard; both are re-derived here, from the sealed snapshot,
// in a separate implementation, and printed as a report.
//
// What the time split does: the odds stage is refitted on the
// peers listed before 2025 only, the value stage on the older
// half of the dated comparables only, and the same 200 protocols
// are re-ranked by that deliberately blinkered model. The
// published result for the shipped board: rank 1 unchanged, 33
// of the top 40 still in the top 40, a median absolute rank shift
// of 11 across all 200 rows. A board that only works with full
// knowledge of 2025 would fall apart under this test; this one
// mostly holds, and the rows that move are named in the report.
//
// What the bootstrap does: the value stage is refitted 150 times
// on comparables resampled with replacement (the build's seeded
// generator, seed 1234567, so the resamples are the same ones the
// build used), the odds held fixed, and each protocol's ranks
// across the refits are collected. The printed range for a row is
// its interquartile span. Wide ranges on mid-board rows are the
// honest picture: the value model's leave-one-out miss is x3.25,
// so neighbouring protocols are genuinely hard to separate.
//
// Usage:
//   node tools/stability-report.mjs --input <snapshot.json|dir>
//   node tools/stability-report.mjs --input <...> --data <data.js>
//
// With --data (a built dashboard data.js), every row's printed
// rank range is compared against the re-derived one and the
// stability counts against the shipped ones. Exit code is 0 when
// the published stability figures reproduce (and, with --data,
// when all 200 rank ranges match), 1 otherwise.

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
  process.stderr.write(`stability report: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const AS_OF = snapshot.as_of;
const dataArg = argValue('data', '');

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
// stage one: launch odds (kept terms: ln TVL, age, growth, family)
//
// Parameterised by its training rows, because the time split
// refits it on the pre-2025 peers alone. Gradient descent exactly
// as the build specifies: step 0.05, L2 lambda 3, 3000 passes,
// each fit's median-age fill taken from its own training rows.

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

// ------------------------------------------------------------------
// stage two: value if it launches (kept terms: size curve + age)
//
// Parameterised by its training rows for the same reason: the
// bootstrap resamples the comparables and the time split keeps
// only the older half. OLS on log market cap, Gauss-Jordan with
// partial pivoting, 1e-4 on the diagonal.

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
// the headline board

const oddsNow = fitOdds(peers);
const valueNow = fitValue(comps);
const boardSet = [...boardPool].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 200);
const board = boardSet
  .map((p) => ({ p, implied: oddsNow(p) * valueNow(p) }))
  .sort((a, b) => b.implied - a.implied)
  .map((r, i) => ({ ...r, rank: i + 1 }));

// ------------------------------------------------------------------
// the bootstrap: 150 value-stage refits on resampled comparables
//
// The generator is the build's own linear congruential one, seed
// 1234567, so the resamples drawn here are the resamples the
// build drew — the rank ranges below are the same ranges, not a
// fresh sample of what the ranges might be.

const rankSamples = new Map(board.map((r) => [r.p.slug, []]));
{
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let b = 0; b < 150; b++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rnd() * comps.length)]);
    const predict = fitValue(sample);
    boardSet
      .map((p) => ({ slug: p.slug, v: oddsNow(p) * predict(p) }))
      .sort((a, c) => c.v - a.v)
      .forEach((s, rank) => rankSamples.get(s.slug).push(rank + 1));
  }
}
const rankRange = (slug) => {
  const s = [...rankSamples.get(slug)].sort((a, b) => a - b);
  return {
    best: s[Math.floor(0.25 * s.length)],
    worst: s[Math.floor(0.75 * s.length)],
  };
};

// ------------------------------------------------------------------
// the time split: a model that has only seen the past
//
// Odds refitted on peers listed before 2025; value refitted on
// the older half of the dated comparables. The same 200 protocols
// re-ranked. Nothing about the split is tuned after the fact —
// the cut dates are the ones the build published.

const pastPeers = peers.filter((p) => p.listed_at && p.listed_at < '2025-01-01');
const oddsPast = fitOdds(pastPeers);
const datedComps = [...comps].filter((p) => p.listed_at)
  .sort((a, b) => (a.listed_at < b.listed_at ? -1 : 1));
const valuePast = fitValue(datedComps.slice(0, Math.floor(datedComps.length / 2)));
const pastRank = new Map(
  boardSet
    .map((p) => ({ slug: p.slug, v: oddsPast(p) * valuePast(p) }))
    .sort((a, b) => b.v - a.v)
    .map((x, i) => [x.slug, i + 1]),
);
const top40 = new Set(board.slice(0, 40).map((r) => r.p.slug));
const pastTop40 = new Set([...pastRank.entries()].filter(([, rk]) => rk <= 40).map(([s]) => s));
const overlap = [...top40].filter((s) => pastTop40.has(s)).length;
const top1Same = board[0].p.slug === [...pastRank.entries()].find(([, rk]) => rk === 1)[0];
const shifts = board.map((r) => Math.abs(r.rank - (pastRank.get(r.p.slug) ?? r.rank)))
  .sort((a, b) => a - b);
const medianShift = shifts[Math.floor(shifts.length / 2)];

// ------------------------------------------------------------------
// the report

const out = [];
out.push(`Launch Radar — stability report`);
out.push(`snapshot as of ${AS_OF}; board of ${board.length}, rank 1 ${board[0].p.name}`);
out.push(``);
out.push(`TIME SPLIT — the board under a model that never saw 2025`);
out.push(`  rank 1 unchanged: ${top1Same ? 'yes' : 'no'}`);
out.push(`  top-40 survival: ${overlap} of 40`);
out.push(`  median absolute rank shift: ${medianShift}`);
out.push(``);
out.push(`  the seven top-40 rows the past-only model drops, and where it puts them:`);
for (const r of board.slice(0, 40).filter((r) => !pastTop40.has(r.p.slug)).slice(0, 7)) {
  out.push(`    #${r.rank} ${r.p.name} -> #${pastRank.get(r.p.slug)} in the past-only ranking`);
}
out.push(``);
out.push(`BOOTSTRAP RANK RANGES — interquartile ranks over 150 value-stage refits`);
out.push(`  the ten widest ranges on the board (the honest uncertainty):`);
{
  const wide = board
    .map((r) => ({ r, range: rankRange(r.p.slug) }))
    .sort((a, b) => (b.range.worst - b.range.best) - (a.range.worst - a.range.best))
    .slice(0, 10);
  for (const x of wide) {
    out.push(`    #${x.r.rank} ${x.r.p.name}: ranks ${x.range.best}–${x.range.worst}`);
  }
}
out.push(``);
out.push(`  the top ten, with their ranges:`);
for (const r of board.slice(0, 10)) {
  const range = rankRange(r.p.slug);
  out.push(`    #${r.rank} ${r.p.name}: ranks ${range.best}–${range.worst}`);
}

// ------------------------------------------------------------------
// the agreement check

let ok = overlap === 33 && top1Same === true && medianShift === 11;
let rangeNote = 'rank ranges not compared (no --data given)';
if (dataArg && existsSync(dataArg)) {
  const text = readFileSync(dataArg, 'utf8');
  const radar = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  let matched = 0;
  for (const row of radar.rows) {
    const range = rankRange(row.slug);
    if (range.best === row.rank_best && range.worst === row.rank_worst) matched++;
  }
  rangeNote = `rank ranges compared with the shipped board: ${matched} of ${radar.rows.length} match`;
  if (matched !== radar.rows.length) ok = false;
  const stabOk = radar.stability.top40_overlap === overlap
    && radar.stability.top1_same === top1Same
    && radar.stability.median_shift === medianShift;
  if (!stabOk) ok = false;
}
out.push(``);
out.push(`  ${rangeNote}`);
out.push(ok
  ? `stability report: the published stability figures reproduce`
  : `stability report: DISAGREEMENT with the published stability figures`);
process.stdout.write(out.join('\n') + '\n');
process.exit(ok ? 0 : 1);
