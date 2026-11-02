import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { EditionMetadata, EditionSourceRecognition } from './edition-api';

export const editionContentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type EditionSourceIdentity = { postId: string; revisionId: string };
/** Consumer-local declaration of Content's DocumentImagePresentation until its original module lands. */
export type EditionPreviewImage = Readonly<{
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: readonly { format: 'avif' | 'webp'; width: number; height: number }[];
  placeholder: { thumbhash: string; color: string } | null;
  focalPoint: { x: number; y: number } | null;
  credit: MediaImportRequest['credit'] | null;
}>;
export type EditionPreviewMedia =
  | Readonly<{ kind: 'ready'; images: readonly EditionPreviewImage[] }>
  | Readonly<{ kind: 'unavailable' }>;

/** Only original declared IDs actually used by this exact document enter the single media batch. */
export function editionPreviewImageIds(body: DocumentSnapshot, declared: readonly string[]): string[] | null {
  if (
    declared.length > 32 ||
    new Set(declared).size !== declared.length ||
    declared.some((id) => !editionContentId.test(id))
  )
    return null;
  const referenced = new Set<string>();
  const visit = (node: DocumentNode) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') referenced.add(node.attrs.src);
    for (const child of node.content ?? []) visit(child);
  };
  visit(body.doc);
  return declared.filter((id) => referenced.has(id));
}

export type EditionCreateSource = EditionSourceIdentity & {
  creatorAccountId: string;
  body: DocumentSnapshot;
  sha256: string;
  licence: string;
  subjectIds: string[];
  media: EditionPreviewMedia;
  recognition?: EditionSourceRecognition | null;
};
export type EditionCreateFailure = {
  kind: 'refused' | 'missing' | 'unavailable' | 'conflict' | 'uncertain';
  status: number;
  reason?: 'native-pending' | 'admission-pending' | 'source' | 'dependency' | 'binding';
  editionId?: string;
  concealSource?: boolean;
  receipt?: { editionId: string; editionRevision: string };
};
export type EditionSourceRead = { kind: 'source'; source: EditionCreateSource } | EditionCreateFailure;
export type EditionCreateIntent = {
  kind: 'create';
  source: EditionSourceIdentity;
  targetSubjectId: string;
  key: string;
};
export type EditionPublishIntent = {
  kind: 'publish';
  source: EditionSourceIdentity | null;
  targetSubjectId: string;
  editionId: string;
  editionRevision: string;
  key: string;
};
export type EditionPublicationIntent = EditionCreateIntent | EditionPublishIntent;
export type EditionCommandRead = { kind: 'confirmed'; edition: EditionMetadata } | EditionCreateFailure;
export type EditionResumeRead = { kind: 'edition'; edition: EditionMetadata } | EditionCreateFailure;
export type EditionReviewRead =
  | { kind: 'review'; source: EditionCreateSource | null; edition: EditionMetadata | null }
  | EditionCreateFailure;
export interface EditionCreateApi {
  source(identity: EditionSourceIdentity, includeMedia?: boolean): Promise<EditionSourceRead>;
  resume(editionId: string): Promise<EditionResumeRead>;
  command(intent: EditionPublicationIntent): Promise<EditionCommandRead>;
  review(identity: EditionSourceIdentity | null, editionId: string | null): Promise<EditionReviewRead>;
}
export type EditionPublicationState = {
  source: EditionCreateSource | null;
  identity: EditionSourceIdentity | null;
  targetSubjectId: string;
  edition: EditionMetadata | null;
  knownEditionId: string | null;
  resumeEditionId: string | null;
  intent: EditionPublicationIntent | null;
  failure: EditionCreateFailure | null;
  review: Extract<EditionReviewRead, { kind: 'review' }> | null;
  busy: boolean;
  uncertain: boolean;
};

const emptyPublicationState = (): EditionPublicationState => ({
  source: null,
  identity: null,
  targetSubjectId: '',
  edition: null,
  knownEditionId: null,
  resumeEditionId: null,
  intent: null,
  failure: null,
  review: null,
  busy: false,
  uncertain: false,
});

/** Only an existing exact-revision link selects a source; IDs never become document bytes. */
export function editionSourceFromLink(value: string, origin = 'https://site.invalid'): EditionSourceIdentity | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    const match = /^\/(?:en\/|zh-Hant\/|zh-Hans\/|ja\/|ko\/|de\/|fr\/|es\/)?posts\/([^/]+)\/revisions\/([^/]+)$/.exec(
      url.pathname,
    );
    if (!match || !editionContentId.test(match[1]!) || !editionContentId.test(match[2]!)) return null;
    return { postId: match[1]!, revisionId: match[2]! };
  } catch {
    return null;
  }
}

export function editionCreateSearch(search: Record<string, unknown>) {
  // An edition parameter always selects resume, including an invalid/missing identifier.
  const editionId =
    search.editionId === undefined ? undefined : typeof search.editionId === 'string' ? search.editionId : '';
  return {
    editionId,
    postId:
      editionId === undefined && typeof search.postId === 'string' && editionContentId.test(search.postId)
        ? search.postId
        : undefined,
    revisionId:
      editionId === undefined && typeof search.revisionId === 'string' && editionContentId.test(search.revisionId)
        ? search.revisionId
        : undefined,
  };
}

/** Route departure follows only the source or edition identity; unrelated search metadata is browsing state. */
export function editionCreateNavigationContext(location: { pathname: string; search: Record<string, unknown> }) {
  if (!location.pathname.endsWith('/editions/new')) return location.pathname;
  const { editionId, postId, revisionId } = editionCreateSearch(location.search);
  const identity =
    editionId !== undefined ? `edition:${editionId}` : `source:${postId ?? ''}:${revisionId ?? ''}`;
  return `${location.pathname}\u0000${identity}`;
}

export function editionCreateHref(source: EditionSourceIdentity, locale: string): string {
  return `/${encodeURIComponent(locale)}/editions/new?${new URLSearchParams(source)}`;
}

export function editionMatchesSource(
  edition: EditionMetadata,
  source: EditionCreateSource,
  targetSubjectId: string,
): boolean {
  return (
    edition.revisionId === source.revisionId &&
    edition.creatorAccountId === source.creatorAccountId &&
    edition.sha256 === source.sha256 &&
    edition.licence === source.licence &&
    edition.targetSubjectId === targetSubjectId &&
    source.subjectIds.includes(targetSubjectId)
  );
}

export function editionBindingMatches(a: EditionMetadata, b: EditionMetadata): boolean {
  return (
    a.editionId === b.editionId &&
    a.revisionId === b.revisionId &&
    a.creatorAccountId === b.creatorAccountId &&
    a.targetSubjectId === b.targetSubjectId &&
    a.sha256 === b.sha256 &&
    a.licence === b.licence
  );
}

/** One mounted draft. Neither a new token nor a lost response replaces its intent. */
export class EditionPublicationController {
  private state: EditionPublicationState = emptyPublicationState();
  private listeners = new Set<() => void>();
  private generation = 0;
  private retired = false;
  constructor(
    private api: EditionCreateApi,
    private newKey: () => string = () => crypto.randomUUID(),
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.retired) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.generation++;
    this.state = emptyPublicationState();
    this.listeners.clear();
  };
  private set(patch: Partial<EditionPublicationState>) {
    if (this.retired) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async resume(editionId: string, loaded?: EditionResumeRead) {
    if (this.retired || this.state.busy || this.state.intent || this.state.edition || this.state.resumeEditionId !== null)
      return;
    const generation = ++this.generation;
    this.set({
      resumeEditionId: editionId,
      knownEditionId: editionId,
      identity: null,
      source: null,
      targetSubjectId: '',
      failure: null,
      review: null,
      busy: true,
    });
    let result: EditionResumeRead;
    try {
      result = loaded ?? (await this.api.resume(editionId));
    } catch {
      result = { kind: 'unavailable', status: 503, reason: 'dependency' };
    }
    if (generation !== this.generation) return;
    if (result.kind === 'edition' && result.edition.editionId === editionId)
      this.set({ edition: result.edition, targetSubjectId: result.edition.targetSubjectId, busy: false });
    else
      this.set({
        failure: result.kind === 'edition' ? { kind: 'unavailable', status: 502, reason: 'binding' } : result,
        busy: false,
      });
  }
  async select(identity: EditionSourceIdentity) {
    if (this.retired || this.state.intent || this.state.edition || this.state.resumeEditionId !== null) return;
    const generation = ++this.generation;
    this.set({ identity, source: null, targetSubjectId: '', failure: null, review: null, busy: true });
    let result: EditionSourceRead;
    try {
      result = await this.api.source(identity);
    } catch {
      result = { kind: 'unavailable', status: 503, reason: 'dependency' };
    }
    if (generation !== this.generation) return;
    if (
      result.kind === 'source' &&
      result.source.postId === identity.postId &&
      result.source.revisionId === identity.revisionId
    )
      this.set({ source: result.source, busy: false });
    else
      this.set({
        failure: result.kind === 'source' ? { kind: 'unavailable', status: 502, reason: 'binding' } : result,
        busy: false,
      });
  }
  chooseSubject(targetSubjectId: string) {
    if (
      this.retired ||
      this.state.busy ||
      this.state.intent ||
      this.state.edition ||
      this.state.resumeEditionId !== null ||
      !this.state.source?.subjectIds.includes(targetSubjectId)
    )
      return;
    this.set({ targetSubjectId, failure: null });
  }
  async create() {
    const { source, targetSubjectId, edition, intent, busy, failure } = this.state;
    if (
      this.retired ||
      busy ||
      intent ||
      edition ||
      this.state.resumeEditionId !== null ||
      failure ||
      !source?.subjectIds.includes(targetSubjectId)
    )
      return;
    await this.send({
      kind: 'create',
      source: { postId: source.postId, revisionId: source.revisionId },
      targetSubjectId,
      key: this.newKey(),
    });
  }
  async publish() {
    const { source, targetSubjectId, edition, intent, busy, failure } = this.state;
    if (
      this.retired ||
      busy ||
      intent ||
      failure ||
      (!source && this.state.resumeEditionId === null) ||
      edition?.state !== 'draft'
    )
      return;
    await this.send({
      kind: 'publish',
      source: source ? { postId: source.postId, revisionId: source.revisionId } : null,
      targetSubjectId,
      editionId: edition.editionId,
      editionRevision: edition.editionRevision,
      key: this.newKey(),
    });
  }
  async retry() {
    if (
      !this.retired &&
      !this.state.busy &&
      (this.state.source || this.state.resumeEditionId !== null) &&
      this.state.intent &&
      this.state.uncertain &&
      this.state.failure?.kind === 'uncertain' &&
      !this.state.failure.concealSource
    )
      if (this.state.failure.receipt) await this.refresh();
      else await this.send(this.state.intent);
  }
  private async send(intent: EditionPublicationIntent) {
    if (this.retired) return;
    const generation = ++this.generation;
    this.set({ intent, failure: null, review: null, busy: true });
    let result: EditionCommandRead;
    try {
      result = await this.api.command(intent);
    } catch {
      result = { kind: 'uncertain', status: 503, reason: 'dependency' };
    }
    if (generation !== this.generation) return;
    if (result.kind === 'confirmed') {
      const { source, edition } = this.state;
      if (
        (source
          ? !editionMatchesSource(result.edition, source, intent.targetSubjectId)
          : this.state.resumeEditionId === null || !edition || !editionBindingMatches(result.edition, edition)) ||
        (intent.kind === 'publish' &&
          (result.edition.editionId !== intent.editionId || result.edition.state !== 'published'))
      ) {
        this.set({ failure: { kind: 'uncertain', status: 502, reason: 'binding' }, uncertain: true, busy: false });
        return;
      }
      this.set({
        edition: result.edition,
        knownEditionId: result.edition.editionId,
        intent: null,
        uncertain: false,
        busy: false,
      });
    } else
      this.set({
        failure: result,
        uncertain:
          result.kind === 'uncertain' ||
          (this.state.uncertain && !(intent.kind === 'publish' && result.kind === 'conflict')),
        busy: false,
        ...(result.editionId ? { knownEditionId: result.editionId } : {}),
        ...(result.kind === 'refused' ||
        result.kind === 'unavailable' ||
        result.kind === 'missing' ||
        result.concealSource
          ? { source: null }
          : {}),
      });
  }
  /** A fresh refusal conceals old bytes immediately, even while an earlier command completes. */
  async refresh() {
    if (this.retired || (!this.state.identity && this.state.resumeEditionId === null)) return;
    const generation = ++this.generation;
    this.set({
      source: null,
      review: null,
      busy: true,
      uncertain: this.state.uncertain || !!(this.state.busy && this.state.intent),
    });
    let result: EditionReviewRead;
    try {
      result = await this.api.review(this.state.identity, this.state.edition?.editionId ?? this.state.knownEditionId);
    } catch {
      result = { kind: 'unavailable', status: 503, reason: 'dependency' };
    }
    if (generation !== this.generation) return;
    if (result.kind !== 'review') {
      this.set({
        failure: { ...result, ...(this.state.failure?.receipt ? { receipt: this.state.failure.receipt } : {}) },
        busy: false,
      });
      return;
    }
    if (this.state.edition && (!result.edition || !editionBindingMatches(this.state.edition, result.edition))) {
      this.set({
        failure: {
          kind: 'unavailable',
          status: 502,
          reason: 'binding',
          ...(this.state.failure?.receipt ? { receipt: this.state.failure.receipt } : {}),
        },
        busy: false,
      });
      return;
    }
    // A parsed command receipt records success. Recover its read without sending another mutation.
    const receipt = this.state.failure?.receipt;
    if (
      receipt &&
      result.edition &&
      result.edition.editionId === receipt.editionId &&
      result.edition.editionRevision === receipt.editionRevision &&
      result.edition.targetSubjectId === this.state.targetSubjectId &&
      (this.state.intent?.kind !== 'publish' || result.edition.state === 'published') &&
      (result.source
        ? editionMatchesSource(result.edition, result.source, this.state.targetSubjectId)
        : this.state.edition && editionBindingMatches(result.edition, this.state.edition))
    ) {
      this.set({
        edition: result.edition,
        source: result.source,
        knownEditionId: receipt.editionId,
        intent: null,
        review: null,
        failure: null,
        uncertain: false,
        busy: false,
      });
      return;
    }
    // Uncertain commands must settle with their original key, even after an explicit current read.
    const uncertain = this.state.intent && this.state.uncertain;
    this.set({
      source: result.source,
      ...(!this.state.edition && this.state.resumeEditionId && result.edition
        ? { targetSubjectId: result.edition.targetSubjectId }
        : {}),
      review: result,
      busy: false,
      failure: uncertain
        ? { kind: 'uncertain', status: 503, ...(receipt ? { receipt } : {}) }
        : { kind: 'conflict', status: 412 },
    });
  }
  acceptReview() {
    const { review, busy, intent, targetSubjectId } = this.state;
    if (this.retired || busy || !review || (intent && this.state.uncertain)) return;
    if (
      review.edition &&
      (review.source
        ? !editionMatchesSource(review.edition, review.source, targetSubjectId)
        : this.state.resumeEditionId === null || review.edition.targetSubjectId !== targetSubjectId)
    )
      return;
    this.set({
      source: review.source,
      edition: review.edition,
      knownEditionId: review.edition?.editionId ?? null,
      intent: null,
      uncertain: false,
      failure: null,
      review: null,
      targetSubjectId: review.source
        ? review.source.subjectIds.includes(targetSubjectId)
          ? targetSubjectId
          : ''
        : targetSubjectId,
    });
  }
}
