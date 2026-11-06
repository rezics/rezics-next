import type {
  AuthorContributionActionsResponse,
  AuthorContributionActionsWire,
  ContributionActionsInput,
  ContributionReference,
} from './wire';

export type {
  AuthorContributionActionsResponse,
  AuthorContributionActionsWire,
  ContributionActionsInput,
  ContributionReference,
} from './wire';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const revision = (value: unknown): value is string | null => value === null || uuid(value);
const views: readonly unknown[] = ['posts', 'reviews', 'discussion'];
const isView = (value: unknown): value is ContributionActionsInput['view'] => views.includes(value);
const admittedCursor = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4096);

/** Consume only the actual anonymous native selection. Row/browser IDs never supply references. */
export function contributionActionsInput(
  accountId: unknown,
  view: unknown,
  cursor: unknown,
  selection: unknown,
): ContributionActionsInput | undefined {
  if (
    !uuid(accountId) ||
    !isView(view) ||
    !admittedCursor(cursor) ||
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

/** The server boundary receives the browser's whole selection request as untrusted data. */
export function contributionActionsRequest(value: unknown): ContributionActionsInput | undefined {
  return record(value) ? contributionActionsInput(value.accountId, value.view, value.cursor, value) : undefined;
}

export type ContributionActionsState<T> =
  | Readonly<{ state: 'unavailable' | 'pending' | 'failed' | 'retired' }>
  | Readonly<{ state: 'ready'; value: T }>;

/**
 * One cohort lifetime, with an opaque credential/client/page episode supplied by its host.
 * A host must dispose on every episode replacement, including away/return with equal values.
 * This reader owns no writes: command owners must also consult isCurrent before every attempt.
 */
export class ContributionActionsReceiver<T = AuthorContributionActionsResponse> {
  private generation = 0;
  private abort: AbortController | undefined;
  private flight: Promise<void> | undefined;
  private retired = false;
  private current: ContributionActionsState<T> = { state: 'unavailable' };
  private admitted: T | undefined;
  private listeners = new Set<() => void>();

  constructor(
    readonly input: ContributionActionsInput,
    private wire: AuthorContributionActionsWire<T>,
    private originCurrent: () => boolean,
  ) {}

  isCurrent = (): boolean => {
    if (!this.retired && !this.originCurrent()) this.retire();
    return !this.retired;
  };
  snapshot = (): ContributionActionsState<T> => {
    this.isCurrent();
    return this.current;
  };
  /**
   * The last advice this visit read. A refresh keeps it until readback replaces it, so admitted owners stay mounted;
   * it never acknowledges a write, and retirement clears it.
   */
  advice = (): T | undefined => (this.isCurrent() ? this.admitted : undefined);
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
        if (this.isCurrent() && generation === this.generation && !abort.signal.aborted) {
          this.admitted = value;
          this.publish({ state: 'ready', value });
        }
      } catch {
        if (this.isCurrent() && generation === this.generation && !abort.signal.aborted)
          this.publish({ state: 'failed' });
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

  retire = () => this.finishRetirement(true);

  /** Replace a visit during render without notifying the previous external-store subscriber. */
  retireSilently = () => this.finishRetirement(false);

  private finishRetirement(notify: boolean) {
    if (this.retired) return;
    this.retired = true;
    this.admitted = undefined;
    ++this.generation;
    this.abort?.abort();
    this.abort = undefined;
    this.flight = undefined;
    if (notify) this.publish({ state: 'retired' });
    else this.current = { state: 'retired' };
    this.listeners.clear();
  }
}
