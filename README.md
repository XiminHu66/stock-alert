# Stock Alert

一个可直接部署到 GitHub Pages 的个人交易观察台：自选股、准实时行情、新闻、期权活跃度、技术指标、模型买卖观察区间和自定义价格提醒。

## 功能

- 默认股票列表继承 `deskboard`：SPX、QQQ、AAPL、SMH、NVDA、BTCUSD、INTC、UNH、HOOD、NOW、VST、MRVL。
- 自由添加/删除股票，自选列表与价格区间保存在浏览器 `localStorage`。
- GitHub Actions 在美股交易时段约每 5 分钟更新轻量报价，每 30 分钟更新历史行情、相关新闻和期权快照；GitHub 调度繁忙时可能延后。
- 技术模型使用 SMA 20/50/200、RSI 14、MACD、布林带、ATR 14、52 周高低点与近期支撑阻力，并在浏览器中做无前视的滚动历史检验。
- 期权面板可视化 Call/Put 成交活跃度、Put/Call 比趋势、行权价 OI 分布、Put Wall、Call Wall 与 Max Pain；这些是描述性统计，不是逐笔买卖方向。
- PE、预期 PE、市净率、PEG 与增长率作为独立估值背景显示，不混入技术买卖区间。
- 股票进入用户设定的买入或卖出区间时，高亮自选项并显示页面提醒；用户可自行启用浏览器系统通知。
- 响应式布局，支持桌面和手机、深色和浅色主题。

## 数据说明

数据由 GitHub Actions 中的 `yfinance` 获取。网页每分钟检查最新报价快照，报价目标频率约 5 分钟；新闻、期权和完整历史数据目标频率约 30 分钟。GitHub 调度或数据源限制可能导致额外延迟。模型在浏览器中计算，每次报价载入都会重新推演。期权数据是成交量、未平仓量和隐含波动率快照，不是逐笔成交方向或付费订单流。自定义股票会优先尝试浏览器端 Yahoo Finance 图表接口；若浏览器或数据源限制跨域访问，需将该代码加入 `scripts/fetch_market.py` 的缓存列表。

“指标一致度”只表示模型内部技术信号的一致程度，不是上涨概率。滚动检验记录历史时点进入模型买入区后 20 个交易日的表现，不含交易成本、滑点、税费与分红，也不是独立样本的生产级回测。模型区间只用于研究和价格提醒，不构成投资建议。财报、宏观事件和跳空可能令历史技术位立即失效。

## GitHub Pages

仓库包含官方 Pages Actions 部署工作流。首次使用时，在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，然后重新运行 `Deploy Stock Alert to Pages` 工作流。

## 本地预览

```bash
python -m http.server 8000
```

访问 `http://localhost:8000`。
