import type { ExportRow } from './export-api.ts';

/** Where a download stands, kept so a reload resumes it: the cursor Main gave and how much came with it. */
export interface ExportProgress { snapshot: string; cursor: string | null; pages: number; rows: number; done: boolean }
export interface ExportStore {
  progress: (agent: string) => Promise<ExportProgress | null>;
  /** Writes the page and the progress that includes it together, so a reload never sees one without the other. */
  append: (agent: string, progress: ExportProgress, rows: readonly ExportRow[]) => Promise<void>;
  pages: (agent: string) => Promise<ExportRow[][]>;
  clear: (agent: string) => Promise<void>;
}

const pad = (page: number) => String(page).padStart(6, '0');

/** Pages are too large for `localStorage`, so each is its own IndexedDB record. */
export function indexedDbExportStore(name = 'rezics-library-export'): ExportStore {
  const database = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('records'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const done = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const finished = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  const range = (agent: string, kind: string) => IDBKeyRange.bound(`${agent}|${kind}|`, `${agent}|${kind}|￿`);
  return {
    async progress(agent) {
      const db = await database();
      return await done(db.transaction('records').objectStore('records').get(`${agent}|progress|`)) ?? null;
    },
    async append(agent, progress, rows) {
      const db = await database();
      const transaction = db.transaction('records', 'readwrite');
      transaction.objectStore('records').put(rows, `${agent}|page|${pad(progress.pages - 1)}`);
      transaction.objectStore('records').put(progress, `${agent}|progress|`);
      await finished(transaction);
    },
    async pages(agent) {
      const db = await database();
      return done(db.transaction('records').objectStore('records').getAll(range(agent, 'page')));
    },
    async clear(agent) {
      const db = await database();
      const transaction = db.transaction('records', 'readwrite');
      transaction.objectStore('records').delete(range(agent, 'page'));
      transaction.objectStore('records').delete(`${agent}|progress|`);
      await finished(transaction);
    },
  };
}

export function memoryExportStore(): ExportStore {
  const held = new Map<string, { progress: ExportProgress; pages: ExportRow[][] }>();
  return {
    progress: async agent => held.get(agent)?.progress ?? null,
    async append(agent, progress, rows) {
      held.set(agent, { progress, pages: [...held.get(agent)?.pages ?? [], [...rows]] });
    },
    pages: async agent => held.get(agent)?.pages ?? [],
    clear: async agent => { held.delete(agent); },
  };
}
