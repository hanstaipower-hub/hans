# Hans 工程回報系統

## 專案簡介

透過 LINE Bot 讓工地承攬商每日回報施工進度，管理者可即時在後台查看回報狀況，並每天 18:00 自動收到包含施工照片的 PDF 日報表，大幅減少電話追蹤與人工彙整的成本。

---

## 系統架構圖

```
┌─────────────────────────────────────────────────────────┐
│  承攬商（LINE App）                                      │
│  六步驟回報：工地選擇 → 施工內容 → 人數 → 數量 → 照片   │
└──────────────────────┬──────────────────────────────────┘
                       │ LINE Messaging API (Webhook)
                       ▼
              ┌─────────────────┐
              │  ngrok 外網穿透  │
              │  固定網域 HTTPS  │
              └────────┬────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │   Node.js / Express  :3000   │
        │                              │
        │  POST /webhook               │
        │  GET  /admin          ───────┼──► 管理後台
        │  GET  /admin/settings ───────┼──► 工地與收件人設定
        │  GET  /report/today   ───────┼──► 下載今日 PDF
        │  GET  /report/monthly ───────┼──► 下載本月 PDF
        │  GET  /uploads/:file  ───────┼──► 施工照片
        └──────────┬───────────────────┘
                   │
                   ▼
           ┌──────────────┐
           │ SQLite DB    │
           │ reports      │
           │ sites        │
           │ recipients   │
           └──────────────┘
                   │
          每日 18:00 (Asia/Taipei)
                   │
                   ▼
        ┌──────────────────────┐
        │  PDF 產製 (pdfkit)   │
        │  ├ 統計摘要          │
        │  ├ 回報明細表格      │
        │  └ 施工照片頁        │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │  Gmail SMTP 寄送     │
        │  (nodemailer)        │
        │  收件人從 DB 動態讀取 │
        └──────────────────────┘
```

---

## 功能特色

- **LINE Bot 六步驟回報**：引導式流程，承攬商無需學習，直接在 LINE 上完成每日回報
- **工地選擇 Flex Carousel**：顯示已回報 ✅ / 未回報 ⏳ 狀態，一目了然
- **多張照片上傳**：支援連續上傳施工照片，自動儲存至伺服器
- **即時後台管理**（`/admin`）：統計卡片、今日明細、歷史記錄篩選，每 60 秒自動刷新
- **工地與收件人後台管理**（`/admin/settings`）：不需改程式碼即可新增／停用工地與 Email 收件人
- **每日 PDF 日報表**：含統計摘要、回報明細表（施工內容自動換行）、施工照片頁
- **每月 PDF 月報表**：含各工地回報天數統計、依日期分組的全月明細
- **自動 Email 寄送**：每天 18:00 台灣時間自動寄送 PDF 至所有啟用中的收件人
- **台灣時區**：所有時間統一以 UTC+8 儲存與顯示
- **PM2 守護程序**：伺服器重啟後自動啟動，崩潰後自動重啟

---

## 技術棧

| 分類 | 技術 |
|------|------|
| 執行環境 | Node.js v20+ |
| Web 框架 | Express.js |
| LINE 整合 | @line/bot-sdk |
| 資料庫 | SQLite（node:sqlite 內建模組） |
| PDF 產製 | pdfkit + Arial Unicode（中文字體） |
| Email 寄送 | nodemailer + Gmail SMTP |
| 排程任務 | node-cron（Asia/Taipei 時區） |
| 外網穿透 | ngrok |
| 程序管理 | PM2 |
| 版本控制 | Git + GitHub |

---

## 快速開始

### 環境需求

- Node.js v20 以上
- ngrok 帳號（免費版即可）
- Gmail 帳號（需開啟兩步驟驗證以產生 App Password）

### 安裝步驟

```bash
# 1. Clone 專案
git clone https://github.com/hanstaipower-hub/hans.git
cd hans

# 2. 安裝套件
npm install

# 3. 建立環境變數檔案
cp .env.example .env
# 編輯 .env，填入所有必要變數（見下方說明）

# 4. 啟動伺服器
nohup node index.js > /tmp/construction-bot.log 2>&1 &

# 5. 啟動 ngrok（使用固定網域）
ngrok http --domain=parched-snore-womanless.ngrok-free.dev 3000

# 6. 設定 LINE Webhook URL
# 至 LINE Developers → Messaging API → Webhook URL
# 填入：https://parched-snore-womanless.ngrok-free.dev/webhook
# 開啟「Use webhook」並點擊 Verify
```

### 環境變數說明（.env）

```env
# LINE Bot 設定
LINE_CHANNEL_SECRET=       # LINE Developer Console → Basic settings → Channel secret
LINE_ACCESS_TOKEN=         # LINE Developer Console → Messaging API → Channel access token

# 伺服器設定
PORT=3000                  # 監聽 port（預設 3000）

# Gmail 寄件設定
GMAIL_USER=                # Gmail 地址（完整 Email，例：your@gmail.com）
GMAIL_APP_PASSWORD=        # Gmail 應用程式密碼（16碼，非登入密碼）
                           # 申請：myaccount.google.com → 安全性 → 應用程式密碼

# 初始收件人（首次啟動時自動新增至 recipients 資料表）
REPORT_EMAIL=              # 預設收件人 Email
```

> **注意**：`.env` 已列入 `.gitignore`，不會上傳至 GitHub。

---

## LINE Bot 回報流程

```
使用者發送任意訊息
        │
        ▼
  [步驟 1] 顯示工地 Flex Carousel
           （每張卡片顯示今日已/未回報狀態）
        │
        │ 點選「選擇此工地」按鈕
        ▼
  [步驟 2] 請輸入今日施工內容
        │
        ▼
  [步驟 3] 請輸入本日出工人數（例：5）
        │
        ▼
  [步驟 4] 請輸入本日施作數量
           （例：鋼構組立 50 噸）
        │
        ▼
  [步驟 5] 請上傳施工照片
           ├─ 收到圖片 → 儲存，可繼續上傳
           └─ 收到「完成」→ 進入步驟 6
        │
        ▼
  [步驟 6] 寫入資料庫，回傳確認訊息 ✅
```

---

## 後台管理介面

### 回報總覽（`/admin`）

- **統計卡片**：今日回報工地數、總出工人數、未回報工地數、累計回報次數
- **未回報工地標籤**：紅色標示未回報工地，全部完成時顯示綠色
- **今日回報明細**：完整表格，含施工內容、人數、數量、照片連結、時間
- **歷史記錄**：最近 30 筆，支援依工地篩選
- **下載按鈕**：右上角一鍵下載今日／本月 PDF 報表
- **自動刷新**：每 60 秒重新載入

### 系統設定（`/admin/settings`）

**工地管理分頁**
- 列出所有工地（名稱、狀態、建立時間）
- 每筆可停用／啟用、刪除
- 底部新增工地表單

**收件人管理分頁**
- 列出所有收件人（姓名、Email、角色、通知設定、狀態）
- 每筆可停用／啟用、刪除
- 支援角色：業主、專案經理、監工、主管
- 可分別設定：每日報表、預警通知

---

## 每日啟動指令

```bash
# 切換至專案目錄
cd /Users/hsiehhengsheng/construction-report

# 啟動 Node.js 伺服器（PM2 管理，開機自動啟動）
pm2 start index.js --name construction-bot

# 啟動 ngrok
ngrok http --domain=parched-snore-womanless.ngrok-free.dev 3000

# 查看 log
pm2 logs construction-bot
```

> **PM2 已設定開機自啟**，重開機後無需手動執行伺服器指令。

---

## API 路由清單

| 方法 | 路由 | 說明 |
|------|------|------|
| `GET` | `/health` | 健康檢查，回傳 `{"status":"ok"}` |
| `GET` | `/admin` | 後台管理介面（回報總覽） |
| `GET` | `/admin/settings` | 工地與收件人設定頁 |
| `POST` | `/admin/sites/add` | 新增工地 |
| `POST` | `/admin/sites/toggle/:id` | 切換工地啟用狀態 |
| `POST` | `/admin/sites/delete/:id` | 刪除工地 |
| `POST` | `/admin/recipients/add` | 新增收件人 |
| `POST` | `/admin/recipients/toggle/:id` | 切換收件人啟用狀態 |
| `POST` | `/admin/recipients/delete/:id` | 刪除收件人 |
| `GET` | `/report/today` | 下載今日 PDF（`?date=YYYY-MM-DD` 可指定日期） |
| `GET` | `/report/monthly` | 下載本月 PDF（`?month=YYYY-MM` 可指定月份） |
| `GET` | `/uploads/:filename` | 靜態照片瀏覽 |
| `POST` | `/webhook` | LINE Bot Webhook 接收端點 |

---

## 資料庫結構

資料庫：SQLite，檔案路徑 `reports.db`

### `reports` 回報記錄

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | INTEGER PK | 自動遞增 |
| `site_name` | TEXT | 工地名稱 |
| `contractor_line_id` | TEXT | 承攬商 LINE User ID |
| `progress_text` | TEXT | 施工內容 |
| `worker_count` | TEXT | 出工人數 |
| `work_quantity` | TEXT | 施作數量 |
| `image_paths` | TEXT | 照片路徑 JSON 陣列 |
| `reported_at` | DATETIME | 回報時間（台灣時間 UTC+8） |

### `sites` 工地管理

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | INTEGER PK | 自動遞增 |
| `name` | TEXT | 工地名稱 |
| `active` | INTEGER | 啟用狀態（1=啟用 0=停用） |
| `created_at` | TEXT | 建立時間 |

### `recipients` 收件人管理

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | INTEGER PK | 自動遞增 |
| `name` | TEXT | 姓名 |
| `email` | TEXT | Email 地址 |
| `role` | TEXT | 角色（業主／專案經理／監工／主管） |
| `notify_daily` | INTEGER | 每日報表通知（1=是） |
| `notify_alert` | INTEGER | 預警通知（1=是） |
| `active` | INTEGER | 啟用狀態（1=啟用） |
| `created_at` | TEXT | 建立時間 |

---

## 版本紀錄

| 版本 | 日期 | 更新內容 |
|------|------|---------|
| v1.0 | 2026-04-30 | 初版上線：LINE Bot 六步驟回報、照片上傳、SQLite 儲存 |
| v1.1 | 2026-05-04 | 新增後台管理介面（`/admin`）：統計卡片、歷史記錄、工地篩選 |
| v1.2 | 2026-05-05 | 台灣時區修正、PDF 日報表、每日 Email 自動寄送、PM2 開機自啟 |
| v1.3 | 2026-05-06 | 工地與收件人後台管理、月報表、導覽列下載按鈕 |
| v1.4 | 2026-05-06 | 後台新增手動寄送今日報表按鈕 |

---

## 授權

Private Project — Hans 謝恆晟
