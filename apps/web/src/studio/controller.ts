import { checkDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { bookPublicationTarget, bookTocRows } from './book-toc';
import {
  sameExact,
  type BookOrganizerPort,
  type BookStructure,
  type BookStructureChange,
  type DraftSave,
  type ExactDocument,
  type PublicationRecord,
  type PublicationReview,
  type PublicationTarget,
  type StudioDocument,
  type StudioFailure,
  type StudioInput,
  type StudioPage,
  type StudioPort,
  type StudioResult,
  type StudioRevision,
  type StudioSelection,
  type NativeDraftCreate,
} from './contract';

export type VersionSummary = Omit<StudioRevision, 'body' | 'mediaIds'>;
export type WorkingDocument = Readonly<{
  source: StudioSelection;
  title: string;
  body: DocumentSnapshot;
  dirty: boolean;
  snapshotPending: boolean;
  invalid: boolean;
  uploading: boolean;
  editorGeneration: number;
}>;
export type StudioState = Readonly<{
  documents: StudioPage<StudioDocument>;
  publications: StudioPage<PublicationRecord>;
  structure: BookStructure | null;
  selectedOccurrences: ReadonlySet<string>;
  selected: WorkingDocument | null;
  versions: StudioPage<VersionSummary> | null;
  historical: StudioRevision | null;
  review: PublicationReview | null;
  published: PublicationRecord | null;
  busy: string | null;
  issue: StudioFailure | null;
  message: string;
  failedDocumentCursor: string | null;
}>;
const unavailable: StudioFailure = { kind: 'unavailable', message: 'This read is unavailable. Try again.' };
const uncertain: StudioFailure = {
  kind: 'uncertain',
  message: 'The result is unknown. Retry the same operation to recover its result.',
};
const invalid: StudioFailure = {
  kind: 'invalid',
  message: 'The response did not match the selected document or exact version. Refresh before continuing.',
};

function sameTarget(a: PublicationTarget, b: PublicationTarget): boolean {
  if (a.kind === 'article') return b.kind === 'article' && sameExact(a.document, b.document);
  return (
    b.kind === 'book' &&
    a.catalogueId === b.catalogueId &&
    a.structureRevision === b.structureRevision &&
    a.chapters.length === b.chapters.length &&
    a.chapters.every((chapter, index) => {
      const other = b.chapters[index];
      return other?.occurrenceId === chapter.occurrenceId && sameExact(chapter.document, other.document);
    })
  );
}
function reviewMatches(review: PublicationReview, target: PublicationTarget, source: BookStructure | null): boolean {
  if (!sameTarget(review.target, target)) return false;
  if (target.kind === 'article' && review.authority === 'local')
    return (
      review.reviewId === '' &&
      review.bookOutline === null &&
      !!review.articleSnapshot?.boardId &&
      !!review.articleSnapshot.licence &&
      review.entries.length === 1 &&
      review.entries[0]?.occurrenceId === null &&
      sameExact(review.entries[0].document, target.document)
    );
  if (!review.reviewId || !Number.isFinite(Date.parse(review.expiresAt)) || review.authority === 'local') return false;
  if (target.kind === 'article')
    return (
      review.bookOutline === null &&
      review.entries.length === 1 &&
      review.entries[0]?.occurrenceId === null &&
      sameExact(review.entries[0].document, target.document)
    );
  const outline = review.bookOutline;
  if (!outline || outline.catalogueId !== target.catalogueId || outline.revision !== target.structureRevision)
    return false;
  let rows: ReturnType<typeof bookTocRows>;
  try {
    rows = bookTocRows({ ...outline, canOrganize: false });
  } catch {
    return false;
  }
  const chapters = rows.filter((row) => row.placement.target.kind === 'chapter');
  if (
    chapters.length !== target.chapters.length ||
    !chapters.every((row, index) => {
      const chapter = target.chapters[index];
      return (
        chapter?.occurrenceId === row.placement.occurrenceId &&
        row.placement.target.kind === 'chapter' &&
        sameExact(chapter.document, row.placement.target.document)
      );
    })
  )
    return false;
  if (!source || source.revision !== target.structureRevision || source.catalogueId !== target.catalogueId)
    return false;
  const sourceRows = bookTocRows(source);
  const selectedIds = new Set(target.chapters.map((chapter) => chapter.occurrenceId));
  const includedIds = new Set(selectedIds);
  sourceRows.forEach((row) => {
    if (selectedIds.has(row.placement.occurrenceId)) row.ancestors.forEach((id) => includedIds.add(id));
  });
  const expectedRows = sourceRows.filter((row) => includedIds.has(row.placement.occurrenceId));
  if (
    expectedRows.length !== rows.length ||
    !expectedRows.every((row, index) => {
      const actual = rows[index]?.placement;
      return (
        actual?.occurrenceId === row.placement.occurrenceId &&
        actual.parentOccurrenceId === row.placement.parentOccurrenceId &&
        actual.title === row.placement.title &&
        actual.target.kind === row.placement.target.kind
      );
    })
  )
    return false;
  // Ancestor parts are present only when they lead to at least one selected chapter.
  if (
    rows.some(
      (row) =>
        row.placement.target.kind === 'part' &&
        !chapters.some((chapter) => chapter.ancestors.includes(row.placement.occurrenceId)),
    )
  )
    return false;
  return (
    review.entries.length === target.chapters.length &&
    target.chapters.every((chapter, index) => {
      const entry = review.entries[index];
      return entry?.occurrenceId === chapter.occurrenceId && sameExact(entry.document, chapter.document);
    })
  );
}
async function validRevision(revision: StudioRevision, exact?: ExactDocument): Promise<boolean> {
  return Boolean(
    revision.exact.postId &&
    revision.exact.revisionId &&
    /^[a-f0-9]{64}$/.test(revision.exact.sha256) &&
    (!exact || sameExact(revision.exact, exact)) &&
    checkDocument(revision.body) &&
    (await editionDocumentDigest(revision.body)) === revision.exact.sha256,
  );
}
function working(source: StudioSelection, generation = 0): WorkingDocument {
  return {
    source,
    body: source.revision.body,
    title: source.revision.title,
    dirty: false,
    snapshotPending: false,
    invalid: false,
    uploading: false,
    editorGeneration: generation,
  };
}
function summary(selection: StudioSelection, state: StudioDocument['state'] = 'draft'): StudioDocument {
  return {
    postId: selection.revision.exact.postId,
    revisionId: selection.revision.exact.revisionId,
    title: selection.revision.title,
    updatedAt: selection.revision.savedAt,
    state: selection.visibility ?? state,
  };
}

/** One mounted private visit. Document bytes live only here and in the existing editor, never a second store. */
export class StudioController {
  private state: StudioState;
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private connected = false;
  private editorSequence = 0;
  private saveAttempt: DraftSave | null = null;
  private createAttempt: { projectId: string; title: string; idempotencyKey: string } | null = null;
  private nativeCreateAttempt: (NativeDraftCreate & { projectId: string; idempotencyKey: string }) | null = null;
  private organizeAttempt: Parameters<BookOrganizerPort['change']>[0] | null = null;
  private publishAttempt: Parameters<StudioPort['publish']>[0] | null = null;

  constructor(
    readonly input: StudioInput,
    readonly port: StudioPort,
    private readonly bookPort?: BookOrganizerPort,
  ) {
    this.state = {
      documents: input.documents,
      publications: input.publications,
      structure: input.profile.kind === 'book' ? input.profile.structure : null,
      selectedOccurrences: new Set(),
      selected: input.initialSelection ? working(input.initialSelection) : null,
      versions: null,
      historical: null,
      review: null,
      published: null,
      busy: null,
      issue: null,
      message: '',
      failedDocumentCursor: null,
    };
  }
  snapshot = (): StudioState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  connect = (): (() => void) => {
    this.connected = true;
    return () => {
      this.connected = false;
      this.request?.abort();
      this.request = null;
      this.patch({ busy: null, review: null, historical: null });
    };
  };
  current = (): boolean => this.connected && this.port.isCurrent();
  isEditorCurrent = (postId: string, generation: number): boolean =>
    this.current() &&
    this.state.selected?.source.revision.exact.postId === postId &&
    this.state.selected.editorGeneration === generation;
  private patch(patch: Partial<StudioState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private canMutate() {
    return this.current() && !this.state.busy && !this.hasUnresolvedCommand();
  }
  hasUnresolvedCommand = (): boolean =>
    Boolean(
      this.saveAttempt || this.createAttempt || this.nativeCreateAttempt || this.organizeAttempt || this.publishAttempt,
    );
  canOrganize = (): boolean => Boolean(this.bookPort && this.state.structure?.canOrganize);
  private async run<T>(
    name: string,
    action: (signal: AbortSignal) => Promise<StudioResult<T>>,
    apply: (value: T) => void,
    mutation = false,
  ): Promise<boolean> {
    if (!this.current() || this.state.busy) return false;
    const request = new AbortController();
    this.request = request;
    this.patch({ busy: name, issue: null, message: '' });
    try {
      const result = await action(request.signal);
      if (!this.current() || request.signal.aborted || this.request !== request) return false;
      if (!result.ok) {
        this.patch({ issue: result.error });
        return false;
      }
      apply(result.value);
      return true;
    } catch {
      if (this.current() && !request.signal.aborted && this.request === request)
        this.patch({ issue: mutation ? uncertain : unavailable });
      return false;
    } finally {
      if (this.request === request) {
        this.request = null;
        if (this.connected) this.patch({ busy: null });
      }
    }
  }
  private updateSummary(selection: StudioSelection): StudioPage<StudioDocument> {
    const prior = this.state.documents.items.find((row) => row.postId === selection.revision.exact.postId);
    const row = summary(selection, prior?.state ?? 'draft');
    return {
      ...this.state.documents,
      items: prior
        ? this.state.documents.items.map((entry) => (entry.postId === row.postId ? row : entry))
        : [row, ...this.state.documents.items].slice(0, this.input.nativeDrafts ? 20 : undefined),
    };
  }
  private edit(patch: Partial<WorkingDocument>) {
    if (!this.current() || !this.state.selected?.source.permissions.edit || this.publishAttempt) return;
    this.patch({ selected: { ...this.state.selected, ...patch }, review: null, published: null });
  }
  changeTitle = (title: string) => this.edit({ title, dirty: true });
  snapshotPending = () => this.edit({ snapshotPending: true, dirty: true });
  snapshotError = () => this.edit({ snapshotPending: false, invalid: true, dirty: true });
  changeBody = (body: DocumentSnapshot) => this.edit({ body, snapshotPending: false, invalid: false, dirty: true });
  uploadState = (uploading: boolean) => this.edit({ uploading });

  open = async (postId: string): Promise<boolean> => {
    if (
      !this.canMutate() ||
      this.state.selected?.dirty ||
      this.state.selected?.uploading ||
      this.state.selected?.snapshotPending
    )
      return false;
    // Never leave an old readable body beneath a new selection or a refused read.
    this.patch({ selected: null, historical: null, versions: null, review: null });
    return this.run<StudioSelection>(
      'Opening draft',
      async (signal) => {
        const result = await this.port.open({ projectId: this.input.projectId, postId }, signal);
        if (!result.ok) return result;
        if (result.value.revision.exact.postId !== postId || !(await validRevision(result.value.revision)))
          return { ok: false, error: invalid };
        return result;
      },
      (selection) =>
        this.patch({ selected: working(selection, ++this.editorSequence), documents: this.updateSummary(selection) }),
    );
  };
  discard = () => {
    if (!this.canMutate() || !this.state.selected || this.state.selected.uploading) return;
    const selected = this.state.selected;
    this.patch({
      selected: working(selected.source, ++this.editorSequence),
      issue: null,
      review: null,
      message: 'Local changes discarded. The last saved draft is open.',
    });
  };
  createDraft = async (title: string): Promise<boolean> => {
    if (
      !this.current() ||
      this.state.busy ||
      !this.input.canCreateDraft ||
      this.state.selected?.dirty ||
      this.state.selected?.uploading ||
      (this.hasUnresolvedCommand() && !this.createAttempt)
    )
      return false;
    if (!this.createAttempt) {
      if (!title.trim()) return false;
      this.createAttempt = {
        projectId: this.input.projectId,
        title: title.trim(),
        idempotencyKey: crypto.randomUUID(),
      };
    }
    const attempt = this.createAttempt;
    return this.run<StudioSelection>(
      'Creating draft',
      async (signal) => {
        const result = await this.port.createDraft(attempt, signal);
        if (!result.ok) {
          if (result.error.kind !== 'uncertain' && result.error.kind !== 'unavailable') this.createAttempt = null;
          return result;
        }
        if (!(await validRevision(result.value.revision))) return { ok: false, error: uncertain };
        return result;
      },
      (selection) => {
        this.createAttempt = null;
        this.patch({
          selected: working(selection, ++this.editorSequence),
          documents: this.updateSummary(selection),
          versions: null,
          historical: null,
          review: null,
          message: 'Private draft created.',
        });
      },
      true,
    );
  };
  save = async (): Promise<boolean> => {
    const selected = this.state.selected;
    if (
      !this.current() ||
      this.state.busy ||
      !selected?.source.permissions.edit ||
      (this.hasUnresolvedCommand() && !this.saveAttempt)
    )
      return false;
    if (!this.saveAttempt) {
      if (selected.snapshotPending || selected.invalid || selected.uploading || !selected.title.trim()) return false;
      if (!selected.dirty) return true;
      this.saveAttempt = {
        projectId: this.input.projectId,
        postId: selected.source.revision.exact.postId,
        expectedRevisionId: selected.source.revision.exact.revisionId,
        title: selected.title.trim(),
        body: selected.body,
        mediaIds: this.documentMediaIds(selected.body),
        idempotencyKey: crypto.randomUUID(),
        ...(selected.source.native
          ? {
              native: {
                boardId: selected.source.native.boardId,
                licence: selected.source.native.licence,
                subjectIds: [...selected.source.native.subjectIds],
                visibility: 'draft' as const,
              },
            }
          : {}),
      };
    }
    const attempt = this.saveAttempt;
    return this.run<StudioSelection>(
      'Saving draft',
      async (signal) => {
        const result = await this.port.saveDraft(attempt, signal);
        if (!result.ok) {
          if (result.error.kind !== 'uncertain' && result.error.kind !== 'unavailable') this.saveAttempt = null;
          return result;
        }
        const revision = result.value.revision;
        if (
          revision.exact.postId !== attempt.postId ||
          revision.title !== attempt.title ||
          !(await validRevision(revision)) ||
          serializeDocument(revision.body) !== serializeDocument(attempt.body)
        )
          return { ok: false, error: uncertain };
        return result;
      },
      (selection) => {
        this.saveAttempt = null;
        const live = this.state.selected!;
        const newer =
          live.snapshotPending ||
          live.invalid ||
          live.title.trim() !== attempt.title ||
          serializeDocument(live.body) !== serializeDocument(attempt.body);
        this.patch({
          selected: {
            ...live,
            source: selection,
            dirty: newer,
            ...(!newer ? { title: selection.revision.title, body: selection.revision.body } : {}),
          },
          documents: this.updateSummary(selection),
          versions: null,
          review: null,
          message: newer ? 'Draft saved. Newer edits are waiting to save.' : 'Draft saved privately.',
        });
      },
      true,
    );
  };
  private documentMediaIds(body: DocumentSnapshot): readonly string[] {
    const ids = new Set<string>();
    const visit = (node: DocumentSnapshot['doc']) => {
      if (node.type === 'image' && typeof node.attrs?.src === 'string') ids.add(node.attrs.src);
      node.content?.forEach(visit);
    };
    visit(body.doc);
    return [...ids];
  }
  loadDocuments = async () => {
    const cursor = this.state.documents.nextCursor;
    if (!cursor || this.hasUnresolvedCommand()) return;
    const loaded = await this.run(
      'Loading drafts',
      (signal) => this.port.documents({ projectId: this.input.projectId, cursor }, signal),
      (documents) => {
        this.patch({ documents, failedDocumentCursor: null });
      },
    );
    if (!loaded) this.patch({ failedDocumentCursor: cursor });
  };
  failedPageCursor = (): string | null => this.state.failedDocumentCursor;
  createNativeDraft = async (input: NativeDraftCreate): Promise<boolean> => {
    if (
      !this.current() ||
      this.state.busy ||
      !this.input.canCreateDraft ||
      !this.input.nativeDrafts ||
      !this.port.createNativeDraft ||
      this.state.selected?.dirty ||
      this.state.selected?.uploading ||
      (this.hasUnresolvedCommand() && !this.nativeCreateAttempt)
    )
      return false;
    if (!this.nativeCreateAttempt) {
      if (!input.boardId.trim() || !input.title.trim() || !input.licence.trim() || !checkDocument(input.body))
        return false;
      this.nativeCreateAttempt = {
        projectId: this.input.projectId,
        ...structuredClone(input),
        boardId: input.boardId.trim(),
        title: input.title.trim(),
        licence: input.licence.trim(),
        subjectIds: [...input.subjectIds],
        mediaIds: [...input.mediaIds],
        idempotencyKey: crypto.randomUUID(),
      };
    }
    const attempt = this.nativeCreateAttempt;
    return this.run<StudioSelection>(
      'Creating private draft',
      async (signal) => {
        const result = await this.port.createNativeDraft!(attempt, signal);
        if (!result.ok) {
          if (result.error.kind !== 'uncertain' && result.error.kind !== 'unavailable') this.nativeCreateAttempt = null;
          return result;
        }
        if (
          result.value.visibility !== 'draft' ||
          !result.value.native ||
          !result.value.permissions.edit ||
          !(await validRevision(result.value.revision)) ||
          serializeDocument(result.value.revision.body) !== serializeDocument(attempt.body)
        )
          return { ok: false, error: uncertain };
        return result;
      },
      (selection) => {
        this.nativeCreateAttempt = null;
        this.patch({
          selected: working(selection, ++this.editorSequence),
          documents: this.updateSummary(selection),
          versions: null,
          historical: null,
          review: null,
          message: m.studio_account_created({}, { locale: getLocale() }),
        });
      },
      true,
    );
  };
  loadVersions = async (more = false) => {
    const postId = this.state.selected?.source.revision.exact.postId;
    if (!postId || this.hasUnresolvedCommand()) return;
    const cursor = more ? this.state.versions?.nextCursor : null;
    if (more && !cursor) return;
    await this.run<StudioPage<VersionSummary>>(
      'Loading versions',
      async (signal) => {
        const result = await this.port.versions(
          { projectId: this.input.projectId, postId, cursor: cursor ?? null },
          signal,
        );
        if (result.ok && result.value.items.some((row) => row.exact.postId !== postId))
          return { ok: false, error: invalid };
        return result;
      },
      (versions) => this.patch({ versions, historical: null }),
    );
  };
  inspectVersion = async (document: ExactDocument) => {
    if (this.hasUnresolvedCommand() || document.postId !== this.state.selected?.source.revision.exact.postId) return;
    this.patch({ historical: null });
    await this.run<StudioRevision>(
      'Reading exact version',
      async (signal) => {
        const result = await this.port.revision({ projectId: this.input.projectId, document }, signal);
        if (result.ok && !(await validRevision(result.value, document))) return { ok: false, error: invalid };
        return result;
      },
      (historical) => this.patch({ historical }),
    );
  };
  restoreVersion = () => {
    if (
      !this.canMutate() ||
      !this.state.historical ||
      !this.state.selected ||
      this.state.selected.snapshotPending ||
      this.state.selected.uploading
    )
      return;
    const historical = this.state.historical;
    if (historical.exact.postId !== this.state.selected.source.revision.exact.postId) return;
    this.edit({
      title: historical.title,
      body: historical.body,
      dirty: true,
      invalid: false,
      snapshotPending: false,
      editorGeneration: ++this.editorSequence,
    });
    this.patch({ message: 'Version copied into the working draft. Save to create a new revision.' });
  };
  toggleOccurrence = (occurrenceId: string, checked: boolean) => {
    if (!this.canMutate() || !this.state.structure) return;
    const placement = this.state.structure.placements.find((row) => row.occurrenceId === occurrenceId);
    if (placement?.target.kind !== 'chapter') return;
    const next = new Set(this.state.selectedOccurrences);
    if (checked) next.add(occurrenceId);
    else next.delete(occurrenceId);
    this.patch({ selectedOccurrences: next, review: null, published: null });
  };
  organize = async (change: BookStructureChange): Promise<boolean> => {
    const structure = this.state.structure;
    const bookPort = this.bookPort;
    if (
      !structure ||
      !bookPort ||
      !structure.canOrganize ||
      !this.current() ||
      this.state.busy ||
      (this.hasUnresolvedCommand() && !this.organizeAttempt)
    )
      return false;
    if (!this.organizeAttempt)
      this.organizeAttempt = {
        catalogueId: structure.catalogueId,
        expectedRevision: structure.revision,
        change,
        idempotencyKey: crypto.randomUUID(),
      };
    const attempt = this.organizeAttempt;
    return this.run<BookStructure>(
      'Saving table of contents',
      async (signal) => {
        const result = await bookPort.change(attempt, signal);
        if (!result.ok) {
          if (result.error.kind !== 'uncertain' && result.error.kind !== 'unavailable') this.organizeAttempt = null;
          return result;
        }
        if (result.value.catalogueId !== attempt.catalogueId) return { ok: false, error: uncertain };
        bookTocRows(result.value);
        return result;
      },
      (next) => {
        this.organizeAttempt = null;
        const chapterIds = new Set(
          next.placements.filter((row) => row.target.kind === 'chapter').map((row) => row.occurrenceId),
        );
        this.patch({
          structure: next,
          review: null,
          published: null,
          selectedOccurrences: new Set([...this.state.selectedOccurrences].filter((id) => chapterIds.has(id))),
          message: 'Table of contents saved. Publication is unchanged.',
        });
      },
      true,
    );
  };
  publicationTarget = (): PublicationTarget | null => {
    if (this.state.structure) return bookPublicationTarget(this.state.structure, this.state.selectedOccurrences);
    const selected = this.state.selected;
    return selected && selected.source.permissions.publish
      ? { kind: 'article', document: selected.source.revision.exact }
      : null;
  };
  reviewPublication = async () => {
    const selected = this.state.selected;
    if (
      !this.canMutate() ||
      !this.input.canPublish ||
      selected?.dirty ||
      selected?.snapshotPending ||
      selected?.invalid ||
      selected?.uploading
    )
      return;
    const target = this.publicationTarget();
    if (!target) return;
    this.patch({ review: null, published: null });
    await this.run<PublicationReview>(
      'Reviewing publication',
      async (signal) => {
        const result = await this.port.reviewPublication({ projectId: this.input.projectId, target }, signal);
        if (
          result.ok &&
          (!reviewMatches(result.value, target, this.state.structure) ||
            (result.value.authority !== 'local' && Date.parse(result.value.expiresAt) <= Date.now()))
        )
          return { ok: false, error: invalid };
        return result;
      },
      (review) => {
        const current = this.publicationTarget();
        if (current && sameTarget(current, target) && !this.state.selected?.dirty) this.patch({ review });
      },
    );
  };
  cancelReview = () => {
    if (!this.canMutate()) return;
    this.patch({ review: null });
  };
  publish = async (): Promise<boolean> => {
    if (
      !this.current() ||
      this.state.busy ||
      !this.input.canPublish ||
      (this.hasUnresolvedCommand() && !this.publishAttempt)
    )
      return false;
    if (!this.publishAttempt) {
      const { review, selected } = this.state;
      const target = this.publicationTarget();
      if (
        !review ||
        !target ||
        !sameTarget(target, review.target) ||
        selected?.dirty ||
        selected?.snapshotPending ||
        selected?.uploading ||
        selected?.invalid ||
        (review.authority !== 'local' && Date.parse(review.expiresAt) <= Date.now())
      ) {
        this.patch({
          review: null,
          issue: { kind: 'stale', message: 'Review the current saved versions again before publishing.' },
        });
        return false;
      }
      this.publishAttempt = { projectId: this.input.projectId, review, idempotencyKey: crypto.randomUUID() };
    }
    const attempt = this.publishAttempt;
    return this.run<PublicationRecord>(
      'Publishing reviewed versions',
      async (signal) => {
        const result = await this.port.publish(attempt, signal);
        if (!result.ok) {
          if (result.error.kind !== 'uncertain' && result.error.kind !== 'unavailable') {
            this.publishAttempt = null;
            this.patch({ review: null });
          }
          return result;
        }
        const entries = result.value.entries;
        const localTarget =
          attempt.review.authority === 'local' && attempt.review.target.kind === 'article'
            ? attempt.review.target.document
            : null;
        const validLocalReadback = localTarget
          ? entries.length === 1 &&
            entries[0]?.occurrenceId === null &&
            entries[0]?.title === attempt.review.entries[0]?.title &&
            entries[0]?.document.postId === localTarget.postId &&
            !!result.value.readbackSelection &&
            result.value.readbackSelection.visibility === 'published' &&
            sameExact(entries[0].document, result.value.readbackSelection.revision.exact) &&
            (await validRevision(result.value.readbackSelection.revision))
          : entries.length === attempt.review.entries.length &&
            entries.every((entry, index) => {
              const reviewed = attempt.review.entries[index];
              return (
                reviewed?.occurrenceId === entry.occurrenceId &&
                reviewed.title === entry.title &&
                sameExact(entry.document, reviewed.document)
              );
            });
        if (result.value.state !== 'published' || !validLocalReadback) return { ok: false, error: uncertain };
        return result;
      },
      (published) => {
        this.publishAttempt = null;
        const ids = new Set(published.entries.map((entry) => entry.document.postId));
        this.patch({
          ...(published.readbackSelection && this.state.selected
            ? { selected: { ...this.state.selected, source: published.readbackSelection, dirty: false } }
            : {}),
          published,
          review: null,
          message:
            attempt.review.authority === 'local'
              ? m.studio_account_published({}, { locale: getLocale() })
              : 'The reviewed versions were published.',
          documents: {
            ...this.state.documents,
            items: this.state.documents.items.map((row) =>
              ids.has(row.postId) ? { ...row, state: 'published' } : row,
            ),
          },
          publications: {
            ...this.state.publications,
            items: [
              published,
              ...this.state.publications.items.filter(
                (row) => row.publicationId !== published.publicationId || row.revision !== published.revision,
              ),
            ],
          },
        });
      },
      true,
    );
  };
  loadPublications = async () => {
    const cursor = this.state.publications.nextCursor;
    if (!cursor || this.hasUnresolvedCommand()) return;
    await this.run(
      'Loading publication history',
      (signal) => this.port.publications({ projectId: this.input.projectId, cursor }, signal),
      (publications) => this.patch({ publications }),
    );
  };
  retry = async () => {
    if (this.saveAttempt) return this.save();
    if (this.createAttempt) return this.createDraft(this.createAttempt.title);
    if (this.nativeCreateAttempt) return this.createNativeDraft(this.nativeCreateAttempt);
    if (this.state.failedDocumentCursor) return this.loadDocuments();
    if (this.organizeAttempt) return this.organize(this.organizeAttempt.change);
    if (this.publishAttempt) return this.publish();
    return false;
  };
}
