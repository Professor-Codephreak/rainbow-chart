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
 * Self-boot: <div data-rainbow-chart data-to="2027" data-height="600"></div>
 * API: RainbowChart.render(mount, opts) · .fit(x) → USD · .bandOf(price, x) · .FIT · .BANDS
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

  // the reference colour scale + labels, bottom band first
  var BANDS = [
    { name: 'Fire sale!',                col: '#4472c4' },
    { name: 'BUY!',                      col: '#54989f' },
    { name: 'Accumulate',                col: '#63be7b' },
    { name: 'Still cheap',               col: '#b1d580' },
    { name: 'HODL!',                     col: '#feeb84' },
    { name: 'Is this a bubble?',         col: '#f6b45a' },
    { name: 'FOMO Intensifies',          col: '#ed7d31' },
    { name: 'Sell. Seriously, SELL!',    col: '#d64018' },
    { name: 'Maximum bubble territory',  col: '#c00200' }
  ];

  // the four halvings that have happened; the schedule then steps 210,000 blocks ~= 1458.33 days
  var HALVINGS = [Date.UTC(2012, 10, 28), Date.UTC(2016, 6, 9), Date.UTC(2020, 4, 11), Date.UTC(2024, 3, 20)];
  var HALVING_STEP_MS = 1458.33 * DAY;
  var GENESIS_MS = Date.UTC(2009, 0, 3);

  // the house palette; every colour the chart uses is overridable through opts.theme
  var THEME = {
    bg: '#160a0f', ink: '#f6e7eb', dim: '#b98da0', faint: '#7d5d6c', seam: '#4a1f30',
    price: '#ffffff', dot: '#ff4d6d', grid: '#160a0f', halving: '#f6e7eb'
  };
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
  function drawCornerLegend(svg, L, T, theme, fontSize, note) {
    var ROW = fontSize + 5, PAD = 11, SW = 9, GAP = 6, charW = fontSize * 0.6;
    var items = [{ name: 'BTC price', col: theme.price }];
    for (var i = 8; i >= 0; i--) items.push(BANDS[i]);

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

  function render(mount, opts) {
    opts = opts || {};
    var theme = THEME;
    if (opts.theme) { theme = {}; for (var t in THEME) theme[t] = opts.theme[t] || THEME[t]; }

    // The reference extends nine months past the last close and stops. Anything further stretches
    // the arc thin and paints more forecast than record, so nine months is the default here too.
    var xEnd = opts.to
      ? xOf(Date.UTC(opts.to, 0, 1))
      : xOf(msOf(SERIES_LAST_X) + 274 * DAY);
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
        points: top.join(' ') + ' ' + bot.reverse().join(' '), fill: BANDS[i].col
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
    for (i = 0; i < hv.length; i++) {
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
    // ── the measured price path ──
    var pts = [];
    for (i = 0; i < SERIES.length; i++) {
      var px = seriesX(i);
      if (px > xEnd) break;
      pts.push(X(px) + ',' + Y(SERIES[i]));
    }
    svg.appendChild(el('polyline', {
      points: pts.join(' '), fill: 'none', stroke: theme.price,
      'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    // ── the key, in the dead corner above the early years ──
    drawCornerLegend(svg, L, T, theme, 10.5,
      hv.length > 4 ? 'halvings: 4 actual, ' + (hv.length - 4) + ' scheduled' : 'halvings');

    // ── where the price stands today, and what that is worth in aggregate ──
    // The arc climbs to the top-right, so the bottom-right of the plot is always empty: the
    // readout card lives there on its own backing plate and reaches the dot with a leader line.
    // Text is never laid over the bands, where nine saturated colours make any ink unreadable.
    var lastX = SERIES_LAST_X;
    var lastUsd = Math.pow(10, SERIES[SERIES.length - 1]);
    var lastBand = bandOf(lastUsd, lastX);
    if (lastX <= xEnd) {
      var dx = X(lastX), dy2 = Y(SERIES[SERIES.length - 1]);
      var mcap = marketcapAt(lastUsd, msOf(lastX));
      var ratio = lastUsd / fit(lastX);
      var lines = [
        { t: FIT.to, c: theme.dim, s: 10, w: 'normal' },
        { t: '$' + Math.round(lastUsd).toLocaleString('en-US'), c: theme.ink, s: 17, w: 'bold' },
        { t: usdLabel(mcap) + ' market cap', c: theme.dim, s: 10.5, w: 'normal' },
        { t: ratio.toFixed(2) + '× the fit', c: theme.dim, s: 10.5, w: 'normal' },
        { t: lastBand < 0 ? 'below the scale' : lastBand > 8 ? 'above the scale' : BANDS[lastBand].name,
          c: lastBand < 0 || lastBand > 8 ? theme.dim : BANDS[lastBand].col, s: 11.5, w: 'bold' }
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
      svg.appendChild(el('circle', {
        cx: dx, cy: dy2, r: 4.5, fill: theme.dot, stroke: theme.bg, 'stroke-width': 1.4
      }));
    }

    while (mount.firstChild) mount.removeChild(mount.firstChild);
    mount.appendChild(svg);
    return { svg: svg, lastUsd: lastUsd, lastX: lastX, band: lastBand };
  }

  var RainbowChart = {
    render: render, fit: fit, bandOf: bandOf, xOf: xOf, msOf: msOf, seriesX: seriesX,
    supplyAt: supplyAt, marketcapAt: marketcapAt, usdLabel: usdLabel,
    FIT: FIT, BANDS: BANDS, SERIES: SERIES, SERIES_STEP: SERIES_STEP, SERIES_LAST_X: SERIES_LAST_X,
    BAND_WIDTH: BAND_WIDTH, BAND_OFFSET: BAND_OFFSET, TERMINAL_SUPPLY: TERMINAL_SUPPLY,
    THEME: THEME, version: '2.0.0'
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
        render(ns[i], {
          to: +ns[i].getAttribute('data-to') || 0,
          height: +ns[i].getAttribute('data-height') || 0
        });
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
