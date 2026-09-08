const IDB_DB_NAME = "greenlake_autoresearch_logger";
export const IDB_STORE_NAME = "runs";

export function openRunDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = () => {
      settled = true;
      resolve(null);
    };
    let request: IDBOpenDBRequest;
    try {
      if (!("indexedDB" in window)) {
        fail();
        return;
      }
      request = window.indexedDB.open(IDB_DB_NAME, 1);
    } catch {
      fail();
      return;
    }
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) db.createObjectStore(IDB_STORE_NAME);
      } catch {
        fail();
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = fail;
    request.onblocked = fail;
  });
}

export async function putRunDatabaseValue(key: string, value: unknown): Promise<boolean> {
  const db = await openRunDatabase();
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readwrite");
      transaction.objectStore(IDB_STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export async function getRunDatabaseValue<T>(key: string): Promise<T | null> {
  const db = await openRunDatabase();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readonly");
      let value: T | null = null;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
      const request = transaction.objectStore(IDB_STORE_NAME).get(key);
      request.onsuccess = () => { value = (request.result as T | undefined) ?? null; };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function deleteRunDatabaseValue(key: string): Promise<boolean> {
  const db = await openRunDatabase();
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(IDB_STORE_NAME, "readwrite");
      transaction.objectStore(IDB_STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}
