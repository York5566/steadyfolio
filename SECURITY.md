# 安全與容量設計

## 已實作

- 無帳號／付款／券商權限。計算與檔案匯入在瀏覽器；無隱式上傳。
- 128-bit 隨機分享 ID；256-bit 獨立撤銷密鑰，只存 SHA-256。ID 不可枚舉，不等於認證或私密儲存。
- 分享上傳明確確認；production Turnstile server verification 檢查 success、hostname、action，8 秒 timeout。所有錯誤 fail closed。正式拒絕測試 site key。
- 每 IP／節點 GET 90 次／分鐘、寫入 5 次／分鐘；缺 limiter 則拒絕。正式訪客 IP 取 Cloudflare 注入欄位，不能在其他反代上直接信任客戶端偽造欄位。
- 寫入精確 Origin allowlist；無 wildcard CORS。CORS 不是對非瀏覽器客戶端的認證。管理匯入另需高熵 bearer secret。
- JSON 型別、實際串流位元組上限、strict schema、日期／數值／筆數／字串上限；拒絕多餘欄位與 content encoding。CSV 匯出防公式注入。
- D1 參數化 SQL；單一 INSERT + trigger 原子限制每日分享數與總 payload bytes，撤銷不返還當日配額，避免刪建循環。
- 分享無 CDN／瀏覽器快取；到期或撤銷立即不可讀。到期資料有限量每日清除與索引，不全表掃描。
- 股票資料有固定符號白名單格式與固定 API；不接受匿名外部 URL，無任意 SSRF 代理。
- 自動抓取使用固定 HTTPS 端點、拒絕轉址、10 秒上游逾時、實際串流 4 MB 上限；每代碼 45 秒租約、失敗冷卻 60 秒。每 IP／節點 15 次／分鐘；全站 D1 原子預算預設 800 次上游請求／天，快取命中不占上游預算。0050 分次下載並顯示進度。
- HTML／React 預設轉義；ECharts tooltip 不使用可注入的 HTML。CSP、frame 禁止、nosniff、no-referrer、HSTS、permissions policy；無外部字型／廣告／追蹤。
- 網頁與 JSON 不包含管理 secret。正式流程不使用本機設定，原始行情／token／管理檔不打包。

## 免費額度與保守預算

官方查核日 2026-10-17；請在真正上線時重查：

- [D1 免費額度](https://developers.cloudflare.com/d1/platform/pricing/)：每日讀取 500 萬 rows、寫入 10 萬 rows、帳號儲存總額 5 GB。
- [D1 平台限制](https://developers.cloudflare.com/d1/platform/limits/)：免費單一 DB 上限 **500 MB**，不是 5 GB。
- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)：免費每天 100,000 次 Worker requests、每次 10 ms CPU。靜態資產／Worker／D1 是不同計量項目。
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) 是節點附近的非精確限流，不是跨全球一致的付費控制。本專案另用 D1 原子約束新分享數與 payload bytes。

預設最多 30 份新分享／天、512 KiB／份、220 MB 有效 payload 預算，管理目錄最多 64 份、自動行情快取最多 128 份，各 512 KiB 以下；0050 月資料只有固定月份鍵，下載租約最多 256 個代碼並清理 7 天未使用紀錄。預留 SQLite page／index／其他表空間；220 MB 是應用 payload 數量，**不是實測 DB 檔案大小保證**。每日快照清理 200 份，大於正常新建上限。

## 上線仍需補的防線

1. 此版能降低濫用，但**不能保證 DDoS 下維持免費額度或不中斷**。分散式來源仍能耗盡 Worker requests／D1 reads；增加 Cloudflare 邊緣規則、Bot 防護和實際方案支援的限流，監控帳號總用量。
2. 實際正式 Worker CPU 需測量，尤其 512 KiB JSON schema 檢查；本機時長不等於邊緣 CPU。若超過免費 10 ms，可先降低分享容量／資料點數；不要默默升級付費或宣稱已適用所有流量。
3. 免費額度超過可能中斷；若帳號切到付費方案，應重核費用、告警與預算。不要把 API 限流當成硬性帳單上限。
4. 正式 Turnstile、DNS／TLS、跨裝置分享、Cron、D1 備份／還原與資料保留都需部署後驗證。單元測試的 mock 不是線上驗證。
5. 匿名分享沒有私人 ACL、密碼或端對端加密。知道網址的人可讀、下載或轉傳；noindex 和 fragment 不能阻止他們。
6. 使用者可匯入並聲明任意資料；不代表網站驗證過其來源或績效。必須提供資料權利申訴、刪除處理和營運者聯絡方式；本版沒有後台審核系統。
7. 研究資料標籤可由惡意客戶端更改，伺服器的標籤 gate 是防誤上線，不是 DRM 或版權鑑別器。需要營運政策與合約配合。
8. 存取日誌只保留必要欄位與時間；預設關閉 Worker observability，若啟用請先訂定留存與遮蔽。CDN／Cloudflare 本身仍處理技術資訊。

## 事故處理

- 先停止新分享或邊緣封鎖受攻擊 API，保存不含 payload／secret 的必要證據。
- 洩漏 ADMIN_TOKEN／Turnstile secret：在 Cloudflare 輪替、更新 GitHub secrets；不要只從 Git 目前檔案刪掉。
- 洩漏管理檔：持有人能撤銷該分享；下載副本無法回收。建議撤銷後視需要建立新連結。
- 資料供應商撤回權利：停止更新及公開提供相關行情，依合約處理既有快照和備份；不能只停止後續 fetch。
- 更新相依套件前跑 `npm run check` 與 `npm audit`。資料庫 migration 先本機驗證、備份後才 remote。
