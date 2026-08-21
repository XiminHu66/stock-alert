#!/usr/bin/env python3
"""Build the market snapshot consumed by the static GitHub Pages app."""

from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "market.json"
SYMBOLS = {
    "^GSPC": ("SPX", "S&P 500", "INDEX"),
    "QQQ": ("QQQ", "Invesco QQQ Trust", "NASDAQ"),
    "AAPL": ("AAPL", "Apple", "NASDAQ"),
    "SMH": ("SMH", "VanEck Semiconductor ETF", "NASDAQ"),
    "NVDA": ("NVDA", "NVIDIA", "NASDAQ"),
    "BTC-USD": ("BTCUSD", "Bitcoin / USD", "CRYPTO"),
    "INTC": ("INTC", "Intel", "NASDAQ"),
    "UNH": ("UNH", "UnitedHealth", "NYSE"),
    "HOOD": ("HOOD", "Robinhood", "NASDAQ"),
    "NOW": ("NOW", "ServiceNow", "NYSE"),
    "VST": ("VST", "Vistra", "NYSE"),
    "MRVL": ("MRVL", "Marvell Technology", "NASDAQ"),
    # Broader cache for common additions from the owner's market watchlist.
    "SPY": ("SPY", "SPDR S&P 500 ETF", "NYSE ARCA"),
    "IWM": ("IWM", "iShares Russell 2000 ETF", "NYSE ARCA"),
    "SOXX": ("SOXX", "iShares Semiconductor ETF", "NASDAQ"),
    "AMD": ("AMD", "Advanced Micro Devices", "NASDAQ"),
    "AVGO": ("AVGO", "Broadcom", "NASDAQ"),
    "TSM": ("TSM", "Taiwan Semiconductor", "NYSE"),
    "ASML": ("ASML", "ASML Holding", "NASDAQ"),
    "ANET": ("ANET", "Arista Networks", "NYSE"),
    "DELL": ("DELL", "Dell Technologies", "NYSE"),
    "MSFT": ("MSFT", "Microsoft", "NASDAQ"),
    "GOOGL": ("GOOGL", "Alphabet", "NASDAQ"),
    "META": ("META", "Meta Platforms", "NASDAQ"),
    "TSLA": ("TSLA", "Tesla", "NASDAQ"),
    "PLTR": ("PLTR", "Palantir", "NASDAQ"),
    "W": ("W", "Wayfair", "NYSE"),
}
MULTI_EXPIRY_SYMBOLS = {
    "QQQ", "AAPL", "SMH", "NVDA", "INTC", "UNH", "HOOD", "NOW", "VST", "MRVL"
}


def native(value: Any) -> Any:
    """Convert pandas/numpy values into strict JSON values."""
    if value is None or value is pd.NA:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, (pd.Timestamp, datetime)):
        dt = value.to_pydatetime() if isinstance(value, pd.Timestamp) else value
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return value


def market_state() -> str:
    now = datetime.now(ZoneInfo("America/New_York"))
    minutes = now.hour * 60 + now.minute
    return "open" if now.weekday() < 5 and 570 <= minutes < 960 else "closed"


def read_previous() -> dict[str, Any]:
    try:
        return json.loads(OUTPUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"symbols": {}}


def history_rows(frame: pd.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, row in frame.tail(270).iterrows():
        close = native(row.get("Close"))
        if close is None:
            continue
        rows.append(
            {
                "d": pd.Timestamp(index).date().isoformat(),
                "o": native(row.get("Open")),
                "h": native(row.get("High")),
                "l": native(row.get("Low")),
                "c": close,
                "v": native(row.get("Volume")),
            }
        )
    return rows


def extract_news(ticker: yf.Ticker) -> list[dict[str, Any]]:
    articles: list[dict[str, Any]] = []
    try:
        raw_news = ticker.news or []
    except Exception as error:  # Yahoo occasionally rejects news while quotes work.
        print(f"news: {error}")
        return articles
    for raw in raw_news[:10]:
        content = raw.get("content") if isinstance(raw, dict) else None
        item = content if isinstance(content, dict) else raw
        canonical = item.get("canonicalUrl") or item.get("clickThroughUrl") or {}
        url = canonical.get("url") if isinstance(canonical, dict) else canonical
        provider = item.get("provider") or {}
        publisher = provider.get("displayName") if isinstance(provider, dict) else provider
        published = item.get("pubDate") or item.get("providerPublishTime")
        if isinstance(published, (int, float)):
            published = datetime.fromtimestamp(published, timezone.utc).isoformat().replace("+00:00", "Z")
        if item.get("title") and url:
            articles.append(
                {
                    "title": str(item["title"])[:240],
                    "url": str(url),
                    "publisher": str(publisher or "Yahoo Finance")[:80],
                    "publishedAt": published,
                }
            )
    return articles


def max_pain(calls: pd.DataFrame, puts: pd.DataFrame) -> float | None:
    strikes = sorted(set(pd.to_numeric(calls.get("strike"), errors="coerce").dropna()) | set(pd.to_numeric(puts.get("strike"), errors="coerce").dropna()))
    if not strikes:
        return None
    call_strikes = pd.to_numeric(calls.get("strike"), errors="coerce").fillna(0).to_numpy()
    call_oi = pd.to_numeric(calls.get("openInterest"), errors="coerce").fillna(0).to_numpy()
    put_strikes = pd.to_numeric(puts.get("strike"), errors="coerce").fillna(0).to_numpy()
    put_oi = pd.to_numeric(puts.get("openInterest"), errors="coerce").fillna(0).to_numpy()
    losses = []
    for settlement in strikes:
        call_loss = np.maximum(0, settlement - call_strikes).dot(call_oi)
        put_loss = np.maximum(0, put_strikes - settlement).dot(put_oi)
        losses.append((float(call_loss + put_loss), float(settlement)))
    return min(losses)[1]


def option_chain_snapshot(
    ticker: yf.Ticker,
    expiry: str,
    expiry_date: Any,
    spot_price: float | None,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    try:
        today = datetime.now(timezone.utc).date()
        chain = ticker.option_chain(expiry)
        calls, puts = chain.calls.copy(), chain.puts.copy()
        call_volume = pd.to_numeric(calls.get("volume"), errors="coerce").fillna(0).sum()
        put_volume = pd.to_numeric(puts.get("volume"), errors="coerce").fillna(0).sum()
        call_oi = pd.to_numeric(calls.get("openInterest"), errors="coerce").fillna(0).sum()
        put_oi = pd.to_numeric(puts.get("openInterest"), errors="coerce").fillna(0).sum()
        strike_rows: list[dict[str, Any]] = []
        all_strikes = sorted(
            set(pd.to_numeric(calls.get("strike"), errors="coerce").dropna())
            | set(pd.to_numeric(puts.get("strike"), errors="coerce").dropna())
        )
        if spot_price and all_strikes:
            nearby = [strike for strike in all_strikes if spot_price * 0.78 <= strike <= spot_price * 1.22]
            if len(nearby) > 17:
                nearby = sorted(nearby, key=lambda strike: abs(strike - spot_price))[:17]
            nearby = sorted(nearby)
            call_by_strike = calls.assign(
                strikeNumeric=pd.to_numeric(calls.get("strike"), errors="coerce"),
                oiNumeric=pd.to_numeric(calls.get("openInterest"), errors="coerce").fillna(0),
                volumeNumeric=pd.to_numeric(calls.get("volume"), errors="coerce").fillna(0),
            ).groupby("strikeNumeric")[["oiNumeric", "volumeNumeric"]].sum()
            put_by_strike = puts.assign(
                strikeNumeric=pd.to_numeric(puts.get("strike"), errors="coerce"),
                oiNumeric=pd.to_numeric(puts.get("openInterest"), errors="coerce").fillna(0),
                volumeNumeric=pd.to_numeric(puts.get("volume"), errors="coerce").fillna(0),
            ).groupby("strikeNumeric")[["oiNumeric", "volumeNumeric"]].sum()
            for strike in nearby:
                call_row = call_by_strike.loc[strike] if strike in call_by_strike.index else None
                put_row = put_by_strike.loc[strike] if strike in put_by_strike.index else None
                strike_rows.append(
                    {
                        "strike": native(strike),
                        "callOi": native(call_row["oiNumeric"]) if call_row is not None else 0,
                        "putOi": native(put_row["oiNumeric"]) if put_row is not None else 0,
                        "callVolume": native(call_row["volumeNumeric"]) if call_row is not None else 0,
                        "putVolume": native(put_row["volumeNumeric"]) if put_row is not None else 0,
                    }
                )
        puts_below = [row for row in strike_rows if row["strike"] <= (spot_price or 0)]
        calls_above = [row for row in strike_rows if row["strike"] >= (spot_price or float("inf"))]
        put_wall = max(puts_below, key=lambda row: row["putOi"], default=None)
        call_wall = max(calls_above, key=lambda row: row["callOi"], default=None)
        active: list[dict[str, Any]] = []
        for frame, option_type in ((calls, "call"), (puts, "put")):
            working = frame.copy()
            volume = pd.to_numeric(working.get("volume"), errors="coerce").fillna(0)
            oi = pd.to_numeric(working.get("openInterest"), errors="coerce").fillna(0)
            working["volumeOi"] = volume / oi.clip(lower=1)
            working["volumeNumeric"] = volume
            for _, row in working.sort_values(["volumeOi", "volumeNumeric"], ascending=False).head(5).iterrows():
                active.append(
                    {
                        "type": option_type,
                        "strike": native(row.get("strike")),
                        "volume": native(row.get("volume")),
                        "openInterest": native(row.get("openInterest")),
                        "volumeOi": native(row.get("volumeOi")),
                        "impliedVolatility": native(row.get("impliedVolatility")),
                    }
                )
        active.sort(key=lambda item: (item.get("volumeOi") or 0, item.get("volume") or 0), reverse=True)
        captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        current_trend = {
            "t": captured_at,
            "putCallVolume": native(put_volume / call_volume) if call_volume else None,
            "putCallOi": native(put_oi / call_oi) if call_oi else None,
            "callVolume": native(call_volume),
            "putVolume": native(put_volume),
            "maxPain": max_pain(calls, puts),
        }
        trend = list((previous or {}).get("trend") or [])
        if not trend and previous and previous.get("capturedAt"):
            trend.append(
                {
                    "t": previous.get("capturedAt"),
                    "putCallVolume": previous.get("putCallVolume"),
                    "putCallOi": previous.get("putCallOi"),
                    "callVolume": previous.get("callVolume"),
                    "putVolume": previous.get("putVolume"),
                    "maxPain": previous.get("maxPain"),
                }
            )
        trend.append(current_trend)
        return {
            "capturedAt": captured_at,
            "expiration": expiry,
            "daysToExpiry": (expiry_date - today).days,
            "callVolume": native(call_volume),
            "putVolume": native(put_volume),
            "putCallVolume": native(put_volume / call_volume) if call_volume else None,
            "callOi": native(call_oi),
            "putOi": native(put_oi),
            "putCallOi": native(put_oi / call_oi) if call_oi else None,
            "maxPain": current_trend["maxPain"],
            "putWall": put_wall["strike"] if put_wall else None,
            "callWall": call_wall["strike"] if call_wall else None,
            "strikeProfile": strike_rows,
            "trend": trend[-32:],
            "topContracts": active[:7],
        }
    except Exception as error:
        print(f"options {expiry}: {error}")
        return None


def option_snapshot(
    ticker: yf.Ticker,
    spot_price: float | None,
    previous: dict[str, Any] | None = None,
    max_expirations: int = 2,
) -> dict[str, Any] | None:
    """Fetch several nearby expirations and keep a per-expiry trend history."""
    try:
        today = datetime.now(timezone.utc).date()
        future_candidates = [
            (datetime.strptime(value, "%Y-%m-%d").date(), value)
            for value in list(ticker.options or [])
        ]
        future_candidates = [item for item in future_candidates if item[0] >= today]
        targets = (0, 21) if max_expirations == 2 else (0, 7, 21, 45)[:max_expirations]
        candidates: list[tuple[Any, str]] = []
        for minimum_dte in targets:
            match = next(
                (item for item in future_candidates if (item[0] - today).days >= minimum_dte and item not in candidates),
                None,
            )
            if match:
                candidates.append(match)
        for item in future_candidates:
            if len(candidates) >= max_expirations:
                break
            if item not in candidates:
                candidates.append(item)
        candidates.sort()
        if not candidates:
            return None

        prior_by_expiry: dict[str, dict[str, Any]] = {}
        if isinstance(previous, dict):
            for snapshot in previous.get("expirations") or []:
                if isinstance(snapshot, dict) and snapshot.get("expiration"):
                    prior_by_expiry[snapshot["expiration"]] = snapshot
            if previous.get("expiration"):
                prior_by_expiry.setdefault(previous["expiration"], previous)

        snapshots: list[dict[str, Any]] = []
        for expiry_date, expiry in candidates:
            snapshot = option_chain_snapshot(
                ticker,
                expiry,
                expiry_date,
                spot_price,
                prior_by_expiry.get(expiry),
            )
            if snapshot:
                snapshots.append(snapshot)
        if not snapshots:
            return None

        preferred = next((item for item in snapshots if (item.get("daysToExpiry") or 0) >= 21), snapshots[0])
        return {
            **preferred,
            "defaultExpiration": preferred["expiration"],
            "availableExpirations": [item["expiration"] for item in snapshots],
            "expirations": snapshots,
        }
    except Exception as error:
        print(f"options: {error}")
        return None


def fundamental_snapshot(ticker: yf.Ticker, previous: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Fetch a compact daily valuation snapshot; preserve the prior value on transient errors."""
    previous = previous if isinstance(previous, dict) else None
    today = datetime.now(timezone.utc).date().isoformat()
    if previous and str(previous.get("fetchedAt", "")).startswith(today):
        return previous
    try:
        info = ticker.get_info() or {}
        result = {
            "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "trailingPE": native(info.get("trailingPE")),
            "forwardPE": native(info.get("forwardPE")),
            "priceToBook": native(info.get("priceToBook")),
            "pegRatio": native(info.get("pegRatio")),
            "earningsGrowth": native(info.get("earningsGrowth")),
            "revenueGrowth": native(info.get("revenueGrowth")),
            "marketCap": native(info.get("marketCap")),
            "sector": info.get("sector") or info.get("category"),
        }
        return result if any(result.get(key) is not None for key in ("trailingPE", "forwardPE", "priceToBook", "marketCap")) else previous
    except Exception as error:
        print(f"fundamentals: {error}")
        return previous


def symbol_snapshot(symbol: str, meta: tuple[str, str, str], previous: dict[str, Any]) -> dict[str, Any]:
    display, name, exchange = meta
    ticker = yf.Ticker(symbol)
    daily = ticker.history(period="1y", interval="1d", auto_adjust=False, actions=False)
    rows = history_rows(daily)
    if not rows:
        raise RuntimeError("no history returned")
    price = rows[-1]["c"]
    last_trade_at = None
    try:
        intraday = ticker.history(period="1d", interval="5m", prepost=True, actions=False)
        if not intraday.empty:
            clean = intraday.dropna(subset=["Close"])
            if not clean.empty:
                price = native(clean.iloc[-1]["Close"])
                last_trade_at = native(clean.index[-1])
    except Exception as error:
        print(f"intraday: {error}")
    previous_close = rows[-2]["c"] if len(rows) > 1 else rows[-1]["c"]
    change = price - previous_close if price is not None and previous_close is not None else None
    previous_news = previous.get("news") if isinstance(previous.get("news"), list) else []
    news = extract_news(ticker) or previous_news
    previous_options = previous.get("options")
    options = None if symbol in {"^GSPC", "BTC-USD"} else option_snapshot(
        ticker,
        price,
        previous_options,
        max_expirations=4 if symbol in MULTI_EXPIRY_SYMBOLS else 2,
    )
    if options is None:
        options = previous_options
    fundamentals = None if symbol in {"^GSPC", "BTC-USD"} else fundamental_snapshot(ticker, previous.get("fundamentals"))
    return {
        "symbol": symbol,
        "display": display,
        "name": name,
        "exchange": exchange,
        "currency": "USD",
        "price": price,
        "previousClose": previous_close,
        "change": change,
        "changePct": change / previous_close * 100 if change is not None and previous_close else None,
        "lastTradeAt": last_trade_at,
        "history": rows,
        "news": news,
        "options": options,
        "fundamentals": fundamentals,
        "source": "Yahoo Finance via scheduled GitHub Action",
    }


def main() -> None:
    previous = read_previous()
    result: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "marketState": market_state(),
        "dataDelay": "行情、新闻和期权通常延迟 15–30 分钟",
        "symbols": {},
    }
    for index, (symbol, meta) in enumerate(SYMBOLS.items(), start=1):
        print(f"[{index}/{len(SYMBOLS)}] {symbol}")
        try:
            result["symbols"][symbol] = symbol_snapshot(symbol, meta, previous.get("symbols", {}).get(symbol, {}))
        except Exception as error:
            print(f"failed {symbol}: {error}")
            fallback = previous.get("symbols", {}).get(symbol)
            if fallback:
                result["symbols"][symbol] = fallback
        time.sleep(float(os.environ.get("MARKET_FETCH_PAUSE", "0.2")))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"wrote {OUTPUT} with {len(result['symbols'])} symbols")


if __name__ == "__main__":
    main()
