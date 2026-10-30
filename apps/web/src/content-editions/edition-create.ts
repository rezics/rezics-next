import type { DocumentSnapshot } from '@rezics/document';
import type { EditionMetadata } from './edition-api';

export const editionContentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type EditionSourceIdentity = { postId: string; revisionId: string };
export type EditionCreateSource = EditionSourceIdentity & {
  creatorAccountId: string;
  body: DocumentSnapshot;
  sha256: string;
  licence: string;
  subjectIds: string[];
};
export type EditionCreateFailure = {
  kind: 'refused' | 'unavailable' | 'conflict' | 'uncertain';
  status: number;
  reason?: 'native-pending' | 'admission-pending' | 'source' | 'dependency' | 'binding';
  editionId?: string;
  concealSource?: boolean;
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
  source: EditionSourceIdentity;
  targetSubjectId: string;
  editionId: string;
  editionRevision: string;
  key: string;
};
export type EditionPublicationIntent = EditionCreateIntent | EditionPublishIntent;
export type EditionCommandRead = { kind: 'confirmed'; edition: EditionMetadata } | EditionCreateFailure;
export type EditionReviewRead =
  | { kind: 'review'; source: EditionCreateSource; edition: EditionMetadata | null }
  | EditionCreateFailure;
export interface EditionCreateApi {
  source(identity: EditionSourceIdentity): Promise<EditionSourceRead>;
  command(intent: EditionPublicationIntent): Promise<EditionCommandRead>;
  review(identity: EditionSourceIdentity, editionId: string | null): Promise<EditionReviewRead>;
}
export type EditionPublicationState = {
  source: EditionCreateSource | null;
  identity: EditionSourceIdentity | null;
  targetSubjectId: string;
  edition: EditionMetadata | null;
  knownEditionId: string | null;
  intent: EditionPublicationIntent | null;
  failure: EditionCreateFailure | null;
  review: Extract<EditionReviewRead, { kind: 'review' }> | null;
  busy: boolean;
  uncertain: boolean;
};

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

/** One mounted draft. Neither a new token nor a lost response replaces its intent. */
export class EditionPublicationController {
  private state: EditionPublicationState = {
    source: null,
    identity: null,
    targetSubjectId: '',
    edition: null,
    knownEditionId: null,
    intent: null,
    failure: null,
    review: null,
    busy: false,
    uncertain: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  constructor(
    private api: EditionCreateApi,
    private newKey: () => string = () => crypto.randomUUID(),
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<EditionPublicationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async select(identity: EditionSourceIdentity) {
    if (this.state.busy || this.state.intent || this.state.edition) return;
    const generation = ++this.generation;
    this.set({ identity, source: null, targetSubjectId: '', failure: null, review: null, busy: true });
    let result: EditionSourceRead;
    try {
      result = await this.api.source(identity);
    } catch {
      result = { kind: 'unavailable', status: 503, reason: 'dependency' };
    }
    if (generation !== this.generation) return;
    if (result.kind === 'source') this.set({ source: result.source, busy: false });
    else this.set({ failure: result, busy: false });
  }
  chooseSubject(targetSubjectId: string) {
    if (
      this.state.busy ||
      this.state.intent ||
      this.state.edition ||
      !this.state.source?.subjectIds.includes(targetSubjectId)
    )
      return;
    this.set({ targetSubjectId, failure: null });
  }
  async create() {
    const { source, targetSubjectId, edition, intent, busy, failure } = this.state;
    if (busy || intent || edition || failure || !source?.subjectIds.includes(targetSubjectId)) return;
    await this.send({
      kind: 'create',
      source: { postId: source.postId, revisionId: source.revisionId },
      targetSubjectId,
      key: this.newKey(),
    });
  }
  async publish() {
    const { source, targetSubjectId, edition, intent, busy, failure } = this.state;
    if (busy || intent || failure || !source || edition?.state !== 'draft') return;
    await this.send({
      kind: 'publish',
      source: { postId: source.postId, revisionId: source.revisionId },
      targetSubjectId,
      editionId: edition.editionId,
      editionRevision: edition.editionRevision,
      key: this.newKey(),
    });
  }
  async retry() {
    if (!this.state.busy && this.state.source && this.state.intent && this.state.uncertain)
      await this.send(this.state.intent);
  }
  private async send(intent: EditionPublicationIntent) {
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
      const { source } = this.state;
      if (
        !source ||
        !editionMatchesSource(result.edition, source, intent.targetSubjectId) ||
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
        uncertain: this.state.uncertain || result.kind === 'uncertain',
        busy: false,
        ...(result.editionId ? { knownEditionId: result.editionId } : {}),
        ...(result.kind === 'refused' || result.kind === 'unavailable' || result.concealSource ? { source: null } : {}),
      });
  }
  /** A fresh refusal conceals old bytes immediately, even while an earlier command completes. */
  async refresh() {
    if (!this.state.identity) return;
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
      this.set({ failure: result, busy: false });
      return;
    }
    // Uncertain commands must settle with their original key, even after an explicit current read.
    const uncertain = this.state.intent && this.state.uncertain;
    this.set({
      source: result.source,
      review: result,
      busy: false,
      failure: uncertain ? { kind: 'uncertain', status: 503 } : { kind: 'conflict', status: 412 },
    });
  }
  acceptReview() {
    const { review, busy, intent, targetSubjectId } = this.state;
    if (
      busy ||
      !review ||
      (intent && this.state.uncertain && (!review.edition || review.edition.editionId !== this.state.knownEditionId))
    )
      return;
    if (review.edition && !editionMatchesSource(review.edition, review.source, targetSubjectId)) return;
    this.set({
      source: review.source,
      edition: review.edition,
      knownEditionId: review.edition?.editionId ?? null,
      intent: null,
      uncertain: false,
      failure: null,
      review: null,
      targetSubjectId: review.source.subjectIds.includes(targetSubjectId) ? targetSubjectId : '',
    });
  }
}
