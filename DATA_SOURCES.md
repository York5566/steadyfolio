# 資料來源與商用邊界

查核日期：2026-10-17。以下是技術選型紀錄，不是法律意見或已取得授權的證明；正式用途須向提供者確認並保存條款／契約版本。

## 結論：免費優先，但不把可下載當作可商用

尚未確認免費且完整涵蓋台美長期含息還原價、網站展示、瀏覽器端計算、長期儲存、下載與匿名分享快照的來源。因此依使用者決定，沿用既有來源做本機研究，保留可替換資料層，**未購買任何方案**。

| 來源 | 查到的邊界／用途 |
|---|---|
| [政府資料開放平臺：上櫃股票每日收盤行情](https://data.gov.tw/dataset/11370) | 公開資料集標示政府資料開放授權條款；部分台灣日行情可商業利用，但不是完整台美長期含息歷史資料庫。 |
| [政府資料開放授權條款](https://data.gov.tw/license) | 允許符合條款的重製、改作、散布與商業利用，須履行顯名等義務；只適用明確以此授權釋出的資料，不延伸到整個網站所有 API。 |
| [TWSE 使用條款](https://www.twse.com.tw/zh/terms/use.html) | 除明確開放資料等情況外，不能假設抓得到就能公開再分發；原研究轉接器不是商用授權。 |
| [yfinance 說明](https://ranaroussi.github.io/yfinance/) | 套件程式授權和 Yahoo 行情權利不同；文件提醒 Yahoo 資料用途限制，不可把開源程式視為行情分發許可。 |
| [Alpha Vantage 條款](https://www.alphavantage.co/terms_of_service/) | 未取得其他書面同意時存在個人／非商業使用限制；不是本需求的已確認免費商用方案。 |
| [Twelve Data 商業方案](https://twelvedata.com/pricing-business) | 查核頁面列 Venture 約 US$499／月起、Enterprise 約 US$1,099／月起，分別涉及外部展示／分發；台灣市場見[交易所頁](https://twelvedata.com/exchanges?country=Taiwan)。價格與可用權利仍依實際市場、用途和合約，不是購買建議。 |
| [EODHD 商業方案](https://eodhd.com/commercial-pricing) | 外部展示／再分發與個人或內部方案不同，需另行洽談；不將最低內部方案價格誤當網站完整授權。 |
| [FRED DEXTAUS](https://fred.stlouisfed.org/series/DEXTAUS) | 研究轉接器使用的 USD/TWD 匯率，需連同來源標示、更新時間與原始權利逐項確認，不能據此推定股票資料也可商用。 |

若後續採開放資料組裝，可先支援明確授權的一部分台灣市場，但需另外建完整歷史、公司行動、除息、分割、校正與匯率管線，不能拿未還原收盤價冒充含息績效。

## 網站自動抓取（2026-10-20）

已移除使用者 CSV 匯入。`worker/providers.ts` 將桌面版 `portfolio_lab/data.py`、`official_data.py` 的來源與核心資料處理移植為 Worker 可執行的 TypeScript，`worker/market.ts` 管理下載進度與 D1 快取。網站直接使用，不需要另外執行下方 Python 指令。

- 0050：TWSE 每月原始收盤 + 元大完整歷年配息 + TWSE 分割，使用 `(當日價格 × 分割比率 + 除息金額) / 前日價格` 重建含息序列。2025-06-18 的 1 拆 4 明確驗證；未知新分割、缺公司行動當日價格或重建後異常跳動會停止，不退回 Yahoo 0050。
- 其他台美股票：與 yfinance 相同的 Yahoo chart 歷史端點，使用 Adj Close；核對代碼、幣別、標的種類、交易所時區，排除 2019 年起台灣非交易週末資料。這是同來源移植，並非在 Worker 執行 Python/yfinance。
- 匯率：2000 年起優先直接讀取[聯準會 H.10 新台幣歷史日匯率](https://www.federalreserve.gov/releases/h10/hist/dat00_ta.htm)，與 FRED DEXTAUS 同樣為每美元兌多少新台幣；連線失敗才使用 FRED 備援，較早期間仍使用 FRED。核對幣別方向、日期、缺值與異常跳動，不退回曾有歷史異常的 Yahoo 匯率。未發布日保留缺值，不取未來匯率填補；聯準會週次發布有時間差。
- 所有原來源資料維持 `usage=research-only`；自動抓取不代表已取得公開商用權。依使用者選擇先沿用，不購買付費方案。

## 保留的維護／比對流程（非使用前置步驟）

`scripts/refresh-market.py` 是獨立轉接器：

- 0050：沿用 TWSE 月行情、元大配息及分割處理的原邏輯，不退回已知不適合的替代還原資料。
- 其他股票：yfinance 的 Adj Close，保留報價幣別驗證。
- 匯率：FRED DEXTAUS，輸出符號統一成 USDTWD（TWD / USD）。
- 只輸出 `data-private/*.json`，`usage=research-only`。不自動上傳、不修改桌面快取、不中途把失敗轉成合成資料。
- `--desktop-cache` 只讀原有單組版 `data/cache` 的已驗證資料；0050 的輔助官方快取可複製到本版私有快取。不是任何舊 CSV 都可直接信任；需符合 symbol/hash/version/currency 檢查。

在獨立 Python 3.11+ 環境安裝 `scripts/requirements-data.txt` 後：

```powershell
python scripts/refresh-market.py --symbols '0050.TW,VTI,QQQ,TWD=X' --start 2015-01-01 --end 2025-12-31
```

在目前專案旁使用既有快取（可選，不是必要依賴）：

```powershell
..\.venv\Scripts\python.exe scripts/refresh-market.py --cache-only --desktop-cache '..\data\cache' --end 2025-12-31
```

原來源可能限制頻率、回傳不完整或改版。0050 首次長歷史抓取較慢；不要用 GitHub 公開 artifact 儲存其回傳資料。不能把原資料來源的「研究用途」文字移掉後就認定合法商用。

### 增量更新與結束日期

已驗證的官方 0050 含息序列延長期間時，只抓缺少的首尾區間與重疊月份，不因原始月快取不在而重抓十多年。至少三個重疊交易日的還原比例必須一致，否則停止，不硬接不同尺度的價格。完全空庫的第一次長歷史仍需逐月抓取，保留節流、進度與取消；最後一批直接回傳，不多等一次輪詢。

當月原始快取記錄已查詢到的日期，不能把收盤前的快取當作已涵蓋收盤後。台股以台北 17:00、美股以紐約 18:00 作為保守的日行情可用界線，再由來源的實際交易日決定；不是保證該時間供應商已發布。要求當日或未來日，不會產生尚未收盤的價格。

自動來源最後資料距有效要求結束日超過 10 天會拒絕更新並顯示錯誤，不悄悄宣稱已完成新期間。所有比較仍以真實共同交易日計算；匯率只沿用不超過 7 天的已知歷史值。

### 匯入本機網站行情

先啟動本機 Worker，使用自己 `.dev.vars` 的 ADMIN_TOKEN：

```powershell
$env:MARKET_API_ORIGIN='http://127.0.0.1:5173'
$env:MARKET_ADMIN_TOKEN='本機設定的 ADMIN_TOKEN'
npm run data:import -- data-private/research-market.json
```

管理匯入會間隔 13 秒以遵守寫入限流。重新解壓 ZIP 不含真實研究資料，但網站會自動下載，無須手動灌入；失敗顯示重新抓取，不轉成示範。

## 正式來源介面

使用一個 JSON 陣列，每個元素符合 `src/core/schema.ts` 的 PriceSeries：

```json
{
  "symbol": "TEST",
  "name": "Synthetic contract example",
  "currency": "USD",
  "market": "US",
  "priceKind": "total-return",
  "source": "market",
  "sourceName": "Replace with the actual licensed source and attribution",
  "usage": "redistribution-licensed",
  "asOf": "2020-01-03",
  "rows": [["2020-01-01",100],["2020-01-02",101],["2020-01-03",102]]
}
```

這只是合成格式範例，不是實際可用的股票資料。價格需已依供應商規則調整；`total-return` 含息、`split-adjusted` 不含息但已調整分割。不可混用不同口徑。至少 3 筆、嚴格升序、無重複日期、不接受 NaN／Infinity／非正價格。

商用合約詢問清單：

1. 台股上市／上櫃、美股和 ETF 的歷史長度與每日更新權。
2. 公司行動與還原方式、幣別、交易所／時區及更正機制。
3. 在免費但含廣告的網站公開展示與匿名使用者瀏覽器下載權。
4. D1／CDN 儲存、資料保留、原資料與衍生資料的條款。
5. 使用者分析檔、CSV、圖片、30 天分享快照及朋友接續分析的權利。
6. 必須標示的名稱／連結、地區／使用者數／流量限制、終止合約後如何處理既有快照。

正式 Worker 保留 research-only 資料的管理匯入與公開分享限制；自動抓取功能依使用者選擇沿用原來源。schema 與來源標籤不等於權利或正確性保證，公開商用前仍需確認實際供應商條款。
