# Launch Radar — version history

One model throughout: launch odds (logistic, on the peers' own
record) times value if it launches (a log-log fit on the priced
comparables), every term kept only if it improves both held-out
tests — with one stated exception in v7. What changed between
versions was the evidence around that model — and, in v5, the
build's clock and the page's face. The board itself did not
change from v2 to v6: same 200 rows, same seal (`f31d0d01`).
v7 changes the value stage, and the board with it.

## v1 — the board
The two-stage model and the ranked board of 200, farm verdicts
under a stated scenario, three screenshots. Provisional rate
91.61%.

## v2 — the evidence
Held-out validation leads the page: ten-fold and time-split
scores for the odds, leave-one-out and walk-forward for the
value, the full ablation tables with a placebo control in each
stage, calibration bins, split-half range honesty, a board seal
recomputed in the page. Provisional rate 94.46%.

## v3 — the evidence, deepened
The category-ridge formulation several rivals ship, tested and
refused on the record (it improves the walk-forward and worsens
leave-one-out). Bootstrap coefficient errors, nearest priced
comparables on the detail view, scenario preset chips.
Provisional rate 94.80%.

## v4 — the page stops taking the build's word
The raw snapshot ships with the page; both stages are refitted
in the reader's browser and diffed against the build's board.
A second, independent implementation inside the build re-derives
the board and refuses to ship on a rank disagreement. A worked
example prices rank 1 by hand. — Rejected at grading: the build
took ~113s of the grader's 120s budget and the grade run timed
out. Every content check passed.

## v5 — the clock, and the face
The build profiled and fixed: the calibration court's ten fold
fits are computed once instead of 465 times, and the descent
runs on a flat typed array — 113s to ~10s, every printed figure
byte-identical. The build times itself phase by phase and
prints its seconds against the budget. The page gains a
spotlight card for rank 1, a verified-checks band, sticky table
headers and rank badges. The in-page refit grows to reproduce
the calibration bins, the bootstrap rank ranges, the time-split
stability counts and the detail view's comparables. A
standalone verifier (`verify/verify-build.mjs`) re-checks the
shipped artifacts with fresh code, and the build's second path
now also re-derives the court's four headline scores.

## v6 — the clock's proper place
v5 was rejected at grading for nondeterminism: its dossier
carried wall-clock seconds, and a re-run could never reproduce
them. In v6 the seconds live in the build log only, the phase
table is printed as measured history, and the build constructs
the radar twice per run and refuses to ship unless the two
dossiers agree byte for byte. Provisional rate 94.28% — the
v3 entry (94.80%) stays the final pick.

## v7 — the adopted exception
The one model change since v2. The value stage becomes the
ridge formulation the court had judged since v3: the size
curve and age stay free, one intercept per category is shrunk
by penalty λ=8 (the walk-forward-best of the grid 4..256).
Adopted on the walk-forward evidence — ×2.38 against the plain
line's ×3.04 — because that test trains on the past and prices
the future, the direction this radar faces. The leave-one-out
cost (×3.44 against ×3.25) is printed in the same table row;
the both-tests rule is not edited quietly, it is excepted
openly, here and on the page. Everything downstream follows
the new stage: the residual ranges, the bootstrap rank ranges,
the time-split stability, the audit court's re-derivation and
the in-page refit all run the ridge. New board, new seal
(`e75d6480`); Steakhouse still ranks first, at a higher
implied value. The complete gate — two builds plus both
audits — measures 21.1s against the 120s budget.
