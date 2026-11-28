import { KomaStorage } from './koma-storage.js';

const APP_VERSION = 'ver.1.0.0';
const RANDOM_MIN_SEC = 10;
const RANDOM_MAX_SEC = 40;
const DIFF_W = 48;
const DIFF_H = 27;

const $ = (id) => document.getElementById(id);
const storage = new KomaStorage();
const RATIOS = { '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '1:1': [1, 1] };

// Safe localStorage wrapper
const storeGet = (key, fallback = '') => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const storeSet = (key, val) => {
  try { localStorage.setItem(key, val); } catch {}
};
const storeRemove = (key) => {
  try { localStorage.removeItem(key); } catch {}
};

// ===== State =====
let previewStream = null;
let videoDevices = [];
let selectedDeviceId = storeGet('komaclip_camera_id', '');
let wakeLock = null;
let selectedRatio = '9:16';
let W = 480;
let H = 854;
let isRecording = false;
let isPaused = false;
let isCapturing = false;
let elapsedMs = 0;
let lastTick = 0;
let currentIntervalMs = 10000;
let nextShotTime = 0;
let worker = null;
let workerUrl = null;

let frames = [];
let droppedStillCount = 0;
let prevLuma = null;
let lastShotUrl = null;
let lastStatKey = '';

// ===== Offscreen Canvases =====
const makeCanvas = (w = 0, h = 0, opt) => {
  const c = document.createElement('canvas');
  if (w) c.width = w;
  if (h) c.height = h;
  return [c, c.getContext('2d', opt)];
};
const [capCanvas, capCtx] = makeCanvas();
const [diffCanvas, diffCtx] = makeCanvas(DIFF_W, DIFF_H, { willReadFrequently: true });

// ===== Helpers =====
const setBadge = (cls, text) => {
  $('badge').className = cls ? `badge ${cls}` : 'badge';
  $('badgeText').textContent = text;
};

const formatTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
};

function getFps() {
  return Number($('fpsSelect').value || 15);
}

function getNextIntervalMs() {
  const val = $('intervalSelect').value;
  if (val === 'random') {
    const sec = Math.floor(Math.random() * (RANDOM_MAX_SEC - RANDOM_MIN_SEC + 1)) + RANDOM_MIN_SEC;
    return sec * 1000;
  }
  return Number(val) || 10000;
}

function updateIntervalNote() {
  const val = $('intervalSelect').value;
  if (isRecording) {
    const sec = Math.round(currentIntervalMs / 1000);
    $('nextIntervalInfo').textContent = val === 'random'
      ? `次回撮影間隔: ${sec}秒（10〜40秒ランダム）`
      : `次回撮影間隔: ${sec}秒（固定）`;
  } else {
    $('nextIntervalInfo').textContent = val === 'random'
      ? '次回撮影間隔: ランダム（10〜40秒）'
      : `次回撮影間隔: ${Math.round(Number(val) / 1000)}秒（固定）`;
  }
}

function updateStats(force = false) {
  const fps = getFps();
  const timeStr = formatTime(elapsedMs);
  const estStr = (frames.length / fps).toFixed(1);
  const key = `${frames.length}|${timeStr}|${estStr}|${droppedStillCount}|${isRecording}`;
  if (!force && key === lastStatKey) return;
  lastStatKey = key;

  $('frameCount').textContent = String(frames.length);
  $('elapsed').textContent = timeStr;
  $('estDuration').textContent = estStr;
  $('droppedCount').textContent = String(droppedStillCount);
  $('psStats').textContent = `${frames.length}枚 ・ ${timeStr}`;
  $('exportWebmBtn').textContent = `WebM書き出し (${frames.length}枚)`;
  $('exportWebmBtn').disabled = isRecording || frames.length < 2;
}

// ===== In-Page Confirm Modal =====
let confirmResolver = null;
function askConfirm(title, message, okLabel = '実行') {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    $('confirmOkBtn').textContent = okLabel;
    $('confirmModal').classList.add('open');
  });
}
function closeConfirm(result) {
  $('confirmModal').classList.remove('open');
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(result);
  }
}
$('confirmOkBtn').addEventListener('click', () => closeConfirm(true));
$('confirmCancelBtn').addEventListener('click', () => closeConfirm(false));
$('confirmModal').addEventListener('click', (e) => {
  if (e.target === $('confirmModal')) closeConfirm(false);
});

// ===== Settings Modal & Version =====
$('appVersion').textContent = APP_VERSION;
function setSettingsOpen(open) {
  $('settingsModal').classList.toggle('open', open);
}
$('settingsBtn').addEventListener('click', () => setSettingsOpen(true));
$('closeSettingsBtn').addEventListener('click', () => setSettingsOpen(false));
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) setSettingsOpen(false);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setSettingsOpen(false);
    closeConfirm(false);
  }
});

// ===== Theme (Monochrome Dark / Light) =====
function applyTheme(t) {
  const mode = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', mode);
  $('themeBtn').textContent = mode === 'light' ? 'ライト' : 'ダーク';
  storeSet('komaclip_theme', mode);
}
applyTheme(storeGet('komaclip_theme', 'dark'));
$('themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'light' ? 'dark' : 'light');
});

// ===== Ratio & Dimensions =====
function calcOutputSize() {
  const base = Number($('resSelect').value);
  const [rw, rh] = RATIOS[selectedRatio] || [9, 16];
  W = Math.max(2, (rw >= rh ? base : Math.round(base * (rw / rh))) & ~1);
  H = Math.max(2, (rw >= rh ? Math.round(base * (rh / rw)) : base) & ~1);
  capCanvas.width = W;
  capCanvas.height = H;
  document.documentElement.style.setProperty('--stage-ar', String(rw / rh));
}

function setRatio(ratio) {
  selectedRatio = RATIOS[ratio] ? ratio : '9:16';
  $('ratioGroup').querySelectorAll('.ratio-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.ratio === selectedRatio);
  });
  calcOutputSize();
  renderGuide();
}

$('resSelect').addEventListener('change', () => {
  if (isRecording) return;
  calcOutputSize();
  $('hint').textContent = `出力解像度を ${W}×${H} (${selectedRatio}) に変更しました`;
});
$('fpsSelect').addEventListener('change', () => updateStats(true));
$('intervalSelect').addEventListener('change', updateIntervalNote);

$('ratioGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn || isRecording) return;
  setRatio(btn.dataset.ratio);
});

$('stillThreshold').addEventListener('input', () => {
  $('stillThVal').textContent = `感度 ${Number($('stillThreshold').value).toFixed(1)}`;
});

// ===== Monochrome Guides =====
const GUIDE_SVGS = {
  study: ['ノート・手元ガイド', '<rect x="260" y="160" width="1080" height="580" rx="14" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="2.5" stroke-dasharray="12 10"/><line x1="775" y1="450" x2="825" y2="450" stroke="rgba(255,255,255,0.8)" stroke-width="2"/><line x1="800" y1="425" x2="800" y2="475" stroke="rgba(255,255,255,0.8)" stroke-width="2"/>'],
  thirds: ['三分割グリッド', '<line x1="533" y1="0" x2="533" y2="900" stroke="rgba(255,255,255,0.4)" stroke-width="2"/><line x1="1066" y1="0" x2="1066" y2="900" stroke="rgba(255,255,255,0.4)" stroke-width="2"/><line x1="0" y1="300" x2="1600" y2="300" stroke="rgba(255,255,255,0.4)" stroke-width="2"/><line x1="0" y1="600" x2="1600" y2="600" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>'],
  horizon: ['水平・中心線', '<line x1="0" y1="450" x2="1600" y2="450" stroke="rgba(255,255,255,0.65)" stroke-width="2"/><line x1="800" y1="0" x2="800" y2="900" stroke="rgba(255,255,255,0.4)" stroke-width="2" stroke-dasharray="10 10"/>']
};
function renderGuide() {
  const g = GUIDE_SVGS[$('guideSelect').value];
  $('guideLabel').textContent = `${g ? g[0] : 'ガイドなし'} (${selectedRatio})`;
  $('guideLayer').innerHTML = g ? `<svg viewBox="0 0 1600 900" preserveAspectRatio="none">${g[1]}</svg>` : '';
}
$('guideSelect').addEventListener('change', renderGuide);
$('toggleGuideBtn').addEventListener('click', () => {
  $('guideSelect').value = $('guideSelect').value === 'off' ? 'study' : 'off';
  renderGuide();
});

calcOutputSize();
renderGuide();
updateIntervalNote();

// ===== Multi-Camera Enumeration & Selection =====
function getSelectedCameraLabel() {
  const found = videoDevices.find((d) => d.deviceId === selectedDeviceId);
  if (found && found.label) return found.label;
  const opt = $('cameraSelect').selectedOptions[0];
  return opt ? opt.textContent : '既定カメラ';
}

async function refreshCameraList(requestPermissionIfHidden = false) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];

  let devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const needsPermission = devices.length === 0 || devices.every((d) => !d.deviceId || !d.label);

  if (requestPermissionIfHidden && needsPermission && navigator.mediaDevices?.getUserMedia) {
    let tmp = null;
    try {
      tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } finally {
      if (tmp) tmp.getTracks().forEach((t) => t.stop());
    }
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }

  videoDevices = devices.filter((d) => d.deviceId);
  const sel = $('cameraSelect');
  sel.innerHTML = '';

  if (videoDevices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'カメラ未検出（「構図確認」または「一覧更新」で許可）';
    sel.appendChild(opt);
    return videoDevices;
  }

  videoDevices.forEach((dev, idx) => {
    const opt = document.createElement('option');
    opt.value = dev.deviceId;
    opt.textContent = dev.label || `カメラ ${idx + 1}`;
    sel.appendChild(opt);
  });

  if (selectedDeviceId && videoDevices.some((d) => d.deviceId === selectedDeviceId)) {
    sel.value = selectedDeviceId;
  } else {
    selectedDeviceId = videoDevices[0].deviceId;
    sel.value = selectedDeviceId;
    storeSet('komaclip_camera_id', selectedDeviceId);
  }
  return videoDevices;
}

$('cameraSelect').addEventListener('change', async () => {
  if (isRecording) return;
  selectedDeviceId = $('cameraSelect').value;
  storeSet('komaclip_camera_id', selectedDeviceId);
  $('hint').textContent = `使用カメラを変更しました: ${getSelectedCameraLabel()}`;
  if (previewStream) {
    stopPreviewStream();
    await togglePreviewCamera();
  }
});

$('refreshCamListBtn').addEventListener('click', async () => {
  if (isRecording) return;
  try {
    const list = await refreshCameraList(true);
    $('hint').textContent = list.length > 0
      ? `カメラを ${list.length}台 検出しました（現在: ${getSelectedCameraLabel()}）`
      : '利用可能なカメラが見つかりませんでした';
  } catch (e) {
    $('hint').textContent = `カメラ一覧の取得に失敗: ${e.message}`;
  }
});

$('switchCamBtn').addEventListener('click', async () => {
  if (isRecording) return;
  try {
    if (videoDevices.length < 2) await refreshCameraList(true);
    if (videoDevices.length < 2) {
      $('hint').textContent = `検出されたカメラは ${videoDevices.length}台 のみです`;
      return;
    }
    const curIdx = videoDevices.findIndex((d) => d.deviceId === selectedDeviceId);
    const nextIdx = (curIdx + 1) % videoDevices.length;
    selectedDeviceId = videoDevices[nextIdx].deviceId;
    $('cameraSelect').value = selectedDeviceId;
    storeSet('komaclip_camera_id', selectedDeviceId);

    if (previewStream) {
      stopPreviewStream();
      await togglePreviewCamera();
    } else {
      $('hint').textContent = `カメラを切り替えました (${nextIdx + 1}/${videoDevices.length}): ${getSelectedCameraLabel()}`;
    }
  } catch (e) {
    $('hint').textContent = `カメラ切替エラー: ${e.message}`;
  }
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    refreshCameraList(false).catch(() => {});
  });
}

// ===== Camera Control =====
function stopPreviewStream() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
  $('preview').srcObject = null;
  $('connectCamBtn').textContent = '構図確認（ON）';
}

async function openCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザまたは非HTTPS環境ではカメラAPIを利用できません');
  }
  const base = Number($('resSelect').value || 854);
  const idealW = base >= 1920 ? 1920 : 1280;
  const idealH = base >= 1920 ? 1080 : 720;

  const videoConstraints = {
    width: { ideal: idealW },
    height: { ideal: idealH },
    frameRate: { ideal: 24 }
  };
  if (selectedDeviceId) {
    videoConstraints.deviceId = { exact: selectedDeviceId };
  }

  try {
    return await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  } catch (err) {
    if (selectedDeviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      selectedDeviceId = '';
      storeRemove('komaclip_camera_id');
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: idealW }, height: { ideal: idealH }, frameRate: { ideal: 24 } },
        audio: false
      });
    }
    throw err;
  }
}

async function waitVideoReady(videoEl, timeoutMs = 3000) {
  const start = performance.now();
  while (videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('カメラ映像の初期化がタイムアウトしました');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function togglePreviewCamera() {
  if (isRecording) return;
  if (previewStream) {
    stopPreviewStream();
    setBadge('', '待機中');
    $('hint').textContent = '構図確認カメラを停止しました';
    return;
  }
  try {
    $('hint').textContent = 'カメラを起動中...';
    previewStream = await openCameraStream();
    const preview = $('preview');
    preview.srcObject = previewStream;
    await preview.play();
    await waitVideoReady(preview);

    const activeId = previewStream.getVideoTracks()[0]?.getSettings()?.deviceId;
    if (activeId) {
      selectedDeviceId = activeId;
      storeSet('komaclip_camera_id', activeId);
    }
    await refreshCameraList(false);

    $('lastShotImg').style.display = 'none';
    $('placeholder').style.display = 'none';
    $('camSleepBadge').style.display = 'none';
    $('connectCamBtn').textContent = '構図確認（OFF）';
    setBadge('', '構図確認中');
    $('hint').textContent = `構図確認中: ${getSelectedCameraLabel()}`;
  } catch (e) {
    stopPreviewStream();
    setBadge('', 'エラー');
    $('hint').textContent = `カメラ接続失敗: ${e.message}`;
  }
}
$('connectCamBtn').addEventListener('click', togglePreviewCamera);
$('heroCamBtn').addEventListener('click', togglePreviewCamera);

// ===== Lightweight Crop & Motion Detection =====
function drawCroppedTo(videoEl, ctx, dstW, dstH) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return false;
  const srcR = vw / vh;
  const dstR = dstW / dstH;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcR > dstR) { sw = vh * dstR; sx = (vw - sw) / 2; }
  else { sh = vw / dstR; sy = (vh - sh) / 2; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, dstW, dstH);
  return true;
}

function evaluateMotion(videoEl) {
  if (!drawCroppedTo(videoEl, diffCtx, DIFF_W, DIFF_H)) {
    return { score: 100, luma: null };
  }
  const rgba = diffCtx.getImageData(0, 0, DIFF_W, DIFF_H).data;
  const pixels = DIFF_W * DIFF_H;
  const luma = new Uint8Array(pixels);
  let sum = 0;

  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const y = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    luma[p] = y;
    if (prevLuma) sum += Math.abs(y - prevLuma[p]);
  }
  return { score: prevLuma ? sum / pixels : 100, luma };
}

// ===== One-Shot Intermittent Capture =====
async function captureOneShotBurst() {
  if (isCapturing || !isRecording) return;
  isCapturing = true;

  let tempStream = null;
  const tempVideo = document.createElement('video');
  tempVideo.muted = true;
  tempVideo.playsInline = true;

  try {
    $('camSleepBadge').textContent = '撮影中...';
    $('camSleepBadge').style.display = 'block';

    tempStream = await openCameraStream();
    tempVideo.srcObject = tempStream;
    await tempVideo.play();
    await waitVideoReady(tempVideo);

    const warmupMs = Number($('warmupMsSelect')?.value || 600);
    await new Promise((r) => setTimeout(r, warmupMs));
    if (!isRecording) return;

    const { score, luma } = evaluateMotion(tempVideo);
    if (!luma) return;

    const autoDrop = $('autoDropStillCheck').checked;
    const threshold = Number($('stillThreshold').value);

    if (autoDrop && prevLuma && score < threshold) {
      droppedStillCount++;
      updateStats(true);
      $('hint').textContent = `静止画像を破棄しました（差分 ${score.toFixed(1)} < ${threshold}）`;
      return;
    }

    if (!drawCroppedTo(tempVideo, capCtx, W, H)) return;
    prevLuma = luma;

    const blob = await new Promise((r) => capCanvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) return;

    const frameElapsed = elapsedMs;
    let id = null;
    try {
      id = await storage.addFrame({ blob, elapsedMs: frameElapsed });
      await storage.saveMeta({ W, H, selectedRatio, elapsedMs: frameElapsed });
      $('dbStatus').textContent = `DB保存済 (${frames.length + 1}枚)`;
    } catch {
      $('dbStatus').textContent = 'メモリ保存中';
    }

    // IndexedDBに保存できた場合はRAM上のBlobを解放して軽量化
    frames.push({ id, blob: id ? null : blob, elapsedMs: frameElapsed });

    if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
    lastShotUrl = URL.createObjectURL(blob);
    const imgEl = $('lastShotImg');
    imgEl.src = lastShotUrl;
    imgEl.style.display = 'block';
    $('placeholder').style.display = 'none';

    updateStats(true);
    const nextSec = Math.round(currentIntervalMs / 1000);
    $('hint').textContent = `コマ #${frames.length} 保存完了（次回 約${nextSec}秒後）`;

    if (!$('powerSaveOverlay').classList.contains('active')) {
      const fl = $('flash');
      fl.classList.remove('fire');
      void fl.offsetWidth;
      fl.classList.add('fire');
    }
  } catch (e) {
    $('hint').textContent = `撮影エラー: ${e.message}`;
  } finally {
    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());
    tempVideo.srcObject = null;
    if (isRecording) {
      const nextSec = Math.round(currentIntervalMs / 1000);
      $('camSleepBadge').textContent = `カメラ停止中（次回 ${nextSec}秒後）`;
      $('camSleepBadge').style.display = 'block';
    } else {
      $('camSleepBadge').style.display = 'none';
    }
    isCapturing = false;
  }
}

// ===== Lightweight 1Hz Worker Timer =====
function stopWorkerTimer() {
  if (worker) { worker.terminate(); worker = null; }
  if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
}

function scheduleNextShot(now) {
  currentIntervalMs = getNextIntervalMs();
  nextShotTime = now + currentIntervalMs;
  updateIntervalNote();
}

function startWorkerTimer() {
  stopWorkerTimer();
  workerUrl = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000);'], { type: 'application/javascript' }));
  worker = new Worker(workerUrl);
  worker.onmessage = async () => {
    if (!isRecording || isPaused) return;
    const now = Date.now();
    elapsedMs += now - lastTick;
    lastTick = now;
    updateStats();

    const remain = Math.max(0, nextShotTime - now);
    const pct = Math.min(100, ((currentIntervalMs - remain) / currentIntervalMs) * 100);
    $('nextShotBar').style.width = `${pct.toFixed(1)}%`;

    if (now >= nextShotTime && !isCapturing) {
      scheduleNextShot(now);
      await captureOneShotBurst();
    }
  };
}

// ===== Recording Controls =====
function setCameraUiDisabled(disabled) {
  $('resSelect').disabled = disabled;
  $('connectCamBtn').disabled = disabled;
  $('switchCamBtn').disabled = disabled;
  $('refreshCamListBtn').disabled = disabled;
  $('cameraSelect').disabled = disabled;
}

$('startBtn').addEventListener('click', async () => {
  stopPreviewStream();

  try { await storage.clearAll(); } catch {}
  calcOutputSize();
  try { await storage.saveMeta({ W, H, selectedRatio, elapsedMs: 0 }); } catch {}

  if (lastShotUrl) { URL.revokeObjectURL(lastShotUrl); lastShotUrl = null; }
  $('lastShotImg').style.display = 'none';

  frames = [];
  droppedStillCount = 0;
  prevLuma = null;
  elapsedMs = 0;
  isRecording = true;
  isPaused = false;
  lastTick = Date.now();
  scheduleNextShot(lastTick);

  $('startBtn').disabled = true;
  setCameraUiDisabled(true);
  $('pauseBtn').disabled = false;
  $('stopRecBtn').disabled = false;
  $('exportCard').style.display = 'none';
  $('downloadLinks').innerHTML = '';
  setBadge('recording', '間欠録画中');
  updateStats(true);

  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }

  await captureOneShotBurst();
  startWorkerTimer();
});

$('pauseBtn').addEventListener('click', () => {
  if (!isRecording) return;
  isPaused = !isPaused;
  $('pauseBtn').textContent = isPaused ? '再開' : '一時停止';
  setBadge(isPaused ? 'paused' : 'recording', isPaused ? '一時停止' : '間欠録画中');
  if (!isPaused) {
    lastTick = Date.now();
    scheduleNextShot(lastTick);
  }
});

$('stopRecBtn').addEventListener('click', () => {
  isRecording = false;
  isPaused = false;
  stopWorkerTimer();
  $('nextShotBar').style.width = '0%';
  $('camSleepBadge').style.display = 'none';
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }

  $('startBtn').disabled = false;
  setCameraUiDisabled(false);
  $('pauseBtn').disabled = true;
  $('stopRecBtn').disabled = true;
  $('pauseBtn').textContent = '一時停止';
  setBadge('done', '撮影完了');
  updateIntervalNote();
  updateStats(true);

  if (frames.length >= 2) {
    $('exportCard').style.display = 'grid';
    $('hint').textContent = `撮影終了（採用 ${frames.length}枚 / 破棄 ${droppedStillCount}枚）。WebM書き出しが可能です。`;
  } else {
    $('hint').textContent = '採用コマが2枚未満のため動画化できません。';
  }
});

$('powerSaveBtn').addEventListener('click', () => $('powerSaveOverlay').classList.add('active'));
const exitPowerSave = () => $('powerSaveOverlay').classList.remove('active');
$('psExitBtn').addEventListener('click', exitPowerSave);
$('powerSaveOverlay').addEventListener('dblclick', exitPowerSave);

// ===== Streaming WebM Export =====
const setProgress = (active, label = '', pct = 0) => {
  $('progressWrap').classList.toggle('active', active);
  $('progressLabel').textContent = label;
  $('progressPct').textContent = `${Math.round(pct)}%`;
  $('progressFill').style.width = `${pct}%`;
};

$('exportWebmBtn').addEventListener('click', async () => {
  if (frames.length < 2) {
    $('hint').textContent = '書き出すコマが2枚以上必要です';
    return;
  }
  $('exportWebmBtn').disabled = true;
  $('exportCard').style.display = 'grid';

  const fps = getFps();
  const [comp, cctx] = makeCanvas(W, H);
  comp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
  document.body.appendChild(comp);

  try {
    setProgress(true, 'WebM書き出し準備中...', 2);
    const mime = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';

    const stream = comp.captureStream(fps);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : {});
    const chunks = [];
    const done = new Promise((r) => { rec.onstop = r; });
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    rec.start();
    const delay = 1000 / fps;
    const t0 = performance.now();

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const blob = f.blob || (f.id != null ? await storage.getFrameBlob(f.id) : null);
      if (!blob) continue;

      const bmp = await createImageBitmap(blob);
      cctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();

      setProgress(true, `WebM生成中... (${i + 1}/${frames.length})`, ((i + 1) / frames.length) * 96);

      const nextTarget = t0 + (i + 1) * delay;
      const waitMs = Math.max(0, nextTarget - performance.now());
      await new Promise((r) => setTimeout(r, waitMs));
    }

    await new Promise((r) => setTimeout(r, delay));
    rec.stop();
    await done;

    const outBlob = new Blob(chunks, { type: mime || 'video/webm' });
    if (outBlob.size === 0) throw new Error('WebMデータが0バイトになりました');

    const a = Object.assign(document.createElement('a'), {
      className: 'dl-link',
      href: URL.createObjectURL(outBlob),
      download: `komaclip_${Date.now()}.webm`,
      textContent: `WebMをダウンロード (${(outBlob.size / 1024 / 1024).toFixed(2)} MB / ${frames.length}コマ)`
    });
    $('downloadLinks').prepend(a);
    a.click();
    setBadge('done', 'WebM保存完了');
    $('hint').textContent = 'WebMファイルを書き出しました。';
  } catch (e) {
    $('hint').textContent = `WebM書き出しエラー: ${e.message}`;
  } finally {
    comp.remove();
    setProgress(false);
    $('exportWebmBtn').disabled = isRecording || frames.length < 2;
  }
});

// ===== DB Clear & Startup =====
$('settingsClearDbBtn').addEventListener('click', async () => {
  const ok = await askConfirm('データ消去', '保存されている撮影データをすべて消去しますか？', '消去する');
  if (!ok) return;
  try { await storage.clearAll(); } catch {}
  frames = [];
  droppedStillCount = 0;
  prevLuma = null;
  elapsedMs = 0;
  if (lastShotUrl) { URL.revokeObjectURL(lastShotUrl); lastShotUrl = null; }
  $('lastShotImg').style.display = 'none';
  $('placeholder').style.display = 'grid';
  $('exportCard').style.display = 'none';
  $('downloadLinks').innerHTML = '';
  updateStats(true);
  $('dbStatus').textContent = '消去済み';
  $('hint').textContent = '保存データをすべて消去しました';
  setSettingsOpen(false);
});

(async () => {
  try { await refreshCameraList(false); } catch {}
  try {
    const restored = await storage.restoreSummary();
    if (restored.frames.length > 0) {
      const ok = await askConfirm(
        '未出力データの復元',
        `前回の未出力データ（${restored.frames.length}枚）が見つかりました。復元しますか？`,
        '復元する'
      );
      if (ok) {
        frames = restored.frames;
        if (restored.meta) {
          if (restored.meta.selectedRatio) setRatio(restored.meta.selectedRatio);
          W = restored.meta.W || W;
          H = restored.meta.H || H;
          elapsedMs = restored.meta.elapsedMs || 0;
        }
        if (restored.lastBlob) {
          lastShotUrl = URL.createObjectURL(restored.lastBlob);
          $('lastShotImg').src = lastShotUrl;
          $('lastShotImg').style.display = 'block';
          $('placeholder').style.display = 'none';
        }
        updateStats(true);
        $('exportCard').style.display = 'grid';
        $('dbStatus').textContent = `復元済 (${frames.length}枚)`;
        setBadge('done', '復元完了');
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
  stopPreviewStream();
  if (wakeLock) wakeLock.release().catch(() => {});
});
