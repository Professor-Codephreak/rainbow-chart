/*!
 * rainbow-chart.js — the Bitcoin rainbow chart, in the browser, as an arc.
 *
 *   github.com/Professor-Codephreak/rainbow-chart
 *   a port of github.com/StephanAkkerman/bitcoin-rainbow-chart (matplotlib) to dependency-free SVG
 *
 * THE ARC. The rainbow is a LOGARITHMIC REGRESSION ON LINEAR TIME, which is what bends it into
 * an arc: fast in the early years, flattening as the log curve tires. Plotted the other way —
 * log time against log price — the same fit straightens into a diagonal ruler. Both are honest;
 * only the arc is the rainbow chart, because the arc is the shape the regression actually has
 * against the calendar people read.
 *
 *     ln(price) = a · ln(b + x) + c        x = 1 for the first priced day, +1 per priced day
 *     a = 5.0222935652   b = 383.8277947247   c = -32.2162634088      R² = 0.9612
 *
 * refit on 5,836 daily closes, 2010-08-16 → 2026-08-08 (the reference CSV through 2024-05-24,
 * extended with Binance BTC/USDT daily closes). The fit is on the DAY INDEX of the series, not on
 * days-since-genesis — that is what the reference does, and it is kept so this chart is
 * comparable to every other rainbow drawn from that method.
 *
 * THE BANDS — nine, each 0.3 wide in NATURAL log, offset (i − 1.5) from the fit:
 *
 *     band i spans exp(fit + (i−1.5)·0.3 − 0.3) … exp(fit + (i−1.5)·0.3)
 *
 * which puts the fit line inside band 2 ("Accumulate") and makes the ladder ASYMMETRIC: it
 * reaches 0.472× below the fit but 7.03× above. That is the reference's geometry, kept verbatim —
 * but worth knowing, because it means only ~86% of BTC's history falls inside the painted range
 * at all. `bandOf()` returns -1 / 9 outside it rather than clamping, so a caller can say "off the
 * scale" instead of quietly pinning to an edge.
 *
 * THE SECOND AXIS. The right margin carries MARKET CAP against the same gridlines: marketcap =
 * price × 21,000,000, the terminal supply. It is a rescale of the price axis, not a second
 * measurement — at the terminal supply the two axes are the same statement in different units,
 * and every tick is exact. Today's schedule supply is smaller (see `supplyAt()`), so a marketcap
 * read for a PAST date is the price times the supply of that date, which `marketcapAt()` gives.
 *
 * Zero dependencies, zero network calls, CSP-safe: SVG built with createElementNS, never
 * innerHTML. The series is embedded — weekly closes, delta-encoded log10 × 1000 — so the chart
 * renders identically offline and airgapped.
 *
 * THE LIVE TIP. The embedded series ends at its last close, which is a fact with a date on it and
 * therefore wrong by a little more every day the page is not republished. `setLive(price, atMs)`
 * hands the organ a current price: the price path is carried from the last close to that reading,
 * the marker and the readout card move to it, and every mount already on the page is redrawn. The
 * organ still fetches NOTHING — the caller supplies the number (on luv.pythai.net that is
 * rainbow.js, reading same-origin /market.json every fifteen minutes), so zero-network-calls
 * survives intact and the page keeps one source of truth for "now".
 *
 * Self-boot: <div data-rainbow-chart data-to="2027" data-height="600"></div>
 * API: RainbowChart.render(mount, opts) · .fit(x) → USD · .bandOf(price, x) · .FIT · .BANDS
 *      RainbowChart.setLive(usd, atMs) → redraws every mount at the live price · .live()
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  // the reference fit, refit on data through 2026-08-08
  var FIT = {
    a: 5.0222935652, b: 383.8277947247, c: -32.2162634088,
    r2: 0.961197, n: 5836, from: '2010-08-16', to: '2026-08-08'
  };
  var DAY = 86400e3;
  var X1_MS = Date.UTC(2010, 7, 16);     // x = 1 lands on the first priced day
  var BAND_WIDTH = 0.3;                  // natural log, per the reference
  var BAND_OFFSET = 1.5;                 // the reference's i_decrease
  var TERMINAL_SUPPLY = 21e6;            // the marketcap axis basis

  // ── the two palettes ──
  // CLASSIC is the reference colour scale, kept verbatim: it is what makes one rainbow chart
  // comparable to every other, and it is the default. HOUSE is the trader's ramp SHAMBA LUV draws
  // (operator, 2026-08-17): the fire zone is RED, the centre band is BITCOIN ORANGE (#F7931A), and
  // the far top — where you sell — is CANDLE GREEN, because a realised gain is a green candle.
  // Labels are the same nine words either way; opts.palette picks the colours. The Python
  // renderer carries both under the same names, and the parity test checks both.
  var BTC_ORANGE = '#F7931A';
  var NAMES = ['Fire sale!', 'BUY!', 'Accumulate', 'Still cheap', 'HODL!', 'Is this a bubble?',
               'FOMO Intensifies', 'Sell. Seriously, SELL!', 'Maximum bubble territory'];
  var PALETTES = {
    classic: ['#4472c4', '#54989f', '#63be7b', '#b1d580', '#feeb84', '#f6b45a', '#ed7d31', '#d64018', '#c00200'],
    house:   ['#d81e3c', '#e5402c', '#ee5f22', '#f47a1c', BTC_ORANGE, '#e8a91e', '#d3bd25', '#8ec43a', '#0ecb81']
  };
  function bandsFor(palette) {
    var cols = PALETTES[palette] || PALETTES.classic, out = [];
    for (var i = 0; i < 9; i++) out.push({ name: NAMES[i], col: cols[i] });
    return out;
  }
  // BANDS is the reference scale, bottom band first — the object the parity test reads
  var BANDS = bandsFor('classic');

  // the four halvings that have happened; the schedule then steps 210,000 blocks ~= 1458.33 days
  var HALVINGS = [Date.UTC(2012, 10, 28), Date.UTC(2016, 6, 9), Date.UTC(2020, 4, 11), Date.UTC(2024, 3, 20)];
  var HALVING_STEP_MS = 1458.33 * DAY;
  var GENESIS_MS = Date.UTC(2009, 0, 3);

  // the house palette; every colour the chart uses is overridable through opts.theme
  var THEME = {
    bg: '#160a0f', ink: '#f6e7eb', dim: '#b98da0', faint: '#7d5d6c', seam: '#4a1f30',
    price: '#ffffff', dot: '#ff4d6d', grid: '#160a0f', halving: '#f6e7eb', debt: '#7ad7ff'
  };
  // on the house palette Bitcoin goes up in bitcoin orange; the reference keeps its white line
  var HOUSE_PRICE = BTC_ORANGE;
  // ── the embedded series: weekly closes, every 7th day from x = 1, delta-encoded log10 x 1000 ──
  var SERIES_STEP = 7;
  // the final point is the true last close, which does not land on the weekly stride
  var SERIES_LAST_X = 5836;
  var SERIES_ENC =
    '-1114,-63,-11,-34,465,-445,-20,23,177,22,279,160,117,-109,5,-5,-53,-2,39,48,-3,43,13,96,157,186,50,-77,34,' +
    '-32,8,-25,-29,-14,114,78,155,321,229,145,-52,97,310,18,-123,75,-36,-66,-7,6,-33,-132,68,4,-84,-92,-104,-7,' +
    '-72,3,-75,-203,36,70,-36,-78,-53,109,18,33,92,8,114,118,-12,-31,-60,16,-12,-98,33,12,34,-48,-12,20,-6,8,15,1,' +
    '-6,-1,6,0,25,37,37,5,-1,28,129,-30,22,82,56,-84,31,-26,23,54,-12,11,-15,-6,-5,-27,3,-2,23,23,12,29,-8,2,-2,' +
    '15,15,88,49,28,95,57,9,194,-7,47,232,193,130,-340,253,-25,-103,4,25,28,-26,-62,7,-14,-79,-45,96,-27,57,3,4,' +
    '12,36,38,-20,11,-16,-70,82,30,170,7,54,231,182,136,150,-113,-109,-21,55,89,-34,-18,-36,29,-79,-25,-32,56,-24,' +
    '-15,-16,-108,-13,62,-11,-46,-2,-4,48,65,62,-15,-25,-11,46,-20,-3,1,-35,11,-30,-35,-5,-25,11,-13,-38,-49,-71,' +
    '80,-9,-41,-11,100,-44,-20,8,-18,-57,12,-19,-54,-195,87,63,-50,-5,29,7,63,26,-42,0,-40,6,-43,27,-21,23,8,-15,' +
    '2,-17,3,15,8,30,18,35,-21,25,-17,-23,-19,-63,13,22,-19,-1,18,11,16,15,48,143,-32,-54,-19,70,20,65,-20,-7,0,' +
    '16,-73,18,-25,0,38,31,-5,-20,3,0,-1,6,6,10,26,-11,-1,4,-8,76,41,70,-13,-9,10,4,0,-12,-104,60,-8,4,-11,29,0,' +
    '-2,-2,3,4,15,12,27,8,1,15,-2,14,12,8,70,37,-49,-1,8,20,37,-20,50,24,32,-12,-46,-32,41,31,-18,36,55,56,22,119,' +
    '1,100,-21,-24,-14,14,-48,-1,42,49,82,86,-24,63,-12,-29,-27,-4,51,37,68,23,34,46,-39,94,92,66,173,12,-111,38,' +
    '-8,-36,-82,-42,-168,94,123,-43,18,-70,-27,-39,-26,-38,65,83,-14,-1,-35,-6,-51,9,-44,-10,-34,27,-7,23,50,12,' +
    '-54,-49,10,39,16,-62,0,19,-1,4,-2,-7,-12,9,-5,-134,-91,19,-63,16,30,-7,32,-43,-14,-11,0,22,32,-7,-13,17,13,' +
    '-7,23,104,-20,29,-10,34,138,10,40,-33,-6,66,72,-18,66,-54,-22,-36,93,-15,-18,-23,1,-3,-2,-25,-67,-5,8,-7,50,' +
    '9,-34,-27,-60,11,2,-28,27,-6,31,19,27,13,13,32,-7,-2,-35,-51,-198,112,-6,59,-30,-1,57,57,-14,53,-39,60,-19,' +
    '-16,12,-23,8,-5,-4,81,8,24,15,-19,-4,-51,12,-10,11,4,29,8,46,17,53,37,42,30,-12,2,72,75,74,45,13,-56,17,141,' +
    '15,52,-37,22,28,-12,27,10,6,-31,-13,24,-10,-108,-51,-16,-47,83,-107,36,-9,-7,-32,83,21,73,-3,32,-22,49,-69,' +
    '-21,-6,65,68,33,8,-14,44,-27,-52,11,-58,-34,1,34,-38,-45,4,-62,22,56,-13,-60,67,-56,19,15,59,-5,-72,15,-4,' +
    '-21,-106,-5,-11,37,-5,-145,-38,3,-10,-6,53,-25,39,10,5,-52,-23,-11,54,-59,-7,9,-11,9,-5,26,2,-94,-22,12,20,6,' +
    '-20,12,-6,13,91,34,-1,-2,-19,57,-24,-21,34,60,-10,10,28,-3,-29,8,-6,-8,-5,14,-32,2,16,52,12,-10,-4,-14,1,-1,' +
    '4,-52,0,-5,-11,27,-8,20,1,14,64,19,7,17,12,-3,52,-8,1,23,6,19,-29,-34,32,1,62,22,38,48,50,-62,53,-29,24,-35,' +
    '17,-39,12,-6,57,-11,13,-20,-14,-23,2,-29,49,6,2,-73,34,-11,3,-14,1,19,28,-24,10,33,2,33,-21,103,21,-1,18,3,' +
    '41,-32,-23,16,-2,41,-20,-16,-9,0,-33,-7,-22,-1,23,-11,-47,39,49,3,12,31,12,8,-14,19,-23,7,-2,13,34,8,-7,-15,' +
    '23,-27,-5,-2,1,20,-18,8,27,-31,-18,18,-47,7,-45,-27,19,7,-23,-2,5,25,8,-33,4,-72,-41,-9,-22,28,10,24,-20,-15,' +
    '23,13,13,0,25,-2,-20,-6,-55,-35,27,-19,-30,34,11,10,-17,1,6';

  var SERIES = (function () {
    var d = SERIES_ENC.split(','), out = new Array(d.length), acc = 0;
    for (var i = 0; i < d.length; i++) { acc += +d[i]; out[i] = acc / 1000; }   // log10 USD
    return out;
  })();

  /// Day index of series point i — uniform weekly stride, except the last, which is the real close.
  function seriesX(i) { return i === SERIES.length - 1 ? SERIES_LAST_X : 1 + i * SERIES_STEP; }

  // ── the live tip ──
  // LIVE is the current price as last handed in, and MOUNTS is every element this organ has drawn
  // into, so a new reading redraws what is actually on the page rather than waiting for a reload.
  // Mounts are deduplicated by element, and a mount removed from the document is dropped on the
  // next pass — otherwise a long-lived page would redraw into detached nodes forever.
  var LIVE = null;
  var MOUNTS = [];

  function remember(mount, opts) {
    for (var i = 0; i < MOUNTS.length; i++) {
      if (MOUNTS[i].mount === mount) { MOUNTS[i].opts = opts; return; }
    }
    MOUNTS.push({ mount: mount, opts: opts });
  }

  /// Hand the organ the current price. Returns false — and changes nothing — for anything that is
  /// not a positive number, because a wrong tip is worse than a dated one.
  function setLive(usd, atMs) {
    if (!(usd > 0)) return false;
    LIVE = { price: usd, atMs: atMs > 0 ? atMs : Date.now() };
    var live = [];
    for (var i = 0; i < MOUNTS.length; i++) {
      var m = MOUNTS[i];
      if (m.mount.ownerDocument && m.mount.ownerDocument.contains(m.mount)) {
        live.push(m);
        render(m.mount, m.opts);
      }
    }
    MOUNTS = live;
    return true;
  }

  // The reference fits on the ROW INDEX of its CSV, not on days-since-genesis, so index and date
  // only coincide where the series has no gaps. Across 2010-08-16 → 2026-08-08 there is exactly
  // ONE missing day — 2010-08-17 — so every index from x = 2 onward runs one day ahead of a naive
  // (x − 1) offset. Correcting for it keeps the year ticks and the "today" marker on their true
  // dates instead of a day early. Kept explicit rather than silently absorbed, because it is the
  // one place where the reference's index-based fit leaks into calendar arithmetic.
  var GAP_AFTER_X = 1;   // the single gap sits between x = 1 and x = 2
  function msOf(x) { return X1_MS + (x >= 2 ? x : x - 1) * DAY; }
  function xOf(ms) {
    var n = Math.round((ms - X1_MS) / DAY);
    return n <= 0 ? 1 : n >= 2 ? n : GAP_AFTER_X + 1;
  }

  /// The fit, in USD, at day index x.
  function fit(x) { return Math.exp(FIT.a * Math.log(FIT.b + x) + FIT.c); }

  /// Which band a price sits in at day index x. 0..8, or -1 below / 9 above the painted range.
  /// @dev CEIL, not floor. Band i spans natural-log offsets [(i−2.5)·0.3, (i−1.5)·0.3] — the top
  ///      edge is (i−1.5)·0.3, so inverting for i gives ceil(r/0.3 + 1.5). Using floor lands one
  ///      band low everywhere and reports "below the scale" for prices that are plainly inside
  ///      band 0. Sanity anchors: r = 0 (price exactly on the fit) must give band 2, "Accumulate";
  ///      r = 1.95 (the very top) must give band 8.
  function bandOf(usd, x) {
    var r = Math.log(usd) - Math.log(fit(x));           // residual in natural log
    var i = Math.ceil(r / BAND_WIDTH + BAND_OFFSET);
    return i < 0 ? -1 : i > 8 ? 9 : i;
  }

  /// Circulating supply implied by the EMISSION SCHEDULE at a moment in time.
  /// @dev Epoch boundaries are the four real halving dates, then +210,000 blocks (~1458.33 days)
  ///      per epoch; each epoch mints exactly 210,000 × reward, interpolated linearly inside it.
  ///      This is the schedule, not the chain: real blocks have run a little slower than the
  ///      idealised epoch, so this reads ~0.5% high against a live node. It is deterministic and
  ///      offline, which is the trade the rest of this file makes too.
  function supplyAt(ms) {
    if (ms <= GENESIS_MS) return 0;
    var bounds = [GENESIS_MS].concat(HALVINGS), last = HALVINGS[HALVINGS.length - 1];
    while (bounds.length < 34) { last += HALVING_STEP_MS; bounds.push(last); }
    var supply = 0;
    for (var e = 0; e + 1 < bounds.length; e++) {
      var reward = 50 / Math.pow(2, e);
      if (reward < 1e-9 || ms <= bounds[e]) break;
      supply += 210000 * reward * Math.min(1, (ms - bounds[e]) / (bounds[e + 1] - bounds[e]));
    }
    return Math.min(supply, TERMINAL_SUPPLY);
  }

  /// Market cap of a price at a moment — price × the supply actually emitted by then.
  function marketcapAt(usd, ms) { return usd * supplyAt(ms); }

  function el(name, attrs, text) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  /// Compact USD label. Runs to quadrillions, because a long extrapolation gets there: the top
  /// band in 2140 is ~$22B per coin, which is $470Q of market cap. Stopping at 'T' printed
  /// "$469674T", a number nobody can read at a glance. Past a quintillion it gives up on suffixes
  /// and prints an exponent, which is the honest way to say "this is off the end of the vocabulary".
  function usdLabel(p) {
    if (p >= 1e18) return '$' + trim(p / 1e18) + 'e18';
    if (p >= 1e15) return '$' + trim(p / 1e15) + 'Q';
    if (p >= 1e12) return '$' + trim(p / 1e12) + 'T';
    if (p >= 1e9) return '$' + trim(p / 1e9) + 'B';
    if (p >= 1e6) return '$' + trim(p / 1e6) + 'M';
    if (p >= 1e3) return '$' + trim(p / 1e3) + 'k';
    if (p >= 1) return '$' + Math.round(p);
    return '$' + p.toFixed(2);
  }
  /// three significant figures, without the trailing-zero noise ("$21.0T", "$2.1T", "$210B")
  function trim(v) {
    var s = v >= 100 ? String(Math.round(v)) : v.toPrecision(3);
    return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
  }

  // ── the legend, stacked into the empty top-left ──
  // The arc climbs from the bottom-left to the top-right, so the corner ABOVE the early years is
  // dead space in every window this chart can draw — the wider the window, the more of it there is.
  // Putting the key there costs the plot nothing, where a banner across the top costs it a strip of
  // height and a right-margin column costs it the market-cap axis. Each label is painted in its own
  // band's colour, so the key needs no swatch to be read: the word IS the sample.
  //
  // It sits on a backing plate because the decade gridlines run the full width of the plot and
  // would otherwise strike through the text.
  function drawCornerLegend(svg, L, T, theme, fontSize, note, extra, bands) {
    var ROW = fontSize + 5, PAD = 11, SW = 9, GAP = 6, charW = fontSize * 0.6;
    var items = [{ name: 'BTC price', col: theme.price }];
    if (extra) items.push(extra);
    for (var i = 8; i >= 0; i--) items.push(bands[i]);

    var wide = note ? note.length * (fontSize - 1.5) * 0.6 : 0;
    for (i = 0; i < items.length; i++) wide = Math.max(wide, items[i].name.length * charW);
    var boxW = PAD * 2 + SW + GAP + wide;
    var boxH = PAD * 2 + items.length * ROW - 5 + (note ? ROW + 4 : 0);
    var x0 = L + 12, y0 = T + 12;

    svg.appendChild(el('rect', {
      x: x0, y: y0, width: boxW, height: boxH, rx: 7,
      fill: theme.bg, 'fill-opacity': 0.96, stroke: theme.seam, 'stroke-opacity': 0.55
    }));
    for (i = 0; i < items.length; i++) {
      var y = y0 + PAD + i * ROW + fontSize;
      svg.appendChild(el('rect', {
        x: x0 + PAD, y: y - SW + 1, width: SW, height: SW, fill: items[i].col, rx: 1.5
      }));
      svg.appendChild(el('text', {
        x: x0 + PAD + SW + GAP, y: y, fill: items[i].col, 'font-size': fontSize,
        'font-family': 'monospace', 'font-weight': 'bold'
      }, items[i].name));
    }
    // The halving key belongs here rather than under the axis, where over a long window it
    // collides with the halving ordinals it is trying to explain.
    if (note) {
      var ny = y0 + PAD + items.length * ROW + fontSize + 4;
      svg.appendChild(el('line', {
        x1: x0 + PAD + 4, y1: ny - fontSize, x2: x0 + PAD + 4, y2: ny + 1,
        stroke: theme.halving, 'stroke-width': 1, 'stroke-opacity': 0.55
      }));
      svg.appendChild(el('text', {
        x: x0 + PAD + SW + GAP, y: ny, fill: theme.dim, 'font-size': fontSize - 1.5,
        'font-family': 'monospace'
      }, note));
    }
    return { w: boxW, h: boxH, x: x0, y: y0 };
  }

  /// A "nice" year step so a 130-year window does not print 130 ticks.
  function yearStep(span) {
    var steps = [1, 2, 5, 10, 20, 25, 50, 100];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= 18) return steps[i];
    return 200;
  }

  /// The measured close at day index x, interpolated in log space between the weekly points.
  /// null past the end of the record, where the fitted curve takes over — unless a live price has
  /// been handed in, in which case the stretch between the last close and the live reading is
  /// interpolated too. That stretch is not a record of anything: it is a straight line drawn
  /// between two real points, and the hover readout says so rather than calling it a close.
  function seriesPriceAtX(x) {
    if (x > SERIES_LAST_X) {
      if (!LIVE) return null;
      var lx = xOf(LIVE.atMs);
      if (x > lx) return null;
      var lastLg = SERIES[SERIES.length - 1];
      if (lx <= SERIES_LAST_X) return LIVE.price;
      var f = (x - SERIES_LAST_X) / (lx - SERIES_LAST_X);
      return Math.pow(10, lastLg + (Math.log10(LIVE.price) - lastLg) * f);
    }
    if (x < 1) return null;
    var i = Math.floor((x - 1) / SERIES_STEP);
    if (i < 0) i = 0;
    if (i >= SERIES.length - 1) return Math.pow(10, SERIES[SERIES.length - 1]);
    var xa = seriesX(i), xb = seriesX(i + 1);
    var t = xb === xa ? 0 : (x - xa) / (xb - xa);
    return Math.pow(10, SERIES[i] + (SERIES[i + 1] - SERIES[i]) * t);
  }

  function render(mount, opts) {
    opts = opts || {};
    var theme = THEME, t;
    var palette = PALETTES[opts.palette] ? opts.palette : 'classic';
    var bands = bandsFor(palette);
    if (palette === 'house') { theme = {}; for (t in THEME) theme[t] = THEME[t]; theme.price = HOUSE_PRICE; }
    if (opts.theme) { var base = theme; theme = {}; for (t in THEME) theme[t] = opts.theme[t] || base[t]; }

    remember(mount, opts);
    // every layer is a toggle; undefined means on, so an old caller draws the whole chart
    var showPath = opts.path !== false, showHalvings = opts.halvings !== false, showKey = opts.key !== false;
    // World debt rides the market-cap reading, and lives in the substrate rainbow — the arc
    // borrows the figure rather than keeping a second copy of the record.
    var RB = global.DVLuvRainbow;
    var showDebt = !!opts.debt && RB && typeof RB.worldDebtAt === 'function';

    // The live tip, if the page has handed one in. Its day index is derived from the reading's own
    // timestamp, so a price read at 00:32 UTC lands on today rather than on whatever "now" was when
    // the chart last drew.
    var live = LIVE && LIVE.price > 0 ? { price: LIVE.price, atMs: LIVE.atMs, x: xOf(LIVE.atMs) } : null;

    // The reference extends nine months past the last close and stops. Anything further stretches
    // the arc thin and paints more forecast than record, so nine months is the default here too.
    // The window is measured from the LIVE tip when there is one — otherwise a page left open long
    // enough would eventually push its own marker off the right-hand edge.
    var xEnd = opts.to
      ? xOf(Date.UTC(opts.to, 0, 1))
      : xOf(Math.max(msOf(SERIES_LAST_X), live ? live.atMs : 0) + 274 * DAY);
    var xStart = 1;

    // 1240 x 600 is ~2.07:1, close to the reference figure's 15x7. The arc wants width: it is a
    // shallow curve, and a squarer frame makes it look like a diagonal stripe instead.
    var W = opts.width || 1240, H = opts.height || 600;
    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H, xmlns: NS, role: 'img',
      'aria-label': 'The Bitcoin rainbow chart: nine logarithmic-regression bands drawn as an arc ' +
        'on linear time against a log price axis, ' + FIT.from + ' to ' +
        new Date(msOf(xEnd)).getUTCFullYear() + ', with a market-cap axis and halving markers.'
    });
    svg.appendChild(el('rect', { width: W, height: H, fill: theme.bg }));

    var T = 26, L = 66, R = 92, B = 44;         // L price axis, R market-cap axis

    // The vertical window is pinned to the painted range itself — the bottom of band 0 where the
    // arc starts, the top of band 8 where it ends — so the rainbow fills the canvas instead of
    // floating in it.
    var lgLo = Math.log10(Math.exp(Math.log(fit(xStart)) - BAND_OFFSET * BAND_WIDTH - BAND_WIDTH));
    var lgHi = Math.log10(Math.exp(Math.log(fit(xEnd)) + (8 - BAND_OFFSET) * BAND_WIDTH));
    // With the debt overlay on, the ceiling rises to hold it: the debt line sits about two decades
    // above the top of the arc today, and THAT gap is the picture the toggle exists to show.
    if (showDebt) lgHi = Math.max(lgHi, Math.log10(RB.worldDebtAt(msOf(xEnd)) / TERMINAL_SUPPLY) + 0.12);

    function X(x) { return L + (x - xStart) / (xEnd - xStart) * (W - L - R); }
    function Y(lg) { return T + (lgHi - lg) / (lgHi - lgLo) * (H - T - B); }
    function Xms(ms) { return X(xOf(ms)); }

    // ── the nine bands, sampled along the fit — this is the arc ──
    var STEPS = 240, k, i;
    for (i = 0; i < 9; i++) {
      var loOff = (i - BAND_OFFSET) * BAND_WIDTH - BAND_WIDTH;
      var hiOff = (i - BAND_OFFSET) * BAND_WIDTH;
      var top = [], bot = [];
      for (k = 0; k <= STEPS; k++) {
        var xx = xStart + (xEnd - xStart) * k / STEPS;
        var lnFit = Math.log(fit(xx));
        top.push(X(xx) + ',' + Y((lnFit + hiOff) / Math.LN10));
        bot.push(X(xx) + ',' + Y((lnFit + loOff) / Math.LN10));
      }
      svg.appendChild(el('polygon', {
        points: top.join(' ') + ' ' + bot.reverse().join(' '), fill: bands[i].col
      }));
    }

    // ── price decades left, the same lines priced as market cap right ──
    // Market cap is price × 21,000,000, so it shares the gridlines exactly: one geometry, two
    // readings. No interpolation, no second scale to misalign.
    for (var d = Math.ceil(lgLo); d <= Math.floor(lgHi); d++) {
      var dy = Y(d);
      svg.appendChild(el('line', {
        x1: L, y1: dy, x2: W - R, y2: dy, stroke: theme.grid, 'stroke-width': 0.6, 'stroke-opacity': 0.35
      }));
      svg.appendChild(el('text', {
        x: L - 7, y: dy + 4, fill: theme.dim, 'font-size': 10.5,
        'text-anchor': 'end', 'font-family': 'monospace'
      }, usdLabel(Math.pow(10, d))));
      svg.appendChild(el('text', {
        x: W - R + 7, y: dy + 4, fill: theme.faint, 'font-size': 10,
        'font-family': 'monospace'
      }, usdLabel(Math.pow(10, d) * TERMINAL_SUPPLY)));
    }
    svg.appendChild(el('text', {
      x: L - 7, y: T - 9, fill: theme.dim, 'font-size': 9.5,
      'text-anchor': 'end', 'font-family': 'monospace', 'letter-spacing': '0.08em'
    }, 'PRICE'));
    svg.appendChild(el('text', {
      x: W - R + 7, y: T - 9, fill: theme.faint, 'font-size': 9.5,
      'font-family': 'monospace', 'letter-spacing': '0.08em'
    }, 'MARKET CAP'));

    // ── year ticks, on a step that keeps the axis readable at any window ──
    // A window to 2140 is 130 years; at one tick a year the labels overprint into a grey smear.
    var y0 = new Date(msOf(xStart)).getUTCFullYear();
    var yEnd = new Date(msOf(xEnd)).getUTCFullYear();
    var step = yearStep(yEnd - y0);
    for (var yr = Math.ceil((y0 + 1) / step) * step; yr <= yEnd; yr += step) {
      var xx2 = Xms(Date.UTC(yr, 0, 1));
      if (xx2 < L || xx2 > W - R) continue;
      svg.appendChild(el('line', {
        x1: xx2, y1: T, x2: xx2, y2: H - B, stroke: theme.grid, 'stroke-width': 0.5, 'stroke-opacity': 0.3
      }));
      svg.appendChild(el('text', {
        x: xx2, y: H - B + 15, fill: theme.dim, 'font-size': 10,
        'text-anchor': 'middle', 'font-family': 'monospace'
      }, String(yr)));
    }

    // ── halvings: the four that happened, then the whole schedule to the end of emission ──
    // Solid where it is history, dashed where it is arithmetic. Over a long window all 32 land on
    // the canvas and the rhythm — four years, tightening against nothing, because the interval
    // never changes — is the clearest thing on the chart.
    var hv = HALVINGS.slice(), lastH = hv[hv.length - 1];
    while (lastH + HALVING_STEP_MS < msOf(xEnd) && hv.length < 33) {
      lastH += HALVING_STEP_MS; hv.push(lastH);
    }
    var spacing = hv.length > 1 ? Math.abs(Xms(hv[1]) - Xms(hv[0])) : 999;
    var labelEvery = spacing >= 46 ? 1 : spacing >= 22 ? 4 : 0;
    for (i = 0; showHalvings && i < hv.length; i++) {
      var hx = Xms(hv[i]);
      if (hx < L || hx > W - R) continue;
      var actual = i < HALVINGS.length;
      svg.appendChild(el('line', {
        x1: hx, y1: T, x2: hx, y2: H - B, stroke: theme.halving,
        'stroke-width': actual ? 1 : 0.8, 'stroke-opacity': actual ? 0.55 : 0.28,
        'stroke-dasharray': actual ? '' : '3 4'
      }));
      if (labelEvery && i % labelEvery === 0) {
        svg.appendChild(el('text', {
          x: hx, y: H - B + 26, fill: actual ? theme.dim : theme.faint, 'font-size': 8.5,
          'text-anchor': 'middle', 'font-family': 'monospace'
        }, String(i + 1)));
      }
    }
    // ── the measured price path, carried to the live tip ──
    var pts = [];
    for (i = 0; i < SERIES.length; i++) {
      var px = seriesX(i);
      if (px > xEnd) break;
      pts.push(X(px) + ',' + Y(SERIES[i]));
    }
    if (live && live.x > SERIES_LAST_X && live.x <= xEnd) {
      pts.push(X(live.x) + ',' + Y(Math.log10(live.price)));
    }
    // Bitcoin goes up in BITCOIN ORANGE. The centre band is the same orange, so the line wears a
    // dark casing: an orange line over every other band, a dark-edged one over its own.
    if (showPath && pts.length > 1) {
      if (palette === 'house') svg.appendChild(el('polyline', {
        points: pts.join(' '), fill: 'none', stroke: theme.bg, 'stroke-opacity': 0.75,
        'stroke-width': 4.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
      svg.appendChild(el('polyline', {
        points: pts.join(' '), fill: 'none', stroke: theme.price,
        'stroke-width': 1.9, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
    }

    // ── world debt, on the market-cap reading of the same axis (opt-in) ──
    // The IIF record interpolated, then compounded forward at the rate the record itself kept —
    // the same worldDebtAt the substrate rainbow draws, so the two charts can never disagree.
    if (showDebt) {
      var dpts = [], DSTEPS = 120;
      for (k = 0; k <= DSTEPS; k++) {
        var dxx = xStart + (xEnd - xStart) * k / DSTEPS;
        dpts.push(X(dxx) + ',' + Y(Math.log10(RB.worldDebtAt(msOf(dxx)) / TERMINAL_SUPPLY)));
      }
      svg.appendChild(el('polyline', { points: dpts.join(' '), fill: 'none', stroke: theme.debt, 'stroke-width': 7, 'stroke-opacity': 0.14, 'stroke-linecap': 'round' }));
      svg.appendChild(el('polyline', { points: dpts.join(' '), fill: 'none', stroke: theme.debt, 'stroke-width': 1.8, 'stroke-dasharray': '8 4', 'stroke-opacity': 0.95 }));
      var dNow = RB.worldDebtAt(Date.now()), dEndY = Y(Math.log10(RB.worldDebtAt(msOf(xEnd)) / TERMINAL_SUPPLY));
      var arcTop = fit(xEnd) * Math.exp((8 - BAND_OFFSET) * BAND_WIDTH) * TERMINAL_SUPPLY;
      var dlabel = 'total world debt \u00b7 ' + usdLabel(dNow) + ' now \u00b7 ' +
                   (RB.worldDebtAt(msOf(xEnd)) / arcTop).toFixed(0) + '\u00d7 the top of the arc';
      var dlw = dlabel.length * 6 + 12, dlx = W - R - dlw - 8;
      svg.appendChild(el('rect', { x: dlx - 6, y: dEndY + 8, width: dlw, height: 17, rx: 4, fill: theme.bg, 'fill-opacity': 0.92, stroke: theme.debt, 'stroke-opacity': 0.4 }));
      svg.appendChild(el('text', { x: dlx, y: dEndY + 20, fill: theme.debt, 'font-size': 10, 'font-family': 'monospace', 'font-weight': 'bold' }, dlabel));
    }

    // ── the key, in the dead corner above the early years ──
    if (showKey) drawCornerLegend(svg, L, T, theme, 10.5,
      showHalvings ? (hv.length > 4 ? 'halvings: 4 actual, ' + (hv.length - 4) + ' scheduled' : 'halvings') : 'halvings: hidden',
      showDebt ? { name: 'world debt (as cap)', col: theme.debt } : null, bands);

    // ── where the price stands today, and what that is worth in aggregate ──
    // The arc climbs to the top-right, so the bottom-right of the plot is always empty: the
    // readout card lives there on its own backing plate and reaches the dot with a leader line.
    // Text is never laid over the bands, where nine saturated colours make any ink unreadable.
    // The marker is the live reading when there is one and the last embedded close otherwise, so
    // the card is never a dated number wearing the word "today".
    var lastX = live ? live.x : SERIES_LAST_X;
    var lastUsd = live ? live.price : Math.pow(10, SERIES[SERIES.length - 1]);
    var lastBand = bandOf(lastUsd, lastX);
    if (lastX <= xEnd) {
      var dx = X(lastX), dy2 = Y(Math.log10(lastUsd));
      var mcap = marketcapAt(lastUsd, msOf(lastX));
      var ratio = lastUsd / fit(lastX);
      var stamp = live
        ? new Date(live.atMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC · live'
        : FIT.to + ' · last close';
      var lines = [
        { t: stamp, c: live ? '#7ee2a0' : theme.dim, s: 10, w: live ? 'bold' : 'normal' },
        { t: '$' + Math.round(lastUsd).toLocaleString('en-US'), c: theme.ink, s: 17, w: 'bold' },
        { t: usdLabel(mcap) + ' market cap', c: theme.dim, s: 10.5, w: 'normal' },
        { t: ratio.toFixed(2) + '× the fit', c: theme.dim, s: 10.5, w: 'normal' },
        { t: lastBand < 0 ? 'below the scale' : lastBand > 8 ? 'above the scale' : bands[lastBand].name,
          c: lastBand < 0 || lastBand > 8 ? theme.dim : bands[lastBand].col, s: 11.5, w: 'bold' }
      ];
      var cardW = 0;
      for (i = 0; i < lines.length; i++) cardW = Math.max(cardW, lines[i].t.length * lines[i].s * 0.6);
      cardW += 24;
      var cardH = 96, cardX = W - R - 12 - cardW, cardY = H - B - 16 - cardH;

      svg.appendChild(el('line', {
        x1: dx, y1: dy2, x2: cardX + cardW - 14, y2: cardY,
        stroke: theme.dot, 'stroke-width': 0.9, 'stroke-dasharray': '3 3', 'stroke-opacity': 0.7
      }));
      svg.appendChild(el('rect', {
        x: cardX, y: cardY, width: cardW, height: cardH, rx: 7,
        fill: theme.bg, 'fill-opacity': 0.93, stroke: theme.dot, 'stroke-opacity': 0.45
      }));
      var ty = cardY + 20;
      for (i = 0; i < lines.length; i++) {
        svg.appendChild(el('text', {
          x: cardX + 12, y: ty, fill: lines[i].c, 'font-size': lines[i].s,
          'font-family': 'monospace', 'font-weight': lines[i].w
        }, lines[i].t));
        ty += lines[i].s + 6;
      }
      // a soft ring marks the live reading — the dot is the same dot, but it is saying "now"
      if (live) {
        svg.appendChild(el('circle', {
          cx: dx, cy: dy2, r: 9, fill: 'none', stroke: '#7ee2a0',
          'stroke-width': 1.1, 'stroke-opacity': 0.55
        }));
      }
      svg.appendChild(el('circle', {
        cx: dx, cy: dy2, r: 4.5, fill: theme.dot, stroke: theme.bg, 'stroke-width': 1.4
      }));
    }

    // ── the hover readout, riding the chart ──
    // Only the pointer's x is read. The price is the one the chart actually holds at that date —
    // the measured close inside the record, the fitted curve past it — so the dot travels ALONG
    // the white line inside the rainbow and every reading is a real point rather than wherever the
    // cursor happened to sit. Built as SVG in the same document: no HTML overlay, no inline style.
    if (svg.addEventListener) {
      var hg = el('g', { 'pointer-events': 'none', visibility: 'hidden' });
      var hvx = el('line', { stroke: '#f6e7eb', 'stroke-width': 0.7, 'stroke-dasharray': '3 3', 'stroke-opacity': 0.6 });
      var hdot = el('circle', { r: 4.5, fill: theme.dot, stroke: '#ffffff', 'stroke-width': 1.4 });
      var hplate = el('rect', { rx: 6, fill: theme.bg, 'fill-opacity': 0.95, stroke: theme.dot, 'stroke-opacity': 0.55 });
      hg.appendChild(hvx); hg.appendChild(hplate); hg.appendChild(hdot);
      var HL = [], hi2;
      for (hi2 = 0; hi2 < 5; hi2++) {
        HL.push(el('text', {
          'font-family': 'monospace', 'font-size': hi2 === 1 ? 14 : 10,
          'font-weight': hi2 === 1 ? 'bold' : 'normal',
          fill: hi2 === 1 ? theme.ink : theme.dim
        }));
        hg.appendChild(HL[hi2]);
      }
      svg.appendChild(hg);

      var PLW = 208, PLH = 94;
      svg.addEventListener('mousemove', function (ev) {
        var r = svg.getBoundingClientRect();
        if (!r.width) return;
        var sx = (ev.clientX - r.left) * (W / r.width);
        var sy = (ev.clientY - r.top) * (H / r.height);
        if (sx < L || sx > W - R || sy < T || sy > H - B) { hg.setAttribute('visibility', 'hidden'); return; }
        hg.setAttribute('visibility', 'visible');

        var xh = xStart + (sx - L) / (W - L - R) * (xEnd - xStart);
        var measured = seriesPriceAtX(xh);
        var fitP = fit(xh);
        var price = measured != null ? measured : fitP;
        var dy3 = Y(Math.log10(price));
        var when = new Date(msOf(Math.round(xh)));
        var bnd = bandOf(price, xh);
        var bname = bnd < 0 ? 'below the scale' : bnd > 8 ? 'above the scale' : bands[bnd].name;
        var bcol = bnd < 0 || bnd > 8 ? theme.dim : bands[bnd].col;

        hvx.setAttribute('x1', sx); hvx.setAttribute('y1', T); hvx.setAttribute('x2', sx); hvx.setAttribute('y2', H - B);
        hdot.setAttribute('cx', sx); hdot.setAttribute('cy', dy3);

        var px = sx + 16 + PLW > W - R ? sx - 16 - PLW : sx + 16;
        var py = dy3 + 14 + PLH > H - B ? dy3 - 14 - PLH : dy3 + 14;
        hplate.setAttribute('x', px); hplate.setAttribute('y', py);
        hplate.setAttribute('width', PLW); hplate.setAttribute('height', PLH);

        // Say which kind of number this is. The series stores WEEKLY closes: on one of them the
        // reading is the close itself (audited against an independent feed: median 0.25% off,
        // worst 2.95%); between two it is a log-space interpolation, which smooths a volatile week
        // (median 2.8%, worst 12%). Calling both "measured" would overstate the second.
        // Past the last close the reading rides the line drawn to the live tip, which is neither a
        // close nor the fit, and is named as its own third thing.
        var onPoint = ((Math.round(xh) - 1) % SERIES_STEP) === 0 || Math.round(xh) === SERIES_LAST_X;
        var kind = measured == null ? 'the fitted curve'
                 : Math.round(xh) > SERIES_LAST_X
                   ? (live && Math.round(xh) >= live.x ? 'the live price' : 'toward the live price')
                 : onPoint ? 'weekly close' : 'between weekly closes';
        var rows = [
          when.toISOString().slice(0, 10),
          '$' + Math.round(price).toLocaleString('en-US'),
          usdLabel(marketcapAt(price, msOf(Math.round(xh)))) + ' market cap',
          kind + ' \u00b7 ' + (price / fitP).toFixed(2) + '\u00d7 the fit',
          bname
        ];
        var ry = py + 19;
        for (hi2 = 0; hi2 < HL.length; hi2++) {
          HL[hi2].setAttribute('x', px + 11);
          HL[hi2].setAttribute('y', ry);
          HL[hi2].textContent = rows[hi2];
          if (hi2 === 4) HL[hi2].setAttribute('fill', bcol);
          ry += hi2 === 1 ? 20 : 15;
        }
      });
      svg.addEventListener('mouseleave', function () { hg.setAttribute('visibility', 'hidden'); });
    }

    while (mount.firstChild) mount.removeChild(mount.firstChild);
    mount.appendChild(svg);
    return { svg: svg, lastUsd: lastUsd, lastX: lastX, band: lastBand };
  }

  var RainbowChart = {
    render: render, fit: fit, bandOf: bandOf, xOf: xOf, msOf: msOf, seriesX: seriesX,
    supplyAt: supplyAt, marketcapAt: marketcapAt, usdLabel: usdLabel,
    setLive: setLive, live: function () { return LIVE; }, seriesPriceAtX: seriesPriceAtX,
    FIT: FIT, BANDS: BANDS, SERIES: SERIES, SERIES_STEP: SERIES_STEP, SERIES_LAST_X: SERIES_LAST_X,
    BAND_WIDTH: BAND_WIDTH, BAND_OFFSET: BAND_OFFSET, TERMINAL_SUPPLY: TERMINAL_SUPPLY,
    THEME: THEME, PALETTES: PALETTES, NAMES: NAMES, bandsFor: bandsFor, BTC_ORANGE: BTC_ORANGE,
    LAYERS: ['debt', 'path', 'halvings', 'key', 'palette'], version: '2.2.0'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RainbowChart;
  global.RainbowChart = RainbowChart;
  global.DVLuvRainbowChart = RainbowChart;        // the name the SHAMBA LUV pages boot against

  if (typeof document !== 'undefined') {
    var boot = function () {
      var ns = document.querySelectorAll('[data-rainbow-chart],[data-luvrainbowchart]');
      for (var i = 0; i < ns.length; i++) {
        if (ns[i].getAttribute('data-booted')) continue;
        ns[i].setAttribute('data-booted', '1');
        // the options live on the mount, so a page's toggles re-render from the same object
        var o = ns[i]._arcOpts || {
          to: +ns[i].getAttribute('data-to') || 0,
          height: +ns[i].getAttribute('data-height') || 0,
          palette: ns[i].getAttribute('data-palette') || undefined
        };
        ns[i]._arcOpts = o;
        render(ns[i], o);
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
