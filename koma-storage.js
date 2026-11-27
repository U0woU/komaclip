export class KomaStorage {
  constructor(dbName = 'KomaClipDB', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this._queue = Promise.resolve();
  }

  async init() {
    if (this.db) return this.db;
    if (typeof indexedDB === 'undefined') {
      throw new Error('このブラウザ環境では IndexedDB が利用できません。');
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('frames')) {
          db.createObjectStore('frames', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
        };
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  _enqueue(task) {
    this._queue = this._queue.then(task, task);
    return this._queue;
  }

  saveMeta(data) {
    return this._enqueue(async () => {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'current', ...data, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  addFrame({ blob, elapsedMs = 0 }) {
    return this._enqueue(async () => {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('frames', 'readwrite');
        const req = tx.objectStore('frames').add({
          blob,
          elapsedMs,
          createdAt: Date.now()
        });
        req.onsuccess = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  async restoreAll() {
    const db = await this.init();
    const meta = await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction('frames', 'readonly');
      const req = tx.objectStore('frames').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const frames = records.map((r, idx) => ({
      id: r.id,
      blob: r.blob,
      elapsedMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : idx * 10000
    }));
    return { meta, frames };
  }

  clearAll() {
    return this._enqueue(async () => {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['meta', 'frames'], 'readwrite');
        tx.objectStore('meta').clear();
        tx.objectStore('frames').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  }
}
