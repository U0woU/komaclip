# KomaClip (ver.1.0.0) — 省電力・タイムラプス撮影ツール

https://u0wou.github.io/komaclip/

複数カメラのデバイスID選択、静止（離席）コマの自動破棄、手動コマ整理、バックグラウンド安定撮影、WebM書き出しに特化した軽量・モノクロUI版です。

## 主な特徴
- **バージョン確認（`ver.1.0.1`）**: 右上の「設定」ボタンからバージョンやバックグラウンド安定モード、露出待ち時間、ストレージ消去を確認・操作できます。
- **10〜40秒ランダム撮影間隔**: 撮影間隔に「ランダム（10〜40秒）」を搭載（固定間隔 5/10/15/20/30秒も選択可能）。撮影ステージ下の黒色プログレスバーと残り秒数で進行状況を確認できます。
- **手動コマ整理（横長フィルムストリップ）**: 「コマ整理」ボタンを押したときだけ横長のサムネイルバーを表示し、不要なコマを選択して**一時削除（復元可能）**または**完全削除**できます（書き出し直前に自動表示されることはありません）。
- **バックグラウンド安定撮影**: 別ブラウザや別アプリを見ている間も撮影が止まりにくいよう、Web Workerタイマー・無音AudioContextによるタブ凍結防止・低FPSカメラ保持・`ImageCapture.grabFrame()` 直接取得を組み合わせています（設定から従来の間欠起動へも切替可能）。
- **PC・スマホ最適化モノクロUI**: 左サイドバーを廃止し、スマートフォンでも押しやすく読みやすいレイアウトとモノクロのダーク／ライトテーマに統一しました。

## ローカル起動方法
```bash
python -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## 緊急時のデータ救出（IndexedDB → WebM 書き出し）
何らかのエラーでアプリ画面から書き出せなくなった場合でも、撮影データはブラウザ内の IndexedDB（`KomaClipDB`）に残っています（録画スタートやデータ消去を押さない限り消えません）。

KomaClip を開いているタブで `F12` を押し、**Console** タブに以下のコードを貼り付けて Enter を押すと、元データを消さずに WebM を生成して画面右上にダウンロードボタンを表示します（貼り付け時に `allow pasting` の入力を求められた場合は、先に入力して Enter してください）。

```js
(async () => {
  try {
    console.log('1. IndexedDBを確認中...');
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('KomaClipDB');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const getAll = (store) => new Promise((res, rej) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    const meta = (await getAll('meta'))[0] || {};
    const frames = await getAll('frames');
    console.log(`2. 検出コマ数: ${frames.length}枚`, meta);
    if (frames.length < 2) return console.warn('コマが2枚未満のため書き出せません');

    const W = meta.W || 480, H = meta.H || 854, fps = 15;
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    c.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    document.body.appendChild(c);
    const ctx = c.getContext('2d');

    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(c.captureStream(fps), mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : {});
    const chunks = [];
    const done = new Promise(r => rec.onstop = r);
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    rec.start();

    const delay = 1000 / fps, t0 = performance.now();
    for (let i = 0; i < frames.length; i++) {
      const bmp = await createImageBitmap(frames[i].blob);
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();
      if (i % 15 === 0 || i === frames.length - 1) {
        console.log(`3. 変換中: ${i + 1} / ${frames.length}`);
      }
      await new Promise(r => setTimeout(r, Math.max(0, t0 + (i + 1) * delay - performance.now())));
    }
    await new Promise(r => setTimeout(r, delay));
    rec.stop();
    await done;
    c.remove();
    db.close();

    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `komaclip_rescue_${Date.now()}.webm`;
    a.textContent = `救出WebMをダウンロード (${(blob.size / 1024 / 1024).toFixed(2)} MB / ${frames.length}枚)`;
    a.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;padding:12px 18px;background:#fff;color:#000;border:2px solid #000;border-radius:8px;font:700 14px sans-serif;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,0.4);';
    document.body.appendChild(a);
    console.log('4. 完了！画面右上の白いボタンをクリックして保存してください。');
  } catch (e) {
    console.error('救出エラー:', e);
  }
})();
```
