import { parseDiscoveryFilter } from '@rezics/filter';
import { pickText } from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { DiscoveryKinds, DiscoveryKindsState } from '../../search/discovery';

/** The same native literal admission used by Content; identity is never normalized. */
export function homeFeedKind(value: unknown): string | undefined {
  if (value === undefined) return;
  parseDiscoveryFilter({ kind: { in: [value] } });
  if (typeof value !== 'string') throw new Error('Invalid kind');
  return value;
}

export type HomeKindChoice = {
  id: string;
  text: string;
  lang?: string;
  description?: string;
  descriptionLang?: string;
};
export function homeKindChoice(kind: DiscoveryKinds['values'][number], locale: string): HomeKindChoice {
  homeFeedKind(kind.id);
  const label = pickText(kind.labels, locale);
  const description = pickText(bundledRelease.types[kind.id]?.descriptions ?? {}, locale);
  return {
    id: kind.id,
    text: label.text,
    ...(label.lang ? { lang: label.lang } : {}),
    ...(description.text ? { description: description.text } : {}),
    ...(description.lang ? { descriptionLang: description.lang } : {}),
  };
}
export type HomeKindsReader = (cursor: string | undefined, signal: AbortSignal) => Promise<DiscoveryKindsState>;
type Snapshot = {
  status: DiscoveryKindsState['status'] | 'idle';
  kinds?: DiscoveryKinds;
  selected?: HomeKindChoice | undefined;
};

/** One metadata page plus one selected label. Selection/viewer changes retire pending metadata reads. */
export function createHomeKindChoices(read: HomeKindsReader) {
  let snapshot: Snapshot = { status: 'idle' };
  let generation = 0;
  let pending: AbortController | undefined;
  let attempted: string | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const retire = () => {
    generation++;
    pending?.abort();
    pending = undefined;
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retire() {
      retire();
      snapshot = {
        ...snapshot,
        status: snapshot.status === 'loading' ? (snapshot.kinds ? 'ready' : 'idle') : snapshot.status,
      };
      emit();
    },
    select(selected: HomeKindChoice | undefined) {
      retire();
      snapshot = {
        ...snapshot,
        selected,
        status: snapshot.status === 'loading' ? (snapshot.kinds ? 'ready' : 'idle') : snapshot.status,
      };
      emit();
    },
    async load(cursor?: string) {
      retire();
      const current = generation;
      const controller = new AbortController();
      pending = controller;
      attempted = cursor;
      snapshot = { ...snapshot, status: 'loading' };
      emit();
      let result: DiscoveryKindsState;
      try {
        result = await read(cursor, controller.signal);
      } catch {
        result = { status: 'unavailable' };
      }
      if (current !== generation || controller.signal.aborted) return;
      pending = undefined;
      snapshot =
        result.status === 'ready'
          ? { ...snapshot, status: 'ready', kinds: result.kinds }
          : { ...snapshot, status: result.status };
      emit();
    },
    retryCursor: () => (snapshot.status === 'restart' ? undefined : attempted),
  };
}
