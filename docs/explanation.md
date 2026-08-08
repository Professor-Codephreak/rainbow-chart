# The rainbow chart, explained

## One idea

Bitcoin's price has spent sixteen years oscillating around a slowly-bending curve. The rainbow
chart draws that curve, stacks nine coloured bands around it, and plots the price on top. Its whole
claim is that **where price sits relative to the curve says more than the number itself** — that
$65,000 is a different fact in 2019 than in 2026, and the curve is what carries the difference.

That is the entire idea. Everything below is either the arithmetic that implements it or the
reasons not to trust it too far.

## Why it is an arc

The fit is a logarithmic regression against **linear time**:

```
ln(price) = a · ln(b + x) + c
```

where `x` counts priced days from the first one. Plotted against a normal calendar with a log price
axis, that function *bends*: fast through the early years, flattening as the logarithm tires. The
bend is the arc, and the arc is the chart.

Plot the same fit on **log-log** axes — log time against log price — and it straightens into a
diagonal ruler. Both pictures are honest, and the straight one is genuinely better for judging a
long extrapolation, because nothing hides in curvature. But the straight version is not the rainbow
chart. The arc is the shape the regression actually has against the calendar people read, and
reading it is the point.

There is a display consequence worth stating plainly. On log-time axes the early years eat the
canvas: 2010–2011 takes about a fifth of the width while 2020–2026 gets an eighth. A viewer trying
to answer "where are we now" spends most of the chart looking at the era when Bitcoin cost less
than a dollar. The arc spends its width the other way round, which is why this repository draws it.

## The nine bands

Each band is **0.3 wide in natural log** — a constant multiple of about 1.35× — and the ladder is
offset so the fit line falls inside band 2, "Accumulate". That offset is what makes the scale
**asymmetric**:

| | multiple of the fit |
|---|---|
| bottom of band 0 | **0.472×** |
| top of band 8 | **7.03×** |

It reaches barely half-way down but seven times up, because the chart was designed with room for
manias. That asymmetry is inherited from the reference implementation and kept verbatim here, so
this chart is comparable to every other rainbow drawn from the same method.

The band names — "Fire sale!", "HODL!", "Maximum bubble territory" — are the classic vocabulary.
They are sentiment labels attached to arithmetic, not conclusions the arithmetic reached.

## What it is not

**The bands are not a model of anything.** They are a regression through past prices plus a colour
ramp chosen by eye. There is no economic mechanism underneath — no stock-to-flow argument, no
adoption curve, no demand equation. It is a description of one era's history.

**The fit moves.** It is refitted every time new data arrives, so the curve quietly relocates to
keep explaining whatever just happened. A price that was "above the curve" last year can become
"on the curve" this year without moving, simply because the curve came to it.

**A high R² proves less than it looks like.** The published fit scores R² ≈ 0.96, which sounds
decisive. But *any* smooth increasing curve fits sixteen years of log-scaled exponential growth
well. The R² is measuring "did we draw a rising line through a rising thing", not "did we find the
law".

**History does not stay inside it.** Only about **86%** of daily closes fall within the painted
range at all; the rest sit above or below the whole rainbow. The chart has no colour for those days,
which is worth noticing rather than smoothing over.

**Extrapolation gets absurd quickly.** Pushed to 2100 the same fit hands back hundreds of millions
of dollars per coin. That is not a forecast; it is the curve confessing that it describes one era
and not the next eleven.

Read it as a mood ring, not a price target.

## Market cap

This fork adds a second axis: for every price level, the corresponding **market cap**.

The axis is the price axis rescaled by the 21,000,000 terminal supply, so a market-cap tick sits on
exactly the gridline of the price it belongs to — one geometry, two readings of the same fact. It
is a rescale, not a second measurement, which is precisely why it can share the geometry without
the two scales ever drifting apart.

That choice has an edge worth naming. Market cap at a *past* date is price × the supply that
actually existed then, and in 2012 that was about half of today's. The axis answers "what would
this price be worth at full emission"; `marketcap_at(price, date)` answers "what was this price
worth on the day". The chart's readout card uses the second one. Both are in the API because they
answer different questions and conflating them is how market-cap charts mislead.

## Rainbow-weighted averaging

The strategy the chart is usually paired with: instead of buying a fixed amount on a fixed
schedule, scale each buy by which band the price is in — heavier in the blue bands, lighter or
nothing in the red. The idea is credited to Reddit's /u/pseudoHappyHippy, and the
[CoinMonks write-up](https://medium.com/coinmonks/using-python-to-analyze-rainbow-weighted-averaging-a-more-profitable-frequency-investment-12009a8c3617)
reports it beating plain dollar-cost averaging 96.8% of the time, by an average of 35.3% greater
returns on historical BTC data.

**Read that number carefully.** It is a backtest against the same price history the bands were
fitted to. A rule that buys more when price is far below a curve drawn through that price will,
mechanically, look good on it — the curve knows where the dips were because it was drawn after
they happened. The honest version of that result would fit the bands on one period and test the
weights on a later one, out of sample.

No weights are published in this repository for exactly that reason. The band a price sits in is
available from the API; what to do about it is not something this code claims to know.

## Provenance

Method, colour scale and band geometry come from
[StephanAkkerman/bitcoin-rainbow-chart](https://github.com/StephanAkkerman/bitcoin-rainbow-chart),
which renders it in matplotlib from Nasdaq Data Link plus Binance and takes its palette from
CoinGlass. This fork keeps that renderer, adds the market-cap axis, and adds a second renderer in
JavaScript that draws the same arithmetic as SVG in a browser with no dependencies and no network
calls.

The two implementations are held to each other by `tests/test_parity.py`, which runs both and fails
if they disagree. See [technical.md](technical.md) for the arithmetic and
[usage.md](usage.md) for how to run them.

Nothing here is financial advice. The chart is arithmetic.
