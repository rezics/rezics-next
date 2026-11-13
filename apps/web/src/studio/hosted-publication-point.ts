import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { Locale } from '../paraglide/runtime.js';
import { sameExact, type StudioFailure, type StudioResult, type StudioRevision } from './contract';
import type {
  HostedCommandReceipt,
  HostedOwnedBook,
  HostedOwnerBook,
  HostedPublicationPointNative,
  HostedPublicationPointRequest,
  HostedTarget,
  HostedOutlineWindowPage,
} from './hosted-contract';
import type { DraftCommandIntent, DraftCommandTransport } from './hosted-draft-point-lifecycle';
import { HostedOutlineWindow } from './hosted-outline-window';
import { HostedReleaseReaderLinkProjection, type HostedReleaseReaderAdmission } from './hosted-release-reader-link';
import { HostedSourceConsentVisit, type SourceConsentTransport } from './hosted-source-consent';

type Row = Extract<HostedOutlineWindowPage['items'][number], { availability: 'available' }>;
export type PublicationPointAnchor = Readonly<{ revisionId: string; observation: number; item: Row }>;
type Ancestor = Readonly<{
  draft: PublicationPointAnchor;
  include: boolean;
  public: PublicationPointAnchor | null;
  before: PublicationPointAnchor | null;
}>;
type Phase =
  | 'loading'
  | 'idle'
  | 'selecting'
  | 'review'
  | 'submitting'
  | 'uncertain'
  | 'stale'
  | 'rejected'
  | 'acknowledged';
export type PublicationPointState =
  | Readonly<{
      kind: 'active';
      owner: HostedOwnerBook;
      observation: number;
      phase: Phase;
      operation: 'publish' | 'replace';
      chapter: PublicationPointAnchor | null;
      replacement: PublicationPointAnchor | null;
      ancestors: readonly Ancestor[];
      parent: PublicationPointAnchor | null;
      before: PublicationPointAnchor | null;
      destination: string | null;
      version: StudioRevision | null;
      versionObservation: number | null;
      draft: HostedOutlineWindow | null;
      publication: HostedOutlineWindow | null;
      intent: DraftCommandIntent<HostedPublicationPointRequest> | null;
      receipt: HostedCommandReceipt | null;
      error: StudioFailure | null;
      readbackError: StudioFailure | null;
    }>
  | Readonly<{ kind: 'ended' }>;
type Active = Extract<PublicationPointState, { kind: 'active' }>;
export type PublicationPointTransport = HostedPublicationPointNative & DraftCommandTransport;
export type PublicationPointOptions = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource;
  locale: Locale;
  csrfToken: string;
  native: PublicationPointTransport;
  readVersion(target: HostedTarget, signal: AbortSignal): Promise<StudioResult<StudioRevision>>;
  admit: HostedReleaseReaderAdmission;
  consent?: SourceConsentTransport;
};

function currentAnchor(state: Active, anchor: PublicationPointAnchor | null, publicSnapshot = false): boolean {
  return (
    anchor !== null &&
    anchor.observation === state.observation &&
    anchor.revisionId === (publicSnapshot ? state.owner.publicationId : state.owner.headRevisionId)
  );
}
/** Resolve only deliberately retained, depth-bounded observations; never infer absence from a page. */
export function publicationPointAncestors(state: Active): readonly Ancestor[] | null {
  const chain: Ancestor[] = [];
  let parentId = state.chapter?.item.parentId ?? null;
  while (parentId !== null) {
    const ancestor = state.ancestors.find((item) => item.draft.item.occurrenceId === parentId);
    if (!ancestor || chain.length === 15) return null;
    chain.unshift(ancestor);
    parentId = ancestor.draft.item.parentId;
  }
  return chain;
}
export function publicationPointReady(state: Active): boolean {
  const { chapter, version } = state;
  if (
    !state.owner.publicationId ||
    !currentAnchor(state, chapter) ||
    chapter?.item.kind !== 'chapter' ||
    !version ||
    state.versionObservation !== state.observation ||
    !sameExact(version.exact, chapter.item.target)
  )
    return false;
  if (state.operation === 'replace')
    return (
      currentAnchor(state, state.replacement, true) &&
      state.replacement?.item.kind === 'chapter' &&
      state.replacement.item.occurrenceId === chapter.item.occurrenceId &&
      state.replacement.item.target.postId === chapter.item.target.postId &&
      state.replacement.item.target.threadId === chapter.item.target.threadId
    );
  if (state.parent && !currentAnchor(state, state.parent, state.parent.revisionId === state.owner.publicationId))
    return false;
  if (
    state.before &&
    (!currentAnchor(state, state.before, true) ||
      state.before.item.parentId !== (state.parent?.item.occurrenceId ?? null))
  )
    return false;
  const chain = publicationPointAncestors(state);
  if (!chain) return false;
  if (
    state.parent &&
    state.parent.revisionId !== state.owner.publicationId &&
    !chain.some((a) => a.include && a.draft.item.occurrenceId === state.parent!.item.occurrenceId)
  )
    return false;
  return chain.every(
    (a) =>
      currentAnchor(state, a.draft) &&
      (a.include
        ? !a.before || (currentAnchor(state, a.before, true) && a.before.item.parentId === a.draft.item.parentId)
        : currentAnchor(state, a.public, true)),
  );
}

/** One exact draft/public window each. Commands and their independent readback never hydrate a Book. */
export class HostedPublicationPointVisit {
  private state: PublicationPointState;
  private readonly origin;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private readRequest: AbortController | null = null;
  private retired = false;
  readonly readerLink: HostedReleaseReaderLinkProjection;
  readonly sourceConsent: HostedSourceConsentVisit | null;

  constructor(private readonly options: PublicationPointOptions) {
    this.origin = options.source.read();
    this.state = {
      kind: 'active',
      owner: options.owner.item,
      observation: 0,
      phase: 'loading',
      operation: 'publish',
      chapter: null,
      replacement: null,
      ancestors: [],
      parent: null,
      before: null,
      destination: null,
      version: null,
      versionObservation: null,
      draft: null,
      publication: null,
      intent: null,
      receipt: null,
      error: null,
      readbackError: null,
    };
    this.readerLink = new HostedReleaseReaderLinkProjection(
      options.owner.item.catalogueId,
      this.isCurrent,
      options.admit,
    );
    this.sourceConsent = options.consent
      ? new HostedSourceConsentVisit({
          source: options.source,
          viewer: options.owner.viewer,
          csrfToken: options.csrfToken,
          isCurrent: this.isCurrent,
          native: options.consent,
        })
      : null;
    this.unsubscribe = options.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    if (!this.isCurrent()) this.retire();
  }
  snapshot = (): PublicationPointState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = (): boolean => {
    const now = this.options.source.read();
    return (
      !this.retired &&
      this.origin.healthy &&
      now.healthy &&
      this.origin.csrfReady &&
      now.csrfReady &&
      this.origin.state === 'signed-in' &&
      now.state === 'signed-in' &&
      this.origin.credentialMode === 'session' &&
      now.credentialMode === 'session' &&
      this.origin.subject === this.options.owner.viewer.accountId &&
      now.subject === this.origin.subject &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };
  private current(request?: AbortController) {
    if (!this.isCurrent()) this.retire();
    return (
      !this.retired &&
      (!request || (!request.signal.aborted && (this.request === request || this.readRequest === request)))
    );
  }
  private update(state: PublicationPointState) {
    this.state = state;
    // Only the already-opened exact version supplies operands; a page observation alone never does.
    this.sourceConsent?.select(
      state.kind === 'active' &&
        state.chapter?.item.kind === 'chapter' &&
        currentAnchor(state, state.chapter) &&
        state.version &&
        state.versionObservation === state.observation &&
        sameExact(state.version.exact, state.chapter.item.target)
        ? { catalogueId: state.owner.catalogueId, target: state.chapter.item.target }
        : null,
    );
    this.listeners.forEach((fn) => fn());
  }
  private retire() {
    if (this.retired) return;
    this.retired = true;
    this.request?.abort();
    this.readRequest?.abort();
    if (this.state.kind === 'active') {
      this.state.draft?.dispose();
      this.state.publication?.dispose();
    }
    this.readerLink.clear();
    this.sourceConsent?.dispose();
    this.update({ kind: 'ended' });
  }
  dispose = () => {
    this.unsubscribe();
    this.retire();
  };
  canEdit = () => this.state.kind === 'active' && ['idle', 'review', 'rejected'].includes(this.state.phase);
  private edit(change: (state: Active) => Active) {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active') return;
    this.readerLink.clear();
    this.update({ ...change(this.state), phase: 'idle', intent: null, error: null });
  }
  setOperation = (operation: Active['operation']) => this.edit((state) => ({ ...state, operation }));
  root = () => this.edit((state) => ({ ...state, parent: null, before: null, destination: null }));
  end = () =>
    this.edit((state) =>
      state.destination === null
        ? { ...state, before: null }
        : {
            ...state,
            ancestors: state.ancestors.map((a) =>
              a.draft.item.occurrenceId === state.destination ? { ...a, before: null } : a,
            ),
          },
    );
  destination = (destination: string | null) => this.edit((state) => ({ ...state, destination }));
  includeAncestor = (occurrenceId: string, include: boolean) =>
    this.edit((state) => ({
      ...state,
      ancestors: state.ancestors.map((a) => (a.draft.item.occurrenceId === occurrenceId ? { ...a, include } : a)),
    }));
  useAncestorParent = (occurrenceId: string) =>
    this.edit((state) => {
      const ancestor = state.ancestors.find((a) => a.include && a.draft.item.occurrenceId === occurrenceId);
      return ancestor ? { ...state, parent: ancestor.draft, before: null, destination: null } : state;
    });
  private row(window: HostedOutlineWindow | null, occurrenceId: string): PublicationPointAnchor | null {
    const page = window?.snapshot();
    if (this.state.kind !== 'active' || page?.kind !== 'ready') return null;
    const item = page.page.items.find((row) => row.occurrenceId === occurrenceId);
    return item?.availability === 'available'
      ? {
          revisionId: page.page.revisionId,
          observation: this.state.observation,
          item,
        }
      : null;
  }
  observeDraft = (occurrenceId: string) => {
    if (this.state.kind !== 'active') return;
    const anchor = this.row(this.state.draft, occurrenceId);
    if (!anchor) return;
    this.edit((state) =>
      anchor.item.kind === 'chapter'
        ? { ...state, chapter: anchor, version: null, versionObservation: null }
        : {
            ...state,
            ancestors: [
              ...state.ancestors.filter((a) => a.draft.item.occurrenceId !== occurrenceId),
              {
                draft: anchor,
                include: false,
                public: null,
                before: null,
              },
            ].slice(-15),
          },
    );
  };
  observePublic = (occurrenceId: string, role: 'parent' | 'before' | 'replacement' | 'ancestor') => {
    if (this.state.kind !== 'active') return;
    const anchor = this.row(this.state.publication, occurrenceId);
    if (!anchor) return;
    this.edit((state) => {
      if (role === 'parent')
        return anchor.item.kind === 'part' ? { ...state, parent: anchor, before: null, destination: null } : state;
      if (role === 'replacement')
        return anchor.item.kind === 'chapter' ? { ...state, replacement: anchor, operation: 'replace' } : state;
      if (role === 'ancestor')
        return {
          ...state,
          ancestors: state.ancestors.map((a) =>
            a.draft.item.occurrenceId === occurrenceId ? { ...a, public: anchor, include: false } : a,
          ),
        };
      if (state.destination !== null)
        return {
          ...state,
          ancestors: state.ancestors.map((a) =>
            a.draft.item.occurrenceId === state.destination && a.draft.item.parentId === anchor.item.parentId
              ? { ...a, before: anchor }
              : a,
          ),
        };
      return anchor.item.parentId === (state.parent?.item.occurrenceId ?? null) ? { ...state, before: anchor } : state;
    });
  };
  admitsPost = (postId: string) =>
    this.isCurrent() &&
    this.state.kind === 'active' &&
    this.state.chapter?.item.kind === 'chapter' &&
    this.state.chapter.item.target.postId === postId;

  readVersion = async () => {
    if (
      !this.current() ||
      !this.canEdit() ||
      this.state.kind !== 'active' ||
      this.state.chapter?.item.kind !== 'chapter'
    )
      return;
    const state = this.state;
    const target = this.state.chapter.item.target;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'selecting', intent: null, version: null, versionObservation: null, error: null });
    try {
      const result = await this.options.readVersion(target, request.signal);
      if (!this.current(request)) return;
      this.update(
        result.ok
          ? {
              ...state,
              phase: 'idle',
              version: result.value,
              versionObservation: state.observation,
              intent: null,
              error: null,
            }
          : { ...state, phase: 'rejected', version: null, versionObservation: null, intent: null, error: result.error },
      );
    } finally {
      if (this.request === request) this.request = null;
    }
  };

  /** Explicit refresh retires review even when a concurrent change returns the same pointers. */
  refresh = async () => {
    if (
      !this.current() ||
      this.state.kind !== 'active' ||
      this.request ||
      ['uncertain', 'submitting', 'acknowledged'].includes(this.state.phase)
    )
      return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.readerLink.clear();
    state.draft?.dispose();
    state.publication?.dispose();
    this.update({
      ...state,
      phase: 'loading',
      observation: state.observation + 1,
      draft: null,
      publication: null,
      intent: null,
      versionObservation: null,
      error: null,
    });
    try {
      const owner = await this.options.native.readOwn(
        this.options.owner.viewer.accountId,
        state.owner.catalogueId,
        request.signal,
        this.options.owner.viewer,
      );
      if (!this.current(request)) return;
      if (!owner.ok) {
        this.update({ ...(this.state as Active), phase: 'stale', error: owner.error });
        return;
      }
      const next = { ...(this.state as Active), owner: owner.value.item, phase: 'loading' as const };
      this.update(next);
      const catalogueId = next.owner.catalogueId;
      const draft = new HostedOutlineWindow(
        this.options.native,
        this.options.source,
        this.options.owner.viewer.accountId,
        { catalogueId, revisionId: next.owner.headRevisionId, kind: 'structure', sourceRevisionId: null },
        this.isCurrent,
      );
      this.update({ ...next, draft });
      const publicationId = next.owner.publicationId;
      if (publicationId) {
        const metadata = await this.options.native.readMetadata(
          { catalogueId, kind: 'publication', revisionId: publicationId },
          request.signal,
        );
        if (!this.current(request)) return;
        if (!metadata.ok) this.update({ ...(this.state as Active), phase: 'stale', error: metadata.error });
        else {
          const publication = new HostedOutlineWindow(
            this.options.native,
            this.options.source,
            this.options.owner.viewer.accountId,
            metadata.value,
            this.isCurrent,
          );
          this.update({ ...(this.state as Active), publication });
          await Promise.all([draft.load(), publication.load()]);
          if (this.current(request)) this.update({ ...(this.state as Active), phase: 'idle' });
          return;
        }
      }
      await draft.load();
      if (this.current(request) && (this.state as Active).phase === 'loading')
        this.update({ ...(this.state as Active), phase: 'idle' });
    } finally {
      if (this.request === request) this.request = null;
    }
  };
  review = () => {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active' || !publicationPointReady(this.state))
      return;
    const state = this.state;
    const chapter = state.chapter!.item as Extract<Row, { kind: 'chapter' }>;
    const body = {
      expectedRevisionId: state.owner.headRevisionId,
      expectedPublicationId: state.owner.publicationId!,
      occurrenceId: chapter.occurrenceId,
      target: { ...chapter.target },
    };
    const envelope = {
      catalogueId: state.owner.catalogueId,
      expectedViewer: { ...this.options.owner.viewer },
      idempotencyKey: crypto.randomUUID(),
    };
    const request: HostedPublicationPointRequest =
      state.operation === 'replace'
        ? { ...envelope, kind: 'replace', body }
        : {
            ...envelope,
            kind: 'publish',
            body: {
              ...body,
              parentId: state.parent?.item.occurrenceId ?? null,
              beforeOccurrenceId: state.before?.item.occurrenceId ?? null,
              selectedAncestors: publicationPointAncestors(state)!
                .filter((a) => a.include)
                .map((a) => ({
                  occurrenceId: a.draft.item.occurrenceId,
                  beforeOccurrenceId: a.before?.item.occurrenceId ?? null,
                })),
            },
          };
    this.update({
      ...state,
      phase: 'review',
      intent: {
        request,
        csrfToken: this.options.csrfToken,
        session: {
          sourceId: this.origin.sourceId,
          generation: this.origin.generation,
          accountId: this.options.owner.viewer.accountId,
          locale: this.options.locale,
        },
      },
      error: null,
    });
  };
  cancelReview = () => this.edit((state) => state);
  submit = async () => {
    if (
      !this.current() ||
      this.state.kind !== 'active' ||
      !['review', 'uncertain'].includes(this.state.phase) ||
      !this.state.intent
    )
      return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.readerLink.clear();
    this.update({ ...state, phase: 'submitting', error: null });
    try {
      const result = await this.options.native.writePublicationPoint(
        state.intent!.request,
        request.signal,
        state.intent!.csrfToken,
      );
      if (!this.current(request)) return;
      if (!result.ok) {
        this.update({
          ...state,
          phase: result.error.kind === 'uncertain' ? 'uncertain' : result.error.kind === 'stale' ? 'stale' : 'rejected',
          error: result.error,
        });
        return;
      }
      state.publication?.dispose();
      this.update({ ...state, phase: 'acknowledged', receipt: result.value, publication: null, error: null });
      await this.readback();
    } finally {
      if (this.request === request) this.request = null;
    }
  };
  /** Receipt survives metadata/window/owner/anonymous failures. This never reissues the command. */
  readback = async () => {
    if (!this.current() || this.state.kind !== 'active' || !this.state.receipt || this.readRequest) return;
    const state = this.state;
    const receipt = state.receipt!;
    const request = new AbortController();
    this.readRequest = request;
    this.readerLink.clear();
    this.update({ ...state, readbackError: null });
    try {
      let publication = state.publication;
      if (!publication) {
        const metadata = await this.options.native.readMetadata(
          { catalogueId: receipt.catalogueId, kind: 'publication', revisionId: receipt.revisionId },
          request.signal,
        );
        if (!this.current(request)) return;
        if (!metadata.ok) {
          this.update({ ...(this.state as Active), readbackError: metadata.error });
          return;
        }
        publication = new HostedOutlineWindow(
          this.options.native,
          this.options.source,
          this.options.owner.viewer.accountId,
          metadata.value,
          this.isCurrent,
        );
        this.update({ ...(this.state as Active), publication });
      }
      await publication.load();
      if (!this.current(request)) return;
      const page = publication.snapshot();
      if (page.kind !== 'ready') return;
      const owner = await this.options.native.readOwn(
        this.options.owner.viewer.accountId,
        receipt.catalogueId,
        request.signal,
        this.options.owner.viewer,
      );
      if (!this.current(request)) return;
      if (!owner.ok) {
        this.update({ ...(this.state as Active), readbackError: owner.error });
        return;
      }
      await this.readerLink.confirmBounded(
        owner.value.item,
        {
          catalogueId: receipt.catalogueId,
          revisionId: receipt.revisionId,
          nonempty: page.page.items.length > 0,
        },
        request.signal,
      );
    } finally {
      if (this.readRequest === request) this.readRequest = null;
    }
  };
}
