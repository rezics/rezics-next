export type ZoneEditorSection = 'home' | 'navigation' | 'theme' | 'attachment' | 'lifecycle';

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A fresh authorized section read restores controls while preserving all unsaved choices and their original heads. */
export function reopenAuthoringNotice<T extends { notice: string | { kind: string } | null }>(retained: T, admitted: T): T {
  const kind = typeof retained.notice === 'string' ? retained.notice : retained.notice?.kind;
  if (!kind || !['denied', 'sign-in', 'missing'].includes(kind)) return retained;
  return { ...retained, notice: admitted.notice };
}

/** The mounted route owns author choices; browser storage is only a full-page fallback. */
export function createZoneEditorDraftStore() {
  const values = new Map<string, unknown>();
  const states = new Map<string, unknown>();
  const resources = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    current<T>(key: string): T | undefined {
      return states.get(key) as T | undefined;
    },
    retain<T>(key: string, value: T): void {
      if (states.has(key) && states.get(key) === value) return;
      states.set(key, value);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    subscribe(key: string, listener: () => void): () => void {
      const group = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, group);
      group.add(listener);
      return () => { group.delete(listener); };
    },
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create());
      return resources.get(key) as T;
    },
    read<T>(storage: DraftStorage | undefined, key: string, accepts: (value: unknown) => value is T): T | null {
      if (values.has(key)) {
        const value = values.get(key);
        return accepts(value) ? value : null;
      }
      const value = storage ? readZoneEditorDraft(storage, key, accepts) : null;
      if (value !== null) values.set(key, value);
      return value;
    },
    write(storage: DraftStorage | undefined, key: string, value: unknown, dirty: boolean): void {
      // A clean marker prevents a failed storage removal from restoring an acknowledged edit.
      values.set(key, dirty ? value : null);
      if (storage) writeZoneEditorDraft(storage, key, value, dirty);
    },
  };
}

/** A session-scoped key keeps one author's unsaved work attached to the Zone they opened. */
export function zoneEditorDraftKey(zoneId: string, actingSubject: string, section: ZoneEditorSection): string {
  return `rezics:zone-editor:draft:${encodeURIComponent(zoneId)}:${encodeURIComponent(actingSubject)}:${section}`;
}

export function readZoneEditorDraft<T>(storage: DraftStorage, key: string, accepts: (value: unknown) => value is T): T | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    return accepts(value) ? value : null;
  } catch {
    return null;
  }
}

/** Clean state comes from Main on the next visit; only unsaved author choices persist locally. */
export function writeZoneEditorDraft(storage: DraftStorage, key: string, value: unknown, dirty: boolean): void {
  try {
    if (dirty) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
  } catch {
    // The route's in-memory draft remains authoritative when storage is disabled or full.
  }
}
