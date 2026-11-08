// Keeps the day's downloaded data (bulletin with all markets, team statistics) on the phone,
// so the heavy download + analysis runs once a day instead of on every open.
// IndexedDB is used because the data is a few MB (too big for localStorage).

const DB = 'sistem-kupon';
const STORE = 'daily';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDay() {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get('day');
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function saveDay(value) {
  try {
    const db = await open();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, 'day');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch { /* private mode / storage full: the app still works, it just downloads again */ }
}
