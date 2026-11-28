import { KomaStorage } from './koma-storage.js?v=1.0.2';

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

// Fallback IndexedDB helpers
async function loadFrameBlobSafe(frame) {
  if (frame.blob) return frame.blob;
  if (frame.id == null) return null;
  if (typeof storage.getFrameBlob === 'function') {
    return await storage.getFrameBlob(frame.id);
  }
  const db = await storage.init();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('frames', 'readonly');
    const req = tx.objectStore('frames').get(frame.id);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror = () => reject(req.error);
  });
}

async function restoreSummarySafe() {
  if (typeof storage.restoreSummary === 'function') {
    return await storage.restoreSummary();
  }
  if (typeof storage.restoreAll === 'function') {
    const old = await storage.restoreAll();
    const list = (old.frames || []).map((r) => ({
      id: r.id,
      blob: r.blob || null,
      excluded: !!r.excluded,
      elapsedMs: r.elapsedMs || 0
    }));
    const lastBlob = list.length > 0 ? list[list.length - 1].blob : null;
    return { meta: old.meta || null, frames: list, lastBlob };
  }
  return { meta: null, frames: [], lastBlob: null };
}

// ===== State =====
let previewStream = null;
let bgStream = null;
let bgVideo = null;
let bgAudioCtx = null;
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
let workerPendingSleeps = new Map();
let workerSleepSeq = 1;

let frames = [];
let droppedStillCount = 0;
let prevLuma = null;
let lastShotUrl = null;
let lastStatKey = '';

// Filmstrip state (only active when user clicks "コマ整理")
let isFilmstripOpen = false;
let selectedFrameKeys = new Set();
let filmThumbUrls = [];

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

function getActiveFrames() {
  return frames.filter((f) => !f.excluded);
}

function getFrameKey(f, idx) {
  return f.id != null ? `id:${f.id}` : `idx:${idx}:${f.elapsedMs}`;
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
  const activeCount = getActiveFrames().length;
  const totalCount = frames.length;
  const timeStr = formatTime(elapsedMs);
  const estStr = (activeCount / fps).toFixed(1);
  const key = `${activeCount}|${totalCount}|${timeStr}|${estStr}|${droppedStillCount}|${isRecording}`;
  if (!force && key === lastStatKey) return;
  lastStatKey = key;

  $('frameCount').textContent = String(activeCount);
  $('elapsed').textContent = timeStr;
  $('estDuration').textContent = estStr;
  $('droppedCount').textContent = String(droppedStillCount);
  $('psStats').textContent = `${activeCount}枚 ・ ${timeStr}`;
  $('exportWebmBtn').textContent = `WebM書き出し (${activeCount}枚)`;
  $('exportWebmBtn').disabled = isRecording || activeCount < 2;
  $('manageFramesBtn').textContent = `コマ整理 (${totalCount}枚)`;
  $('manageFramesBtn').disabled = totalCount === 0;
}

// ===== Background Keep-Alive (Silent AudioContext) =====
function startBgAudioKeepAlive() {
  stopBgAudioKeepAlive();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    bgAudioCtx = new AudioCtx();
    const osc = bgAudioCtx.createOscillator();
    const gain = bgAudioCtx.createGain();
    osc.frequency.value = 1;
    gain.gain.value = 0.00001;
    osc.connect(gain);
    gain.connect(bgAudioCtx.destination);
    osc.start();
    if (bgAudioCtx.state === 'suspended') {
      bgAudioCtx.resume().catch(() => {});
    }
  } catch {}
}

function stopBgAudioKeepAlive() {
  if (bgAudioCtx) {
    bgAudioCtx.close().catch(() => {});
    bgAudioCtx = null;
  }
}

// ===== Worker Timer & Unthrottled Sleep =====
function stopWorkerTimer() {
  for (const [, resolve] of workerPendingSleeps) resolve();
  workerPendingSleeps.clear();
  if (worker) { worker.terminate(); worker = null; }
  if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
}

function workerSleep(ms) {
  if (!worker) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve) => {
    const id = workerSleepSeq++;
    workerPendingSleeps.set(id, resolve);
    worker.postMessage({ type: 'sleep', id, ms });
  });
}

function scheduleNextShot(now) {
  currentIntervalMs = getNextIntervalMs();
  nextShotTime = now + currentIntervalMs;
  updateIntervalNote();
}

function startWorkerTimer() {
  stopWorkerTimer();
  const code = `
    setInterval(() => postMessage({ type: 'tick' }), 1000);
    onmessage = (e) => {
      if (e.data && e.data.type === 'sleep') {
        setTimeout(() => postMessage({ type: 'wake', id: e.data.id }), e.data.ms);
      }
    };
  `;
  workerUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  worker = new Worker(workerUrl);
  worker.onmessage = async (e) => {
    const data = e.data;
    if (data?.type === 'wake') {
      const fn = workerPendingSleeps.get(data.id);
      if (fn) {
        workerPendingSleeps.delete(data.id);
        fn();
      }
      return;
    }
    if (!isRecording || isPaused) return;
    const now = Date.now();
    elapsedMs += now - lastTick;
    lastTick = now;
    updateStats();

    const remain = Math.max(0, nextShotTime - now);
    const pct = Math.min(100, ((currentIntervalMs - remain) / currentIntervalMs) * 100);
    $('nextShotBar').style.width = `${pct.toFixed(1)}%`;
    $('shotBarRemain').textContent = `残り ${Math.ceil(remain / 1000)}秒 / ${Math.round(currentIntervalMs / 1000)}秒`;

    if (now >= nextShotTime && !isCapturing) {
      scheduleNextShot(now);
      await captureOneShotBurst();
    }
  };
}

// Recover immediately if returning from deep OS sleep
document.addEventListener('visibilitychange', async () => {
  if (!isRecording || isPaused) return;
  if (bgAudioCtx && bgAudioCtx.state === 'suspended') {
    bgAudioCtx.resume().catch(() => {});
  }
  if (!document.hidden && Date.now() >= nextShotTime && !isCapturing) {
    const now = Date.now();
    scheduleNextShot(now);
    await captureOneShotBurst();
  }
});

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
const savedBgMode = storeGet('komaclip_bg_stable', '1');
$('bgStableModeCheck').checked = savedBgMode !== '0';
$('bgStableModeCheck').addEventListener('change', () => {
  storeSet('komaclip_bg_stable', $('bgStableModeCheck').checked ? '1' : '0');
});

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

// ===== Manual Frame Filmstrip (Only opened via button) =====
function revokeFilmThumbs() {
  for (const url of filmThumbUrls) URL.revokeObjectURL(url);
  filmThumbUrls = [];
}

function updateFilmstripButtons() {
  const count = selectedFrameKeys.size;
  $('filmstripSelectionInfo').textContent = `${count}枚選択中（有効 ${getActiveFrames().length} / 全 ${frames.length}枚）`;
  $('filmToggleExcludeBtn').disabled = count === 0;
  $('filmDeleteBtn').disabled = count === 0;
  $('filmClearSelBtn').disabled = count === 0;
}

async function renderFilmstrip() {
  revokeFilmThumbs();
  const bar = $('filmstripBar');
  bar.innerHTML = '';

  if (frames.length === 0) {
    bar.innerHTML = '<div class="filmstrip-empty">保存されているコマはありません</div>';
    selectedFrameKeys.clear();
    updateFilmstripButtons();
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const key = getFrameKey(f, i);
    const item = document.createElement('div');
    item.className = 'film-item';
    if (selectedFrameKeys.has(key)) item.classList.add('selected');
    if (f.excluded) item.classList.add('excluded');
    item.dataset.key = key;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'film-thumb-wrap';

    const img = document.createElement('img');
    img.alt = `コマ #${i + 1}`;
    img.loading = 'lazy';
    thumbWrap.appendChild(img);

    const badge = document.createElement('span');
    badge.className = 'film-badge';
    badge.textContent = `#${i + 1}`;
    thumbWrap.appendChild(badge);

    if (f.excluded) {
      const exTag = document.createElement('div');
      exTag.className = 'film-excluded-tag';
      exTag.textContent = '一時削除中';
      thumbWrap.appendChild(exTag);
    }

    const meta = document.createElement('div');
    meta.className = 'film-meta';
    meta.textContent = formatTime(f.elapsedMs || 0);

    item.appendChild(thumbWrap);
    item.appendChild(meta);
    frag.appendChild(item);

    // Load thumbnail asynchronously
    loadFrameBlobSafe(f).then((blob) => {
      if (!blob || !isFilmstripOpen) return;
      const url = URL.createObjectURL(blob);
      filmThumbUrls.push(url);
      img.src = url;
    }).catch(() => {});
  }
  bar.appendChild(frag);
  updateFilmstripButtons();
}

function setFilmstripOpen(open) {
  isFilmstripOpen = open;
  $('filmstripCard').classList.toggle('open', open);
  if (open) {
    renderFilmstrip();
  } else {
    selectedFrameKeys.clear();
    revokeFilmThumbs();
    $('filmstripBar').innerHTML = '';
  }
}

$('manageFramesBtn').addEventListener('click', () => {
  setFilmstripOpen(!isFilmstripOpen);
});
$('closeFilmstripBtn').addEventListener('click', () => setFilmstripOpen(false));

$('filmstripBar').addEventListener('click', (e) => {
  const item = e.target.closest('.film-item');
  if (!item) return;
  const key = item.dataset.key;
  if (selectedFrameKeys.has(key)) {
    selectedFrameKeys.delete(key);
    item.classList.remove('selected');
  } else {
    selectedFrameKeys.add(key);
    item.classList.add('selected');
  }
  updateFilmstripButtons();
});

$('filmClearSelBtn').addEventListener('click', () => {
  selectedFrameKeys.clear();
  $('filmstripBar').querySelectorAll('.film-item.selected').forEach((el) => el.classList.remove('selected'));
  updateFilmstripButtons();
});

$('filmToggleExcludeBtn').addEventListener('click', async () => {
  if (selectedFrameKeys.size === 0) return;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const key = getFrameKey(f, i);
    if (!selectedFrameKeys.has(key)) continue;
    f.excluded = !f.excluded;
    if (f.id != null && typeof storage.setFrameExcluded === 'function') {
      try { await storage.setFrameExcluded(f.id, f.excluded); } catch {}
    }
  }
  updateStats(true);
  await renderFilmstrip();
  $('hint').textContent = '選択したコマの一時削除／復元を切り替えました';
});

$('filmDeleteBtn').addEventListener('click', async () => {
  const count = selectedFrameKeys.size;
  if (count === 0) return;
  const ok = await askConfirm('完全削除', `選択した ${count}枚 を完全に削除しますか？（元に戻せません）`, '完全削除');
  if (!ok) return;

  const remaining = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const key = getFrameKey(f, i);
    if (selectedFrameKeys.has(key)) {
      if (f.id != null && typeof storage.deleteFrame === 'function') {
        try { await storage.deleteFrame(f.id); } catch {}
      }
    } else {
      remaining.push(f);
    }
  }
  frames = remaining;
  selectedFrameKeys.clear();
  updateStats(true);
  await renderFilmstrip();
  $('hint').textContent = `${count}枚のコマを完全削除しました`;
});

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

// ===== Camera Control (Preview & Background-Stable Stream) =====
function stopPreviewStream() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
  $('preview').srcObject = null;
  $('connectCamBtn').textContent = '構図確認（ON）';
}

function stopBgStream() {
  if (bgStream) {
    bgStream.getTracks().forEach((t) => t.stop());
    bgStream = null;
  }
  if (bgVideo) {
    bgVideo.srcObject = null;
    bgVideo.remove();
    bgVideo = null;
  }
}

async function openCameraStream(lowFps = false) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザまたは非HTTPS環境ではカメラAPIを利用できません');
  }
  const base = Number($('resSelect').value || 854);
  const idealW = base >= 1920 ? 1920 : 1280;
  const idealH = base >= 1920 ? 1080 : 720;

  const videoConstraints = {
    width: { ideal: idealW },
    height: { ideal: idealH },
    frameRate: lowFps ? { ideal: 5, max: 10 } : { ideal: 24 }
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
        video: { width: { ideal: idealW }, height: { ideal: idealH }, frameRate: { ideal: lowFps ? 5 : 24 } },
        audio: false
      });
    }
    throw err;
  }
}

async function waitVideoReady(videoEl, timeoutMs = 6000) {
  const start = performance.now();
  while (videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('カメラ映像の初期化がタイムアウトしました');
    }
    await workerSleep(80);
  }
}

async function ensureBgStreamReady() {
  const track = bgStream?.getVideoTracks()[0];
  if (track && track.readyState === 'live') return bgStream;

  stopBgStream();
  bgStream = await openCameraStream(true);
  bgVideo = document.createElement('video');
  bgVideo.muted = true;
  bgVideo.playsInline = true;
  bgVideo.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.appendChild(bgVideo);
  bgVideo.srcObject = bgStream;
  await bgVideo.play().catch(() => {});
  await waitVideoReady(bgVideo, 6000);
  return bgStream;
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
    previewStream = await openCameraStream(false);
    const preview = $('preview');
    preview.srcObject = previewStream;
    await preview.play();
    await waitVideoReady(preview, 4000);

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

// ===== Lightweight Crop & Motion Detection (Supports both ImageBitmap and Video) =====
function drawCroppedSource(src, ctx, dstW, dstH) {
  const sw0 = src.videoWidth || src.width;
  const sh0 = src.videoHeight || src.height;
  if (!sw0 || !sh0) return false;
  const srcR = sw0 / sh0;
  const dstR = dstW / dstH;
  let sx = 0, sy = 0, sw = sw0, sh = sh0;
  if (srcR > dstR) { sw = sh0 * dstR; sx = (sw0 - sw) / 2; }
  else { sh = sw0 / dstR; sy = (sh0 - sh) / 2; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dstW, dstH);
  return true;
}

function evaluateMotion(src) {
  if (!drawCroppedSource(src, diffCtx, DIFF_W, DIFF_H)) {
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

// Grab frame using ImageCapture API first (works reliably in background tabs)
async function grabFrameSourceFromStream(stream, fallbackVideo) {
  const track = stream.getVideoTracks()[0];
  if (track && typeof window.ImageCapture === 'function') {
    try {
      const ic = new window.ImageCapture(track);
      const bmp = await ic.grabFrame();
      if (bmp && bmp.width > 0) {
        return { source: bmp, cleanup: () => bmp.close() };
      }
    } catch {}
  }
  if (fallbackVideo) {
    if (fallbackVideo.paused) await fallbackVideo.play().catch(() => {});
    await waitVideoReady(fallbackVideo, 5000);
    return { source: fallbackVideo, cleanup: () => {} };
  }
  throw new Error('フレーム取得に失敗しました');
}

// ===== One-Shot Capture (Background-Resilient) =====
async function captureOneShotBurst() {
  if (isCapturing || !isRecording) return;
  isCapturing = true;

  const useBgStable = $('bgStableModeCheck').checked;
  let tempStream = null;
  let tempVideo = null;
  let grabbed = null;

  try {
    $('camSleepBadge').textContent = '撮影中...';
    $('camSleepBadge').style.display = 'block';

    if (useBgStable) {
      const stream = await ensureBgStreamReady();
      grabbed = await grabFrameSourceFromStream(stream, bgVideo);
    } else {
      tempVideo = document.createElement('video');
      tempVideo.muted = true;
      tempVideo.playsInline = true;
      tempStream = await openCameraStream(false);
      tempVideo.srcObject = tempStream;
      await tempVideo.play().catch(() => {});
      await waitVideoReady(tempVideo, 6000);
      const warmupMs = Number($('warmupMsSelect')?.value || 600);
      await workerSleep(warmupMs);
      if (!isRecording) return;
      grabbed = await grabFrameSourceFromStream(tempStream, tempVideo);
    }

    if (!isRecording) return;

    const { score, luma } = evaluateMotion(grabbed.source);
    if (!luma) return;

    const autoDrop = $('autoDropStillCheck').checked;
    const threshold = Number($('stillThreshold').value);

    if (autoDrop && prevLuma && score < threshold) {
      droppedStillCount++;
      updateStats(true);
      $('hint').textContent = `静止画像を破棄しました（差分 ${score.toFixed(1)} < ${threshold}）`;
      return;
    }

    if (!drawCroppedSource(grabbed.source, capCtx, W, H)) return;
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

    frames.push({ id, blob: id ? null : blob, excluded: false, elapsedMs: frameElapsed });

    if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
    lastShotUrl = URL.createObjectURL(blob);
    const imgEl = $('lastShotImg');
    imgEl.src = lastShotUrl;
    imgEl.style.display = 'block';
    $('placeholder').style.display = 'none';

    updateStats(true);
    if (isFilmstripOpen) renderFilmstrip();

    const nextSec = Math.round(currentIntervalMs / 1000);
    $('hint').textContent = `コマ #${frames.length} 保存完了（次回 約${nextSec}秒後）`;

    if (!$('powerSaveOverlay').classList.contains('active') && !document.hidden) {
      const fl = $('flash');
      fl.classList.remove('fire');
      void fl.offsetWidth;
      fl.classList.add('fire');
    }
  } catch (e) {
    $('hint').textContent = `撮影エラー: ${e.message}`;
  } finally {
    if (grabbed) grabbed.cleanup();
    if (tempStream) tempStream.getTracks().forEach((t) => t.stop());
    if (tempVideo) tempVideo.srcObject = null;
    if (isRecording) {
      const nextSec = Math.round(currentIntervalMs / 1000);
      $('camSleepBadge').textContent = useBgStable
        ? `待機中・BG安定（次回 ${nextSec}秒後）`
        : `カメラ停止中（次回 ${nextSec}秒後）`;
      $('camSleepBadge').style.display = 'block';
    } else {
      $('camSleepBadge').style.display = 'none';
    }
    isCapturing = false;
  }
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
  stopBgStream();

  try { await storage.clearAll(); } catch {}
  calcOutputSize();
  try { await storage.saveMeta({ W, H, selectedRatio, elapsedMs: 0 }); } catch {}

  if (lastShotUrl) { URL.revokeObjectURL(lastShotUrl); lastShotUrl = null; }
  $('lastShotImg').style.display = 'none';

  frames = [];
  selectedFrameKeys.clear();
  if (isFilmstripOpen) renderFilmstrip();

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
  setBadge('recording', '録画中');
  updateStats(true);

  if ($('bgStableModeCheck').checked) {
    startBgAudioKeepAlive();
  }
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }

  startWorkerTimer();
  await captureOneShotBurst();
});

$('pauseBtn').addEventListener('click', () => {
  if (!isRecording) return;
  isPaused = !isPaused;
  $('pauseBtn').textContent = isPaused ? '再開' : '一時停止';
  setBadge(isPaused ? 'paused' : 'recording', isPaused ? '一時停止' : '録画中');
  if (!isPaused) {
    lastTick = Date.now();
    scheduleNextShot(lastTick);
  }
});

$('stopRecBtn').addEventListener('click', () => {
  isRecording = false;
  isPaused = false;
  stopWorkerTimer();
  stopBgStream();
  stopBgAudioKeepAlive();
  $('nextShotBar').style.width = '0%';
  $('shotBarRemain').textContent = '--';
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

  const activeCount = getActiveFrames().length;
  if (activeCount >= 2) {
    $('exportCard').style.display = 'grid';
    $('hint').textContent = `撮影終了（有効 ${activeCount}枚 / 破棄 ${droppedStillCount}枚）。WebM書き出しが可能です。`;
  } else {
    $('hint').textContent = '有効コマが2枚未満のため動画化できません。';
  }
});

$('powerSaveBtn').addEventListener('click', () => $('powerSaveOverlay').classList.add('active'));
const exitPowerSave = () => $('powerSaveOverlay').classList.remove('active');
$('psExitBtn').addEventListener('click', exitPowerSave);
$('powerSaveOverlay').addEventListener('dblclick', exitPowerSave);

// ===== Streaming WebM Export (Does NOT auto-open filmstrip) =====
const setProgress = (active, label = '', pct = 0) => {
  $('progressWrap').classList.toggle('active', active);
  $('progressLabel').textContent = label;
  $('progressPct').textContent = `${Math.round(pct)}%`;
  $('progressFill').style.width = `${pct}%`;
};

$('exportWebmBtn').addEventListener('click', async () => {
  const activeFrames = getActiveFrames();
  if (activeFrames.length < 2) {
    $('hint').textContent = '書き出す有効コマが2枚以上必要です';
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

    for (let i = 0; i < activeFrames.length; i++) {
      const blob = await loadFrameBlobSafe(activeFrames[i]);
      if (!blob) continue;

      const bmp = await createImageBitmap(blob);
      cctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();

      setProgress(true, `WebM生成中... (${i + 1}/${activeFrames.length})`, ((i + 1) / activeFrames.length) * 96);

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
      textContent: `WebMをダウンロード (${(outBlob.size / 1024 / 1024).toFixed(2)} MB / ${activeFrames.length}コマ)`
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
    $('exportWebmBtn').disabled = isRecording || getActiveFrames().length < 2;
  }
});

// ===== DB Clear & Startup =====
$('settingsClearDbBtn').addEventListener('click', async () => {
  const ok = await askConfirm('データ消去', '保存されている撮影データをすべて消去しますか？', '消去する');
  if (!ok) return;
  try { await storage.clearAll(); } catch {}
  frames = [];
  selectedFrameKeys.clear();
  if (isFilmstripOpen) setFilmstripOpen(false);
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
    const restored = await restoreSummarySafe();
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
  stopBgStream();
  stopBgAudioKeepAlive();
  revokeFilmThumbs();
  if (wakeLock) wakeLock.release().catch(() => {});
});
