/**
 * Text kept on this device until Main has saved it: written on every change, so
 * a closed tab, a crash or a lost connection never loses typing. `base` is the
 * draft head the text was written on; a different head on Main means someone
 * saved meanwhile and the writer chooses (see `restoreDecision`).
 */
export interface LocalDraft { body: string; base: string | null; changedAt: string }

/** Storage the browser offers; a test or a private window may lack it. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PREFIX = 'rezics:studio:draft:';

/** One key per Studio Agent and text: two Agents never share a device copy. */
export const localDraftKey = (agent: string, resource: string, variant: string) =>
  `${PREFIX}${agent.slice(-36)}:${resource.slice(-36)}:${variant.slice(-36)}`;

export function readLocalDraft(storage: DraftStorage | null, key: string): LocalDraft | null {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as Partial<LocalDraft> | null;
    if (typeof value?.body !== 'string' || (value.base !== null && typeof value.base !== 'string')
      || typeof value.changedAt !== 'string') return null;
    return { body: value.body, base: value.base, changedAt: value.changedAt };
  } catch { return null; }
}

/** Keeps the text; false when the device refused (quota or a disabled store). */
export function writeLocalDraft(storage: DraftStorage | null, key: string, draft: LocalDraft): boolean {
  try { storage?.setItem(key, JSON.stringify(draft)); return Boolean(storage); } catch { return false; }
}

export function clearLocalDraft(storage: DraftStorage | null, key: string): void {
  try { storage?.removeItem(key); } catch { /* nothing kept, nothing to clear */ }
}

export function browserStorage(): DraftStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/**
 * What to open with, given Main's draft head and the device copy: Main's text,
 * the device text on the same head (unsaved typing to save now), or a conflict
 * when Main moved past the head the device text was written on.
 */
export function restoreDecision(server: { head: string | null; body: string }, local: LocalDraft | null):
  { kind: 'server' } | { kind: 'restore'; body: string } | { kind: 'conflict'; mine: string } {
  if (!local || local.body === server.body) return { kind: 'server' };
  if (local.base === server.head) return { kind: 'restore', body: local.body };
  return { kind: 'conflict', mine: local.body };
}
