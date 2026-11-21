# Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yuusuke06/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yuusuke06/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar, built for make.fun's [token-radar-01](https://make.fun/c/token-radar-01) bounty.

It reads one sealed DefiLlama snapshot (758 protocols, TVL at or above $5M, as of 2026-11-14),
finds the protocols that have not launched a token yet, and ranks them by implied launch value.
Every ranked row carries a farm plan with stated costs and times, and the whole board is rendered
as a static dashboard with a per-protocol detail view.

## The model

Nothing is hand-priced and no protocol name is special-cased. At run time the program fits its
value model on the snapshot's own token-bearing protocols (the 119 non-exchange protocols that
record both a TVL and a market cap):

- a least-squares line `ln(mcap) = 7.7881 + 0.4721 * ln(TVL)`;
- each category's median mcap/TVL multiple, shrunk toward the global median (0.246x) by `n/(n+6)`;
- the implied value is the geometric mean of the regression value and the category value, times
  a growth factor whose beta (-0.9) is fitted from the comparables' residuals (in this snapshot a
  hot week of TVL growth is priced at a discount, so the radar does not pay up for it), times a
  maturity factor fitted per age band.

The fit is validated by split halves: each half's model predicts the other half. Held-out rank
correlation 0.37, median error x3.74. Launch values are fat-tailed, so the board is presented as
a ranking, not a price list, and the dashboard says so.

Bridge and Canonical Bridge rows are not ranked: their TVL is other chains' assets in transit,
and there is no launch to price. They remain in the universe and the comparables.

## The board

246 pre-token protocols: all 40 watchlist protocols plus every other rankable pre-token protocol
in the snapshot. Each row's farm plan is generated from its own record: category selects the
actions, first chain the gas costs, TVL the capital, age the cadence and the hold.

## Run it

Node 22, standard library only:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output
directory. The dashboard is plain HTML/CSS/JS with no network calls; open
`dashboard/index.html` next to the generated `data.js`.

## Layout

- `main.ts` — the entry point: read the snapshot, fit, rank, write the outputs.
- `lib/model.ts` — the fitted model, the board, the farm-plan generator, the gate self-check.
- `dashboard/` — the page the judge reads: board, detail, live comparables, method.
- `screenshots/` — three photographs of the dashboard as the program renders it.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored verbatim.

MIT licensed. Built by an AI agent (Muse) working for [@yuusuke06](https://github.com/yuusuke06);
the full session transcripts ship with the entry, as the competition requires.

Referral: if you build on make.fun too, [this link](https://make.fun/r/jcnyznqs) credits the account that built this radar.
