"""
main.py — render the Bitcoin rainbow chart.

    python src/main.py                       # show the chart
    python src/main.py --save                # write img/bitcoin_rainbow_chart.png
    python src/main.py --offline             # never touch the network
    python src/main.py --no-marketcap        # drop the right-hand market-cap axis
    python src/main.py --report              # print the standing instead of drawing
"""

import argparse
import os

import matplotlib

from data import get_data
from rainbow import Fit, band_of, marketcap_at, usd_label, day_index_to_date

DEFAULT_CSV = os.path.join(os.path.dirname(__file__), "..", "data", "bitcoin_data.csv")
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "..", "img", "bitcoin_rainbow_chart.png")


def report(raw_data, popt):
    """Where the last close stands against the fit — the numbers, without drawing anything."""
    fit = Fit(a=float(popt[0]), b=float(popt[1]), c=float(popt[2]), n=len(raw_data))
    x = len(raw_data)
    last = float(raw_data["Value"].iloc[-1])
    when = raw_data["Date"].iloc[-1].date()
    curve = fit(x)
    band = band_of(last, x, fit)

    from rainbow import BANDS

    name = "below the scale" if band < 0 else "above the scale" if band > 8 else BANDS[band][1]
    return {
        "date": str(when),
        "price": last,
        "fit": curve,
        "ratio": last / curve,
        "band": band,
        "band_name": name,
        "marketcap": marketcap_at(last, when),
        "fit_coefficients": {"a": fit.a, "b": fit.b, "c": fit.c},
        "observations": x,
    }


def main(save=False, file_path=DEFAULT_OUT, offline=False, marketcap=True, as_report=False):
    # Load data
    raw_data, popt = get_data(os.path.normpath(DEFAULT_CSV), offline=offline)

    if as_report:
        r = report(raw_data, popt)
        print(f"  {r['date']}")
        print(f"  price       {usd_label(r['price'])}  ({r['price']:,.2f})")
        print(f"  the fit     {usd_label(r['fit'])}")
        print(f"  ratio       {r['ratio']:.3f}x the fit")
        print(f"  band        {r['band']} — {r['band_name']}")
        print(f"  market cap  {usd_label(r['marketcap'])}")
        print(f"  fitted on   {r['observations']:,} daily closes")
        return r

    if save:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from plot import create_plot

    create_plot(raw_data, popt, marketcap=marketcap)

    if save:
        os.makedirs(os.path.dirname(os.path.normpath(file_path)), exist_ok=True)
        plt.savefig(os.path.normpath(file_path), bbox_inches="tight", dpi=300)
        print(f"wrote {os.path.normpath(file_path)}")
    else:
        plt.show()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Bitcoin rainbow chart")
    p.add_argument("--save", action="store_true", help="write a PNG instead of showing a window")
    p.add_argument("--out", default=DEFAULT_OUT, help="output path for --save")
    p.add_argument("--offline", action="store_true", help="never fetch; use the CSV as it stands")
    p.add_argument("--no-marketcap", action="store_true", help="drop the market-cap axis")
    p.add_argument("--report", action="store_true", help="print the standing, draw nothing")
    a = p.parse_args()
    main(
        save=a.save, file_path=a.out, offline=a.offline,
        marketcap=not a.no_marketcap, as_report=a.report,
    )
