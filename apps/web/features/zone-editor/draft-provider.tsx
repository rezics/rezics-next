'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react';
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
  const key = scope ? zoneEditorDraftKey(scope.zoneId, scope.actingSubject, section) : null;
  const [local, setLocal] = useState(initial);
  const localRef = useRef(local);
  localRef.current = local;
  const snapshot = useSyncExternalStore(
    useCallback(listener => key && scope ? scope.drafts.subscribe(key, listener) : () => {}, [key, scope?.drafts]),
    () => key && scope ? scope.drafts.current<T>(key) : undefined,
    () => undefined,
  );
  const ready = !key || snapshot !== undefined;
  const state = key ? snapshot ?? initial : local;
  const setState = useCallback((next: SetStateAction<T>) => {
    const current = key && scope ? scope.drafts.current<T>(key) ?? initial : localRef.current;
    const value = typeof next === 'function' ? (next as (value: T) => T)(current) : next;
    if (!scope || !key) { localRef.current = value; setLocal(value); return; }
    // Settle in the provider even when the section that dispatched the command has unmounted.
    scope.drafts.retain(key, value);
    scope.drafts.write(sessionStorageIfAvailable(), key, value, isDirty(value));
    scope.mark(section, isDirty(value));
  }, [key, scope?.drafts, scope?.mark, initial, isDirty, section]);

  useEffect(() => {
    if (!scope || !key || scope.drafts.current(key) !== undefined) return;
    const value = scope.drafts.read(sessionStorageIfAvailable(), key, accepts) ?? initial;
    scope.drafts.retain(key, value);
    scope.mark(section, isDirty(value));
  }, [key, scope?.drafts, scope?.mark, accepts, initial, isDirty, section]);

  return [state, setState, ready];
}

/** Runtime command lanes and checkpoints live with the Zone and acting subject, not a section. */
export function useZoneEditorResource<T>(name: string, create: () => T): T {
  const scope = useContext(DraftContext);
  const fallback = useRef<{ value: T } | null>(null);
  if (scope) return scope.drafts.resource(`${zoneEditorDraftKey(scope.zoneId, scope.actingSubject, 'home')}:resource:${name}`, create);
  fallback.current ??= { value: create() };
  return fallback.current.value;
}

export function useZoneEditorRef<T>(name: string, initial: T): { current: T } {
  return useZoneEditorResource(name, () => ({ current: initial }));
}

/** Transient command feedback is observable after leaving and returning to a section. */
export function useZoneEditorSessionState<T>(name: string, initial: T): [T, (next: SetStateAction<T>) => void] {
  const scope = useContext(DraftContext);
  const key = scope ? `${zoneEditorDraftKey(scope.zoneId, scope.actingSubject, 'home')}:session:${name}` : null;
  const [local, setLocal] = useState(initial);
  const value = useSyncExternalStore(
    useCallback(listener => scope && key ? scope.drafts.subscribe(key, listener) : () => {}, [scope?.drafts, key]),
    () => scope && key ? scope.drafts.current<T>(key) : undefined,
    () => undefined,
  );
  const setState = useCallback((next: SetStateAction<T>) => {
    if (!scope || !key) { setLocal(next); return; }
    const current = scope.drafts.current<T>(key) ?? initial;
    scope.drafts.retain(key, typeof next === 'function' ? (next as (value: T) => T)(current) : next);
  }, [scope?.drafts, key, initial]);
  return [key ? value ?? initial : local, setState];
}

function sessionStorageIfAvailable(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

export function useUnsavedZoneEditorSections(): readonly ('home' | 'navigation' | 'theme')[] {
  const scope = useContext(DraftContext);
  if (!scope) return [];
  return (['home', 'navigation', 'theme'] as const).filter(section => scope.dirty[section]);
}

function isStoredDraft(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
