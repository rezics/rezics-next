/** Local public-wire seam. The complete-input publisher owns the eventual installed DTO. */
export type ContributionReference = Readonly<
  | { type: 'content.thread'; id: string; placeId: string; sourceRevisionId: string | null }
  | {
      type: 'content.post';
      id: string;
      threadId: string;
      placeId: string;
      threadRevisionId: string | null;
      sourceRevisionId: string | null;
    }
>;
export type ContributionActionsInput = Readonly<{
  accountId: string;
  view: 'posts' | 'reviews' | 'discussion';
  cursor: string | null;
  proof: string;
  references: readonly ContributionReference[];
}>;

export interface AuthorContributionActionsWire<T = never> {
  /** One selected native read; implementations must retain private/no-store transport semantics. */
  read(input: ContributionActionsInput, signal: AbortSignal): Promise<T>;
}

export class ContributionActionsUnavailable extends Error {
  constructor() {
    super('The complete-input publisher has not installed author_contributions.actions');
  }
}

/** No producer imports, generated declaration edits or speculative SDK method calls. */
export const unavailableAuthorContributionActionsWire: AuthorContributionActionsWire = {
  async read() {
    throw new ContributionActionsUnavailable();
  },
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const revision = (value: unknown): value is string | null => value === null || uuid(value);

/** Consume only the actual anonymous native selection. Row/browser IDs never supply references. */
export function contributionActionsInput(
  accountId: string,
  view: ContributionActionsInput['view'],
  cursor: string | null,
  selection: unknown,
): ContributionActionsInput | undefined {
  if (
    !uuid(accountId) ||
    !['posts', 'reviews', 'discussion'].includes(view) ||
    (cursor !== null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096)) ||
    !record(selection) ||
    typeof selection.proof !== 'string' ||
    !selection.proof.length ||
    selection.proof.length > 4096 ||
    !Array.isArray(selection.references) ||
    !selection.references.length ||
    selection.references.length > 20
  )
    return;
  const references: ContributionReference[] = [];
  const seen = new Set<string>();
  for (const value of selection.references) {
    if (!record(value) || !uuid(value.id) || !uuid(value.placeId) || !revision(value.sourceRevisionId)) return;
    const identity = `${value.type}:${value.id}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    if (value.type === 'content.thread' && view !== 'posts') {
      references.push(
        Object.freeze({
          type: value.type,
          id: value.id,
          placeId: value.placeId,
          sourceRevisionId: value.sourceRevisionId,
        }),
      );
    } else if (
      value.type === 'content.post' &&
      view === 'posts' &&
      uuid(value.threadId) &&
      revision(value.threadRevisionId)
    ) {
      references.push(
        Object.freeze({
          type: value.type,
          id: value.id,
          threadId: value.threadId,
          placeId: value.placeId,
          threadRevisionId: value.threadRevisionId,
          sourceRevisionId: value.sourceRevisionId,
        }),
      );
    } else return;
  }
  return Object.freeze({ accountId, view, cursor, proof: selection.proof, references: Object.freeze(references) });
}

export type ContributionActionsState<T> =
  | Readonly<{ state: 'unavailable' | 'pending' | 'failed' | 'retired' }>
  | Readonly<{ state: 'ready'; value: T }>;

/**
 * One cohort lifetime, with an opaque credential/client/page episode supplied by its host.
 * A host must dispose on every episode replacement, including away/return with equal values.
 * This reader owns no writes: command owners must also consult isCurrent before every attempt.
 */
export class ContributionActionsReceiver<T> {
  private generation = 0;
  private abort: AbortController | undefined;
  private flight: Promise<void> | undefined;
  private retired = false;
  private current: ContributionActionsState<T> = { state: 'unavailable' };
  private listeners = new Set<() => void>();

  constructor(
    readonly input: ContributionActionsInput,
    private wire: AuthorContributionActionsWire<T>,
    private originCurrent: () => boolean,
  ) {}

  isCurrent = (): boolean => !this.retired && this.originCurrent();
  snapshot = (): ContributionActionsState<T> => (this.isCurrent() ? this.current : { state: 'retired' });
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: ContributionActionsState<T>) {
    this.current = value;
    for (const listener of this.listeners) listener();
  }

  /** Coalesce concurrent refreshes and keep the exact input/frontier on retry. */
  refresh = (): Promise<void> => {
    if (!this.isCurrent()) return Promise.resolve();
    if (this.flight) return this.flight;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    // Defer transport until the in-flight guard is installed, including synchronous failures.
    const flight = Promise.resolve().then(async () => {
      if (!this.isCurrent() || abort.signal.aborted) return;
      try {
        const value = await this.wire.read(this.input, abort.signal);
        if (this.isCurrent() && generation === this.generation && !abort.signal.aborted)
          this.publish({ state: 'ready', value });
      } catch (error) {
        if (this.isCurrent() && generation === this.generation && !abort.signal.aborted)
          this.publish({ state: error instanceof ContributionActionsUnavailable ? 'unavailable' : 'failed' });
      } finally {
        if (generation === this.generation) {
          this.flight = undefined;
          this.abort = undefined;
        }
      }
    });
    this.flight = flight;
    this.publish({ state: 'pending' });
    return flight;
  };

  retire = () => {
    if (this.retired) return;
    this.retired = true;
    ++this.generation;
    this.abort?.abort();
    this.abort = undefined;
    this.flight = undefined;
    this.publish({ state: 'retired' });
    this.listeners.clear();
  };
}
