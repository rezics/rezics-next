import type { ApplyIntent, ImportFormat } from './import-api.ts';

/**
 * The imports this browser has not finished. Main keeps the upload for seven days, so the page can only
 * list what it remembered: the file's id, which is all that is needed to come back to it.
 */
export interface PendingImport { id: string; format: ImportFormat; name: string; total: number; createdAt: number;
  /** Fixed when apply starts; Main refuses a resumed apply with a different context or language. */
  intent: ApplyIntent | null }
export interface ImportShelf {
  list: (agent: string) => PendingImport[];
  save: (agent: string, entry: PendingImport) => void;
  remove: (agent: string, id: string) => void;
}

/** Main's retention (`docs/contracts/source-lifecycle.md#reader-upload-retention`). */
export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const keyOf = (agent: string) => `rezics:library-imports:${agent}`;

function entries(text: string | null, now: number): PendingImport[] {
  try {
    const parsed: unknown = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is PendingImport => typeof entry?.id === 'string'
      && typeof entry.createdAt === 'number' && now - entry.createdAt < UPLOAD_RETENTION_MS) : [];
  } catch { return []; }
}

/** `localStorage`, tolerating a browser that refuses it: the import then simply is not remembered. */
export const browserImportShelf: ImportShelf = {
  list(agent) {
    try { return entries(localStorage.getItem(keyOf(agent)), Date.now()); } catch { return []; }
  },
  save(agent, entry) {
    try {
      const others = entries(localStorage.getItem(keyOf(agent)), Date.now()).filter(item => item.id !== entry.id);
      localStorage.setItem(keyOf(agent), JSON.stringify([...others, entry]));
    } catch { /* not remembered */ }
  },
  remove(agent, id) {
    try {
      localStorage.setItem(keyOf(agent), JSON.stringify(entries(localStorage.getItem(keyOf(agent)), Date.now())
        .filter(item => item.id !== id)));
    } catch { /* nothing to forget */ }
  },
};

export function memoryImportShelf(initial: readonly PendingImport[] = []): ImportShelf {
  let held = [...initial];
  return {
    list: () => [...held],
    save: (_agent, entry) => { held = [...held.filter(item => item.id !== entry.id), entry]; },
    remove: (_agent, id) => { held = held.filter(item => item.id !== id); },
  };
}
