// ============================
// draw.js — 三層分離（Mask→Paint→Outline）+ Admin 模式(Tab+A)
// ============================

let canvas;

// Layers
let pgPaint;   // 使用者上色（中層，100% 不透明顯示）
let maskG;     // 與畫面同尺寸的遮罩（由 rabbit_mask.png 放大/縮小後 blit）
let previewG;  // 用於實際出圖（pgPaint × maskG）
let scratchG;  // 單筆暫存 → 用 mask 即時硬裁切後合入 pgPaint

// Templates
const MASK_PATH    = '/assets/rabbit_mask.png';
const OUTLINE_PATH = '/assets/rabbit_outline.png';
let tplMaskImg = null;
let tplOutlineImg = null;

// Visual params
const MASK_OVERLAY_ALPHA = 170; // Mask 底層可視度（0=隱；255=實）
const OUTLINE_ALPHA      = 210; // Outline 頂層可視度

// Box (contain templates into this region)
let templateBox = { x: 0, y: 0, w: 0, h: 0 };

// UI (簡化後只留必要)
let brushSize, brushColorInput;
let btnClear, btnSend;

// WS & Preview
let WS;
let _previewWrap, _previewImg, _btnConfirm, _btnCancel;
let lastExportInfo = { bytes: 0, w: 0, h: 0 };

// Admin mode
let adminMode = false;
let tabDown = false;
let _connBadge, _adminHUD;



// ---------- preload ----------
function preload() {
  tplMaskImg    = loadImage(MASK_PATH,    () => {}, () => console.warn('[draw] mask not found:', MASK_PATH));
  tplOutlineImg = loadImage(OUTLINE_PATH, () => {}, () => console.warn('[draw] outline not found:', OUTLINE_PATH));
}

function setup() {
  pixelDensity(1);
  canvas = createCanvas(windowWidth, windowHeight);
  preventPageScrollWhileDrawing();

  pgPaint  = createGraphics(width, height);  pgPaint.pixelDensity(1);  pgPaint.clear();
  maskG    = createGraphics(width, height);  maskG.pixelDensity(1);    maskG.clear();
  previewG = createGraphics(width, height);  previewG.pixelDensity(1); previewG.clear();
  scratchG = createGraphics(width, height);  scratchG.pixelDensity(1); scratchG.clear();

  // 綁定必要控件
  brushSize       = document.getElementById('brushSize');
  brushColorInput = document.getElementById('brushColor');
  btnClear        = document.getElementById('btnClear');
  btnSend         = document.getElementById('btnSend');

  // 隱藏你不要的元素（如存在）
  hideIfExists('name');
  hideIfExists('tip');
  hideIfExists('btnEraser');
  hideIfExists('btnBg');
  hideIfExists('btnBrush');

  // 清除（只剩一層 Paint）
  btnClear?.addEventListener('click', () => { pgPaint.clear(); });

  // 送出 → 先 Preview
  btnSend?.addEventListener('click', openPreviewModal);

  computeTemplateBox();
  rebuildMaskFromTemplate();

  // WS
  mountConnectionBadge();  // 先建立，但 Admin 模式以外隱藏
  WS = createWSManager({
    role: 'drawer',
    onMessage: () => {},
    onStateChange: (state) => { updateConnectionBadge(state); if (adminMode) showConnBadge(); }
  });
  hideConnBadge();

  // Admin HUD
  mountAdminHUD();
  hideAdminHUD();

  // Preview modal
  mountPreviewModal();

  // 模板未載好 → 禁用 Send
  const ready = !!(tplMaskImg && tplOutlineImg);
  if (btnSend) {
    btnSend.disabled = !ready;
    btnSend.title = ready ? '' : 'Please check /assets/rabbit_mask.png and rabbit_outline.png exist or not';
  }

  // Admin 模式切換：Tab + A
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);
}

// 檔案內新增：
function preventPageScrollWhileDrawing() {
  // ✅ 只鎖 Canvas 本身的手勢，其他 UI（包括 Slider）不受影響
  canvas.elt.style.touchAction = 'none';
  canvas.elt.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  canvas.elt.addEventListener?.('gesturestart', (e) => e.preventDefault(), { passive: false });

  // 建議保留 overscroll-behavior，避免橡皮筋，但不鎖 overflow
  document.documentElement.style.overscrollBehavior = 'none';
  document.body.style.overscrollBehavior = 'none';

  // ❌ 不要在 touchstart/touchend 時把 body.overflow 改為 hidden
  // （這會在某些情況下連 UI 都一齊鎖住）
}

// p5：在觸控移動時阻止預設（避免滾動）
//function touchMoved() { return false; }


function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  const oldPaint = pgPaint.get();
  pgPaint  = createGraphics(width, height);  pgPaint.pixelDensity(1);  pgPaint.clear();  pgPaint.image(oldPaint, 0, 0, width, height);
  maskG    = createGraphics(width, height);  maskG.pixelDensity(1);    maskG.clear();
  previewG = createGraphics(width, height);  previewG.pixelDensity(1); previewG.clear();
  scratchG = createGraphics(width, height);  scratchG.pixelDensity(1); scratchG.clear();

  computeTemplateBox();
  rebuildMaskFromTemplate();
}

function draw() {
  // 乾淨背景（純黑）
  background(0);

  // 畫畫：先畫 scratch，再用 mask 硬裁切，最後合入 pgPaint
  if (mouseIsPressed && mouseWithinCanvas()) {
    scratchG.clear();
    drawStroke(scratchG); // 永遠不透明畫筆
    scratchG.push();
    scratchG.drawingContext.globalCompositeOperation = 'destination-in';
    scratchG.image(maskG, 0, 0);
    scratchG.drawingContext.globalCompositeOperation = 'source-over';
    scratchG.pop();
    pgPaint.image(scratchG, 0, 0);
  }

  // （重要）顯示順序：底 Mask → 中 Paint → 面 Outline
  drawMaskOverlay();           // 半透明提示範圍（底）
  image(pgPaint, 0, 0);        // 使用者上色（中，100% 清晰）
  drawFixedOutline();          // 半透明 Outline（面）

  // 筆刷游標
  noFill(); stroke(255, 140);
  const r = Number(brushSize?.value || 16) / 2;
  circle(mouseX, mouseY, r * 2);

  // Admin HUD（只在 adminMode 顯示）
  if (adminMode) updateAdminHUD();
}

function drawStroke(g) {
  g.push();
  g.strokeWeight(Number(brushSize?.value || 16));
  g.strokeCap(ROUND);
  g.strokeJoin(ROUND);
  g.noErase();
  const c = color(brushColorInput?.value || '#ffffff');
  c.setAlpha(255);           // 強制 100% 不透明
  g.stroke(c);
  g.line(pmouseX, pmouseY, mouseX, mouseY);
  g.pop();
}

function mouseWithinCanvas() { return mouseX >= 0 && mouseY >= 0 && mouseX < width && mouseY < height; }
function hideIfExists(id)    { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

// ---- 模板與遮罩 ----
function computeTemplateBox() {
  const margin = 40;
  const maxW = width  - margin * 2;
  const maxH = height - margin * 2;
  const targetH = Math.min(maxH, maxW * 1.1);
  const targetW = Math.min(maxW, targetH * 0.9);
  templateBox.w = Math.round(targetW);
  templateBox.h = Math.round(targetH);
  templateBox.x = Math.round((width  - templateBox.w) / 2);
  templateBox.y = Math.round((height - templateBox.h) * 0.55);
}

function rebuildMaskFromTemplate() {
  maskG.clear();
  if (!tplMaskImg) return;
  const nm = normalizeMaskAlpha(tplMaskImg);
  const { dx, dy, dw, dh } = fitImageInBox(nm.width, nm.height, templateBox);
  maskG.push();
  maskG.imageMode(CORNER);
  maskG.image(nm, dx, dy, dw, dh);
  maskG.pop();
}

function drawMaskOverlay() {
  if (!tplMaskImg) return;
  push();
  tint(255, MASK_OVERLAY_ALPHA);
  image(maskG, 0, 0);
  noTint();
  pop();
}

function drawFixedOutline() {
  if (!tplOutlineImg) return;
  const { dx, dy, dw, dh } = fitImageInBox(tplOutlineImg.width, tplOutlineImg.height, templateBox);
  push();
  tint(255, OUTLINE_ALPHA);
  imageMode(CORNER);
  image(tplOutlineImg, dx, dy, dw, dh);
  noTint();
  pop();
}

function fitImageInBox(imgW, imgH, box) {
  const scale = Math.min(box.w / imgW, box.h / imgH);
  const dw = imgW * scale, dh = imgH * scale;
  const dx = box.x + (box.w - dw) / 2;
  const dy = box.y + (box.h - dh) / 2;
  return { dx, dy, dw, dh, scale };
}

// 若 mask PNG 無 alpha（黑白圖），以亮度轉 alpha
function normalizeMaskAlpha(img) {
  const w = img.width, h = img.height;
  const g = createGraphics(w, h); g.pixelDensity(1); g.clear(); g.image(img, 0, 0, w, h);
  g.loadPixels();

  let hasVarAlpha = false;
  for (let i = 3; i < g.pixels.length; i += 4) { if (g.pixels[i] < 250) { hasVarAlpha = true; break; } }
  if (hasVarAlpha) return img;

  const out = createImage(w, h); out.loadPixels();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = 4 * (y * w + x);
    const r = g.pixels[idx], gg = g.pixels[idx+1], b = g.pixels[idx+2];
    const luma = 0.2126*r + 0.7152*gg + 0.0722*b;
    const inside = luma > 127;
    if (inside) { out.pixels[idx]=255; out.pixels[idx+1]=255; out.pixels[idx+2]=255; out.pixels[idx+3]=255; }
    else        { out.pixels[idx]=0;   out.pixels[idx+1]=0;   out.pixels[idx+2]=0;   out.pixels[idx+3]=0;   }
  }
  out.updatePixels();
  return out;
}

// ---- 輸出 & Preview ----
function previewComposite() {
  previewG.clear();
  previewG.push();
  previewG.image(pgPaint, 0, 0);
  previewG.drawingContext.globalCompositeOperation = 'destination-in';
  previewG.image(maskG, 0, 0);
  previewG.drawingContext.globalCompositeOperation = 'source-over';
  previewG.pop();
}

function buildExportImage() {
  // 先以實際輸出流程做一次合成
  const exportG = createGraphics(width, height);
  exportG.pixelDensity(1); exportG.clear();
  exportG.image(pgPaint, 0, 0);
  exportG.drawingContext.globalCompositeOperation = 'destination-in';
  exportG.image(maskG, 0, 0);
  exportG.drawingContext.globalCompositeOperation = 'source-over';

  const trimmed = trimTransparent(exportG, { alphaThreshold: 8, padding: 2 });
  const { gfx, w, h } = trimmed;

  const maxDim = 512;
  let outW = Math.max(1, w), outH = Math.max(1, h);
  if (Math.max(outW, outH) > maxDim) {
    const s = maxDim / Math.max(outW, outH);
    outW = Math.max(1, Math.round(outW * s));
    outH = Math.max(1, Math.round(outH * s));
  }
  const out = createGraphics(outW, outH);
  out.pixelDensity(1); out.clear();
  out.image(gfx, 0, 0, outW, outH);
  const imgData = out.elt.toDataURL('image/png');
  lastExportInfo = { bytes: Math.round((imgData.length * 3) / 4), w: outW, h: outH }; // base64→byte 估算

  return { imgData,
    payload: { type: 'add_rabbit', imgData, w: outW, h: outH } // 不再傳 name
  };
}

function trimTransparent(g, options = {}) {
  const { alphaThreshold = 8, padding = 2 } = options;
  const img = g.get(); img.loadPixels();
  const w = img.width, h = img.height, d = pixelDensity();

  const hasAlphaAt = (x, y) => {
    for (let dy = 0; dy < d; dy++) for (let dx = 0; dx < d; dx++) {
      const px = x * d + dx, py = y * d + dy;
      const idx = 4 * (py * (w * d) + px);
      if (img.pixels[idx + 3] >= alphaThreshold) return true;
    }
    return false;
  };

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (hasAlphaAt(x, y)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    const empty = createGraphics(64, 64); empty.pixelDensity(1); empty.clear();
    return { gfx: empty, w: 64, h: 64 };
  }

  const pad = Math.max(0, padding || 0);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

  const outW = maxX - minX + 1, outH = maxY - minY + 1;
  const gfx = createGraphics(outW, outH); gfx.pixelDensity(1); gfx.clear();
  gfx.image(img, -minX, -minY);
  return { gfx, w: outW, h: outH };
}

// ---- Preview Modal ----
function mountPreviewModal() {
  _previewWrap = document.createElement('div');
  _previewWrap.style.cssText = `
    position: fixed; inset: 0; display: none; place-items: center;
    background: rgba(0,0,0,0.55); z-index: 99999;
  `;
  const panel = document.createElement('div');
  panel.style.cssText = `
    background: #1d1f24; color: #fff; padding: 16px;
    border-radius: 12px; width: min(90vw, 520px);
    box-shadow: 0 10px 40px rgba(0,0,0,0.35);
  `;
  const title = document.createElement('div');
  title.textContent = 'Preview';
  title.style.cssText = 'font-weight:600;margin-bottom:8px;font-size:16px;';
  _previewImg = document.createElement('img');
  _previewImg.style.cssText = `
    display:block; width:100%; height:auto; border-radius:8px;
    background: repeating-conic-gradient(#222 0% 25%, #2a2d34 0% 50%) 50% / 16px 16px;
  `;
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
  _btnCancel = document.createElement('button');
  _btnCancel.textContent = 'Continue to Modify';
  _btnCancel.style.cssText = btnCss('#3a3f47');
  _btnCancel.onclick = () => { _previewWrap.style.display = 'none'; };
  _btnConfirm = document.createElement('button');
  _btnConfirm.textContent = 'Send to Rabbit Playground';
  _btnConfirm.style.cssText = btnCss('#2ecc71');
  _btnConfirm.onclick = () => { _previewWrap.style.display = 'none'; doSendToZoo(); };
  btnRow.appendChild(_btnCancel); btnRow.appendChild(_btnConfirm);
  panel.appendChild(title); panel.appendChild(_previewImg); panel.appendChild(btnRow);
  _previewWrap.appendChild(panel); document.body.appendChild(_previewWrap);

  function btnCss(bg) {
    return `padding:8px 12px;border-radius:8px;border:1px solid #444;background:${bg};color:#fff;cursor:pointer;font-size:13px;`;
  }
}
function openPreviewModal() {
  const { imgData } = buildExportImage();
  _previewImg.src = imgData;
  _previewWrap.style.display = 'grid';
}
function doSendToZoo() {
  if (!WS || !WS.isOpen()) { alert('WebSocket Connecting/Reconnecting, please try again later。'); return; }
  const { payload } = buildExportImage();
  const ok = WS.send(payload);
  if (!ok) { alert('Unable to send, WebSocket not ready'); return; }
  alert('Already Sent Rabbit Playround！');
}

// ============================
// Admin 模式 & 連線徽章/HUD
// ============================
function onKeyDown(e) {
  if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
    adminMode = !adminMode;
    if (adminMode) { showConnBadge(); showAdminHUD(); }
    else           { hideConnBadge(); hideAdminHUD(); }
    e.preventDefault();
  }
}
function onKeyUp(e) { if (e.code === 'Tab') tabDown = false; }

function mountAdminHUD() {
  _adminHUD = document.createElement('div');
  _adminHUD.style.cssText = `
    position: fixed; top: 10px; left: 10px; z-index: 9999;
    background: rgba(0,0,0,0.6); color: #fff; padding: 8px 10px; border-radius: 8px;
    font: 12px/1.4 system-ui, sans-serif; backdrop-filter: blur(4px);
  `;
  _adminHUD.innerHTML = `
    <div><b>Admin HUD</b></div>
    <div id="hudWS">WS: -</div>
    <div id="hudFPS">FPS: -</div>
    <div id="hudCanvas">Canvas: -</div>
    <div id="hudTpl">TemplateBox: -</div>
    <div id="hudBrush">Brush: -</div>
    <div id="hudLast">Last Export: -</div>
  `;
  document.body.appendChild(_adminHUD);
}
function updateAdminHUD() {
  if (!_adminHUD) return;
  _adminHUD.querySelector('#hudWS').textContent     = `WS: ${WS?.getState?.() || '-'}`;
  _adminHUD.querySelector('#hudFPS').textContent    = `FPS: ${Math.round(frameRate())}`;
  _adminHUD.querySelector('#hudCanvas').textContent = `Canvas: ${width}×${height}`;
  _adminHUD.querySelector('#hudTpl').textContent    = `TemplateBox: ${templateBox.w}×${templateBox.h} at (${templateBox.x},${templateBox.y})`;
  _adminHUD.querySelector('#hudBrush').textContent  = `Brush: ${brushSize?.value || '-'} / ${brushColorInput?.value || '-'}`;
  const kb = (lastExportInfo.bytes/1024).toFixed(1);
  _adminHUD.querySelector('#hudLast').textContent   = `Last Export: ${lastExportInfo.w}×${lastExportInfo.h} @ ${kb} KB`;
}
function showAdminHUD() { if (_adminHUD) _adminHUD.style.display = 'block'; }
function hideAdminHUD() { if (_adminHUD) _adminHUD.style.display = 'none'; }

function mountConnectionBadge() {
  _connBadge = document.createElement('div');
  _connBadge.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 9999;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 10px; background: rgba(0,0,0,0.45);
    border-radius: 999px; color: #fff; font: 12px/1.2 system-ui, sans-serif;
    backdrop-filter: blur(4px);
  `;
  const dot = document.createElement('span');
  dot.id='connDot';
  dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:#aaa;box-shadow:0 0 8px rgba(255,255,255,0.4);`;
  const text = document.createElement('span');
  text.id='connText'; text.textContent='Connecting…';
  _connBadge.appendChild(dot); _connBadge.appendChild(text);
  document.body.appendChild(_connBadge);
}
function updateConnectionBadge(state) {
  if (!_connBadge) return;
  const dot  = _connBadge.querySelector('#connDot');
  const text = _connBadge.querySelector('#connText');
  switch (state) {
    case 'open':         dot.style.background = '#2ecc71'; text.textContent = 'Connected'; break;
    case 'reconnecting': dot.style.background = '#f39c12'; text.textContent = 'Reconnecting…'; break;
    case 'connecting':   dot.style.background = '#95a5a6'; text.textContent = 'Connecting…'; break;
    default:             dot.style.background = '#7f8c8d'; text.textContent = 'Disconnected';
  }
}
function showConnBadge() { if (_connBadge) _connBadge.style.display = 'inline-flex'; }
function hideConnBadge() { if (_connBadge) _connBadge.style.display = 'none'; }

// ============================
// WebSocket manager（沿用）
// ============================
function createWSManager({ role = 'client', onMessage, onStateChange } = {}) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}`;
  let ws = null, reconnectAttempts = 0, reconnectTimer = null, keepAliveTimer = null;
  let state = 'disconnected';

  function setState(next) { state = next; if (typeof onStateChange === 'function') onStateChange(state); }
  function backoffDelay(){ return Math.min(8000, Math.round(800 * Math.pow(1.7, reconnectAttempts))); }

  function connect() {
    clearTimeout(reconnectTimer); try { ws && ws.close(); } catch {}
    ws = null; setState('connecting');
    const instance = new WebSocket(url); ws = instance;

    instance.addEventListener('open', () => {
      reconnectAttempts = 0; setState('open');
      clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'client_ping', ts: Date.now(), role }));
      }, 25000);
    });
    instance.addEventListener('message', (ev) => {
      if (typeof onMessage !== 'function') return;
      try { onMessage(JSON.parse(ev.data)); } catch (e) { console.warn('[ws] invalid JSON', e); }
    });

    function scheduleReconnect() {
      if (state === 'reconnecting') return;
      setState('reconnecting'); const delay = backoffDelay();
      reconnectAttempts++; reconnectTimer = setTimeout(connect, delay);
    }
    instance.addEventListener('close', () => { clearInterval(keepAliveTimer); keepAliveTimer = null; scheduleReconnect(); });
    instance.addEventListener('error', () => { try { instance.close(); } catch {} });
  }

  function send(obj){ if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } console.warn('[ws] not open'); return false; }
  function isOpen(){ return ws && ws.readyState === 1; }
  function getState(){ return state; }

  connect(); return { send, isOpen, getState };
}
