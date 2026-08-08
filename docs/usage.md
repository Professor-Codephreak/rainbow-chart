# Usage

Three ways to run the chart: [Python](#python), [JavaScript](#javascript), [mindX](#mindx).
For the arithmetic see [technical.md](technical.md); for what it means, [explanation.md](explanation.md).

---

## Python

### Install

```bash
git clone https://github.com/Professor-Codephreak/rainbow-chart.git
cd rainbow-chart
pip install -r requirements.txt
```

`ccxt` is only needed to refresh the price series. To draw from the bundled CSV, the other four
packages are enough — and for the read-only API (`src/rainbow.py`) you need nothing at all beyond
the standard library.

### Draw it

```bash
python src/main.py                    # open a window
python src/main.py --save             # write img/bitcoin_rainbow_chart.png
python src/main.py --save --out /tmp/rainbow.png
```

| flag | effect |
|---|---|
| `--save` | write a PNG instead of opening a window (switches to the Agg backend) |
| `--out PATH` | where `--save` writes |
| `--offline` | never fetch; draw from the CSV as it stands and say how old it is |
| `--no-marketcap` | drop the right-hand market-cap axis |
| `--report` | print where the last close stands; draw nothing |

By default, if the CSV is more than a day stale, `get_data()` fetches the gap from Binance via ccxt
and writes it back. If that fails — no network, no ccxt, exchange geoblocked — it says so and draws
from the CSV rather than raising.

### Read it

```bash
$ python src/main.py --offline --report
Offline: drawing from a CSV that is 806 days old.
  2024-05-24
  price       $68.5k  (68,549.99)
  the fit     $57.3k
  ratio       1.195x the fit
  band        3 — Still cheap
  market cap  $1.35T
  fitted on   5,030 daily closes
```

### The core API

`src/rainbow.py` has no dependencies and does no plotting. Import it anywhere.

```python
import datetime as dt
import sys; sys.path.insert(0, "src")
import rainbow as R

x = R.date_to_day_index(dt.date(2026, 8, 8))

R.fit_value(x)                      # 115378.06   the curve, in USD, that day
R.band_of(65013, x)                 # 0           "Fire sale!"
R.BANDS[0]                          # ('#4472c4', 'Fire sale!')
R.band_bounds(2, x)                 # (99306.81, 134050.18)  the "Accumulate" band that day

R.supply_at(dt.date(2026, 8, 8))    # 20065500.86  BTC, from the emission schedule
R.marketcap_at(65013, dt.date(2026, 8, 8))   # 1.3045e12
R.marketcap_axis([1e3, 1e4, 1e5])   # [2.1e10, 2.1e11, 2.1e12]
R.usd_label(2.1e12)                 # '$2.1T'

R.PUBLISHED_FIT                     # Fit(a=5.0222935652, b=383.8277947247, c=-32.2162634088, …)
R.fit_from_series([...])            # refit your own closes (needs scipy)
```

Everything takes an optional `fit=` argument, so you can drive it from your own regression:

```python
mine = R.fit_from_series(my_daily_closes)
R.band_of(price, x, fit=mine)
```

### Tests

```bash
python tests/test_parity.py         # standalone
python -m pytest tests/ -v          # or under pytest
```

The parity test runs the JavaScript under node and fails if the two implementations disagree. If
node is not installed those checks skip and the pure-Python invariants still run.

---

## JavaScript

### Drop it in

```html
<div data-rainbow-chart data-height="600"></div>
<script src="rainbow-chart.js"></script>
```

That is the whole integration. The script self-boots into any `[data-rainbow-chart]` mount on
`DOMContentLoaded`, and the price series is embedded in the file — no build step, no bundler, no
fetch, no CDN. Open `js/example.html` from disk with the network off and it draws.

| attribute | meaning |
|---|---|
| `data-to="2030"` | draw out to January of this year (default: 9 months past the last close) |
| `data-height="600"` | SVG height in viewBox units (width is fixed at 1000 and scales) |

### Call it

```js
const chart = RainbowChart.render(mount, { to: 2030, height: 600 });
// → { svg, lastUsd, lastX, band }

RainbowChart.fit(5836)                  // 115378.06   the curve at that day index
RainbowChart.bandOf(65013, 5836)        // 0
RainbowChart.BANDS[0].name              // 'Fire sale!'

const when = RainbowChart.msOf(5836);
RainbowChart.supplyAt(when)             // 20065500.86
RainbowChart.marketcapAt(65013, when)   // 1.3045e12
RainbowChart.usdLabel(2.1e12)           // '$2.1T'
```

### Re-theme it

Every colour is overridable; unspecified keys fall back to the house palette.

```js
RainbowChart.render(mount, {
  theme: { bg: '#0d1117', ink: '#ffffff', dim: '#8b949e', price: '#ffffff', dot: '#f85149' }
});
```

The nine **band** colours are deliberately not themeable — they are the shared vocabulary that makes
one rainbow chart comparable to another. Edit `BANDS` if you really mean to break that.

### Sizing

The SVG is `width: 100%; height: auto`. Put it in a container with `overflow-x: auto` and a
`min-width` on the SVG so it scrolls rather than crushes on narrow screens:

```css
.chart { overflow-x: auto }
.chart svg { display: block; width: 100%; height: auto; min-width: 760px }
```

### Content Security Policy

The file builds its SVG with `createElementNS` and never touches `innerHTML`, `eval`, or inline
handlers. It runs unmodified under:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'
```

Serve it as a normal external script. It makes no network requests of any kind.

---

## mindX

The chart is exposed to [mindX](https://github.com/agenticplace/mindX) as a `BaseTool`.

### Install

```bash
cp mindx/rainbow_chart_tool.py   ~/mindX/tools/
mkdir -p                         ~/mindX/tools/rainbow_chart
cp src/rainbow.py                ~/mindX/tools/rainbow_chart/
touch                            ~/mindX/tools/rainbow_chart/__init__.py

# optional: point at this checkout so `render` can draw and refit
export MINDX_RAINBOW_CHART_PATH=$(pwd)
```

The vendored `rainbow.py` is standard-library-only, so the read actions work on any mindX host with
no plotting stack and no network.

### Actions

| action | needs | returns |
|---|---|---|
| `report` | core only | where a price stands: fit, ratio, band, market cap, a one-line reading |
| `bands` | core only | the nine bands priced for a date |
| `marketcap` | core only | supply, market cap on the day, market cap at terminal supply |
| `fit` | core only | the published coefficients, with the caveat attached |
| `render` | matplotlib + CSV | writes a PNG, market-cap axis included |

```python
from tools.rainbow_chart_tool import RainbowChartTool

tool = RainbowChartTool()

await tool.execute(action="report", price=65013, date="2026-08-08")
# {'success': True, 'price_label': '$65k', 'fit_label': '$115k', 'ratio': 0.563,
#  'band': 0, 'band_name': 'Fire sale!', 'marketcap_label': '$1.3T',
#  'reading': '$65k is 0.56x the fitted curve ($115k) — band 0, "Fire sale!".',
#  'caveat': 'a description of past price, not a target'}

await tool.execute(action="bands", date="2026-08-08")
await tool.execute(action="marketcap", price=65013, date="2026-08-08")
await tool.execute(action="render", output_path="/tmp/rainbow.png")
```

### Notes for agents

* **The tool holds no price feed.** It never reaches the network, by design. `report` and
  `marketcap` require an explicit `price=`; getting one is another tool's job. Asking without a
  price returns a `success: False` that says so rather than inventing a number.
* **`render` degrades instead of raising.** If matplotlib or the CSV is missing it returns an
  explanation and points at the read actions, so a plan that asked for a picture still gets the
  number it was really after.
* **Every answer carries its caveat.** `report` returns `caveat`, `fit` returns a note about R².
  Pass them through — the band name is sentiment vocabulary attached to a regression, and a plan
  that quotes "Fire sale!" as a conclusion has lost the thing that made it meaningful.
* `render` runs matplotlib in an executor, so it does not block the event loop.
