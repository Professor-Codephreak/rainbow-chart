"""
data.py — loading the price series and fitting the curve.

Two changes from upstream, both about making the module importable in places that cannot install
a full exchange SDK (mindX runs it that way):

  1. ccxt is imported LAZILY. Upstream builds its list of supported exchanges by instantiating
     every exchange ccxt knows about at import time, which costs seconds and makes ccxt a hard
     dependency of merely reading the CSV. Here the import — and the probe — happen only if the
     data is actually stale and needs refreshing.
  2. `get_data(..., offline=True)` never reaches for the network at all: it reads the CSV, fits,
     and returns, however old the CSV is. Staleness is reported, not silently repaired.
"""

import datetime
import time

import numpy as np
import pandas as pd
from dateutil.parser import parse
from scipy.optimize import curve_fit


def log_func(x, a, b, c):
    """Logarithmic function for curve fitting."""
    return a * np.log(b + x) + c


def _exchanges_with_ohlcv():
    """
    The ccxt exchanges that can serve OHLCV, probed on demand.

    Upstream ran this at import time. It instantiates every exchange class ccxt ships, so it is
    slow and it makes ccxt mandatory for anyone who only wants to read the bundled CSV.
    """
    import ccxt

    found = []
    for exchange_id in ccxt.exchanges:
        try:
            if getattr(ccxt, exchange_id)().has["fetchOHLCV"]:
                found.append(exchange_id)
        except Exception:
            continue  # an exchange class that will not instantiate is simply not a candidate
    return found


def get_data(file_path, offline=False):
    """
    Load and preprocess data from a CSV file.

    Args:
        file_path (str): Path to the CSV file.
        offline (bool): If True, never fetch — use the CSV as it stands, however stale.

    Returns:
        pd.DataFrame: Processed data.
        np.ndarray: Fitted parameters (a, b, c).
    """
    raw_data = pd.read_csv(file_path)
    raw_data["Date"] = pd.to_datetime(raw_data["Date"])

    # Calculate the difference in days between the last date and today
    diff_days = (pd.Timestamp.today() - raw_data["Date"].max()).days

    if diff_days > 1 and not offline:
        print(f"Data is {diff_days} days old. Updating...")
        try:
            new_data = fetch_data(
                since=raw_data["Date"].max(), limit=diff_days, exchange="binance"
            )
            raw_data = pd.concat([raw_data, new_data])
            raw_data.to_csv(file_path, index=False)
        except Exception as exc:  # network down, ccxt absent, exchange geoblocked
            print(f"Could not refresh the series ({exc}). Drawing from the CSV as it stands.")
    elif diff_days > 1:
        print(f"Offline: drawing from a CSV that is {diff_days} days old.")

    # Zero rows are the pre-market era of the dataset; duplicates creep in at refresh boundaries.
    raw_data = raw_data[raw_data["Value"] > 0].drop_duplicates(subset=["Date"])
    raw_data = raw_data.sort_values("Date").reset_index(drop=True)

    # Prepare data for curve fitting
    xdata = np.array([x + 1 for x in range(len(raw_data))])
    ydata = np.log(raw_data["Value"])

    # Fit the logarithmic curve
    popt, _ = curve_fit(log_func, xdata, ydata)

    return raw_data, popt


def fetch_data(
    exchange: str = "binance",
    since=None,
    limit: int = None,
) -> pd.DataFrame:
    """
    Pandas DataFrame with the latest OHLCV data from specified exchange.

    Parameters
    --------------
    exchange : string, check the exchange_list to see the supported exchanges. For instance "binance".
    since: integer, UTC timestamp in milliseconds. Default is None, which means will not take the start date into account.
    The behavior of this parameter depends on the exchange.
    limit : integer, the amount of rows that should be returned. For instance 100, default is None, which means 500 rows.

    All the timeframe options are: '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'
    """
    import ccxt

    timeframe: str = "1d"
    symbol: str = "BTC/USDT"

    # If it is a string, convert it to a datetime object
    if isinstance(since, str):
        since = parse(since)

    if isinstance(since, datetime.datetime):
        since = int(since.timestamp() * 1000)

    # Always convert to lowercase
    exchange = exchange.lower()

    if exchange not in _exchanges_with_ohlcv():
        raise ValueError(
            f"{exchange} is not a supported exchange. Please use one of the following: "
            f"{_exchanges_with_ohlcv()}"
        )

    exchange = getattr(ccxt, exchange)()

    # Convert ms to seconds, so we can use time.sleep() for multiple calls
    rate_limit = exchange.rateLimit / 1000

    # Get data
    data = exchange.fetch_ohlcv(symbol, timeframe, since, limit)

    while len(data) < limit:
        # If the data is less than the limit, we need to make multiple calls
        # Shift the since date to the last date of the data
        since = data[-1][0] + 86400000

        # Sleep to prevent rate limit errors
        time.sleep(rate_limit)

        # Get the remaining data
        new_data = exchange.fetch_ohlcv(symbol, timeframe, since, limit - len(data))
        data += new_data

        if len(new_data) == 0:
            break

    df = pd.DataFrame(
        data, columns=["Timestamp", "open", "high", "low", "close", "volume"]
    )

    # Convert Timestamp to date
    df.Timestamp = (
        df.Timestamp / 1000
    )  # Timestamp is 1000 times bigger than it should be in this case
    df["Date"] = pd.to_datetime(df.Timestamp, unit="s")

    # The default values are string, so convert these to numeric values
    df["Value"] = pd.to_numeric(df["close"])

    # Returned DataFrame should consists of columns: index starting from 0, date as datetime, open, high, low, close, volume in numbers
    return df[["Date", "Value"]]
