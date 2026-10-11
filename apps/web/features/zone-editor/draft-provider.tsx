'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type SetStateAction } from 'react';
import { readZoneEditorDraft, writeZoneEditorDraft, zoneEditorDraftKey, type ZoneEditorSection } from './draft-state.ts';

type DirtySections = Partial<Record<ZoneEditorSection, true>>;
interface DraftScope {
  zoneId: string;
  actingSubject: string;
  dirty: DirtySections;
  mark(section: ZoneEditorSection, dirty: boolean): void;
}

const DraftContext = createContext<DraftScope | null>(null);

/** The route layout stays mounted across Home, Navigation and Theme, and storage covers a full-page link fallback. */
export function ZoneEditorDraftProvider({ zoneId, actingSubject, children }: {
  zoneId: string;
  actingSubject: string;
  children: ReactNode;
}) {
  const [dirty, setDirty] = useState<DirtySections>({});
  const mark = useCallback((section: ZoneEditorSection, value: boolean) => {
    setDirty(current => {
      if (value) return current[section] ? current : { ...current, [section]: true };
      if (!current[section]) return current;
      const next = { ...current };
      delete next[section];
      return next;
    });
  }, []);
  const value = useMemo(() => ({ zoneId, actingSubject, dirty, mark }), [zoneId, actingSubject, dirty, mark]);
  useEffect(() => {
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    if (!storage) return;
    for (const section of ['home', 'navigation', 'theme'] as const) {
      const key = zoneEditorDraftKey(zoneId, actingSubject, section);
      if (readZoneEditorDraft(storage, key, isStoredDraft)) mark(section, true);
    }
  }, [zoneId, actingSubject, mark]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/** Restore a section's local choices after navigation, and advertise any work that still needs saving. */
export function useZoneEditorDraft<T>(section: ZoneEditorSection, initial: T, isDirty: (value: T) => boolean,
  accepts: (value: unknown) => value is T): [T, (next: SetStateAction<T>) => void, boolean] {
  const scope = useContext(DraftContext);
  const zoneId = scope?.zoneId;
  const actingSubject = scope?.actingSubject;
  const mark = scope?.mark;
  const [state, setState] = useState(initial);
  const [ready, setReady] = useState(scope === null);
  const key = zoneId && actingSubject ? zoneEditorDraftKey(zoneId, actingSubject, section) : null;

  useEffect(() => {
    if (!zoneId || !key) {
      setReady(true);
      return;
    }
    setReady(false);
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    if (storage) {
      const saved = readZoneEditorDraft(storage, key, accepts);
      if (saved !== null) setState(saved);
    }
    setReady(true);
  }, [zoneId, key, accepts]);

  useEffect(() => {
    if (!mark || !key || !ready) return;
    const dirty = isDirty(state);
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    if (storage) writeZoneEditorDraft(storage, key, state, dirty);
    mark(section, dirty);
  }, [mark, key, ready, state, isDirty, section]);

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
