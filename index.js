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

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

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
// 相容舊資料表：新增欄位若不存在
try { db.exec('ALTER TABLE reports ADD COLUMN worker_count TEXT'); } catch {}
try { db.exec('ALTER TABLE reports ADD COLUMN work_quantity TEXT'); } catch {}

const userStates = new Map();

function twNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function twToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

const SITE_CONFIG = [
  { name: '鋼構安裝', color: '#FF6B6B' },
  { name: '管線安裝', color: '#4ECDC4' },
  { name: '保溫',     color: '#45B7D1' },
];
const SITES = SITE_CONFIG.map(s => s.name);

const FONT_PATH = '/Library/Fonts/Arial Unicode.ttf';
const REPORT_EMAIL = process.env.REPORT_EMAIL || '';

function getState(userId) {
  return userStates.get(userId) || { step: 0, images: [] };
}

function setState(userId, state) {
  userStates.set(userId, state);
}

function siteCarousel() {
  const todayTW = twToday();
  const bubbles = SITE_CONFIG.map(site => {
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM reports
       WHERE site_name = ? AND DATE(reported_at) = ?`
    ).get(site.name, todayTW);
    const reported    = row.cnt > 0;
    const statusText  = reported ? '✅ 已回報' : '⏳ 未回報';
    const statusColor = reported ? '#27AE60' : '#E67E22';

    return {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: site.color,
        paddingAll: '20px',
        contents: [{
          type: 'text',
          text: site.name,
          color: '#FFFFFF',
          size: 'xl',
          weight: 'bold',
          align: 'center',
        }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [{
          type: 'text',
          text: statusText,
          color: statusColor,
          size: 'md',
          weight: 'bold',
          align: 'center',
        }],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [{
          type: 'button',
          action: {
            type: 'postback',
            label: '選擇此工地',
            data: `action=select_site&site=${encodeURIComponent(site.name)}`,
          },
          style: 'primary',
          color: site.color,
          height: 'sm',
        }],
      },
    };
  });

  return {
    type: 'flex',
    altText: '請選擇工地',
    contents: { type: 'carousel', contents: bubbles },
  };
}

async function saveImage(userId, messageId) {
  const filename = `${userId}_${Date.now()}_${messageId}.jpg`;
  const filepath = path.join('uploads', filename);
  const stream = await client.getMessageContent(messageId);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath);
    stream.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  return filepath;
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const { replyToken } = event;

  // ── Postback：選擇工地 ────────────────────────────────────────
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    if (params.get('action') === 'select_site') {
      const siteName = decodeURIComponent(params.get('site') || '');
      if (SITES.includes(siteName)) {
        setState(userId, { step: 2, site_name: siteName, images: [] });
        return client.replyMessage(replyToken, {
          type: 'text',
          text: `已選擇【${siteName}】\n請輸入今日施工內容`,
        });
      }
    }
    return null;
  }

  if (event.type !== 'message') return null;

  const state = getState(userId);

  // ── 圖片（步驟5：上傳照片中）──────────────────────────────────
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
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '照片上傳失敗，請重試',
      });
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
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '請輸入本日出工人數（例：5）',
      });

    case 3:
      setState(userId, { ...state, step: 4, worker_count: text });
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '請輸入本日施作數量（例：鋼構組立 50 噸、天然氣管線焊接 35 DB）',
      });

    case 4:
      setState(userId, { ...state, step: 5, work_quantity: text });
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '請上傳今日施工照片（可傳多張，完成後請傳「完成」）',
      });

    case 5:
      if (text === '完成') {
        db.prepare(`
          INSERT INTO reports
            (site_name, contractor_line_id, progress_text, worker_count, work_quantity, image_paths, reported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          state.site_name,
          userId,
          state.progress_text,
          state.worker_count,
          state.work_quantity,
          JSON.stringify(state.images),
          twNow(),
        );

        const { site_name, worker_count, work_quantity } = state;
        userStates.delete(userId);
        return client.replyMessage(replyToken, {
          type: 'text',
          text: `✅ 回報完成！\n工地：${site_name}\n施工內容：${state.progress_text}\n出工人數：${worker_count} 人\n施作數量：${work_quantity}\n感謝今日回報！`,
        });
      }
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '請上傳施工照片，或傳「完成」結束上傳',
      });

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

    const reportedSites   = new Set(rows.map(r => r.site_name));
    const unreportedSites = SITES.filter(s => !reportedSites.has(s));
    const totalWorkers    = rows.reduce((s, r) => s + (parseInt(r.worker_count) || 0), 0);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const buffers = [];
    doc.on('data', b => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.registerFont('CJK', FONT_PATH).font('CJK');

    const ML = 40;
    const PW = doc.page.width - ML * 2; // 515.28
    const [yr, mo, dy] = targetDate.split('-');

    // ── 第一頁：回報明細表 ─────────────────────────────────────

    doc.fontSize(20).fillColor('#1d3461')
       .text('Hans 工程回報日報表', ML, 44, { width: PW, align: 'center' });
    doc.fontSize(13).fillColor('#334155')
       .text(`${yr}年${mo}月${dy}日`, ML, 72, { width: PW, align: 'center' });
    doc.moveTo(ML, 95).lineTo(ML + PW, 95).strokeColor('#3b82f6').lineWidth(1.5).stroke();

    // 統計摘要
    let cy = 108;
    doc.fontSize(11).fillColor('#1d3461').text('統計摘要', ML, cy);
    cy += 18;
    doc.fontSize(9.5).fillColor('#333333');
    [
      `・今日回報工地數：${reportedSites.size} / ${SITES.length} 個`,
      `・今日總出工人數：${totalWorkers} 人`,
      `・未回報工地：${unreportedSites.length ? unreportedSites.join('、') : '✓ 全部工地已回報'}`,
    ].forEach(line => { doc.text(line, ML + 8, cy); cy += 16; });
    cy += 8;

    doc.fontSize(11).fillColor('#1d3461').text('各工地回報明細', ML, cy);
    cy += 16;

    // 欄位定義（百分比寬度）
    const colDefs = [
      { header: '工地名稱', pct: 0.15, wrap: false },
      { header: '施工內容', pct: 0.35, wrap: true  },
      { header: '出工人數', pct: 0.10, wrap: false },
      { header: '施作數量', pct: 0.20, wrap: false },
      { header: '照片數',   pct: 0.08, wrap: false },
      { header: '回報時間', pct: 0.12, wrap: false },
    ];
    const cols = colDefs.map(c => ({ ...c, width: Math.floor(PW * c.pct) }));
    // 補足捨去的零頭至最後一欄
    const usedW = cols.reduce((s, c) => s + c.width, 0);
    cols[cols.length - 1].width += Math.round(PW - usedW);

    const PAD_X  = 4;
    const PAD_Y  = 5;
    const MIN_RH = 20;
    const HDR_H  = 20;

    function calcRowH(cells) {
      doc.font('CJK').fontSize(8);
      let h = MIN_RH;
      cols.forEach((col, i) => {
        if (!col.wrap) return;
        const needed = doc.heightOfString(String(cells[i] ?? '—'), {
          width: col.width - PAD_X * 2,
        }) + PAD_Y * 2;
        if (needed > h) h = needed;
      });
      return Math.ceil(h);
    }

    function drawRow(cells, y, rowH, isHeader) {
      // 背景
      let x = ML;
      cols.forEach(col => {
        doc.rect(x, y, col.width, rowH).fill(isHeader ? '#1d3461' : '#f8fafc');
        x += col.width;
      });
      // 外框線
      doc.rect(ML, y, PW, rowH).strokeColor('#94a3b8').lineWidth(0.5).stroke();
      // 垂直分隔線
      x = ML;
      cols.forEach(col => {
        doc.moveTo(x, y).lineTo(x, y + rowH).strokeColor('#94a3b8').lineWidth(0.3).stroke();
        x += col.width;
      });
      // 文字
      x = ML;
      cols.forEach((col, i) => {
        const txt  = String(cells[i] ?? '—');
        const opts = isHeader || !col.wrap
          ? { width: col.width - PAD_X * 2, lineBreak: false, ellipsis: true }
          : { width: col.width - PAD_X * 2, lineBreak: true };
        doc.fillColor(isHeader ? '#ffffff' : '#222222')
           .fontSize(isHeader ? 8.5 : 8)
           .text(txt, x + PAD_X, y + PAD_Y, opts);
        x += col.width;
      });
    }

    drawRow(cols.map(c => c.header), cy, HDR_H, true);
    cy += HDR_H;

    if (!rows.length) {
      const eh = MIN_RH * 2;
      doc.rect(ML, cy, PW, eh).fill('#f8fafc');
      doc.fillColor('#888888').fontSize(9)
         .text('今日尚無回報紀錄', ML, cy + 10, { width: PW, align: 'center' });
      cy += eh;
    } else {
      rows.forEach(r => {
        const imgCount = JSON.parse(r.image_paths || '[]').length;
        const cells = [
          r.site_name,
          r.progress_text,
          r.worker_count ? `${r.worker_count} 人` : '—',
          r.work_quantity,
          String(imgCount || 0),
          (r.reported_at || '').slice(11, 16),
        ];
        const rh = calcRowH(cells);
        if (cy + rh > doc.page.height - 50) {
          doc.addPage();
          cy = 40;
          drawRow(cols.map(c => c.header), cy, HDR_H, true);
          cy += HDR_H;
        }
        drawRow(cells, cy, rh, false);
        cy += rh;
      });
    }

    // 頁尾
    const footerY = doc.page.height - 28;
    doc.moveTo(ML, footerY - 6).lineTo(ML + PW, footerY - 6)
       .strokeColor('#e2e8f0').lineWidth(0.8).stroke();
    doc.fillColor('#94a3b8').fontSize(7.5)
       .text(`產製時間：${twNow()}`, ML, footerY, { width: PW, align: 'right' });

    // ── 第二頁起：今日施工照片 ────────────────────────────────
    doc.addPage();
    doc.fontSize(16).fillColor('#1d3461')
       .text('今日施工照片', ML, 44, { width: PW, align: 'center' });
    doc.moveTo(ML, 68).lineTo(ML + PW, 68).strokeColor('#3b82f6').lineWidth(1.5).stroke();

    // 收集所有照片（過濾不存在的檔案）
    const allPhotos = rows.flatMap(r =>
      JSON.parse(r.image_paths || '[]').map(p => ({
        site:     r.site_name,
        time:     (r.reported_at || '').slice(11, 16),
        fullPath: path.resolve(__dirname, p),
      })).filter(p => fs.existsSync(p.fullPath))
    );

    if (!allPhotos.length) {
      doc.fontSize(10).fillColor('#666666')
         .text('本日無施工照片', ML, 100, { width: PW, align: 'center' });
    } else {
      // 依工地分組
      const bysite = {};
      allPhotos.forEach(p => {
        if (!bysite[p.site]) bysite[p.site] = [];
        bysite[p.site].push(p);
      });

      const PHOTO_W  = 240;
      const PHOTO_H  = 180;
      const GAP      = Math.floor(PW - PHOTO_W * 2); // 兩欄間距
      const CAP_H    = 26;
      const BLOCK_H  = PHOTO_H + CAP_H + 10;
      const TITLE_H  = 24;

      let py = 80;

      for (const [siteName, photos] of Object.entries(bysite)) {
        if (py + TITLE_H + BLOCK_H > doc.page.height - 40) {
          doc.addPage();
          py = 40;
        }
        doc.fontSize(12).fillColor('#1d3461').text(`▌ ${siteName}`, ML, py);
        py += TITLE_H;

        for (let i = 0; i < photos.length; i += 2) {
          if (py + BLOCK_H > doc.page.height - 40) {
            doc.addPage();
            py = 40;
          }
          [photos[i], photos[i + 1]].forEach((photo, col) => {
            if (!photo) return;
            const px = ML + col * (PHOTO_W + GAP);
            try {
              doc.image(photo.fullPath, px, py, { fit: [PHOTO_W, PHOTO_H] });
            } catch (_) {
              doc.rect(px, py, PHOTO_W, PHOTO_H).strokeColor('#cccccc').stroke();
              doc.fillColor('#999999').fontSize(8)
                 .text('圖片無法載入', px, py + PHOTO_H / 2 - 6, {
                   width: PHOTO_W, align: 'center',
                 });
            }
            doc.fillColor('#555555').fontSize(8)
               .text(`${photo.site}　${photo.time}`, px, py + PHOTO_H + 4, {
                 width: PHOTO_W, lineBreak: false, ellipsis: true,
               });
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

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !REPORT_EMAIL) {
    console.warn('[Report] Email env vars not configured, skipping send');
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
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from:    `Hans工程回報系統 <${process.env.GMAIL_USER}>`,
      to:      REPORT_EMAIL,
      subject: `【Hans工程回報】${dateLabel} 日報表`,
      text:    `您好，\n\n附件為 ${dateLabel} 工程回報日報表，請查閱。\n\n（此信件由系統自動發送，請勿回覆）`,
      attachments: [{ filename: `工程日報表-${targetDate}.pdf`, path: tmpPath }],
    });

    console.log(`[Report] Sent daily report for ${targetDate} to ${REPORT_EMAIL}`);
  } catch (err) {
    console.error('[Report] Send failed:', err.message);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── 每日 18:00 自動寄送（台灣時間）──────────────────────────
cron.schedule('0 18 * * *', () => {
  console.log('[Cron] Sending daily report...');
  sendDailyReport().catch(err => console.error('[Cron]', err.message));
}, { timezone: 'Asia/Taipei' });

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── GET /uploads（靜態圖片）────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── GET /report/today（手動下載 PDF，?date=YYYY-MM-DD 可指定日期）──
app.get('/report/today', async (req, res) => {
  const targetDate = req.query.date || twToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });
  }
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
  const allRows = db.prepare('SELECT * FROM reports ORDER BY reported_at DESC').all();

  const todayStr = twToday();

  const todayRows = allRows.filter(r => r.reported_at && r.reported_at.startsWith(todayStr));
  const histRows  = allRows.slice(0, 30);

  const reportedSiteSet = new Set(todayRows.map(r => r.site_name));
  const unreportedSites = SITES.filter(s => !reportedSiteSet.has(s));
  const todayWorkers    = todayRows.reduce((s, r) => s + (parseInt(r.worker_count) || 0), 0);

  function buildRows(rows) {
    if (!rows.length) return `<tr><td colspan="7" class="empty">尚無回報紀錄</td></tr>`;
    return rows.map(r => {
      const imgs   = JSON.parse(r.image_paths || '[]');
      const photos = imgs.length
        ? imgs.map((p, i) =>
            `<a href="/uploads/${path.basename(p)}" target="_blank" class="view-link">` +
            `查看${imgs.length > 1 ? (i + 1) : ''}</a>`).join(' ')
        : '<span class="dim">—</span>';
      const t = (r.reported_at || '').slice(0, 16);
      return `<tr>
        <td><span class="site-badge">${r.site_name}</span></td>
        <td>${r.progress_text || '—'}</td>
        <td class="tc">${r.worker_count || '—'}</td>
        <td>${r.work_quantity || '—'}</td>
        <td class="tc">${imgs.length}</td>
        <td>${photos}</td>
        <td class="tc mono">${t}</td>
      </tr>`;
    }).join('');
  }

  const siteOptions = SITES.map(s =>
    `<option value="${s}">${s}</option>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hans 工程回報後台</title>
<meta http-equiv="refresh" content="60">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
     background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px}
h1{font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.subtitle{font-size:13px;color:#64748b;margin-bottom:24px}
h2{font-size:15px;font-weight:600;color:#93c5fd;margin:28px 0 12px;
   border-left:3px solid #3b82f6;padding-left:10px}

/* 統計卡片 */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px 20px}
.card .num{font-size:30px;font-weight:700;color:#60a5fa;line-height:1}
.card .lbl{font-size:12px;color:#94a3b8;margin-top:6px}
.card.warn .num{color:#f97316}
.card.ok   .num{color:#34d399}

/* 未回報清單 */
.unreport{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.tag{background:#7f1d1d;color:#fca5a5;font-size:12px;padding:3px 10px;border-radius:999px}
.tag.none{background:#14532d;color:#86efac}

/* 表格容器 */
.wrap{background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:auto;margin-bottom:8px}
table{border-collapse:collapse;width:100%;min-width:600px}
th{background:#1d3461;color:#93c5fd;padding:10px 13px;text-align:left;
   font-size:13px;font-weight:600;white-space:nowrap}
td{padding:10px 13px;border-bottom:1px solid #1e3a5f;font-size:13px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#0f2744}
.tc{text-align:center}
.mono{font-family:monospace;font-size:12px;color:#94a3b8}
.dim{color:#475569}
.empty{text-align:center;color:#475569;padding:28px;font-size:13px}
.site-badge{display:inline-block;background:#1d3461;color:#93c5fd;
            font-size:12px;padding:2px 8px;border-radius:4px;white-space:nowrap}
.view-link{color:#60a5fa;text-decoration:none;margin-right:4px;font-size:12px}
.view-link:hover{text-decoration:underline}

/* 篩選列 */
.filter-row{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.filter-row label{font-size:13px;color:#94a3b8}
select{background:#1e293b;border:1px solid #334155;color:#e2e8f0;
       padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer}

@media(max-width:640px){
  h1{font-size:17px} .card .num{font-size:24px}
  th,td{padding:8px 10px;font-size:12px}
}
</style>
</head>
<body>
<h1>Hans 工程回報後台</h1>
<p class="subtitle">今日：${todayStr}　每 60 秒自動更新</p>

<!-- 區塊一：統計卡片 -->
<div class="cards">
  <div class="card ok">
    <div class="num">${reportedSiteSet.size}</div>
    <div class="lbl">今日回報工地數</div>
  </div>
  <div class="card">
    <div class="num">${todayWorkers}</div>
    <div class="lbl">今日總出工人數</div>
  </div>
  <div class="card warn">
    <div class="num">${unreportedSites.length}</div>
    <div class="lbl">今日未回報工地數</div>
  </div>
  <div class="card">
    <div class="num">${allRows.length}</div>
    <div class="lbl">累計總回報次數</div>
  </div>
</div>
<div class="unreport" style="margin-bottom:24px">
  ${unreportedSites.length
    ? unreportedSites.map(s => `<span class="tag">${s}</span>`).join('')
    : '<span class="tag none">所有工地已回報</span>'}
</div>

<!-- 區塊二：今日回報明細 -->
<h2>今日回報明細（${todayRows.length} 筆）</h2>
<div class="wrap">
  <table>
    <thead><tr>
      <th>工地名稱</th><th>施工內容</th><th>出工人數</th>
      <th>施作數量</th><th>照片數</th><th>照片連結</th><th>回報時間</th>
    </tr></thead>
    <tbody>${buildRows(todayRows)}</tbody>
  </table>
</div>

<!-- 區塊三：歷史回報記錄 -->
<h2>歷史回報記錄（最近 30 筆）</h2>
<div class="filter-row">
  <label>依工地篩選：</label>
  <select id="siteFilter" onchange="filterTable()">
    <option value="">全部</option>
    ${siteOptions}
  </select>
</div>
<div class="wrap">
  <table id="histTable">
    <thead><tr>
      <th>工地名稱</th><th>施工內容</th><th>出工人數</th>
      <th>施作數量</th><th>照片數</th><th>照片連結</th><th>回報時間</th>
    </tr></thead>
    <tbody id="histBody">${buildRows(histRows)}</tbody>
  </table>
</div>

<script>
const raw = ${JSON.stringify(histRows.map(r => ({
  site: r.site_name,
  prog: r.progress_text || '—',
  wc:   r.worker_count  || '—',
  wq:   r.work_quantity || '—',
  imgs: JSON.parse(r.image_paths || '[]').map(p => p.split('/').pop()),
  time: (r.reported_at || '').slice(0,16),
})))};

function filterTable() {
  const val = document.getElementById('siteFilter').value;
  const rows = val ? raw.filter(r => r.site === val) : raw;
  const tbody = document.getElementById('histBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">無符合紀錄</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const photos = r.imgs.length
      ? r.imgs.map((f,i) =>
          '<a href="/uploads/'+f+'" target="_blank" class="view-link">查看'+(r.imgs.length>1?i+1:'')+'</a>'
        ).join(' ')
      : '<span class="dim">—</span>';
    return '<tr>'
      + '<td><span class="site-badge">'+r.site+'</span></td>'
      + '<td>'+r.prog+'</td>'
      + '<td class="tc">'+r.wc+'</td>'
      + '<td>'+r.wq+'</td>'
      + '<td class="tc">'+r.imgs.length+'</td>'
      + '<td>'+photos+'</td>'
      + '<td class="tc mono">'+r.time+'</td>'
      + '</tr>';
  }).join('');
}
</script>
</body>
</html>`);
});

// ── POST /webhook ─────────────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  res.status(200).json({ status: 'ok' });

  const rawBody = req.body;
  const signature = req.headers['x-line-signature'];

  if (signature) {
    const digest = crypto
      .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest('base64');
    if (signature !== digest) {
      console.error('[Webhook] invalid signature');
      return;
    }
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString());
  } catch (e) {
    console.error('[Webhook] JSON parse error:', e.message);
    return;
  }

  const events = body.events || [];
  Promise.all(events.map(handleEvent)).catch(err => {
    console.error('[Handler]', err.message);
  });
});

// ── Process 信號處理 ──────────────────────────────────────────
process.on('SIGHUP', () => {});

process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message);
});

process.on('unhandledRejection', reason => {
  console.error('[unhandledRejection]', reason);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

// ── 啟動 ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Error] Port ${PORT} in use — run: lsof -ti :${PORT} | xargs kill -9`);
    process.exit(1);
  } else {
    console.error('[Server Error]', err.message);
  }
});
