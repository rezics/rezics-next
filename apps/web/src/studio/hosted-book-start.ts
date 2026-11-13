import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure, StudioSelection } from './contract';
import type { StudioState } from './controller';
import { sameHostedViewer, type HostedBookNative, type HostedCreate, type HostedOwnerViewer } from './hosted-contract';
import { hostedOwnerBookHref } from './hosted-inventory';

/** Supplied only by the mounted account-draft visit, after its native page has been admitted. */
export type HostedBookStartBinding = Readonly<{
  native: Pick<HostedBookNative, 'create' | 'readOwn'>;
  source: HistoricalReaderSource;
  viewer: HostedOwnerViewer;
  isCurrent: () => boolean;
  navigate: (href: string) => void;
}>;

export type HostedBookStartState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'creating' | 'confirming' | 'ready' }>
  | Readonly<{ kind: 'failed'; error: StudioFailure; retryable: boolean }>
  | Readonly<{ kind: 'ended' }>;

type Intent = Readonly<{ body: HostedCreate; key: string; phase: 'create' | 'owner' }>;

/** A clean exact selection here comes from account-port's admitted opening, never route search. */
export function savedOpeningForBook(state: StudioState): StudioSelection | null {
  const selected = state.selected;
  return selected &&
    !state.busy &&
    !selected.dirty &&
    !selected.snapshotPending &&
    !selected.uploading &&
    !selected.invalid &&
    selected.source.visibility === 'draft' &&
    selected.source.permissions.edit &&
    selected.source.native
    ? selected.source
    : null;
}

/** One explicit create intent, retained through both uncertain writes and owner-read recovery. */
export class HostedBookStart {
  private state: HostedBookStartState = { kind: 'idle' };
  private intent: Intent | null = null;
  private request: AbortController | null = null;
  private readonly origin;
  private readonly listeners = new Set<() => void>();
  private connected = false;
  private retired = false;

  constructor(
    private readonly binding: HostedBookStartBinding,
    private readonly selection: () => StudioSelection | null,
    private readonly key: () => string = () => crypto.randomUUID(),
  ) {
    this.origin = binding.source.read();
  }

  snapshot = (): HostedBookStartState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  locked = () =>
    this.state.kind === 'creating' ||
    this.state.kind === 'confirming' ||
    this.state.kind === 'ready' ||
    (this.state.kind === 'failed' && this.state.retryable);

  private update(state: HostedBookStartState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  isCurrent = () => {
    const now = this.binding.source.read();
    return (
      !this.retired &&
      this.binding.isCurrent() &&
      this.origin.healthy &&
      this.origin.state === 'signed-in' &&
      this.origin.subject === this.binding.viewer.accountId &&
      now.healthy &&
      now.state === 'signed-in' &&
      now.subject === this.binding.viewer.accountId &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };

  private retire() {
    this.retired = true;
    this.request?.abort();
    this.intent = null;
    this.update({ kind: 'ended' });
  }

  connect = () => {
    this.connected = true;
    const unsubscribe = this.binding.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    if (!this.isCurrent()) this.retire();
    return () => {
      this.connected = false;
      unsubscribe();
      this.request?.abort();
      this.request = null;
      if (this.intent && !this.retired)
        this.update({
          kind: 'failed',
          retryable: true,
          error: { kind: 'uncertain', message: 'Retry this Book start.' },
        });
    };
  };

  start = async (): Promise<void> => {
    if (!this.connected || this.request || this.locked()) return;
    if (!this.isCurrent()) return this.retire();
    const selected = this.selection();
    if (!selected?.native || selected.visibility !== 'draft' || !selected.permissions.edit) return;
    this.intent = {
      body: { postId: selected.revision.exact.postId, threadId: selected.native.threadId, placements: [] },
      key: this.key(),
      phase: 'create',
    };
    await this.run();
  };

  retry = async (): Promise<void> => {
    if (this.state.kind === 'failed' && this.state.retryable) await this.run();
  };

  private async run() {
    if (!this.connected || this.request || !this.intent) return;
    if (!this.isCurrent()) return this.retire();
    const request = new AbortController();
    this.request = request;
    const intent = this.intent;
    const current = () => this.connected && !request.signal.aborted && this.isCurrent();
    try {
      if (intent.phase === 'create') {
        this.update({ kind: 'creating' });
        const created = await this.binding.native.create(intent.body, intent.key, request.signal);
        if (!current()) return;
        if (!created.ok && created.error.kind !== 'stale') {
          const retryable = created.error.kind === 'uncertain' || created.error.kind === 'unavailable';
          if (!retryable) this.intent = null;
          this.update({ kind: 'failed', error: created.error, retryable });
          return;
        }
        // A native conflict may mean this Post already has a catalogue. Only an exact owner read can reopen it.
        this.intent = { ...intent, phase: 'owner' };
      }
      this.update({ kind: 'confirming' });
      const owned = await this.binding.native.readOwn(
        this.binding.viewer.accountId,
        intent.body.postId,
        request.signal,
        this.binding.viewer,
      );
      if (!current()) return;
      if (!owned.ok) {
        this.update({ kind: 'failed', error: owned.error, retryable: true });
        return;
      }
      const { item, viewer } = owned.value;
      // Concrete external-response mismatch: a different opening or viewer must never become a destination.
      if (
        !sameHostedViewer(viewer, this.binding.viewer) ||
        item.catalogueId !== intent.body.postId ||
        item.threadId !== intent.body.threadId
      ) {
        this.retire();
        return;
      }
      this.update({ kind: 'ready' });
      if (current()) this.binding.navigate(hostedOwnerBookHref(item, viewer));
    } finally {
      if (this.request === request) this.request = null;
    }
  }
}
