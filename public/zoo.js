// ============================
// zoo.js — Hop-only（forward/inplace/idle）+ 拋物線式向前跳（x 同步前進）
// 行列透視 + 方向 flip + 月亮脈動 + Admin(Ctrl/⌘ + A) + 點擊刪除(只限 Admin)
// Prefab 自動送兔（不需 Admin）+ R 鍵即時送一隻
// ============================

let WS;
let rabbits = [];
let canvas;

// ------- 可調參數（行列/視覺） -------
const GLOBAL_SCALE_MULT = 0.5; // 全體再縮 50%
const ROW_COUNT = 6;           // 建議 6~7 行
const FRONT_Y = 0.9;          // 最前排 yNorm
const BACK_Y  = 0.28;          // 最後排 yNorm（越細越高）
const ROW_SCALE_DECAY = 0.78;  // 每上一排縮小倍率
const HOP_HEIGHT_BASE = 0.22;  // 前排垂直跳高（以自身高比例）
const HOP_HEIGHT_DECAY= 0.88;  // 上一排跳高遞減

// ------- Hop-only 行為參數（同步前進）-------
const HOP_PERIOD_RANGE   = [0.4, 0.8]; // 每次跳的時長（秒）
const FRONT_DX_PER_HOP   = 0.02;        // 前排每次「向前跳」的水平推進量 (xNorm)
const DX_DECAY_PER_ROW   = 0.86;         // 每上一排位移更少（遠景更慢）
const P_INPLACE_AFTER_HOP= 0.001;         // 跳完轉做原地跳的機率
const P_IDLE_AFTER_HOP   = 0.95;         // 跳完轉做停留的機率
const IDLE_RANGE_S       = [3, 5];   // 停留（idle）時間（秒）

// ------- 月亮（脈動） -------
const MOON_Y_NORM = 0.1;
const MOON_RADIUS = 70;
const MOON_GLOW_LAY = 6;
let tMoon = 0;

// ------- 耳仔 & 頭身切割（可微調）-------
const HEAD_RATIO_BASE   = 0.25; // 頭部高度/整體高度（0.30~0.46 建議）
const HEAD_RATIO_JITTER = 0.05; // 每隻兔子的微小隨機（0.00~0.05）
const OVERLAP_RATIO     = 0.04; // 接縫重疊帶比例（避免裂縫）
const PIVOT_OFFSET_PX   = 0;    // 旋轉中心相對接縫像素位移（+ 下移 / - 上移）

// ------- Admin 模式 / UI -------
let adminMode = false;
let _connBadge, _btnClear;

// ------- Prefab（不需 Admin；開頁自動送；R key 立即送）-------
const PREFAB_INTERVAL_MS = 60_000; // ~1分鐘一隻
let _prefabTimer = null;
// TODO: 在此填入你預先準備嘅 PNG（同源路徑）
const PREFAB_URLS = [
  '/assets/prefabs/rabbit01.png',
  '/assets/prefabs/rabbit02.png',
  '/assets/prefabs/rabbit03.png',
  '/assets/prefabs/rabbit04.png',
  '/assets/prefabs/rabbit05.png'
];

// 行列定義（每排的 y、朝向、縮放、跳高）
let rowDefs = [];

// ---------------- Setup ----------------
function setup() {
  canvas = createCanvas(windowWidth, windowHeight);
  frameRate(60);
  rowDefs = buildRowDefs();

  // Connection badge / Clear All（只在 Admin 顯示）
  mountConnectionBadge(); hideConnBadge();
  mountClearButton();     hideClearBtn();

  // WebSocket
  WS = createWSManager({
    role: 'viewer',
    onMessage: handleServerMessage,
    onStateChange: (state) => {
      updateConnectionBadge(state);
      if (adminMode) showConnBadge();
    }
  });

  // Admin 切換（Ctrl + A / Cmd + A）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
      adminMode = !adminMode;
      if (adminMode) { showConnBadge(); showClearBtn(); }
      else           { hideConnBadge(); hideClearBtn(); }
      e.preventDefault();
    }
  });

  // Prefab 自動送兔（不需 Admin）
  if (PREFAB_URLS.length) startPrefabSpawner();

  // R 鍵：即時送一隻 prefab
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') sendOnePrefab(); });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  rowDefs = buildRowDefs();
}

// ---------------- 行列定義 ----------------
function buildRowDefs() {
  const rows = [];
  for (let i = 0; i < ROW_COUNT; i++) {
    const t = i / Math.max(1, ROW_COUNT - 1);
    const y = lerp(FRONT_Y, BACK_Y, t);
    const dir = (i % 2 === 0) ? -1 : +1; // 偶數排右→左；奇數排左→右
    const scaleMul = Math.pow(ROW_SCALE_DECAY, i);
    const hopH  = HOP_HEIGHT_BASE * Math.pow(HOP_HEIGHT_DECAY, i);
    rows.push({ yNorm: y, dir, scaleMul, hopH });
  }
  return rows;
}

// ---------------- WebSocket handlers ----------------
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'sync_state': {
      rabbits = [];
      (msg.rabbits ?? []).forEach(spawnRandomRowFromServer); // 隨機分佈
      break;
    }
    case 'new_rabbit': {
      spawnFrontRowFromServer(msg.rabbit); // 前排入場
      break;
    }
    case 'clear_all': {
      rabbits = [];
      break;
    }
    case 'remove_rabbit': {
      rabbits = rabbits.filter(r => r.id !== msg.id);
      break;
    }
  }
}

// 前排入場（新兔）
function spawnFrontRowFromServer(data) {
  if (!data || !data.imgData) return;
  loadImage(data.imgData, (img) => {
    const base = makeRabbitFromImage(data, img);
    const rowIdx = 0, row = rowDefs[rowIdx];

    const dxPerHop  = FRONT_DX_PER_HOP * Math.pow(DX_DECAY_PER_ROW, rowIdx);
    const hopPeriod = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);

    const r = {
      ...base,
      rowIdx,
      yNorm: row.yNorm,
      dir: row.dir,
      xNorm: (row.dir === -1) ? 1.08 : -0.08,  // 由畫面外側進場
      scale: (data.scale ?? base.scale ?? 1) * GLOBAL_SCALE_MULT * row.scaleMul * random(0.5,1),

      // Hop-only 狀態
      state: 'forward',                         // 入場時先做向前跳
      hopsLeft: floor(random(10, 20)),
      stateUntil: null,                         // idle 專用
      hop: { t: random(0, hopPeriod), period: hopPeriod, heightRatio: row.hopH, x0: 0, x1: 0 },
      dxPerHop,

      // 耳仔 & 微抖
      ear: { active:false, t:0, dur:random(0.3,0.6), ampDeg: random(6,12), nextAt: millis()+random(2000,6000) },
      jitterSeed: random(1000)
    };

    // ★ 初始化首跳嘅 x0/x1（用當前 state 判斷 forward / inplace）
    r.hop.x0 = r.xNorm;
    r.hop.x1 = (r.state === 'forward') ? r.xNorm + r.dir * r.dxPerHop : r.xNorm;

    rabbits.push(r);
  }, (err) => console.warn('[zoo] load image fail:', err));
}

// 同步時：行列與 x 隨機分佈
function spawnRandomRowFromServer(data) {
  if (!data || !data.imgData) return;
  loadImage(data.imgData, (img) => {
    const base = makeRabbitFromImage(data, img);
    const rowIdx = floor(random(0, ROW_COUNT)), row = rowDefs[rowIdx];

    const dxPerHop  = FRONT_DX_PER_HOP * Math.pow(DX_DECAY_PER_ROW, rowIdx);
    const hopPeriod = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);

    const r = {
      ...base,
      rowIdx,
      yNorm: row.yNorm,
      dir: row.dir,
      xNorm: random(0.1, 0.9),
      scale: (data.scale ?? base.scale ?? 1) * GLOBAL_SCALE_MULT * row.scaleMul,

      state: random() < 0.6 ? 'forward' : 'inplace',
      hopsLeft: floor(random(1, 3)),
      stateUntil: millis() + random(IDLE_RANGE_S[0]*1000, IDLE_RANGE_S[1]*1000),
      hop: { t: random(0, hopPeriod), period: hopPeriod, heightRatio: row.hopH, x0: 0, x1: 0 },
      dxPerHop,

      ear: { active:false, t:0, dur:random(0.3,0.6), ampDeg: random(6,12), nextAt: millis()+random(2000,6000) },
      jitterSeed: random(1000)
    };

    r.hop.x0 = r.xNorm;
    r.hop.x1 = (r.state === 'forward') ? r.xNorm + r.dir * r.dxPerHop : r.xNorm;

    rabbits.push(r);
  }, (err) => console.warn('[zoo] load image fail:', err));
}

// 圖片切片 + 重疊帶&pivot + 你可微調 headRatio/pivot
function makeRabbitFromImage(data, img) {
  const headRatio = constrain(
    HEAD_RATIO_BASE + random(-HEAD_RATIO_JITTER, HEAD_RATIO_JITTER),
    0.25, 0.5
  );
  const headCutPx = max(1, floor(img.height * headRatio));
  const overlapPx = max(1, round(img.height * OVERLAP_RATIO));
  const bodyStart = max(0, headCutPx - overlapPx);

  const headImg = img.get(0, 0, img.width, min(img.height, headCutPx + overlapPx));
  const bodyImg = img.get(0, bodyStart, img.width, img.height - bodyStart);

  return {
    id: data.id,
    createdAt: data.createdAt || Date.now(),
    img, headImg, bodyImg,
    headCutPx, headOverlapPx: overlapPx,
    pivotOffsetPx: PIVOT_OFFSET_PX,
    scale: (data.scale ?? 1) // 保留 server 的 scale（避免 NaN）
  };
}

// ---------------- 主回圈 ----------------
function draw() {
  drawNightBackground();

  const dt = deltaTime / 1000;
  for (const r of rabbits) updateRabbitHopOnly(r, dt);

  // 後排先畫（由遠到近）
  rabbits.sort((a, b) => (b.rowIdx - a.rowIdx));
  for (const r of rabbits) drawRabbit(r);
}

// Hop-only FSM：'forward'（向前跳） / 'inplace'（原地跳） / 'idle'（停留）
// ★ 重點：hop 期間用 smoothstep 插值 x = lerp(x0, x1, s(p))，形成拋物線感
function updateRabbitHopOnly(r, dt) {
  const now = millis();

  // 耳仔偶發
  if (!r.ear.active && now >= r.ear.nextAt) {
    r.ear.active = true; r.ear.t = 0;
    r.ear.dur = random(0.3, 0.6);
    r.ear.ampDeg = random(6, 12);
    r.ear.nextAt = now + random(2000, 6000);
  } else if (r.ear.active) {
    r.ear.t += dt; if (r.ear.t >= r.ear.dur) { r.ear.active = false; r.ear.t = 0; }
  }

  // idle 計時完 → 回到跳躍（預備新 hop）
  if (r.state === 'idle' && now >= r.stateUntil) {
    r.state = (random() < 0.55) ? 'forward' : 'inplace';
    r.hopsLeft = floor(random(1, 3));
    r.hop.period = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);
    r.hop.t = 0;
    r.hop.x0 = r.xNorm;
    r.hop.x1 = (r.state === 'forward') ? r.xNorm + r.dir * r.dxPerHop : r.xNorm;
  }

  // 只有 forward / inplace 先會推進 hop
  if (r.state !== 'idle') {
    r.hop.t += dt;

    // ★ 同步前進：用 smoothstep 插值 x（forward）/ 固定 x（inplace）
    const p = constrain(r.hop.t / r.hop.period, 0, 1);
    const s = p * p * (3 - 2 * p); // smoothstep，水平速度前慢後快（視覺更自然）
    if (r.state === 'forward') r.xNorm = lerp(r.hop.x0, r.hop.x1, s);
    else                       r.xNorm = r.hop.x0;

    // 一次 hop 完成（落地）
    if (r.hop.t >= r.hop.period) {
      // 收尾：對齊 x 到目標點
      r.xNorm = r.hop.x1;
      r.hop.t -= r.hop.period;
      r.hopsLeft--;

      // 決定下一段狀態
      if (r.hopsLeft <= 0) {
        const prob = random();
        if (prob < P_IDLE_AFTER_HOP) {
          r.state = 'idle';
          r.stateUntil = now + random(IDLE_RANGE_S[0]*1000, IDLE_RANGE_S[1]*1000);
        } else if (prob < P_IDLE_AFTER_HOP + P_INPLACE_AFTER_HOP) {
          r.state = 'inplace';
          r.hopsLeft = floor(random(1, 3));
          r.hop.period = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);
          r.hop.t = 0;
          r.hop.x0 = r.xNorm;
          r.hop.x1 = r.xNorm; // 原地跳
        } else {
          r.state = 'forward';
          r.hopsLeft = floor(random(1, 3));
          r.hop.period = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);
          r.hop.t = 0;
          r.hop.x0 = r.xNorm;
          r.hop.x1 = r.xNorm + r.dir * r.dxPerHop;
        }
      } else {
        // 同一段未完，接下一跳（延續同一狀態）
        r.hop.period = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);
        r.hop.t = 0;
        r.hop.x0 = r.xNorm;
        r.hop.x1 = (r.state === 'forward') ? r.xNorm + r.dir * r.dxPerHop : r.xNorm;
      }
    }
  }

  // 出界 → 進上一排或刪除（在 hop 完成後觸發更自然）
  const offL = r.xNorm < -0.12, offR = r.xNorm > 1.12;
  if ((r.dir === -1 && offL) || (r.dir === +1 && offR)) {
    const nextRow = r.rowIdx + 1;
    if (nextRow >= ROW_COUNT) {
      if (WS) WS.send({ type: 'remove_rabbit', id: r.id });
      rabbits = rabbits.filter(x => x.id !== r.id);
      return;
    }
    const def = rowDefs[nextRow];
    r.rowIdx = nextRow;
    r.yNorm = def.yNorm;
    r.dir   = def.dir;
    r.hop.heightRatio = def.hopH;
    r.scale *= ROW_SCALE_DECAY;
    r.xNorm = (r.dir === -1) ? 1.08 : -0.08;

    // 新一排嘅 forward hop 位移（更細）
    r.dxPerHop = FRONT_DX_PER_HOP * Math.pow(DX_DECAY_PER_ROW, r.rowIdx);

    // 升排之後多數繼續 forward
    r.state = (random() < 0.7) ? 'forward' : 'inplace';
    r.hopsLeft = floor(random(1, 3));
    r.hop.period = random(HOP_PERIOD_RANGE[0], HOP_PERIOD_RANGE[1]);
    r.hop.t = 0;
    r.hop.x0 = r.xNorm;
    r.hop.x1 = (r.state === 'forward') ? r.xNorm + r.dir * r.dxPerHop : r.xNorm;
  }
}

// ---------------- 繪製（含方向 flip + 接縫重疊 & pivot 可調）----------------
function drawRabbit(r) {
  if (!isFinite(r.scale) || !isFinite(r.xNorm) || !isFinite(r.yNorm)) return;

  const baseX = r.xNorm * width;
  const baseY = r.yNorm * height;
  const s = r.scale;
  const drawW = r.img.width  * s;
  const drawH = r.img.height * s;

  const jx = (noise(r.jitterSeed + frameCount * 0.003) - 0.5) * 1.0;
  const jy = (noise(1000 + r.jitterSeed + frameCount * 0.003) - 0.5) * 0.6;

  // 垂直跳躍位移（正弦）
  const p = constrain(r.hop.t / r.hop.period, 0, 1);
  const hopY = - (Math.sin(Math.PI * p) * (r.hop.heightRatio * drawH));

  // 耳仔擺動（若 active）
  let earAngleRad = 0;
  if (r.ear?.active) {
    const q = constrain(r.ear.t / r.ear.dur, 0, 1);
    earAngleRad = radians(r.ear.ampDeg) * Math.sin(TWO_PI * q) * Math.exp(-3 * q);
  }

  // 影子
  noStroke(); fill(50, 60);
  ellipse(baseX + jx, baseY + jy + 6, drawW * 0.5, drawH * 0.10);

  // 根據方向水平翻轉（以 baseX 為鏡像軸）
  push();
  if (r.dir === +1) { translate(baseX, 0); scale(-1, 1); translate(-baseX, 0); }

  const topLeftX = baseX + jx - drawW / 2;
  const topLeftY = baseY + jy - drawH;

  // 身體
  const bodyStartPx = r.headCutPx - r.headOverlapPx;
  const bodyTopY = topLeftY + bodyStartPx * s + hopY;
  const bodyDrawH = r.bodyImg.height * s;
  imageMode(CORNER);
  image(r.bodyImg, topLeftX, bodyTopY, drawW, bodyDrawH);

  // 頭/耳（pivot 在接縫 + 你可用 PIVOT_OFFSET_PX 微調）
  const seamY = topLeftY + (r.headCutPx + (r.pivotOffsetPx ?? 0)) * s + hopY;
  push();
  translate(topLeftX + drawW / 2, seamY);
  rotate(earAngleRad);
  const headTopLeftX = -drawW / 2;
  const headTopLeftY = -(r.headImg.height - r.headOverlapPx) * s;
  image(r.headImg, headTopLeftX, headTopLeftY, drawW, r.headImg.height * s);
  pop();

  pop();
}

// ---------------- 夜景背景（帶月亮輕微脈動）----------------
function drawNightBackground() {
  background(0);

  tMoon += deltaTime / 1000;
  const cx = width / 2;
  const cy = height * MOON_Y_NORM;

  // 緩慢脈動（sin + noise）
  const pulse = 1 + 0.03 * sin(tMoon * 0.8) + 0.02 * (noise(tMoon * 0.2) - 0.5) * 2;

  noStroke();
  for (let i = MOON_GLOW_LAY; i >= 1; i--) {
    const t = i / MOON_GLOW_LAY;
    const r = MOON_RADIUS * (1 + t * 2.6) * pulse;
    const alpha = 18 * t * t * (0.85 + 0.15 * sin(tMoon * 0.6 + i));
    fill(255, 255, 220, alpha);
    ellipse(cx, cy, r * 2, r * 2);
  }
  fill(255, 250, 210);
  ellipse(cx, cy, (MOON_RADIUS * pulse) * 2, (MOON_RADIUS * pulse) * 2);
}

// ---------------- Admin：點擊刪除（僅 Admin） & Clear All ----------------
function mousePressed() {
  if (!adminMode || !WS) return;
  // 前景優先（近→遠）
  const sorted = [...rabbits].sort((a, b) => a.rowIdx - b.rowIdx);
  for (const r of sorted) {
    const s = r.scale;
    const drawW = r.img.width * s;
    const drawH = r.img.height * s;
    const baseX = r.xNorm * width;
    const baseY = r.yNorm * height;
    const topLeftX = baseX - drawW / 2;
    const topLeftY = baseY - drawH;
    if (mouseX >= topLeftX && mouseX <= topLeftX + drawW &&
        mouseY >= topLeftY && mouseY <= topLeftY + drawH) {
      WS.send({ type: 'remove_rabbit', id: r.id });
      break;
    }
  }
}

function mountClearButton() {
  _btnClear = document.createElement('button');
  _btnClear.textContent = 'Clear All';
  _btnClear.style.cssText = `
    position: fixed; top: 10px; left: 10px; z-index: 9999;
    padding: 6px 10px; border-radius: 8px; border: 1px solid #444;
    background: #1d1f24; color: #fff; font: 12px system-ui; cursor: pointer;
  `;
  _btnClear.onclick = () => { WS && WS.send({ type: 'clear_all' }); };
  document.body.appendChild(_btnClear);
}
function showClearBtn() { if (_btnClear) _btnClear.style.display = 'block'; }
function hideClearBtn() { if (_btnClear) _btnClear.style.display = 'none'; }

// ---------------- Prefab：自動送兔（不需 Admin） + R 鍵即時送 ----------------
function startPrefabSpawner() {
  if (_prefabTimer) clearInterval(_prefabTimer);
  sendOnePrefab(); // 開場先來一隻
  _prefabTimer = setInterval(sendOnePrefab, PREFAB_INTERVAL_MS);
}
function sendOnePrefab() {
  if (!PREFAB_URLS.length) { console.warn('[zoo] PREFAB_URLS 未設定'); return; }
  const url = random(PREFAB_URLS);
  loadImage(url, (img) => {
    // 最長邊 512 下采樣（與 Draw 端一致）
    const maxDim = 512;
    let w = img.width, h = img.height;
    if (Math.max(w, h) > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.max(1, round(w * s));
      h = Math.max(1, round(h * s));
    }
    const g = createGraphics(w, h); g.pixelDensity(1); g.clear();
    g.image(img, 0, 0, w, h);
    const imgData = g.elt.toDataURL('image/png');
    WS && WS.send({ type: 'add_rabbit', imgData, w, h });
  }, () => console.warn('[zoo] failed prefab:', url));
}

// ============================
// Connection badge（Admin 才顯示） + WS manager
// ============================
function mountConnectionBadge(){
  _connBadge = document.createElement('div');
  _connBadge.style.cssText = `
    position: fixed; top:10px; right:10px; z-index:9999;
    display:inline-flex; align-items:center; gap:8px;
    padding:6px 10px; background: rgba(255,255,255,0.85);
    border-radius:999px; color:#111; font:12px/1.2 system-ui, sans-serif;
    box-shadow:0 6px 20px rgba(0,0,0,0.12); backdrop-filter: blur(4px);
  `;
  const dot = document.createElement('span'); dot.id='connDot';
  dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:#aaa;box-shadow:0 0 8px rgba(0,0,0,0.2);`;
  const text = document.createElement('span'); text.id='connText'; text.textContent='Connecting…';
  _connBadge.appendChild(dot); _connBadge.appendChild(text); document.body.appendChild(_connBadge);
}
function updateConnectionBadge(state){
  if (!_connBadge) return;
  const dot=_connBadge.querySelector('#connDot'); const text=_connBadge.querySelector('#connText');
  switch(state){
    case 'open': dot.style.background='#2ecc71'; text.textContent='Connected'; break;
    case 'reconnecting': dot.style.background='#f39c12'; text.textContent='Reconnecting…'; break;
    case 'connecting': dot.style.background='#95a5a6'; text.textContent='Connecting…'; break;
    default: dot.style.background='#7f8c8d'; text.textContent='Disconnected';
  }
}
function showConnBadge() { if (_connBadge) _connBadge.style.display = 'inline-flex'; }
function hideConnBadge() { if (_connBadge) _connBadge.style.display = 'none'; }

function createWSManager({ role = 'client', onMessage, onStateChange } = {}) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}`;
  let ws = null, reconnectAttempts = 0, reconnectTimer = null, keepAliveTimer = null;
  let state = 'disconnected';

  function setState(next){ state = next; if (typeof onStateChange === 'function') onStateChange(state); }
  function backoffDelay(){ return Math.min(8000, Math.round(800 * Math.pow(1.7, reconnectAttempts))); }

  function connect(){
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

    function scheduleReconnect(){
      if (state === 'reconnecting') return;
      setState('reconnecting');
      const delay = backoffDelay();
      reconnectAttempts++;
      reconnectTimer = setTimeout(connect, delay);
    }
    instance.addEventListener('close', () => { clearInterval(keepAliveTimer); keepAliveTimer = null; scheduleReconnect(); });
    instance.addEventListener('error', () => { try { instance.close(); } catch {} });
  }
  function send(obj){ if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } console.warn('[ws] not open'); return false; }
  function isOpen(){ return ws && ws.readyState === 1; }
  function getState(){ return state; }

  connect(); return { send, isOpen, getState };
}

// ---------------- 小工具 ----------------
function rand([a,b])   { return random(a, b); }
function randMs([a,b]) { return random(a*1000, b*1000); }
