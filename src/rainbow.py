"""
rainbow.py — the arithmetic of the Bitcoin rainbow chart, with no plotting and no dependencies.

This is the shared core. `plot.py` renders it with matplotlib; `js/rainbow-chart.js` renders the
same numbers as SVG in a browser. Keeping the arithmetic in one dependency-free module is what
lets the two renderers be checked against each other (see `tests/test_parity.py`).

THE ARC
-------
The rainbow is a logarithmic regression on LINEAR time, which is what bends it into an arc:

    ln(price) = a * ln(b + x) + c        x = 1 for the first priced day, +1 per priced day

Plotted the other way — log time against log price — the same fit straightens into a diagonal
ruler. Both are honest; only the arc is the rainbow chart, because the arc is the shape the
regression actually has against the calendar people read.

Note that x is the ROW INDEX of the price series, not days since the genesis block. That is what
the reference implementation fits on, and it is kept so this chart is comparable to every other
rainbow drawn from that method.

THE BANDS
---------
Nine bands, each 0.3 wide in natural log, offset (i - 1.5) from the fit:

    band i spans exp(fit + (i-1.5)*0.3 - 0.3) ... exp(fit + (i-1.5)*0.3)

That offset puts the fit line inside band 2 ("Accumulate") and makes the ladder ASYMMETRIC: it
reaches 0.472x below the fit but 7.03x above. The chart was drawn with room for manias.

MARKET CAP
----------
`marketcap_axis()` rescales the price axis by the 21,000,000 terminal supply, so a market-cap tick
sits on exactly the same gridline as its price tick — one geometry, two readings. For a market cap
at a PAST date, use `marketcap_at()`, which multiplies by the supply actually emitted by then.
"""

from __future__ import annotations

import datetime as _dt
import math
from dataclasses import dataclass
from typing import Iterable, Sequence

__all__ = [
    "Fit", "PUBLISHED_FIT", "BANDS", "NAMES", "PALETTES", "bands_for", "BAND_WIDTH", "BAND_OFFSET", "TERMINAL_SUPPLY",
    "HALVINGS", "fit_value", "band_of", "band_bounds", "supply_at", "marketcap_at",
    "marketcap_axis", "usd_label", "day_index_to_date", "date_to_day_index", "fit_from_series",
]

# ── the fit ───────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Fit:
    """Coefficients of ln(price) = a * ln(b + x) + c, plus the provenance of the refit."""

    a: float
    b: float
    c: float
    r2: float = float("nan")
    n: int = 0
    start: str = ""
    end: str = ""

    def __call__(self, x: float) -> float:
        """The fit, in USD, at day index x."""
        return math.exp(self.a * math.log(self.b + x) + self.c)


#: Refit on 5,836 daily closes, 2010-08-16 -> 2026-08-08 (the reference CSV extended with Binance
#: BTC/USDT daily closes). The JS renderer carries these same numbers, so both agree by default.
#: Refitting from the shipped CSV alone (which ends 2024-05-24) gives a=5.0245684461,
#: b=384.9634287322, c=-32.2390224708 — a curve that differs from this one by 0.2% at the far end.
PUBLISHED_FIT = Fit(
    a=5.0222935652, b=383.8277947247, c=-32.2162634088,
    r2=0.961197, n=5836, start="2010-08-16", end="2026-08-08",
)

BAND_WIDTH = 0.3        # natural log, per the reference
BAND_OFFSET = 1.5       # the reference's i_decrease
TERMINAL_SUPPLY = 21_000_000

#: The nine labels, bottom band first — the same words on every palette.
NAMES: tuple[str, ...] = (
    "Fire sale!", "BUY!", "Accumulate", "Still cheap", "HODL!",
    "Is this a bubble?", "FOMO Intensifies", "Sell. Seriously, SELL!", "Maximum bubble territory",
)

#: The two colour scales, bottom band first. ``classic`` is the reference palette, kept verbatim —
#: it is what makes one rainbow chart comparable to every other, and it is the default. ``house``
#: is the trader's ramp SHAMBA LUV draws: the fire zone is red, the centre band is bitcoin orange
#: (#F7931A), and the far top — where you sell — is candle green. Same geometry, same words; only
#: the ink changes. The JavaScript carries both under the same names, and the parity test checks
#: both.
BTC_ORANGE = "#F7931A"
PALETTES: dict[str, tuple[str, ...]] = {
    "classic": ("#4472c4", "#54989f", "#63be7b", "#b1d580", "#feeb84", "#f6b45a", "#ed7d31", "#d64018", "#c00200"),
    "house":   ("#d81e3c", "#e5402c", "#ee5f22", "#f47a1c", BTC_ORANGE, "#e8a91e", "#d3bd25", "#8ec43a", "#0ecb81"),
}


def bands_for(palette: str = "classic") -> tuple[tuple[str, str], ...]:
    """(colour, label) for each of the nine bands, bottom first, on the named palette."""
    cols = PALETTES.get(palette, PALETTES["classic"])
    return tuple(zip(cols, NAMES))


#: The reference colour scale and labels, bottom band first.
BANDS: tuple[tuple[str, str], ...] = bands_for("classic")

#: The four halvings that have happened; the schedule then steps 210,000 blocks (~1458.33 days).
HALVINGS = (
    _dt.date(2012, 11, 28),
    _dt.date(2016, 7, 9),
    _dt.date(2020, 5, 11),
    _dt.date(2024, 4, 20),
)
HALVING_STEP_DAYS = 1458.33
GENESIS = _dt.date(2009, 1, 3)

#: x = 1 lands on the first priced day. Across 2010-08-16 -> 2026-08-08 the series has exactly one
#: gap (2010-08-17), so from x = 2 onward the index runs one day ahead of a naive (x - 1) offset.
#: Correcting for it keeps year ticks and the "today" marker on their true dates.
FIRST_PRICED_DAY = _dt.date(2010, 8, 16)


def fit_value(x: float, fit: Fit = PUBLISHED_FIT) -> float:
    """The fit, in USD, at day index x."""
    return fit(x)


def fit_from_series(values: Sequence[float]) -> Fit:
    """
    Least-squares refit of ln(price) = a*ln(b+x)+c over a sequence of positive daily closes.

    Requires scipy. Kept here so the core can refit as well as read the published coefficients;
    everything else in this module is dependency-free.
    """
    import numpy as np
    from scipy.optimize import curve_fit

    y = np.log(np.asarray([v for v in values if v > 0], dtype=float))
    x = np.arange(1, len(y) + 1, dtype=float)

    def _f(x, a, b, c):
        return a * np.log(b + x) + c

    popt, _ = curve_fit(_f, x, y)
    residual = y - _f(x, *popt)
    r2 = 1.0 - float(np.sum(residual ** 2) / np.sum((y - y.mean()) ** 2))
    return Fit(a=float(popt[0]), b=float(popt[1]), c=float(popt[2]), r2=r2, n=len(y))


# ── the bands ─────────────────────────────────────────────────────────────────────────────────


def band_bounds(i: int, x: float, fit: Fit = PUBLISHED_FIT) -> tuple[float, float]:
    """(lower, upper) USD bounds of band i at day index x."""
    ln_fit = math.log(fit(x))
    lo = (i - BAND_OFFSET) * BAND_WIDTH - BAND_WIDTH
    hi = (i - BAND_OFFSET) * BAND_WIDTH
    return math.exp(ln_fit + lo), math.exp(ln_fit + hi)


def band_of(usd: float, x: float, fit: Fit = PUBLISHED_FIT) -> int:
    """
    Which band a price sits in at day index x: 0..8, or -1 below / 9 above the painted range.

    CEIL, not floor. Band i spans natural-log offsets [(i-2.5)*0.3, (i-1.5)*0.3] — the top edge is
    (i-1.5)*0.3, so inverting for i gives ceil(r/0.3 + 1.5). Using floor lands one band low
    everywhere. Sanity anchors: r = 0 (price exactly on the fit) must give band 2, "Accumulate";
    r = 1.95 (the very top) must give band 8. Returns -1/9 rather than clamping, so a caller can
    say "off the scale" instead of quietly pinning to an edge.
    """
    r = math.log(usd) - math.log(fit(x))
    i = math.ceil(r / BAND_WIDTH + BAND_OFFSET)
    return -1 if i < 0 else 9 if i > 8 else i


# ── supply and market cap ─────────────────────────────────────────────────────────────────────


def _as_datetime(d) -> _dt.datetime:
    """Widen a date to a datetime so fractional-day arithmetic survives."""
    if isinstance(d, _dt.datetime):
        return d
    return _dt.datetime(d.year, d.month, d.day)


def supply_at(when) -> float:
    """
    Circulating supply implied by the EMISSION SCHEDULE at a date.

    Epoch boundaries are the four real halving dates, then +210,000 blocks (~1458.33 days) per
    epoch; each epoch mints exactly 210,000 * reward, interpolated linearly inside it. This is the
    schedule, not the chain: real blocks have run a little slower than the idealised epoch, so this
    reads ~0.5% high against a live node. It is deterministic and offline, which is the trade the
    rest of this module makes too.

    Epochs are walked as datetimes, not dates: the step is 1458.33 days, and `date + timedelta`
    silently drops that 0.33 while `datetime + timedelta` keeps it. Truncating it puts every
    scheduled boundary up to a third of a day early and pulls this function off the JavaScript
    renderer by a few dozen coins — small, but the two implementations then disagree, which is the
    one thing they are not allowed to do.
    """
    when = _as_datetime(when)
    if when <= _as_datetime(GENESIS):
        return 0.0

    bounds: list[_dt.datetime] = [_as_datetime(GENESIS), *(_as_datetime(h) for h in HALVINGS)]
    last = bounds[-1]
    while len(bounds) < 34:
        last = last + _dt.timedelta(days=HALVING_STEP_DAYS)
        bounds.append(last)

    supply = 0.0
    for e in range(len(bounds) - 1):
        reward = 50 / (2 ** e)
        if reward < 1e-9 or when <= bounds[e]:
            break
        span = (bounds[e + 1] - bounds[e]).total_seconds()
        done = (when - bounds[e]).total_seconds()
        supply += 210_000 * reward * min(1.0, done / span)
    return min(supply, float(TERMINAL_SUPPLY))


def marketcap_at(usd: float, when: _dt.date) -> float:
    """Market cap of a price at a date — price times the supply actually emitted by then."""
    return usd * supply_at(when)


def marketcap_axis(price_ticks: Iterable[float]) -> list[float]:
    """
    Rescale price ticks to market-cap ticks at the terminal supply.

    At 21,000,000 coins the two axes are the same statement in different units, so every tick is
    exact and lands on the gridline it shares with its price. This is the secondary axis the chart
    draws; it is a rescale, not a second measurement.
    """
    return [p * TERMINAL_SUPPLY for p in price_ticks]


# ── calendar <-> day index ────────────────────────────────────────────────────────────────────


def day_index_to_date(x: int) -> _dt.date:
    """Calendar date of day index x, correcting for the single 2010-08-17 gap."""
    return FIRST_PRICED_DAY + _dt.timedelta(days=(x if x >= 2 else x - 1))


def date_to_day_index(when: _dt.date) -> int:
    """Day index of a calendar date, correcting for the single 2010-08-17 gap."""
    n = (when - FIRST_PRICED_DAY).days
    return 1 if n <= 0 else n if n >= 2 else 2


# ── labels ────────────────────────────────────────────────────────────────────────────────────


def _trim(v: float) -> str:
    """Three significant figures without the trailing-zero noise: 21.0 -> '21', 2.10 -> '2.1'."""
    s = str(round(v)) if v >= 100 else f"{v:.3g}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def usd_label(p: float) -> str:
    """
    Compact USD label matching the JS renderer exactly: $21T, $2.1T, $210B, $65, $0.10.

    Runs to quadrillions, because a long extrapolation gets there: the top band in 2140 is ~$22B
    per coin, which is $470Q of market cap. Stopping at 'T' printed "$469674T", a number nobody can
    read at a glance. Past a quintillion it gives up on suffixes and prints an exponent, which is
    the honest way to say "this is off the end of the vocabulary".
    """
    if p >= 1e18:
        return f"${_trim(p / 1e18)}e18"
    if p >= 1e15:
        return f"${_trim(p / 1e15)}Q"
    if p >= 1e12:
        return f"${_trim(p / 1e12)}T"
    if p >= 1e9:
        return f"${_trim(p / 1e9)}B"
    if p >= 1e6:
        return f"${_trim(p / 1e6)}M"
    if p >= 1e3:
        return f"${_trim(p / 1e3)}k"
    if p >= 1:
        return f"${round(p)}"
    return f"${p:.2f}"
