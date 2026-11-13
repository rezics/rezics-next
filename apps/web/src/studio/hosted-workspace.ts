import type {
  StudioInput,
  StudioPort,
  StudioResult,
  PublicationRecord,
  PublicationReview,
  PublicationTarget,
} from './contract';
import type { StudioWorkspaceProps } from './workspace';
import type {
  HostedBook,
  HostedBookNative,
  HostedOwnedBook,
  HostedOwnerViewer,
  HostedTargetResolver,
} from './hosted-contract';
import { HostedBookAdapter } from './hosted-adapter';
import { hostedFailure } from './hosted-native';
import { bookTocIndex } from './book-toc';
import { hostedBookStructure } from './hosted-structure';
import { HostedReleaseReaderLinkProjection, type HostedReleaseReaderAdmission } from './hosted-release-reader-link';

/** These are the shared draft/document lifecycle operations, not a second authoring store. */
export type StudioDocumentPort = Pick<
  StudioPort,
  'isCurrent' | 'documents' | 'open' | 'createDraft' | 'saveDraft' | 'versions' | 'revision'
>;
export type HostedStudioInput = Omit<StudioInput, 'profile' | 'canPublish' | 'publicationUnavailableReason'>;
export type HostedStudioBinding = Readonly<{
  workspace: Pick<StudioWorkspaceProps, 'input' | 'port' | 'bookPort' | 'bookHistory' | 'hostedReleaseReader'>;
  book: HostedBookAdapter;
  viewer: HostedOwnerViewer;
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
  return {
    publicationId: id,
    revision: book.revision.revisionId,
    publishedAt: null,
    state: book.placements.length === 0 ? 'withdrawn' : 'published',
    entries,
  };
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
  const outline = bookTocIndex(structure);
  const { rows } = outline;
  const selected = new Set<string>();
  const included = new Set<string>();
  for (const chapter of target.chapters) {
    const row = outline.byId.get(chapter.occurrenceId);
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
    owner?: HostedOwnedBook;
    /** Defaults to the anonymous native catalogue metadata reader, never the owner-only reader. */
    admitPublicRelease?: HostedReleaseReaderAdmission;
  },
  signal: AbortSignal,
): Promise<StudioResult<HostedStudioBinding>> {
  const { input, documents } = options;
  const native = options.native ?? (await import('./hosted-actions')).hostedBookNative;
  const current = () => options.isCurrent() && documents.isCurrent();
  const ended = () => hostedFailure('denied', 'This Studio visit has ended.');
  const releaseReader = new HostedReleaseReaderLinkProjection(options.catalogueId, current, async (address, signal) =>
    options.admitPublicRelease
      ? options.admitPublicRelease(address, signal)
      : (await import('./hosted-release-reader-link-public')).admitPublicHostedRelease(address, signal),
  );
  if (!current() || signal.aborted) return ended();
  const owner = await native.readOwn(options.accountId, options.catalogueId, signal, options.owner?.viewer);
  if (!current() || signal.aborted) return ended();
  if (!owner.ok) return owner;
  const selected = owner.value.item;
  if (
    options.owner &&
    (options.owner.item.postRevisionId !== selected.postRevisionId ||
      options.owner.item.postVisibility !== selected.postVisibility ||
      options.owner.item.headRevisionId !== selected.headRevisionId ||
      options.owner.item.publicationId !== selected.publicationId)
  )
    return hostedFailure('stale', 'The book changed while it was opening. Reopen the book.');
  const viewer = owner.value.viewer;
  const book = new HostedBookAdapter(native, current, options.resolveTarget);
  const loaded = await book.load(options.catalogueId, signal, selected.headRevisionId);
  if (!loaded.ok) return loaded;
  if (!current() || signal.aborted) return ended();
  if (selected.headRevisionId !== loaded.value.revision)
    return hostedFailure('stale', 'The book changed while it was opening. Reload the workspace.');
  let publicationId = selected.publicationId;
  let currentPublication: PublicationRecord | null = null;
  if (publicationId) {
    const publication = await book.readPublication(options.catalogueId, signal, publicationId);
    if (!current() || signal.aborted) return ended();
    if (!publication.ok) return publication;
    currentPublication = publicationRecord(publicationId, publication.value);
  }
  const confirmed = await native.readOwn(options.accountId, options.catalogueId, signal, viewer);
  if (!current() || signal.aborted) return ended();
  if (!confirmed.ok) return confirmed;
  if (
    confirmed.value.item.headRevisionId !== selected.headRevisionId ||
    confirmed.value.item.publicationId !== selected.publicationId ||
    confirmed.value.item.postRevisionId !== selected.postRevisionId ||
    confirmed.value.item.postVisibility !== selected.postVisibility
  )
    return hostedFailure('stale', 'The book changed while it was opening. Reopen the book.');

  await releaseReader.confirm(confirmed.value.item, currentPublication, signal);
  if (!current() || signal.aborted) return ended();

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
  let pendingPublication: { key: string; reviewId: string } | null = null;
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
      releaseReader.clear();
      const freshOwner = await native.readOwn(options.accountId, options.catalogueId, requestSignal, viewer);
      if (!current() || requestSignal.aborted) return ended();
      if (!freshOwner.ok) return freshOwner;
      if (freshOwner.value.item.headRevisionId !== structure.revision)
        return hostedFailure('stale', 'The book changed. Reload the structure before reviewing publication.');
      publicationId = freshOwner.value.item.publicationId;
      await releaseReader.confirm(freshOwner.value.item, currentPublication, requestSignal);
      if (!current() || requestSignal.aborted) return ended();
      const review = reviewFor(structure, request.target, publicationId);
      return review
        ? { ok: true, value: review }
        : hostedFailure('invalid', 'Select saved chapter versions from the current book structure.');
    },
    async reviewWithdrawal(request, requestSignal) {
      if (!current() || requestSignal.aborted || request.projectId !== input.projectId) return ended();
      const structure = book.currentStructure();
      if (!structure || request.catalogueId !== options.catalogueId || request.structureRevision !== structure.revision)
        return hostedFailure('stale', 'Reload the current book before reviewing withdrawal.');
      releaseReader.clear();
      const freshOwner = await native.readOwn(options.accountId, options.catalogueId, requestSignal, viewer);
      if (!current() || requestSignal.aborted) return ended();
      if (!freshOwner.ok) return freshOwner;
      const item = freshOwner.value.item;
      if (
        item.postVisibility !== 'published' ||
        item.headRevisionId !== structure.revision ||
        !item.publicationId ||
        item.publicationId !== request.expectedPublicationId
      )
        return hostedFailure('stale', 'The current published book changed. Reopen it before reviewing withdrawal.');
      const release = await book.readPublication(options.catalogueId, requestSignal, item.publicationId);
      if (!current() || requestSignal.aborted) return ended();
      if (!release.ok) return release;
      if (release.value.placements.length === 0)
        return hostedFailure('stale', 'This book is already withdrawn. Reopen it to read its current release.');
      publicationId = item.publicationId;
      await releaseReader.confirm(item, publicationRecord(publicationId, release.value), requestSignal);
      if (!current() || requestSignal.aborted) return ended();
      return {
        ok: true,
        value: {
          reviewId: crypto.randomUUID(),
          authority: 'hosted',
          target: {
            kind: 'book',
            catalogueId: options.catalogueId,
            structureRevision: structure.revision,
            chapters: [],
          },
          withdrawal: { publicationId, revision: release.value.revision.revisionId },
          expectedPublicationRevision: publicationId,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          bookOutline: { ...structure, placements: [] },
          entries: [],
          notices: [],
        },
      };
    },
    async publish(request, requestSignal) {
      const review = request.review;
      const recovering =
        pendingPublication?.key === request.idempotencyKey && pendingPublication.reviewId === review.reviewId;
      if (
        !current() ||
        requestSignal.aborted ||
        request.projectId !== input.projectId ||
        review.target.kind !== 'book' ||
        (!recovering && Date.parse(review.expiresAt) <= Date.now()) ||
        review.expectedPublicationRevision !== publicationId
      )
        return hostedFailure('stale', 'Review the current book and publication again before publishing.');
      if (
        review.withdrawal
          ? review.target.chapters.length !== 0 ||
            review.entries.length !== 0 ||
            review.withdrawal.publicationId !== publicationId ||
            review.withdrawal.revision !== publicationId
          : review.target.chapters.length === 0
      )
        return hostedFailure('invalid', 'Use the explicit withdrawal review to remove the current publication.');
      pendingPublication = { key: request.idempotencyKey, reviewId: review.reviewId };
      releaseReader.clear();
      const result = await book.publish(
        {
          target: review.target,
          expectedPublicationId: publicationId,
          withdrawal: Boolean(review.withdrawal),
          idempotencyKey: request.idempotencyKey,
        },
        requestSignal,
      );
      if (!result.ok) {
        if (result.error.kind !== 'uncertain' && result.error.kind !== 'unavailable') pendingPublication = null;
        return result;
      }
      const freshOwner = await native.readOwn(options.accountId, options.catalogueId, requestSignal, viewer);
      if (!current() || requestSignal.aborted) return ended();
      if (!freshOwner.ok)
        return hostedFailure(
          'uncertain',
          'The release was accepted but its current publication could not be refreshed. Retry to recover it.',
        );
      if (freshOwner.value.item.publicationId !== result.value.revision.revisionId)
        return hostedFailure(
          'uncertain',
          'The release was accepted but the owner read did not expose its publication. Retry to recover it.',
        );
      const nextPublicationId = result.value.revision.revisionId;
      if (review.withdrawal) {
        // The current native release selects discovery. An exact historical receipt alone cannot confirm removal.
        const visible = await book.readPublication(options.catalogueId, requestSignal);
        if (!current() || requestSignal.aborted) return ended();
        if (
          result.value.placements.length !== 0 ||
          !visible.ok ||
          visible.value.revision.revisionId !== nextPublicationId ||
          visible.value.revision.sourceRevisionId !== review.target.structureRevision ||
          visible.value.placements.length !== 0
        )
          return hostedFailure(
            'uncertain',
            'The withdrawal was accepted but the current empty release could not be confirmed. Retry to recover it.',
          );
      }
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
      await releaseReader.confirm(freshOwner.value.item, record, requestSignal);
      if (!current() || requestSignal.aborted) return ended();
      publicationId = nextPublicationId;
      currentPublication = record;
      pendingPublication = null;
      return { ok: true, value: record };
    },
    publications: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
  };
  return {
    ok: true,
    value: {
      book,
      viewer,
      workspace: {
        input: {
          ...input,
          profile: { kind: 'book', structure: loaded.value },
          canPublish: true,
          currentBookPublication: currentPublication,
          canWithdrawBook: selected.postVisibility === 'published',
          publications: currentPublication
            ? { items: [currentPublication], nextCursor: null }
            : { items: [], nextCursor: null },
        },
        port,
        bookPort: book,
        bookHistory: { native, accountId: options.accountId, catalogueId: options.catalogueId, isCurrent: current },
        hostedReleaseReader: releaseReader,
      },
    },
  };
}
