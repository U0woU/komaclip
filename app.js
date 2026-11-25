import { KomaStorage } from './koma-storage.js';

const $ = (id) => document.getElementById(id);
const storage = new KomaStorage();
const RATIOS = { '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '1:1': [1, 1] };

// State
let stream = null, facingMode = 'environment', wakeLock = null;
let selectedRatio = '16:9', W = 1280, H = 720;
let isRecording = false, isPaused = false, elapsedMs = 0, lastTick = 0, nextShotTime = 0, worker = null;
let frames = [], currentIdx = 0, isPlaying = false, playRaf = null, lastPlayStep = 0;
let isDragging = false, dragTargetExclude = true, prevDiffData = null;
let overlayGifFrames = [], overlayStaticImg = null, overlayTotalMs = 0;

// Canvases & PiP
const makeCanvas = (w = 0, h = 0, opt) => {
  const c = document.createElement('canvas');
  if (w) c.width = w; if (h) c.height = h;
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

// ===== UI: Sidebar, Tabs, Theme =====
$('sidebarToggleBtn').onclick = () => $('appShell').classList.toggle('sidebar-collapsed');

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'edit' && frames.length) renderEditor();
  else stopPreview();
}
document.querySelectorAll('.nav-item').forEach(el => el.onclick = () => switchTab(el.dataset.tab));

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
  W = (rw >= rh ? base : Math.round(base * (rw / rh))) & ~1;
  H = (rw >= rh ? Math.round(base * (rh / rw)) : base) & ~1;

  capCanvas.width = W; capCanvas.height = H;
  thumbCanvas.width = 160;
  thumbCanvas.height = Math.max(40, Math.round(160 * (H / W)));

  // プレビュー枠・編集枠・グリッドの比率を連動
  document.documentElement.style.setProperty('--stage-ar', String(rw / rh));

  // PiP用Canvasの比率も連動
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

$('ratioGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (btn && !isRecording) setRatio(btn.dataset.ratio);
});
$('resSelect').onchange = () => { if (!isRecording) calcOutputSize(); };

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

// ===== Helpers =====
const setBadge = (cls, text) => { $('badge').className = 'badge ' + cls; $('badgeText').textContent = text; };
const formatTime = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
};
function updateStats() {
  const fps = Number($('fpsSelect').value);
  $('frameCount').innerHTML = `${frames.length}<span>枚</span>`;
  $('elapsed').textContent = formatTime(elapsedMs);
  $('estDuration').innerHTML = `${(frames.length / fps).toFixed(1)}<span>秒</span>`;
  $('psStats').textContent = `${frames.length}枚 ・ ${formatTime(elapsedMs)}`;
}
$('fpsSelect').onchange = () => { updateStats(); updateEditorStats(); };

// ===== Camera Connect (高画質1080p優先取得) =====
async function connectCamera() {
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
$('switchCamBtn').onclick = () => { facingMode = facingMode === 'environment' ? 'user' : 'environment'; connectCamera(); };

// ===== PiP (比率連動クロップ映像) & Power Save =====
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
  clearInterval(pipTimer); pipTimer = null;
  if (pipVideo.srcObject) { pipVideo.srcObject.getTracks().forEach(t => t.stop()); pipVideo.srcObject = null; }
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
      pipTimer = setInterval(() => { if (stream) drawCroppedTo(pipCtx, pipCanvas.width, pipCanvas.height); }, 1000 / 15);
      await pipVideo.requestPictureInPicture();
    }
  } catch (e) {
    $('hint').textContent = 'PiP未対応または許可されていません: ' + e.message;
  }
};
$('powerSaveBtn').onclick = () => $('powerSaveOverlay').classList.add('active');
$('psExitBtn').onclick = $('powerSaveOverlay').ondblclick = () => $('powerSaveOverlay').classList.remove('active');

// ===== Worker Timer & Capture =====
function stopWorkerTimer() { if (worker) { worker.terminate(); worker = null; } }
function startWorkerTimer() {
  stopWorkerTimer();
  worker = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), 200);`], { type: 'application/javascript' })));
  worker.onmessage = async () => {
    if (!isRecording || isPaused) return;
    const now = Date.now();
    elapsedMs += now - lastTick;
    lastTick = now;
    updateStats();

    const interval = Number($('intervalSelect').value);
    const remain = Math.max(0, nextShotTime - now);
    $('nextShotBar').style.width = Math.min(100, ((interval - remain) / interval) * 100) + '%';
    if (now >= nextShotTime) { nextShotTime = now + interval; await captureFrame(); }
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
  if (!stream) return;
  const motion = calcMotion();
  drawCroppedTo(capCtx, W, H);
  drawCroppedTo(thumbCtx, thumbCanvas.width, thumbCanvas.height);

  const [blob, thumbBlob] = await Promise.all([
    new Promise(r => capCanvas.toBlob(r, 'image/jpeg', 0.92)),
    new Promise(r => thumbCanvas.toBlob(r, 'image/jpeg', 0.7))
  ]);

  let id = null;
  try {
    id = await storage.addFrame({ blob, thumbBlob, motion, excluded: false });
    storage.saveMeta({ W, H, selectedRatio, elapsedMs });
    $('dbStatus').textContent = `保存済 (${frames.length + 1})`;
  } catch { $('dbStatus').textContent = 'メモリのみ'; }

  frames.push({ id, blob, thumbUrl: URL.createObjectURL(thumbBlob), motion, excluded: false });
  updateStats();
  if (frames.length >= 2) $('finishBtn').disabled = false;

  if (!$('powerSaveOverlay').classList.contains('active')) {
    const fl = $('flash'); fl.classList.remove('fire'); void fl.offsetWidth; fl.classList.add('fire');
  }
}

// ===== Recording Controls & Demo =====
$('startBtn').onclick = async () => {
  if (!stream) return;
  await storage.clearAll();
  calcOutputSize();
  await storage.saveMeta({ W, H, selectedRatio, elapsedMs: 0 });
  frames = []; prevDiffData = null; elapsedMs = 0; isRecording = true; isPaused = false;
  lastTick = Date.now();
  nextShotTime = lastTick + Number($('intervalSelect').value);

  $('startBtn').disabled = $('finishBtn').disabled = $('resSelect').disabled = true;
  $('pauseBtn').disabled = false;
  setBadge('recording', '録画中');
  if ('wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  await captureFrame();
  startWorkerTimer();
};

$('pauseBtn').onclick = () => {
  if (!isRecording) return;
  isPaused = !isPaused;
  $('pauseBtn').textContent = isPaused ? '▶ 再開' : '⏸ 一時停止';
  setBadge(isPaused ? 'paused' : 'recording', isPaused ? '一時停止' : '録画中');
  if (!isPaused) { lastTick = Date.now(); nextShotTime = lastTick + Number($('intervalSelect').value); }
};

$('finishBtn').onclick = () => {
  isRecording = isPaused = false;
  stopWorkerTimer();
  $('nextShotBar').style.width = '0%';
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $('startBtn').disabled = $('resSelect').disabled = false;
  $('pauseBtn').disabled = true; $('pauseBtn').textContent = '⏸ 一時停止';
  setBadge('done', '編集モード');
  switchTab('edit');
};

$('demoBtn').onclick = async () => {
  calcOutputSize();
  await storage.clearAll();
  frames = [];
  const [c, ctx] = makeCanvas(W, H);
  for (let i = 0; i < 24; i++) {
    const isStill = i >= 10 && i <= 14;
    ctx.fillStyle = '#181c2b'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = isStill ? '#3d2c14' : '#253152'; ctx.fillRect(W * 0.14, H * 0.14, W * 0.72, H * 0.72);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(Math.min(W, H) * 0.08)}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(isStill ? `離席中 #${i + 1}` : `勉強中 #${i + 1}`, W / 2, H / 2);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    const motion = isStill ? 1.2 : 18.0;
    const id = await storage.addFrame({ blob, thumbBlob: blob, motion, excluded: false });
    frames.push({ id, blob, thumbUrl: URL.createObjectURL(blob), motion, excluded: false });
  }
  await storage.saveMeta({ W, H, selectedRatio, elapsedMs: 240000 });
  updateStats();
  switchTab('edit');
};

// ===== Editor =====
const getActiveIndices = () => frames.map((f, i) => f.excluded ? -1 : i).filter(i => i >= 0);

function renderEditor() {
  editorCanvas.width = W; editorCanvas.height = H;
  const grid = $('gridWrap'); grid.innerHTML = '';
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
  if (frames[idx].id != null) storage.setExcluded(frames[idx].id, state);
  updateEditorStats();
}

$('gridSizeGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn'); if (!btn) return;
  $('gridSizeGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  $('gridWrap').classList.remove('size-sm', 'size-md', 'size-lg');
  $('gridWrap').classList.add('size-' + btn.dataset.size);
});
$('touchDragCheck').onchange = () => $('gridWrap').classList.toggle('drag-touch', $('touchDragCheck').checked);

$('gridWrap').addEventListener('pointerdown', (e) => {
  const item = e.target.closest('.grid-item'); if (!item) return;
  const idx = Number(item.dataset.idx);
  if (e.pointerType === 'touch' && !$('touchDragCheck').checked) {
    stopPreview(); showFrame(idx); applyExclude(idx, !frames[idx].excluded); return;
  }
  e.preventDefault(); stopPreview();
  isDragging = true; dragTargetExclude = !frames[idx].excluded;
  showFrame(idx); applyExclude(idx, dragTargetExclude);
});
window.addEventListener('pointermove', (e) => {
  if (!isDragging) return;
  const item = document.elementFromPoint(e.clientX, e.clientY)?.closest('.grid-item');
  if (item) { const idx = Number(item.dataset.idx); showFrame(idx); applyExclude(idx, dragTargetExclude); }
});
window.addEventListener('pointerup', () => { isDragging = false; });

$('cutBeforeBtn').onclick = () => { for (let i = 0; i < currentIdx; i++) applyExclude(i, true); };
$('cutAfterBtn').onclick = () => { for (let i = currentIdx + 1; i < frames.length; i++) applyExclude(i, true); };

function updateStillHighlight() {
  const th = Number($('stillThreshold').value);
  let cnt = 0;
  frames.forEach((f, i) => {
    const isStill = f.motion < th; if (isStill) cnt++;
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

async function showFrame(idx) {
  if (!frames[idx]) return;
  $('gridWrap').children[currentIdx]?.classList.remove('current');
  currentIdx = idx;
  $('gridWrap').children[currentIdx]?.classList.add('current');
  $('currentFrameInfo').textContent = `#${idx + 1} / ${frames.length}`;
  const bmp = await createImageBitmap(frames[idx].blob);
  editorCtx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
}

function updateEditorStats() {
  const active = getActiveIndices().length, fps = Number($('fpsSelect').value);
  $('editorStats').textContent = `有効 ${active}枚 / 全${frames.length}枚（約${(active / fps).toFixed(1)}秒）`;
}

function stopPreview() { isPlaying = false; cancelAnimationFrame(playRaf); $('playPreviewBtn').textContent = '▶ 再生'; }
$('playPreviewBtn').onclick = () => {
  if (isPlaying) return stopPreview();
  const active = getActiveIndices(); if (active.length < 2) return;
  isPlaying = true; $('playPreviewBtn').textContent = '⏸ 停止';
  let pos = Math.max(0, active.indexOf(currentIdx));
  lastPlayStep = performance.now();
  const loop = (now) => {
    if (!isPlaying) return;
    if (now - lastPlayStep >= 1000 / Number($('fpsSelect').value)) {
      lastPlayStep = now; showFrame(active[pos]); pos = (pos + 1) % active.length;
    }
    playRaf = requestAnimationFrame(loop);
  };
  playRaf = requestAnimationFrame(loop);
};

// ===== Export Modal & GIF Overlay =====
$('openExportModalBtn').onclick = () => {
  if (frames.length < 2) return alert('書き出すフレームがありません');
  stopPreview(); $('exportModal').classList.add('open');
};
$('closeExportModalBtn').onclick = () => $('exportModal').classList.remove('open');
$('exportModal').onclick = (e) => { if (e.target === $('exportModal')) $('exportModal').classList.remove('open'); };

$('gifSizeRange').oninput = () => { $('cornerGif').style.width = $('gifSizeRange').value + 'px'; };
$('gifFileInput').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  overlayGifFrames.forEach(f => f.bitmap.close());
  overlayGifFrames = []; overlayTotalMs = 0;

  $('cornerGif').src = URL.createObjectURL(file);
  $('cornerGif').style.display = 'block';
  $('removeGifBtn').style.display = 'inline-flex';
  overlayStaticImg = await createImageBitmap(file);
  $('gifStatusText').textContent = `設定中: ${file.name}`;

  if ('ImageDecoder' in window && file.type === 'image/gif') {
    try {
      const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
      await dec.tracks.ready;
      const cnt = dec.tracks.selectedTrack.frameCount;
      for (let i = 0; i < cnt; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const dur = Math.max(20, (image.duration || 100000) / 1000);
        overlayGifFrames.push({ bitmap: await createImageBitmap(image), durationMs: dur });
        image.close(); overlayTotalMs += dur;
      }
      $('gifStatusText').textContent = `設定中: ${file.name}（アニメ${cnt}コマ）`;
    } catch {}
  }
};
$('removeGifBtn').onclick = () => {
  $('cornerGif').style.display = $('removeGifBtn').style.display = 'none';
  $('gifFileInput').value = '';
  overlayGifFrames.forEach(f => f.bitmap.close());
  overlayGifFrames = []; overlayStaticImg = null;
  $('gifStatusText').textContent = '未設定（Canva等のGIFを右下に配置できます）';
};

function drawCornerOverlay(ctx, cw, ch, timeMs) {
  let img = overlayStaticImg;
  if (overlayGifFrames.length && overlayTotalMs > 0) {
    let t = timeMs % overlayTotalMs;
    img = overlayGifFrames.find(f => (t -= f.durationMs) <= 0)?.bitmap || overlayGifFrames[0].bitmap;
  }
  if (!img) return;
  const dw = Math.round(cw * Math.min(0.32, Math.max(0.08, Number($('gifSizeRange').value) / 600)));
  const dh = Math.round(dw * (img.height / img.width));
  const pad = Math.round(cw * 0.02);
  ctx.drawImage(img, cw - dw - pad, ch - dh - pad, dw, dh);
}

// ===== Fast MP4 Export =====
const setProgress = (active, label = '', pct = 0) => {
  $('progressWrap').classList.toggle('active', active);
  $('progressLabel').textContent = label;
  $('progressPct').textContent = Math.round(pct) + '%';
  $('progressFill').style.width = pct + '%';
};

function addDownload(blob, ext) {
  if (!blob || blob.size === 0) return alert('動画データの生成に失敗しました（0バイト）。');
  const a = Object.assign(document.createElement('a'), {
    className: 'dl-link', href: URL.createObjectURL(blob),
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

  const fps = Number($('fpsSelect').value), bitrate = 6_000_000;
  const [comp, cctx] = makeCanvas(W, H);
  try {
    setProgress(true, 'MP4エンコーダ準備中...', 5);
    if ('VideoEncoder' in window) {
      const { Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs');
      let chosen = null;
      for (const codec of ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.42001f']) {
        if ((await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate, framerate: fps })).supported) { chosen = codec; break; }
      }
      if (chosen) {
        const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
        const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { throw e; } });
        encoder.configure({ codec: chosen, width: W, height: H, bitrate, framerate: fps });

        const frameUs = Math.round(1_000_000 / fps), frameMs = 1000 / fps;
        for (let i = 0; i < active.length; i++) {
          const bmp = await createImageBitmap(frames[active[i]].blob);
          cctx.drawImage(bmp, 0, 0, W, H); bmp.close();
          drawCornerOverlay(cctx, W, H, i * frameMs);
          const vf = new VideoFrame(comp, { timestamp: i * frameUs, duration: frameUs });
          encoder.encode(vf, { keyFrame: i % Math.max(1, fps * 2) === 0 });
          vf.close();
          if (i % 5 === 0) { setProgress(true, `MP4生成中... (${i + 1}/${active.length})`, 10 + (i / active.length) * 85); await new Promise(r => setTimeout(r, 0)); }
        }
        await encoder.flush(); muxer.finalize();
        addDownload(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'mp4');
        setBadge('done', 'MP4保存完了');
        return;
      }
    }
    await exportFallback(active, fps, comp, cctx, bitrate);
  } catch (err) {
    console.error(err);
    await exportFallback(active, fps, comp, cctx, bitrate);
  } finally {
    setProgress(false); $('exportMp4Btn').disabled = false;
  }
};

async function exportFallback(active, fps, comp, cctx, bitrate) {
  comp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
  document.body.appendChild(comp);
  try {
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(comp.captureStream(fps), mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : {});
    const chunks = [], done = new Promise(r => rec.onstop = r);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    const delay = 1000 / fps;
    for (let i = 0; i < active.length; i++) {
      const bmp = await createImageBitmap(frames[active[i]].blob);
      cctx.drawImage(bmp, 0, 0, W, H); bmp.close();
      drawCornerOverlay(cctx, W, H, i * delay);
      setProgress(true, `互換モード書き出し中... (${i + 1}/${active.length})`, (i / active.length) * 95);
      await new Promise(r => setTimeout(r, delay));
    }
    await new Promise(r => setTimeout(r, delay));
    rec.stop(); await done;
    addDownload(new Blob(chunks, { type: mime || 'video/webm' }), mime.includes('mp4') ? 'mp4' : 'webm');
  } finally { comp.remove(); }
}

// ===== DB Clear, Shortcuts & Restore =====
$('settingsClearDbBtn').onclick = async () => {
  if (!confirm('保存されている撮影データをすべて消去しますか？')) return;
  await storage.clearAll(); frames = []; updateStats();
  $('dbStatus').textContent = '消去済み'; $('gridWrap').innerHTML = '';
};

window.addEventListener('keydown', (e) => {
  if (!$('tab-edit').classList.contains('active') || $('exportModal').classList.contains('open')) return;
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
          W = restored.meta.W || W; H = restored.meta.H || H;
          elapsedMs = restored.meta.elapsedMs || 0;
        }
        updateStats(); $('dbStatus').textContent = `復元済 (${frames.length})`; switchTab('edit');
      } else await storage.clearAll();
    }
  } catch (e) { console.warn('IndexedDB初期化スキップ:', e); }
})();

window.addEventListener('beforeunload', () => {
  stopWorkerTimer(); stopPip();
  if (wakeLock) wakeLock.release().catch(() => {});
  if (stream) stream.getTracks().forEach(t => t.stop());
});
