export type ZoneEditorSection = 'home' | 'navigation' | 'theme';

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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
    // Storage can be disabled or full. The mounted editor still keeps its state.
  }
}
