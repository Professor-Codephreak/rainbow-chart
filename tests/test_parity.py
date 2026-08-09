"""
test_parity.py — the two renderers must agree.

`src/rainbow.py` and `js/rainbow-chart.js` carry the same fit, the same bands and the same supply
schedule. Nothing enforces that except this test: it runs the JavaScript under node, asks both
implementations the same questions, and fails if the answers diverge.

    python -m pytest tests/ -v          # or just: python tests/test_parity.py

If node is not installed the JS comparisons skip; the pure-Python invariants still run.
"""

import json
import math
import os
import shutil
import subprocess
import sys
import datetime as dt

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import rainbow as R  # noqa: E402

JS = os.path.join(os.path.dirname(__file__), "..", "js", "rainbow-chart.js")
NODE = shutil.which("node")

# Day indices spread across the whole series and into the forward window.
X_PROBES = [1, 2, 100, 1000, 2500, 5000, 5836, 7000, 23535, 37448, 47000]
# The upper probes reach where a long extrapolation actually goes: the fit passes $1M/coin around
# 2035, $100M around 2075 and $1B around 2113, and market cap at the terminal supply is 21,000,000x
# each of those. Without probes up here the label formatters could disagree above a trillion and
# every test would still pass — which is exactly what happened once.
PRICE_PROBES = [0.06, 1.0, 100.0, 1000.0, 20000.0, 65013.0, 250000.0, 5_000_000.0,
                1e9, 2.24e10, 4.7e14, 4.7e17, 2.1e19]
DATE_PROBES = ["2009-01-03", "2012-11-28", "2016-07-09", "2020-05-11",
               "2024-04-20", "2026-08-08", "2040-01-01", "2140-01-01"]


def _js():
    """Ask the JavaScript the same questions and hand back its answers."""
    script = """
    const R = require(process.argv[1]);
    const X = %s, P = %s, D = %s;
    const out = {
      fit: X.map(x => R.fit(x)),
      band: [], supply: D.map(d => R.supplyAt(Date.parse(d + 'T00:00:00Z'))),
      label: P.map(p => R.usdLabel(p)),
      constants: { a: R.FIT.a, b: R.FIT.b, c: R.FIT.c,
                   bandWidth: R.BAND_WIDTH, bandOffset: R.BAND_OFFSET,
                   terminal: R.TERMINAL_SUPPLY, bands: R.BANDS.map(b => [b.col, b.name]) }
    };
    for (const x of X) for (const p of P) out.band.push(R.bandOf(p, x));
    console.log(JSON.stringify(out));
    """ % (json.dumps(X_PROBES), json.dumps(PRICE_PROBES), json.dumps(DATE_PROBES))
    raw = subprocess.run([NODE, "-e", script, os.path.abspath(JS)],
                         capture_output=True, text=True, check=True)
    return json.loads(raw.stdout)


def _close(a, b, tol=1e-9):
    """Relative closeness, so the comparison survives float formatting on both sides."""
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


# ── pure-Python invariants ────────────────────────────────────────────────────────────────────


def test_band_of_anchors():
    """Price exactly on the fit is band 2; the very top of the ladder is band 8."""
    for x in X_PROBES:
        on_fit = R.fit_value(x)
        assert R.band_of(on_fit, x) == 2, f"x={x}: the fit line must sit in band 2"
        top = on_fit * math.exp((8 - R.BAND_OFFSET) * R.BAND_WIDTH)
        assert R.band_of(top * 0.999, x) == 8, f"x={x}: the top of the ladder must be band 8"
        assert R.band_of(top * 1.5, x) == 9, f"x={x}: above the ladder must report off-scale"
        bottom = on_fit * math.exp(-R.BAND_OFFSET * R.BAND_WIDTH - R.BAND_WIDTH)
        assert R.band_of(bottom * 0.5, x) == -1, f"x={x}: below the ladder must report off-scale"


def test_bands_tile_without_gaps():
    """Adjacent bands share an edge exactly — no gap, no overlap."""
    for x in X_PROBES:
        for i in range(8):
            _, hi = R.band_bounds(i, x)
            lo_next, _ = R.band_bounds(i + 1, x)
            assert _close(hi, lo_next), f"x={x}: band {i} top != band {i+1} bottom"


def test_ladder_is_asymmetric_as_documented():
    """0.472x below the fit, 7.03x above — the reference's geometry."""
    x = 5836
    fit = R.fit_value(x)
    low, _ = R.band_bounds(0, x)
    _, high = R.band_bounds(8, x)
    assert abs(low / fit - 0.472) < 0.001
    assert abs(high / fit - 7.03) < 0.01


def test_supply_schedule_hits_the_textbook_numbers():
    """Each epoch mints exactly 210,000 x reward; the total converges on 21,000,000."""
    assert _close(R.supply_at(dt.date(2024, 4, 20)), 19_687_500.0, 1e-9)
    assert R.supply_at(dt.date(2009, 1, 3)) == 0.0
    assert R.supply_at(dt.date(2140, 1, 1)) <= R.TERMINAL_SUPPLY
    assert R.supply_at(dt.date(2140, 1, 1)) > 20_999_999.0
    # monotone, never decreasing
    prev = -1.0
    for y in range(2009, 2141, 4):
        s = R.supply_at(dt.date(y, 1, 1))
        assert s >= prev, f"supply went backwards at {y}"
        prev = s


def test_marketcap_axis_is_a_clean_rescale():
    """The axis is price x terminal supply — exact, not interpolated."""
    ticks = [1e-2, 1e-1, 1, 10, 100, 1e3, 1e4, 1e5, 1e6]
    assert R.marketcap_axis(ticks) == [t * 21_000_000 for t in ticks]
    assert R.usd_label(1e5 * R.TERMINAL_SUPPLY) == "$2.1T"
    assert R.usd_label(1e6 * R.TERMINAL_SUPPLY) == "$21T"


def test_day_index_round_trips_across_the_gap():
    """The single 2010-08-17 gap must not shift any date by a day."""
    assert R.day_index_to_date(1) == dt.date(2010, 8, 16)
    for x in [2, 3, 100, 1000, 5836]:
        assert R.date_to_day_index(R.day_index_to_date(x)) == x


# ── cross-implementation parity ───────────────────────────────────────────────────────────────


def test_js_matches_python():
    """Same fit, same bands, same supply, same labels — or the two charts are telling two stories."""
    if not NODE:
        print("SKIP: node not installed; JS parity not checked")
        return
    js = _js()

    c = js["constants"]
    assert _close(c["a"], R.PUBLISHED_FIT.a) and _close(c["b"], R.PUBLISHED_FIT.b) \
        and _close(c["c"], R.PUBLISHED_FIT.c), "fit coefficients differ"
    assert c["bandWidth"] == R.BAND_WIDTH and c["bandOffset"] == R.BAND_OFFSET
    assert c["terminal"] == R.TERMINAL_SUPPLY
    assert [tuple(b) for b in c["bands"]] == list(R.BANDS), "band colours/labels differ"

    for x, got in zip(X_PROBES, js["fit"]):
        assert _close(R.fit_value(x), got, 1e-12), f"fit disagrees at x={x}"

    k = 0
    for x in X_PROBES:
        for p in PRICE_PROBES:
            assert R.band_of(p, x) == js["band"][k], f"band disagrees at x={x}, price={p}"
            k += 1

    for d, got in zip(DATE_PROBES, js["supply"]):
        mine = R.supply_at(dt.date.fromisoformat(d))
        assert _close(mine, got, 1e-6), f"supply disagrees at {d}: {mine} vs {got}"

    for p, got in zip(PRICE_PROBES, js["label"]):
        assert R.usd_label(p) == got, f"label disagrees for {p}: {R.usd_label(p)} vs {got}"


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError as e:
                failed += 1
                print(f"  FAIL  {name}: {e}")
    print(("\nall green" if not failed else f"\n{failed} failing"))
    sys.exit(1 if failed else 0)
