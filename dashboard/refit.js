'use strict';
// Launch Radar v5 — the in-page refit.
//
// This file is the dashboard's second opinion about itself. The
// board it renders was produced at build time by lib/model.ts; here,
// in the reader's browser, both model stages are fitted again from
// the raw snapshot (../snapshot.js, the same sealed DefiLlama pull
// the build read) and the resulting board is diffed against the
// shipped one. Same features, same optimiser, same order of
// operations — so any disagreement is a real disagreement, and the
// checks line above the board prints the verdict either way.
//
// What the refit covers: the ledger classification, the top-200
// board set, the launch-odds fit (logistic, gradient descent,
// L2 lambda 3, 3000 iterations), the if-it-launches fit (OLS on log
// market cap), the implied values and the ranks. What it does not
// redo: the ablation court that chose the terms (that lives in the
// build, with its tables on the Evidence tab) and the farm-plan
// economics (those are arithmetic on stated assumptions, recomputed
// live by app.js itself on every slider move).
//
// If a future model ever keeps group multipliers (category or family
// effects in the value stage), this refit refuses to run rather than
// fake a match: window.REFIT stays null and the checks line says the
// refit is unavailable in this copy.
window.REFIT = (() => {
  const R = window.RADAR;
  if (typeof window.SNAPSHOT === 'undefined' || !R) return null;
  if (R.value.terms.some((t) => t === 'category' || t === 'family')) return null;
  try { return refitBoard(window.SNAPSHOT, R); } catch (e) { return null; }
})();

function refitBoard(S, R) {
  // --- the ledger, classified exactly as lib/model.ts classifies it
  const EXCLUDED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
  const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
  const houseExcluded = (p) => EXCLUDED_CATS.has(p.category)
    || /(^|\s)(V2|v2|2\.0|V3|v3)$/.test(p.name.trim())
    || /\b(wrapped|staked|staking)\b/i.test(p.name)
    || EXCHANGES.some((e) => p.name.startsWith(e + ' ') || p.name === e);
  const tokenRecorded = (p) => !!(p.symbol || p.gecko_id);
  const priced = (p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0;

  // --- shared feature helpers (age is unknown, never zero, when the
  // snapshot carries no listing date: the fill is the median log-age
  // of the dated training rows, as in the build)
  const ageYears = (p) => {
    if (!p.listed_at) return null;
    const days = (new Date(S.as_of + 'T00:00:00Z').getTime() - new Date(p.listed_at + 'T00:00:00Z').getTime()) / 864e5;
    return Math.max(0, days / 365.25);
  };
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const ageFill = (rows) => median(rows.filter((p) => ageYears(p) !== null).map((p) => Math.log(1 + ageYears(p))));
  const ageFeat = (p, fill) => { const a = ageYears(p); return a === null ? fill : Math.log(1 + a); };
  const FAMS = ['Lending', 'Dexs', 'Yield', 'Curators', 'Derivatives', 'Stablecoins', 'RWA', 'Staking', 'Chain'];
  const family = (p) => {
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
  };

  // --- the board set: rankable protocols by TVL, top 200
  const ranked = [], pricedComp = [];
  for (const p of S.protocols) {
    if (priced(p)) { pricedComp.push(p); continue; }
    if (tokenRecorded(p)) continue;
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') continue;
    if (['Liquid Staking', 'Liquid Restaking', 'Restaked BTC'].includes(p.category)) continue;
    if (p.category === 'CEX') continue;
    if (houseExcluded(p)) continue;
    ranked.push(p);
  }
  ranked.sort((a, b) => b.tvl_usd - a.tvl_usd);
  const boardSet = ranked.slice(0, 200);

  // --- stage one: launch odds, logistic fit on the 465 peers
  const peers = S.protocols.filter((p) => !houseExcluded(p));
  const oTerms = R.odds.terms;
  const oFill = ageFill(peers);
  const oFeat = (p) => {
    const f = [1];
    if (oTerms.includes('lntvl')) f.push((Math.log(p.tvl_usd) - 17) / 2);
    if (oTerms.includes('age')) f.push(ageFeat(p, oFill) - 1.5);
    if (oTerms.includes('chains')) f.push(p.chains.length - 1);
    if (oTerms.includes('growth')) f.push(Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10)));
    if (oTerms.includes('family')) for (const fm of FAMS) f.push(family(p) === fm ? 1 : 0);
    return f;
  };
  const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  const X = peers.map(oFeat), y = peers.map((p) => (tokenRecorded(p) ? 1 : 0));
  const d = X[0].length, w = new Array(d).fill(0);
  for (let it = 0; it < 3000; it++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const pr = sigmoid(X[i].reduce((s, v, j) => s + v * w[j], 0));
      for (let j = 0; j < d; j++) g[j] += (pr - y[i]) * X[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= 0.05 * (g[j] / X.length + (j === 0 ? 0 : (3.0 * w[j]) / X.length));
  }
  const odds = (p) => sigmoid(oFeat(p).reduce((s, v, j) => s + v * w[j], 0));

  // --- stage two: value if it launches, OLS on the 119 comparables
  const comps = pricedComp.filter((p) => p.category !== 'CEX');
  const vFill = ageFill(comps);
  const vFeat = (p) => {
    const f = [1, Math.log(p.tvl_usd)];
    if (R.value.terms.includes('age')) f.push(ageFeat(p, vFill));
    if (R.value.terms.includes('growth')) f.push(Math.max(-2, Math.min(10, (p.change_7d ?? 0) / 10)));
    return f;
  };
  const Xv = comps.map(vFeat), yv = comps.map((p) => Math.log(p.mcap_usd));
  const dv = Xv[0].length;
  const A = Array.from({ length: dv }, () => new Array(dv).fill(0)), b = new Array(dv).fill(0);
  for (let i = 0; i < Xv.length; i++) for (let j = 0; j < dv; j++) {
    b[j] += Xv[i][j] * yv[i];
    for (let k = 0; k < dv; k++) A[j][k] += Xv[i][j] * Xv[i][k];
  }
  for (let j = 0; j < dv; j++) A[j][j] += 1e-4;
  for (let c = 0; c < dv; c++) {
    let piv = c;
    for (let r = c + 1; r < dv; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < dv; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < dv; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const beta = b.map((v, j) => v / A[j][j]);
  const value = (p) => Math.exp(vFeat(p).reduce((s, v, j) => s + v * beta[j], 0));

  // --- the diff: ranks identical, and the largest implied drift
  const mine = boardSet.map((p) => ({ slug: p.slug, implied: odds(p) * value(p) })).sort((a, b2) => b2.implied - a.implied);
  let same = 0, maxDrift = 0;
  const bySlug = new Map(mine.map((m) => [m.slug, m.implied]));
  R.rows.forEach((r, i) => {
    if (mine[i] && mine[i].slug === r.slug) same++;
    const m = bySlug.get(r.slug);
    if (m) maxDrift = Math.max(maxDrift, Math.abs(m - r.implied_value_usd) / r.implied_value_usd);
  });
  return { n: mine.length, same, maxDrift };
}
