import { useRef, useState, type ReactNode } from 'react';
import type { Release } from '@rezics/definitions';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import type { CreateType } from '../create-subject';

export type CreationRead = { ok: true; release: Release; digest: string } | { ok: false };
type Snapshot<Holders> = { release: Release; digest: string; holders: Holders };

/** Native payloads and handoff semantics belong to profiles. This host owns only the
 * mounted draft and its metadata/review lifetime, using the existing reader boundary.
 */
export function useCreationHost<Fact, Holders>(profile: {
  initial: CreationRead;
  locale: string;
  scope: string;
  types: (release: Release, locale: string) => CreateType[];
  load: () => Promise<CreationRead>;
  failure: ReactNode;
  admit?: (type: CreateType) => boolean;
}) {
  const work = useCatalogueLifetime(profile.scope);
  const [reading, setReading] = useState(profile.initial);
  const lastGood = useRef(profile.initial.ok ? profile.initial : undefined);
  const [pending, setPending] = useState(false);
  const [termDrafts, setTermDrafts] = useState<Record<string, boolean>>({});
  const [factsByType, setFactsByType] = useState<Record<string, Fact[]>>({});
  const [archived, setArchived] = useState<CreateType[]>([]);
  const refreshing = useRef(false);
  const prepared = useRef<Snapshot<Holders> | undefined>(undefined);
  const retainedTypes = new Set([
    ...Object.keys(termDrafts),
    ...Object.entries(factsByType)
      .filter(([, rows]) => rows.length > 0)
      .map(([type]) => type),
  ]);
  const currentRead = reading.ok ? reading : lastGood.current;
  const release = currentRead?.release;
  const offered = (value: Release) => profile.types(value, profile.locale).filter(profile.admit ?? (() => true));
  const activeTypes = reading.ok ? offered(reading.release) : [];
  const activeTypeIds = new Set(activeTypes.map((entry) => entry.id));
  // Keep archived choices through failed refresh too: recovery must not strand a retained draft.
  const available = reading.ok ? activeTypes : currentRead ? offered(currentRead.release) : [];
  const availableIds = new Set(available.map((entry) => entry.id));
  const types = [
    ...available,
    ...archived.filter((entry) => retainedTypes.has(entry.id) && !availableIds.has(entry.id)),
  ];
  const metadataRevision = currentRead?.digest ?? 'unavailable';
  // Retain the review projection so the form can explain a stale review, but permanently
  // retire its authority on refresh, even when the digest later returns to its old value.
  const revision = useRef(0);
  const reviewRevision = `${metadataRevision}:${revision.current}`;

  async function refreshMetadata() {
    if (!work.active() || refreshing.current) return;
    refreshing.current = true;
    revision.current++;
    setPending(true);
    try {
      const result = await profile.load();
      if (!work.active()) return;
      if (result.ok) {
        const previous = lastGood.current;
        if (previous) {
          const admitted = new Set(offered(result.release).map((entry) => entry.id));
          const withdrawn = offered(previous.release).filter(
            (entry) => retainedTypes.has(entry.id) && !admitted.has(entry.id),
          );
          setArchived((current) => [...new Map([...current, ...withdrawn].map((entry) => [entry.id, entry])).values()]);
        }
        lastGood.current = result;
      }
      setReading(result);
    } catch {
      if (work.active()) setReading({ ok: false });
    } finally {
      refreshing.current = false;
      if (work.active()) setPending(false);
    }
  }

  function onTypeDraftChange(type: string, hasTerms: boolean) {
    if (!type || !work.active()) return;
    setTermDrafts((current) => {
      const next = { ...current };
      if (hasTerms) next[type] = true;
      else delete next[type];
      return next;
    });
  }
  function onDiscardType(type: string) {
    onTypeDraftChange(type, false);
    setFactsByType((current) => {
      const next = { ...current };
      delete next[type];
      return next;
    });
  }
  return {
    work,
    reading,
    currentRead,
    release,
    pending,
    factsByType,
    setFactsByType,
    prepared,
    retainedTypes,
    activeTypes,
    activeTypeIds,
    types,
    metadataRevision,
    reviewRevision,
    metadata: { ready: reading.ok, pending, failure: profile.failure, types },
    refreshMetadata,
    onTypeDraftChange,
    onDiscardType,
    jumpToField,
  };
}

/** Review navigation expands the original editor and focuses its real control. */
export function jumpToField(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  const control = target.matches('input, select, textarea, button')
    ? target
    : target.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
      );
  (control ?? target).focus();
  target.scrollIntoView({ block: 'center' });
}
