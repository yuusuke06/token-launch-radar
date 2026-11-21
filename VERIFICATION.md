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

The build runs the same double-entry check on itself before
anything is written: `lib/audit.ts` re-derives the board from the
snapshot by a second, independent implementation of the rules, and
`main.ts` refuses to produce a dossier when the two paths disagree
on a single rank. The page's refit is the third implementation of
the same rules; the three are kept honest by being compared, not
by being trusted.

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

## 7. A worked example: rank 1 by hand

Every number on the board can be recomputed from the printed
coefficients. Rank 1, Steakhouse Financial, with nothing but the
snapshot row and a pocket calculator:

Snapshot row: TVL $2,753,981,495 · listed 2025-05-20 (1.487 years
before the snapshot) · 7-day change −2.19% · category Risk
Curators (family: Curators).

Launch odds (logistic; weights in feature order — intercept, size,
age, growth, then the family effects):

    size    = (ln 2,753,981,495 − 17) / 2 = 2.368
    age     = ln(1 + 1.487) − 1.5         = −0.589
    growth  = −2.19% / 10                 = −0.219
    z = 0.612 + 0.509×2.368 + 1.312×(−0.589)
              − 0.466×(−0.219) − 1.116   (Curators)
      = 0.030
    odds = 1 / (1 + e^−z) = 50.8%   → the board prints 51%

Value if it launches (OLS on log market cap; intercept, size
curve, age):

    ln value = 8.820 + 0.456×21.736 − 0.601×0.911 = 18.182
    value = e^18.182 ≈ $79.3M       → the board prints $79.3M

Implied value:

    0.508 × $79.3M ≈ $40.3M         → the board prints $40.3M

The other 199 rows are the same arithmetic with their own rows of
the snapshot. The coefficients themselves are printed in the data
file the page ships (`odds.weights`, `value.beta`), so this
example can be re-derived from the entry alone — and §4's refit
recomputes all 200 rows, not just this one, on every page load.

## 8. Reproducing the build

    node main.ts --input <path to the kit's snapshot.json>

`main.ts` (Node 22, standard library only) parses the sealed
snapshot, classifies the ledger, runs the ablation court, fits the
two stages, and writes `board.json`, `data.js`, `snapshot.js`, the
dashboard and `dossier.json` into the output directory. There is
no randomness anywhere in the build: the one resampling procedure
(the bootstrap behind the rank ranges) runs on a seeded generator
with a fixed seed, so two runs of the same snapshot produce the
same board, the same seal, and the same dossier, byte for byte in
every field that reaches the page.
