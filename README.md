# Stock Alert

一个可直接部署到 GitHub Pages 的个人交易观察台：自选股、准实时行情、新闻、期权活跃度、技术指标、模型买卖观察区间和自定义价格提醒。

## 功能

- 默认股票列表继承 `deskboard`：SPX、QQQ、AAPL、SMH、NVDA、BTCUSD、INTC、UNH、HOOD、NOW、VST、MRVL。
- 自由添加/删除股票，自选列表与价格区间保存在浏览器 `localStorage`。
- GitHub Actions 在美股交易时段每 15 分钟更新行情、相关新闻和期权快照。
- 技术模型使用 SMA 20/50/200、RSI 14、MACD、布林带、ATR 14、52 周高低点与近期支撑阻力。
- 股票进入用户设定的买入或卖出区间时，高亮自选项并显示页面提醒；用户可自行启用浏览器系统通知。
- 响应式布局，支持桌面和手机、深色和浅色主题。

## 数据说明

数据由 GitHub Actions 中的 `yfinance` 获取，通常延迟 15–30 分钟。期权数据是成交量、未平仓量和隐含波动率快照，不是逐笔成交方向或付费订单流。自定义股票会优先尝试浏览器端 Yahoo Finance 图表接口；若浏览器或数据源限制跨域访问，需等待将该代码加入 `scripts/fetch_market.py` 的缓存列表。

模型区间只用于研究和价格提醒，不构成投资建议。财报、宏观事件和跳空可能令历史技术位立即失效。

## GitHub Pages

仓库包含官方 Pages Actions 部署工作流。首次使用时，在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，然后重新运行 `Deploy Stock Alert to Pages` 工作流。

## 本地预览

```bash
python -m http.server 8000
```

访问 `http://localhost:8000`。
