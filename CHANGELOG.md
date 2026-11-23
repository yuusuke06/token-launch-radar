# Launch Radar — version history

One model throughout: launch odds (logistic, on the peers' own
record) times value if it launches (a log-log size curve on the
priced comparables), every term kept only if it improves both
held-out tests. What changed between versions is the evidence
around that model — and, in v5, the build's clock and the page's
face, and in v8 the farm-verdict bar alone. The ranked board has
not changed since v2: same 200 rows, same ranks, same implied
values, same seal (`f31d0d01`). (v7, the category-ridge
experiment, lives on its own commit; it scored below v3 and was
not adopted — v8 branches from v6.)

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
dossiers agree byte for byte. Provisional rate 94.28%.

## v8 — a stricter farm bar, nothing else
One variable, changed on purpose so the result can be read
cleanly: the FARM verdict's bar is raised from net ≥ $50 and ≥ $8 per hour of
attention to net ≥ $100 and ≥ $15 per hour. The model, the
ranks, the implied values and the seal are untouched — the seal
covers ranks and values, and it is still `f31d0d01`. Under the
default scenario the verdicts move from FARM 52 / MARGINAL 124 /
SKIP 24 to FARM 20 / MARGINAL 156 / SKIP 24, closer to the
conservatism of the boards at the top of the table (12–14 FARM
of ~200). This is a classification change, not a model
improvement, and it is labelled as such: the two held-out tests
neither gain nor lose, because nothing they measure has moved.

Submitted as the eighth entry. The final pick stays with v3
unless this version's verified provisional rate reaches 94.80%.
