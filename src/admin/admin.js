// ════════════════════════════════════════════════════════════════
// 闪投 · 数据后台（口令保护的只读页）
// 需求口径：v1 只做口令保护，不做账号/权限；只读，不提供任何写操作。
// 口令存 SHA-256 哈希（ui:adminPass），首次打开自设。认证状态只在内存，
// 关掉页面就要重新输——内部工具，宁可麻烦一点也不留门。
// ════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 口令闸 ─────────────────────────────────────────────────────

async function initGate() {
  const st = await chrome.storage.local.get(STORE.UI.ADMIN_PASS);
  const has = !!st[STORE.UI.ADMIN_PASS];
  $('gate-setup').hidden = has;
  $('gate-login').hidden = !has;
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
}

$('btn-setup').addEventListener('click', async () => {
  const p1 = $('setup-p1').value;
  const p2 = $('setup-p2').value;
  if (p1.length < 4) { alert('口令至少 4 位'); return; }
  if (p1 !== p2) { alert('两次输入不一致'); return; }
  await chrome.storage.local.set({ [STORE.UI.ADMIN_PASS]: await sha256(p1) });
  showMain();
});

$('btn-login').addEventListener('click', async () => {
  const st = await chrome.storage.local.get(STORE.UI.ADMIN_PASS);
  const ok = (await sha256($('login-p').value)) === st[STORE.UI.ADMIN_PASS];
  $('login-err').hidden = ok;
  if (ok) showMain();
});
$('login-p').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click(); });

// ── 主内容 ─────────────────────────────────────────────────────

async function showMain() {
  $('gate').hidden = true;
  $('main').hidden = false;
  renderStats();
  renderFeedback();
}

async function renderStats() {
  const { days: rows, total } = await Tracker.stats(30);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
  const today = rows.length ? rows[rows.length - 1] : { dau: 0 };

  const card = (label, val, sub) =>
    `<div class="metric"><div class="m-label">${label}</div><div class="m-val">${val}</div><div class="m-sub">${sub}</div></div>`;
  $('metrics').innerHTML =
    card('今日日活', today.dau, `近 30 天去重 ${total.dau} 人`) +
    card('海投点击渗透', pct(total.ht, total.dau), `${total.ht}/${total.dau} 人点过`) +
    card('精投点击渗透', pct(total.jt, total.dau), `${total.jt}/${total.dau} 人点过`) +
    card('一键投递渗透', pct(total.send, total.dau), `${total.send}/${total.dau} 人点过`);

  const body = $('daily').querySelector('tbody');
  body.innerHTML = rows.slice().reverse().map((r) =>
    `<tr><td>${r.day}</td><td>${r.dau}</td><td>${r.ht}</td><td>${pct(r.ht, r.dau)}</td>` +
    `<td>${r.jt}</td><td>${pct(r.jt, r.dau)}</td><td>${r.send}</td><td>${pct(r.send, r.dau)}</td></tr>`
  ).join('') || '<tr><td colspan="8" class="muted">暂无数据</td></tr>';
}

async function readFeedback() {
  const st = await chrome.storage.local.get(STORE.UI.FEEDBACK);
  return Array.isArray(st[STORE.UI.FEEDBACK]) ? st[STORE.UI.FEEDBACK] : [];
}

async function renderFeedback() {
  const list = await readFeedback();
  $('fb-count').textContent = `共 ${list.length} 条`;
  $('fb-list').innerHTML = list.length ? list.slice().reverse().map((f) =>
    `<div class="fb-item">` +
    `<div class="fb-meta">${fmtTime(f.ts)} · v${esc(f.version || '?')} · 来源页：${esc(f.source || '?')}` +
    ` · 设备 ${esc(String(f.uid || '').slice(0, 8))}` +
    (f.contact ? ` · 联系方式：${esc(f.contact)}` : '') + `</div>` +
    `<div class="fb-text">${esc(f.text)}</div></div>`
  ).join('') : '<div class="fb-empty">暂无反馈</div>';
}

// ── 导出 ───────────────────────────────────────────────────────

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

$('btn-export-stats').addEventListener('click', async () => {
  downloadCsv(`闪投埋点统计-${stamp()}.csv`, await Tracker.exportCsv(90));
});

$('btn-export-fb').addEventListener('click', async () => {
  const list = await readFeedback();
  const head = '时间,版本,来源页,联系方式,设备ID,内容';
  const lines = list.map((f) =>
    [fmtTime(f.ts), 'v' + (f.version || '?'), f.source || '', f.contact || '', f.uid || '', f.text]
      .map(csvCell).join(','));
  downloadCsv(`闪投客服反馈-${stamp()}.csv`, '﻿' + [head, ...lines].join('\r\n'));
});

initGate();
