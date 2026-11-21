// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts, from the
// same board board.json carries) and renders three views: the ranked board, one protocol's detail
// (the model's arithmetic for that row, and its farm plan), and the live-token comparables the
// model was fitted on, plus a method view that states the fit and its out-of-sample validation.
// No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var M = DATA.model;
  var state = { q: '', category: 'all', chain: 'all', watchOnly: false, tab: 'board', sort: 'implied', dir: -1, selected: null };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtX(n) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : n.toFixed(2) + 'x'; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes into board.json, ported line for line:
  // the category picks the playbook, the first chain picks the gas, the TVL picks the capital,
  // the age picks the cadence and the hold. Where a feature may not exist in a given app, the
  // step says "where the app offers it" instead of inventing one.
  function gasFor(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return { label: '$6 to $15 of Ethereum gas', perAction: 9 };
    if (c === 'solana') return { label: 'about $0.05 of Solana fees', perAction: 0.05 };
    if (c.indexOf('arbitrum') >= 0 || c.indexOf('base') >= 0 || c.indexOf('optimism') >= 0 || c.indexOf('mantle') >= 0
      || c.indexOf('linea') >= 0 || c.indexOf('scroll') >= 0 || c.indexOf('zksync') >= 0 || c.indexOf('mode') >= 0
      || c.indexOf('blast') >= 0 || c.indexOf('opbnb') >= 0) return { label: 'about $0.25 of L2 gas', perAction: 0.25 };
    if (c.indexOf('bsc') >= 0 || c.indexOf('bnb') >= 0) return { label: 'about $0.30 of BNB Chain gas', perAction: 0.3 };
    if (c.indexOf('polygon') >= 0 || c.indexOf('matic') >= 0) return { label: 'about $0.05 of Polygon gas', perAction: 0.05 };
    if (c.indexOf('avalanche') >= 0) return { label: 'about $0.40 of Avalanche gas', perAction: 0.4 };
    if (c.indexOf('tron') >= 0) return { label: 'about $1.20 of Tron fees', perAction: 1.2 };
    if (c.indexOf('sui') >= 0 || c.indexOf('aptos') >= 0) return { label: 'about $0.05 of network fees', perAction: 0.05 };
    return { label: 'about $0.80 of network gas', perAction: 0.8 };
  }
  function capitalFor(tvl) {
    if (tvl >= 5e9) return 500;
    if (tvl >= 1e9) return 250;
    if (tvl >= 2.5e8) return 150;
    if (tvl >= 5e7) return 100;
    if (tvl >= 1e7) return 50;
    return 25;
  }
  function variant(slug, count) {
    var h = 0;
    for (var i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
    return h % count;
  }
  function playbookFor(category) {
    var c = (category || '').toLowerCase();
    function has() { for (var i = 0; i < arguments.length; i++) if (c.indexOf(arguments[i]) >= 0) return true; return false; }
    if (has('dex', 'aggregator')) return function (x) { return [
      'Swap $' + Math.round(x.capital / 2) + ' of USDC into the most liquid asset on ' + x.name + ' and back again on ' + x.chain + ', twice in the first week, so the wallet records real trading volume.',
      'Add $' + x.capital + " of balanced liquidity to " + x.name + "'s busiest pool on " + x.chain + ' and leave the LP position untouched.',
      'Where ' + x.name + ' offers a second surface (a limit order, a DCA or a pro interface), place one small order of $' + Math.round(x.capital / 4) + ' through it so the wallet is not a one-feature user.']; };
    if (has('lend', 'cdp', 'collateral', 'money market')) return function (x) { return [
      'Supply $' + x.capital + ' of USDC as collateral to ' + x.name + ' on ' + x.chain + ' and leave the supply in place.',
      'Borrow about 35% of the supplied value from ' + x.name + ', hold the borrowed asset for seven days, then repay in full: one complete borrow cycle, with the interest as the only cost.',
      "Supply a second asset (the chain's native token, $" + Math.round(x.capital / 2) + ') to a different ' + x.name + ' market so the wallet uses more than one side of the book.']; };
    if (has('bridge')) return function (x) { return [
      'Bridge $' + x.capital + ' of USDC to ' + x.chain + ' through ' + x.name + ' and use the bridged funds in one app on the destination chain the same day.',
      'A week later, bridge a different asset (the chain\'s native token, about $' + Math.round(x.capital / 2) + ') back the other way through ' + x.name + ', so the wallet has traffic in both directions.',
      'Keep at least $' + Math.round(x.capital / 2) + ' of the bridged funds working on ' + x.chain + ' instead of bridging straight back: a balance that stays is the signal most snapshots count.']; };
    if (has('staking', 'restak')) return function (x) { return [
      'Stake $' + x.capital + " of the chain's native staking asset through " + x.name + ' on ' + x.chain + ' and keep the liquid receipt token in the same wallet.',
      'Use the receipt token once: deposit it as collateral in a money market ' + x.name + ' lists, or hold it untouched if none is listed, so the position reads as staking, not flipping.',
      'Claim any staking rewards ' + x.name + ' distributes and restake them once, so the wallet shows a second staking action a few weeks after the first.']; };
    if (has('perpetual', 'derivative', 'option')) return function (x) { return [
      'Deposit $' + x.capital + ' of USDC as margin on ' + x.name + ' and open one small position (no more than 2x, sized under $' + Math.round(x.capital / 2) + ') on its most liquid market.',
      'Hedge the position: hold the same value of the underlying asset in the same wallet, so the account reads as a hedger with steady margin, not a gambler.',
      'Trade a second market on ' + x.name + ' once, with a position under $' + Math.round(x.capital / 5) + ', and close both positions only after the hold below.']; };
    if (has('yield', 'farm', 'vault')) return function (x) { return [
      'Deposit $' + x.capital + " of USDC into " + x.name + "'s flagship vault on " + x.chain + ' and keep the vault shares in the wallet.',
      'Deposit a second, smaller amount ($' + Math.round(x.capital / 2) + ') into a different ' + x.name + ' vault or strategy, so the wallet is not riding on one pool.',
      "Harvest or reinvest the vault's yield once, where the app offers it, a few weeks in: one reinvest transaction is the action most activity snapshots record."]; };
    if (has('curator', 'allocator')) return function (x) { return [
      'Deposit $' + x.capital + " of USDC into one of " + x.name + "'s curated vaults on " + x.chain + ', choosing the vault with the deepest liquidity, and keep the shares.',
      'Split a second deposit ($' + Math.round(x.capital / 2) + ') into a vault run by a different curator on ' + x.name + ', so the wallet backs two curators, not one.',
      "Check the vault pages once a month and move nothing unless a vault's risk notes change: steady shares across snapshots are the position."]; };
    if (has('rwa', 'real world')) return function (x) { return [
      'Complete ' + x.name + "'s onboarding on " + x.chain + ' (an account and, where it asks, identity checks) and subscribe $' + x.capital + ' to its flagship yield asset.',
      'Hold the asset through at least one full distribution cycle instead of redeeming early: a completed cycle is the activity that counts.',
      'Subscribe a second, smaller amount ($' + Math.round(x.capital / 2) + ') after the first distribution lands, so the wallet shows repeat, not one-off, use.']; };
    if (has('stable', 'currency')) return function (x) { return [
      'Mint or buy $' + x.capital + ' of ' + x.name + "'s stable asset on " + x.chain + ' through the app itself, not a secondary market, and hold it in the wallet.',
      'Supply half of it to a lending market or pool ' + x.name + ' points to, keeping the other half liquid in the wallet.',
      'Hold through one full rewards epoch the app runs, where it runs one, and claim only from the page the app itself publishes.']; };
    if (has('prediction')) return function (x) { return [
      'Fund the farm wallet with $' + x.capital + ' on ' + x.chain + " and take one position in " + x.name + "'s most liquid market.",
      'Take a second position in a different market category on ' + x.name + ', sized under $' + Math.round(x.capital / 3) + ', so the account is not a single bet.',
      'Let one position settle in full before withdrawing anything: a settled market is a completed activity record.']; };
    if (has('insurance')) return function (x) { return [
      'Buy $' + x.capital + ' of cover from ' + x.name + ' on ' + x.chain + ' against a position you actually hold, and keep the policy to its term.',
      'Where ' + x.name + ' offers a risk pool, stake $' + Math.round(x.capital / 2) + ' into it and leave the stake through one full assessment period.',
      'Renew or replace the cover once when the first term ends, so the wallet shows continuing, not trial, use.']; };
    if (has('launchpad')) return function (x) { return [
      "Create and verify the farm wallet's account on " + x.name + ', and complete every allowlist or registration step it currently asks for.',
      'Commit $' + x.capital + ' to one sale or staking tier ' + x.name + ' runs on ' + x.chain + ', at the smallest tier that records participation.',
      'Hold any allocation or tier position to the date the sale itself states; selling on day one is the pattern most snapshots discount.']; };
    return function (x) { return [
      'Deposit $' + x.capital + " of USDC into " + x.name + "'s main product on " + x.chain + ' and keep the position open.',
      'Make a second deposit of $' + Math.round(x.capital / 2) + " about a week later, so the wallet's history is a pattern, not a single transaction.",
      "Use one more surface of " + x.name + "'s app (its dashboard lists them: a second product, a vote, or a claim page) once, so the wallet is a user, not a deposit address."]; };
  }
  function stepString(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
    var secondChain = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    var gas = gasFor(chain);
    var capital = capitalFor(p.tvl_usd);
    var age = p.age_days;
    var weeks = age === null || age === undefined ? 8 : age < 180 ? 10 : age < 365 ? 8 : age < 1095 ? 6 : 5;
    var holdDays = weeks * 7;
    var x = { name: p.name, chain: chain, capital: capital };
    var actions = playbookFor(p.category)(x);
    var pick = variant(p.slug, 2);
    var steps = [
      pick === 0
        ? { text: 'Open a fresh wallet for ' + p.name + ' alone, fund it on ' + chain + ' with the capital below plus gas, and keep its seed phrase offline.', cost: gas.label, time: '10 minutes' }
        : { text: 'Use one wallet per protocol you farm: create a new one for ' + p.name + ', fund it on ' + chain + ', and never mix it with your main wallet.', cost: gas.label, time: '10 minutes' },
      { text: actions[0], cost: '$' + capital + ' of capital plus ' + gas.label, time: '15 minutes to set up' },
      { text: actions[1], cost: gas.label, time: '15 minutes' },
      secondChain !== null
        ? { text: 'Bridge about $' + Math.round(capital / 2) + ' to ' + secondChain + ', where ' + p.name + ' also runs, and repeat the first step there, so the wallet is active on two of its chains.', cost: 'about $1 of bridge fees plus ' + gasFor(secondChain).label, time: '20 minutes' }
        : { text: actions[2], cost: gas.label, time: '15 minutes' },
      { text: 'Repeat one qualifying action on ' + p.name + ' every week for ' + weeks + ' weeks (a small deposit, a swap, a borrow or a vote): regularity across weekly snapshots is what separates a user from a drive-by.', cost: gas.label + ' a week', time: '10 minutes a week for ' + weeks + ' weeks' },
      { text: 'Hold the position for at least ' + holdDays + ' days in total, and once a month open ' + p.name + "'s own points or rewards page, only from the link the app itself publishes, to see whether the protocol has started counting.", cost: 'the $' + capital + ' stays in the position; checking costs nothing', time: holdDays + ' days, 5 minutes a month' },
      { text: "Keep a farm log (wallet, dates, amounts, transaction hashes) and, when you exit, claim only from " + p.name + "'s official page: never pay a fee to claim an airdrop, and unwind the position in the same order you built it.", cost: 'nothing to log; exit gas is the reverse of entry', time: '15 minutes' }
    ];
    return steps.map(stepString);
  }

  // ------------------------------------------------------------------ state in the hash
  function readHash() {
    // The hash is the whole navigation state: start from the defaults, then apply what it carries,
    // so following a link never inherits a selection the link did not name.
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchOnly = false; state.tab = 'board'; state.selected = null;
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('watch') === '1') state.watchOnly = true;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchOnly) params.set('watch', '1');
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function header() {
    return el('div', null,
      el('div', { class: 'top' },
        el('div', { class: 'ring', 'aria-hidden': 'true' }),
        el('div', null,
          el('h1', null, 'LAUNCH ', el('span', { class: 'thin' }, 'RADAR')),
          el('p', { class: 'tagline', text: 'Every pre-token protocol in the snapshot, ranked by the launch value a model fitted on the snapshot\'s own token-bearing protocols implies for it. Each row opens a detail view with the arithmetic and a farm plan with costs and times.' }))),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: String(DATA.board_size) }), el('span', { text: 'protocols ranked' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.watchlist_size) }), el('span', { text: 'on the watchlist' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.universe_size) }), el('span', { text: 'in the universe' })),
        el('div', { class: 'stat' }, el('b', { text: String(M.train_count) }), el('span', { text: 'comparables fitted' })),
        el('div', { class: 'stat' }, el('b', { text: DATA.as_of }), el('span', { text: 'snapshot date' }))));
  }

  function methodStrip() {
    var v = M.validation;
    return el('section', { class: 'method', 'aria-label': 'How the value is fitted' },
      el('p', null,
        el('b', { text: 'The model, in one breath: ' }),
        'implied value = geometric mean of (a TVL regression and a category-multiple value fitted on the ',
        String(M.train_count), ' protocols that already trade), then a fitted growth factor and a fitted age-band factor. ',
        el('span', { class: 'mono', text: 'ln(mcap) = ' + M.intercept + ' + ' + M.slope + ' x ln(TVL)' }),
        '; median comparable multiple ', el('span', { class: 'mono', text: M.global_median_multiple + 'x' }),
        '; growth beta ', el('span', { class: 'mono', text: String(M.growth_beta) }),
        ' (a hot week of TVL growth is priced at a slight discount by the market\'s own history, so the radar does not pay up for it).'),
      el('p', null,
        el('b', { text: 'Validated, not asserted: ' }),
        'fitted on one half of the comparables and tested on the other, both ways round, the model\'s held-out rank correlation is ',
        el('span', { class: 'mono', text: String(v.rank_correlation) }),
        ' and its median error is ', el('span', { class: 'mono', text: 'x' + v.median_error_factor }),
        '. Launch values are fat-tailed; treat the board as a ranking, not a price list. ',
        'Bridge and Canonical Bridge rows are not ranked: their TVL is other chains\' assets in transit, and there is no launch to price.'));
  }

  // ------------------------------------------------------------------ the board
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    var key = { implied: 'implied_value_usd', tvl: 'tvl_usd', change: 'change_7d', age: 'age_days', mult: 'implied_multiple' }[state.sort];
    return list.slice().sort(function (a, b) {
      var av = a[key] === null || a[key] === undefined ? -Infinity : a[key];
      var bv = b[key] === null || b[key] === undefined ? -Infinity : b[key];
      return (av - bv) * state.dir || a.rank - b.rank;
    });
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains; }))).sort();
    var catSel = el('select', { 'aria-label': 'Category', onchange: function () { state.category = catSel.value; writeHash(); render(); } },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: state.category === c ? 'selected' : null }); }));
    var chainSel = el('select', { 'aria-label': 'Chain', onchange: function () { state.chain = chainSel.value; writeHash(); render(); } },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: state.chain === c ? 'selected' : null }); }));
    var sortSel = el('select', { 'aria-label': 'Sort', onchange: function () { state.sort = sortSel.value; state.dir = -1; render(); } },
      [['implied', 'Sort: implied value'], ['tvl', 'Sort: TVL'], ['change', 'Sort: 7d change'], ['age', 'Sort: age'], ['mult', 'Sort: value / TVL']]
        .map(function (pair) { return el('option', { value: pair[0], text: pair[1], selected: state.sort === pair[0] ? 'selected' : null }); }));
    function tab(name, label) {
      return el('button', { 'aria-pressed': state.tab === name ? 'true' : 'false', onclick: function () { state.tab = name; state.selected = null; writeHash(); render(); } }, label);
    }
    return el('div', { class: 'controls' },
      el('input', { type: 'search', placeholder: 'Search name or slug', value: state.q, 'aria-label': 'Search',
        oninput: function (e) { state.q = e.target.value; writeHash(); renderTableOnly(); } }),
      catSel, chainSel, sortSel,
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: state.watchOnly ? 'checked' : null,
          onchange: function (e) { state.watchOnly = e.target.checked; writeHash(); render(); } }),
        'Watchlist only'),
      el('div', { class: 'tabs' }, tab('board', 'Board'), tab('live', 'Live comps'), tab('method', 'Method')));
  }

  var tableHost = null;
  function boardTable() {
    var list = visibleRows();
    var maxVal = list.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 0);
    function th(label, key, cls) {
      return el('th', { class: (cls || '') + (state.sort === key ? ' sorted' : ''), onclick: function () {
        if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; }
        render();
      } }, label + (state.sort === key ? (state.dir < 0 ? ' v' : ' ^') : ''));
    }
    var table = el('table', null,
      el('thead', null, el('tr', null,
        th('#', 'implied'), th('Protocol', 'implied'), th('Category', 'implied'), th('TVL', 'tvl', 'num'),
        th('7d', 'change', 'num'), el('th', { class: 'hideS', text: 'Age' }), th('Implied value', 'implied', 'num'))),
      el('tbody', null, list.map(function (r) {
        return el('tr', { class: 'row', onclick: function () { state.selected = r.slug; writeHash(); render(); } },
          el('td', { class: 'rank', text: String(r.rank) }),
          el('td', null,
            el('span', { class: 'name', text: r.name }),
            r.watchlist ? el('span', { class: 'watch', text: 'watchlist' }) : null,
            el('div', { class: 'slug', text: r.slug }),
            el('div', { class: 'chains', text: r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') })),
          el('td', { text: r.category || 'Uncategorised' }),
          el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
          el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) }),
          el('td', { class: 'hideS', text: fmtAge(r.age_days) }),
          el('td', { class: 'num val' }, fmtUsd(r.implied_value_usd),
            el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / maxVal) * 100)) + '%' }))));
      })));
    return el('div', null,
      el('p', { class: 'count', text: list.length + ' of ' + DATA.board_size + ' ranked protocols shown. Click a row for its arithmetic and farm plan.' }),
      table);
  }
  function renderTableOnly() {
    if (!tableHost) { render(); return; }
    var fresh = boardTable();
    tableHost.replaceWith(fresh);
    tableHost = fresh;
  }

  // ------------------------------------------------------------------ detail
  function detailView(row) {
    var catValue = row.category_multiple * row.tvl_usd;
    var base = Math.sqrt(row.regression_value * catValue);
    var steps = farmSteps(row);
    function cell(value, label) { return el('div', { class: 'cell' }, el('b', { text: value }), el('span', { text: label })); }
    function term(label, value, op) {
      return el('tr', null, el('td', { class: 'op', text: op || '' }), el('td', { text: label }), el('td', { class: 'num', text: value }));
    }
    return el('div', { class: 'detail' },
      el('button', { class: 'back', onclick: function () { state.selected = null; writeHash(); render(); } }, '< back to the board'),
      el('h2', null, row.name, row.watchlist ? el('span', { class: 'watch', text: 'watchlist' }) : null),
      el('p', { class: 'tagline', text: (row.category || 'Uncategorised') + ' · ' + row.chains.join(', ') + ' · listed ' + (row.listed_at || 'date unknown') + ' · rank #' + row.rank + ' of ' + DATA.board_size }),
      el('div', { class: 'grid' },
        cell(fmtUsd(row.implied_value_usd), 'implied launch value'),
        cell(fmtUsd(row.tvl_usd), 'TVL'),
        cell(fmtX(row.implied_multiple), 'implied value / TVL'),
        cell(fmtPct(row.change_7d), 'TVL change, 7d'),
        cell(fmtAge(row.age_days), 'running, no token'),
        cell(Math.round(row.category_launch_rate * 100) + '%', 'of its category already trade')),
      el('section', { class: 'panel' },
        el('h3', { text: 'How this value is built' }),
        el('p', { text: 'No hand-set price: every term below is fitted on the ' + M.train_count + ' protocols in this snapshot that already trade, and the same function scores every row on the board.' }),
        el('table', { class: 'terms' },
          term('TVL regression value (exp(' + M.intercept + ' + ' + M.slope + ' x ln TVL))', fmtUsd(row.regression_value)),
          term('Category value (' + (row.category || 'Uncategorised') + ' multiple ' + row.category_multiple + 'x: its fitted median, shrunk toward the global median, or that median itself when the category has too few comparables)', fmtUsd(catValue)),
          term('Base value (geometric mean of the two)', fmtUsd(base), '='),
          term('Growth factor (fitted beta ' + M.growth_beta + ' on ' + fmtPct(row.change_7d) + ', clamped)', 'x' + row.growth_factor, 'x'),
          term('Maturity factor (its age band\'s fitted multiple)', 'x' + row.maturity_factor, 'x'),
          el('tr', { class: 'total' }, el('td', { class: 'op', text: '=' }), el('td', { text: 'Implied launch value' }), el('td', { class: 'num', text: fmtUsd(row.implied_value_usd) })))),
      el('section', { class: 'panel' },
        el('h3', { text: 'Farm plan' }),
        el('p', { text: 'Derived from this protocol\'s category, chains, TVL and age, the same derivation board.json carries. Costs and times are stated per step; capital stays in the position for the hold.' }),
        el('ol', { class: 'plan' }, steps.map(function (s) { return el('li', { text: s }); })),
        el('p', { class: 'note', text: 'A plan is a hypothesis about how a launch might count activity, not a promise of one. Protocols launch late, change terms, or never launch; the base rate above is the honest prior.' })));
  }

  // ------------------------------------------------------------------ live comps
  function liveView() {
    return el('div', null,
      el('p', { class: 'count', text: 'The ' + DATA.live_size + ' largest token-bearing protocols in the snapshot, at the market\'s own values. The model is fitted on these and their ' + (M.train_count - DATA.live_size) + ' smaller peers; none of them is ranked.' }),
      el('table', null,
        el('thead', null, el('tr', null,
          el('th', { text: 'Protocol' }), el('th', { text: 'Category' }), el('th', { class: 'num', text: 'TVL' }),
          el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'mcap / TVL' }), el('th', { class: 'num', text: '7d' }))),
        el('tbody', null, DATA.live.map(function (r) {
          return el('tr', null,
            el('td', null, el('span', { class: 'name', text: r.name }), el('div', { class: 'slug', text: r.slug })),
            el('td', { text: r.category || 'Uncategorised' }),
            el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
            el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
            el('td', { class: 'num', text: fmtX(r.multiple) }),
            el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) }));
        }))));
  }

  // ------------------------------------------------------------------ method
  function methodView() {
    var v = M.validation;
    var bands = M.maturity_bands.map(function (b) { return b.label + ' x' + b.factor; }).join('; ');
    var cats = Object.keys(M.category_multiples).sort(function (a, b) { return M.category_multiples[b] - M.category_multiples[a]; })
      .slice(0, 8).map(function (c) { return c + ' ' + M.category_multiples[c] + 'x'; }).join('; ');
    function para() { return el('p', null, Array.prototype.slice.call(arguments)); }
    return el('section', { class: 'panel' },
      el('h3', { text: 'Method, stated in full' }),
      para(el('b', { text: 'The universe. ' }), 'The snapshot carries ' + DATA.universe_size + ' protocols at or above its $5M TVL floor. A protocol is pre-token when its record shows no market cap, no CoinGecko id and no symbol. The board ranks ' + DATA.board_size + ' of them: all ' + DATA.watchlist_size + ' watchlist protocols, plus every other rankable pre-token protocol. Bridge and Canonical Bridge rows are excluded from ranking (their TVL is assets in transit, not a future launch), as are exchange rows and versioned pool names.'),
      para(el('b', { text: 'The fit. ' }), 'On the ' + M.train_count + ' non-exchange protocols that record both a TVL and a token market cap, the model fits ln(mcap) = ' + M.intercept + ' + ' + M.slope + ' x ln(TVL) by least squares, and each category\'s median mcap/TVL multiple, shrunk toward the global median (' + M.global_median_multiple + 'x) by n/(n+6) so small categories barely move the estimate. Fitted category multiples: ' + cats + '.'),
      para(el('b', { text: 'Growth and maturity. ' }), 'The growth factor is exp(beta x change_7d / 100) with beta fitted from the comparables\' residuals against their 7-day TVL change, damped by half and the factor clamped to ' + M.growth_clamp[0] + '-' + M.growth_clamp[1] + '. The fitted beta is ' + M.growth_beta + ': in this snapshot, protocols whose TVL just spiked trade at lower multiples, so the radar refuses to pay up for a hot week. The maturity factor is each age band\'s median comparable multiple over the global median, clamped to 0.8-1.35: ' + bands + '.'),
      para(el('b', { text: 'Validation. ' }), 'The comparables were split in two by slug order; each half\'s model predicted the other half. Held-out rank correlation ' + v.rank_correlation + ', median error x' + v.median_error_factor + ', ' + Math.round(v.within_2x_share * 100) + '% of predictions within 2x of the market\'s own value. That is the honest state of launch pricing from one snapshot: useful as a ranking, meaningless as a promise.'),
      para(el('b', { text: 'Farm plans. ' }), 'Each plan is generated from the protocol\'s own record: its category selects the actions, its first chain the gas costs, its TVL the capital, its age the cadence and hold. No protocol name is special-cased anywhere in the model or the plans.'),
      para(el('b', { text: 'What this is not. ' }), 'Not financial advice, and not a claim that any protocol will launch. It is one snapshot (' + DATA.as_of + ', ' + DATA.source + '), one fitted model (' + M.version + '), and the discipline of showing the arithmetic.'));
  }

  function render() {
    readHash();
    app.setAttribute('aria-busy', 'false');
    app.textContent = '';
    if (state.selected) {
      var row = DATA.rows.find(function (r) { return r.slug === state.selected; });
      if (row) { app.appendChild(header()); app.appendChild(detailView(row)); app.appendChild(foot()); return; }
      state.selected = null;
    }
    app.appendChild(header());
    app.appendChild(methodStrip());
    app.appendChild(controls());
    if (state.tab === 'live') app.appendChild(liveView());
    else if (state.tab === 'method') app.appendChild(methodView());
    else { tableHost = boardTable(); app.appendChild(tableHost); }
    app.appendChild(foot());
  }
  function foot() {
    return el('p', { class: 'foot', text: 'Launch Radar · model ' + M.version + ' · fitted at run time on the sealed snapshot of ' + DATA.as_of + ' (' + DATA.source + '). Implied values are a model\'s ranking, not market prices. Farm plans state their own costs and times; nothing here is financial advice.' });
  }

  window.addEventListener('hashchange', render);
  render();
})();
