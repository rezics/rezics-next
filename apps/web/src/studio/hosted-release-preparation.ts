import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedBookNative, HostedOutlineWindowNative, HostedOwnedBook } from './hosted-contract';
import type { StudioFailure } from './contract';
import { hostedOccurrenceId } from './hosted-structure';
import {
  releaseReadiness,
  type ReleaseMode,
  type ReleaseProgress,
  type ReleaseRequest,
} from './hosted-release-preparation-contract';
import type { ReleaseCommand } from './hosted-release-preparation-native';
import { HostedReleaseSelectionWindow, type ReleaseSelectionState } from './hosted-release-selection';

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
  | 'selecting'
  | 'paused'
  | 'unknown'
  | 'invalid'
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
      mode: ReleaseMode | null;
      progress: ReleaseProgress | null;
      pending: ReleaseRequest | null;
      selection: ReleaseSelectionState | null;
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
  selectionNative?: HostedOutlineWindowNative;
  stageId?: string | null;
  locate?: (stageId: string | null) => void;
};

/** Native input is authoritative. This visit retains one outline window and one exact pending command. */
export class HostedReleasePreparationVisit {
  private state: ReleaseState;
  private readonly origin;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private request: AbortController | null = null;
  private selectionWindow: HostedReleaseSelectionWindow | null = null;
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
      mode: null,
      progress: null,
      pending: null,
      selection: null,
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
  private closeSelection() {
    this.selectionWindow?.dispose();
    this.selectionWindow = null;
  }
  private retire(reason: 'session' | 'denied' = 'session') {
    if (this.retired) return;
    this.retired = true;
    this.running = false;
    this.request?.abort();
    this.request = null;
    this.closeSelection();
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
  private collecting() {
    return (
      this.idle() &&
      this.state.kind === 'active' &&
      this.state.phase === 'selecting' &&
      this.state.progress?.stage.mode === 'selection' &&
      this.state.progress.stage.state === 'collecting'
    );
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
  start = async (mode: ReleaseMode = 'whole') => {
    if (!this.idle() || this.state.kind !== 'active' || this.state.phase !== 'reviewed') return;
    this.update({ ...this.state, mode });
    await this.perform('start');
  };
  retry = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'unknown') await this.perform('retry');
  };
  readProgress = async () => {
    if (this.state.kind === 'active' && this.state.stageId && this.state.phase !== 'unknown' && !this.running)
      await this.perform('progress');
  };
  choosePlacement = (occurrenceId: string) => {
    if (this.collecting()) this.selectionWindow?.toggle(occurrenceId);
  };
  loadSelectionPage = async (direction: 'next' | 'first' | 'retry') => {
    if (!this.collecting() || this.state.kind !== 'active' || this.state.selection?.occurrenceIds.length) return;
    if (direction === 'next') await this.selectionWindow?.next();
    else if (direction === 'first') await this.selectionWindow?.first();
    else await this.selectionWindow?.load();
  };
  appendSelection = async () => {
    if (
      this.collecting() &&
      this.state.kind === 'active' &&
      this.state.selection?.outline.kind === 'ready' &&
      this.state.selection.occurrenceIds.length
    )
      await this.perform('append');
  };
  freezeSelection = async () => {
    if (
      this.collecting() &&
      this.state.kind === 'active' &&
      this.state.progress!.stage.inputCount !== '0' &&
      !this.state.selection?.occurrenceIds.length
    )
      await this.perform('freeze');
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

  private async openSelection() {
    if (!this.collecting() || this.state.kind !== 'active' || !this.state.review || this.selectionWindow) return;
    // A locator-only resume cannot recover the pinned revision from the counts response.
    // It can freeze stored input, but new pages need a newly reviewed stage, never an assumed current draft.
    const { review, owner } = this.state;
    const window = new HostedReleaseSelectionWindow(
      this.options.selectionNative!,
      this.options.source,
      owner.viewer.accountId,
      {
        catalogueId: review.catalogueId,
        revisionId: review.expectedRevisionId,
        kind: 'structure',
        sourceRevisionId: null,
      },
      () => this.isCurrent() && this.selectionWindow === window,
      (selection) => {
        if (this.state.kind === 'active') this.update({ ...this.state, selection });
      },
    );
    this.selectionWindow = window;
    this.update({ ...this.state, selection: window.snapshot() });
    await window.load();
  }

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
        const catalogueId = state.owner.item.catalogueId;
        const stageId = kind === 'start' ? await hostedOccurrenceId(catalogueId, key) : state.stageId!;
        const envelope = {
          catalogueId,
          stageId,
          idempotencyKey: key,
          expectedViewer: { ...state.owner.viewer },
          ...(state.mode ? { expectedMode: state.mode } : {}),
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
                mode: state.mode!,
              },
            };
            break;
          case 'append':
            command = {
              ...envelope,
              kind,
              body: {
                batchId: await hostedOccurrenceId(catalogueId, key),
                occurrenceIds: [...state.selection!.occurrenceIds],
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
        const phase =
          result.error.kind === 'uncertain'
            ? 'unknown'
            : result.error.kind === 'stale'
              ? 'stale'
              : result.error.kind === 'invalid'
                ? 'invalid'
                : 'unavailable';
        if (phase !== 'unknown') this.closeSelection();
        this.update({
          ...active,
          busy: false,
          running: false,
          error: result.error,
          pending: phase === 'unknown' ? frozen : null,
          selection: phase === 'unknown' ? active.selection : null,
          phase,
        });
        return;
      }
      const progress = result.value;
      const terminal = ['expired', 'cancelled', 'failed'].includes(progress.stage.state);
      const readiness = releaseReadiness(progress);
      const phase = terminal
        ? (progress.stage.state as 'expired' | 'cancelled' | 'failed')
        : progress.stage.mode === 'selection' && progress.stage.state === 'collecting'
          ? 'selecting'
          : readiness === 'advance'
            ? 'paused'
            : readiness;
      if (phase !== 'paused') this.running = false;
      if (phase !== 'selecting') this.closeSelection();
      this.update({
        ...active,
        progress,
        mode: progress.stage.mode,
        pending: null,
        selection: phase === 'selecting' ? active.selection : null,
        busy: false,
        running: this.running,
        phase,
        error: null,
      });
      if (frozen.kind === 'append') this.selectionWindow?.acknowledged();
    } finally {
      if (this.request === request) this.request = null;
    }
    await this.openSelection();
  }

  /** Restart obtains fresh owner admission first; an unresolved command must be replayed before discarding it. */
  refreshReview = async () => {
    if (!this.idle() || this.running || this.state.kind !== 'active' || this.state.phase === 'unknown') return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.closeSelection();
    this.update({ ...state, selection: null, busy: true, error: null });
    try {
      const result = await this.options.native.readOwn(
        state.owner.viewer.accountId,
        state.owner.item.catalogueId,
        request.signal,
        state.owner.viewer,
      );
      if (!this.current(request)) return;
      if (!result.ok) {
        if (result.error.kind === 'denied') {
          this.retire('denied');
          return;
        }
        this.update({ ...state, selection: null, busy: false, error: result.error });
        return;
      }
      this.options.locate?.(null);
      this.update({
        ...state,
        owner: result.value,
        phase: 'review',
        stageId: null,
        mode: null,
        review: null,
        progress: null,
        pending: null,
        selection: null,
        busy: false,
        error: null,
      });
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
