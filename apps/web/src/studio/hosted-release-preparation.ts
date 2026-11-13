import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedBookNative, HostedOwnedBook } from './hosted-contract';
import type { StudioFailure } from './contract';
import { hostedOccurrenceId } from './hosted-structure';
import { releaseReadiness, type ReleaseProgress, type ReleaseRequest } from './hosted-release-preparation-contract';
import type { ReleaseCommand } from './hosted-release-preparation-native';

export type ReleaseTransport = Pick<HostedBookNative, 'readOwn'> & { command: ReleaseCommand };
export type ReleaseReview = Readonly<{
  catalogueId: string;
  title: string;
  expectedRevisionId: string;
  expectedPublicationId: string | null;
}>;
export type ReleasePhase =
  | 'review'
  | 'reviewed'
  | 'paused'
  | 'unknown'
  | 'ready'
  | 'prepared'
  | 'stale'
  | 'unavailable'
  | 'expired'
  | 'cancelled'
  | 'failed';
export type ReleaseState =
  | { kind: 'ended'; reason: 'session' | 'denied' }
  | {
      kind: 'active';
      phase: ReleasePhase;
      owner: HostedOwnedBook;
      review: ReleaseReview | null;
      stageId: string | null;
      progress: ReleaseProgress | null;
      pending: ReleaseRequest | null;
      busy: boolean;
      running: boolean;
      error: StudioFailure | null;
    };
type Options = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource;
  csrfToken: string;
  locale: Locale;
  native: ReleaseTransport;
  stageId?: string | null;
  locate?: (stageId: string | null) => void;
};

/** Visit-local work only. The native locator resumes persisted state; neither credentials nor placements persist here. */
export class HostedReleasePreparationVisit {
  private state: ReleaseState;
  private readonly origin;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private request: AbortController | null = null;
  private retired = false;
  private running = false;

  constructor(private readonly options: Options) {
    this.origin = options.source.read();
    this.state = {
      kind: 'active',
      phase: options.stageId ? 'paused' : 'review',
      owner: options.owner,
      review: null,
      stageId: options.stageId ?? null,
      progress: null,
      pending: null,
      busy: false,
      running: false,
      error: null,
    };
    this.unsubscribe = options.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    if (!this.isCurrent()) this.retire();
  }
  snapshot = (): ReleaseState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = () => {
    const now = this.options.source.read();
    return (
      !this.retired &&
      this.origin.healthy &&
      now.healthy &&
      this.origin.state === 'signed-in' &&
      now.state === 'signed-in' &&
      this.origin.credentialMode === 'session' &&
      now.credentialMode === 'session' &&
      this.origin.csrfReady &&
      now.csrfReady &&
      this.origin.subject === this.options.owner.viewer.accountId &&
      now.subject === this.origin.subject &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };
  private update(state: ReleaseState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private retire(reason: 'session' | 'denied' = 'session') {
    if (this.retired) return;
    this.retired = true;
    this.running = false;
    this.request?.abort();
    this.request = null;
    this.unsubscribe?.();
    this.update({ kind: 'ended', reason });
    this.listeners.clear();
  }
  dispose = () => this.retire();
  private current(request?: AbortController) {
    if (!this.isCurrent()) this.retire();
    return !this.retired && (!request || (this.request === request && !request.signal.aborted));
  }
  private idle() {
    return this.current() && !this.request && this.state.kind === 'active' && !this.state.busy;
  }

  /** This explicit action is the only place where current owner pointers become release operands. */
  confirmReview = () => {
    if (!this.idle() || this.state.kind !== 'active' || this.state.phase !== 'review') return;
    const { catalogueId, title, headRevisionId, publicationId } = this.state.owner.item;
    this.update({
      ...this.state,
      phase: 'reviewed',
      review: {
        catalogueId,
        title: title ?? '',
        expectedRevisionId: headRevisionId,
        expectedPublicationId: publicationId,
      },
      error: null,
    });
  };
  start = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'reviewed') await this.perform('start');
  };
  retry = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'unknown') await this.perform('retry');
  };
  readProgress = async () => {
    if (this.state.kind === 'active' && this.state.stageId && this.state.phase !== 'unknown' && !this.running)
      await this.perform('progress');
  };
  seal = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'ready' && !this.running) await this.perform('seal');
  };
  cancel = async () => {
    if (
      this.state.kind !== 'active' ||
      !this.state.stageId ||
      !this.state.progress ||
      this.state.phase === 'unknown' ||
      ['prepared', 'expired', 'cancelled', 'failed'].includes(this.state.phase) ||
      this.running
    )
      return;
    await this.perform('cancel');
  };
  pause = () => {
    this.running = false;
    if (this.state.kind === 'active') this.update({ ...this.state, running: false });
  };
  resume = async () => {
    if (
      !this.idle() ||
      this.running ||
      this.state.kind !== 'active' ||
      this.state.phase !== 'paused' ||
      !this.state.progress
    )
      return;
    this.running = true;
    this.update({ ...this.state, running: true });
    try {
      while (this.running && this.current() && this.state.kind === 'active' && this.state.phase === 'paused') {
        await this.perform('advance');
        // Yield between bounded native requests so pause, navigation and session changes can interrupt the loop.
        if (this.running) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.running = false;
      if (this.state.kind === 'active') this.update({ ...this.state, running: false });
    }
  };

  private async perform(kind: ReleaseRequest['kind'] | 'retry') {
    if (!this.idle() || this.state.kind !== 'active') return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, busy: true, error: null });
    try {
      let command = state.pending;
      if (kind !== 'retry') {
        const key = crypto.randomUUID();
        const catalogueId = this.options.owner.item.catalogueId;
        const stageId = kind === 'start' ? await hostedOccurrenceId(catalogueId, key) : state.stageId!;
        const envelope = {
          catalogueId,
          stageId,
          idempotencyKey: key,
          expectedViewer: { ...this.options.owner.viewer },
        };
        switch (kind) {
          case 'start':
            command = {
              ...envelope,
              kind,
              body: {
                stageId,
                expectedRevisionId: state.review!.expectedRevisionId,
                expectedPublicationId: state.review!.expectedPublicationId,
                mode: 'whole',
              },
            };
            break;
          case 'advance':
            command = { ...envelope, kind, body: { stepId: await hostedOccurrenceId(catalogueId, key) } };
            break;
          default:
            command = { ...envelope, kind, body: {} };
            break;
        }
      }
      if (!this.current(request)) return;
      const frozen = command!;
      this.update({
        ...(this.state as Extract<ReleaseState, { kind: 'active' }>),
        pending: frozen,
        stageId: frozen.stageId,
      });
      if (frozen.kind === 'start') this.options.locate?.(frozen.stageId);
      const result = await this.options.native.command(frozen, request.signal, this.options.csrfToken);
      if (!this.current(request)) return;
      const active = this.state as Extract<ReleaseState, { kind: 'active' }>;
      if (!result.ok) {
        this.running = false;
        if (result.error.kind === 'denied') {
          this.retire('denied');
          return;
        }
        this.update({
          ...active,
          busy: false,
          running: false,
          error: result.error,
          pending: result.error.kind === 'uncertain' ? frozen : null,
          phase:
            result.error.kind === 'uncertain' ? 'unknown' : result.error.kind === 'stale' ? 'stale' : 'unavailable',
        });
        return;
      }
      const progress = result.value;
      const terminal = ['expired', 'cancelled', 'failed'].includes(progress.stage.state);
      const readiness = releaseReadiness(progress);
      const phase = terminal
        ? (progress.stage.state as 'expired' | 'cancelled' | 'failed')
        : readiness === 'advance'
          ? 'paused'
          : readiness;
      if (phase !== 'paused') this.running = false;
      this.update({ ...active, progress, pending: null, busy: false, running: this.running, phase, error: null });
    } finally {
      if (this.request === request) this.request = null;
    }
  }

  /** Restart obtains fresh owner admission first; an unresolved command must be replayed before discarding it. */
  refreshReview = async () => {
    if (!this.idle() || this.running || this.state.kind !== 'active' || this.state.phase === 'unknown') return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, busy: true, error: null });
    try {
      const result = await this.options.native.readOwn(
        this.options.owner.viewer.accountId,
        this.options.owner.item.catalogueId,
        request.signal,
        this.options.owner.viewer,
      );
      if (!this.current(request)) return;
      if (!result.ok) {
        if (result.error.kind === 'denied') {
          this.retire('denied');
          return;
        }
        this.update({ ...state, busy: false, error: result.error });
        return;
      }
      this.options.locate?.(null);
      this.update({
        ...state,
        owner: result.value,
        phase: 'review',
        stageId: null,
        review: null,
        progress: null,
        pending: null,
        busy: false,
        error: null,
      });
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
