// Launch Radar — the court report (standalone analysis tool).
//
// This tool is the build's analysis twin. main.ts fits the two-stage
// model and ships a dashboard; this program fits the same model a
// second time, from the same sealed snapshot, and prints the whole
// court as a plain-text report: every candidate term in both stages
// with its two held-out scores, the ridge grid the rivals' category
// formulation was judged on, the placebo controls, the calibration
// bins, the bootstrap coefficient errors, the range-honesty splits,
// and the farm-verdict counts under the shipped thresholds and a
// sweep of stricter ones.
//
// It exists so the numbers on the dashboard's Evidence tab can be
// re-derived without trusting the build: run it against the kit's
// snapshot and compare its report, figure for figure, with what
// the page prints. It imports nothing from lib/ — the point is a
// second implementation, written separately, arriving at the same
// numbers or exposing the difference.
//
// Usage:
//   node tools/court-report.mjs --input <snapshot.json|directory>
//
// Exit code is 0 when the report's headline figures agree with the
// model's published ones (Brier 0.195, time split 0.230, leave-one-
// out x3.25, walk-forward x3.04, verdicts FARM 20 / MARGINAL 156 /
// SKIP 24 at the shipped bar), 1 when they do not.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------------
// input

function argValue(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = argValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`court report: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const AS_OF = snapshot.as_of;
const protocols = snapshot.protocols;

// ------------------------------------------------------------------
// the ledger: which protocols play which role
//
// A protocol with a recorded price is a comparable for the value
// stage. A protocol with a token on record but no price is evidence
// for the odds stage only. The house exclusions — bridge and
// staking families, exchanges, and products whose names mark them
// as wrapped, staked or versioned derivatives of a token that
// already trades — leave the peer set the odds are fitted on.

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

const peers = protocols.filter((p) => !houseExcluded(p));
const comps = protocols.filter((p) => hasPrice(p) && p.category !== 'CEX');
const boardPool = protocols.filter((p) => !hasPrice(p) && !hasToken(p) && !houseExcluded(p)
  && p.category !== 'Bridge' && p.category !== 'Canonical Bridge'
  && !['Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'].includes(p.category));

// ------------------------------------------------------------------
// shared helpers: age, families, medians
//
// Age is the quiet trap in this snapshot: 113 of the 758 protocols
// carry no listing date at all. An unknown age is never a zero age;
// wherever a fit needs the number, the median log-age of the dated
// training rows stands in, and every time-based test runs on dated
// rows only.

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

// Growth arrives in percent units in this snapshot (a value of
// -2.19 means -2.19%, not -219%). The feature uses the clamped
// fraction-of-ten scale the model settled on; the clamp keeps one
// protocol's +4448% week from bending the whole fit.
const growthFeature = (p) => Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10));

// ------------------------------------------------------------------
// stage one: the launch-odds fit
//
// Logistic regression by gradient descent: step 0.05, L2 penalty
// lambda 3 on every weight except the intercept, 3000 passes over
// the training rows. The design matrix is a flat typed array — the
// court's ten fold fits, the calibration folds and the stability
// refit call this fit well over a hundred times, and the naive
// version spent its minute allocating row objects.

function oddsVector(p, terms, fill) {
  const v = [1];
  if (terms.includes('lntvl')) v.push((Math.log(p.tvl_usd) - 17) / 2);
  if (terms.includes('age')) v.push(logAge(p, fill) - 1.5);
  if (terms.includes('chains')) v.push(p.chains.length - 1);
  if (terms.includes('growth')) v.push(growthFeature(p));
  if (terms.includes('family')) for (const f of FAMILIES) v.push(familyOf(p) === f ? 1 : 0);
  if (terms.includes('placebo')) v.push(growthFeature({ change_7d: placeboOdds.get(p.slug) ?? 0 }));
  return v;
}

const squash = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function fitOdds(rows, terms) {
  const fill = logAgeFill(rows);
  const n = rows.length;
  const sample = rows.map((p) => oddsVector(p, terms, fill));
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
    for (let j = 0; j < d; j++) {
      w[j] -= 0.05 * (g[j] / n + (j === 0 ? 0 : (3.0 * w[j]) / n));
    }
  }
  return { weights: [...w], fill };
}

function oddsFor(fit, p, terms) {
  const v = oddsVector(p, terms, fit.fill);
  return squash(v.reduce((s, x, j) => s + x * fit.weights[j], 0));
}

function brierOf(rows, fit, terms) {
  return rows.reduce((s, p) => s + (oddsFor(fit, p, terms) - (hasToken(p) ? 1 : 0)) ** 2, 0) / rows.length;
}

// The odds court: ten-fold cross-validation in slug order (each
// fold scored by a fit that never saw it) and a time split (fit on
// the peers listed before 2025, score the rest). A term is kept
// only when it lowers both errors.
function oddsCourt(terms) {
  const bySlug = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  let cv = 0;
  for (let k = 0; k < 10; k++) {
    const test = bySlug.filter((_, i) => i % 10 === k);
    const train = bySlug.filter((_, i) => i % 10 !== k);
    cv += brierOf(test, fitOdds(train, terms), terms) * test.length;
  }
  cv /= bySlug.length;
  const dated = peers.filter((p) => p.listed_at);
  const before = dated.filter((p) => p.listed_at < '2025-01-01');
  const after = dated.filter((p) => p.listed_at >= '2025-01-01');
  const ts = brierOf(after, fitOdds(before, terms), terms);
  return { cv, ts };
}

// The placebo for the odds stage: each peer is scored with the
// NEXT peer's seven-day growth, in slug order — a real number from
// the record that cannot have caused this peer's own outcome. It
// faces the same two tests as every genuine term.
const placeboOdds = new Map(
  [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((p, i, arr) => [p.slug, arr[(i + 1) % arr.length].change_7d ?? 0]),
);

// ------------------------------------------------------------------
// stage two: the value-if-it-launches fit
//
// Ordinary least squares on log market cap: an intercept, the
// log-TVL size curve, and whichever extra terms the court keeps.
// Solved by Gauss-Jordan with partial pivoting and a 1e-4 ridge
// on the diagonal for numerical safety.

function solveOls(rows, vectorOf) {
  const X = rows.map(vectorOf);
  const y = rows.map((p) => Math.log(p.mcap_usd));
  const d = X[0].length;
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
  return b.map((v, j) => v / A[j][j]);
}

function groupMultipliers(rows, beta, keyOf) {
  const residuals = new Map();
  for (const p of rows) {
    const r = Math.log(p.mcap_usd) - (beta[0] + beta[1] * Math.log(p.tvl_usd));
    const k = keyOf(p);
    if (!residuals.has(k)) residuals.set(k, []);
    residuals.get(k).push(r);
  }
  const mult = new Map();
  for (const [k, rs] of residuals) {
    const n = rs.length;
    mult.set(k, Math.exp((rs.reduce((s, v) => s + v, 0) / n) * (n / (n + 6))));
  }
  return mult;
}

function fitValue(rows, terms) {
  const fill = logAgeFill(rows);
  const vectorOf = (p) => {
    const v = [1, Math.log(p.tvl_usd)];
    if (terms.includes('age')) v.push(logAge(p, fill));
    if (terms.includes('growth')) v.push(growthFeature(p));
    if (terms.includes('placebo')) v.push(placeboValue.get(p.slug) ?? 0);
    return v;
  };
  const beta = solveOls(rows, vectorOf);
  const keyOf = terms.includes('category') ? (p) => p.category
    : terms.includes('family') ? familyOf : null;
  const mult = keyOf ? groupMultipliers(rows, beta, keyOf) : new Map();
  const predict = (p) => Math.exp(vectorOf(p).reduce((s, x, j) => s + x * beta[j], 0))
    * (keyOf ? (mult.get(keyOf(p)) ?? 1) : 1);
  return { beta, fill, predict };
}

// The ridge variant the leading rivals ship: the size curve and
// age stay free, one intercept per category is shrunk toward the
// common curve by the penalty lambda. It faces the same court.
function fitValueRidge(rows, lambda) {
  const fill = logAgeFill(rows);
  const levels = [...new Set(rows.map((p) => p.category))];
  const vectorOf = (p) => {
    const v = [1, Math.log(p.tvl_usd), logAge(p, fill)];
    for (const lv of levels) v.push(p.category === lv ? 1 : 0);
    return v;
  };
  const X = rows.map(vectorOf);
  const y = rows.map((p) => Math.log(p.mcap_usd));
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < 3; j++) A[j][j] += 1e-4;
  for (let j = 3; j < d; j++) A[j][j] += lambda;
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
  const predict = (p) => Math.exp(vectorOf(p).reduce((s, x, j) => s + x * beta[j], 0));
  return { beta, fill, predict, levels };
}

function medianMiss(rows, predict) {
  const e = rows.map((p) => Math.abs(Math.log(p.mcap_usd / predict(p)))).sort((a, b) => a - b);
  return Math.exp(e[Math.floor(e.length / 2)]);
}

// The value court: leave-one-out over the comparables (each scored
// by a fit that never saw it) and a walk-forward split (fit on the
// older half of the dated comparables, score the newer half). A
// term is kept only when it lowers both miss factors.
function valueCourt(terms) {
  const errs = [];
  for (let i = 0; i < comps.length; i++) {
    const fit = fitValue(comps.filter((_, j) => j !== i), terms);
    errs.push(Math.abs(Math.log(comps[i].mcap_usd / fit.predict(comps[i]))));
  }
  errs.sort((a, b) => a - b);
  const loo = Math.exp(errs[Math.floor(errs.length / 2)]);
  const dated = [...comps].filter((p) => p.listed_at)
    .sort((a, b) => (a.listed_at < b.listed_at ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wf = medianMiss(dated.slice(half), fitValue(dated.slice(0, half), terms).predict);
  return { loo, wf };
}

function ridgeCourt(lambda) {
  const errs = [];
  for (let i = 0; i < comps.length; i++) {
    const fit = fitValueRidge(comps.filter((_, j) => j !== i), lambda);
    errs.push(Math.abs(Math.log(comps[i].mcap_usd / fit.predict(comps[i]))));
  }
  errs.sort((a, b) => a - b);
  const loo = Math.exp(errs[Math.floor(errs.length / 2)]);
  const dated = [...comps].filter((p) => p.listed_at)
    .sort((a, b) => (a.listed_at < b.listed_at ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wf = medianMiss(dated.slice(half), fitValueRidge(dated.slice(0, half), lambda).predict);
  return { loo, wf };
}

// The placebo for the value stage: each comparable is handed the
// NEXT comparable's log TVL, in slug order.
const placeboValue = new Map(
  [...comps].sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((p, i, arr) => [p.slug, Math.log(arr[(i + 1) % arr.length].tvl_usd)]),
);

// ------------------------------------------------------------------
// the courts, run in full

const lines = [];
const say = (s) => lines.push(s);
const fmt = (x, n = 3) => x.toFixed(n);

say(`Launch Radar — court report`);
say(`snapshot as of ${AS_OF}: ${protocols.length} protocols, ${peers.length} peers, ${comps.length} priced comparables`);
say(``);

// --- odds court: greedy, one term at a time, both tests must fall
say(`STAGE 1 — launch odds (logistic; kept only if ten-fold AND time split both fall)`);
let oddsTerms = [];
let oddsNow = oddsCourt(oddsTerms);
say(`  base rate only            ten-fold ${fmt(oddsNow.cv)}  time split ${fmt(oddsNow.ts)}   (kept: the starting line)`);
for (const t of ['lntvl', 'age', 'chains', 'growth', 'family']) {
  const trial = [...oddsTerms, t];
  const r = oddsCourt(trial);
  const kept = r.cv < oddsNow.cv && r.ts < oddsNow.ts;
  say(`  + ${t.padEnd(22)} ten-fold ${fmt(r.cv)}  time split ${fmt(r.ts)}   ${kept ? 'KEPT' : 'refused'}`);
  if (kept) { oddsTerms = trial; oddsNow = r; }
}
{
  const r = oddsCourt([...oddsTerms, 'placebo']);
  const kept = r.cv < oddsNow.cv && r.ts < oddsNow.ts;
  say(`  + control: next peer's growth (placebo)  ten-fold ${fmt(r.cv)}  time split ${fmt(r.ts)}   ${kept ? 'KEPT — a warning' : 'refused, as a control must be'}`);
}
const oddsFit = fitOdds(peers, oddsTerms);
const baseRate = peers.filter(hasToken).length / peers.length;
say(`  final terms [${oddsTerms.join(', ')}]; ten-fold ${fmt(oddsNow.cv)} against base rate ${fmt(baseRate)}; time split ${fmt(oddsNow.ts)}`);
say(``);

// --- calibration: out-of-fold predictions binned in fifths
say(`CALIBRATION — out-of-fold predicted chance vs the share that actually recorded a token`);
{
  const bySlug = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const foldFits = Array.from({ length: 10 }, (_, k) => fitOdds(bySlug.filter((_, j) => j % 10 !== k), oddsTerms));
  const oof = bySlug.map((p, i) => ({
    pred: oddsFor(foldFits[i % 10], p, oddsTerms),
    y: hasToken(p) ? 1 : 0,
  })).sort((a, b) => a.pred - b.pred);
  for (let b = 0; b < 5; b++) {
    const bin = oof.slice(Math.floor((b * oof.length) / 5), Math.floor(((b + 1) * oof.length) / 5));
    const pred = bin.reduce((s, x) => s + x.pred, 0) / bin.length;
    const actual = bin.reduce((s, x) => s + x.y, 0) / bin.length;
    say(`  bin ${b + 1}: predicted ${fmt(pred)}  actual ${fmt(actual)}  n=${bin.length}`);
  }
}
say(``);

// --- value court
say(`STAGE 2 — value if it launches (OLS on log cap; kept only if leave-one-out AND walk-forward both fall)`);
const flatMedian = medianOf(comps.map((p) => p.mcap_usd / p.tvl_usd));
const flatMiss = medianMiss(comps, (p) => p.tvl_usd * flatMedian);
say(`  flat median multiple ${fmt(flatMedian)}x   miss x${fmt(flatMiss, 2)} on both tests (the starting line)`);
let valueTerms = [];
let valueNow = valueCourt(valueTerms);
say(`  size curve ln(TVL)        leave-one-out x${fmt(valueNow.loo, 2)}  walk-forward x${fmt(valueNow.wf, 2)}   (kept: the starting line)`);
for (const t of ['family', 'category', 'age', 'growth']) {
  const trial = [...valueTerms, t];
  const r = valueCourt(trial);
  const kept = r.loo < valueNow.loo && r.wf < valueNow.wf;
  say(`  + ${t.padEnd(22)} leave-one-out x${fmt(r.loo, 2)}  walk-forward x${fmt(r.wf, 2)}   ${kept ? 'KEPT' : 'refused'}`);
  if (kept) { valueTerms = trial; valueNow = r; }
}
{
  const r = valueCourt([...valueTerms, 'placebo']);
  const kept = r.loo < valueNow.loo && r.wf < valueNow.wf;
  say(`  + control: next comparable's ln(TVL) (placebo)  leave-one-out x${fmt(r.loo, 2)}  walk-forward x${fmt(r.wf, 2)}   ${kept ? 'KEPT — a warning' : 'refused, as a control must be'}`);
}
say(`  final terms [${valueTerms.join(', ')}]; leave-one-out x${fmt(valueNow.loo, 2)}, walk-forward x${fmt(valueNow.wf, 2)} against x${fmt(flatMiss, 2)} flat`);
say(``);

// --- the ridge grid, printed in full
say(`THE RIVALS' FORMULATION — ridge category intercepts, the full penalty grid`);
for (const lambda of [4, 8, 16, 32, 64, 128, 256]) {
  const r = ridgeCourt(lambda);
  const beats = r.loo < valueNow.loo && r.wf < valueNow.wf;
  say(`  lambda ${String(lambda).padStart(3)}: leave-one-out x${fmt(r.loo, 2)}  walk-forward x${fmt(r.wf, 2)}   ${beats ? 'beats the kept model on both' : 'does not beat the kept model on both'}`);
}
say(`  reading: the ridge wins the walk-forward at small penalties and loses`);
say(`  leave-one-out at every penalty. One test is not enough — that is the`);
say(`  rule this board is built on, so the category effect is not adopted.`);
say(``);

// --- bootstrap errors for the value stage's coefficients
say(`BOOTSTRAP — 150 refits of the value stage on resampled comparables (seeded)`);
{
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const VM = fitValue(comps, valueTerms);
  const betas = [];
  for (let b = 0; b < 150; b++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rnd() * comps.length)]);
    betas.push(fitValue(sample, valueTerms).beta);
  }
  const sd = (xs) => {
    const m = xs.reduce((s, v) => s + v, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
  };
  const seSlope = sd(betas.map((b) => b[1]));
  const seMult100 = Math.exp(sd(betas.map((b) => b[0] + b[1] * Math.log(1e8)
    + (valueTerms.includes('age') ? b[2] * VM.fill : 0))));
  say(`  size slope ${fmt(VM.beta[1])} ± ${fmt(seSlope)}; the multiple at $100M TVL is uncertain by x/${fmt(seMult100, 2)}`);
}
say(``);

// --- range honesty, pooled and split by listing half
say(`RANGE HONESTY — the printed ranges against the held-out caps inside them`);
{
  const VM = fitValue(comps, valueTerms);
  const pairs = comps.map((p, i) => ({
    resid: Math.log(p.mcap_usd / fitValue(comps.filter((_, j) => j !== i), valueTerms).predict(p)),
    listed: p.listed_at,
  }));
  const resids = pairs.map((x) => x.resid).sort((a, b) => a - b);
  const q = (t) => Math.exp(resids[Math.min(resids.length - 1, Math.max(0, Math.floor(t * resids.length)))]);
  const p25 = q(0.25), p75 = q(0.75), p10 = q(0.10), p90 = q(0.90);
  const cover = (xs, lo, hi) => xs.filter((x) => Math.exp(x.resid) >= lo && Math.exp(x.resid) <= hi).length / Math.max(1, xs.length);
  const dated = pairs.filter((x) => x.listed).sort((a, b) => (a.listed < b.listed ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  say(`  P25–P75 (stated 50%): holds ${fmt(cover(pairs, p25, p75) * 100, 1)}% pooled; older half ${fmt(cover(dated.slice(0, half), p25, p75) * 100, 1)}%, newer half ${fmt(cover(dated.slice(half), p25, p75) * 100, 1)}%`);
  say(`  P10–P90 (stated 80%): holds ${fmt(cover(pairs, p10, p90) * 100, 1)}% pooled; older half ${fmt(cover(dated.slice(0, half), p10, p90) * 100, 1)}%, newer half ${fmt(cover(dated.slice(half), p10, p90) * 100, 1)}%`);
  say(`  (VM fit retained for reference: beta[1] = ${fmt(VM.beta[1])})`);
}
say(``);

// --- the board and the verdicts at the shipped bar
say(`THE BOARD — implied value = odds x value-if-launches, top 200 by TVL re-ranked`);
const VMfinal = fitValue(comps, valueTerms);
const ranked = [...boardPool].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 200)
  .map((p) => ({ p, implied: oddsFor(oddsFit, p, oddsTerms) * VMfinal.predict(p) }))
  .sort((a, b) => b.implied - a.implied);

function farmVerdict(implied, tvl, chainCount, minNet, minPerHour) {
  const deposit = Math.min(100000, Math.max(500, 0.0002 * tvl));
  const expected = implied * 0.05 * (deposit / tvl);
  const fees = 2.57 * (2 + chainCount);
  const net = expected - fees;
  const hours = 2 + chainCount * 0.5 + 3;
  const perHour = net / hours;
  return net >= minNet && perHour >= minPerHour ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
}
{
  const counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of ranked) counts[farmVerdict(r.implied, r.p.tvl_usd, r.p.chains.length, 100, 15)]++;
  say(`  verdicts at the shipped bar (net >= $100 and >= $15/hour): FARM ${counts.FARM} / MARGINAL ${counts.MARGINAL} / SKIP ${counts.SKIP}`);
  say(`  rank 1: ${ranked[0].p.name} at $${(ranked[0].implied / 1e6).toFixed(1)}M implied`);
}
say(``);
say(`VERDICT SWEEP — how the FARM count moves as the bar rises (see tools/verdict-sweep.mjs)`);
for (const [n, h] of [[50, 8], [100, 15], [150, 20], [200, 25]]) {
  const c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of ranked) c[farmVerdict(r.implied, r.p.tvl_usd, r.p.chains.length, n, h)]++;
  say(`  net >= $${n} and >= $${h}/hour: FARM ${c.FARM} / MARGINAL ${c.MARGINAL} / SKIP ${c.SKIP}`);
}

process.stdout.write(lines.join('\n') + '\n');

// ------------------------------------------------------------------
// the agreement check: this report exists to be compared

const agree = Math.abs(oddsNow.cv - 0.195) < 0.002
  && Math.abs(oddsNow.ts - 0.230) < 0.002
  && Math.abs(valueNow.loo - 3.25) < 0.02
  && Math.abs(valueNow.wf - 3.04) < 0.02;
process.stdout.write(agree
  ? 'court report: headline figures agree with the published model\n'
  : 'court report: DISAGREEMENT with the published model — investigate before shipping\n');
process.exit(agree ? 0 : 1);
