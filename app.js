import { KomaStorage } from './koma-storage.js';

const $ = (id) => document.getElementById(id);
const storage = new KomaStorage();
const RATIOS = { '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '1:1': [1, 1] };

// ===== State =====
let stream = null, facingMode = 'environment', wakeLock = null;
let selectedRatio = '16:9', W = 854, H = 480;
let isRecording = false, isPaused = false, isCapturing = false;
let elapsedMs = 0, lastTick = 0, nextShotTime = 0, worker = null;

let frames = [], currentIdx = 0, isPlaying = false, playRaf = null, lastPlayStep = 0, playTimeMs = 0;
let renderSeq = 0;
let isDragging = false, dragTargetExclude = true, prevDiffData = null;

// Overlay GIF / Stamp & Edit State (プレビューとMP4出力で完全共有)
let overlayGifFrames = [], overlayStaticImg = null, overlayTotalMs = 0;
const editState = {
  gifPos: 'br',      // br | bl | tr | tl
  gifSizePct: 18,    // 画面幅に対する%
  gifOpacity: 1.0,
  gifMarginPct: 3,
  stampPreset: 'none', // none | study | focus | rec
  brightness: 100,
  contrast: 100,
  saturate: 100,
  sepia: 0,
  rotateDeg: 0,
  flipH: false,
  showTimer: false,
  watermark: ''
};

// ===== Canvases & PiP =====
const makeCanvas = (w = 0, h = 0, opt) => {
  const c = document.createElement('canvas');
  if (w) c.width = w;
  if (h) c.height = h;
  return [c, c.getContext('2d', opt)];
};
const [capCanvas, capCtx] = makeCanvas();
const [thumbCanvas, thumbCtx] = makeCanvas();
const [diffCanvas, diffCtx] = makeCanvas(64, 36, { willReadFrequently: true });
const [pipCanvas, pipCtx] = makeCanvas(480, 270);
const pipVideo = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
let pipTimer = null;

const editorCanvas = $('editorCanvas');
const editorCtx = editorCanvas.getContext('2d');

// ===== Helpers =====
const setBadge = (cls, text) => {
  $('badge').className = 'badge ' + cls;
  $('badgeText').textContent = text;
};

const formatTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
};

function revokeFrameUrls() {
  for (const f of frames) {
    if (f.thumbUrl) URL.revokeObjectURL(f.thumbUrl);
  }
}

function getFps() {
  return Number($('exportFpsSelect')?.value || $('fpsSelect').value || 15);
}

function updateStats() {
  const fps = getFps();
  $('frameCount').innerHTML = `${frames.length}<span>枚</span>`;
  $('elapsed').textContent = formatTime(elapsedMs);
  $('estDuration').innerHTML = `${(frames.length / fps).toFixed(1)}<span>秒</span>`;
  $('psStats').textContent = `${frames.length}枚 ・ ${formatTime(elapsedMs)}`;
}

// ===== UI: Sidebar, Tabs, Theme =====
$('sidebarToggleBtn').onclick = () => $('appShell').classList.toggle('sidebar-collapsed');

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'edit') renderEditor();
  else stopPreview();
}
document.querySelectorAll('.nav-item').forEach(el => el.onclick = () => switchTab(el.dataset.tab));
$('openBlueprintBtn').onclick = () => switchTab('blueprint');
$('blueprintGoRecordBtn').onclick = () => switchTab('record');

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').textContent = t === 'light' ? '☀️ ライト' : '🌙 ダーク';
  localStorage.setItem('komaclip_theme', t);
}
applyTheme(localStorage.getItem('komaclip_theme') || 'light');
$('themeBtn').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');

// ===== Ratio, Dimensions & PiP Sync =====
function calcOutputSize() {
  const base = Number($('resSelect').value);
  const [rw, rh] = RATIOS[selectedRatio] || [16, 9];
  W = Math.max(2, (rw >= rh ? base : Math.round(base * (rw / rh))) & ~1);
  H = Math.max(2, (rw >= rh ? Math.round(base * (rh / rw)) : base) & ~1);

  capCanvas.width = W;
  capCanvas.height = H;
  thumbCanvas.width = 160;
  thumbCanvas.height = Math.max(40, Math.round(160 * (H / W)));

  document.documentElement.style.setProperty('--stage-ar', String(rw / rh));

  const scale = 480 / Math.max(W, H);
  pipCanvas.width = Math.max(2, Math.round(W * scale) & ~1);
  pipCanvas.height = Math.max(2, Math.round(H * scale) & ~1);
  if (document.pictureInPictureElement === pipVideo) refreshPipStream();
}

function setRatio(ratio) {
  selectedRatio = RATIOS[ratio] ? ratio : '16:9';
  $('ratioGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b.dataset.ratio === selectedRatio));
  calcOutputSize();
  renderGuide();
}

$('resSelect').onchange = () => {
  if (isRecording) return;
  calcOutputSize();
  $('hint').textContent = `出力解像度を ${W}×${H} (${selectedRatio}) に変更しました`;
};

$('fpsSelect').onchange = () => {
  $('exportFpsSelect').value = $('fpsSelect').value;
  updateStats();
  updateEditorStats();
};
$('exportFpsSelect').onchange = () => {
  $('fpsSelect').value = $('exportFpsSelect').value;
  updateStats();
  updateEditorStats();
};

$('ratioGroup').addEventListener('click', async (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn || isRecording) return;
  setRatio(btn.dataset.ratio);
  if (document.pictureInPictureElement === pipVideo) {
    try {
      await document.exitPictureInPicture();
      await refreshPipStream();
      await pipVideo.requestPictureInPicture();
    } catch {}
  }
});

// ===== Guides =====
const GUIDE_SVGS = {
  study: ['ノート・手元ガイド', `<rect x="260" y="160" width="1080" height="580" rx="18" fill="none" stroke="rgba(56,189,248,0.75)" stroke-width="3" stroke-dasharray="14 10"/><line x1="775" y1="450" x2="825" y2="450" stroke="#38bdf8" stroke-width="2.5"/><line x1="800" y1="425" x2="800" y2="475" stroke="#38bdf8" stroke-width="2.5"/>`],
  thirds: ['三分割グリッド', `<line x1="533" y1="0" x2="533" y2="900" stroke="rgba(255,255,255,0.45)" stroke-width="2"/><line x1="1066" y1="0" x2="1066" y2="900" stroke="rgba(255,255,255,0.45)" stroke-width="2"/><line x1="0" y1="300" x2="1600" y2="300" stroke="rgba(255,255,255,0.45)" stroke-width="2"/><line x1="0" y1="600" x2="1600" y2="600" stroke="rgba(255,255,255,0.45)" stroke-width="2"/>`],
  horizon: ['水平・中心線', `<line x1="0" y1="450" x2="1600" y2="450" stroke="rgba(56,189,248,0.75)" stroke-width="2.5"/><line x1="800" y1="0" x2="800" y2="900" stroke="rgba(255,255,255,0.4)" stroke-width="2" stroke-dasharray="10 10"/>`]
};
function renderGuide() {
  const g = GUIDE_SVGS[$('guideSelect').value];
  $('guideLabel').textContent = `▶ ${g ? g[0] : 'ガイドなし'} (${selectedRatio})`;
  $('guideLayer').innerHTML = g ? `<svg viewBox="0 0 1600 900" preserveAspectRatio="none">${g[1]}</svg>` : '';
}
$('guideSelect').onchange = renderGuide;
$('toggleGuideBtn').onclick = () => {
  $('guideSelect').value = $('guideSelect').value === 'off' ? 'study' : 'off';
  renderGuide();
};
calcOutputSize();
renderGuide();

// ===== Camera Connect =====
async function connectCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setBadge('', '未対応');
    $('hint').textContent = 'このブラウザまたは非HTTPS環境ではカメラAPIを利用できません（HTTPS または localhost で開いてください）';
    return;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    await new Promise(r => setTimeout(r, 150));
  }
  calcOutputSize();
  $('hint').textContent = 'カメラへ接続中...';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false
    });
    const preview = $('preview');
    preview.srcObject = stream;
    await preview.play();
    const { width = 0, height = 0 } = stream.getVideoTracks()[0]?.getSettings() || {};
    $('placeholder').style.display = 'none';
    $('startBtn').disabled = $('switchCamBtn').disabled = $('pipBtn').disabled = false;
    setBadge('', '接続済み');
    $('hint').textContent = `接続完了（入力 ${width}×${height} → 出力 ${W}×${H} / ${selectedRatio}）`;
  } catch (e) {
    setBadge('', 'エラー');
    $('hint').textContent = 'カメラ接続失敗: ' + e.message;
  }
}
$('connectCamBtn').onclick = $('heroCamBtn').onclick = connectCamera;
$('switchCamBtn').onclick = () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  connectCamera();
};

// ===== PiP & Power Save =====
function drawCroppedTo(ctx, dstW, dstH) {
  const v = $('preview'), vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return;
  const srcR = vw / vh, dstR = dstW / dstH;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcR > dstR) { sw = vh * dstR; sx = (vw - sw) / 2; }
  else { sh = vw / dstR; sy = (vh - sh) / 2; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dstW, dstH);
}

async function refreshPipStream() {
  drawCroppedTo(pipCtx, pipCanvas.width, pipCanvas.height);
  if (pipVideo.srcObject) pipVideo.srcObject.getTracks().forEach(t => t.stop());
  pipVideo.srcObject = pipCanvas.captureStream(15);
  await pipVideo.play();
}

function stopPip() {
  clearInterval(pipTimer);
  pipTimer = null;
  if (pipVideo.srcObject) {
    pipVideo.srcObject.getTracks().forEach(t => t.stop());
    pipVideo.srcObject = null;
  }
}
pipVideo.addEventListener('leavepictureinpicture', stopPip);

$('pipBtn').onclick = async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      stopPip();
    } else if (stream) {
      calcOutputSize();
      await refreshPipStream();
      clearInterval(pipTimer);
      pipTimer = setInterval(() => {
        if (stream) drawCroppedTo(pipCtx, pipCanvas.width, pipCanvas.height);
      }, 1000 / 15);
      await pipVideo.requestPictureInPicture();
    }
  } catch (e) {
    $('hint').textContent = 'PiP未対応または許可されていません: ' + e.message;
  }
};
$('powerSaveBtn').onclick = () => $('powerSaveOverlay').classList.add('active');
$('psExitBtn').onclick = $('powerSaveOverlay').ondblclick = () => $('powerSaveOverlay').classList.remove('active');

// ===== Worker Timer & Capture =====
let workerUrl = null;
function stopWorkerTimer() {
  if (worker) { worker.terminate(); worker = null; }
  if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
}

function startWorkerTimer() {
  stopWorkerTimer();
  workerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), 200);`], { type: 'application/javascript' }));
  worker = new Worker(workerUrl);
  worker.onmessage = async () => {
    if (!isRecording || isPaused) return;
    const now = Date.now();
    elapsedMs += now - lastTick;
    lastTick = now;
    updateStats();

    const interval = Number($('intervalSelect').value);
    const remain = Math.max(0, nextShotTime - now);
    $('nextShotBar').style.width = Math.min(100, ((interval - remain) / interval) * 100) + '%';
    if (now >= nextShotTime && !isCapturing) {
      nextShotTime = now + interval;
      await captureFrame();
    }
  };
}

function calcMotion() {
  drawCroppedTo(diffCtx, 64, 36);
  const cur = diffCtx.getImageData(0, 0, 64, 36).data;
  if (!prevDiffData) { prevDiffData = new Uint8ClampedArray(cur); return 100; }
  let sum = 0;
  for (let i = 0; i < cur.length; i += 4) {
    sum += Math.abs(cur[i] - prevDiffData[i]) + Math.abs(cur[i + 1] - prevDiffData[i + 1]) + Math.abs(cur[i + 2] - prevDiffData[i + 2]);
  }
  prevDiffData.set(cur);
  return sum / (64 * 36 * 3);
}

async function captureFrame() {
  if (!stream || isCapturing) return;
  isCapturing = true;
  try {
    const motion = calcMotion();
    drawCroppedTo(capCtx, W, H);
    drawCroppedTo(thumbCtx, thumbCanvas.width, thumbCanvas.height);

    const [blob, thumbBlob] = await Promise.all([
      new Promise(r => capCanvas.toBlob(r, 'image/jpeg', 0.92)),
      new Promise(r => thumbCanvas.toBlob(r, 'image/jpeg', 0.7))
    ]);
    if (!blob) return;

    const frameElapsed = elapsedMs;
    let id = null;
    try {
      id = await storage.addFrame({ blob, thumbBlob: thumbBlob || blob, motion, elapsedMs: frameElapsed, excluded: false });
      await storage.saveMeta({ W, H, selectedRatio, elapsedMs: frameElapsed });
      $('dbStatus').textContent = `保存済 (${frames.length + 1})`;
    } catch {
      $('dbStatus').textContent = 'メモリのみ';
    }

    frames.push({
      id,
      blob,
      thumbUrl: URL.createObjectURL(thumbBlob || blob),
      motion,
      elapsedMs: frameElapsed,
      excluded: false
    });
    updateStats();
    if (frames.length >= 2) $('finishBtn').disabled = false;

    if (!$('powerSaveOverlay').classList.contains('active')) {
      const fl = $('flash');
      fl.classList.remove('fire');
      void fl.offsetWidth;
      fl.classList.add('fire');
    }
  } finally {
    isCapturing = false;
  }
}

// ===== Recording Controls & Demo =====
$('startBtn').onclick = async () => {
  if (!stream) return;
  try { await storage.clearAll(); } catch {}
  revokeFrameUrls();
  calcOutputSize();
  try { await storage.saveMeta({ W, H, selectedRatio, elapsedMs: 0 }); } catch {}

  frames = [];
  prevDiffData = null;
  elapsedMs = 0;
  isRecording = true;
  isPaused = false;
  lastTick = Date.now();
  nextShotTime = lastTick + Number($('intervalSelect').value);

  $('startBtn').disabled = $('finishBtn').disabled = $('resSelect').disabled = true;
  $('pauseBtn').disabled = false;
  setBadge('recording', '録画中');
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  await captureFrame();
  startWorkerTimer();
};

$('pauseBtn').onclick = () => {
  if (!isRecording) return;
  isPaused = !isPaused;
  $('pauseBtn').textContent = isPaused ? '▶ 再開' : '⏸ 一時停止';
  setBadge(isPaused ? 'paused' : 'recording', isPaused ? '一時停止' : '録画中');
  if (!isPaused) {
    lastTick = Date.now();
    nextShotTime = lastTick + Number($('intervalSelect').value);
  }
};

$('finishBtn').onclick = () => {
  isRecording = isPaused = false;
  stopWorkerTimer();
  $('nextShotBar').style.width = '0%';
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('startBtn').disabled = $('resSelect').disabled = false;
  $('pauseBtn').disabled = true;
  $('pauseBtn').textContent = '⏸ 一時停止';
  setBadge('done', '編集モード');
  switchTab('edit');
};

async function loadDemoFrames() {
  stopPreview();
  calcOutputSize();
  try { await storage.clearAll(); } catch {}
  revokeFrameUrls();
  frames = [];
  const [c, ctx] = makeCanvas(W, H);
  for (let i = 0; i < 30; i++) {
    const isStill = i >= 11 && i <= 15;
    // 机・ノート風の勉強デモ画を描画
    ctx.fillStyle = '#1e2436';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = isStill ? '#3b2d1b' : '#2a3554';
    ctx.fillRect(W * 0.08, H * 0.08, W * 0.84, H * 0.84);

    // ノート
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(W * 0.2, H * 0.18, W * 0.6, H * 0.64);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    for (let line = 1; line <= 6; line++) {
      const ly = H * 0.18 + (H * 0.64 / 7) * line;
      ctx.beginPath();
      ctx.moveTo(W * 0.23, ly);
      ctx.lineTo(W * 0.77, ly);
      ctx.stroke();
    }
    // 進捗バー的なメモ線
    ctx.fillStyle = isStill ? '#f59e0b' : '#4f6ef7';
    const prog = Math.min(1, (i + 1) / 30);
    ctx.fillRect(W * 0.23, H * 0.25, W * 0.54 * prog, H * 0.05);

    ctx.fillStyle = '#1e293b';
    ctx.font = `bold ${Math.round(Math.min(W, H) * 0.07)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(isStill ? `離席中 #${i + 1}` : `勉強中 #${i + 1}`, W / 2, H * 0.56);

    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    const motion = isStill ? 1.2 : 18.0;
    const frameElapsed = i * 10000;
    let id = null;
    try {
      id = await storage.addFrame({ blob, thumbBlob: blob, motion, elapsedMs: frameElapsed, excluded: false });
    } catch {}
    frames.push({ id, blob, thumbUrl: URL.createObjectURL(blob), motion, elapsedMs: frameElapsed, excluded: false });
  }
  elapsedMs = 30 * 10000;
  try { await storage.saveMeta({ W, H, selectedRatio, elapsedMs }); } catch {}
  updateStats();
  setBadge('done', 'デモ読込済');
  switchTab('edit');
}
$('demoBtn').onclick = $('editDemoBtn').onclick = loadDemoFrames;

// ===== Composite Renderer (プレビュー・MP4出力で完全共通) =====
function buildFilterString() {
  const parts = [
    `brightness(${editState.brightness}%)`,
    `contrast(${editState.contrast}%)`,
    `saturate(${editState.saturate}%)`
  ];
  if (editState.sepia > 0) parts.push(`sepia(${editState.sepia}%)`);
  return parts.join(' ');
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawBuiltInStamp(ctx, cw, ch, timeMs) {
  if (editState.stampPreset === 'none') return;
  const labels = {
    study: { text: '🔥 勉強中', bg: 'rgba(79, 110, 247, 0.88)' },
    focus: { text: '✨ 集中モード', bg: 'rgba(16, 185, 129, 0.88)' },
    rec: { text: '● STUDY REC', bg: 'rgba(239, 68, 68, 0.88)' }
  };
  const cfg = labels[editState.stampPreset];
  if (!cfg) return;

  const pulse = 1 + Math.sin(timeMs / 240) * 0.04;
  const dw = Math.round(cw * (editState.gifSizePct / 100) * 1.15);
  const dh = Math.round(dw * 0.36);
  const padX = Math.round(cw * (editState.gifMarginPct / 100));
  const padY = Math.round(ch * (editState.gifMarginPct / 100));

  let x = cw - dw - padX, y = ch - dh - padY;
  if (editState.gifPos === 'bl') { x = padX; y = ch - dh - padY; }
  else if (editState.gifPos === 'tr') { x = cw - dw - padX; y = padY; }
  else if (editState.gifPos === 'tl') { x = padX; y = padY; }

  ctx.save();
  ctx.globalAlpha = editState.gifOpacity;
  ctx.translate(x + dw / 2, y + dh / 2);
  ctx.scale(pulse, pulse);
  drawRoundedRect(ctx, -dw / 2, -dh / 2, dw, dh, dh / 2);
  ctx.fillStyle = cfg.bg;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.max(12, Math.round(dh * 0.44))}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.text, 0, 1);
  ctx.restore();
}

function drawCornerOverlay(ctx, cw, ch, timeMs) {
  // ユーザーアップロードGIF優先、なければ内蔵スタンプ
  let img = overlayStaticImg;
  if (overlayGifFrames.length && overlayTotalMs > 0) {
    let t = ((timeMs % overlayTotalMs) + overlayTotalMs) % overlayTotalMs;
    img = overlayGifFrames.find(f => (t -= f.durationMs) <= 0)?.bitmap || overlayGifFrames[0].bitmap;
  }
  if (!img) {
    drawBuiltInStamp(ctx, cw, ch, timeMs);
    return;
  }

  const dw = Math.round(cw * (editState.gifSizePct / 100));
  const dh = Math.max(2, Math.round(dw * (img.height / img.width)));
  const padX = Math.round(cw * (editState.gifMarginPct / 100));
  const padY = Math.round(ch * (editState.gifMarginPct / 100));

  let x = cw - dw - padX, y = ch - dh - padY;
  if (editState.gifPos === 'bl') { x = padX; y = ch - dh - padY; }
  else if (editState.gifPos === 'tr') { x = cw - dw - padX; y = padY; }
  else if (editState.gifPos === 'tl') { x = padX; y = padY; }

  ctx.save();
  ctx.globalAlpha = editState.gifOpacity;
  drawRoundedRect(ctx, x, y, dw, dh, Math.round(dw * 0.08));
  ctx.clip();
  ctx.drawImage(img, x, y, dw, dh);
  ctx.restore();
}

function drawTextAndTimer(ctx, cw, ch, frameElapsedMs) {
  const pad = Math.round(cw * 0.025);
  const fontSize = Math.max(14, Math.round(Math.min(cw, ch) * 0.042));

  if (editState.showTimer) {
    const label = `⏱ ${formatTime(frameElapsedMs)}`;
    ctx.save();
    ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const tw = ctx.measureText(label).width;
    const boxW = tw + fontSize * 1.1;
    const boxH = fontSize * 1.65;
    drawRoundedRect(ctx, pad, pad, boxW, boxH, boxH / 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad + fontSize * 0.55, pad + boxH / 2 + 1);
    ctx.restore();
  }

  const wm = editState.watermark.trim();
  if (wm) {
    ctx.save();
    ctx.font = `700 ${Math.round(fontSize * 0.88)}px -apple-system, BlinkMacSystemFont, "Noto Sans JP", sans-serif`;
    const tw = ctx.measureText(wm).width;
    const boxW = tw + fontSize * 1.0;
    const boxH = fontSize * 1.5;
    const y = ch - boxH - pad;
    drawRoundedRect(ctx, pad, y, boxW, boxH, 10);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(wm, pad + fontSize * 0.5, y + boxH / 2 + 1);
    ctx.restore();
  }
}

function drawCompositeFrame(ctx, bmp, cw, ch, timeMs, frameElapsedMs) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  ctx.filter = buildFilterString();
  ctx.translate(cw / 2, ch / 2);
  if (editState.flipH) ctx.scale(-1, 1);
  if (editState.rotateDeg) ctx.rotate((editState.rotateDeg * Math.PI) / 180);

  // 90°/270°回転時はアスペクトを保って枠に収める
  if (editState.rotateDeg % 180 !== 0) {
    const scale = Math.min(cw / ch, ch / cw);
    ctx.drawImage(bmp, -(cw * scale) / 2, -(ch * scale) / 2, cw * scale, ch * scale);
  } else {
    ctx.drawImage(bmp, -cw / 2, -ch / 2, cw, ch);
  }
  ctx.restore();

  drawTextAndTimer(ctx, cw, ch, frameElapsedMs);
  drawCornerOverlay(ctx, cw, ch, timeMs);
}

// ===== Editor =====
const getActiveIndices = () => frames.map((f, i) => f.excluded ? -1 : i).filter(i => i >= 0);

function renderEditor() {
  editorCanvas.width = W;
  editorCanvas.height = H;
  const grid = $('gridWrap');
  grid.innerHTML = '';

  const hasFrames = frames.length > 0;
  $('editEmptyState').classList.toggle('hidden', hasFrames);
  if (!hasFrames) {
    editorCtx.clearRect(0, 0, W, H);
    $('currentFrameInfo').textContent = '#0 / 0';
    $('editorStats').textContent = 'フレームがありません（録画するかデモを読込んでください）';
    $('stillCountLabel').textContent = '0枚';
    return;
  }

  const frag = document.createDocumentFragment();
  frames.forEach((f, idx) => {
    const el = document.createElement('div');
    el.className = 'grid-item' + (f.excluded ? ' excluded' : '');
    el.dataset.idx = idx;
    el.innerHTML = `<img src="${f.thumbUrl}" alt=""><span class="num">#${idx + 1}</span>`;
    frag.appendChild(el);
  });
  grid.appendChild(frag);
  updateStillHighlight();
  showFrame(Math.min(currentIdx, frames.length - 1));
  updateEditorStats();
}

function applyExclude(idx, state) {
  if (!frames[idx] || frames[idx].excluded === state) return;
  frames[idx].excluded = state;
  $('gridWrap').children[idx]?.classList.toggle('excluded', state);
  if (frames[idx].id != null) {
    storage.setExcluded(frames[idx].id, state).catch(() => {});
  }
  updateEditorStats();
}

// Sub-tabs inside Editor
$('editToolTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.subtab-btn');
  if (!btn) return;
  $('editToolTabs').querySelectorAll('.subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.toggle('active', p.id === `tool-${btn.dataset.tool}`));
});

$('gridSizeGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn) return;
  $('gridSizeGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  $('gridWrap').classList.remove('size-sm', 'size-md', 'size-lg');
  $('gridWrap').classList.add('size-' + btn.dataset.size);
});
$('touchDragCheck').onchange = () => $('gridWrap').classList.toggle('drag-touch', $('touchDragCheck').checked);

$('gridWrap').addEventListener('pointerdown', (e) => {
  const item = e.target.closest('.grid-item');
  if (!item) return;
  const idx = Number(item.dataset.idx);
  if (e.pointerType === 'touch' && !$('touchDragCheck').checked) {
    stopPreview(); showFrame(idx); applyExclude(idx, !frames[idx].excluded);
    return;
  }
  e.preventDefault();
  stopPreview();
  isDragging = true;
  dragTargetExclude = !frames[idx].excluded;
  showFrame(idx);
  applyExclude(idx, dragTargetExclude);
});
window.addEventListener('pointermove', (e) => {
  if (!isDragging) return;
  const item = document.elementFromPoint(e.clientX, e.clientY)?.closest('.grid-item');
  if (item) {
    const idx = Number(item.dataset.idx);
    showFrame(idx);
    applyExclude(idx, dragTargetExclude);
  }
});
window.addEventListener('pointerup', () => { isDragging = false; });

$('cutBeforeBtn').onclick = () => { for (let i = 0; i < currentIdx; i++) applyExclude(i, true); };
$('cutAfterBtn').onclick = () => { for (let i = currentIdx + 1; i < frames.length; i++) applyExclude(i, true); };
$('thinFramesBtn').onclick = () => {
  const active = getActiveIndices();
  if (active.length < 4) return;
  active.forEach((frameIdx, order) => {
    if (order % 2 === 1) applyExclude(frameIdx, true);
  });
};

function updateStillHighlight() {
  const th = Number($('stillThreshold').value);
  let cnt = 0;
  frames.forEach((f, i) => {
    const isStill = f.motion < th;
    if (isStill) cnt++;
    $('gridWrap').children[i]?.classList.toggle('still', isStill);
  });
  $('stillCountLabel').textContent = `${cnt}枚`;
}
$('stillThreshold').oninput = updateStillHighlight;
$('excludeStillBtn').onclick = () => {
  const th = Number($('stillThreshold').value);
  frames.forEach((f, i) => { if (f.motion < th) applyExclude(i, true); });
};
$('restoreAllBtn').onclick = () => frames.forEach((_, i) => applyExclude(i, false));

async function showFrame(idx, timeMs = playTimeMs) {
  if (!frames[idx]) return;
  const seq = ++renderSeq;
  $('gridWrap').children[currentIdx]?.classList.remove('current');
  currentIdx = idx;
  $('gridWrap').children[currentIdx]?.classList.add('current');
  $('currentFrameInfo').textContent = `#${idx + 1} / ${frames.length}`;

  const bmp = await createImageBitmap(frames[idx].blob);
  if (seq !== renderSeq) {
    bmp.close();
    return;
  }
  drawCompositeFrame(editorCtx, bmp, W, H, timeMs, frames[idx].elapsedMs ?? idx * 10000);
  bmp.close();
}

function refreshCurrentPreview() {
  if (frames.length) showFrame(currentIdx, playTimeMs);
}

$('prevFrameBtn').onclick = () => { stopPreview(); if (frames.length) showFrame(Math.max(0, currentIdx - 1)); };
$('nextFrameBtn').onclick = () => { stopPreview(); if (frames.length) showFrame(Math.min(frames.length - 1, currentIdx + 1)); };

function updateEditorStats() {
  const active = getActiveIndices().length;
  const fps = getFps();
  $('editorStats').textContent = `有効 ${active}枚 / 全${frames.length}枚（約${(active / fps).toFixed(1)}秒・${fps}fps）`;
}

function stopPreview() {
  isPlaying = false;
  cancelAnimationFrame(playRaf);
  $('playPreviewBtn').textContent = '▶ 再生';
}

$('playPreviewBtn').onclick = () => {
  if (isPlaying) return stopPreview();
  const active = getActiveIndices();
  if (active.length < 2) return;
  isPlaying = true;
  $('playPreviewBtn').textContent = '⏸ 停止';
  let pos = Math.max(0, active.indexOf(currentIdx));
  lastPlayStep = performance.now();
  const loop = (now) => {
    if (!isPlaying) return;
    const stepMs = 1000 / getFps();
    if (now - lastPlayStep >= stepMs) {
      playTimeMs += now - lastPlayStep;
      lastPlayStep = now;
      showFrame(active[pos], playTimeMs);
      pos = (pos + 1) % active.length;
    }
    playRaf = requestAnimationFrame(loop);
  };
  playRaf = requestAnimationFrame(loop);
};

// ===== GIF & Light Editing Controls =====
$('gifFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  overlayGifFrames.forEach(f => f.bitmap.close());
  overlayGifFrames = [];
  overlayTotalMs = 0;
  if (overlayStaticImg) { overlayStaticImg.close(); overlayStaticImg = null; }

  $('removeGifBtn').style.display = 'inline-flex';
  overlayStaticImg = await createImageBitmap(file);
  $('gifStatusText').textContent = `設定中: ${file.name}`;

  if ('ImageDecoder' in window && file.type === 'image/gif') {
    let dec = null;
    try {
      dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
      await dec.tracks.ready;
      const cnt = dec.tracks.selectedTrack.frameCount;
      for (let i = 0; i < cnt; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const dur = Math.max(20, (image.duration || 100000) / 1000);
        overlayGifFrames.push({ bitmap: await createImageBitmap(image), durationMs: dur });
        image.close();
        overlayTotalMs += dur;
      }
      $('gifStatusText').textContent = `設定中: ${file.name}（アニメ${cnt}コマ）`;
    } catch {
      $('gifStatusText').textContent = `設定中: ${file.name}（静止画として合成）`;
    } finally {
      try { dec?.close(); } catch {}
    }
  }
  refreshCurrentPreview();
};

$('removeGifBtn').onclick = () => {
  $('removeGifBtn').style.display = 'none';
  $('gifFileInput').value = '';
  overlayGifFrames.forEach(f => f.bitmap.close());
  overlayGifFrames = [];
  overlayTotalMs = 0;
  if (overlayStaticImg) { overlayStaticImg.close(); overlayStaticImg = null; }
  $('gifStatusText').textContent = '未設定（下の内蔵スタンプも使えます）';
  refreshCurrentPreview();
};

$('stampPresetGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn) return;
  $('stampPresetGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b === btn));
  editState.stampPreset = btn.dataset.stamp;
  refreshCurrentPreview();
});

$('gifPosGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn) return;
  $('gifPosGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b === btn));
  editState.gifPos = btn.dataset.pos;
  refreshCurrentPreview();
});

$('gifSizeRange').oninput = () => {
  editState.gifSizePct = Number($('gifSizeRange').value);
  $('gifSizeVal').textContent = `${editState.gifSizePct}%`;
  refreshCurrentPreview();
};
$('gifOpacityRange').oninput = () => {
  const v = Number($('gifOpacityRange').value);
  editState.gifOpacity = v / 100;
  $('gifOpacityVal').textContent = `${v}%`;
  refreshCurrentPreview();
};
$('gifMarginRange').oninput = () => {
  editState.gifMarginPct = Number($('gifMarginRange').value);
  $('gifMarginVal').textContent = `${editState.gifMarginPct}%`;
  refreshCurrentPreview();
};

// Look & Transform
function syncLookSliders() {
  $('brightRange').value = editState.brightness;
  $('brightVal').textContent = `${editState.brightness}%`;
  $('contrastRange').value = editState.contrast;
  $('contrastVal').textContent = `${editState.contrast}%`;
  $('satRange').value = editState.saturate;
  $('satVal').textContent = `${editState.saturate}%`;
  $('rotateVal').textContent = `${editState.rotateDeg}°`;
}

$('filterPresetGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn) return;
  $('filterPresetGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b === btn));
  const p = btn.dataset.preset;
  if (p === 'none') Object.assign(editState, { brightness: 100, contrast: 100, saturate: 100, sepia: 0 });
  else if (p === 'crisp') Object.assign(editState, { brightness: 106, contrast: 122, saturate: 110, sepia: 0 });
  else if (p === 'warm') Object.assign(editState, { brightness: 104, contrast: 106, saturate: 115, sepia: 25 });
  else if (p === 'mono') Object.assign(editState, { brightness: 104, contrast: 118, saturate: 0, sepia: 0 });
  syncLookSliders();
  refreshCurrentPreview();
});

$('brightRange').oninput = () => { editState.brightness = Number($('brightRange').value); $('brightVal').textContent = `${editState.brightness}%`; refreshCurrentPreview(); };
$('contrastRange').oninput = () => { editState.contrast = Number($('contrastRange').value); $('contrastVal').textContent = `${editState.contrast}%`; refreshCurrentPreview(); };
$('satRange').oninput = () => { editState.saturate = Number($('satRange').value); $('satVal').textContent = `${editState.saturate}%`; refreshCurrentPreview(); };
$('rotateBtn').onclick = () => { editState.rotateDeg = (editState.rotateDeg + 90) % 360; $('rotateVal').textContent = `${editState.rotateDeg}°`; refreshCurrentPreview(); };
$('flipBtn').onclick = () => { editState.flipH = !editState.flipH; refreshCurrentPreview(); };
$('resetLookBtn').onclick = () => {
  Object.assign(editState, { brightness: 100, contrast: 100, saturate: 100, sepia: 0, rotateDeg: 0, flipH: false });
  $('filterPresetGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === 'none'));
  syncLookSliders();
  refreshCurrentPreview();
};

// Timer & Watermark
$('showTimerCheck').onchange = () => { editState.showTimer = $('showTimerCheck').checked; refreshCurrentPreview(); };
$('watermarkInput').oninput = () => { editState.watermark = $('watermarkInput').value; refreshCurrentPreview(); };

// ===== Export Modal & Safe MP4 Export =====
$('openExportModalBtn').onclick = () => {
  const active = getActiveIndices();
  if (active.length < 2) return alert('書き出す有効なフレームが2枚以上必要です');
  stopPreview();
  const fps = getFps();
  const overlayName = overlayStaticImg
    ? `カスタム画像/GIF (${editState.gifPos.toUpperCase()}・${editState.gifSizePct}%)`
    : (editState.stampPreset !== 'none' ? `内蔵スタンプ (${editState.stampPreset})` : 'なし');
  $('exportSummary').innerHTML = `
    <strong>出力解像度:</strong> ${W} × ${H} (${selectedRatio})<br>
    <strong>有効コマ数:</strong> ${active.length}枚 / 再生時間 約${(active.length / fps).toFixed(1)}秒 (${fps}fps)<br>
    <strong>右下GIF・スタンプ:</strong> ${overlayName}<br>
    <strong>タイマー / 文字:</strong> ${editState.showTimer ? 'ON' : 'OFF'} / ${editState.watermark.trim() || 'なし'}
  `;
  $('exportModal').classList.add('open');
};
$('closeExportModalBtn').onclick = () => $('exportModal').classList.remove('open');
$('exportModal').onclick = (e) => { if (e.target === $('exportModal')) $('exportModal').classList.remove('open'); };

const setProgress = (active, label = '', pct = 0) => {
  $('progressWrap').classList.toggle('active', active);
  $('progressLabel').textContent = label;
  $('progressPct').textContent = Math.round(pct) + '%';
  $('progressFill').style.width = pct + '%';
};

function addDownload(blob, ext) {
  if (!blob || blob.size === 0) return alert('動画データの生成に失敗しました（0バイト）。');
  const a = Object.assign(document.createElement('a'), {
    className: 'dl-link',
    href: URL.createObjectURL(blob),
    download: `komaclip_${Date.now()}.${ext}`,
    textContent: `⬇ ${ext.toUpperCase()} をダウンロード (${(blob.size / 1024 / 1024).toFixed(2)} MB)`
  });
  $('downloadLinks').prepend(a);
  a.click();
}

$('exportMp4Btn').onclick = async () => {
  const active = getActiveIndices();
  if (active.length < 2) return alert('有効なフレームが2枚以上必要です');
  $('exportMp4Btn').disabled = true;

  const fps = getFps();
  const bitrate = Number($('exportQualitySelect').value) || 6_000_000;
  const [comp, cctx] = makeCanvas(W, H);
  try {
    setProgress(true, 'MP4エンコーダ準備中...', 5);
    if ('VideoEncoder' in window && 'VideoFrame' in window) {
      const { Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs');
      let chosen = null;
      for (const codec of ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.42001f']) {
        try {
          const support = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate, framerate: fps });
          if (support.supported) { chosen = codec; break; }
        } catch {}
      }

      if (chosen) {
        let encoderErr = null;
        const muxer = new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: 'avc', width: W, height: H },
          fastStart: 'in-memory',
          firstTimestampBehavior: 'offset'
        });
        const encoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (e) => { encoderErr = e; }
        });
        encoder.configure({ codec: chosen, width: W, height: H, bitrate, framerate: fps });

        const frameUs = Math.round(1_000_000 / fps);
        const frameMs = 1000 / fps;
        for (let i = 0; i < active.length; i++) {
          if (encoderErr) throw encoderErr;
          while (encoder.encodeQueueSize > 8) {
            await new Promise(r => setTimeout(r, 10));
            if (encoderErr) throw encoderErr;
          }
          const f = frames[active[i]];
          const bmp = await createImageBitmap(f.blob);
          drawCompositeFrame(cctx, bmp, W, H, i * frameMs, f.elapsedMs ?? active[i] * 10000);
          bmp.close();

          const vf = new VideoFrame(comp, { timestamp: i * frameUs, duration: frameUs });
          encoder.encode(vf, { keyFrame: i % Math.max(1, fps * 2) === 0 });
          vf.close();

          if (i % 5 === 0 || i === active.length - 1) {
            setProgress(true, `MP4生成中... (${i + 1}/${active.length})`, 10 + ((i + 1) / active.length) * 85);
            await new Promise(r => setTimeout(r, 0));
          }
        }
        await encoder.flush();
        if (encoderErr) throw encoderErr;
        encoder.close();
        muxer.finalize();
        addDownload(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'mp4');
        setBadge('done', 'MP4保存完了');
        return;
      }
    }
    await exportFallback(active, fps, comp, cctx, bitrate);
  } catch (err) {
    console.warn('WebCodecs MP4出力に失敗したため互換モードへ切替:', err);
    await exportFallback(active, fps, comp, cctx, bitrate);
  } finally {
    setProgress(false);
    $('exportMp4Btn').disabled = false;
  }
};

async function exportFallback(active, fps, comp, cctx, bitrate) {
  comp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
  document.body.appendChild(comp);
  try {
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(comp.captureStream(fps), mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : {});
    const chunks = [];
    const done = new Promise(r => rec.onstop = r);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    const delay = 1000 / fps;
    for (let i = 0; i < active.length; i++) {
      const f = frames[active[i]];
      const bmp = await createImageBitmap(f.blob);
      drawCompositeFrame(cctx, bmp, W, H, i * delay, f.elapsedMs ?? active[i] * 10000);
      bmp.close();
      setProgress(true, `互換モード書き出し中... (${i + 1}/${active.length})`, ((i + 1) / active.length) * 95);
      await new Promise(r => setTimeout(r, delay));
    }
    await new Promise(r => setTimeout(r, delay));
    rec.stop();
    await done;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    addDownload(new Blob(chunks, { type: mime || 'video/webm' }), ext);
    setBadge('done', `${ext.toUpperCase()}保存完了`);
  } finally {
    comp.remove();
  }
}

// ===== DB Clear, Shortcuts & Restore =====
$('settingsClearDbBtn').onclick = async () => {
  if (!confirm('保存されている撮影データをすべて消去しますか？')) return;
  try { await storage.clearAll(); } catch {}
  revokeFrameUrls();
  frames = [];
  currentIdx = 0;
  updateStats();
  $('dbStatus').textContent = '消去済み';
  renderEditor();
};

window.addEventListener('keydown', (e) => {
  if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
  if (!$('tab-edit').classList.contains('active') || $('exportModal').classList.contains('open')) return;
  if (!frames.length) return;

  if (e.key === 'ArrowLeft') { e.preventDefault(); stopPreview(); showFrame(Math.max(0, currentIdx - 1)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stopPreview(); showFrame(Math.min(frames.length - 1, currentIdx + 1)); }
  else if (e.code === 'Space') { e.preventDefault(); $('playPreviewBtn').click(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); applyExclude(currentIdx, !frames[currentIdx].excluded); }
});

(async () => {
  try {
    const restored = await storage.restoreAll();
    if (restored.frames.length > 0) {
      if (confirm(`前回の未保存データ（${restored.frames.length}枚）が見つかりました。復元しますか？`)) {
        frames = restored.frames;
        if (restored.meta) {
          if (restored.meta.selectedRatio) setRatio(restored.meta.selectedRatio);
          W = restored.meta.W || W;
          H = restored.meta.H || H;
          elapsedMs = restored.meta.elapsedMs || 0;
        }
        updateStats();
        $('dbStatus').textContent = `復元済 (${frames.length})`;
        switchTab('edit');
      } else {
        await storage.clearAll();
      }
    }
  } catch (e) {
    console.warn('IndexedDB初期化スキップ:', e);
  }
})();

window.addEventListener('beforeunload', () => {
  stopWorkerTimer();
  stopPip();
  if (wakeLock) wakeLock.release().catch(() => {});
  if (stream) stream.getTracks().forEach(t => t.stop());
});
