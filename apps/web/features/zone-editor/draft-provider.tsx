'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type SetStateAction } from 'react';
import { createZoneEditorDraftStore, zoneEditorDraftKey, type ZoneEditorSection } from './draft-state.ts';

type DirtySections = Partial<Record<ZoneEditorSection, true>>;
interface DraftScope {
  zoneId: string;
  actingSubject: string;
  dirty: DirtySections;
  drafts: ReturnType<typeof createZoneEditorDraftStore>;
  mark(section: ZoneEditorSection, dirty: boolean): void;
}

const DraftContext = createContext<DraftScope | null>(null);

/** The route layout stays mounted across Home, Navigation and Theme, and storage covers a full-page link fallback. */
export function ZoneEditorDraftProvider({ zoneId, actingSubject, children }: {
  zoneId: string;
  actingSubject: string;
  children: ReactNode;
}) {
  const [drafts] = useState(createZoneEditorDraftStore);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const mark = useCallback((section: ZoneEditorSection, value: boolean) => {
    const key = zoneEditorDraftKey(zoneId, actingSubject, section);
    setDirtyKeys(current => {
      if (current.has(key) === value) return current;
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [zoneId, actingSubject]);
  const dirty = useMemo(() => {
    const sections: DirtySections = {};
    for (const section of ['home', 'navigation', 'theme'] as const) {
      if (dirtyKeys.has(zoneEditorDraftKey(zoneId, actingSubject, section))) sections[section] = true;
    }
    return sections;
  }, [zoneId, actingSubject, dirtyKeys]);
  const value = useMemo(() => ({ zoneId, actingSubject, dirty, drafts, mark }), [zoneId, actingSubject, dirty, drafts, mark]);
  useEffect(() => {
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    for (const section of ['home', 'navigation', 'theme'] as const) {
      const key = zoneEditorDraftKey(zoneId, actingSubject, section);
      mark(section, drafts.read(storage, key, isStoredDraft) !== null);
    }
  }, [zoneId, actingSubject, drafts, mark]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/** Restore a section's local choices after navigation, and advertise any work that still needs saving. */
export function useZoneEditorDraft<T>(section: ZoneEditorSection, initial: T, isDirty: (value: T) => boolean,
  accepts: (value: unknown) => value is T): [T, (next: SetStateAction<T>) => void, boolean] {
  const scope = useContext(DraftContext);
  const zoneId = scope?.zoneId;
  const actingSubject = scope?.actingSubject;
  const mark = scope?.mark;
  const drafts = scope?.drafts;
  const key = zoneId && actingSubject ? zoneEditorDraftKey(zoneId, actingSubject, section) : null;
  const [local, setLocal] = useState<{ key: string | null; value: T }>(() => ({ key: null, value: initial }));
  const ready = local.key === key;
  const state = ready ? local.value : initial;
  const setState = useCallback((next: SetStateAction<T>) => {
    setLocal(current => {
      // Ignore an old identity's acknowledgement after this section has changed scope.
      if (current.key !== key) return current;
      const value = typeof next === 'function' ? (next as (value: T) => T)(current.value) : next;
      return current.value === value ? current : { key, value };
    });
  }, [key]);

  useEffect(() => {
    if (!drafts || !key) {
      setLocal(current => current.key === key ? current : { key, value: initial });
      return;
    }
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    const saved = drafts.read(storage, key, accepts);
    setLocal(current => {
      const value = saved ?? (current.key === key ? current.value : initial);
      return current.key === key && current.value === value ? current : { key, value };
    });
  }, [key, drafts, accepts, initial]);

  useEffect(() => {
    if (!drafts || !mark || !key || !ready) return;
    const dirty = isDirty(state);
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    drafts.write(storage, key, state, dirty);
    mark(section, dirty);
  }, [drafts, mark, key, ready, state, isDirty, section]);

  return [state, setState, ready];
}

export function useUnsavedZoneEditorSections(): readonly ZoneEditorSection[] {
  const scope = useContext(DraftContext);
  if (!scope) return [];
  return (['home', 'navigation', 'theme'] as const).filter(section => scope.dirty[section]);
}

function isStoredDraft(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
