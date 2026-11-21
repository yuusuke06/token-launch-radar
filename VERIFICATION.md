# How this entry verifies itself

A ranked board is a claim. This document lists the claims Launch
Radar makes and the checks a reader can run — most of them inside
the page itself, without trusting the build, the author, or this
file.

## 1. The ledger adds up

The snapshot holds 758 protocols. Every one of them is accounted
for exactly once: 200 ranked on the board, 128 priced comparables,
288 with a token recorded but no usable market cap, and the rest in
named exclusion buckets (bridges, the liquid-staking family,
exchanges, wrapped/versioned house duplicates). The dashboard
recomputes the buckets from the shipped data and prints the total
in the checks line above the board; a protocol that fell out of the
accounting would change the printed number.

## 2. The board is internally consistent

Ranks run 1–200 with no gaps, implied values never rise as rank
falls, and the totals printed in the header equal the sums of the
rows. The page recomputes all of this from the data file on every
load and prints yes/no per check. These are weak checks — a board
can be consistent and wrong — which is why they are not the only
ones.

## 3. The seal ties the page to the build

The build hashes the board's canonical rows (slug, rank, implied
value; FNV-1a) and ships the hash with the data. The page recomputes
the hash from the rows it is displaying and prints both values. A
page whose rows were edited after the build — by anyone, for any
reason — shows a mismatch instead of a match.

## 4. The page refits the model (v4)

The strongest check. The raw snapshot ships with the dashboard, and
`dashboard/refit.js` re-runs both model stages in the reader's
browser: the ledger classification, the top-200 board set, the
logistic launch-odds fit (gradient descent, L2 λ=3, 3000
iterations) and the OLS value fit, using the same feature
definitions and the same order of operations as `lib/model.ts`. It
then diffs its own board against the build's and prints how many
ranks are identical and the largest relative drift in implied
value. On the shipped build: 200 of 200 ranks identical, largest
drift 0.003% — the residue of the build's whole-dollar rounding.

Two honest limits. The refit re-derives the board from the shipped
terms; it does not re-run the ablation court that chose those terms
(that evidence is printed, not re-executed — see §5). And if a
future model kept group multipliers in the value stage, the refit
would refuse to run and the checks line would say so, rather than
print a match it did not earn.

## 5. The model is held out, not just fitted

Every coefficient in the model survived two out-of-sample tests
run at build time: ten-fold cross-validation and a time split for
the odds stage, leave-one-out and a walk-forward split for the
value stage. Terms that failed either test — including a ridge
category effect of the kind several rival boards ship, and a
placebo control in each stage — are printed on the Evidence tab as
tested and refused, with their scores. The printed ranges are
calibrated on the same held-out residuals, and their coverage is
reported split by older and newer tokens, so a range that only
works on old tokens would be visible.

## 6. The board survives a time split (v4)

Both stages refitted on the past only — odds on peers listed
before 2025, value on the older half of the dated comparables —
still rank the same protocol first, keep 33 of the top 40 inside
the top 40, and move the median row 11 places. The head of the
board is a property of the record; the tail is not, and the
per-row rank ranges on the board say so.

## What is not verified

The snapshot itself. Everything above verifies that the board
follows from the snapshot by the stated rules; whether DefiLlama's
14 November 2026 pull describes the world is the snapshot's claim,
not this entry's, and the kit seals it for every entrant alike.
The farm economics are likewise stated assumptions with their
arithmetic exposed, not measurements: change the drop share or the
plan size and the verdicts move, in the open, on the page.
