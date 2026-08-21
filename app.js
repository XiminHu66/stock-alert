const DEFAULT_WATCHLIST = [
  ["^GSPC", "SPX", "S&P 500"], ["QQQ", "QQQ", "Nasdaq 100 ETF"],
  ["AAPL", "AAPL", "Apple"], ["SMH", "SMH", "VanEck Semiconductor ETF"],
  ["NVDA", "NVDA", "NVIDIA"], ["BTC-USD", "BTCUSD", "Bitcoin / USD"],
  ["INTC", "INTC", "Intel"], ["UNH", "UNH", "UnitedHealth"],
  ["HOOD", "HOOD", "Robinhood"], ["NOW", "NOW", "ServiceNow"],
  ["VST", "VST", "Vistra"], ["MRVL", "MRVL", "Marvell Technology"]
].map(([symbol, display, name]) => ({ symbol, display, name }));

const KEYS = {
  watchlist: "stock_alert_watchlist_v1",
  ranges: "stock_alert_ranges_v1",
  selected: "stock_alert_selected_v1",
  theme: "stock_alert_theme_v1",
  notifications: "stock_alert_notifications_v1"
};
const RAW_DATA = "https://raw.githubusercontent.com/XiminHu66/stock-alert/main/data/market.json";
const RAW_QUOTES = "https://raw.githubusercontent.com/XiminHu66/stock-alert/main/data/quotes.json";
const $ = id => document.getElementById(id);
const state = {
  watchlist: readStorage(KEYS.watchlist, DEFAULT_WATCHLIST),
  ranges: readStorage(KEYS.ranges, {}),
  selected: localStorage.getItem(KEYS.selected) || "NVDA",
  data: { generatedAt: null, symbols: {} },
  period: "1Y",
  analysis: null,
  dismissedAlert: false
};

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? structuredClone(fallback); }
  catch { return structuredClone(fallback); }
}
function writeStorage(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function fmt(value, digits = 2) { const number = finite(value); return number === null ? "—" : number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function fmtCompact(value) { const number = finite(value); if (number === null) return "—"; return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(number); }
function pct(value, digits = 2) { const number = finite(value); return number === null ? "—" : `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`; }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
function displayFor(symbol) { return state.watchlist.find(item => item.symbol === symbol)?.display || symbol.replace("-USD", "USD").replace("^GSPC", "SPX"); }
function dataFor(symbol = state.selected) { return state.data.symbols?.[symbol] || null; }
function currencyMark(item) { return item?.currency === "USD" || !item?.currency ? "$" : `${item.currency} `; }

function toast(message) {
  const node = $("toast"); node.textContent = message; node.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 2200);
}

async function fetchJson(url, timeout = 12000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function loadMarketData(showFeedback = false) {
  $("refreshButton").classList.add("loading");
  const stamp = Date.now();
  const sources = [`${RAW_DATA}?t=${stamp}`, `data/market.json?t=${stamp}`];
  const quoteSources = [`${RAW_QUOTES}?t=${stamp}`, `data/quotes.json?t=${stamp}`];
  let loaded = null;
  for (const source of sources) {
    try { loaded = await fetchJson(source); if (loaded?.symbols) break; }
    catch (error) { console.warn("Market data source failed", source, error); }
  }
  if (loaded?.symbols) {
    state.data = loaded;
    let quotes = null;
    for (const source of quoteSources) {
      try { quotes = await fetchJson(source); if (quotes?.symbols) break; }
      catch (error) { console.warn("Quote source failed", source, error); }
    }
    if (quotes?.symbols) {
      Object.entries(quotes.symbols).forEach(([symbol, quote]) => {
        if (state.data.symbols[symbol]) Object.assign(state.data.symbols[symbol], quote);
      });
      state.data.quoteGeneratedAt = quotes.generatedAt;
    }
    if (showFeedback) toast("报价与模型已刷新");
  } else if (showFeedback) toast("暂时无法更新，保留已有数据");
  $("refreshButton").classList.remove("loading");
  updateMarketStatus(); renderAll();
  if (!dataFor()) await fetchCustomSymbol(state.selected, showFeedback);
}

async function fetchCustomSymbol(symbol, showFeedback = true) {
  if (!symbol) return;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=true`;
    const payload = await fetchJson(url, 10000);
    const result = payload?.chart?.result?.[0];
    if (!result) throw new Error("No quote result");
    const q = result.indicators?.quote?.[0] || {}; const adj = result.indicators?.adjclose?.[0]?.adjclose || q.close || [];
    const history = (result.timestamp || []).map((timestamp, index) => ({
      d: new Date(timestamp * 1000).toISOString().slice(0,10), o: finite(q.open?.[index]),
      h: finite(q.high?.[index]), l: finite(q.low?.[index]), c: finite(adj[index]), v: finite(q.volume?.[index])
    })).filter(row => row.c !== null);
    const meta = result.meta || {}; const price = finite(meta.regularMarketPrice) ?? history.at(-1)?.c;
    const previousClose = finite(meta.chartPreviousClose) ?? history.at(-2)?.c;
    state.data.symbols[symbol] = {
      symbol, display: displayFor(symbol), name: meta.longName || meta.shortName || displayFor(symbol),
      exchange: meta.fullExchangeName || meta.exchangeName || "YAHOO", currency: meta.currency || "USD",
      price, previousClose, change: price - previousClose, changePct: previousClose ? (price / previousClose - 1) * 100 : null,
      history, news: [], options: null, lastTradeAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      source: "Yahoo Finance browser"
    };
    const known = state.watchlist.find(item => item.symbol === symbol); if (known && known.name === symbol) known.name = state.data.symbols[symbol].name;
    writeStorage(KEYS.watchlist, state.watchlist); renderAll(); if (showFeedback) toast(`${displayFor(symbol)} 已载入`);
  } catch (error) {
    console.warn(error); renderAll(); if (showFeedback) toast(`${displayFor(symbol)} 暂无可用数据`);
  }
}

function updateMarketStatus() {
  const badge = $("marketBadge"); const marketState = state.data.marketState || inferMarketState();
  const open = marketState === "open"; badge.classList.toggle("open", open); badge.innerHTML = `<i></i> ${open ? "美股交易中" : "美股已休市"}`;
  const timestamp = state.data.quoteGeneratedAt || state.data.generatedAt;
  if (!timestamp) { $("updatedAt").textContent = "等待报价 · 模型随报价更新"; return; }
  const date = new Date(timestamp); const ageMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  $("updatedAt").textContent = `${ageMinutes < 2 ? "报价刚刚更新" : `报价 ${ageMinutes} 分钟前`} · 模型已同步`;
}
function inferMarketState() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value; const day = get("weekday"); const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return !["Sat","Sun"].includes(day) && minutes >= 570 && minutes < 960 ? "open" : "closed";
}

function renderAll() {
  if (!state.watchlist.length) state.watchlist = structuredClone(DEFAULT_WATCHLIST);
  if (!state.watchlist.some(item => item.symbol === state.selected)) state.selected = state.watchlist[0].symbol;
  renderWatchlist(); renderSelected();
}

function alertState(symbol, item) {
  const price = finite(item?.price); const range = state.ranges[symbol]; if (price === null || !range) return null;
  if (finite(range.buyLow) !== null && finite(range.buyHigh) !== null && price >= range.buyLow && price <= range.buyHigh) return "buy";
  if (finite(range.sellLow) !== null && finite(range.sellHigh) !== null && price >= range.sellLow && price <= range.sellHigh) return "sell";
  return null;
}

function modelZoneState(item) {
  const price = finite(item?.price); const analysis = calculateAnalysis(item?.history || [], price);
  if (price === null || !analysis) return null;
  if (price >= analysis.buyLow && price <= analysis.buyHigh) return "buy";
  if (price >= analysis.sellLow && price <= analysis.sellHigh) return "sell";
  return null;
}

function renderWatchlist() {
  $("watchlist").innerHTML = state.watchlist.map(item => {
    const market = dataFor(item.symbol); const change = finite(market?.changePct); const alert = alertState(item.symbol, market); const modelZone = modelZoneState(market);
    const zoneLabel = alert ? `自定${alert === "buy" ? "买" : "卖"}` : modelZone ? `模型${modelZone === "buy" ? "买" : "卖"}` : "";
    return `<button class="watch-item ${item.symbol === state.selected ? "active" : ""} ${modelZone ? `model-${modelZone}` : ""} ${alert ? `alert-${alert}` : ""}" data-symbol="${escapeHtml(item.symbol)}" type="button">
      <span class="ticker-avatar">${escapeHtml(item.display.slice(0,4))}</span>
      <span class="ticker-id"><strong>${escapeHtml(item.display)} ${zoneLabel ? `<em class="zone-tag ${alert ? "custom" : ""}">${zoneLabel}</em>` : ""}</strong><small>${escapeHtml(item.name || item.symbol)}</small></span>
      <span class="ticker-quote"><strong>${market ? `${currencyMark(market)}${fmt(market.price)}` : "—"}</strong><small class="${change >= 0 ? "positive" : "negative"}">${pct(change)}</small></span>
      <span class="remove-symbol" data-remove="${escapeHtml(item.symbol)}">×</span>
    </button>`;
  }).join("");
}

function renderSelected() {
  const item = dataFor(); const watch = state.watchlist.find(entry => entry.symbol === state.selected) || { display: state.selected, name: state.selected };
  $("quoteSymbol").textContent = watch.display; $("quoteName").textContent = item?.name || watch.name || "等待行情";
  $("quoteExchange").textContent = item?.exchange || "—"; $("quoteCurrency").textContent = currencyMark(item); $("quotePrice").textContent = fmt(item?.price);
  const change = finite(item?.change); const changePct = finite(item?.changePct); const changeNode = $("quoteChange");
  changeNode.textContent = change === null ? "—" : `${change >= 0 ? "+" : ""}${fmt(change)}  ${pct(changePct)}`;
  changeNode.className = `quote-change ${change >= 0 ? "positive" : "negative"}`;
  $("optionsLink").href = `https://finance.yahoo.com/quote/${encodeURIComponent(state.selected)}/options/`;
  $("newsLink").href = `https://finance.yahoo.com/quote/${encodeURIComponent(state.selected)}/news/`;
  const analysis = calculateAnalysis(item?.history || [], item?.price); state.analysis = analysis;
  $("statPrev").textContent = fmt(item?.previousClose);
  $("stat52").textContent = analysis ? `${fmt(analysis.low52)} – ${fmt(analysis.high52)}` : "—";
  $("statVol").textContent = analysis ? `${fmt(analysis.annualVol,1)}%` : "—"; $("statAtr").textContent = analysis ? fmt(analysis.atr) : "—";
  renderChart(item?.history || [], analysis); renderAnalysis(analysis); renderRangeForm(analysis); renderOptions(item?.options); renderNews(item?.news || []); renderAlert(item);
}

function sma(values, period) { if (values.length < period) return null; return values.slice(-period).reduce((sum, value) => sum + value, 0) / period; }
function emaSeries(values, period) {
  if (!values.length) return []; const multiplier = 2 / (period + 1); const output = [values[0]];
  for (let index = 1; index < values.length; index++) output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  return output;
}
function standardDeviation(values) { if (!values.length) return null; const mean = values.reduce((sum,v) => sum + v,0) / values.length; return Math.sqrt(values.reduce((sum,v) => sum + (v-mean)**2,0) / values.length); }
function rsi(values, period = 14) {
  if (values.length <= period) return null; const diffs = values.slice(-period - 1).slice(1).map((value,index) => value - values.slice(-period - 1)[index]);
  const gains = diffs.reduce((sum,value) => sum + Math.max(0,value),0) / period; const losses = diffs.reduce((sum,value) => sum + Math.max(0,-value),0) / period;
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
}
function atr(history, period = 14) {
  if (history.length <= period) return null; const sample = history.slice(-period - 1); const ranges = sample.slice(1).map((row,index) => Math.max(row.h-row.l, Math.abs(row.h-sample[index].c), Math.abs(row.l-sample[index].c)));
  return ranges.reduce((sum,value) => sum + value,0) / ranges.length;
}
function lastValid(values) { return [...values].reverse().find(value => Number.isFinite(value)) ?? null; }
function median(values) { const sorted = values.filter(Number.isFinite).sort((a,b) => a-b); if (!sorted.length) return null; const mid = Math.floor(sorted.length/2); return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2; }

function calculateAnalysis(history, livePrice) {
  const valid = history.filter(row => finite(row.c) !== null && finite(row.h) !== null && finite(row.l) !== null); if (valid.length < 20) return null;
  const closes = valid.map(row => Number(row.c)); const highs = valid.map(row => Number(row.h)); const lows = valid.map(row => Number(row.l)); const price = finite(livePrice) ?? closes.at(-1);
  const sma20 = sma(closes,20), sma50 = sma(closes,50), sma200 = sma(closes,200); const rsi14 = rsi(closes); const atr14 = atr(valid) || price*.025;
  const ema12 = emaSeries(closes,12), ema26 = emaSeries(closes,26); const macdSeries = closes.map((_,index) => index < 25 ? null : ema12[index]-ema26[index]);
  const macdValues = macdSeries.filter(Number.isFinite); const macd = lastValid(macdValues), macdSignal = lastValid(emaSeries(macdValues,9));
  const std20 = standardDeviation(closes.slice(-20)); const bbUpper = sma20 + 2*std20, bbLower = sma20 - 2*std20;
  const high20 = Math.max(...highs.slice(-20)), low20 = Math.min(...lows.slice(-20)); const high60 = Math.max(...highs.slice(-60)), low60 = Math.min(...lows.slice(-60));
  const high52 = Math.max(...highs.slice(-252)), low52 = Math.min(...lows.slice(-252));
  const returns = closes.slice(-252).slice(1).map((value,index) => Math.log(value / closes.slice(-252)[index])); const annualVol = standardDeviation(returns) * Math.sqrt(252) * 100;
  const supports = [sma20,sma50,sma200,bbLower,low20,low60].filter(value => Number.isFinite(value) && value <= price*1.04 && value >= price*.65);
  const resistances = [bbUpper,high20,high60,high52,price+2*atr14].filter(value => Number.isFinite(value) && value >= price*.96 && value <= price*1.45);
  let support = median(supports) ?? price-1.5*atr14; let resistance = median(resistances) ?? price+2*atr14;
  if (sma50 && price > sma50 && sma20 > sma50) support = Math.max(support, Math.min(sma20,price));
  // Zones are centered on historical support/resistance. Do not anchor their edge
  // to the live price, otherwise the price can never actually enter the zone.
  const buyLow = Math.max(price*.55, support-.75*atr14); const buyHigh = support+.45*atr14;
  const sellLow = resistance-.35*atr14; const sellHigh = resistance+.75*atr14;
  let trendScore = 0; if (sma20) trendScore += price > sma20 ? 1 : -1; if (sma50) trendScore += price > sma50 ? 1 : -1; if (sma200) trendScore += price > sma200 ? 1 : -1; if (sma20 && sma50) trendScore += sma20 > sma50 ? 1 : -1;
  let signal = "等待"; let tone = "neutral";
  if (price >= sellLow || rsi14 >= 72) { signal = "偏向止盈"; tone = "sell"; }
  else if (price >= buyLow && price <= buyHigh) { signal = rsi14 < 48 ? "进入买入区" : "接近支撑"; tone = "buy"; }
  else if (trendScore >= 3 && rsi14 < 68 && macd >= macdSignal) { signal = "趋势持有"; tone = "buy"; }
  else if (trendScore <= -2) { signal = "谨慎等待"; tone = "sell"; }
  else signal = "区间等待";
  const completeness = clamp(valid.length/252,0,1); const alignment = Math.abs(trendScore)/4; const confidence = Math.round(clamp(48+completeness*25+alignment*17-(annualVol>75?8:0),35,90));
  const summaryParts = [];
  if (trendScore >= 3) summaryParts.push("中短期均线结构偏多"); else if (trendScore <= -2) summaryParts.push("价格位于多条关键均线下方"); else summaryParts.push("趋势信号尚未形成一致方向");
  if (rsi14 > 70) summaryParts.push("RSI 已进入偏热区"); else if (rsi14 < 35) summaryParts.push("RSI 接近超卖区"); else summaryParts.push("RSI 处于中性区间");
  summaryParts.push(`模型以约 ${fmt(atr14)} 的 ATR 为区间缓冲`);
  return { price,sma20,sma50,sma200,rsi14,atr:atr14,macd,macdSignal,bbUpper,bbLower,high52,low52,annualVol,buyLow,buyHigh,sellLow,sellHigh,trendScore,signal,tone,confidence,summary:summaryParts.join("；")+"。" };
}

function renderAnalysis(analysis) {
  if (!analysis) {
    $("modelBuyBox").classList.remove("active-zone"); $("modelSellBox").classList.remove("active-zone");
    $("signalText").textContent = "数据不足"; $("confidenceBar").style.width = "0"; $("confidenceText").textContent = "至少需要 20 个交易日";
    $("buyRange").textContent = $("sellRange").textContent = "—"; $("indicatorGrid").innerHTML = `<div class="empty-state">等待历史数据</div>`; $("analysisSummary").textContent = "当前标的尚无足够历史数据。"; return;
  }
  $("signalText").textContent = analysis.signal; $("signalText").className = analysis.tone === "buy" ? "positive" : analysis.tone === "sell" ? "negative" : "";
  $("confidenceBar").style.width = `${analysis.confidence}%`; $("confidenceText").textContent = `模型置信度 ${analysis.confidence}%`;
  $("buyRange").textContent = `$${fmt(analysis.buyLow)} – ${fmt(analysis.buyHigh)}`; $("sellRange").textContent = `$${fmt(analysis.sellLow)} – ${fmt(analysis.sellHigh)}`;
  $("modelBuyBox").classList.toggle("active-zone", analysis.price >= analysis.buyLow && analysis.price <= analysis.buyHigh);
  $("modelSellBox").classList.toggle("active-zone", analysis.price >= analysis.sellLow && analysis.price <= analysis.sellHigh);
  const inBuyZone = analysis.price >= analysis.buyLow && analysis.price <= analysis.buyHigh; const inSellZone = analysis.price >= analysis.sellLow && analysis.price <= analysis.sellHigh;
  $("buyDistance").textContent = inBuyZone ? "当前已进入模型区间" : `距区间上沿 ${pct((analysis.buyHigh/analysis.price-1)*100,1)}`;
  $("sellDistance").textContent = inSellZone ? "当前已进入模型区间" : `距区间下沿 ${pct((analysis.sellLow/analysis.price-1)*100,1)}`;
  const indicators = [
    ["SMA 20",fmt(analysis.sma20),analysis.price>analysis.sma20?"价格在上":"价格在下"], ["SMA 50",fmt(analysis.sma50),analysis.price>analysis.sma50?"价格在上":"价格在下"],
    ["SMA 200",fmt(analysis.sma200),analysis.sma200?analysis.price>analysis.sma200?"长期偏多":"长期偏弱":"样本不足"], ["RSI 14",fmt(analysis.rsi14,1),analysis.rsi14>70?"偏热":analysis.rsi14<35?"偏冷":"中性"],
    ["MACD",fmt(analysis.macd,2),analysis.macd>analysis.macdSignal?"动量向上":"动量向下"], ["布林带",`${fmt(analysis.bbLower)} / ${fmt(analysis.bbUpper)}`,"下轨 / 上轨"]
  ];
  $("indicatorGrid").innerHTML = indicators.map(([name,value,note]) => `<div class="indicator"><span>${name}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
  $("analysisSummary").textContent = analysis.summary;
}

function renderChart(history, analysis) {
  const periods = { "1M":22, "3M":66, "6M":132, "1Y":260 }; const valid = history.filter(row => finite(row.c) !== null); const rows = valid.slice(-(periods[state.period]||260));
  if (rows.length < 2) { $("chart").innerHTML = `<div class="chart-empty">暂无可绘制的历史数据</div>`; return; }
  const width = 900, height = 230, top = 12, bottom = 24; const closes = rows.map(row => Number(row.c));
  const sma50Values = closes.map((_,index) => index < 49 ? null : closes.slice(index-49,index+1).reduce((sum,value)=>sum+value,0)/50);
  const values = closes.concat(sma50Values.filter(Number.isFinite)); let min = Math.min(...values), max = Math.max(...values); const pad = Math.max((max-min)*.1, max*.005); min -= pad; max += pad;
  const x = index => index/(rows.length-1)*width; const y = value => top+(max-value)/(max-min)*(height-top-bottom);
  const linePath = valuesArray => valuesArray.map((value,index) => Number.isFinite(value) ? `${index && Number.isFinite(valuesArray[index-1])?"L":"M"}${x(index).toFixed(1)},${y(value).toFixed(1)}` : "").join(" ");
  const pricePath = linePath(closes); const areaPath = `${pricePath} L${width},${height-bottom} L0,${height-bottom} Z`; const smaPath = linePath(sma50Values);
  const levels = [0,.25,.5,.75,1].map(ratio => ({ y:top+ratio*(height-top-bottom), price:max-ratio*(max-min) }));
  const gridLines = levels.map(level => `<line x1="0" y1="${level.y}" x2="${width}" y2="${level.y}"/>`).join("");
  const gridLabels = levels.map(level => `<text x="${width-4}" y="${level.y-4}">${fmt(level.price)}</text>`).join("");
  const id = `g${state.selected.replace(/\W/g,"")}`;
  $("chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".25"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><g stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke">${gridLines}</g><g fill="var(--muted)" font-size="8" text-anchor="end">${gridLabels}</g><path d="${areaPath}" fill="url(#${id})"/><path d="${smaPath}" fill="none" stroke="var(--blue)" stroke-opacity=".65" stroke-width="1.4" vector-effect="non-scaling-stroke"/><path d="${pricePath}" fill="none" stroke="var(--accent)" stroke-width="2.2" vector-effect="non-scaling-stroke"/><circle cx="${x(rows.length-1)}" cy="${y(closes.at(-1))}" r="3.5" fill="var(--accent)" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderRangeForm(analysis) {
  const range = state.ranges[state.selected]; const set = (id,value) => { $(id).value = finite(value) === null ? "" : Number(value).toFixed(2); };
  set("buyLowInput",range?.buyLow); set("buyHighInput",range?.buyHigh); set("sellLowInput",range?.sellLow); set("sellHighInput",range?.sellHigh);
  const status = $("rangeStatus"); status.textContent = range ? "已保存" : "未设置"; status.classList.toggle("saved",Boolean(range));
  $("useModelRanges").disabled = !analysis;
}

function renderOptions(options) {
  if (!options || options.error) { $("optionsBody").innerHTML = `<div class="empty-state">${options?.error ? "该标的暂无期权快照" : "等待自动抓取期权快照"}</div>`; return; }
  const ratio = finite(options.putCallVolume); const tone = ratio === null ? "" : ratio > 1.15 ? "negative" : ratio < .75 ? "positive" : "";
  const contracts = (options.topContracts || []).slice(0,5).map(contract => `<div class="contract ${contract.type === "put" ? "put" : ""}"><b>${escapeHtml(contract.type?.toUpperCase()||"—")} ${fmt(contract.strike)}</b><span>Vol ${fmtCompact(contract.volume)}</span><span>V/OI ${fmt(contract.volumeOi,1)}</span></div>`).join("");
  $("optionsBody").innerHTML = `<div class="options-summary">
    <div class="option-stat"><span>到期日</span><strong>${escapeHtml(options.expiration || "—")}</strong><small>${options.daysToExpiry ?? "—"} DTE</small></div>
    <div class="option-stat"><span>Put / Call 成交量</span><strong class="${tone}">${fmt(ratio,2)}</strong><small>${ratio>1?"Put 更活跃":"Call 更活跃"}</small></div>
    <div class="option-stat"><span>Put / Call OI</span><strong>${fmt(options.putCallOi,2)}</strong><small>未平仓比率</small></div>
    <div class="option-stat"><span>估算 Max Pain</span><strong>$${fmt(options.maxPain)}</strong><small>按当前 OI 粗估</small></div>
  </div><div class="contract-list"><h3>异常活跃合约 · 按 Volume / OI</h3>${contracts || '<div class="empty-state">无活跃合约</div>'}</div><p class="options-caption">快照聚合成交量与未平仓量，不提供逐笔买卖方向；高 V/OI 仅代表当日活跃。</p>`;
}

function renderNews(news) {
  if (!news.length) { $("newsList").innerHTML = `<div class="empty-state">暂无新闻，点击“更多”打开外部新闻页</div>`; return; }
  $("newsList").innerHTML = news.slice(0,7).map(article => {
    const age = article.publishedAt ? relativeTime(article.publishedAt) : ""; const href = /^https?:\/\//.test(article.url||"") ? article.url : "#";
    return `<a class="news-item" href="${escapeHtml(href)}" target="_blank" rel="noopener"><div class="news-meta"><span>${escapeHtml(article.publisher||"Market News")}</span><span>${escapeHtml(age)}</span></div><h3>${escapeHtml(article.title||"Untitled")}</h3></a>`;
  }).join("");
}
function relativeTime(dateValue) { const seconds = Math.max(0,(Date.now()-new Date(dateValue).getTime())/1000); if(seconds<3600)return `${Math.max(1,Math.round(seconds/60))} 分钟前`; if(seconds<86400)return `${Math.round(seconds/3600)} 小时前`; return `${Math.round(seconds/86400)} 天前`; }

function renderAlert(item) {
  const kind = alertState(state.selected,item); const banner = $("alertBanner"); if (!kind || state.dismissedAlert) { banner.hidden = true; return; }
  const range = state.ranges[state.selected]; banner.hidden = false; banner.classList.toggle("sell",kind==="sell");
  $("alertIcon").textContent = kind === "buy" ? "↓" : "↑"; $("alertTitle").textContent = kind === "buy" ? "进入自定义买入区间" : "进入自定义卖出区间";
  $("alertText").textContent = `${displayFor(state.selected)} 当前价 $${fmt(item.price)}，位于 $${fmt(range[`${kind}Low`])} – $${fmt(range[`${kind}High`])}。`;
  maybeNotify(kind,item,range);
}
function maybeNotify(kind,item,range) {
  if (localStorage.getItem(KEYS.notifications) !== "on" || Notification.permission !== "granted") return;
  const marker = `${state.selected}-${kind}-${new Date().toISOString().slice(0,10)}`; if (sessionStorage.getItem(marker)) return; sessionStorage.setItem(marker,"1");
  new Notification(`${displayFor(state.selected)} ${kind === "buy" ? "买入" : "卖出"}区间提醒`, { body:`当前价 $${fmt(item.price)} · 区间 $${fmt(range[`${kind}Low`])}–$${fmt(range[`${kind}High`])}` });
}

function bindEvents() {
  $("watchlist").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove]"); if (remove) { event.stopPropagation(); removeSymbol(remove.dataset.remove); return; }
    const button = event.target.closest("[data-symbol]"); if (!button) return; state.selected = button.dataset.symbol; state.dismissedAlert = false; localStorage.setItem(KEYS.selected,state.selected); renderAll(); if(!dataFor()) fetchCustomSymbol(state.selected);
  });
  $("addSymbolForm").addEventListener("submit", event => { event.preventDefault(); const input=$("symbolInput"); let symbol=input.value.trim().toUpperCase(); if(!symbol)return; if(symbol==="SPX")symbol="^GSPC"; if(symbol==="BTCUSD")symbol="BTC-USD"; if(!state.watchlist.some(item=>item.symbol===symbol))state.watchlist.push({symbol,display:symbol.replace("-USD","USD").replace("^GSPC","SPX"),name:symbol}); state.selected=symbol; input.value=""; writeStorage(KEYS.watchlist,state.watchlist); localStorage.setItem(KEYS.selected,symbol); renderAll(); fetchCustomSymbol(symbol); });
  $("resetWatchlist").addEventListener("click",()=>{state.watchlist=structuredClone(DEFAULT_WATCHLIST);writeStorage(KEYS.watchlist,state.watchlist);renderAll();toast("已恢复 deskboard 默认列表");});
  $("refreshButton").addEventListener("click",()=>loadMarketData(true));
  document.querySelectorAll("[data-period]").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll("[data-period]").forEach(node=>node.classList.remove("active"));button.classList.add("active");state.period=button.dataset.period;renderChart(dataFor()?.history||[],state.analysis);}));
  $("rangeForm").addEventListener("submit", event => { event.preventDefault(); const value=id=>finite($(id).value); const range={buyLow:value("buyLowInput"),buyHigh:value("buyHighInput"),sellLow:value("sellLowInput"),sellHigh:value("sellHighInput")}; if([range.buyLow,range.buyHigh,range.sellLow,range.sellHigh].some(v=>v===null)){toast("请完整填写两个价格区间");return;} if(range.buyLow>range.buyHigh||range.sellLow>range.sellHigh){toast("最低价不能高于最高价");return;} state.ranges[state.selected]=range;writeStorage(KEYS.ranges,state.ranges);state.dismissedAlert=false;renderAll();toast("提醒区间已保存"); });
  $("useModelRanges").addEventListener("click",()=>{if(!state.analysis)return; const a=state.analysis; $("buyLowInput").value=a.buyLow.toFixed(2);$("buyHighInput").value=a.buyHigh.toFixed(2);$("sellLowInput").value=a.sellLow.toFixed(2);$("sellHighInput").value=a.sellHigh.toFixed(2);toast("已填入模型区间，点击保存后生效");});
  $("dismissAlert").addEventListener("click",()=>{state.dismissedAlert=true;$("alertBanner").hidden=true;});
  $("methodButton").addEventListener("click",()=>$("methodDialog").showModal());
  $("themeButton").addEventListener("click",()=>{document.body.classList.toggle("light");localStorage.setItem(KEYS.theme,document.body.classList.contains("light")?"light":"dark");});
  $("notifyButton").addEventListener("click",async()=>{if(!("Notification" in window)){toast("当前浏览器不支持系统通知");return;} const result=await Notification.requestPermission(); if(result==="granted"){localStorage.setItem(KEYS.notifications,"on");$("notifyButton").textContent="●";toast("价格通知已启用");}else toast("未获得通知权限");});
}
function removeSymbol(symbol) { if(state.watchlist.length<=1){toast("至少保留一个标的");return;} state.watchlist=state.watchlist.filter(item=>item.symbol!==symbol);if(state.selected===symbol)state.selected=state.watchlist[0].symbol;writeStorage(KEYS.watchlist,state.watchlist);localStorage.setItem(KEYS.selected,state.selected);renderAll(); }

function init() {
  if (localStorage.getItem(KEYS.theme)==="light") document.body.classList.add("light");
  if (localStorage.getItem(KEYS.notifications)==="on") $("notifyButton").textContent="●";
  bindEvents(); updateMarketStatus(); renderAll(); loadMarketData(false); setInterval(()=>loadMarketData(false),60*1000);
}
init();
