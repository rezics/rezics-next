import type { SetupChoice, SetupReaderProvenance } from './space-setup';
import type { BoardIncomingPage } from './setup-board-native';

type Observation = { as_of?: string; freshness?: BoardIncomingPage['freshness'] };
type ChoiceInput = { query: string; cursor?: string | undefined };
export type BoardChoiceRead = ChoiceInput & ({ kind: 'scheme' } | { kind: 'concept'; schemeId: string });
export type BoardChoiceFailure = 'denied' | 'stale' | 'invalid' | 'unavailable';
export type BoardChoiceResult =
  | ({
      kind: 'ready';
      choices: readonly SetupChoice[];
      next: string | null;
      reader?: SetupReaderProvenance;
    } & Observation)
  | { kind: 'failure'; reason: BoardChoiceFailure; status: number; reader?: SetupReaderProvenance };

/** Display data only. Native commands remain the authority for lifecycle and membership. */
export type BoardChoiceSource = {
  conceptQuery?: 'loaded-page';
  schemes(input: ChoiceInput): Promise<
    {
      schemes: readonly { id: string; label: string }[];
      next: string | null;
    } & Observation
  >;
  concepts(input: ChoiceInput & { schemeId: string }): Promise<
    {
      concepts: readonly { id: string; label: string }[];
      next: string | null;
    } & Observation
  >;
};

export class BoardChoiceError extends Error {
  constructor(
    readonly reason: BoardChoiceFailure,
    readonly status: number,
  ) {
    super(`Board options: ${reason}`);
  }
}

/** The server transports native refusal and observation data without turning them into empty pages. */
export function setupBoardChoiceSource(
  read: (input: BoardChoiceRead) => Promise<BoardChoiceResult>,
): BoardChoiceSource {
  async function page(input: BoardChoiceRead) {
    const result = await read(input);
    if (result.kind === 'failure') throw new BoardChoiceError(result.reason, result.status);
    return result;
  }
  return {
    conceptQuery: 'loaded-page',
    async schemes(input) {
      const { choices, next, as_of } = await page({ ...input, kind: 'scheme' });
      return { schemes: choices, next, ...(as_of === undefined ? {} : { as_of }) };
    },
    async concepts(input) {
      const { choices, next, freshness } = await page({ ...input, kind: 'concept' });
      return { concepts: choices, next, ...(freshness === undefined ? {} : { freshness }) };
    },
  };
}

export class BoardChoiceUnavailable extends Error {
  readonly kind = 'unavailable';
  constructor() {
    super('The installed SKOS choice reader is unavailable');
  }
}

/** Isolated fallback for a form rendered without a native choice transport. */
export const unavailableBoardChoiceSource: BoardChoiceSource = {
  async schemes() {
    throw new BoardChoiceUnavailable();
  },
  async concepts() {
    throw new BoardChoiceUnavailable();
  },
};

export type BoardConceptSelection = { schemeId: string; choice: SetupChoice };
export function currentBoardConcept(selection: BoardConceptSelection | null, schemeId: string | null) {
  return selection?.schemeId === schemeId ? selection : null;
}

export type BoardChoicePage = {
  status: 'loading' | 'ready' | BoardChoiceFailure;
  choices: readonly SetupChoice[];
  next: string | null;
  /** An invalid or unavailable continuation can be replaced by an explicit first-page read. */
  canRestart?: true;
} & Observation;
export type BoardChoiceScope = {
  source: BoardChoiceSource;
  kind: 'scheme' | 'concept';
  schemeId: string;
  query: string;
};
export type BoardChoiceExpectation = BoardChoiceScope & { version?: number };
const loading: BoardChoicePage = { status: 'loading', choices: [], next: null };

/** One bounded page per request. Cancellation hides late data even when the producer cannot abort its I/O. */
export class BoardChoicePager {
  private scope: BoardChoiceScope | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private page: BoardChoicePage = loading;
  private cursor: string | undefined;
  private loaded: BoardChoicePage | null = null;
  private generation = 0;
  constructor(private publish: (page: BoardChoicePage) => void) {}

  private matches(expected?: BoardChoiceExpectation) {
    return (
      !!this.scope &&
      (!expected ||
        (expected.source === this.scope.source &&
          expected.kind === this.scope.kind &&
          expected.schemeId === this.scope.schemeId &&
          expected.query === this.scope.query &&
          (expected.version === undefined || expected.version === this.generation)))
    );
  }

  version() {
    return this.generation;
  }

  search(scope: BoardChoiceScope, debounceMs = 250) {
    const previous = this.scope;
    if (
      scope.kind === 'concept' &&
      scope.source.conceptQuery === 'loaded-page' &&
      this.page.status === 'ready' &&
      previous?.source === scope.source &&
      previous.kind === scope.kind &&
      previous.schemeId === scope.schemeId &&
      this.loaded
    ) {
      this.cancelWork();
      this.scope = scope;
      this.showLoaded();
      return;
    }
    this.cancel();
    this.scope = scope;
    this.cursor = undefined;
    this.loaded = null;
    this.update(loading);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation) void this.load(generation);
    }, debounceMs);
  }
  next(expected?: BoardChoiceExpectation) {
    if (!this.matches(expected) || this.page.status !== 'ready' || this.page.next === null) return;
    this.cursor = this.page.next;
    void this.load(this.generation);
  }
  retry(expected?: BoardChoiceExpectation) {
    if (!this.matches(expected) || this.page.status === 'ready' || this.page.status === 'loading') return;
    if (this.page.status === 'stale') this.cursor = undefined;
    void this.load(this.generation);
  }
  restart(expected?: BoardChoiceExpectation) {
    if (!this.matches(expected) || !this.page.canRestart) return;
    // Retire queued actions from the failed page, including an away-and-back scope replacement.
    this.cancelWork();
    this.cursor = undefined;
    this.loaded = null;
    void this.load(this.generation);
  }
  choose(id: string, expected?: BoardChoiceExpectation): SetupChoice | null {
    return this.matches(expected) && this.page.status === 'ready'
      ? (this.page.choices.find((choice) => choice.id === id) ?? null)
      : null;
  }
  cancel() {
    this.cancelWork();
    this.scope = null;
    this.cursor = undefined;
    this.loaded = null;
    this.page = loading;
  }
  private cancelWork() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = null;
    this.generation++;
  }
  private update(page: BoardChoicePage) {
    this.page = page;
    this.publish(page);
  }
  private showLoaded() {
    if (!this.loaded || !this.scope) return;
    const query = this.scope.query.trim().toLowerCase();
    this.update({
      ...this.loaded,
      choices:
        this.scope.kind === 'concept' && this.scope.source.conceptQuery === 'loaded-page'
          ? this.loaded.choices.filter((choice) => choice.label.toLowerCase().includes(query))
          : this.loaded.choices,
    });
  }
  private async load(generation: number) {
    if (generation !== this.generation) return;
    const scope = this.scope;
    if (!scope) return;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.update(loading);
    try {
      if (scope.kind === 'concept' && !scope.schemeId) throw new BoardChoiceUnavailable();
      const input = { query: scope.query, ...(this.cursor === undefined ? {} : { cursor: this.cursor }) };
      const result =
        scope.kind === 'scheme'
          ? await scope.source.schemes(input)
          : await scope.source.concepts({ ...input, schemeId: scope.schemeId });
      if (generation !== this.generation || controller.signal.aborted || !this.matches(scope)) return;
      const choices = 'schemes' in result ? result.schemes : result.concepts;
      this.loaded = {
        status: 'ready',
        choices,
        next: result.next,
        ...(result.as_of === undefined ? {} : { as_of: result.as_of }),
        ...(result.freshness === undefined ? {} : { freshness: result.freshness }),
      };
      this.showLoaded();
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted && this.matches(scope)) {
        const status = error instanceof BoardChoiceError ? error.reason : 'unavailable';
        this.update({
          status,
          choices: [],
          next: null,
          ...(this.cursor !== undefined && (status === 'invalid' || status === 'unavailable')
            ? { canRestart: true as const }
            : {}),
        });
      }
    }
  }
}
