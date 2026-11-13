import type { Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure } from './contract';
import type { HostedOwnedBook } from './hosted-contract';
import type { ReleaseProgress } from './hosted-release-preparation-contract';
import type { ActivationKind, ActivationProgress, ActivationRequest, HostedReleaseActivationTransport } from './hosted-release-activation-contract';
import { HostedReleaseReaderLinkProjection } from './hosted-release-reader-link';

export type ActivationReview = Readonly<{
  catalogueId: string;
  title: string;
  stageId: string;
  sourceRevisionId: string;
  expectedHeadRevisionId: string;
  expectedPublicationId: string | null;
  candidateId: string;
  candidateGenerationId: string;
  placementCount: string;
  chapterCount: string;
}>;

/** Use the immutable stage binding, never substitute a later draft or a later publication observation. */
export function preparedActivationReview(owner: HostedOwnedBook, prepared: ReleaseProgress): ActivationReview | null {
  const { stage, candidate } = prepared;
  if (
    !prepared.candidateReady || !candidate?.sealed || !candidate.coverageComplete ||
    prepared.catalogueId !== owner.item.catalogueId ||
    stage.locator.catalogueId !== prepared.catalogueId || stage.locator.stageId !== prepared.stageId ||
    !stage.sourceRevisionId || stage.sourceRevisionId !== stage.expectedHeadRevisionId ||
    !Object.prototype.hasOwnProperty.call(stage, 'expectedPublicationId')
  ) return null;
  return {
    catalogueId: prepared.catalogueId,
    title: owner.item.title ?? '',
    stageId: prepared.stageId,
    sourceRevisionId: stage.sourceRevisionId,
    expectedHeadRevisionId: stage.expectedHeadRevisionId,
    expectedPublicationId: stage.expectedPublicationId!,
    candidateId: candidate.candidateId,
    candidateGenerationId: candidate.generationId,
    placementCount: candidate.placementCount,
    chapterCount: candidate.chapterCount,
  };
}

export type ActivationPhase = 'review' | 'checking' | 'ready' | 'restart' | 'unknown' | 'blocked' | 'activated';
export type ActivationReadback = 'idle' | 'reading' | 'observed' | 'unavailable' | 'different' | 'not-public' | 'empty' | 'verified';
export type ActivationState =
  | { kind: 'ended'; reason: 'session' | 'denied' }
  | {
      kind: 'active';
      review: ActivationReview;
      phase: ActivationPhase;
      progress: ActivationProgress | null;
      /** A receipt survives failed readback. A current observation never supplies this acknowledgment. */
      receipt: ActivationProgress | null;
      pending: ActivationRequest | null;
      paused: boolean;
      busy: boolean;
      readback: ActivationReadback;
      observedPublicationId: string | null | undefined;
      error: StudioFailure | null;
    };
export type ActivationOptions = {
  owner: HostedOwnedBook;
  review: ActivationReview;
  source: HistoricalReaderSource;
  csrfToken: string;
  locale: Locale;
  native: HostedReleaseActivationTransport;
};

/** One private visit, one explicit in-flight action, one retained uncertain intent. No background authority loop. */
export class HostedReleaseActivationVisit {
  private state: ActivationState;
  private readonly origin;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private request: AbortController | null = null;
  private retired = false;
  readonly readerLink: HostedReleaseReaderLinkProjection;

  constructor(private readonly options: ActivationOptions) {
    this.origin = options.source.read();
    this.state = {
      kind: 'active', review: options.review, phase: 'review', progress: null, receipt: null,
      pending: null, paused: false, busy: false, readback: 'idle', observedPublicationId: undefined, error: null,
    };
    this.readerLink = new HostedReleaseReaderLinkProjection(
      options.review.catalogueId, this.isCurrent, options.native.admitPublic,
    );
    this.unsubscribe = options.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    if (!this.isCurrent()) this.retire();
  }
  snapshot = (): ActivationState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = () => {
    const now = this.options.source.read();
    return !this.retired && this.origin.healthy && now.healthy && this.origin.csrfReady && now.csrfReady &&
      this.origin.state === 'signed-in' && now.state === 'signed-in' &&
      this.origin.credentialMode === 'session' && now.credentialMode === 'session' &&
      this.origin.subject === this.options.owner.viewer.accountId && now.subject === this.origin.subject &&
      now.sourceId === this.origin.sourceId && now.generation === this.origin.generation;
  };
  private update(state: ActivationState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private retire(reason: 'session' | 'denied' = 'session') {
    if (this.retired) return;
    this.retired = true;
    this.request?.abort();
    this.request = null;
    this.readerLink.clear();
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

  start = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'review') await this.perform('start');
  };
  checkNext = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'checking' && !this.state.paused)
      await this.perform('advance');
  };
  restartAuthority = async () => {
    // Content's advance resets a restart pass and checks one page. The candidate is never rebuilt.
    if (this.state.kind === 'active' && this.state.phase === 'restart') await this.perform('advance');
  };
  activate = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'ready') await this.perform('activate');
  };
  retry = async () => {
    if (this.state.kind === 'active' && this.state.phase === 'unknown') await this.perform('retry');
  };
  pause = () => {
    if (this.current() && this.state.kind === 'active' && this.state.phase === 'checking')
      this.update({ ...this.state, paused: true });
  };
  resume = () => {
    if (this.idle() && this.state.kind === 'active' && this.state.phase === 'checking')
      this.update({ ...this.state, paused: false });
  };

  private async perform(kind: ActivationKind | 'retry') {
    if (!this.idle() || this.state.kind !== 'active') return;
    const state = this.state;
    const request = new AbortController();
    const command: ActivationRequest = kind === 'retry' ? state.pending! : {
      kind,
      catalogueId: state.review.catalogueId,
      stageId: state.review.stageId,
      candidateGenerationId: state.review.candidateGenerationId,
      expectedViewer: { ...this.options.owner.viewer },
      idempotencyKey: crypto.randomUUID(),
      body: { stageId: state.review.stageId },
    };
    this.request = request;
    this.readerLink.clear();
    this.update({ ...state, busy: true, pending: command, error: null });
    let acknowledged = false;
    try {
      const result = await this.options.native.command(command, request.signal, this.options.csrfToken);
      if (!this.current(request) || this.state.kind !== 'active') return;
      const active = this.state;
      if (!result.ok) {
        if (result.error.kind === 'denied') return this.retire('denied');
        const uncertain = result.error.kind === 'uncertain';
        this.update({ ...active, phase: uncertain ? 'unknown' : 'blocked', busy: false,
          pending: uncertain ? command : null, error: result.error });
        return;
      }
      const progress = result.value;
      acknowledged = progress.state === 'activated';
      this.update({ ...active, progress, phase: progress.state, pending: null, busy: false,
        paused: active.paused && progress.state === 'checking',
        receipt: acknowledged ? progress : null, readback: 'idle', error: null });
    } finally {
      if (this.request === request) this.request = null;
    }
    if (acknowledged) await this.readPublication();
  }

  /** Recover readback without resending activation. While uncertain, a read stays an observation only. */
  readPublication = async () => {
    if (!this.idle() || this.state.kind !== 'active') return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.readerLink.clear();
    this.update({ ...state, busy: true, readback: 'reading', error: null });
    try {
      const result = await this.options.native.readOwn(
        this.options.owner.viewer.accountId, state.review.catalogueId, request.signal, this.options.owner.viewer,
      );
      if (!this.current(request) || this.state.kind !== 'active') return;
      if (!result.ok) {
        if (result.error.kind === 'denied') return this.retire('denied');
        this.update({ ...this.state, readback: 'unavailable', busy: false, error: result.error });
        return;
      }
      const owner = result.value.item;
      const observedPublicationId = owner.publicationId;
      this.update({ ...this.state, observedPublicationId });
      const receipt = state.receipt;
      if (!receipt) {
        this.update({ ...this.state, busy: false, readback: 'observed' });
        return;
      }
      if (owner.catalogueId !== state.review.catalogueId || observedPublicationId !== receipt.publicationId) {
        this.update({ ...this.state, busy: false, readback: 'different' });
        return;
      }
      const metadata = await this.options.native.readMetadata({
        catalogueId: state.review.catalogueId, kind: 'publication', revisionId: receipt.publicationId!,
      }, request.signal);
      if (!this.current(request) || this.state.kind !== 'active') return;
      if (!metadata.ok) {
        if (metadata.error.kind === 'denied') return this.retire('denied');
        this.update({ ...this.state, busy: false, readback: 'unavailable', error: metadata.error });
        return;
      }
      if (metadata.value.catalogueId !== owner.catalogueId || metadata.value.kind !== 'publication' ||
        metadata.value.revisionId !== receipt.publicationId) {
        this.update({ ...this.state, busy: false, readback: 'different' });
        return;
      }
      const nonempty = BigInt(state.review.chapterCount) > 0n;
      await this.readerLink.confirmBounded(owner, {
        catalogueId: owner.catalogueId, revisionId: receipt.publicationId!, nonempty,
      }, request.signal);
      if (!this.current(request) || this.state.kind !== 'active') return;
      this.update({ ...this.state, busy: false,
        readback: this.readerLink.snapshot() ? 'verified' : nonempty ? 'not-public' : 'empty' });
    } catch (error) {
      if (!(error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError'))) throw error;
      if (this.current(request) && this.state.kind === 'active')
        this.update({ ...this.state, busy: false, readback: 'unavailable' });
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
