import type { SetupChoice } from './space-setup';

/** Display data only. Native commands remain the authority for lifecycle and membership. */
export type BoardChoiceSource = {
  schemes(input: { query: string; cursor?: string }): Promise<{
    schemes: readonly { id: string; label: string }[];
    next: string | null;
  }>;
  concepts(input: { schemeId: string; query: string; cursor?: string }): Promise<{
    concepts: readonly { id: string; label: string }[];
    next: string | null;
  }>;
};

export class BoardChoiceUnavailable extends Error {
  readonly kind = 'unavailable';
  constructor() {
    super('The installed SKOS choice reader is unavailable');
  }
}

/** No native bounded SKOS list export is installed. Never substitute a catalogue or guessed route. */
export const unavailableBoardChoiceSource: BoardChoiceSource = {
  async schemes() { throw new BoardChoiceUnavailable(); },
  async concepts() { throw new BoardChoiceUnavailable(); },
};

export type BoardConceptSelection = { schemeId: string; choice: SetupChoice };
export function currentBoardConcept(selection: BoardConceptSelection | null, schemeId: string | null) {
  return selection?.schemeId === schemeId ? selection : null;
}

export type BoardChoicePage = {
  status: 'loading' | 'ready' | 'unavailable';
  choices: readonly SetupChoice[];
  next: string | null;
};
type Scope = { source: BoardChoiceSource; kind: 'scheme' | 'concept'; schemeId: string; query: string };
const loading: BoardChoicePage = { status: 'loading', choices: [], next: null };

/** One bounded page per request. Cancellation hides late data even when the producer cannot abort its I/O. */
export class BoardChoicePager {
  private scope: Scope | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private page: BoardChoicePage = loading;
  private cursor: string | undefined;
  constructor(private publish: (page: BoardChoicePage) => void) {}

  search(scope: Scope, debounceMs = 250) {
    this.cancel();
    this.scope = scope;
    this.cursor = undefined;
    this.update(loading);
    this.timer = setTimeout(() => { void this.load(); }, debounceMs);
  }
  next() {
    if (this.page.status !== 'ready' || this.page.next === null) return;
    this.cursor = this.page.next;
    void this.load();
  }
  retry() {
    if (this.page.status === 'unavailable') void this.load();
  }
  choose(id: string): SetupChoice | null {
    return this.page.status === 'ready' ? this.page.choices.find((choice) => choice.id === id) ?? null : null;
  }
  cancel() {
    clearTimeout(this.timer);
    this.abort?.abort();
  }
  private update(page: BoardChoicePage) {
    this.page = page;
    this.publish(page);
  }
  private async load() {
    const scope = this.scope;
    if (!scope) return;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.update(loading);
    try {
      if (scope.kind === 'concept' && !scope.schemeId) throw new BoardChoiceUnavailable();
      const input = { query: scope.query, ...(this.cursor === undefined ? {} : { cursor: this.cursor }) };
      const result = scope.kind === 'scheme'
        ? await scope.source.schemes(input)
        : await scope.source.concepts({ ...input, schemeId: scope.schemeId });
      if (controller.signal.aborted) return;
      const choices = 'schemes' in result ? result.schemes : result.concepts;
      this.update({ status: 'ready', choices, next: result.next });
    } catch {
      if (!controller.signal.aborted) this.update({ status: 'unavailable', choices: [], next: null });
    }
  }
}
