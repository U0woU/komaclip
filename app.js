import { KomaStorage } from './koma-storage.js';

const $ = (id) => document.getElementById(id);
const storage = new KomaStorage();
const RATIOS = { '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '1:1': [1, 1] };

// ===== State =====
let previewStream = null;
let facingMode = 'environment';
let wakeLock = null;
let selectedRatio = '9:16', W = 480, H = 854;
let isRecording = false, isPaused = false, isCapturing = false;
let elapsedMs = 0, lastTick = 0, nextShotTime = 0, worker = null, workerUrl = null;

let frames = [];
let droppedStillCount = 0;
let prevDiffData = null;
let lastShotUrl = null;

// ===== Offscreen Canvases =====
const makeCanvas = (w = 0, h = 0, opt) => {
  const c = document.createElement('canvas');
  if (w) c.width = w;
  if (h) c.height = h;
  return [c, c.getContext('2d', opt)];
};
const [capCanvas, capCtx] = makeCanvas();
const [diffCanvas, diffCtx] = makeCanvas(64, 36, { willReadFrequently: true });

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

function getFps() {
  return Number($('fpsSelect').value || 15);
}

function updateStats() {
  const fps = getFps();
  $('frameCount').innerHTML = `${frames.length}<span>枚</span>`;
  $('elapsed').textContent = formatTime(elapsedMs);
  $('estDuration').innerHTML = `${(frames.length / fps).toFixed(1)}<span>秒</span>`;
  $('droppedCount').innerHTML = `${droppedStillCount}<span>枚</span>`;
  $('psStats').textContent = `${frames.length}枚 ・ ${formatTime(elapsedMs)}`;
  $('exportWebmBtn').textContent = `⬇ WebM書き出し (${frames.length}枚)`;
  $('exportWebmBtn').disabled = isRecording || frames.length < 2;
}

// ===== UI: Sidebar, Tabs, Theme =====
$('sidebarToggleBtn').onclick = () => $('appShell').classList.toggle('sidebar-collapsed');

document.querySelectorAll('.nav-item').forEach(el => {
  el.onclick = () => {
    const tab = el.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === el));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  };
});

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').textContent = t === 'light' ? '☀️ ライト' : '🌙 ダーク';
  localStorage.setItem('komaclip_theme', t);
}
applyTheme(localStorage.getItem('komaclip_theme') || 'dark');
$('themeBtn').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');

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
  $('ratioGroup').querySelectorAll('.ratio-btn').forEach(b => b.classList.toggle('active', b.dataset.ratio === selectedRatio));
  calcOutputSize();
  renderGuide();
}

$('resSelect').onchange = () => {
  if (isRecording) return;
  calcOutputSize();
  $('hint').textContent = `出力解像度を ${W}×${H} (${selectedRatio}) に変更しました`;
};
$('fpsSelect').onchange = updateStats;

$('ratioGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.ratio-btn');
  if (!btn || isRecording) return;
  setRatio(btn.dataset.ratio);
});

$('stillThreshold').oninput = () => {
  $('stillThVal').textContent = `感度 ${Number($('stillThreshold').value).toFixed(1)}`;
};

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

// ===== Camera Control (On-Demand Start & Immediate Stop) =====
function stopPreviewStream() {
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
  const preview = $('preview');
  preview.srcObject = null;
  $('connectCamBtn').textContent = '📷 構図確認（カメラON）';
}

async function openCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザまたは非HTTPS環境ではカメラAPIを利用できません');
  }
  const base = Number($('resSelect').value || 854);
  const idealW = base >= 1920 ? 1920 : 1280;
  const idealH = base >= 1920 ? 1080 : 720;
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: idealW },
      height: { ideal: idealH },
      frameRate: { ideal: 30 }
    },
    audio: false
  });
}

async function waitVideoReady(videoEl, timeoutMs = 3000) {
  const start = performance.now();
  while (videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('カメラ映像の初期化がタイムアウトしました');
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

// 構図確認用の手動ON/OFF（録画開始時は自動でOFFにして発熱防止）
async function togglePreviewCamera() {
  if (isRecording) return;
  if (previewStream) {
    stopPreviewStream();
    setBadge('', 'カメラ停止中');
    $('hint').textContent = '構図確認カメラを停止しました（発熱・電力消費ゼロ）';
    return;
  }
  try {
    $('hint').textContent = '構図確認のためカメラを起動中...';
    previewStream = await openCameraStream();
    const preview = $('preview');
    preview.srcObject = previewStream;
    await preview.play();
    await waitVideoReady(preview);
    $('lastShotImg').style.display = 'none';
    $('placeholder').style.display = 'none';
    $('camSleepBadge').style.display = 'none';
    $('connectCamBtn').textContent = '⏹ 構図確認を終了（カメラOFF）';
    setBadge('', '構図確認中');
    $('hint').textContent = '画角を確認したら「間欠録画スタート」を押してください（自動で間欠駆動に切り替わります）';
  } catch (e) {
    stopPreviewStream();
    setBadge('', 'エラー');
    $('hint').textContent = 'カメラ接続失敗: ' + e.message;
  }
}
$('connectCamBtn').onclick = $('heroCamBtn').onclick = togglePreviewCamera;
$('switchCamBtn').onclick = async () => {
  if (isRecording) return;
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  if (previewStream) {
    stopPreviewStream();
    await togglePreviewCamera();
  } else {
    $('hint').textContent = `使用カメラを ${facingMode === 'environment' ? '背面/外付け' : '前面'} に切り替えました`;
  }
};

// ===== Crop & Motion Detection =====
function drawCroppedTo(videoEl, ctx, dstW, dstH) {
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  if (!vw || !vh) return false;
  const srcR = vw / vh, dstR = dstW / dstH;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcR > dstR) { sw = vh * dstR; sx = (vw - sw) / 2; }
  else { sh = vw / dstR; sy = (vh - sh) / 2; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, dstW, dstH);
  return true;
}

function evaluateMotion(videoEl) {
  if (!drawCroppedTo(videoEl, diffCtx, 64, 36)) {
    return { score: 100, snapshot: null };
  }
  const cur = diffCtx.getImageData(0, 0, 64, 36).data;
  if (!prevDiffData) {
    return { score: 100, snapshot: new Uint8ClampedArray(cur) };
  }
  let sum = 0;
  for (let i = 0; i < cur.length; i += 4) {
    const y1 = (cur[i] * 77 + cur[i + 1] * 150 + cur[i + 2] * 29) >> 8;
    const y2 = (prevDiffData[i] * 77 + prevDiffData[i + 1] * 150 + prevDiffData[i + 2] * 29) >> 8;
    sum += Math.abs(y1 - y2);
  }
  return { score: sum / (64 * 36), snapshot: new Uint8ClampedArray(cur) };
}

// ===== One-Shot Capture (Start Camera -> Capture -> Stop Camera Immediately) =====
async function captureOneShotBurst() {
  if (isCapturing || !isRecording) return;
  isCapturing = true;

  let tempStream = null;
  const tempVideo = document.createElement('video');
  tempVideo.muted = true;
  tempVideo.playsInline = true;

  try {
    $('camSleepBadge').textContent = '📸 カメラ起動・撮影中...';
    $('camSleepBadge').style.display = 'block';

    tempStream = await openCameraStream();
    tempVideo.srcObject = tempStream;
    await tempVideo.play();
    await waitVideoReady(tempVideo);

    // オート露出・ホワイトバランス安定待ち
    const warmupMs = Number($('warmupMsSelect')?.value || 600);
    await new Promise(r => setTimeout(r, warmupMs));

    // 待機中に録画終了された場合は保存せず即座に抜ける
    if (!isRecording) return;

    const { score, snapshot } = evaluateMotion(tempVideo);
    if (!snapshot) return;

    const autoDrop = $('autoDropStillCheck').checked;
    const threshold = Number($('stillThreshold').value);

    // 2枚目以降で動きが閾値未満なら「止まっている画像」として即破棄（基準画像 prevDiffData は更新しない）
    if (autoDrop && prevDiffData && score < threshold) {
      droppedStillCount++;
      updateStats();
      $('hint').textContent = `🟠 静止画像を検知して破棄しました（動き差分: ${score.toFixed(2)} < ${threshold}）`;
      return;
    }

    if (!drawCroppedTo(tempVideo, capCtx, W, H)) return;
    prevDiffData = snapshot;

    const blob = await new Promise(r => capCanvas.toBlob(r, 'image/jpeg', 0.90));
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

    frames.push({ id, blob, elapsedMs: frameElapsed });

    if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
    lastShotUrl = URL.createObjectURL(blob);
    const imgEl = $('lastShotImg');
    imgEl.src = lastShotUrl;
    imgEl.style.display = 'block';
    $('placeholder').style.display = 'none';

    updateStats();
    $('hint').textContent = `✅ コマ #${frames.length} 保存完了（動き差分: ${score.toFixed(1)}）→ カメラ即停止`;

    if (!$('powerSaveOverlay').classList.contains('active')) {
      const fl = $('flash');
      fl.classList.remove('fire');
      void fl.offsetWidth;
      fl.classList.add('fire');
    }
  } catch (e) {
    $('hint').textContent = '撮影エラー: ' + e.message;
  } finally {
    // 撮影が終わったら必ず即座にトラックを停止してカメラをオフにする
    if (tempStream) {
      tempStream.getTracks().forEach(t => t.stop());
    }
    tempVideo.srcObject = null;
    if (isRecording) {
      $('camSleepBadge').textContent = '💤 カメラ停止中（次の撮影まで待機）';
      $('camSleepBadge').style.display = 'block';
    } else {
      $('camSleepBadge').style.display = 'none';
    }
    isCapturing = false;
  }
}

// ===== Worker Timer =====
function stopWorkerTimer() {
  if (worker) { worker.terminate(); worker = null; }
  if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
}

function startWorkerTimer() {
  stopWorkerTimer();
  workerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), 250);`], { type: 'application/javascript' }));
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
      await captureOneShotBurst();
    }
  };
}

// ===== Recording Controls =====
$('startBtn').onclick = async () => {
  stopPreviewStream();

  try { await storage.clearAll(); } catch {}
  calcOutputSize();
  try { await storage.saveMeta({ W, H, selectedRatio, elapsedMs: 0 }); } catch {}

  if (lastShotUrl) { URL.revokeObjectURL(lastShotUrl); lastShotUrl = null; }
  $('lastShotImg').style.display = 'none';

  frames = [];
  droppedStillCount = 0;
  prevDiffData = null;
  elapsedMs = 0;
  isRecording = true;
  isPaused = false;
  lastTick = Date.now();
  nextShotTime = lastTick + Number($('intervalSelect').value);

  $('startBtn').disabled = $('resSelect').disabled = $('connectCamBtn').disabled = $('switchCamBtn').disabled = true;
  $('pauseBtn').disabled = $('stopRecBtn').disabled = false;
  $('exportCard').style.display = 'none';
  $('downloadLinks').innerHTML = '';
  setBadge('recording', '間欠録画中');
  updateStats();

  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }

  await captureOneShotBurst();
  startWorkerTimer();
};

$('pauseBtn').onclick = () => {
  if (!isRecording) return;
  isPaused = !isPaused;
  $('pauseBtn').textContent = isPaused ? '▶ 再開' : '⏸ 一時停止';
  setBadge(isPaused ? 'paused' : 'recording', isPaused ? '一時停止' : '間欠録画中');
  if (!isPaused) {
    lastTick = Date.now();
    nextShotTime = lastTick + Number($('intervalSelect').value);
  }
};

$('stopRecBtn').onclick = () => {
  isRecording = isPaused = false;
  stopWorkerTimer();
  $('nextShotBar').style.width = '0%';
  $('camSleepBadge').style.display = 'none';
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }

  $('startBtn').disabled = $('resSelect').disabled = $('connectCamBtn').disabled = $('switchCamBtn').disabled = false;
  $('pauseBtn').disabled = $('stopRecBtn').disabled = true;
  $('pauseBtn').textContent = '⏸ 一時停止';
  setBadge('done', '撮影完了');
  updateStats();

  if (frames.length >= 2) {
    $('exportCard').style.display = 'grid';
    $('hint').textContent = `撮影終了（採用 ${frames.length}枚 / 静止破棄 ${droppedStillCount}枚）。「WebM書き出し」で出力できます。`;
  } else {
    $('hint').textContent = '採用コマが2枚未満のため動画化できません。';
  }
};

$('powerSaveBtn').onclick = () => $('powerSaveOverlay').classList.add('active');
$('psExitBtn').onclick = $('powerSaveOverlay').ondblclick = () => $('powerSaveOverlay').classList.remove('active');

// ===== Direct WebM Export (for External Video Editors) =====
const setProgress = (active, label = '', pct = 0) => {
  $('progressWrap').classList.toggle('active', active);
  $('progressLabel').textContent = label;
  $('progressPct').textContent = Math.round(pct) + '%';
  $('progressFill').style.width = pct + '%';
};

$('exportWebmBtn').onclick = async () => {
  if (frames.length < 2) return alert('書き出すコマが2枚以上必要です');
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
    ].find(m => MediaRecorder.isTypeSupported(m)) || '';

    const stream = comp.captureStream(fps);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : {});
    const chunks = [];
    const done = new Promise(r => rec.onstop = r);
    rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    rec.start();
    const delay = 1000 / fps;
    const t0 = performance.now();

    for (let i = 0; i < frames.length; i++) {
      const bmp = await createImageBitmap(frames[i].blob);
      cctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();

      setProgress(true, `WebM生成中... (${i + 1}/${frames.length})`, ((i + 1) / frames.length) * 96);

      // デコード時間を含めたドリフト補正でフレーム間隔を安定化
      const nextTarget = t0 + (i + 1) * delay;
      const waitMs = Math.max(0, nextTarget - performance.now());
      await new Promise(r => setTimeout(r, waitMs));
    }

    await new Promise(r => setTimeout(r, delay));
    rec.stop();
    await done;

    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    if (blob.size === 0) throw new Error('WebMデータが0バイトになりました');

    const a = Object.assign(document.createElement('a'), {
      className: 'dl-link',
      href: URL.createObjectURL(blob),
      download: `komaclip_${Date.now()}.webm`,
      textContent: `⬇ WebM をダウンロード (${(blob.size / 1024 / 1024).toFixed(2)} MB / ${frames.length}コマ)`
    });
    $('downloadLinks').prepend(a);
    a.click();
    setBadge('done', 'WebM保存完了');
    $('hint').textContent = 'WebMファイルを書き出しました。編集ソフトに読み込んで編集してください。';
  } catch (e) {
    alert('WebM書き出しエラー: ' + e.message);
  } finally {
    comp.remove();
    setProgress(false);
    $('exportWebmBtn').disabled = false;
  }
};

// ===== DB Clear & Restore =====
$('settingsClearDbBtn').onclick = async () => {
  if (!confirm('保存されている撮影データをすべて消去しますか？')) return;
  try { await storage.clearAll(); } catch {}
  frames = [];
  droppedStillCount = 0;
  prevDiffData = null;
  elapsedMs = 0;
  if (lastShotUrl) { URL.revokeObjectURL(lastShotUrl); lastShotUrl = null; }
  $('lastShotImg').style.display = 'none';
  $('placeholder').style.display = 'grid';
  $('exportCard').style.display = 'none';
  $('downloadLinks').innerHTML = '';
  updateStats();
  $('dbStatus').textContent = '消去済み';
};

(async () => {
  try {
    const restored = await storage.restoreAll();
    if (restored.frames.length > 0) {
      if (confirm(`前回の未出力データ（${restored.frames.length}枚）が見つかりました。復元しますか？`)) {
        frames = restored.frames;
        if (restored.meta) {
          if (restored.meta.selectedRatio) setRatio(restored.meta.selectedRatio);
          W = restored.meta.W || W;
          H = restored.meta.H || H;
          elapsedMs = restored.meta.elapsedMs || 0;
        }
        const last = frames[frames.length - 1];
        if (last?.blob) {
          lastShotUrl = URL.createObjectURL(last.blob);
          $('lastShotImg').src = lastShotUrl;
          $('lastShotImg').style.display = 'block';
          $('placeholder').style.display = 'none';
        }
        updateStats();
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
