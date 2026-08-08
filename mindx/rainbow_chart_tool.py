"""
rainbow_chart_tool.py — the Bitcoin rainbow chart as a mindX tool.

Install into mindX as `tools/rainbow_chart_tool.py`, with the dependency-free core vendored
alongside it at `tools/rainbow_chart/rainbow.py` (copy `src/rainbow.py` from this repo).

The tool has two modes, and the split matters:

  * The READ actions — `report`, `bands`, `marketcap`, `fit` — need only `rainbow.py`, which is
    pure standard library. They work on any mindX host, offline, with no plotting stack.
  * The DRAW action — `render` — needs pandas/numpy/scipy/matplotlib and the CSV. If those are
    absent the tool says so and returns the read-only answer instead of raising, so a BDI plan
    that asked for a picture still gets the number it was really after.

Nothing here reaches the network. The bundled series ends where the CSV ends; `report` always
states the date it is reading from, so staleness is a returned fact rather than a silent one.
"""

from __future__ import annotations

import datetime as _dt
import os
import sys
from typing import Any, Dict, Optional

from utils.config import Config
from utils.logging_config import get_logger
from agents.core.bdi_agent import BaseTool

logger = get_logger(__name__)

# The core is vendored next to this file; if the full repo is checked out somewhere, an env var
# points at it instead so a single clone can serve both mindX and a developer's working tree.
_REPO = os.environ.get("MINDX_RAINBOW_CHART_PATH")
for _candidate in (
    os.path.join(_REPO, "src") if _REPO else None,
    os.path.join(os.path.dirname(__file__), "rainbow_chart"),
):
    if _candidate and os.path.isdir(_candidate) and _candidate not in sys.path:
        sys.path.insert(0, _candidate)

try:
    import rainbow as _core
except ImportError as exc:  # pragma: no cover - a broken install, not a runtime condition
    _core = None
    logger.error(f"RainbowChartTool: could not import the rainbow core ({exc}).")


class RainbowChartTool(BaseTool):
    """
    Read and draw the Bitcoin rainbow chart.

    The rainbow is a logarithmic regression on linear time — that is what bends it into an arc —
    with nine bands 0.3 wide in natural log stacked around the fit. Band 2 ("Accumulate") contains
    the fit line, which makes the ladder asymmetric: 0.472x below the fit, 7.03x above.

    It is a heuristic, not an oracle. The fit is refitted whenever new data arrives, so the curve
    quietly moves to keep explaining whatever just happened, and only ~86% of BTC's history falls
    inside the painted range at all. Answers from this tool should be framed as "where price sits
    relative to a curve drawn through past price", never as a target.
    """

    ACTIONS = ("report", "bands", "marketcap", "fit", "render")

    def __init__(
        self,
        config: Optional[Config] = None,
        bdi_agent_ref: Optional[Any] = None,
        llm_handler: Optional[Any] = None,
        csv_path: Optional[str] = None,
        **kwargs: Any,
    ):
        super().__init__(config=config, llm_handler=llm_handler, bdi_agent_ref=bdi_agent_ref)
        self.csv_path = csv_path or (
            os.path.join(_REPO, "data", "bitcoin_data.csv") if _REPO else None
        )

    # ── schema ────────────────────────────────────────────────────────────────────────────────

    def get_schema(self) -> Dict[str, Any]:
        return {
            "name": "rainbow_chart",
            "description": (
                "Read or draw the Bitcoin rainbow chart: a logarithmic regression on linear time "
                "with nine coloured bands. Reports which band a price sits in, the band price "
                "ladder, and the corresponding market cap. A heuristic, not a price target."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": list(self.ACTIONS),
                        "description": (
                            "report: where a price stands against the fit. "
                            "bands: the nine bands priced for a date. "
                            "marketcap: market cap of a price at a date. "
                            "fit: the published coefficients. "
                            "render: write a PNG (needs matplotlib + the CSV)."
                        ),
                    },
                    "price": {
                        "type": "number",
                        "description": "USD price to locate. Defaults to the last close in the series.",
                    },
                    "date": {
                        "type": "string",
                        "description": "ISO date (YYYY-MM-DD) the price belongs to. Defaults to today.",
                    },
                    "output_path": {
                        "type": "string",
                        "description": "Where render writes the PNG.",
                    },
                },
                "required": ["action"],
            },
        }

    # ── execute ───────────────────────────────────────────────────────────────────────────────

    async def execute(
        self,
        action: str = "report",
        price: Optional[float] = None,
        date: Optional[str] = None,
        output_path: Optional[str] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        if _core is None:
            return {"success": False, "error": "the rainbow core is not importable on this host"}
        if action not in self.ACTIONS:
            return {"success": False, "error": f"unknown action '{action}'", "actions": list(self.ACTIONS)}

        try:
            when = _dt.date.fromisoformat(date) if date else _dt.date.today()
        except ValueError:
            return {"success": False, "error": f"'{date}' is not an ISO date (YYYY-MM-DD)"}

        try:
            if action == "fit":
                return {"success": True, **self._fit()}
            if action == "render":
                return await self._render(output_path)

            x = _core.date_to_day_index(when)
            usd = float(price) if price is not None else None
            if usd is None:
                return {
                    "success": False,
                    "error": "this action needs a price; pass price=<usd>",
                    "hint": "the tool holds no live feed by design — it never reaches the network",
                }

            if action == "marketcap":
                return {
                    "success": True,
                    "date": str(when),
                    "price": usd,
                    "supply": _core.supply_at(when),
                    "supply_basis": "emission schedule (deterministic; reads ~0.5% high vs a live node)",
                    "marketcap": _core.marketcap_at(usd, when),
                    "marketcap_label": _core.usd_label(_core.marketcap_at(usd, when)),
                    "marketcap_at_terminal_supply": usd * _core.TERMINAL_SUPPLY,
                }

            if action == "bands":
                return {"success": True, "date": str(when), "day_index": x, "bands": self._bands(x)}

            return {"success": True, **self._report(usd, x, when)}

        except Exception as exc:  # pragma: no cover
            logger.error(f"RainbowChartTool.{action} failed: {exc}", exc_info=True)
            return {"success": False, "error": str(exc)}

    # ── the actions ───────────────────────────────────────────────────────────────────────────

    def _fit(self) -> Dict[str, Any]:
        f = _core.PUBLISHED_FIT
        return {
            "equation": "ln(price) = a * ln(b + x) + c",
            "a": f.a, "b": f.b, "c": f.c, "r2": f.r2,
            "observations": f.n, "from": f.start, "to": f.end,
            "x": "1 on the first priced day, +1 per priced day (row index, not days since genesis)",
            "band_width": _core.BAND_WIDTH,
            "band_offset": _core.BAND_OFFSET,
            "caveat": (
                "R2 is high because any smooth curve fits sixteen years of log-scaled exponential "
                "growth well. The fit is refitted as data arrives, so it moves to keep explaining "
                "whatever just happened."
            ),
        }

    def _bands(self, x: int) -> list:
        out = []
        for i in range(8, -1, -1):
            lo, hi = _core.band_bounds(i, x)
            colour, name = _core.BANDS[i]
            out.append({
                "band": i, "name": name, "colour": colour,
                "low": lo, "high": hi,
                "low_label": _core.usd_label(lo), "high_label": _core.usd_label(hi),
            })
        return out

    def _report(self, usd: float, x: int, when: _dt.date) -> Dict[str, Any]:
        curve = _core.fit_value(x)
        band = _core.band_of(usd, x)
        name = (
            "below the scale" if band < 0
            else "above the scale" if band > 8
            else _core.BANDS[band][1]
        )
        return {
            "date": str(when),
            "price": usd,
            "price_label": _core.usd_label(usd),
            "fit": curve,
            "fit_label": _core.usd_label(curve),
            "ratio": usd / curve,
            "band": band,
            "band_name": name,
            "on_the_scale": 0 <= band <= 8,
            "marketcap": _core.marketcap_at(usd, when),
            "marketcap_label": _core.usd_label(_core.marketcap_at(usd, when)),
            "reading": (
                f"{_core.usd_label(usd)} is {usd / curve:.2f}x the fitted curve "
                f"({_core.usd_label(curve)}) — band {band}, \"{name}\"."
            ),
            "caveat": "a description of past price, not a target",
        }

    async def _render(self, output_path: Optional[str]) -> Dict[str, Any]:
        """Draw the PNG. Degrades to an explanation rather than an exception when deps are absent."""
        if not self.csv_path or not os.path.isfile(self.csv_path):
            return {
                "success": False,
                "error": "no price CSV available for rendering",
                "hint": "set MINDX_RAINBOW_CHART_PATH to a checkout of Professor-Codephreak/rainbow-chart",
            }
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError as exc:
            return {
                "success": False,
                "error": f"matplotlib is not installed on this host ({exc})",
                "hint": "the read actions (report/bands/marketcap/fit) need no plotting stack",
            }

        src = os.path.join(_REPO, "src")
        if src not in sys.path:
            sys.path.insert(0, src)
        from data import get_data           # noqa: E402  (resolved from the repo checkout)
        from plot import create_plot        # noqa: E402

        import asyncio

        def _draw() -> str:
            raw, popt = get_data(self.csv_path, offline=True)
            create_plot(raw, popt, marketcap=True)
            out = output_path or os.path.join(_REPO, "img", "bitcoin_rainbow_chart.png")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            plt.savefig(out, bbox_inches="tight", dpi=200)
            plt.close("all")
            return out

        # matplotlib is blocking and mindX is async throughout; keep the loop free.
        out = await asyncio.get_running_loop().run_in_executor(None, _draw)
        return {"success": True, "path": out, "marketcap_axis": True}
