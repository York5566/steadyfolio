# GitHub + Cloudflare 上線指南

## 建議架構與邊界

**GitHub 存放原始碼／執行 CI → Cloudflare Worker Static Assets 提供網站 → Worker API → D1。**使用同一 HTTPS 網域，避免 API 跨域、分享網址及 CSP 設定混亂。靜態頁不先進 Worker；只有 `/api/*` 進入 API。回測在使用者的 Web Worker 計算，D1 不做回測工作。

這不是直接推上 GitHub Pages 就具備分享後端的版本。若「GitHub 託管」特指 Pages：根網域靜態內容可另部署，但 D1、API、Turnstile 仍需 Worker，且必須另外調整 CSP、`VITE_API_BASE`、精確 CORS 和部署流程；`username.github.io/repository/` 子路徑目前未支援。預設不走這條雙網域路線。

## 0. 上線前決定

- 正式網域、網站名稱、營運者法律名稱／客服與資料申訴管道，更新 `src/documents.ts`。
- 目前依使用者選擇沿用原來源自動抓取；公開商用前確認資料的儲存、展示、瀏覽器分發、使用者快照與下載授權。需要只提供已授權資料時，設定 `MARKET_FETCH_ENABLED=false` 並維護授權資料；分享未就緒時保持 `SHARING_ENABLED=false`。
- GitHub Repository **以本「網頁版」資料夾內容作為根目錄**。不要把桌面版、個人快取、驗證私檔一起推上去。若改用 monorepo，Actions 工作目錄及 cache 路徑需要另改。
- `.dev.vars`、`.env`、`data-private`、`.wrangler`、`node_modules`、`wrangler.deploy.json`、分享管理檔不得提交。設定 GitHub production environment 的人工部署審核。

## 1. 本人登入並建立 D1

下列步驟會修改自己的 Cloudflare 帳號，由營運者在確認後執行；此交付未替你執行。

```powershell
npm ci
npx wrangler login
npx wrangler d1 create steadyfolio
```

記下回傳的 database ID。在 PowerShell 設定本次部署環境；正式網域須先選定，workers.dev 也可：

```powershell
$env:SITE_URL='https://你的實際網站網域'
$env:CLOUDFLARE_D1_DATABASE_ID='剛建立的 UUID'
$env:SHARING_ENABLED='false'
npm run check
npx tsx scripts/preflight.ts
npx wrangler d1 migrations apply steadyfolio --remote --config wrangler.deploy.json
npx wrangler deploy --config wrangler.deploy.json
```

必須在 build 前設 `SITE_URL`；只改執行階段變數不會改 HTML canonical。無有效網域的預覽自動 noindex；preflight 拒絕錯誤網域、未設定 D1、建置網域不符或測試 Turnstile key。它無法替你確認 DNS、真實帳號或遠端 secret 是否正確。

自訂網域可於 Cloudflare Dashboard 的 Worker → Settings → Domains & Routes 加入。確認 DNS／TLS 完成，重新用該網域建置。避免同時公開多個可寫 API 網域；關閉不需要的 workers.dev 路由或重新導向正式網域。

## 2. 開啟分享

1. 建立自己的 Turnstile widget，hostname 只允許正式站網域。
2. 將 site key 設為 `$env:TURNSTILE_SITE_KEY`。**Secret key 不放前端或 GitHub 變數**。
3. `npx wrangler secret put TURNSTILE_SECRET_KEY`，互動輸入 secret。
4. 設 `$env:SHARING_ENABLED='true'`，重新 `npm run check`、`npm run deploy`。
5. 正式站實測挑戰通過、失敗、過期、重複 token、不同 hostname／action 皆符合預期。測試 key 不可進正式環境；本機 bypass 需要 loopback + local 環境同時成立。

上線初期保持預設每日 30 份／單份 512 KiB／總快照 220 MB；容量滿會拒絕新分享，不刪掉尚未到期的資料。每份 30 天到期，每日 UTC 03:17 清理最多 200 份。

## 3. 行情維護

預設 Worker 直接按代碼與期間抓取桌面版同源資料，不需要先匯入 CSV 或執行 Python。首次啟動也能從空的 D1 取得資料。升級既有網站必須套用 `0002_automatic_market.sql`（執行所有 migrations 即可）。`GET /api/history/:symbol/:start/:end` 回傳完成資料，或 202 月份進度；前端自動接續未完成月份。

0050 延長期間只補缺段及至少三個重疊交易日，驗證還原比例後銜接；每次最多取得 2 個月份，批次內間隔 2.1 秒，瀏覽器續批另等 2.1 秒，最後一批直接回傳。仍核對配息和分割。其他股票用 Yahoo chart 的 Adj Close，2000 年起匯率優先直接使用聯準會 H.10，連線失敗才改 FRED DEXTAUS；更早期間仍用 FRED。固定 HTTPS 主機與路徑、拒絕 redirect；不接受使用者提供網址。資料抓取每 IP／節點 15 次／分鐘，D1 原子限制全站上游請求預設 800 次／天，失敗冷卻 60 秒，並用每代碼鎖避免重複下載。可透過 `DAILY_MARKET_FETCH_LIMIT` 降低預算。

近期資料共用快取 6 小時；已完整查詢的歷史區間重用快取。0050 過去月份快取 30 天，當月與公司行動快取 6 小時，當月另核對已查詢日期，避免收盤前快取擋住收盤後的新資料。最多 128 份行情，每份 512 KiB；沒有任意日期組合永久快取。來源最後資料落後有效要求結束日超過 10 天會拒絕更新；舊結果明確標示且暫停分享。若來源暫停服務或容量已滿，顯示錯誤，已快取資料仍可讀。免費 Worker CPU 與供應商對 Cloudflare IP 的連線情形仍須部署後實測。

以下管理匯入介面僅供日後改用授權資料來源，不是一般使用者流程：

- 用 `wrangler secret put ADMIN_TOKEN` 設定至少 32 字元隨機管理 token。
- 使用標準 PriceSeries JSON 陣列；見 `src/core/schema.ts` 與 DATA_SOURCES.md。
- 設 `MARKET_API_ORIGIN`、`MARKET_ADMIN_TOKEN`、`DATA_RIGHTS_CONFIRMED=true`，執行 `npm run data:import -- 檔案.json`。
- 正式環境只接受 `source=market`、`usage=redistribution-licensed`；此標籤是授權聲明，不是授權本身。
- 匯入逐檔進行，失敗停止，不自動重試；先成功的檔案保留，重跑同 symbol 為覆寫。上線資料建議於低流量時段整批更新；不是多標的一次原子發布。
- 管理匯入清單上限 64 個標的，自動下載快取上限 128 個；每標的 12,000 筆／512 KiB。舊目錄 API 快取 15 分鐘，自動抓取 API 依 D1 覆蓋範圍與時間判斷快取。

`refresh-data.yml` 預設停用。只有 `LICENSED_DATA_PIPELINE_ENABLED=true` 時執行；`LICENSED_DATA_URL` 必須是營運者控制的 HTTPS **標準 JSON 資料集**，不是直接把任何商用資料 API key 填進去。需自行完成已授權來源轉換與維運，不代表已串接某個付費商。

## 4. GitHub Actions

CI 在 push／PR 執行單元測試、型別／打包、靜態頁與依賴掃描。Deploy 僅 `workflow_dispatch`，不會每次 push 自動上線。

Repository / production environment 設定：

| 種類 | 名稱 |
|---|---|
| Secrets | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |
| Variables | `SITE_URL`、`CLOUDFLARE_D1_DATABASE_ID`、`SHARING_ENABLED`、`TURNSTILE_SITE_KEY`、`MARKET_FETCH_ENABLED`（未設時為 true） |
| Worker secrets | `TURNSTILE_SECRET_KEY`、`ADMIN_TOKEN` |

Cloudflare API token 只授權該帳號需要的 Worker scripts／D1 操作，不使用全域 API key。Actions 不輸出 secret。鎖定依賴版號；更新前跑測試。需要更嚴格供應鏈政策時，將 GitHub actions 固定至經核對的 commit SHA 並設定 Dependabot。

## 5. SEO 與廣告

- 中／英文有可爬取的靜態介紹、FAQ、方法、隱私與風險頁；不是只有空白 JavaScript app。
- 正式建置產生 canonical、hreflang／x-default、sitemap、robots、Open Graph、WebApplication JSON-LD。未捏造評分、見證或收益承諾。
- 分享內容使用 URL fragment 的隨機 ID、noindex/noarchive、不放 sitemap；社群預覽只顯示通用說明，不洩漏分析金額。
- 設好正式網域後向搜尋引擎提交 sitemap，實測 robots、真實 404、canonical、行動裝置效能與結構化資料。**不保證排名、收錄或廣告審核通過。**
- 本版不植入廣告。未來加廣告前：核對投資內容與資料授權，補隱私／同意管理、必要的 CMP／地區政策及 ads.txt；依廠商需求最小化調整 CSP，不可改成 `*` 或 `unsafe-eval`。
- 廣告不要遮住輸入、圖表或分享確認，預留固定尺寸避免 CLS。不要在私人分享快照載入廣告／分析追蹤；避免把投入金額、標的或 ID 傳給廣告商。

## 6. 正式驗收、監控與回復

- 真實 HTTPS 網域確認 10 個語系頁、404、CSP、無 console error、桌面／手機與鍵盤流程。
- 真實 Turnstile 建立分享 → 不同瀏覽器開啟 → 接續修改 → 原分享不變 → 管理檔撤銷 → 舊網址不可讀。
- 查 D1 執行指標、Worker CPU／錯誤／限流命中、Cron 清理與過期資料；不要記錄 POST body、撤銷 token、Authorization 或整份分享。
- 免費額度是整個帳號／方案的資源限制，不保證服務永不中斷。讀取攻擊仍可能耗盡額度；依 SECURITY.md 加邊緣防護、告警及緊急停用流程。
- 發版前備份 D1、保存前一版 Worker 和相同 schema／engine 的程式。資料 migration 只新增不回滾刪表；先試本機再執行 remote。
- 緊急停止新分享：`SHARING_ENABLED=false` 重新部署，既有 GET 與撤銷仍可用。若所有 API 遭攻擊，用 Cloudflare 規則封鎖 `/api/*`（會暫停所有分享）。
- 回滾 Worker 時必須確認舊版仍理解現有 schema；不要默默以新算法重算舊分享。

**尚未完成的外部事項：**建立實際 GitHub repo／Cloudflare 資源、正式 DNS／TLS、商用資料授權、營運者與客服資訊、真實 Turnstile、遠端備份／監控設定、正式負載與 CPU 驗證。交付測試不代表上述已完成。
