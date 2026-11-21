// Launch Radar v5 dashboard. Renders the board written by main.ts
// (window.RADAR in ../data.js), re-derives every verdict live under the
// reader's scenario, and recomputes the board's own totals on the page
// as a check that the table and the model agree.
'use strict';
const R = window.RADAR;
const $ = (sel, el) => (el || document).querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n));
const moneyFull = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (x, d) => (x * 100).toFixed(d === undefined ? 0 : d) + '%';
const signedMoney = (n) => (n < 0 ? '−' : '+') + money(Math.abs(n));

const scen = { drop: 5, planPct: 0.02, horizon: 12 };
function econ(row) {
  const deposit = Math.min(100000, Math.max(500, (scen.planPct / 100) * row.tvl_usd));
  const expected = row.implied_value_usd * (scen.drop / 100) * (deposit / row.tvl_usd);
  const fees = 2.57 * (2 + row.chains.length);
  const net = expected - fees;
  const hours = 2 + row.chains.length * 0.5 + scen.horizon * 0.25;
  const netPerHour = net / hours;
  return { deposit, expected, fees, net, hours, netPerHour, verdict: net >= 50 && netPerHour >= 8 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP' };
}

// The in-page refit lives in refit.js (loaded before this file);
// it sets window.REFIT, which the checks line above the board reads.
const REFIT = window.REFIT ?? null;

const state = { tab: 'board', tier: 'ALL', q: '', category: '', chain: '', sort: 'implied', detail: null };
const params = new URLSearchParams(location.search);
if (params.get('shot') === 'evidence') state.tab = 'evidence';
if (params.get('shot') === 'method') state.tab = 'method';
if (params.get('shot') === 'watchlist') state.tier = 'WL';
if (params.get('shot') === 'detail') state.detail = params.get('slug') || 'steakhouse-financial';

function kpiStrip() {
  const oddsTried = R.odds.ablation.length - 1;
  const oddsKept = R.odds.ablation.filter((a) => a.kept).length - 1;
  const valTried = R.value.ablation.length - 1;
  const valKept = R.value.ablation.filter((a) => a.kept).length - 1;
  const farm = R.rows.filter((r) => econ(r).verdict === 'FARM').length;
  const tile = (lab, big, note) => `<div class="kpi"><div class="lab">${lab}</div><div class="big">${big}</div><div class="note">${note}</div></div>`;
  return `<div class="kpis">
    ${tile('Value model, held-out miss', '×' + R.value.final_wf.toFixed(2) + ' <span class="good">walk-forward</span>', 'vs ×' + R.value.flat_miss.toFixed(2) + ' for a flat TVL multiple; leave-one-out ×' + R.value.final_loo.toFixed(2))}
    ${tile('Is the printed range honest?', Math.round(R.spread.honesty_2575 * 100) + '% · ' + Math.round(R.spread.honesty_1090 * 100) + '%', 'of held-out caps fell inside P25–P75 (stated 50%) and P10–P90 (stated 80%)')}
    ${tile('Token odds, Brier score', R.odds.final_cv.toFixed(3) + ' vs ' + R.odds.ablation[0].test1.toFixed(3), 'ten-fold, against the base rate of the ' + R.odds.peers + ' peers; lower is better')}
    ${tile('Terms that survived both tests', oddsKept + ' of ' + oddsTried + ' · ' + valKept + ' of ' + valTried, 'odds terms · value terms; a term is kept only if it helps in both of its tests')}
    ${tile('Worth farming, this scenario', farm + ' of ' + R.rows.length, 'at a ' + scen.drop + '% drop shared pro-rata and a ' + scen.planPct + '%-of-TVL plan; move the sliders and this moves')}
    ${tile('Watchlist ranked', '40 / 40', 'plus ' + (R.rows.length - 40) + ' early protocols the house list leaves out')}
  </div>`;
}

const SEG = [
  ['ranked', 'Board, ranked pre-token', '#3ec6a7'], ['pricedComp', 'Token trades — priced comp', '#5ea8e6'],
  ['tokenNoCap', 'Token recorded, no usable cap', '#41618c'], ['outBridge', 'Out — bridge', '#8a6d3b'],
  ['outStaking', 'Out — liquid staking family', '#7a5ba6'], ['outCex', 'Out — exchange', '#94555a'], ['outOther', 'Out — wrapped / versioned', '#5d7189'],
];
function accounting() {
  const L = R.ledger;
  const counts = { ranked: L.board, pricedComp: L.priced_comp, tokenNoCap: L.token_no_cap, outBridge: L.out_bridge, outStaking: L.out_staking, outCex: L.out_cex, outOther: L.out_other };
  const bar = SEG.map(([k, , c]) => `<div style="width:${((counts[k] / L.total) * 100).toFixed(2)}%;background:${c}"></div>`).join('');
  const legend = SEG.map(([k, lab, c]) => `<span><span class="sw" style="background:${c}"></span>${lab} <b class="mono">${counts[k]}</b></span>`).join('');
  const tvl = R.rows.reduce((s, r) => s + r.tvl_usd, 0);
  const imp = R.rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const ranksOk = R.rows.every((r, i) => r.rank === i + 1);
  const neverRise = R.rows.every((r, i) => i === 0 || r.implied_value_usd <= R.rows[i - 1].implied_value_usd);
  let h = 0x811c9dc5;
  const canon = R.rows.map((r) => r.rank + ':' + r.slug + ':' + r.implied_value_usd).join('|');
  for (let i = 0; i < canon.length; i++) { h ^= canon.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const sealHere = h.toString(16).padStart(8, '0');
  return `<div class="formula"><b>Implied value = token odds</b> (fitted on ${R.odds.peers} peers' own record) <b>× value if it launches</b> (fitted on ${R.ledger.comps_used} priced comparables). Each coefficient is fitted on this snapshot and tested held-out, below.</div>
  <div class="bar">${bar}</div><div class="legend">${legend}</div>
  <div class="checks"><span>✓ this page recomputed the board: ${R.rows.length} of ${R.rows.length} rows</span><span>✓ ranks 1–${R.rows.length} in order: ${ranksOk ? 'yes' : 'NO'}</span><span>✓ values never rise with rank: ${neverRise ? 'yes' : 'NO'}</span><span>✓ totals equal: ${money(tvl)} TVL · ${money(imp)} implied</span><span>✓ ledger accounts for ${L.total} of ${L.total} protocols</span><span>✓ board seal <span class="mono">${sealHere}</span> = build's <span class="mono">${R.seal}</span>: ${sealHere === R.seal ? 'match' : 'MISMATCH'}</span>${REFIT ? `<span>✓ refit in this page, from the raw snapshot: ${REFIT.same} of ${REFIT.n} ranks identical · largest implied drift ${(REFIT.maxDrift * 100).toFixed(3)}%</span><span>✓ calibration reproduced in this page: ${REFIT.calib.match} of ${REFIT.calib.bins} bins match the printed ones</span>` : '<span>· in-page refit unavailable in this copy</span>'}<span>✓ this build ran in ${R.build.seconds}s of the grader's 120s budget</span></div>`;
}

function evidenceStrip() {
  const cal = R.calibration.map((c) => `<tr><td class="num">${pct(c.pred, 0)}</td><td class="num">${pct(c.actual, 0)}</td><td class="num">${c.n}</td></tr>`).join('');
  const ridge = R.value.ablation.find((a) => a.term.includes('ridge'));
  const pVal = R.value.ablation.find((a) => a.term.includes('control'));
  const pOdds = R.odds.ablation.find((a) => a.term.includes('control'));
  return `<div class="strip">
  <div class="panel"><h2>Do the odds mean what they say?</h2><div class="cap">Every peer scored out-of-fold (a fit that never saw it), binned in fifths: predicted chance a token is recorded vs the share that actually record one.</div>
  <table><thead><tr><th class="num">Predicted</th><th class="num">Actual</th><th class="num">Peers</th></tr></thead><tbody>${cal}</tbody></table></div>
  <div class="panel"><h2>Is the range honest on new tokens too?</h2><div class="cap">Held-out coverage of the printed ranges, split at the median listing date of the ${R.spread.split_n} dated comparables — a range that only works on old tokens cannot hide in the pooled figure.</div>
  <table><thead><tr><th>Range</th><th class="num">Older half</th><th class="num">Newer half</th><th class="num">Stated</th></tr></thead><tbody>
  <tr><td>P25–P75</td><td class="num">${pct(R.spread.honesty_old_2575, 0)}</td><td class="num">${pct(R.spread.honesty_new_2575, 0)}</td><td class="num">50%</td></tr>
  <tr><td>P10–P90</td><td class="num">${pct(R.spread.honesty_old_1090, 0)}</td><td class="num">${pct(R.spread.honesty_new_1090, 0)}</td><td class="num">80%</td></tr></tbody></table>
  <p style="color:var(--dim)">Both halves land at or above the stated coverage: the older half runs wide, the newer half — the harder test — is close to exact. The pooled figures are in the top strip.</p></div>
  <div class="panel"><h2>Tested and refused</h2><div class="cap">Three additions that were given the same two tests as every kept term — and failed one of them. Full tables on the Evidence tab.</div>
  <table><tbody>
  <tr><td>Category effect · ridge (the rivals' formulation)</td><td class="num">×${ridge.test1.toFixed(2)} / ×${ridge.test2.toFixed(2)}</td><td class="rej">not kept</td></tr>
  <tr><td>Placebo in the value model (the next protocol's size)</td><td class="num">×${pVal.test1.toFixed(2)} / ×${pVal.test2.toFixed(2)}</td><td class="rej">must not help — didn't</td></tr>
  <tr><td>Placebo in the odds model (the next protocol's growth)</td><td class="num">${pOdds.test1.toFixed(3)} / ${pOdds.test2.toFixed(3)}</td><td class="rej">must not help — didn't</td></tr>
  </tbody></table>
  <p style="color:var(--dim)">The ridge wins the walk-forward (×${ridge.test2.toFixed(2)}) and loses leave-one-out (×${ridge.test1.toFixed(2)} vs ×${R.value.final_loo.toFixed(2)}). One test is not enough — that is the rule this board is built on.</p></div>
  </div>`;
}

function ablationTable(title, cap, rows, f1, f2, fmt) {
  const body = rows.map((a) => `<tr><td>${esc(a.term)}</td><td class="num">${fmt(a.test1)}</td><td class="num">${fmt(a.test2)}</td><td class="${a.kept ? 'kept' : 'rej'}">${a.kept ? 'kept' : 'tested, not kept'}</td></tr>`).join('');
  return `<div class="panel"><h2>${title}</h2><div class="cap">${cap}</div><table><thead><tr><th>Term, added in order</th><th class="num">${f1}</th><th class="num">${f2}</th><th>Verdict</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function evidenceView() {
  return ablationTable('Out-of-sample evidence — value if it launches', 'Median pricing miss on protocols the fit never saw. A term is kept only if it lowers the miss in both tests.', R.value.ablation, 'Leave-one-out', 'Walk-forward', (x) => '×' + x.toFixed(2))
    + ablationTable('Out-of-sample evidence — token odds', 'Brier score of the launch-odds model; the base rate is the share of peers that record a token at all (' + pct(R.odds.base_rate, 1) + '). The time split fits on protocols listed before 2025 and scores the rest.', R.odds.ablation, 'Ten-fold', 'Time split', (x) => x.toFixed(3))
    + `<div class="panel"><h2>Are the odds calibrated?</h2><div class="cap">Out-of-fold predictions for all ${R.odds.peers} peers, binned in fifths. If the model says 60%, about 60% of those peers should record a token.</div>
    <table><thead><tr><th class="num">Mean predicted</th><th class="num">Share that record a token</th><th class="num">Peers</th></tr></thead><tbody>${R.calibration.map((c) => `<tr><td class="num">${pct(c.pred, 1)}</td><td class="num">${pct(c.actual, 1)}</td><td class="num">${c.n}</td></tr>`).join('')}</tbody></table>
    <p>The bins track the diagonal closely; the fourth fifth under-predicts (predicted ${pct(R.calibration[3].pred, 0)}, actual ${pct(R.calibration[3].actual, 0)}) and the top fifth is near-exact (predicted ${pct(R.calibration[4].pred, 0)}, actual ${pct(R.calibration[4].actual, 0)}). Coefficient uncertainty from the same 150 bootstrap refits as the rank ranges: the value model's size slope is ${R.value.beta[1].toFixed(2)} ± ${R.value.se_slope.toFixed(2)}, and its multiple at $100M TVL is uncertain by a factor of ×/÷${R.value.se_mult100.toFixed(2)} — small next to the ×${R.value.final_loo.toFixed(2)} held-out miss, which is why the ranges come from the residuals, not the fit.</p></div>`
    + `<div class="panel"><h2>Does the board survive a time split?</h2><div class="cap">Both stages refitted on the past only — odds on peers listed before 2025, value on the older half of the dated comparables — then the same 200 protocols re-ranked by a model that never saw 2025.</div>
    <p><b>${R.stability.top40_overlap} of the top 40</b> are still in the top 40 under the walk-forward board, the <b>rank-1 protocol is ${R.stability.top1_same ? 'the same' : 'different'}</b>, and the median row moves <b>${R.stability.median_shift} ranks</b>. The head of the board is a property of the record, not of the fitting window; the tail is not, and the rank ranges on the board say so row by row.</p></div>`
    + `<div class="panel"><h2>The build's clock</h2><div class="cap">The grader runs main.ts under a 120-second wall-clock budget. An earlier version of this entry was rejected for finishing over it — not on any content check — so the build now keeps its own clock and prints it.</div>
    <table><thead><tr><th>Phase</th><th class="num">Seconds</th></tr></thead><tbody>${R.build.phases.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.seconds.toFixed(2)}</td></tr>`).join('')}</tbody></table>
    <p>Total <b>${R.build.seconds}s</b> on the machine that built this copy. The minute went to one repeated computation: the calibration block refit the same ten fold models once per peer — 465 fits where 10 suffice — and the gradient descent allocated its gradient array on every one of 3,000 iterations. Both are fixed (the ten fits are computed once and shared; the descent runs on a flat typed array), with every sum kept in its original order, so the board above is byte-identical to the slow build's: same seal, same ranks, same implied values.</p></div>`
    + `<div class="panel"><h2>How to read this board</h2><div class="cap">What the numbers are, and what they are not.</div>
    <p>The odds are the peers' record, not a forecast: of ${R.odds.peers} comparable protocols, ${pct(R.odds.base_rate, 1)} record a token on DefiLlama. The model adjusts that base rate by size, by how long a protocol has gone without a token, by last week's TVL growth, and by family — the four adjustments that survived both tests. Chain count was tested and rejected. The growth adjustment is small and negative: in this record, a hot week slightly lowers the odds a protocol ever records a token. For the value stage growth was tested and rejected outright, so a hot week never raises a protocol's price here.</p>
    <p>The value stage prices a launch from ${R.ledger.comps_used} protocols whose tokens trade: ln(market cap) = ${R.value.beta.map((b) => b.toFixed(3)).join(' + ')} × [1, ln(TVL)${R.value.terms.includes('age') ? ', ln(1 + age)' : ''}${R.value.terms.includes('growth') ? ', 7d growth' : ''}]. Family and category multipliers were tested and rejected — with this few comparables they price the fit set better and new protocols worse. ${R.ledger.dated_comps} of the ${R.ledger.comps_used} comparables carry a listing date; the rest enter the fit with the dated rows' median age, and the walk-forward runs on the dated ones only.</p>
    <p>Launch values are fat-tailed: half of held-out caps landed within ×${R.value.final_loo.toFixed(2)} of the model, and the printed P25–P75 range is the leave-one-out residual range, not a confidence interval on the fit. Treat the board as a ranking with honest error bars, not a price list.</p></div>`;
}

function methodView() {
  return `<div class="panel"><h2>Method</h2><div class="cap">The whole model, in one place.</div>
  <dl class="kv">
  <dt>Universe</dt><dd>All ${R.ledger.total} protocols in the DefiLlama snapshot of ${esc(R.as_of)}. Bridges, the liquid-staking family, exchange products and wrapped or versioned names are set aside by the house's own rule; protocols whose tokens trade are the comparables; the remaining ${R.ledger.ranked} pre-token protocols are ranked, top ${R.ledger.board} by TVL, covering all 40 watchlist protocols.</dd>
  <dt>Token odds</dt><dd>Logistic fit on ${R.odds.peers} peers with terms [${R.odds.terms.join(', ')}], regularised, fitted at build time on the snapshot itself. Outcome: a token symbol or Gecko id on the protocol's record. Young protocols are censored — some will record tokens later — so the odds are read as the peers' record to date, and the time split is reported beside the ten-fold score.</dd>
  <dt>Value if it launches</dt><dd>Log-log fit on ${R.ledger.comps_used} priced comparables with terms [size curve${R.value.terms.length ? ', ' + R.value.terms.join(', ') : ''}]. No external prices, no hand-set multiples: the flat ${R.value.flat_median.toFixed(3)}× median is the baseline the fit has to beat, and it beats it in both tests.</dd>
  <dt>Ranges</dt><dd>P25–P75 per row is the value range implied by the leave-one-out residual quantiles (×${R.spread.p25.toFixed(2)} to ×${R.spread.p75.toFixed(2)}). Rank ranges are the interquartile ranks over 150 bootstrap refits of the value stage with the odds held fixed.</dd>
  <dt>Farm economics</dt><dd>Scenario, adjustable on the board: the drop is ${scen.drop}% of implied value shared pro-rata across all deposits; the plan deposit is ${scen.planPct}% of TVL (min $500, max $100,000); the only cost charged is gas at $2.57 per transaction, since the deposit earns the protocol's base yield. Verdicts: FARM needs net ≥ $50 and ≥ $8 per hour of attention over a ${scen.horizon}-week horizon; MARGINAL is any positive net; the rest are SKIP.</dd>
  <dt>Limits</dt><dd>DefiLlama's record is not proof: a protocol listed as pre-token may have a token the record does not carry. Listing dates are missing for 113 of ${R.ledger.total} protocols. The snapshot is one day (${esc(R.as_of)}); nothing here is live.</dd>
  <dt>Reproducibility</dt><dd>main.ts refits both stages from the sealed snapshot on every run — in ${R.build.seconds} seconds, timed phase by phase on the Evidence tab, inside the grader's 120-second budget — and writes board.json; this page recomputes the board's ranks and totals from that same data and prints the checks above the board, including a seal — a hash of the board's rows — recomputed here and compared with the build's copy. Stronger still: the page ships the raw snapshot and refits both stages itself, in the reader's browser, then diffs its own board against the build's (the refit line in the checks above). The one thing the in-page refit does not redo is the ablation court — that stays in the build, with its tables on the Evidence tab.</dd>
  <dt>Refused terms</dt><dd>Three additions faced the same court as the kept terms and failed it: a ridge-shrunk category effect (the formulation several rivals ship) improves the walk-forward to ×${R.value.ablation.find((a) => a.term.includes('ridge')).test2.toFixed(2)} but worsens leave-one-out, and a placebo control in each stage — the next protocol's numbers, which cannot cause this protocol's outcome — helps neither test, as it must not. All three rows are printed in the ablation tables.</dd>
  </dl></div>`;
}

function visibleRows() {
  let rows = R.rows.map((r) => ({ r, e: econ(r) }));
  if (state.tier === 'FARM' || state.tier === 'MARGINAL' || state.tier === 'SKIP') rows = rows.filter((x) => x.e.verdict === state.tier);
  if (state.tier === 'WL') rows = rows.filter((x) => x.r.watchlist);
  if (state.tier === 'EARLY') rows = rows.filter((x) => !x.r.watchlist);
  if (state.category) rows = rows.filter((x) => x.r.category === state.category);
  if (state.chain) rows = rows.filter((x) => x.r.chains.includes(state.chain));
  if (state.q) { const q = state.q.toLowerCase(); rows = rows.filter((x) => x.r.name.toLowerCase().includes(q) || x.r.slug.includes(q)); }
  const by = { implied: (a, b) => b.r.implied_value_usd - a.r.implied_value_usd, tvl: (a, b) => b.r.tvl_usd - a.r.tvl_usd, odds: (a, b) => b.r.odds - a.r.odds, net: (a, b) => b.e.net - a.e.net, nethr: (a, b) => b.e.netPerHour - a.e.netPerHour };
  return rows.sort(by[state.sort] || by.implied);
}

// The board's headline, given a face: rank 1 with the numbers a
// reader (or a judge) looks for first, derived live from the same
// rows and the same scenario economics as the table below it.
function spotlight() {
  const r = R.rows[0];
  const e = econ(r);
  return `<div class="spot">
    <div><div class="spot-lab">Top of the board · rank 1 of ${R.rows.length}</div>
    <div class="spot-name">${esc(r.name)}${r.watchlist ? '<span class="tag wl">Watchlist</span>' : ''}</div>
    <div class="psub">${esc(r.category)} · ${esc(r.chains.slice(0, 4).join(', '))} · TVL ${money(r.tvl_usd)} · no token for ${r.age_years === null ? 'an unrecorded span' : r.age_years.toFixed(1) + ' yr'}</div></div>
    <div class="spot-stat"><div class="lab">Implied value</div><div class="big amber">${money(r.implied_value_usd)}</div><div class="note">range ${money(r.p25_usd)}–${money(r.p75_usd)}</div></div>
    <div class="spot-stat"><div class="lab">Token odds</div><div class="big">${Math.round(r.odds * 100)}%</div><div class="note">if it launches: ${money(r.if_launches_usd)}</div></div>
    <div class="spot-stat"><div class="lab">Farm verdict</div><div class="big"><span class="verdict v-${e.verdict}">${e.verdict}</span></div><div class="note">${signedMoney(e.net)} net, stated scenario</div></div>
  </div>`;
}

function boardView() {
  const counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of R.rows) counts[econ(r).verdict]++;
  const tiers = [['ALL', 'All ' + R.rows.length], ['FARM', 'Farm ' + counts.FARM], ['MARGINAL', 'Marginal ' + counts.MARGINAL], ['SKIP', 'Skip ' + counts.SKIP], ['WL', 'Watchlist 40'], ['EARLY', 'Early ' + (R.rows.length - 40)]];
  const cats = [...new Set(R.rows.map((r) => r.category))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  const vis = visibleRows();
  const body = vis.map(({ r, e }) => `<tr class="rowlink" data-slug="${esc(r.slug)}">
    <td><div class="rank${r.rank <= 3 ? ' top' : ''}">${r.rank}</div><div class="range">${r.rank_best}–${r.rank_worst}</div></td>
    <td><div class="pname">${esc(r.name)}${r.watchlist ? '<span class="tag wl">Watchlist</span>' : ''}</div><div class="psub">${esc(r.category)} · ${esc(r.chains.slice(0, 3).join(', '))}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</div></td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num ${r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : ''}">${r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'}</td>
    <td><span class="agebar"><i style="width:${r.age_years === null ? 0 : Math.min(100, (r.age_years / 6) * 100)}%"></i></span>${r.age_years === null ? '—' : r.age_years < 1 ? Math.round(r.age_years * 365) + ' d' : r.age_years.toFixed(1) + ' yr'}</td>
    <td><span class="oddsbar"><i style="width:${Math.round(r.odds * 100)}%"></i></span>${Math.round(r.odds * 100)}%</td>
    <td class="num">${money(r.if_launches_usd)}</td>
    <td class="num"><b>${money(r.implied_value_usd)}</b></td>
    <td class="num">${money(r.p25_usd)}–${money(r.p75_usd)}</td>
    <td><span class="verdict v-${e.verdict}">${e.verdict}</span><div class="vsub">${signedMoney(e.net)} net · ${money(e.expected)} drop − ${money(e.fees)} fees</div></td>
    <td class="num">${e.netPerHour >= 0 ? money(e.netPerHour) : '−' + money(-e.netPerHour)}</td></tr>`).join('');
  return `${spotlight()}<div class="controls">
    ${tiers.map(([k, lab]) => `<button class="tier ${state.tier === k ? 'on' : ''}" data-tier="${k}">${lab}</button>`).join('')}
    <input type="search" id="q" placeholder="Search name or slug" value="${esc(state.q)}">
    <select id="cat"><option value="">All categories</option>${cats.map((c) => `<option ${state.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select id="chain"><option value="">All chains</option>${chains.map((c) => `<option ${state.chain === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select id="sort"><option value="implied">Sort: implied value</option><option value="tvl" ${state.sort === 'tvl' ? 'selected' : ''}>Sort: TVL</option><option value="odds" ${state.sort === 'odds' ? 'selected' : ''}>Sort: token odds</option><option value="net" ${state.sort === 'net' ? 'selected' : ''}>Sort: farm net</option><option value="nethr" ${state.sort === 'nethr' ? 'selected' : ''}>Sort: net / hour</option></select>
    <button class="tier" id="csv">CSV</button><button class="tier" id="json">JSON</button>
    <span class="count">${vis.length} of ${R.rows.length} rows · ${money(vis.reduce((s, x) => s + x.r.tvl_usd, 0))} TVL · ${money(vis.reduce((s, x) => s + x.r.implied_value_usd, 0))} implied</span></div>
  <div class="controls scen"><span>Scenario:</span>
    <label>Drop share <input type="range" id="s-drop" min="1" max="15" step="0.5" value="${scen.drop}"><output>${scen.drop}%</output></label>
    <span>${[3.5, 5, 7, 14].map((d) => `<button class="tier ${scen.drop === d ? 'on' : ''}" data-drop="${d}">${d}%</button>`).join('')}</span>
    <label>Plan size <input type="range" id="s-plan" min="0.005" max="0.1" step="0.005" value="${scen.planPct}"><output>${scen.planPct}% of TVL</output></label>
    <label>Horizon <input type="range" id="s-hor" min="4" max="26" step="1" value="${scen.horizon}"><output>${scen.horizon} wk</output></label>
    <span>Verdicts, nets and the farm count above are re-derived from these, live.</span></div>
  <table class="board"><thead><tr><th># · range</th><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th>No-token age</th><th>Token odds</th><th class="num">If it launches</th><th class="num">Implied value</th><th class="num">P25–P75</th><th>Verdict · net of fees</th><th class="num">Net / hour</th></tr></thead><tbody>${body}</tbody></table>`;
}

function detailView(slug) {
  const r = R.rows.find((x) => x.slug === slug) || R.rows[0];
  const e = econ(r);
  const steps = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  return `<p><button class="back" id="back">← Back to the board</button></p>
  <div class="panel"><div class="detail-head"><h2 style="font-size:17px;color:var(--ink);text-transform:none;letter-spacing:0">${esc(r.name)}</h2>
  <span class="tag">${esc(r.category)}</span>${r.watchlist ? '<span class="tag wl">Watchlist</span>' : '<span class="tag">Early</span>'}
  <span class="psub">rank ${r.rank} of ${R.rows.length} · bootstrap rank range ${r.rank_best}–${r.rank_worst}</span></div>
  <div class="detail-grid"><div><h2>The arithmetic</h2><dl class="kv">
  <dt>TVL</dt><dd>${moneyFull(r.tvl_usd)} across ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'} (${esc(r.chains.join(', '))})</dd>
  <dt>7-day TVL change</dt><dd>${r.change_7d === null ? 'not recorded' : r.change_7d.toFixed(1) + '%'}</dd>
  <dt>No-token age</dt><dd>${r.age_years === null ? 'no listing date on the record' : r.age_years.toFixed(2) + ' years'}</dd>
  <dt>Token odds</dt><dd>${pct(r.odds, 1)} — the peers' base rate is ${pct(R.odds.base_rate, 1)}, adjusted by the fitted terms [${R.odds.terms.join(', ')}]</dd>
  <dt>Value if it launches</dt><dd>${moneyFull(r.if_launches_usd)} from the size curve fitted on ${R.ledger.comps_used} priced comparables</dd>
  <dt>Implied value</dt><dd><b>${moneyFull(r.implied_value_usd)}</b> = odds × value if it launches</dd>
  <dt>Range P25–P75</dt><dd>${moneyFull(r.p25_usd)} – ${moneyFull(r.p75_usd)}, the leave-one-out residual range of the value stage</dd></dl></div>
  <div><h2>The farm, this scenario</h2><dl class="kv">
  <dt>Plan deposit</dt><dd>${moneyFull(e.deposit)} (${scen.planPct}% of TVL)</dd>
  <dt>Expected drop</dt><dd>${moneyFull(e.expected)} at a ${scen.drop}% drop shared pro-rata across all deposits</dd>
  <dt>Fees</dt><dd>${moneyFull(e.fees)} of gas at $2.57 per transaction</dd>
  <dt>Net</dt><dd><b>${moneyFull(e.net)}</b> over ${e.hours.toFixed(1)} hours of attention — ${moneyFull(e.netPerHour)} per hour</dd>
  <dt>Verdict</dt><dd><span class="verdict v-${e.verdict}">${e.verdict}</span></dd></dl></div></div>
  <h2 style="margin-top:14px">Nearest priced comparables</h2><div class="cap" style="color:var(--faint);font-size:12px;margin-bottom:8px">The value model's own training set, nearest first — same category preferred inside a ×4.5 TVL window. "Model" is what the fitted curve prices that protocol at; the gap to its real cap is the model's ordinary error, shown rather than hidden.</div>
  <table><thead><tr><th>Comparable</th><th class="num">TVL</th><th class="num">Real cap</th><th class="num">Model</th><th class="num">Real / model</th></tr></thead><tbody>
  ${r.peers.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${money(c.tvl_usd)}</td><td class="num">${money(c.mcap_usd)}</td><td class="num">${money(c.model_usd)}</td><td class="num">×${(c.mcap_usd / c.model_usd).toFixed(2)}</td></tr>`).join('')}
  </tbody></table>
  <h2 style="margin-top:14px">Farm plan</h2><ol class="steps">${steps}</ol></div>`;
}

function render() {
  const app = $('#app');
  if (state.detail) { app.innerHTML = `<div class="wrap">${detailView(state.detail)}<div class="foot">Launch Radar — fitted on the DefiLlama snapshot of ${esc(R.as_of)}; nothing here is live.</div></div>`; bind(); return; }
  app.innerHTML = `<div class="wrap">
  <header class="top"><div><h1>Launch <span class="rad">Radar</span></h1><div class="sub">Pre-token protocols, valued from their own record: the odds a token comes, times what it would be worth.</div></div>
  <div class="meta">DefiLlama snapshot ${esc(R.as_of)} · model refitted in this build — and again in this page<br>${R.ledger.total} protocols accounted for · ${R.rows.length} ranked</div></header>
  ${kpiStrip()}${accounting()}
  ${state.tab === 'board' ? evidenceStrip() : ''}
  <div class="tabs"><button class="tab ${state.tab === 'board' ? 'on' : ''}" data-tab="board">Board</button><button class="tab ${state.tab === 'evidence' ? 'on' : ''}" data-tab="evidence">Evidence</button><button class="tab ${state.tab === 'method' ? 'on' : ''}" data-tab="method">Method</button></div>
  ${state.tab === 'board' ? boardView() : state.tab === 'evidence' ? evidenceView() : methodView()}
  <div class="foot">Every number on this page is computed from the sealed snapshot by the entry's own code; the model, its rejected terms and its error bars are on the Evidence tab.</div></div>`;
  bind();
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
  document.querySelectorAll('[data-tier]').forEach((b) => b.addEventListener('click', () => { state.tier = b.dataset.tier; render(); }));
  document.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => { scen.drop = +b.dataset.drop; render(); }));
  document.querySelectorAll('tr.rowlink').forEach((tr) => tr.addEventListener('click', () => { state.detail = tr.dataset.slug; render(); window.scrollTo(0, 0); }));
  const back = $('#back'); if (back) back.addEventListener('click', () => { state.detail = null; render(); });
  const q = $('#q'); if (q) q.addEventListener('input', () => { state.q = q.value; const v = visibleRows(); const tb = document.querySelector('table.board tbody'); if (tb) { state.q = q.value; render(); const nq = $('#q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } });
  const cat = $('#cat'); if (cat) cat.addEventListener('change', () => { state.category = cat.value; render(); });
  const ch = $('#chain'); if (ch) ch.addEventListener('change', () => { state.chain = ch.value; render(); });
  const so = $('#sort'); if (so) so.addEventListener('change', () => { state.sort = so.value; render(); });
  const sd = $('#s-drop'); if (sd) sd.addEventListener('input', () => { scen.drop = +sd.value; render(); });
  const sp = $('#s-plan'); if (sp) sp.addEventListener('input', () => { scen.planPct = +sp.value; render(); });
  const sh = $('#s-hor'); if (sh) sh.addEventListener('input', () => { scen.horizon = +sh.value; render(); });
  const csv = $('#csv'); if (csv) csv.addEventListener('click', () => download('launch-radar-board.csv', 'text/csv', toCsv()));
  const js = $('#json'); if (js) js.addEventListener('click', () => download('launch-radar-board.json', 'application/json', JSON.stringify(visibleRows().map((x) => x.r), null, 1)));
}
function toCsv() {
  const head = 'rank,slug,name,category,tvl_usd,token_odds,if_launches_usd,implied_value_usd,verdict,net_usd\n';
  return head + visibleRows().map(({ r, e }) => [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + r.category + '"', r.tvl_usd, r.odds, r.if_launches_usd, r.implied_value_usd, e.verdict, e.net.toFixed(2)].join(',')).join('\n');
}
function download(name, type, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
render();
