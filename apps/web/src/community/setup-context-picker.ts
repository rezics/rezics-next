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

/** Replace this consumer-local binding when Semantic delivers its exact search declaration. */
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
  let currentGeneration = 0;
  let currentVersion: string | undefined;
  function update(next: ContextPickerState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function cancelSearch() {
    clearTimeout(timer);
    searchRequest?.abort();
    searchGeneration++;
  }
  function search(query: string, cursor?: string, delay = 0) {
    cancelSearch();
    const generation = searchGeneration;
    const page = { phase: 'loading' as const, contexts: [], next: null, ...(cursor !== undefined ? { cursor } : {}) };
    update({ ...state, query, page });
    timer = setTimeout(async () => {
      const request = new AbortController();
      searchRequest = request;
      try {
        const result = await source.search({
          query: query.trim(),
          ...(cursor !== undefined ? { cursor } : {}),
          signal: request.signal,
        });
        if (generation !== searchGeneration || request.signal.aborted) return;
        update({ ...state, page: { ...page, phase: 'ready', contexts: result.contexts, next: result.next } });
      } catch (error) {
        if (generation !== searchGeneration || request.signal.aborted) return;
        update({ ...state, page: { ...page, phase: failurePhase(error) } });
      }
    }, delay);
  }
  function failurePhase(error: unknown): 'denied' | 'unavailable' {
    return error instanceof ContextChoiceError ? error.reason : 'unavailable';
  }
  async function resolve(id: string): Promise<ContextResolution> {
    try {
      const choice = await source.resolve(id);
      if (!choice) return { id, phase: 'denied', choice: null };
      if (choice.id !== id) throw new ContextChoiceError('unavailable');
      return { id, phase: 'ready', choice };
    } catch (error) {
      return { id, phase: failurePhase(error), choice: null };
    }
  }
  async function choose(id: string) {
    cancelSearch();
    const generation = ++selectionGeneration;
    update({
      ...state,
      page: { phase: 'idle', contexts: [], next: null },
      selected: { id, phase: 'loading', choice: null },
    });
    const selected = await resolve(id);
    if (generation === selectionGeneration) update({ ...state, selected });
  }
  async function current(id: string | null, version?: string, retry = false) {
    if (!retry && state.current?.id === id && currentVersion === version) return;
    currentVersion = version;
    const generation = ++currentGeneration;
    const selectionAtRead = selectionGeneration;
    update({ ...state, current: id ? { id, phase: 'loading', choice: null } : null });
    if (!id) return;
    const resolved = await resolve(id);
    if (generation === currentGeneration)
      update({
        ...state,
        current: resolved,
        selected:
          selectionAtRead === selectionGeneration && state.selected?.id === id && state.selected.phase !== 'loading'
            ? resolved
            : state.selected,
      });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search(query: string) {
      search(query, undefined, 250);
    },
    next() {
      if (state.page.phase === 'ready' && state.page.next !== null) search(state.query, state.page.next);
    },
    retrySearch() {
      search(state.query, state.page.cursor);
    },
    choose,
    current,
    retryCurrent() {
      return current(state.current?.id ?? null, currentVersion, true);
    },
    reference(value: string) {
      cancelSearch();
      selectionGeneration++;
      update({ ...state, reference: value, selected: null, page: { phase: 'idle', contexts: [], next: null } });
    },
    clear() {
      selectionGeneration++;
      update({ ...state, selected: null });
    },
    dispose() {
      cancelSearch();
      selectionGeneration++;
      currentGeneration++;
      currentVersion = undefined;
    },
  };
}
export type SetupContextPicker = ReturnType<typeof createSetupContextPicker>;
