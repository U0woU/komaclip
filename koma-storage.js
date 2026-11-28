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
      throw new Error('IndexedDB が利用できません');
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
          excluded: false,
          createdAt: Date.now()
        });
        req.onsuccess = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  async getFrameBlob(id) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('frames', 'readonly');
      const req = tx.objectStore('frames').get(id);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => reject(req.error);
    });
  }

  deleteFrame(id) {
    return this._enqueue(async () => {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('frames', 'readwrite');
        tx.objectStore('frames').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  setFrameExcluded(id, excluded) {
    return this._enqueue(async () => {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('frames', 'readwrite');
        const store = tx.objectStore('frames');
        const req = store.get(id);
        req.onsuccess = () => {
          const rec = req.result;
          if (rec) {
            rec.excluded = !!excluded;
            store.put(rec);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  async restoreSummary() {
    const db = await this.init();
    const meta = await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    const frames = [];
    let lastBlob = null;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('frames', 'readonly');
      const req = tx.objectStore('frames').openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        const r = cursor.value;
        frames.push({
          id: r.id,
          blob: null,
          excluded: !!r.excluded,
          elapsedMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : frames.length * 10000
        });
        if (!r.excluded && r.blob) lastBlob = r.blob;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return { meta, frames, lastBlob };
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
