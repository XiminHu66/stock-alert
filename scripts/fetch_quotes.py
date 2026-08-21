#!/usr/bin/env python3
"""Fetch a lightweight five-minute quote snapshot for Stock Alert."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf


ROOT = Path(__file__).resolve().parents[1]
MARKET_FILE = ROOT / "data" / "market.json"
OUTPUT = ROOT / "data" / "quotes.json"


def read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def native(value: Any) -> float | int | None:
    if value is None or value is pd.NA:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def main() -> None:
    market = read_json(MARKET_FILE, {"symbols": {}})
    previous = read_json(OUTPUT, {"symbols": {}})
    symbols = list(market.get("symbols", {}).keys())
    if not symbols:
        raise RuntimeError("market.json has no configured symbols")

    downloaded = yf.download(
        symbols,
        period="2d",
        interval="5m",
        group_by="ticker",
        auto_adjust=False,
        prepost=True,
        threads=True,
        progress=False,
    )
    result: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "interval": "5m",
        "symbols": {},
    }
    for symbol in symbols:
        base = market["symbols"].get(symbol, {})
        try:
            if isinstance(downloaded.columns, pd.MultiIndex):
                frame = downloaded[symbol]
            else:
                frame = downloaded
            clean = frame.dropna(subset=["Close"])
            if clean.empty:
                raise RuntimeError("no intraday rows")
            price = native(clean.iloc[-1]["Close"])
            previous_close = native(base.get("previousClose"))
            change = price - previous_close if price is not None and previous_close else None
            result["symbols"][symbol] = {
                "price": price,
                "previousClose": previous_close,
                "change": change,
                "changePct": change / previous_close * 100 if change is not None and previous_close else None,
                "lastTradeAt": pd.Timestamp(clean.index[-1]).to_pydatetime().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        except Exception as error:
            print(f"{symbol}: {error}")
            fallback = previous.get("symbols", {}).get(symbol)
            if fallback:
                result["symbols"][symbol] = fallback

    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"wrote {len(result['symbols'])} quotes to {OUTPUT}")


if __name__ == "__main__":
    main()
