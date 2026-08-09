# Technical reference

Everything the two renderers compute, and why each choice is the one it is.
For what the chart *means*, see [explanation.md](explanation.md); for how to run it, [usage.md](usage.md).

---

## 1. The fit

```
ln(price) = a · ln(b + x) + c
```

Fitted by least squares (`scipy.optimize.curve_fit`) over the natural log of daily closes.

### The published coefficients

```
a =   5.0222935652
b = 383.8277947247
c = -32.2162634088
R² = 0.961197        n = 5,836        2010-08-16 → 2026-08-08
```

Both renderers carry these, so both draw the same curve by default. They come from the reference
CSV extended with Binance BTC/USDT daily closes.

### Refitting from the bundled CSV alone

`data/bitcoin_data.csv` ends 2024-05-24. Refitting from it gives a slightly different curve:

```
a =   5.0245978362
b = 384.9694473944
c = -32.2392610862
R² = 0.953200        n = 5,030
```

The two agree to within **0.2%** at the far end of the series ($115,154 vs $115,378 at x = 5836),
which is the useful check: the published coefficients are not a different model, just a longer one.

Note the row counts. The CSV has 5,624 rows, of which **592 carry a zero price** (the pre-market era
of the dataset) and 2 are duplicate dates. Dropping both leaves **5,030** observations. `data.py`
drops zeros and de-duplicates before fitting; the upstream version dropped zeros but kept the
duplicates, which is why fitting against upstream reports 5,032.

### What x is

`x` is the **row index of the price series**, not days since the genesis block. `x = 1` is the first
priced day, 2010-08-16, and every subsequent priced row adds one. This is what the reference
implementation fits on and it is kept so the chart is comparable to others drawn the same way.

Index and calendar therefore only coincide where the series has no gaps. Across 2010-08-16 →
2026-08-08 there is exactly **one** missing day — 2010-08-17 — so from `x = 2` onward the index runs
one day ahead of a naive `(x − 1)` offset. `day_index_to_date()` / `date_to_day_index()` correct for
it; without the correction every year tick and the "today" marker land a day early.

---

## 2. The bands

Nine bands, each `BAND_WIDTH = 0.3` wide in **natural** log, offset by `BAND_OFFSET = 1.5`:

```
band i spans   exp(fit + (i − 1.5)·0.3 − 0.3)  …  exp(fit + (i − 1.5)·0.3)
```

| i | name | × the fit (low – high) |
|---|---|---|
| 8 | Maximum bubble territory | 5.21 – 7.03 |
| 7 | Sell. Seriously, SELL! | 3.86 – 5.21 |
| 6 | FOMO Intensifies | 2.86 – 3.86 |
| 5 | Is this a bubble? | 2.12 – 2.86 |
| 4 | HODL! | 1.57 – 2.12 |
| 3 | Still cheap | 1.16 – 1.57 |
| 2 | Accumulate | 0.861 – 1.16 |
| 1 | BUY! | 0.638 – 0.861 |
| 0 | Fire sale! | 0.472 – 0.638 |

Band 2 contains the fit line (ratio 1.0), which is the offset's whole purpose. The ladder reaches
**0.472× below** and **7.03× above** — asymmetric by design.

### `band_of()` uses CEIL, not FLOOR

Band `i` spans natural-log offsets `[(i−2.5)·0.3, (i−1.5)·0.3]`. The **top** edge is `(i−1.5)·0.3`,
so inverting for `i` gives:

```
i = ceil(r / 0.3 + 1.5)          r = ln(price) − ln(fit)
```

Using `floor` lands one band low everywhere and reports "below the scale" for prices plainly inside
band 0. Two anchors pin it, both asserted in the test suite:

* `r = 0` (price exactly on the fit) → band **2**, "Accumulate"
* `r = 1.95` (the very top) → band **8**

Out of range returns `−1` (below) or `9` (above) rather than clamping, so a caller can say "off the
scale" instead of quietly pinning to an edge — which matters, because ~14% of history is off it.

---

## 3. Supply and market cap

### The emission schedule

`supply_at(date)` walks the halving epochs. Boundaries are the four real halving dates —
2012-11-28, 2016-07-09, 2020-05-11, 2024-04-20 — then `+210,000 blocks ≈ 1458.33 days` per epoch.
Each epoch mints exactly `210,000 × reward`, interpolated linearly inside it.

```
epoch 0 …  3:  210,000 × (50 + 25 + 12.5 + 6.25)  =  19,687,500 BTC by the 4th halving
terminal:                                             21,000,000 BTC
```

This is the **schedule, not the chain**. Real blocks have run slightly slower than the idealised
epoch, so it reads about 0.5% high against a live node (≈20.07M vs ≈19.95M in mid-2026). That is the
trade the whole repository makes: deterministic and offline beats live and unreproducible.

> **Implementation trap.** The step is 1458.33 days. In Python, `date + timedelta(days=1458.33)`
> silently truncates the fractional day, while `datetime + timedelta(...)` keeps it. Truncating puts
> every scheduled boundary up to a third of a day early and pulls the Python result off the
> JavaScript one by a few dozen coins. `supply_at()` widens to `datetime` for exactly this reason —
> and the parity test is what caught it.

### The market-cap axis

```
marketcap_axis(price_ticks) = [p × 21,000,000 for p in price_ticks]
```

The axis is the price axis **rescaled**, so every market-cap tick shares a gridline with its price:

| price | market cap |
|---|---|
| $0.01 | $210k |
| $1 | $21M |
| $1k | $21B |
| $100k | $2.1T |
| $1M | $21T |

In matplotlib this needs forcing: left alone, `twinx()` picks its own round decades ($1T, $10T) which
land *between* the price gridlines and read as a second, subtly misaligned scale. `add_marketcap_axis()`
pins the ticks to the price decades rescaled.

For a market cap at a **past** date, use `marketcap_at(price, date)`, which multiplies by the supply
actually emitted by then. The axis answers "worth at full emission"; `marketcap_at` answers "worth
on the day". They are different questions and the API keeps them apart.

---

## 4. The JavaScript renderer

`js/rainbow-chart.js`, ~450 lines, no dependencies, no network calls.

### The embedded series

The price history ships **inside the file**: weekly closes (every 7th day from `x = 1`), delta-encoded
as `log10(USD) × 1000` rounded to integers, joined by commas. 835 points, about 4 KB of text.

```js
acc = 0; for each delta d:  acc += d;  series[i] = acc / 1000     // log10 USD
```

The final point is the true last close, which does not land on the weekly stride — `seriesX(i)`
returns `SERIES_LAST_X` for it rather than `1 + i·7`.

Weekly resolution is a deliberate loss: at chart scale a daily series is thousands of extra points
that render as the same line. The delta encoding keeps a decade and a half of history smaller than a
logo.

### Rendering

* SVG built with `createElementNS`, **never** `innerHTML` — the file is CSP-safe and drops into a
  strict `script-src 'self'` policy unmodified.
* The bands are polygons sampled at 240 steps along the fit. Sampling (rather than a path with
  curves) keeps the geometry identical to what the Python `fill_between` produces.
* Bands are drawn **opaque**. Translucent fills over a dark background desaturate into mud and the
  mid-bands vanish; the reference uses `alpha=1` and so does this.
* The vertical window is pinned to the painted range itself — the bottom of band 0 where the arc
  starts, the top of band 8 where it ends — so the rainbow fills the canvas instead of floating in it.
* The forward window defaults to **9 months** past the last close, matching the reference's
  `EXTEND_MONTHS`, and `to:` walks it out as far as you like (see below).

### Layout

The frame is **1240 × 600**, about 2.07:1 — close to the reference figure's 15 × 7. The arc wants
width: it is a shallow curve, and a squarer frame makes it read as a diagonal stripe.

```
┌────────────────────────────────────────────────────────────────────────┐
│ PRICE                                                     MARKET CAP   │
│  $1M ┤ ┌──────────────────────┐                    ╭───────╮   $21T    │
│      │ │ ■ BTC price          │      ╭─────────────╯                   │
│ $100k┤ │ ■ Maximum bubble …   │ ╭────╯                        $2.1T    │
│      │ │ … nine bands, each   │─╯                                      │
│ $10k ┤ │   in its own colour  │              ┌────────────┐   $210B    │
│      │ │ │ halvings: 4 actual │              │ readout    │            │
│  $1k ┤ └──────────────────────┘              │ card       │    $21B    │
│      │╯                                      └────────────┘            │
│      └──────────────────────────────────────────────────────────────   │
│        2011   2013   2015   2017   2019   2021   2023   2025   2027    │
│          1              2            3          4                      │
└────────────────────────────────────────────────────────────────────────┘
```

**The key sits in the top-left, inside the plot.** The arc climbs from the bottom-left to the
top-right, so the corner above the early years is dead space in every window the chart can draw —
and the wider the window, the more of it there is. Putting the key there costs the plot nothing,
where a banner across the top costs a strip of height and a right-margin column costs the
market-cap axis. Each label is painted in **its own band's colour**, so the word is its own sample.

Two placements that were tried and are wrong:

* **Right margin.** The bands converge as the arc flattens, so all nine labels bunch into the top
  fifth of the canvas, overlap each other, and the ninth clips off the top edge entirely.
* **Banner across the top.** Ten items do not fit one row at this width, so it wraps to two and
  eats ~50px of plot height on every render.

**The readout card** sits in the bottom-right, which is empty for the same reason the top-left is.
Text placed near the dot lands on nine saturated colours and cannot be read; the card gets a
backing plate and a dashed leader line to the dot instead. The legend gets a plate too — the decade
gridlines run the full width of the plot and would otherwise strike through it.

### Long windows

`to:` accepts any year. The fit does not stop at the edge of the record, and the magnitudes it
reaches are worth stating:

| the fit crosses | around |
|---|---|
| $1M / coin | 2035 |
| $10M | 2051 |
| $100M | 2075 |
| **$1B** | **2113** |
| $1T | 2419 |

At `to: 2140` — the end of emission — the price axis runs $0.10 → $10B, the market-cap axis runs
$2.1M → $210Q, and **all 32 halvings** are on the canvas: four solid (history), 28 dashed
(schedule). Three things adapt so that stays readable:

* **Year ticks** pick a nice step (1, 2, 5, 10, 20, 25, 50, 100) targeting ≤ 18 ticks. At one tick
  per year a 130-year window prints 130 labels as a grey smear.
* **Halving ordinals** are labelled every halving when they are ≥ 46px apart, every fourth when
  ≥ 22px, and not at all below that. The lines are always drawn — the rhythm is the point.
* **`usdLabel` runs to quadrillions.** Stopping at `T` printed `$469674T` for the top band's market
  cap in 2140. Past a quintillion it prints an exponent instead of inventing a suffix.

None of this makes the extrapolation meaningful — see [explanation.md](explanation.md). It makes
the absurdity *legible*, which is the honest thing for a chart to do with its own far end.

### API

```js
RainbowChart.render(mount, { to, height, width, theme })  // returns {svg, lastUsd, lastX, band}
RainbowChart.fit(x)                                 // USD at day index x
RainbowChart.bandOf(usd, x)                         // 0..8, or -1 / 9 off-scale
RainbowChart.supplyAt(ms)                           // BTC from the emission schedule
RainbowChart.marketcapAt(usd, ms)                   // USD
RainbowChart.usdLabel(p)                            // "$21T", "$2.1T", "$65"
RainbowChart.FIT / .BANDS / .SERIES / .TERMINAL_SUPPLY / .THEME
```

Self-boots into `[data-rainbow-chart]` and `[data-luvrainbowchart]` mounts. Exports as
`window.RainbowChart`, `window.DVLuvRainbowChart`, and CommonJS `module.exports`.

---

## 5. Parity

`tests/test_parity.py` runs the JavaScript under node and compares it to the Python core across
8 day indices × 8 prices for band membership, 8 dates for supply, and every constant:

* fit coefficients, band width, band offset, terminal supply
* the nine colours and labels, in order
* `fit(x)` to 1e-12 relative
* `bandOf(price, x)` exactly, at 64 combinations
* `supplyAt(date)` to 1e-6 relative
* `usdLabel(price)` string-identical

Plus pure-Python invariants: bands tile with no gap or overlap, the fit line is always band 2, the
ladder is 0.472×–7.03×, supply is monotone and converges on 21M, day-index round-trips survive the
2010-08-17 gap.

If node is absent the cross-implementation checks skip and the invariants still run.

```
$ python tests/test_parity.py
  PASS  test_band_of_anchors
  PASS  test_bands_tile_without_gaps
  PASS  test_day_index_round_trips_across_the_gap
  PASS  test_js_matches_python
  PASS  test_ladder_is_asymmetric_as_documented
  PASS  test_marketcap_axis_is_a_clean_rescale
  PASS  test_supply_schedule_hits_the_textbook_numbers

all green
```

---

## 6. Changes from upstream

| | upstream | here |
|---|---|---|
| market-cap axis | — | right margin, pinned to price decades |
| shared core | — | `src/rainbow.py`, dependency-free |
| JS renderer | — | `js/rainbow-chart.js`, zero deps |
| parity test | — | `tests/test_parity.py` |
| ccxt import | at module load, instantiates every exchange | lazy, only when refreshing |
| offline mode | — | `--offline`; staleness reported, not silently repaired |
| duplicate dates | kept | dropped before fitting |
| `create_plot` | returns `None` | returns `(fig, ax)` |
| CLI | `save` kwarg in code | `--save --offline --report --no-marketcap` |

The band arithmetic, colour scale, halving lines and top legend are unchanged. That is deliberate:
the point of a rainbow chart is that it is *the same chart everyone else is looking at*.
