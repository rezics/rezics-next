import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure } from './contract';
import type { HostedBookNative, HostedOwnedBook } from './hosted-contract';
import {
  baselineNextBody,
  type BaselineProgress,
  type BaselineRequest,
  type BaselineVersion,
} from './hosted-legacy-baseline-contract';
import type { BaselineAdvance } from './hosted-legacy-baseline-native';

export type BaselineTransport = Pick<HostedBookNative, 'readOwn'> & { advance: BaselineAdvance };
export type BaselineReview = Readonly<BaselineVersion & { catalogueId: string; title: string }>;
export type BaselineIntent = Readonly<{
  request: BaselineRequest;
  csrfToken: string;
  binding: Readonly<{ sourceId: string; generation: number; accountId: string; locale: Locale }>;
}>;
export type BaselinePhase = 'review' | 'preparing' | 'step-ready' | 'unknown' | 'stale' | 'unavailable' | 'done';
export type BaselineState =
  | Readonly<{ kind: 'ended' }>
  | Readonly<{
      kind: 'active';
      phase: BaselinePhase;
      candidate: HostedOwnedBook | null;
      original: BaselineReview | null;
      progress: BaselineProgress | null;
      intent: BaselineIntent | null;
      refreshing: boolean;
      readFailed: boolean;
      error: StudioFailure | null;
    }>;
type Options = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource;
  locale: Locale;
  csrfToken: string;
  native: BaselineTransport;
};

/** One visit, one frozen source and one retained command. No background work or status endpoint. */
export class HostedLegacyBaselineVisit {
  private state: BaselineState;
  private readonly origin;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private request: AbortController | null = null;
  private retired = false;

  constructor(private readonly options: Options) {
    this.origin = options.source.read();
    this.state = {
      kind: 'active',
      phase: options.owner.item.publicationId ? 'review' : 'unavailable',
      candidate: options.owner,
      original: null,
      progress: null,
      intent: null,
      refreshing: false,
      readFailed: false,
      error: null,
    };
    this.unsubscribe = options.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    if (!this.isCurrent()) this.retire();
  }
  snapshot = (): BaselineState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = (): boolean => {
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
  private update(state: BaselineState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private retire() {
    if (this.retired) return;
    this.retired = true;
    this.request?.abort();
    this.request = null;
    this.unsubscribe?.();
    this.update({ kind: 'ended' });
    this.listeners.clear();
  }
  dispose = () => this.retire();
  private current(request?: AbortController) {
    if (!this.isCurrent()) this.retire();
    return !this.retired && (!request || (this.request === request && !request.signal.aborted));
  }

  /** The review action freezes the exact owner operands. It is also the only way to replace a stale intent. */
  confirmReview = () => {
    if (!this.current() || this.state.kind !== 'active' || this.state.phase !== 'review' || this.state.refreshing)
      return;
    const candidate = this.state.candidate!;
    if (candidate.item.publicationId === null) return;
    const original: BaselineReview = {
      catalogueId: candidate.item.catalogueId,
      title: candidate.item.title ?? '',
      expectedRevisionId: candidate.item.headRevisionId,
      expectedPublicationId: candidate.item.publicationId,
    };
    this.update({ ...this.state, original, progress: null, intent: null, phase: 'step-ready', error: null });
  };

  continue = async (): Promise<void> => {
    if (!this.current() || this.state.kind !== 'active' || this.state.refreshing) return;
    const state = this.state;
    if ((state.phase !== 'step-ready' && state.phase !== 'unknown') || !state.original) return;
    let intent = state.intent;
    if (state.phase === 'step-ready') {
      const body = baselineNextBody(state.original, state.progress);
      if (!body) return;
      // Only the two native version operands belong in the body, never presentation metadata.
      intent = {
        request: {
          catalogueId: state.original.catalogueId,
          body,
          expectedViewer: { ...this.options.owner.viewer },
          idempotencyKey: crypto.randomUUID(),
        },
        csrfToken: this.options.csrfToken,
        binding: {
          sourceId: this.origin.sourceId,
          generation: this.origin.generation,
          accountId: this.options.owner.viewer.accountId,
          locale: this.options.locale,
        },
      };
    }
    const frozen = intent!;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'preparing', intent: frozen, error: null });
    try {
      const result = await this.options.native.advance(frozen.request, request.signal, frozen.csrfToken);
      if (!this.current(request)) return;
      if (!result.ok) {
        this.update({
          ...state,
          intent: frozen,
          phase:
            result.error.kind === 'uncertain' ? 'unknown' : result.error.kind === 'stale' ? 'stale' : 'unavailable',
          candidate: null,
          error: result.error,
        });
        return;
      }
      this.update({
        ...state,
        intent: null,
        progress: result.value,
        error: null,
        phase: result.value.nextStep === 'done' ? 'done' : 'step-ready',
      });
    } finally {
      if (this.request === request) this.request = null;
    }
  };

  /** A separate exact-owner observation never discards a receipt or alters an uncertain request. */
  refreshReview = async (): Promise<void> => {
    if (!this.current() || this.state.kind !== 'active' || this.state.refreshing || this.state.phase === 'preparing')
      return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, refreshing: true, readFailed: false });
    try {
      const result = await this.options.native.readOwn(
        this.options.owner.viewer.accountId,
        this.options.owner.item.catalogueId,
        request.signal,
        this.options.owner.viewer,
      );
      if (!this.current(request)) return;
      if (!result.ok) {
        this.update({ ...state, refreshing: false, readFailed: true });
        return;
      }
      // Unknown replay and acknowledged progress remain bound to their original version.
      const needsReview = state.phase === 'stale' || state.phase === 'unavailable' || state.phase === 'review';
      this.update({
        ...state,
        candidate: result.value,
        refreshing: false,
        readFailed: false,
        phase: needsReview ? (result.value.item.publicationId ? 'review' : 'unavailable') : state.phase,
      });
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
