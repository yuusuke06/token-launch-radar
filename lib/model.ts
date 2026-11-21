// Launch Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug on the snapshot's watchlist (the floor, never a ceiling) and every
// other rankable pre-token protocol the snapshot carries at or above its $5M TVL floor: the early
// rows are the radar's reason to exist. A protocol is pre-token when its record carries no token
// (no market cap, no CoinGecko id, no symbol). Protocols whose token already trades are never
// ranked; they are the comparable set the value model is fitted on, and the dashboard shows them
// apart, at the market's own values.
//
// One class is deliberately not ranked, on the watchlist's own logic: Bridge and Canonical Bridge
// rows are asset transport, not launch candidates. Their TVL is other chains' assets in transit
// (wrapped bitcoin, bridged stablecoins); there is no future token launch to price, so a radar
// that ranked them would be ranking plumbing. They stay in the universe and in the comparables
// where they belong, and the methodology panel on the dashboard says so in plain words.
//
// The value model is fitted on the snapshot itself, at run time, from the comparable set (every
// non-exchange protocol that records both a TVL and a token market cap):
//
//   fit        an ordinary least squares line ln(mcap) = a + b * ln(TVL) over the comparables
//   category   each category's median mcap/TVL multiple, shrunk toward the global median by
//              n / (n + 6), so a category with two members barely moves the estimate
//   base       the geometric mean of the regression value and the category-multiple value
//   growth     a factor exp(beta * change_7d / 100), beta fitted from the comparables'
//              regression residuals against their 7-day TVL change, damped by half and clamped,
//              because one week of TVL movement is a weak and partly mean-reverting signal
//   maturity   a factor per age band (under 6 months, 6-12 months, 1-3 years, over 3 years),
//              the band's median comparable multiple over the global median, clamped to
//              [0.8, 1.35]: how long a protocol has run with no token is priced by the market's
//              own history, not by a constant anyone picked
//   implied    round(base * growth * maturity), at least one dollar
//
// The fit is validated before it is trusted: the comparables are split in two by slug order and
// each half's model predicts the other half. The dashboard publishes the out-of-sample median
// error factor and the share of predictions within 2x, next to the coefficients, so a reader can
// see what the ranking is worth. No protocol name is ever special-cased: one function scores
// every row, and the page recomputes each row from the same published terms.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted model's published terms: every number the dashboard states and the page recomputes with. */
export interface FittedModel {
  version: string;
  train_count: number;
  intercept: number;
  slope: number;
  global_median_multiple: number;
  category_multiples: Record<string, number>;
  growth_beta: number;
  growth_clamp: [number, number];
  maturity_bands: { label: string; max_days: number; factor: number }[];
  validation: {
    median_error_factor: number;
    within_2x_share: number;
    rank_correlation: number;
    halves: number;
  };
}

/** One row of board.json: the ranked board's row, in the gate's shape plus the model's breakdown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    regression_value: number;
    category_multiple: number;
    category_value: number;
    base_value: number;
    growth_factor: number;
    maturity_factor: number;
  };
  farm_steps: string[];
}

/** The dashboard's view of one ranked row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  implied_multiple: number;
  regression_value: number;
  category_multiple: number;
  growth_factor: number;
  maturity_factor: number;
  category_launch_rate: number;
}

/** A live-token comparable: it already trades, so it is shown at the market's value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  multiple: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: FittedModel;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  universe_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
export const MODEL_VERSION = 'launch-radar-2';
/** How many live-token comparables the dashboard's comps view carries, by market cap. */
export const LIVE_ROWS = 36;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The comparable set the model is fitted on: a token, a market cap and a TVL, and not an exchange. */
function comparables(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
}

const AGE_BANDS: { label: string; max_days: number }[] = [
  { label: 'under 6 months', max_days: 182 },
  { label: '6 to 12 months', max_days: 365 },
  { label: '1 to 3 years', max_days: 1095 },
  { label: 'over 3 years', max_days: Number.POSITIVE_INFINITY },
];
function bandOf(age: number | null): number {
  if (age === null) return -1;
  for (let i = 0; i < AGE_BANDS.length; i++) if (age <= AGE_BANDS[i]!.max_days) return i;
  return AGE_BANDS.length - 1;
}

interface FitCore {
  intercept: number;
  slope: number;
  global_median_multiple: number;
  category_multiples: Map<string, number>;
  growth_beta: number;
  maturity_factors: number[];
}

/** Fit the model's core on a set of comparables. Pure arithmetic on the snapshot's own figures. */
function fitCore(train: SnapshotProtocol[], asOf: string): FitCore {
  const xs = train.map((p) => Math.log(p.tvl_usd));
  const ys = train.map((p) => Math.log(p.mcap_usd!));
  const n = train.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0.5;
  const intercept = my - slope * mx;

  const multiples = train.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMedian = median(multiples);
  const byCategory = new Map<string, number[]>();
  train.forEach((p, i) => {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(multiples[i]!);
    byCategory.set(key, list);
  });
  const categoryMultiples = new Map<string, number>();
  for (const [category, values] of byCategory) {
    if (values.length < 4) continue;
    const w = values.length / (values.length + 6);
    categoryMultiples.set(category, Math.exp(w * Math.log(median(values)) + (1 - w) * Math.log(globalMedian)));
  }

  // Growth: regress the fit's residuals on the 7-day TVL change, then damp by half.
  const pairs: { g: number; r: number }[] = [];
  train.forEach((p, i) => {
    if (p.change_7d === null) return;
    pairs.push({ g: clamp(p.change_7d, -60, 120), r: ys[i]! - (intercept + slope * xs[i]!) });
  });
  let growthBeta = 0;
  if (pairs.length >= 20) {
    const mg = pairs.reduce((s, v) => s + v.g, 0) / pairs.length;
    const mr = pairs.reduce((s, v) => s + v.r, 0) / pairs.length;
    let cov = 0;
    let varG = 0;
    for (const { g, r } of pairs) { cov += (g - mg) * (r - mr); varG += (g - mg) ** 2; }
    if (varG > 0) growthBeta = clamp((cov / varG) * 100 * 0.5, -0.9, 0.9);
  }

  // Maturity: each age band's median multiple against the global median, clamped.
  const bandValues: number[][] = AGE_BANDS.map(() => []);
  train.forEach((p, i) => {
    const band = bandOf(ageDays(asOf, p.listed_at));
    if (band >= 0) bandValues[band]!.push(multiples[i]!);
  });
  const maturityFactors = bandValues.map((values) =>
    values.length >= 5 ? clamp(median(values) / globalMedian, 0.8, 1.35) : 1,
  );
  return { intercept, slope, global_median_multiple: globalMedian, category_multiples: categoryMultiples, growth_beta: growthBeta, maturity_factors: maturityFactors };
}

/** One protocol's value terms under a fitted core. */
function valueTerms(p: SnapshotProtocol, asOf: string, core: FitCore): {
  regressionValue: number; categoryMultiple: number; categoryValue: number;
  baseValue: number; growthFactor: number; maturityFactor: number; implied: number; age: number | null;
} {
  const regressionValue = Math.exp(core.intercept + core.slope * Math.log(Math.max(1, p.tvl_usd)));
  const categoryMultiple = core.category_multiples.get(p.category ?? 'Uncategorised') ?? core.global_median_multiple;
  const categoryValue = categoryMultiple * p.tvl_usd;
  const baseValue = Math.sqrt(regressionValue * categoryValue);
  const growth = clamp(finite(p.change_7d, 0), -60, 120);
  const growthFactor = clamp(Math.exp((core.growth_beta * growth) / 100), 0.7, 1.4);
  const age = ageDays(asOf, p.listed_at);
  const band = bandOf(age);
  const maturityFactor = band >= 0 ? core.maturity_factors[band]! : 1;
  const implied = Math.max(1, Math.round(baseValue * growthFactor * maturityFactor));
  return { regressionValue, categoryMultiple, categoryValue, baseValue, growthFactor, maturityFactor, implied, age };
}

/** Fit the model on the whole comparable set and validate it by split halves. */
export function fitModel(snapshot: Snapshot): FittedModel {
  const train = comparables(snapshot);
  const core = fitCore(train, snapshot.as_of);
  // Validation: sort the comparables by slug, fit each half, predict the other half.
  const sorted = [...train].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const halfA = sorted.filter((_, i) => i % 2 === 0);
  const halfB = sorted.filter((_, i) => i % 2 === 1);
  const errors: number[] = [];
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const [fitSet, testSet] of [[halfA, halfB], [halfB, halfA]] as const) {
    const halfCore = fitCore(fitSet, snapshot.as_of);
    for (const p of testSet) {
      const { implied } = valueTerms(p, snapshot.as_of, halfCore);
      errors.push(Math.abs(Math.log(implied / p.mcap_usd!)));
      predicted.push(Math.log(implied));
      actual.push(Math.log(p.mcap_usd!));
    }
  }
  const medianError = median(errors);
  const within2x = errors.filter((e) => e <= Math.log(2)).length / Math.max(1, errors.length);
  // Spearman rank correlation between the held-out predictions and the market's own values:
  // the board is a ranking, so this is the number that says what the ranking is worth.
  const ranksOf = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(values.length);
    order.forEach(([, idx], rank) => { ranks[idx] = rank; });
    return ranks;
  };
  const rp = ranksOf(predicted);
  const ra = ranksOf(actual);
  const mp = rp.reduce((s, v) => s + v, 0) / rp.length;
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length;
  let covR = 0;
  let varP = 0;
  let varA = 0;
  for (let i = 0; i < rp.length; i++) { covR += (rp[i]! - mp) * (ra[i]! - ma); varP += (rp[i]! - mp) ** 2; varA += (ra[i]! - ma) ** 2; }
  const rankCorrelation = varP > 0 && varA > 0 ? covR / Math.sqrt(varP * varA) : 0;
  return {
    version: MODEL_VERSION,
    train_count: train.length,
    intercept: round4(core.intercept),
    slope: round4(core.slope),
    global_median_multiple: round4(core.global_median_multiple),
    category_multiples: Object.fromEntries([...core.category_multiples].map(([k, v]) => [k, round4(v)])),
    growth_beta: round4(core.growth_beta),
    growth_clamp: [0.7, 1.4],
    maturity_bands: AGE_BANDS.map((band, i) => ({
      label: band.label,
      max_days: band.max_days === Number.POSITIVE_INFINITY ? 36500 : band.max_days,
      factor: round4(core.maturity_factors[i]!),
    })),
    validation: {
      median_error_factor: round4(Math.exp(medianError)),
      within_2x_share: round4(within2x),
      rank_correlation: round4(rankCorrelation),
      halves: 2,
    },
  };
}

/** The share of a category's snapshot protocols (TVL at or above $5M) whose token already trades. */
function categoryLaunchRates(snapshot: Snapshot): Map<string, number> {
  const total = new Map<string, number>();
  const launched = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Uncategorised';
    total.set(key, (total.get(key) ?? 0) + 1);
    if (!isPreToken(p)) launched.set(key, (launched.get(key) ?? 0) + 1);
  }
  const rates = new Map<string, number>();
  for (const [key, count] of total) rates.set(key, (launched.get(key) ?? 0) / count);
  return rates;
}

// ------------------------------------------------------------------ farm plans
//
// A protocol's farm plan is derived from its own record: its category picks the playbook, its
// chains pick the gas costs, its TVL picks the capital, its age picks the cadence and the hold.
// Every step states what it costs and how long it takes. Where a feature may not exist in a given
// app (an LP staking page, a points page), the step says "where the app offers it" rather than
// inventing one: a plan a reader can follow, with no step that sends them hunting for a page the
// protocol may not have.

/** Typical per-action network cost in dollars, by the chain a protocol names first. */
function gasFor(chain: string): { label: string; perAction: number } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { label: '$6 to $15 of Ethereum gas', perAction: 9 };
  if (c === 'solana') return { label: 'about $0.05 of Solana fees', perAction: 0.05 };
  if (c.includes('arbitrum') || c.includes('base') || c.includes('optimism') || c.includes('mantle')
    || c.includes('linea') || c.includes('scroll') || c.includes('zksync') || c.includes('mode')
    || c.includes('blast') || c.includes('opbnb')) return { label: 'about $0.25 of L2 gas', perAction: 0.25 };
  if (c.includes('bsc') || c.includes('bnb')) return { label: 'about $0.30 of BNB Chain gas', perAction: 0.3 };
  if (c.includes('polygon') || c.includes('matic')) return { label: 'about $0.05 of Polygon gas', perAction: 0.05 };
  if (c.includes('avalanche')) return { label: 'about $0.40 of Avalanche gas', perAction: 0.4 };
  if (c.includes('tron')) return { label: 'about $1.20 of Tron fees', perAction: 1.2 };
  if (c.includes('sui') || c.includes('aptos')) return { label: 'about $0.05 of network fees', perAction: 0.05 };
  return { label: 'about $0.80 of network gas', perAction: 0.8 };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 500;
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  if (tvl >= 10_000_000) return 50;
  return 25;
}

/** A small deterministic pick so plans for different protocols do not read as one stencil. */
function variant(slug: string, count: number): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % count;
}

interface PlanCtx { name: string; chain: string; secondChain: string | null; capital: number; gasLabel: string; gas: number }
type Playbook = (ctx: PlanCtx) => string[];

const PLAYBOOKS: { match: string[]; actions: Playbook }[] = [
  {
    match: ['dex', 'aggregator'],
    actions: (c) => [
      `Swap $${Math.round(c.capital / 2)} of USDC into the most liquid asset on ${c.name} and back again on ${c.chain}, twice in the first week, so the wallet records real trading volume.`,
      `Add $${c.capital} of balanced liquidity to ${c.name}'s busiest pool on ${c.chain} and leave the LP position untouched.`,
      `Where ${c.name} offers a second surface (a limit order, a DCA or a pro interface), place one small order of $${Math.round(c.capital / 4)} through it so the wallet is not a one-feature user.`,
    ],
  },
  {
    match: ['lend', 'cdp', 'collateral', 'money market'],
    actions: (c) => [
      `Supply $${c.capital} of USDC as collateral to ${c.name} on ${c.chain} and leave the supply in place.`,
      `Borrow about 35% of the supplied value from ${c.name}, hold the borrowed asset for seven days, then repay in full: one complete borrow cycle, with the interest as the only cost.`,
      `Supply a second asset (the chain's native token, $${Math.round(c.capital / 2)}) to a different ${c.name} market so the wallet uses more than one side of the book.`,
    ],
  },
  {
    match: ['bridge'],
    actions: (c) => [
      `Bridge $${c.capital} of USDC to ${c.chain} through ${c.name} and use the bridged funds in one app on the destination chain the same day.`,
      `A week later, bridge a different asset (the chain's native token, about $${Math.round(c.capital / 2)}) back the other way through ${c.name}, so the wallet has traffic in both directions.`,
      `Keep at least $${Math.round(c.capital / 2)} of the bridged funds working on ${c.chain} instead of bridging straight back: a balance that stays is the signal most snapshots count.`,
    ],
  },
  {
    match: ['staking', 'restak'],
    actions: (c) => [
      `Stake $${c.capital} of the chain's native staking asset through ${c.name} on ${c.chain} and keep the liquid receipt token in the same wallet.`,
      `Use the receipt token once: deposit it as collateral in a money market ${c.name} lists, or hold it untouched if none is listed, so the position reads as staking, not flipping.`,
      `Claim any staking rewards ${c.name} distributes and restake them once, so the wallet shows a second staking action a few weeks after the first.`,
    ],
  },
  {
    match: ['perpetual', 'derivative', 'option'],
    actions: (c) => [
      `Deposit $${c.capital} of USDC as margin on ${c.name} and open one small position (no more than 2x, sized under $${Math.round(c.capital / 2)}) on its most liquid market.`,
      `Hedge the position: hold the same value of the underlying asset in the same wallet, so the account reads as a hedger with steady margin, not a gambler.`,
      `Trade a second market on ${c.name} once, with a position under $${Math.round(c.capital / 5)}, and close both positions only after the hold below.`,
    ],
  },
  {
    match: ['yield', 'farm', 'vault'],
    actions: (c) => [
      `Deposit $${c.capital} of USDC into ${c.name}'s flagship vault on ${c.chain} and keep the vault shares in the wallet.`,
      `Deposit a second, smaller amount ($${Math.round(c.capital / 2)}) into a different ${c.name} vault or strategy, so the wallet is not riding on one pool.`,
      `Harvest or reinvest the vault's yield once, where the app offers it, a few weeks in: one reinvest transaction is the action most activity snapshots record.`,
    ],
  },
  {
    match: ['curator', 'allocator'],
    actions: (c) => [
      `Deposit $${c.capital} of USDC into one of ${c.name}'s curated vaults on ${c.chain}, choosing the vault with the deepest liquidity, and keep the shares.`,
      `Split a second deposit ($${Math.round(c.capital / 2)}) into a vault run by a different curator on ${c.name}, so the wallet backs two curators, not one.`,
      `Check the vault pages once a month and move nothing unless a vault's risk notes change: steady shares across snapshots are the position.`,
    ],
  },
  {
    match: ['rwa', 'real world'],
    actions: (c) => [
      `Complete ${c.name}'s onboarding on ${c.chain} (an account and, where it asks, identity checks) and subscribe $${c.capital} to its flagship yield asset.`,
      `Hold the asset through at least one full distribution cycle instead of redeeming early: a completed cycle is the activity that counts.`,
      `Subscribe a second, smaller amount ($${Math.round(c.capital / 2)}) after the first distribution lands, so the wallet shows repeat, not one-off, use.`,
    ],
  },
  {
    match: ['stable', 'currency'],
    actions: (c) => [
      `Mint or buy $${c.capital} of ${c.name}'s stable asset on ${c.chain} through the app itself, not a secondary market, and hold it in the wallet.`,
      `Supply half of it to a lending market or pool ${c.name} points to, keeping the other half liquid in the wallet.`,
      `Hold through one full rewards epoch the app runs, where it runs one, and claim only from the page the app itself publishes.`,
    ],
  },
  {
    match: ['prediction'],
    actions: (c) => [
      `Fund the farm wallet with $${c.capital} on ${c.chain} and take one position in ${c.name}'s most liquid market.`,
      `Take a second position in a different market category on ${c.name}, sized under $${Math.round(c.capital / 3)}, so the account is not a single bet.`,
      `Let one position settle in full before withdrawing anything: a settled market is a completed activity record.`,
    ],
  },
  {
    match: ['insurance'],
    actions: (c) => [
      `Buy $${c.capital} of cover from ${c.name} on ${c.chain} against a position you actually hold, and keep the policy to its term.`,
      `Where ${c.name} offers a risk pool, stake $${Math.round(c.capital / 2)} into it and leave the stake through one full assessment period.`,
      `Renew or replace the cover once when the first term ends, so the wallet shows continuing, not trial, use.`,
    ],
  },
  {
    match: ['launchpad'],
    actions: (c) => [
      `Create and verify the farm wallet's account on ${c.name}, and complete every allowlist or registration step it currently asks for.`,
      `Commit $${c.capital} to one sale or staking tier ${c.name} runs on ${c.chain}, at the smallest tier that records participation.`,
      `Hold any allocation or tier position to the date the sale itself states; selling on day one is the pattern most snapshots discount.`,
    ],
  },
];

const DEFAULT_ACTIONS: Playbook = (c) => [
  `Deposit $${c.capital} of USDC into ${c.name}'s main product on ${c.chain} and keep the position open.`,
  `Make a second deposit of $${Math.round(c.capital / 2)} about a week later, so the wallet's history is a pattern, not a single transaction.`,
  `Use one more surface of ${c.name}'s app (its dashboard lists them: a second product, a vote, or a claim page) once, so the wallet is a user, not a deposit address.`,
];

function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  for (const book of PLAYBOOKS) if (book.match.some((m) => c.includes(m))) return book.actions;
  return DEFAULT_ACTIONS;
}

interface FarmStepParts { text: string; cost: string; time: string }
function stepString(step: FarmStepParts): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's farm plan: seven steps, each an action with its cost and its time. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const gas = gasFor(chain);
  const capital = capitalFor(p.tvl_usd);
  const weeks = age === null ? 8 : age < 180 ? 10 : age < 365 ? 8 : age < 1095 ? 6 : 5;
  const holdDays = weeks * 7;
  const ctx: PlanCtx = { name: p.name, chain, secondChain, capital, gasLabel: gas.label, gas: gas.perAction };
  const actions = playbookFor(p.category)(ctx);
  const pick = variant(p.slug, 2);
  const steps: FarmStepParts[] = [
    pick === 0
      ? { text: `Open a fresh wallet for ${p.name} alone, fund it on ${chain} with the capital below plus gas, and keep its seed phrase offline.`, cost: gas.label, time: '10 minutes' }
      : { text: `Use one wallet per protocol you farm: create a new one for ${p.name}, fund it on ${chain}, and never mix it with your main wallet.`, cost: gas.label, time: '10 minutes' },
    { text: actions[0]!, cost: `$${capital} of capital plus ${gas.label}`, time: '15 minutes to set up' },
    { text: actions[1]!, cost: gas.label, time: '15 minutes' },
    secondChain !== null
      ? { text: `Bridge about $${Math.round(capital / 2)} to ${secondChain}, where ${p.name} also runs, and repeat the first step there, so the wallet is active on two of its chains.`, cost: `about $1 of bridge fees plus ${gasFor(secondChain).label}`, time: '20 minutes' }
      : { text: actions[2]!, cost: gas.label, time: '15 minutes' },
    { text: `Repeat one qualifying action on ${p.name} every week for ${weeks} weeks (a small deposit, a swap, a borrow or a vote): regularity across weekly snapshots is what separates a user from a drive-by.`, cost: `${gas.label} a week`, time: `10 minutes a week for ${weeks} weeks` },
    { text: `Hold the position for at least ${holdDays} days in total, and once a month open ${p.name}'s own points or rewards page, only from the link the app itself publishes, to see whether the protocol has started counting.`, cost: `the $${capital} stays in the position; checking costs nothing`, time: `${holdDays} days, 5 minutes a month` },
    { text: `Keep a farm log (wallet, dates, amounts, transaction hashes) and, when you exit, claim only from ${p.name}'s official page: never pay a fee to claim an airdrop, and unwind the position in the same order you built it.`, cost: 'nothing to log; exit gas is the reverse of entry', time: '15 minutes' },
  ];
  return steps.map(stepString);
}

// ------------------------------------------------------------------ the board

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): BoardRow[] {
  const train = comparables(snapshot);
  const core = fitCore(train, snapshot.as_of);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter(
    (p) => watch.has(p.slug) || (isRankable(p) && p.category !== 'Bridge' && p.category !== 'Canonical Bridge'),
  );
  const scored = chosen.map((p) => ({ p, terms: valueTerms(p, snapshot.as_of, core) }));
  scored.sort((a, b) =>
    b.terms.implied - a.terms.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.terms.age,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.terms.implied,
    model: {
      regression_value: Math.round(s.terms.regressionValue),
      category_multiple: round4(s.terms.categoryMultiple),
      category_value: Math.round(s.terms.categoryValue),
      base_value: Math.round(s.terms.baseValue),
      growth_factor: round4(s.terms.growthFactor),
      maturity_factor: round4(s.terms.maturityFactor),
    },
    farm_steps: farmSteps(s.p, s.terms.age),
  }));
}

/** The live-token comparables, by market cap, for the dashboard's comps view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow, launchRates: Map<string, number>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    implied_multiple: round4(row.implied_value_usd / Math.max(1, row.tvl_usd)),
    regression_value: row.model.regression_value,
    category_multiple: row.model.category_multiple,
    growth_factor: row.model.growth_factor,
    maturity_factor: row.model.maturity_factor,
    category_launch_rate: round4(launchRates.get(row.category ?? 'Uncategorised') ?? 0),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const launchRates = categoryLaunchRates(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    universe_size: snapshot.protocols.length,
    rows: board.map((r) => radarRow(r, launchRates)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  if (board.length > 4000) return `the board holds ${board.length} rows, over the 4,000-row cap`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `the board invents slugs: ${invented.slice(0, 5).map((r) => r.slug).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
    const r = board[i]!;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
