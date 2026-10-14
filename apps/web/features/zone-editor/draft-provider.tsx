'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import { createZoneEditorDraftStore, zoneEditorDraftKey, type ZoneEditorSection } from './draft-state.ts';
import { messages } from './messages.ts';

type DirtySections = Partial<Record<ZoneEditorSection, true>>;
const draftSections = ['home', 'navigation', 'theme', 'attachment'] as const;
const exitSections = [...draftSections, 'lifecycle'] as const;
interface ExitActions { save(): Promise<boolean>; discard(): void; pending?(): boolean }
interface DraftScope {
  zoneId: string;
  actingSubject: string;
  dirty: DirtySections;
  drafts: ReturnType<typeof createZoneEditorDraftStore>;
  actions: Map<string, ExitActions>;
  mark(section: ZoneEditorSection, dirty: boolean): void;
  requestExit(action: () => void): void;
}

const DraftContext = createContext<DraftScope | null>(null);

/** The route layout stays mounted across Home, Navigation and Theme, and storage covers a full-page link fallback. */
export function ZoneEditorDraftProvider({ zoneId, actingSubject, children }: {
  zoneId: string;
  actingSubject: string;
  children: ReactNode;
}) {
  const [drafts] = useState(createZoneEditorDraftStore);
  const [actions] = useState(() => new Map<string, ExitActions>());
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const dirtyRef = useRef(dirtyKeys);
  const [exit, setExit] = useState<{ zoneId: string; actingSubject: string; action(): void } | null>(null);
  const [saving, setSaving] = useState(false);
  const [exitFailed, setExitFailed] = useState(false);
  const copy = messages[useOptionalShell()?.locale ?? 'en'];
  const mark = useCallback((section: ZoneEditorSection, value: boolean) => {
    const key = zoneEditorDraftKey(zoneId, actingSubject, section);
    if (dirtyRef.current.has(key) === value) return;
    const next = new Set(dirtyRef.current);
    if (value) next.add(key);
    else next.delete(key);
    dirtyRef.current = next;
    setDirtyKeys(next);
  }, [zoneId, actingSubject]);
  const dirty = useMemo(() => {
    const sections: DirtySections = {};
    for (const section of draftSections) {
      if (dirtyKeys.has(zoneEditorDraftKey(zoneId, actingSubject, section))) sections[section] = true;
    }
    return sections;
  }, [zoneId, actingSubject, dirtyKeys]);
  const hasUnsaved = useCallback(() => exitSections.some(section => {
    const key = zoneEditorDraftKey(zoneId, actingSubject, section);
    return dirtyRef.current.has(key) || actions.get(key)?.pending?.();
  }), [zoneId, actingSubject, actions]);
  const requestExit = useCallback((action: () => void) => {
    if (!hasUnsaved()) {
      action();
      return;
    }
    setExitFailed(false);
    setExit({ zoneId, actingSubject, action });
  }, [zoneId, actingSubject, hasUnsaved]);
  const guardNavigation = useCallback((event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const destination = new URL(anchor.href);
    const currentSection = window.location.pathname.match(/^(?:\/[a-z]{2}(?:-[A-Za-z]+)?)?\/manage\/z\/([^/]+)(?:\/(navigation|theme|realm|lifecycle))?\/?$/);
    const nextSection = destination.pathname.match(/^(?:\/[a-z]{2}(?:-[A-Za-z]+)?)?\/manage\/z\/([^/]+)(?:\/(navigation|theme|realm|lifecycle))?\/?$/);
    if (destination.origin === window.location.origin && currentSection && nextSection && currentSection[1] === nextSection[1]) return;
    if (!hasUnsaved()) return;
    event.preventDefault();
    event.stopPropagation();
    requestExit(() => window.location.assign(anchor.href));
  }, [hasUnsaved, requestExit]);
  const value = useMemo(() => ({ zoneId, actingSubject, dirty, drafts, actions, mark, requestExit }),
    [zoneId, actingSubject, dirty, drafts, actions, mark, requestExit]);
  useEffect(() => {
    let storage: Storage | undefined;
    try { storage = globalThis.sessionStorage; } catch { storage = undefined; }
    for (const section of draftSections) {
      const key = zoneEditorDraftKey(zoneId, actingSubject, section);
      mark(section, drafts.read(storage, key, isStoredDraft) !== null);
    }
  }, [zoneId, actingSubject, drafts, mark]);
  useEffect(() => {
    const ask = (event: BeforeUnloadEvent) => {
      if (hasUnsaved()) event.preventDefault();
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [hasUnsaved]);
  // The provider sits inside <main>; capture shell links before Next handles them.
  useEffect(() => {
    document.addEventListener('click', guardNavigation, true);
    return () => document.removeEventListener('click', guardNavigation, true);
  }, [guardNavigation]);
  const selectedExit = exit?.zoneId === zoneId && exit.actingSubject === actingSubject ? exit : null;
  function leave() {
    setExit(null);
    selectedExit?.action();
  }
  async function saveAndLeave() {
    if (saving || !selectedExit) return;
    setSaving(true);
    setExitFailed(false);
    try {
      for (const section of exitSections) {
        const key = zoneEditorDraftKey(zoneId, actingSubject, section);
        if (!dirtyRef.current.has(key) && !actions.get(key)?.pending?.()) continue;
        if (!await actions.get(key)?.save()) { setExitFailed(true); return; }
      }
      if (hasUnsaved()) {
        setExitFailed(true);
        return;
      }
      leave();
    } catch { setExitFailed(true); }
    finally { setSaving(false); }
  }
  function discardAndLeave() {
    for (const section of exitSections) {
      const key = zoneEditorDraftKey(zoneId, actingSubject, section);
      if (!dirtyRef.current.has(key) && !actions.get(key)?.pending?.()) continue;
      actions.get(key)?.discard();
      drafts.write(sessionStorageIfAvailable(), key, null, false);
      mark(section, false);
    }
    leave();
  }
  const awaitingConfirmation = exitSections.some(section => actions.get(zoneEditorDraftKey(zoneId, actingSubject, section))?.pending?.());
  return <DraftContext.Provider value={value}>
    <div className="contents">{children}</div>
    <Dialog open={selectedExit !== null} pending={saving} onOpenChange={({ open }) => { if (!open) setExit(null); }}>
      <DialogContent size="md">
        <DialogHeader className="pr-14" title={copy.exitTitle} description={awaitingConfirmation ? copy.exitPendingBody : copy.exitBody} />
        {exitFailed ? <DialogBody><p role="alert" className="text-sm text-destructive">{copy.exitFailed}</p></DialogBody> : null}
        <DialogFooter className="sm:flex-wrap">
          <Button size="sm" disabled={saving} isLoading={saving} onClick={() => void saveAndLeave()}>{saving ? copy.exitSaving : copy.exitSave}</Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={discardAndLeave}>{copy.exitDiscard}</Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setExit(null)}>{copy.exitCancel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </DraftContext.Provider>;
}

/** Save/discard handlers remain available for dirty sections after their view unmounts. */
export function useZoneEditorExitActions(section: ZoneEditorSection, save: () => Promise<boolean>, discard: () => void,
  pending?: () => boolean): void {
  const scope = useContext(DraftContext);
  useEffect(() => {
    if (!scope) return;
    scope.actions.set(zoneEditorDraftKey(scope.zoneId, scope.actingSubject, section), { save, discard, pending });
  }, [scope?.actions, scope?.zoneId, scope?.actingSubject, section, save, discard, pending]);
}

export function useZoneEditorExit(): (action: () => void) => void {
  return useContext(DraftContext)?.requestExit ?? (action => action());
}

/** Restore a section's local choices after navigation, and advertise any work that still needs saving. */
export function useZoneEditorDraft<T>(section: ZoneEditorSection, initial: T, isDirty: (value: T) => boolean,
  accepts: (value: unknown) => value is T, reopen?: (retained: T, admitted: T) => T): [T, (next: SetStateAction<T>) => void, boolean] {
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
    if (!scope || !key) return;
    const current = scope.drafts.current<T>(key);
    if (current !== undefined && !reopen) return;
    const retained = current ?? scope.drafts.read(sessionStorageIfAvailable(), key, accepts) ?? initial;
    const value = reopen ? reopen(retained, initial) : retained;
    scope.drafts.retain(key, value);
    if (value !== retained) scope.drafts.write(sessionStorageIfAvailable(), key, value, isDirty(value));
    scope.mark(section, isDirty(value));
  }, [key, scope?.drafts, scope?.mark, accepts, initial, isDirty, section, reopen]);

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

export function useUnsavedZoneEditorSections(): readonly (typeof draftSections)[number][] {
  const scope = useContext(DraftContext);
  if (!scope) return [];
  return draftSections.filter(section => scope.dirty[section]);
}

function isStoredDraft(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
