# Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yuusuke06/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yuusuke06/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar, built for make.fun's [token-radar-01](https://make.fun/c/token-radar-01) bounty.

It reads one sealed DefiLlama snapshot (758 protocols, TVL at or above $5M, as of 2026-11-14),
finds the protocols that record no token yet, and ranks 200 of them by implied launch value.
Every ranked row carries a farm plan with stated costs and times, and the whole board is
rendered as a static dashboard with a per-protocol detail view and an evidence tab that shows
the model's held-out tests, including the terms that failed them.

**v5** changes no number on the board. It fixes the build's clock and the page's face:
the calibration court now computes its ten fold fits once instead of 465 times (the same
fits, shared — build time 113s → 10s, every printed figure byte-identical), and the
dashboard leads with a spotlight card for rank 1, a verified-checks band, sticky table
headers and rank badges, so the first screen says what the board found before it says
how it knows.

**v4** keeps the same model and removes the last reason to trust the build: the raw
snapshot ships with the dashboard, and on load the page refits both stages itself, in the
reader's browser, and diffs its own board against the build's — 200 of 200 ranks
identical, largest implied drift 0.003% (whole-dollar rounding). It also adds a time-split
rank-stability check: both stages refitted on the past only still put 33 of the top 40 in
the top 40, with the same rank 1.

**v3** keeps the v2 model — it survived its own tests — and deepens the evidence around it:
out-of-fold calibration of the odds, split-half range honesty (older vs newer tokens), a
board seal the page recomputes and compares with the build's, the nearest priced comparables
on every detail view, and three more refused terms, among them the ridge category effect
several rivals ship and a placebo control in each stage.

## The model

Implied value is a product of two fitted stages. Nothing is hand-priced and no protocol name
is special-cased; both stages are fitted on the snapshot itself at run time.

**Stage 1 — token odds.** A regularised logistic fit on the 465 protocols that are not
wrapped, staked, bridged or exchange products, where the outcome (a token symbol or Gecko id
on the record) is known for every peer. Kept terms: ln(TVL), ln(1 + age), 7-day TVL growth
and protocol family. Ten-fold Brier 0.195 against 0.247 for the base rate; a time split
(fit before 2025, score the rest) gives 0.230 against 0.373.

**Stage 2 — value if it launches.** A log-log fit on the 119 priced, non-exchange
comparables: a size curve in ln(TVL) plus an age term. Leave-one-out median miss ×3.25 and
walk-forward ×3.04, against ×4.88 for the snapshot's flat median multiple of 0.246×.

**The court every term faces.** Each candidate term is kept only if it lowers the held-out
error in both of its stage's tests. Rejected, and printed on the dashboard's evidence tab:
chain count (odds), family and category multipliers (value), and growth (value). v3 put
three more in the dock: a ridge-shrunk category effect (walk-forward ×2.38 but leave-one-out
×3.44 — one test is not enough) and a placebo control in each stage, the next protocol's
numbers, which must not help and did not. Listing
dates are missing for 113 of the 758 protocols; those rows enter the fits with the dated
rows' median age, and the time-based tests run on dated rows only.

**Ranges.** Each row's P25–P75 is the value range implied by the value stage's leave-one-out
residuals — 51% of held-out caps fell inside the stated 50% range, 82% inside the stated 80%
range. Rank ranges are interquartile ranks over 150 bootstrap refits of the value stage.

**Farm economics.** Under the page's default scenario the drop is 5% of implied value shared
pro-rata across all deposits, the plan deposit is 0.02% of TVL (min $500, max $100,000), and
gas at $2.57 per transaction is the only cost charged. Verdicts: FARM 20, MARGINAL 156,
SKIP 24 — the FARM bar stands at net ≥ $100 and ≥ $15 per hour of attention (raised in
v8; see the changelog) — and they move with the scenario sliders, which re-derive every verdict live.

## Where each claim is checked

| Claim on the page | Checked by |
|---|---|
| Board ranks, implied values, totals | the page itself, recomputed from `data.js` on every load (checks line) |
| The board is the model's board | the page's own refit from the raw snapshot (`dashboard/refit.js`): both stages refitted in the browser, ranks diffed |
| Calibration bins | the same in-page refit: ten fold fits, out-of-fold scores, bins compared |
| Rank ranges (150 bootstrap refits) | the same in-page refit, with the build's seeded generator |
| Time-split stability counts | the same in-page refit: both stages refitted on the past only |
| The build agrees with itself | a second, independent implementation inside the build (`lib/audit.ts`); the build refuses to ship on any rank disagreement |
| Ledger, watchlist coverage, board rules, seal | `node verify/verify-build.mjs <dossier-dir>` — fresh code, shipped artifacts only, 22 checks |
| The build fits its time budget, deterministically | the build's clock prints to its log (v4 was rejected at ~113s of 120s; the fixed build runs in ~10s), the dossier carries no run-varying field (v5 was rejected for carrying one), and the build constructs the radar twice per run and refuses to ship if the two dossiers differ |
| The court's four headline scores | the build's second path (`auditCourt` in `lib/audit.ts`) re-derives the kept terms' ten-fold Brier, time split, leave-one-out and walk-forward; the build refuses to ship past a 0.01 disagreement |
| The whole court, the ridge grid and the verdict sweep | `node tools/court-report.mjs --input <snapshot>` and `node tools/verdict-sweep.mjs --input <snapshot>` — standalone re-implementations that print every figure and exit non-zero on disagreement (VERIFICATION.md §13) |
| Term selection (the ablation trials themselves) | not re-derived — the full tables are printed on the Evidence tab, and the snapshot ships with the page for anyone to re-run them |

## Running it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. The run writes `board.json` (the ranked board),
`data.js` (the same board for the page), the dashboard, the screenshots and `dossier.json`.
Open `out/dashboard/index.html` for the board; `?shot=evidence`,
`?shot=detail&slug=steakhouse-financial` and `?shot=watchlist` select the other handed-in views.
