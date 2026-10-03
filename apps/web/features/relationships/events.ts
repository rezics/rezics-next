export const RELATIONSHIPS_CHANGED = 'rezics:relationships-changed';

/** One successful Main receipt refreshes controls, navigation and the manager, including other tabs. */
export function relationshipsChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(RELATIONSHIPS_CHANGED));
  try { localStorage.setItem(RELATIONSHIPS_CHANGED, crypto.randomUUID()); } catch { /* Storage may be disabled. */ }
}

export function observeRelationships(refresh: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === RELATIONSHIPS_CHANGED) refresh(); };
  window.addEventListener(RELATIONSHIPS_CHANGED, refresh);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(RELATIONSHIPS_CHANGED, refresh);
    window.removeEventListener('storage', storage);
  };
}
