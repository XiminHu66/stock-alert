#!/usr/bin/env python3
"""Fetch a lightweight quote snapshot without installing the yfinance stack.

The full market job still uses yfinance for history, news, options and
fundamentals. This fast path calls Yahoo's chart endpoint directly so a
scheduled quote run spends seconds fetching data instead of installing pandas.
"""

from __future__ import annotations

import json
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
MARKET_FILE = ROOT / "data" / "market.json"
OUTPUT = ROOT / "data" / "quotes.json"
HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")


def read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def native(value: Any) -> float | int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def quote_from_payload(payload: dict[str, Any], base: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(str(chart["error"]))
    result = (chart.get("result") or [None])[0]
    if not result:
        raise RuntimeError("empty chart response")
    timestamps = result.get("timestamp") or []
    quote_rows = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote_rows.get("close") or []
    points = [(timestamp, native(closes[index])) for index, timestamp in enumerate(timestamps) if index < len(closes)]
    points = [(timestamp, price) for timestamp, price in points if price is not None]
    meta = result.get("meta") or {}
    price = points[-1][1] if points else native(meta.get("regularMarketPrice"))
    if price is None:
        raise RuntimeError("no current price")
    previous_close = native(meta.get("chartPreviousClose")) or native(base.get("previousClose"))
    change = price - previous_close if previous_close else None
    last_trade = points[-1][0] if points else meta.get("regularMarketTime")
    return {
        "price": price,
        "previousClose": previous_close,
        "change": change,
        "changePct": change / previous_close * 100 if change is not None and previous_close else None,
        "lastTradeAt": datetime.fromtimestamp(last_trade, timezone.utc).isoformat().replace("+00:00", "Z") if last_trade else None,
        "fetchedAt": fetched_at,
    }


def fetch_symbol(symbol: str, base: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    encoded = quote(symbol, safe="")
    last_error: Exception | None = None
    for attempt in range(3):
        host = HOSTS[attempt % len(HOSTS)]
        url = f"https://{host}/v8/finance/chart/{encoded}?range=2d&interval=5m&includePrePost=true&events=div%2Csplits"
        request = Request(url, headers={"User-Agent": "Mozilla/5.0 Stock-Alert/1.0", "Accept": "application/json"})
        try:
            with urlopen(request, timeout=15) as response:
                payload = json.load(response)
            return quote_from_payload(payload, base, fetched_at)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"quote request failed: {last_error}")


def main() -> None:
    market = read_json(MARKET_FILE, {"symbols": {}})
    previous = read_json(OUTPUT, {"symbols": {}})
    symbols = list((market.get("symbols") or {}).keys())
    if not symbols:
        raise RuntimeError("market.json has no configured symbols")

    fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fresh: dict[str, dict[str, Any]] = {}
    failures: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(symbols))) as pool:
        jobs = {pool.submit(fetch_symbol, symbol, market["symbols"].get(symbol, {}), fetched_at): symbol for symbol in symbols}
        for job in as_completed(jobs):
            symbol = jobs[job]
            try:
                fresh[symbol] = job.result()
            except Exception as error:
                failures[symbol] = str(error)

    result: dict[str, Any] = {
        "generatedAt": fetched_at,
        "interval": "5m",
        "successCount": len(fresh),
        "symbols": {},
    }
    for symbol in symbols:
        if symbol in fresh:
            result["symbols"][symbol] = fresh[symbol]
            continue
        fallback = (previous.get("symbols") or {}).get(symbol)
        if fallback:
            result["symbols"][symbol] = fallback
        print(f"{symbol}: {failures.get(symbol, 'no quote returned')}")

    if not fresh:
        raise RuntimeError("all quote requests failed; preserving the previous snapshot")
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"wrote {len(fresh)}/{len(symbols)} fresh quotes to {OUTPUT}")


if __name__ == "__main__":
    main()
