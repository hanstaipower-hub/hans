require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ── 時間工具 ─────────────────────────────────────────────────
function twNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}
function twToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// ── 常數 ─────────────────────────────────────────────────────
const PALETTE   = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57', '#FF9FF3', '#54A0FF'];
const FONT_PATH = '/Library/Fonts/Arial Unicode.ttf';

// ── 資料庫初始化 ──────────────────────────────────────────────
const db = new DatabaseSync('reports.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name TEXT NOT NULL,
    contractor_line_id TEXT NOT NULL,
    progress_text TEXT,
    worker_count TEXT,
    work_quantity TEXT,
    image_paths TEXT,
    reported_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec('ALTER TABLE reports ADD COLUMN worker_count TEXT'); } catch {}
try { db.exec('ALTER TABLE reports ADD COLUMN work_quantity TEXT'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT DEFAULT '主管',
    notify_daily INTEGER DEFAULT 1,
    notify_alert INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT
  )
`);

// 預設工地（首次執行）
if (db.prepare('SELECT COUNT(*) AS c FROM sites').get().c === 0) {
  const now = twNow();
  for (const name of ['台中燃氣二期鋼構', '台中燃氣二期管線', '台中燃氣二期保溫']) {
    db.prepare('INSERT INTO sites (name, active, created_at) VALUES (?, 1, ?)').run(name, now);
  }
}

// 預設收件人（從 .env 移植）
if (db.prepare('SELECT COUNT(*) AS c FROM recipients').get().c === 0 && process.env.REPORT_EMAIL) {
  db.prepare('INSERT INTO recipients (name, email, role, notify_daily, active, created_at) VALUES (?, ?, ?, 1, 1, ?)')
    .run('管理者', process.env.REPORT_EMAIL, '主管', twNow());
}

// ── 狀態管理 ─────────────────────────────────────────────────
const userStates = new Map();
function getState(uid) { return userStates.get(uid) || { step: 0, images: [] }; }
function setState(uid, s) { userStates.set(uid, s); }

// ── HTML 工具 ─────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function navBar(active) {
  const link = (href, label, key) =>
    `<a href="${href}" class="nav-link${active === key ? ' nav-active' : ''}">${label}</a>`;
  return `<nav class="topnav">${link('/admin','回報總覽','overview')}${link('/admin/settings','系統設定','settings')}</nav>`;
}

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px}
h1{font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.subtitle{font-size:13px;color:#64748b;margin-bottom:16px}
h2{font-size:15px;font-weight:600;color:#93c5fd;margin:24px 0 12px;border-left:3px solid #3b82f6;padding-left:10px}
.topnav{display:flex;gap:0;border-bottom:1px solid #334155;margin-bottom:24px}
.nav-link{padding:10px 20px;text-decoration:none;font-size:14px;font-weight:600;color:#64748b}
.nav-active{color:#60a5fa;border-bottom:2px solid #3b82f6}
.wrap{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:auto;margin-bottom:8px}
table{border-collapse:collapse;width:100%;min-width:500px}
th{background:#1d3461;color:#93c5fd;padding:10px 13px;text-align:left;font-size:13px;font-weight:600;white-space:nowrap}
td{padding:10px 13px;border-bottom:1px solid #1e3a5f;font-size:13px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#0f2744}
.tc{text-align:center}
.mono{font-family:monospace;font-size:12px;color:#94a3b8}
.dim{color:#475569}
.empty{text-align:center;color:#475569;padding:28px;font-size:13px}
.site-badge{display:inline-block;background:#1d3461;color:#93c5fd;font-size:12px;padding:2px 8px;border-radius:4px;white-space:nowrap}
.view-link{color:#60a5fa;text-decoration:none;margin-right:4px;font-size:12px}
.view-link:hover{text-decoration:underline}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600}
.badge-on{background:#14532d;color:#86efac}
.badge-off{background:#3f3f46;color:#a1a1aa}
.btn-sm{font-size:12px;padding:4px 10px;border:none;border-radius:4px;cursor:pointer;font-weight:600}
.btn-ok{background:#14532d;color:#86efac}
.btn-warn{background:#7c2d12;color:#fed7aa}
.btn-danger{background:#7f1d1d;color:#fca5a5}
.btn-primary{background:#1d4ed8;color:#fff;padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
.btn-primary:hover{background:#1e40af}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px 20px}
.card .num{font-size:30px;font-weight:700;color:#60a5fa;line-height:1}
.card .lbl{font-size:12px;color:#94a3b8;margin-top:6px}
.card.warn .num{color:#f97316}
.card.ok .num{color:#34d399}
.unreport{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.tag{background:#7f1d1d;color:#fca5a5;font-size:12px;padding:3px 10px;border-radius:999px}
.tag.none{background:#14532d;color:#86efac}
.filter-row{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.filter-row label{font-size:13px;color:#94a3b8}
select{background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer}
.add-form{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;margin-top:12px}
.add-form .row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.add-form input[type=text],.add-form input[type=email],.add-form select.form-select{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px;min-width:160px}
.add-form label.ck{display:flex;align-items:center;gap:6px;font-size:13px;color:#94a3b8;cursor:pointer}
.tab-bar{display:flex;gap:8px;margin-bottom:20px}
.tab-btn{background:#1e293b;border:1px solid #334155;color:#64748b;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
.tab-btn.active{background:#1d3461;border-color:#3b82f6;color:#60a5fa}
@media(max-width:640px){h1{font-size:17px}.card .num{font-size:24px}th,td{padding:8px 10px;font-size:12px}}
`;

// ── 設定頁面 HTML ─────────────────────────────────────────────
function buildSettingsPage(sites, recipients, activeTab) {
  const t = activeTab === 'recipients' ? 'recipients' : 'sites';

  const sitesTableHtml = sites.length ? sites.map(s => `<tr>
    <td>${esc(s.name)}</td>
    <td><span class="badge ${s.active ? 'badge-on' : 'badge-off'}">${s.active ? '啟用' : '停用'}</span></td>
    <td class="mono">${esc((s.created_at || '').slice(0, 16))}</td>
    <td style="white-space:nowrap">
      <form method="POST" action="/admin/sites/toggle/${s.id}" style="display:inline">
        <button class="btn-sm ${s.active ? 'btn-warn' : 'btn-ok'}" type="submit">${s.active ? '停用' : '啟用'}</button>
      </form>
      <form method="POST" action="/admin/sites/delete/${s.id}" style="display:inline"
            onsubmit="return confirm('確定刪除「${esc(s.name)}」？此操作不可復原。')">
        <button class="btn-sm btn-danger" type="submit">刪除</button>
      </form>
    </td>
  </tr>`).join('') : `<tr><td colspan="4" class="empty">尚無工地資料</td></tr>`;

  const recipientsTableHtml = recipients.length ? recipients.map(r => `<tr>
    <td>${esc(r.name)}</td>
    <td>${esc(r.email)}</td>
    <td>${esc(r.role)}</td>
    <td class="tc">${r.notify_daily ? '<span style="color:#34d399">✓</span>' : '<span class="dim">—</span>'}</td>
    <td class="tc">${r.notify_alert ? '<span style="color:#34d399">✓</span>' : '<span class="dim">—</span>'}</td>
    <td><span class="badge ${r.active ? 'badge-on' : 'badge-off'}">${r.active ? '啟用' : '停用'}</span></td>
    <td style="white-space:nowrap">
      <form method="POST" action="/admin/recipients/toggle/${r.id}" style="display:inline">
        <button class="btn-sm ${r.active ? 'btn-warn' : 'btn-ok'}" type="submit">${r.active ? '停用' : '啟用'}</button>
      </form>
      <form method="POST" action="/admin/recipients/delete/${r.id}" style="display:inline"
            onsubmit="return confirm('確定刪除「${esc(r.name)}」？')">
        <button class="btn-sm btn-danger" type="submit">刪除</button>
      </form>
    </td>
  </tr>`).join('') : `<tr><td colspan="7" class="empty">尚無收件人資料</td></tr>`;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hans 工程回報 — 系統設定</title>
<style>${BASE_CSS}</style>
</head>
<body>
<h1>Hans 工程回報後台</h1>
${navBar('settings')}

<div class="tab-bar">
  <button class="tab-btn ${t === 'sites' ? 'active' : ''}" onclick="showTab('sites',this)">工地管理</button>
  <button class="tab-btn ${t === 'recipients' ? 'active' : ''}" onclick="showTab('recipients',this)">收件人管理</button>
</div>

<!-- 工地管理 -->
<div id="tab-sites" style="display:${t === 'sites' ? 'block' : 'none'}">
  <h2>工地列表（共 ${sites.length} 筆）</h2>
  <div class="wrap">
    <table>
      <thead><tr><th>工地名稱</th><th>狀態</th><th>建立時間</th><th>操作</th></tr></thead>
      <tbody>${sitesTableHtml}</tbody>
    </table>
  </div>
  <h2>新增工地</h2>
  <div class="add-form">
    <form method="POST" action="/admin/sites/add">
      <div class="row">
        <input type="text" name="name" placeholder="輸入工地名稱" required style="flex:1;min-width:200px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:6px;font-size:13px">
        <button class="btn-primary" type="submit">＋ 新增工地</button>
      </div>
    </form>
  </div>
</div>

<!-- 收件人管理 -->
<div id="tab-recipients" style="display:${t === 'recipients' ? 'block' : 'none'}">
  <h2>收件人列表（共 ${recipients.length} 筆）</h2>
  <div class="wrap">
    <table>
      <thead><tr><th>姓名</th><th>Email</th><th>角色</th><th class="tc">每日報表</th><th class="tc">預警通知</th><th>狀態</th><th>操作</th></tr></thead>
      <tbody>${recipientsTableHtml}</tbody>
    </table>
  </div>
  <h2>新增收件人</h2>
  <div class="add-form">
    <form method="POST" action="/admin/recipients/add">
      <div class="row">
        <input type="text" name="name" placeholder="姓名" required>
        <input type="email" name="email" placeholder="Email" required>
        <select name="role" class="form-select">
          <option value="業主">業主</option>
          <option value="專案經理">專案經理</option>
          <option value="監工">監工</option>
          <option value="主管" selected>主管</option>
        </select>
        <label class="ck"><input type="checkbox" name="notify_daily" value="1" checked> 每日報表</label>
        <label class="ck"><input type="checkbox" name="notify_alert" value="1"> 預警通知</label>
        <button class="btn-primary" type="submit">＋ 新增收件人</button>
      </div>
    </form>
  </div>
</div>

<script>
function showTab(name, btn) {
  ['sites','recipients'].forEach(t => {
    document.getElementById('tab-'+t).style.display = t === name ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}

// ── LINE Bot：工地 Carousel ───────────────────────────────────
function siteCarousel() {
  const todayTW = twToday();
  const sites   = db.prepare('SELECT * FROM sites WHERE active = 1 ORDER BY id').all();

  const bubbles = sites.map((site, idx) => {
    const color     = PALETTE[idx % PALETTE.length];
    const row       = db.prepare(
      `SELECT COUNT(*) AS cnt FROM reports WHERE site_name = ? AND DATE(reported_at) = ?`
    ).get(site.name, todayTW);
    const reported  = row.cnt > 0;
    const statusText  = reported ? '✅ 已回報' : '⏳ 未回報';
    const statusColor = reported ? '#27AE60' : '#E67E22';

    return {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '20px',
        contents: [{ type: 'text', text: site.name, color: '#FFFFFF', size: 'xl', weight: 'bold', align: 'center' }],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [{ type: 'text', text: statusText, color: statusColor, size: 'md', weight: 'bold', align: 'center' }],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [{
          type: 'button',
          action: { type: 'postback', label: '選擇此工地', data: `action=select_site&site=${encodeURIComponent(site.name)}` },
          style: 'primary', color: color, height: 'sm',
        }],
      },
    };
  });

  return { type: 'flex', altText: '請選擇工地', contents: { type: 'carousel', contents: bubbles } };
}

// ── 照片儲存 ─────────────────────────────────────────────────
async function saveImage(userId, messageId) {
  const filename = `${userId}_${Date.now()}_${messageId}.jpg`;
  const filepath = path.join('uploads', filename);
  const stream   = await client.getMessageContent(messageId);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath);
    stream.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  return filepath;
}

// ── LINE Bot：事件處理 ────────────────────────────────────────
async function handleEvent(event) {
  const userId      = event.source.userId;
  const { replyToken } = event;

  if (event.type === 'postback') {
    const params   = new URLSearchParams(event.postback.data);
    if (params.get('action') === 'select_site') {
      const siteName    = decodeURIComponent(params.get('site') || '');
      const activeSites = db.prepare('SELECT name FROM sites WHERE active = 1').all().map(r => r.name);
      if (activeSites.includes(siteName)) {
        setState(userId, { step: 2, site_name: siteName, images: [] });
        return client.replyMessage(replyToken, { type: 'text', text: `已選擇【${siteName}】\n請輸入今日施工內容` });
      }
    }
    return null;
  }

  if (event.type !== 'message') return null;

  const state = getState(userId);

  if (event.message.type === 'image') {
    if (state.step !== 5) return null;
    try {
      const filepath = await saveImage(userId, event.message.id);
      state.images.push(filepath);
      setState(userId, state);
      return client.replyMessage(replyToken, {
        type: 'text',
        text: `📸 照片已收到（共 ${state.images.length} 張），可繼續上傳，或傳「完成」結束`,
      });
    } catch (err) {
      console.error('[saveImage]', err.message);
      return client.replyMessage(replyToken, { type: 'text', text: '照片上傳失敗，請重試' });
    }
  }

  if (event.message.type !== 'text') return null;
  const text = event.message.text.trim();

  switch (state.step) {
    case 0:
      setState(userId, { step: 1, images: [] });
      return client.replyMessage(replyToken, siteCarousel());
    case 1:
      return client.replyMessage(replyToken, siteCarousel());
    case 2:
      setState(userId, { ...state, step: 3, progress_text: text });
      return client.replyMessage(replyToken, { type: 'text', text: '請輸入本日出工人數（例：5）' });
    case 3:
      setState(userId, { ...state, step: 4, worker_count: text });
      return client.replyMessage(replyToken, { type: 'text', text: '請輸入本日施作數量（例：鋼構組立 50 噸、天然氣管線焊接 35 DB）' });
    case 4:
      setState(userId, { ...state, step: 5, work_quantity: text });
      return client.replyMessage(replyToken, { type: 'text', text: '請上傳今日施工照片（可傳多張，完成後請傳「完成」）' });
    case 5:
      if (text === '完成') {
        db.prepare(`
          INSERT INTO reports
            (site_name, contractor_line_id, progress_text, worker_count, work_quantity, image_paths, reported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(state.site_name, userId, state.progress_text, state.worker_count, state.work_quantity, JSON.stringify(state.images), twNow());
        const { site_name, worker_count, work_quantity } = state;
        userStates.delete(userId);
        return client.replyMessage(replyToken, {
          type: 'text',
          text: `✅ 回報完成！\n工地：${site_name}\n施工內容：${state.progress_text}\n出工人數：${worker_count} 人\n施作數量：${work_quantity}\n感謝今日回報！`,
        });
      }
      return client.replyMessage(replyToken, { type: 'text', text: '請上傳施工照片，或傳「完成」結束上傳' });
    default:
      return null;
  }
}

// ── PDF 產製 ──────────────────────────────────────────────────
function buildDailyPDF(targetDate) {
  return new Promise((resolve, reject) => {
    const rows = db.prepare(
      `SELECT * FROM reports WHERE DATE(reported_at) = ? ORDER BY site_name, reported_at ASC`
    ).all(targetDate);

    const activeSites     = db.prepare('SELECT name FROM sites WHERE active = 1 ORDER BY id').all().map(r => r.name);
    const reportedSites   = new Set(rows.map(r => r.site_name));
    const unreportedSites = activeSites.filter(s => !reportedSites.has(s));
    const totalWorkers    = rows.reduce((s, r) => s + (parseInt(r.worker_count) || 0), 0);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const buffers = [];
    doc.on('data', b => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.registerFont('CJK', FONT_PATH).font('CJK');

    const ML = 40;
    const PW = doc.page.width - ML * 2;
    const [yr, mo, dy] = targetDate.split('-');

    doc.fontSize(20).fillColor('#1d3461')
       .text('Hans 工程回報日報表', ML, 44, { width: PW, align: 'center' });
    doc.fontSize(13).fillColor('#334155')
       .text(`${yr}年${mo}月${dy}日`, ML, 72, { width: PW, align: 'center' });
    doc.moveTo(ML, 95).lineTo(ML + PW, 95).strokeColor('#3b82f6').lineWidth(1.5).stroke();

    let cy = 108;
    doc.fontSize(11).fillColor('#1d3461').text('統計摘要', ML, cy); cy += 18;
    doc.fontSize(9.5).fillColor('#333333');
    [
      `・今日回報工地數：${reportedSites.size} / ${activeSites.length} 個`,
      `・今日總出工人數：${totalWorkers} 人`,
      `・未回報工地：${unreportedSites.length ? unreportedSites.join('、') : '✓ 全部工地已回報'}`,
    ].forEach(line => { doc.text(line, ML + 8, cy); cy += 16; });
    cy += 8;

    doc.fontSize(11).fillColor('#1d3461').text('各工地回報明細', ML, cy); cy += 16;

    const colDefs = [
      { header: '工地名稱', pct: 0.15, wrap: false },
      { header: '施工內容', pct: 0.35, wrap: true  },
      { header: '出工人數', pct: 0.10, wrap: false },
      { header: '施作數量', pct: 0.20, wrap: false },
      { header: '照片數',   pct: 0.08, wrap: false },
      { header: '回報時間', pct: 0.12, wrap: false },
    ];
    const cols = colDefs.map(c => ({ ...c, width: Math.floor(PW * c.pct) }));
    const usedW = cols.reduce((s, c) => s + c.width, 0);
    cols[cols.length - 1].width += Math.round(PW - usedW);

    const PAD_X = 4, PAD_Y = 5, MIN_RH = 20, HDR_H = 20;

    function calcRowH(cells) {
      doc.font('CJK').fontSize(8);
      let h = MIN_RH;
      cols.forEach((col, i) => {
        if (!col.wrap) return;
        const n = doc.heightOfString(String(cells[i] ?? '—'), { width: col.width - PAD_X * 2 }) + PAD_Y * 2;
        if (n > h) h = n;
      });
      return Math.ceil(h);
    }

    function drawRow(cells, y, rowH, isHeader) {
      let x = ML;
      cols.forEach(col => { doc.rect(x, y, col.width, rowH).fill(isHeader ? '#1d3461' : '#f8fafc'); x += col.width; });
      doc.rect(ML, y, PW, rowH).strokeColor('#94a3b8').lineWidth(0.5).stroke();
      x = ML;
      cols.forEach(col => { doc.moveTo(x, y).lineTo(x, y + rowH).strokeColor('#94a3b8').lineWidth(0.3).stroke(); x += col.width; });
      x = ML;
      cols.forEach((col, i) => {
        const opts = isHeader || !col.wrap
          ? { width: col.width - PAD_X * 2, lineBreak: false, ellipsis: true }
          : { width: col.width - PAD_X * 2, lineBreak: true };
        doc.fillColor(isHeader ? '#ffffff' : '#222222').fontSize(isHeader ? 8.5 : 8)
           .text(String(cells[i] ?? '—'), x + PAD_X, y + PAD_Y, opts);
        x += col.width;
      });
    }

    drawRow(cols.map(c => c.header), cy, HDR_H, true); cy += HDR_H;

    if (!rows.length) {
      doc.rect(ML, cy, PW, MIN_RH * 2).fill('#f8fafc');
      doc.fillColor('#888888').fontSize(9).text('今日尚無回報紀錄', ML, cy + 10, { width: PW, align: 'center' });
      cy += MIN_RH * 2;
    } else {
      rows.forEach(r => {
        const imgCount = JSON.parse(r.image_paths || '[]').length;
        const cells = [r.site_name, r.progress_text, r.worker_count ? `${r.worker_count} 人` : '—',
          r.work_quantity, String(imgCount || 0), (r.reported_at || '').slice(11, 16)];
        const rh = calcRowH(cells);
        if (cy + rh > doc.page.height - 50) {
          doc.addPage(); cy = 40;
          drawRow(cols.map(c => c.header), cy, HDR_H, true); cy += HDR_H;
        }
        drawRow(cells, cy, rh, false); cy += rh;
      });
    }

    const footerY = doc.page.height - 28;
    doc.moveTo(ML, footerY - 6).lineTo(ML + PW, footerY - 6).strokeColor('#e2e8f0').lineWidth(0.8).stroke();
    doc.fillColor('#94a3b8').fontSize(7.5).text(`產製時間：${twNow()}`, ML, footerY, { width: PW, align: 'right' });

    doc.addPage();
    doc.fontSize(16).fillColor('#1d3461').text('今日施工照片', ML, 44, { width: PW, align: 'center' });
    doc.moveTo(ML, 68).lineTo(ML + PW, 68).strokeColor('#3b82f6').lineWidth(1.5).stroke();

    const allPhotos = rows.flatMap(r =>
      JSON.parse(r.image_paths || '[]').map(p => ({
        site: r.site_name, time: (r.reported_at || '').slice(11, 16),
        fullPath: path.resolve(__dirname, p),
      })).filter(p => fs.existsSync(p.fullPath))
    );

    if (!allPhotos.length) {
      doc.fontSize(10).fillColor('#666666').text('本日無施工照片', ML, 100, { width: PW, align: 'center' });
    } else {
      const bysite = {};
      allPhotos.forEach(p => { if (!bysite[p.site]) bysite[p.site] = []; bysite[p.site].push(p); });
      const PHOTO_W = 240, PHOTO_H = 180, GAP = Math.floor(PW - PHOTO_W * 2), CAP_H = 26;
      const BLOCK_H = PHOTO_H + CAP_H + 10, TITLE_H = 24;
      let py = 80;
      for (const [siteName, photos] of Object.entries(bysite)) {
        if (py + TITLE_H + BLOCK_H > doc.page.height - 40) { doc.addPage(); py = 40; }
        doc.fontSize(12).fillColor('#1d3461').text(`▌ ${siteName}`, ML, py); py += TITLE_H;
        for (let i = 0; i < photos.length; i += 2) {
          if (py + BLOCK_H > doc.page.height - 40) { doc.addPage(); py = 40; }
          [photos[i], photos[i + 1]].forEach((photo, col) => {
            if (!photo) return;
            const px = ML + col * (PHOTO_W + GAP);
            try { doc.image(photo.fullPath, px, py, { fit: [PHOTO_W, PHOTO_H] }); } catch (_) {
              doc.rect(px, py, PHOTO_W, PHOTO_H).strokeColor('#cccccc').stroke();
            }
            doc.fillColor('#555555').fontSize(8).text(`${photo.site}　${photo.time}`, px, py + PHOTO_H + 4, { width: PHOTO_W, lineBreak: false, ellipsis: true });
          });
          py += BLOCK_H;
        }
        py += 8;
      }
    }

    doc.end();
  });
}

// ── Email 寄送 ────────────────────────────────────────────────
async function sendDailyReport(targetDate) {
  targetDate = targetDate || twToday();

  const recipients = db.prepare(
    'SELECT * FROM recipients WHERE active = 1 AND notify_daily = 1'
  ).all();

  if (!recipients.length) {
    console.warn('[Report] No active daily recipients, skipping');
    return;
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('[Report] Gmail env vars not configured, skipping');
    return;
  }

  const [yr, mo, dy] = targetDate.split('-');
  const dateLabel = `${yr}年${mo}月${dy}日`;
  const tmpPath   = `/tmp/construction-report-${targetDate}.pdf`;

  try {
    const pdfBuffer = await buildDailyPDF(targetDate);
    fs.writeFileSync(tmpPath, pdfBuffer);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const toList = recipients.map(r => `${r.name} <${r.email}>`).join(', ');
    await transporter.sendMail({
      from:    `Hans工程回報系統 <${process.env.GMAIL_USER}>`,
      to:      toList,
      subject: `【Hans工程回報】${dateLabel} 日報表`,
      text:    `您好，\n\n附件為 ${dateLabel} 工程回報日報表，請查閱。\n\n（此信件由系統自動發送，請勿回覆）`,
      attachments: [{ filename: `工程日報表-${targetDate}.pdf`, path: tmpPath }],
    });

    console.log(`[Report] Sent to ${recipients.length} recipient(s) for ${targetDate}`);
  } catch (err) {
    console.error('[Report] Send failed:', err.message);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── Cron：每日 18:00 台灣時間 ────────────────────────────────
cron.schedule('0 18 * * *', () => {
  console.log('[Cron] Sending daily report...');
  sendDailyReport().catch(err => console.error('[Cron]', err.message));
}, { timezone: 'Asia/Taipei' });

// ── Express Middleware ────────────────────────────────────────
app.use('/admin', express.urlencoded({ extended: false }));

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── GET /uploads ─────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── GET /report/today ─────────────────────────────────────────
app.get('/report/today', async (req, res) => {
  const targetDate = req.query.date || twToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate))
    return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });
  try {
    const pdfBuffer = await buildDailyPDF(targetDate);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="construction-report-${targetDate}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error('[report/today]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin ────────────────────────────────────────────────
app.get('/admin', (_req, res) => {
  const allRows     = db.prepare('SELECT * FROM reports ORDER BY reported_at DESC').all();
  const todayStr    = twToday();
  const todayRows   = allRows.filter(r => r.reported_at && r.reported_at.startsWith(todayStr));
  const histRows    = allRows.slice(0, 30);
  const activeSites = db.prepare('SELECT name FROM sites WHERE active = 1 ORDER BY id').all().map(r => r.name);

  const reportedSiteSet = new Set(todayRows.map(r => r.site_name));
  const unreportedSites = activeSites.filter(s => !reportedSiteSet.has(s));
  const todayWorkers    = todayRows.reduce((s, r) => s + (parseInt(r.worker_count) || 0), 0);

  function buildRows(rows) {
    if (!rows.length) return `<tr><td colspan="7" class="empty">尚無回報紀錄</td></tr>`;
    return rows.map(r => {
      const imgs   = JSON.parse(r.image_paths || '[]');
      const photos = imgs.length
        ? imgs.map((p, i) => `<a href="/uploads/${path.basename(p)}" target="_blank" class="view-link">查看${imgs.length > 1 ? (i + 1) : ''}</a>`).join(' ')
        : '<span class="dim">—</span>';
      const t = (r.reported_at || '').slice(0, 16);
      return `<tr>
        <td><span class="site-badge">${esc(r.site_name)}</span></td>
        <td>${esc(r.progress_text)}</td>
        <td class="tc">${esc(r.worker_count) || '—'}</td>
        <td>${esc(r.work_quantity)}</td>
        <td class="tc">${imgs.length}</td>
        <td>${photos}</td>
        <td class="tc mono">${t}</td>
      </tr>`;
    }).join('');
  }

  const siteOptions = activeSites.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hans 工程回報後台</title>
<meta http-equiv="refresh" content="60">
<style>${BASE_CSS}</style>
</head>
<body>
<h1>Hans 工程回報後台</h1>
${navBar('overview')}
<p class="subtitle">今日：${todayStr}　每 60 秒自動更新</p>

<div class="cards">
  <div class="card ok"><div class="num">${reportedSiteSet.size}</div><div class="lbl">今日回報工地數</div></div>
  <div class="card"><div class="num">${todayWorkers}</div><div class="lbl">今日總出工人數</div></div>
  <div class="card warn"><div class="num">${unreportedSites.length}</div><div class="lbl">今日未回報工地數</div></div>
  <div class="card"><div class="num">${allRows.length}</div><div class="lbl">累計總回報次數</div></div>
</div>
<div class="unreport" style="margin-bottom:24px">
  ${unreportedSites.length
    ? unreportedSites.map(s => `<span class="tag">${esc(s)}</span>`).join('')
    : '<span class="tag none">所有工地已回報</span>'}
</div>

<h2>今日回報明細（${todayRows.length} 筆）</h2>
<div class="wrap">
  <table>
    <thead><tr><th>工地名稱</th><th>施工內容</th><th>出工人數</th><th>施作數量</th><th>照片數</th><th>照片連結</th><th>回報時間</th></tr></thead>
    <tbody>${buildRows(todayRows)}</tbody>
  </table>
</div>

<h2>歷史回報記錄（最近 30 筆）</h2>
<div class="filter-row">
  <label>依工地篩選：</label>
  <select id="siteFilter" onchange="filterTable()">
    <option value="">全部</option>${siteOptions}
  </select>
</div>
<div class="wrap">
  <table id="histTable">
    <thead><tr><th>工地名稱</th><th>施工內容</th><th>出工人數</th><th>施作數量</th><th>照片數</th><th>照片連結</th><th>回報時間</th></tr></thead>
    <tbody id="histBody">${buildRows(histRows)}</tbody>
  </table>
</div>

<script>
const raw = ${JSON.stringify(histRows.map(r => ({
  site: r.site_name, prog: r.progress_text || '—',
  wc: r.worker_count || '—', wq: r.work_quantity || '—',
  imgs: JSON.parse(r.image_paths || '[]').map(p => p.split('/').pop()),
  time: (r.reported_at || '').slice(0, 16),
})))};
function filterTable() {
  const val = document.getElementById('siteFilter').value;
  const rows = val ? raw.filter(r => r.site === val) : raw;
  const tbody = document.getElementById('histBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">無符合紀錄</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => {
    const photos = r.imgs.length
      ? r.imgs.map((f,i) => '<a href="/uploads/'+f+'" target="_blank" class="view-link">查看'+(r.imgs.length>1?i+1:'')+'</a>').join(' ')
      : '<span class="dim">—</span>';
    return '<tr><td><span class="site-badge">'+r.site+'</span></td><td>'+r.prog+'</td><td class="tc">'+r.wc+'</td><td>'+r.wq+'</td><td class="tc">'+r.imgs.length+'</td><td>'+photos+'</td><td class="tc mono">'+r.time+'</td></tr>';
  }).join('');
}
</script>
</body>
</html>`);
});

// ── GET /admin/settings ───────────────────────────────────────
app.get('/admin/settings', (req, res) => {
  const sites      = db.prepare('SELECT * FROM sites ORDER BY id').all();
  const recipients = db.prepare('SELECT * FROM recipients ORDER BY id').all();
  res.send(buildSettingsPage(sites, recipients, req.query.tab));
});

// ── 工地管理 API ──────────────────────────────────────────────
app.post('/admin/sites/add', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) db.prepare('INSERT INTO sites (name, active, created_at) VALUES (?, 1, ?)').run(name, twNow());
  res.redirect('/admin/settings?tab=sites');
});

app.post('/admin/sites/toggle/:id', (req, res) => {
  const site = db.prepare('SELECT active FROM sites WHERE id = ?').get(req.params.id);
  if (site) db.prepare('UPDATE sites SET active = ? WHERE id = ?').run(site.active ? 0 : 1, req.params.id);
  res.redirect('/admin/settings?tab=sites');
});

app.post('/admin/sites/delete/:id', (req, res) => {
  db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
  res.redirect('/admin/settings?tab=sites');
});

// ── 收件人管理 API ────────────────────────────────────────────
app.post('/admin/recipients/add', (req, res) => {
  const { name, email, role } = req.body;
  const notify_daily = req.body.notify_daily ? 1 : 0;
  const notify_alert = req.body.notify_alert ? 1 : 0;
  if (name && email) {
    db.prepare('INSERT INTO recipients (name, email, role, notify_daily, notify_alert, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(name.trim(), email.trim(), role || '主管', notify_daily, notify_alert, twNow());
  }
  res.redirect('/admin/settings?tab=recipients');
});

app.post('/admin/recipients/toggle/:id', (req, res) => {
  const r = db.prepare('SELECT active FROM recipients WHERE id = ?').get(req.params.id);
  if (r) db.prepare('UPDATE recipients SET active = ? WHERE id = ?').run(r.active ? 0 : 1, req.params.id);
  res.redirect('/admin/settings?tab=recipients');
});

app.post('/admin/recipients/delete/:id', (req, res) => {
  db.prepare('DELETE FROM recipients WHERE id = ?').run(req.params.id);
  res.redirect('/admin/settings?tab=recipients');
});

// ── POST /webhook ─────────────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  res.status(200).json({ status: 'ok' });
  const rawBody  = req.body;
  const signature = req.headers['x-line-signature'];
  if (signature) {
    const digest = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(rawBody).digest('base64');
    if (signature !== digest) { console.error('[Webhook] invalid signature'); return; }
  }
  let body;
  try { body = JSON.parse(rawBody.toString()); } catch (e) { console.error('[Webhook] JSON parse error:', e.message); return; }
  Promise.all((body.events || []).map(handleEvent)).catch(err => console.error('[Handler]', err.message));
});

// ── Process 信號 ──────────────────────────────────────────────
process.on('SIGHUP', () => {});
process.on('uncaughtException', err => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', reason => console.error('[unhandledRejection]', reason));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

// ── 啟動 ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Error] Port ${PORT} in use — run: lsof -ti :${PORT} | xargs kill -9`);
    process.exit(1);
  } else {
    console.error('[Server Error]', err.message);
  }
});
