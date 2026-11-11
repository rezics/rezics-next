import type {
  StudioInput,
  StudioPort,
  StudioResult,
  PublicationRecord,
  PublicationReview,
  PublicationTarget,
} from './contract';
import type { StudioWorkspaceProps } from './workspace';
import type { HostedBook, HostedBookNative, HostedTargetResolver } from './hosted-contract';
import { HostedBookAdapter } from './hosted-adapter';
import { hostedBookNative } from './hosted-actions';
import { hostedFailure } from './hosted-native';
import { bookTocRows } from './book-toc';
import { hostedBookStructure } from './hosted-structure';

/** These are the shared draft/document lifecycle operations, not a second authoring store. */
export type StudioDocumentPort = Pick<
  StudioPort,
  'isCurrent' | 'documents' | 'open' | 'createDraft' | 'saveDraft' | 'versions' | 'revision'
>;
export type HostedStudioInput = Omit<StudioInput, 'profile' | 'canPublish' | 'publicationUnavailableReason'>;
export type HostedStudioBinding = Readonly<{
  workspace: Pick<StudioWorkspaceProps, 'input' | 'port' | 'bookPort'>;
  book: HostedBookAdapter;
}>;

function publicationRecord(id: string, book: HostedBook): PublicationRecord {
  const entries = book.placements.flatMap((placement) =>
    placement.kind === 'chapter'
      ? [
          {
            occurrenceId: placement.occurrenceId,
            title: placement.title,
            document: {
              postId: placement.target.postId,
              revisionId: placement.target.revisionId,
              sha256: placement.target.sha256,
            },
          },
        ]
      : [],
  );
  return { publicationId: id, revision: book.revision.revisionId, publishedAt: null, state: 'published', entries };
}

function reviewFor(
  structure: ReturnType<typeof hostedBookStructure>,
  target: PublicationTarget,
  publicationId: string | null,
): PublicationReview | null {
  if (
    target.kind !== 'book' ||
    target.catalogueId !== structure.catalogueId ||
    target.structureRevision !== structure.revision ||
    target.chapters.length === 0
  )
    return null;
  const rows = bookTocRows(structure);
  const selected = new Set<string>();
  const included = new Set<string>();
  for (const chapter of target.chapters) {
    const row = rows.find((entry) => entry.placement.occurrenceId === chapter.occurrenceId);
    if (
      !row ||
      row.placement.target.kind !== 'chapter' ||
      selected.has(chapter.occurrenceId) ||
      row.placement.target.document.postId !== chapter.document.postId ||
      row.placement.target.document.revisionId !== chapter.document.revisionId ||
      row.placement.target.document.sha256 !== chapter.document.sha256
    )
      return null;
    selected.add(chapter.occurrenceId);
    included.add(chapter.occurrenceId);
    row.ancestors.forEach((id) => included.add(id));
  }
  const placements = rows.filter((row) => included.has(row.placement.occurrenceId)).map((row) => row.placement);
  const entries = rows.flatMap((row) =>
    selected.has(row.placement.occurrenceId) && row.placement.target.kind === 'chapter'
      ? [
          {
            occurrenceId: row.placement.occurrenceId,
            title: row.placement.title,
            document: row.placement.target.document,
          },
        ]
      : [],
  );
  return {
    reviewId: crypto.randomUUID(),
    target: structuredClone(target),
    expectedPublicationRevision: publicationId,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    bookOutline: {
      catalogueId: structure.catalogueId,
      revision: structure.revision,
      placements,
      limits: structure.limits,
    },
    entries,
    notices: [],
  };
}

/** Bind only after the current book and its owner metadata have both been admitted. */
export async function openHostedStudio(
  options: {
    catalogueId: string;
    accountId: string;
    input: HostedStudioInput;
    documents: StudioDocumentPort;
    resolveTarget: HostedTargetResolver;
    isCurrent: () => boolean;
    native?: HostedBookNative;
  },
  signal: AbortSignal,
): Promise<StudioResult<HostedStudioBinding>> {
  const { input, documents } = options;
  const native = options.native ?? hostedBookNative;
  const current = () => options.isCurrent() && documents.isCurrent();
  const book = new HostedBookAdapter(native, current, options.resolveTarget);
  const loaded = await book.load(options.catalogueId, signal);
  if (!loaded.ok) return loaded;
  if (!current() || signal.aborted) return hostedFailure('denied', 'This Studio visit has ended.');

  const owner = await native.readOwn(options.accountId, options.catalogueId, signal);
  if (!owner.ok) return owner;
  if (owner.value.catalogueId !== options.catalogueId || owner.value.headRevisionId !== loaded.value.revision)
    return hostedFailure('stale', 'The book changed while it was opening. Reload the workspace.');
  let publicationId = owner.value.publicationId;
  let currentPublication: PublicationRecord | null = null;
  if (publicationId) {
    const publication = await book.readPublication(options.catalogueId, signal);
    if (!publication.ok) return publication;
    currentPublication = publicationRecord(publicationId, publication.value);
  }

  async function documentOperation<T>(
    projectId: string,
    requestSignal: AbortSignal,
    run: () => Promise<StudioResult<T>>,
  ): Promise<StudioResult<T>> {
    if (!current() || requestSignal.aborted || projectId !== input.projectId)
      return hostedFailure('denied', 'This document operation belongs to a different Studio visit.');
    const result = await run();
    return current() && !requestSignal.aborted ? result : hostedFailure('denied', 'This Studio visit has ended.');
  }
  const unsupported = async () =>
    hostedFailure('unavailable', 'Article publication is not available in this workspace.');
  const port: StudioPort = {
    isCurrent: current,
    documents: (request, requestSignal) =>
      documentOperation(request.projectId, requestSignal, () => documents.documents(request, requestSignal)),
    open: (request, requestSignal) =>
      documentOperation(request.projectId, requestSignal, () => documents.open(request, requestSignal)),
    createDraft: (request, requestSignal) =>
      documentOperation(request.projectId, requestSignal, () => documents.createDraft(request, requestSignal)),
    saveDraft: (request, requestSignal) =>
      documentOperation(request.projectId, requestSignal, () => documents.saveDraft(request, requestSignal)),
    versions: (request, requestSignal) =>
      documentOperation(request.projectId, requestSignal, () => documents.versions(request, requestSignal)),
    revision: (request, requestSignal) =>
      documentOperation(request.projectId, requestSignal, () => documents.revision(request, requestSignal)),
    async reviewPublication(request, requestSignal) {
      if (!current() || requestSignal.aborted || request.projectId !== input.projectId)
        return hostedFailure('denied', 'This Studio visit has ended.');
      const structure = book.currentStructure();
      if (!structure) return hostedFailure('stale', 'Reload the book structure before reviewing publication.');
      const freshOwner = await native.readOwn(options.accountId, options.catalogueId, requestSignal);
      if (!freshOwner.ok) return freshOwner;
      if (freshOwner.value.headRevisionId !== structure.revision)
        return hostedFailure('stale', 'The book changed. Reload the structure before reviewing publication.');
      publicationId = freshOwner.value.publicationId;
      const review = reviewFor(structure, request.target, publicationId);
      return review
        ? { ok: true, value: review }
        : hostedFailure('invalid', 'Select saved chapter versions from the current book structure.');
    },
    async publish(request, requestSignal) {
      const review = request.review;
      if (
        !current() ||
        requestSignal.aborted ||
        request.projectId !== input.projectId ||
        review.target.kind !== 'book' ||
        Date.parse(review.expiresAt) <= Date.now() ||
        review.expectedPublicationRevision !== publicationId
      )
        return hostedFailure('stale', 'Review the current book and publication again before publishing.');
      const result = await book.publish(
        { target: review.target, expectedPublicationId: publicationId, idempotencyKey: request.idempotencyKey },
        requestSignal,
      );
      if (!result.ok) return result;
      const freshOwner = await native.readOwn(options.accountId, options.catalogueId, requestSignal);
      if (!freshOwner.ok)
        return hostedFailure(
          'uncertain',
          'The release was accepted but its current publication could not be refreshed. Retry to recover it.',
        );
      if (!freshOwner.value.publicationId)
        return hostedFailure(
          'uncertain',
          'The release was accepted but the owner read did not expose its publication. Retry to recover it.',
        );
      const nextPublicationId = freshOwner.value.publicationId;
      const record = publicationRecord(nextPublicationId, result.value);
      if (
        record.entries.length !== review.entries.length ||
        !record.entries.every((entry, index) => {
          const reviewed = review.entries[index];
          return (
            reviewed?.occurrenceId === entry.occurrenceId &&
            reviewed.title === entry.title &&
            reviewed.document.postId === entry.document.postId &&
            reviewed.document.revisionId === entry.document.revisionId &&
            reviewed.document.sha256 === entry.document.sha256
          );
        })
      )
        return hostedFailure('uncertain', 'The published snapshot did not match the reviewed chapter selection.');
      publicationId = nextPublicationId;
      currentPublication = record;
      return { ok: true, value: record };
    },
    publications: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
  };
  return {
    ok: true,
    value: {
      book,
      workspace: {
        input: {
          ...input,
          profile: { kind: 'book', structure: loaded.value },
          canPublish: true,
          publications: currentPublication
            ? { items: [currentPublication], nextCursor: null }
            : { items: [], nextCursor: null },
        },
        port,
        bookPort: book,
      },
    },
  };
}
