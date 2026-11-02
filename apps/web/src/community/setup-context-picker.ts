import type { SetupChoice, SetupFailure } from './space-setup';

/** Presentation data only. Native setup commands still check current authority and disclosure. */
export type ContextChoiceSource = {
  search(input: { query: string; cursor?: string; signal?: AbortSignal }): Promise<{
    contexts: readonly SetupChoice[];
    next: string | null;
  }>;
  resolve(id: string): Promise<SetupChoice | null>;
};

export class ContextChoiceError extends Error {
  constructor(readonly reason: 'denied' | 'unavailable') {
    super(reason);
  }
}

/** Known-reference recovery for consumers that have no directory transport. */
export function unavailableContextChoiceSource(
  resolve: (id: string) => Promise<SetupChoice | SetupFailure>,
): ContextChoiceSource {
  return {
    async search() {
      throw new ContextChoiceError('unavailable');
    },
    async resolve(id) {
      const result = await resolve(id);
      if ('kind' in result) {
        if (result.reason === 'denied') return null;
        throw new ContextChoiceError('unavailable');
      }
      if (result.id !== id) throw new ContextChoiceError('unavailable');
      return result;
    },
  };
}

type Phase = 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable';
export type ContextResolution = {
  id: string;
  phase: Exclude<Phase, 'idle'>;
  choice: SetupChoice | null;
};
export type ContextPickerState = {
  query: string;
  reference: string;
  page: { phase: Phase; contexts: readonly SetupChoice[]; next: string | null; cursor?: string };
  current: ContextResolution | null;
  selected: ContextResolution | null;
};

/** One page per request; stale searches and exact resolutions cannot replace newer intent. */
export function createSetupContextPicker(source: ContextChoiceSource, reference = '') {
  let state: ContextPickerState = {
    query: '',
    reference,
    page: { phase: 'idle', contexts: [], next: null },
    current: null,
    selected: null,
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searchRequest: AbortController | undefined;
  let searchGeneration = 0;
  let selectionGeneration = 0;
  let selectionCurrentRead: number | null = null;
  let currentGeneration = 0;
  let referenceGeneration = 0;
  let currentVersion: string | undefined;
  let connected = true;
  let disposed = false;
  const active = () => connected && !disposed;
  function update(next: ContextPickerState) {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  function cancelSearch() {
    clearTimeout(timer);
    timer = undefined;
    searchRequest?.abort();
    searchRequest = undefined;
    searchGeneration++;
  }
  function search(query: string, cursor?: string, delay = 0) {
    if (!active()) return;
    cancelSearch();
    const interrupted = state.selected?.phase === 'loading';
    if (interrupted) {
      selectionGeneration++;
      selectionCurrentRead = null;
    }
    const generation = searchGeneration;
    const page = { phase: 'loading' as const, contexts: [], next: null, ...(cursor !== undefined ? { cursor } : {}) };
    update({ ...state, query, page, selected: interrupted ? null : state.selected });
    timer = setTimeout(async () => {
      timer = undefined;
      if (!active() || generation !== searchGeneration) return;
      const request = new AbortController();
      searchRequest = request;
      try {
        const result = await source.search({
          query: query.trim(),
          ...(cursor !== undefined ? { cursor } : {}),
          signal: request.signal,
        });
        if (!active() || generation !== searchGeneration || request.signal.aborted) return;
        update({ ...state, page: { ...page, phase: 'ready', contexts: result.contexts, next: result.next } });
      } catch (error) {
        if (!active() || generation !== searchGeneration || request.signal.aborted) return;
        update({ ...state, page: { ...page, phase: failurePhase(error) } });
      }
    }, delay);
  }
  function failurePhase(error: unknown): 'denied' | 'unavailable' {
    return error instanceof ContextChoiceError ? error.reason : 'unavailable';
  }
  async function resolve(id: string): Promise<ContextResolution> {
    if (!active()) return { id, phase: 'unavailable', choice: null };
    try {
      const choice = await source.resolve(id);
      if (!active()) return { id, phase: 'unavailable', choice: null };
      if (!choice) return { id, phase: 'denied', choice: null };
      if (choice.id !== id) throw new ContextChoiceError('unavailable');
      return { id, phase: 'ready', choice };
    } catch (error) {
      if (!active()) return { id, phase: 'unavailable', choice: null };
      return { id, phase: failurePhase(error), choice: null };
    }
  }
  async function choose(id: string) {
    if (!active()) return;
    cancelSearch();
    selectionCurrentRead = null;
    const generation = ++selectionGeneration;
    update({
      ...state,
      page: { phase: 'idle', contexts: [], next: null },
      selected: { id, phase: 'loading', choice: null },
    });
    const selected = await resolve(id);
    if (active() && generation === selectionGeneration) update({ ...state, selected });
  }
  async function current(id: string | null, version?: string, retry = false) {
    if (!active()) return;
    if (!retry && state.current?.id === id && currentVersion === version) return;
    currentVersion = version;
    const generation = ++currentGeneration;
    // A newer current read can replace a recheck, but cannot take over an independent choice.
    const selected = selectionCurrentRead !== null && state.selected?.id !== id ? null : state.selected;
    const recheckSelection =
      !!id && selected?.id === id && (selected.phase !== 'loading' || selectionCurrentRead !== null);
    selectionCurrentRead = recheckSelection ? generation : null;
    if (recheckSelection) selectionGeneration++;
    const selectionAtRead = selectionGeneration;
    const loading = id ? { id, phase: 'loading' as const, choice: null } : null;
    update({
      ...state,
      current: loading,
      selected: recheckSelection ? loading : selected,
    });
    if (!id) return;
    const resolved = await resolve(id);
    if (active() && generation === currentGeneration)
      update({
        ...state,
        current: resolved,
        selected:
          recheckSelection && selectionAtRead === selectionGeneration && state.selected?.id === id
            ? resolved
            : state.selected,
      });
    if (selectionCurrentRead === generation) selectionCurrentRead = null;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      if (disposed) return () => {};
      connected = true;
      return () => {
        if (!connected) return;
        connected = false;
        cancelSearch();
        selectionGeneration++;
        currentGeneration++;
        referenceGeneration++;
        const current = state.current?.phase === 'loading' ? null : state.current;
        const selected = state.selected?.phase === 'loading' ? null : state.selected;
        update({
          ...state,
          page: { phase: 'idle', contexts: [], next: null },
          current,
          selected,
        });
        queueMicrotask(() => {
          if (!connected) disposed = true;
        });
      };
    },
    search(query: string, expectedQuery?: string, expectedVersion?: number) {
      if (expectedQuery !== undefined && state.query !== expectedQuery) return;
      if (expectedVersion !== undefined && expectedVersion !== searchGeneration) return;
      search(query, undefined, 250);
    },
    searchVersion() {
      return searchGeneration;
    },
    pageVersion() {
      return searchGeneration;
    },
    next(expected?: { query: string; cursor?: string; next?: string | null; version?: number }) {
      if (
        active() &&
        state.page.phase === 'ready' &&
        state.page.next !== null &&
        (!expected ||
          (state.query === expected.query &&
            state.page.cursor === expected.cursor &&
            state.page.next === expected.next &&
            (expected.version === undefined || expected.version === searchGeneration)))
      )
        search(state.query, state.page.next);
    },
    retrySearch(expected?: { query: string; cursor?: string; version?: number }) {
      if (
        active() &&
        state.page.phase !== 'loading' &&
        (!expected ||
          (state.query === expected.query &&
            state.page.cursor === expected.cursor &&
            (expected.version === undefined || expected.version === searchGeneration)))
      )
        search(state.query, state.page.cursor);
    },
    /** Explicit recovery belongs to this rendered failed continuation, including an empty cursor. */
    restartSearch(expected: { query: string; cursor: string; version: number }) {
      if (
        !active() ||
        state.page.phase !== 'unavailable' ||
        state.page.cursor === undefined ||
        state.query !== expected.query ||
        state.page.cursor !== expected.cursor ||
        searchGeneration !== expected.version
      )
        return false;
      search(state.query);
      return true;
    },
    choose,
    choosePage(id: string, expected?: { query: string; cursor?: string; version?: number }) {
      if (
        active() &&
        state.page.phase === 'ready' &&
        (!expected ||
          (state.query === expected.query &&
            state.page.cursor === expected.cursor &&
            (expected.version === undefined || expected.version === searchGeneration))) &&
        state.page.contexts.some((choice) => choice.id === id)
      )
        return choose(id);
      return Promise.resolve();
    },
    chooseCurrent(expectedId?: string, expectedVersion?: string) {
      const current = state.current;
      if (
        active() &&
        current?.phase === 'ready' &&
        (expectedId === undefined || current.id === expectedId) &&
        (expectedVersion === undefined || JSON.stringify([currentGeneration, currentVersion]) === expectedVersion)
      )
        return choose(current.id);
      return Promise.resolve();
    },
    retrySelected(expectedId?: string, expectedPhase?: ContextResolution['phase'], expectedVersion?: number) {
      const selected = state.selected;
      if (
        active() &&
        selected &&
        (expectedId === undefined || selected.id === expectedId) &&
        (expectedPhase === undefined || selected.phase === expectedPhase) &&
        (expectedVersion === undefined || expectedVersion === selectionGeneration) &&
        (selected.phase === 'denied' || selected.phase === 'unavailable')
      )
        return choose(selected.id);
      return Promise.resolve();
    },
    chooseReference(value = state.reference, expectedVersion?: number) {
      const id = value.trim();
      if (
        active() &&
        id &&
        id === state.reference.trim() &&
        (expectedVersion === undefined || expectedVersion === referenceGeneration)
      )
        return choose(id);
      return Promise.resolve();
    },
    current,
    currentVersion() {
      return JSON.stringify([currentGeneration, currentVersion]);
    },
    referenceVersion() {
      return referenceGeneration;
    },
    selectionVersion() {
      return selectionGeneration;
    },
    /** A queued submit must still own the exact selection observed by its render. */
    selection(expectedId: string, expectedVersion: number): SetupChoice | null {
      if (!active() || expectedVersion !== selectionGeneration) return null;
      const selected = state.selected;
      if (selected?.phase !== 'ready' || selected.id !== expectedId || selected.choice?.id !== expectedId) return null;
      return selected.choice;
    },
    retryCurrent(expectedId?: string, expectedVersion?: string) {
      return active() &&
        state.current?.id &&
        (expectedId === undefined || expectedId === state.current.id) &&
        (expectedVersion === undefined || JSON.stringify([currentGeneration, currentVersion]) === expectedVersion)
        ? current(state.current.id, currentVersion, true)
        : Promise.resolve();
    },
    reference(value: string, expectedReference?: string, expectedVersion?: number) {
      if (!active()) return;
      if (expectedReference !== undefined && state.reference !== expectedReference) return;
      if (expectedVersion !== undefined && expectedVersion !== referenceGeneration) return;
      referenceGeneration++;
      cancelSearch();
      selectionCurrentRead = null;
      selectionGeneration++;
      update({ ...state, reference: value, selected: null, page: { phase: 'idle', contexts: [], next: null } });
    },
    clear(expectedId?: string, expectedVersion?: number) {
      if (!active()) return;
      if (expectedId !== undefined && state.selected?.id !== expectedId) return;
      if (expectedVersion !== undefined && expectedVersion !== selectionGeneration) return;
      selectionCurrentRead = null;
      selectionGeneration++;
      update({ ...state, selected: null });
    },
    dispose() {
      if (disposed) return;
      connected = false;
      disposed = true;
      cancelSearch();
      selectionGeneration++;
      currentGeneration++;
      currentVersion = undefined;
      referenceGeneration++;
      update({ ...state, page: { phase: 'idle', contexts: [], next: null } });
    },
  };
}
export type SetupContextPicker = ReturnType<typeof createSetupContextPicker>;
