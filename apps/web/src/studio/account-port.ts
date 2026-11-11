import { checkDocument, hasDocumentContent, serializeDocument } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import {
  readSelectedOwnDraft,
  type OwnDraftCommands,
  type OwnDraftEntry,
  type OwnDraftIdentity,
  type OwnDraftPageData,
  type OwnDraftReader,
} from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { createPostDocumentPort, type PostDocumentPort } from './post-document-port';
import {
  sameExact,
  type NativeDraftCreate,
  type PublicationRecord,
  type PublicationReview,
  type StudioDocument,
  type StudioFailure,
  type StudioInput,
  type StudioPort,
  type StudioResult,
  type StudioSelection,
} from './contract';

const unavailable: StudioFailure = {
  kind: 'unavailable',
  message: 'This Studio operation is unavailable. Retry the same operation.',
};
const uncertain: StudioFailure = {
  kind: 'uncertain',
  message: 'The result is unknown. Retry the same operation to recover its result.',
};

function failure(error: StudioFailure['kind'], message: string): StudioResult<never> {
  return { ok: false, error: { kind: error, message } };
}

function readFailure(value: string): StudioResult<never> {
  if (value === 'denied') return failure('denied', 'This account can no longer open this Studio visit.');
  if (value === 'stale') return failure('stale', 'This draft changed. Reload its current version before continuing.');
  if (value === 'concealed') return failure('withdrawn', 'This draft is no longer available to this account.');
  return { ok: false, error: unavailable };
}

function writeFailure(reason: string): StudioResult<never> {
  if (reason === 'forbidden') return failure('denied', 'The current account cannot write this draft.');
  if (reason === 'stale' || reason === 'conflict')
    return failure('stale', 'The saved revision changed. Reopen the draft before writing.');
  if (reason === 'invalid' || reason === 'media-unavailable')
    return failure('invalid', 'The native command refused these draft details.');
  if (reason === 'unavailable' || reason === 'rate-limited' || reason === 'closed')
    return { ok: false, error: uncertain };
  return failure('withdrawn', 'This draft is no longer available to this account.');
}

function summary(entry: OwnDraftEntry): StudioDocument {
  return {
    postId: entry.id,
    title: entry.title ?? 'Untitled draft',
    revisionId: entry.revisionId,
    updatedAt: entry.savedAt,
    state: 'draft',
    openable: entry.kind === 'discussion' && entry.documentKind === 'opening',
  };
}

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactSelection(selection: StudioSelection, entry: OwnDraftEntry, accountId: string): boolean {
  return (
    selection.revision.exact.postId === entry.id &&
    selection.revision.exact.revisionId === entry.revisionId &&
    selection.visibility === 'draft' &&
    selection.native?.threadId === entry.threadId &&
    selection.native.boardId === entry.board.id &&
    selection.native.licence === entry.licence &&
    sameList(selection.native.subjectIds, entry.subjectIds) &&
    selection.revision.mediaIds.length === entry.mediaIds.length &&
    selection.revision.mediaIds.every((id, index) => id === entry.mediaIds[index]) &&
    selection.revision.title === (entry.title ?? 'Untitled draft') &&
    selection.permissions.edit &&
    accountId === entry.authorId
  );
}

/** Compose Studio's existing document lifecycle over the mounted native account reader and writers. */
export function createStudioAccountPort(
  input: Readonly<{
    identity: OwnDraftIdentity;
    initialPage: OwnDraftPageData;
    reader: OwnDraftReader;
    commands?: OwnDraftCommands;
    source: HistoricalReaderSource;
    csrfToken: string | null;
    locale: string;
    isCurrent: () => boolean;
  }>,
): StudioPort {
  const { identity, reader, commands, source } = input;
  const accountId = identity.accountId;
  const projectId = accountId;
  let authnEpoch = identity.authnEpoch ?? input.initialPage.viewer.authnEpoch;
  const visibleEntries = new Map<string, OwnDraftEntry>(input.initialPage.drafts.map((entry) => [entry.id, entry]));
  const selectedEntries = new Map<string, OwnDraftEntry>();
  const selections = new Map<string, StudioSelection>();
  const isCurrent = () => input.isCurrent() && identity.accountId === accountId;
  const documents = createPostDocumentPort({
    projectId,
    accountId,
    locale: input.locale,
    source,
    csrfToken: input.csrfToken,
    isCurrent,
    admitsPost: (postId) => visibleEntries.has(postId) || selectedEntries.has(postId),
  });

  async function open(postId: string, signal: AbortSignal): Promise<StudioResult<StudioSelection>> {
    const entry = visibleEntries.get(postId) ?? selectedEntries.get(postId);
    if (!entry || entry.documentKind !== 'opening' || entry.kind !== 'discussion')
      return failure('withdrawn', 'Only an account-owned discussion draft can open in Studio.');
    const currentIdentity = { ...identity, authnEpoch };
    const resumed = await readSelectedOwnDraft(reader, currentIdentity, entry, signal, isCurrent);
    if (typeof resumed === 'string') return readFailure(resumed);
    if (!isCurrent() || resumed.revision !== entry.revisionId)
      return failure('stale', 'The selected draft changed. Reload the inventory.');
    const result = await documents.open({ projectId, postId }, signal);
    if (!result.ok) return result;
    const selection = result.value;
    if (
      !exactSelection(selection, entry, accountId) ||
      serializeDocument(selection.revision.body) !== serializeDocument(resumed.post.body) ||
      !sameList(selection.revision.mediaIds, resumed.post.mediaIds)
    )
      return failure('stale', 'The selected draft changed while it was opening. Select its current inventory row.');
    const admitted = { ...selection, permissions: { edit: true, publish: true } };
    selectedEntries.clear();
    selections.clear();
    selectedEntries.set(postId, entry);
    selections.set(postId, admitted);
    return { ok: true, value: admitted };
  }

  async function createNativeDraft(
    draft: NativeDraftCreate & { idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioSelection>> {
    if (!isCurrent() || !commands?.create)
      return failure('denied', 'Creating drafts requires the current account write session.');
    const result = await commands.create(draft, signal);
    if (!result.ok) return writeFailure(result.reason);
    if (!isCurrent()) return { ok: false, error: uncertain };
    const thread = result.thread;
    const post = thread.firstPost;
    if (
      thread.visibility !== 'draft' ||
      thread.authorId !== accountId ||
      thread.boardId !== draft.boardId ||
      thread.title !== draft.title ||
      thread.licence !== draft.licence ||
      !sameList(thread.subjectIds, draft.subjectIds) ||
      post.availability !== 'available' ||
      post.authorId !== accountId ||
      post.threadId !== thread.id ||
      post.visibility !== 'draft' ||
      !checkDocument(post.body) ||
      !hasDocumentContent(post.body) ||
      serializeDocument(post.body) !== serializeDocument(draft.body) ||
      !sameList(post.mediaIds, draft.mediaIds) ||
      !/^[a-f0-9]{64}$/.test(post.sha256) ||
      (await editionDocumentDigest(post.body)) !== post.sha256
    )
      return { ok: false, error: uncertain };
    const selection: StudioSelection = {
      revision: {
        exact: { postId: post.id, revisionId: post.revisionId, sha256: post.sha256 },
        title: thread.title,
        body: post.body,
        mediaIds: [...post.mediaIds],
        savedAt: post.revisedAt ?? post.createdAt,
      },
      visibility: 'draft',
      native: {
        threadId: thread.id,
        boardId: thread.boardId,
        licence: thread.licence,
        subjectIds: [...thread.subjectIds],
      },
      permissions: { edit: true, publish: true },
    };
    const entry = {
      id: post.id,
      threadId: thread.id,
      firstPostId: post.id,
      revisionId: post.revisionId,
      authorId: accountId,
      kind: 'discussion' as const,
      documentKind: 'opening' as const,
      title: thread.title,
      savedAt: selection.revision.savedAt,
      licence: thread.licence,
      subjectIds: [...thread.subjectIds],
      mediaIds: [...post.mediaIds],
      board: { id: thread.boardId, title: null, realmId: null },
      language: null,
      actions: {
        resume: `/v1/accounts/${accountId}/drafts/${post.id}?threadId=${thread.id}`,
        edit: null,
        publish: null,
        erase: null,
      },
    } satisfies OwnDraftEntry;
    visibleEntries.delete(post.id);
    visibleEntries.set(post.id, entry);
    while (visibleEntries.size > 20) visibleEntries.delete(visibleEntries.keys().next().value!);
    selectedEntries.clear();
    selections.clear();
    selectedEntries.set(post.id, entry);
    selections.set(post.id, selection);
    return { ok: true, value: selection };
  }

  async function saveDraft(
    save: Parameters<StudioPort['saveDraft']>[0],
    signal: AbortSignal,
  ): Promise<StudioResult<StudioSelection>> {
    const prior = selections.get(save.postId);
    if (!prior?.native || prior.revision.exact.revisionId !== save.expectedRevisionId)
      return failure('stale', 'Reopen the selected account draft before saving.');
    const result = await documents.saveDraft(
      {
        ...save,
        projectId,
        native: {
          boardId: prior.native.boardId,
          licence: prior.native.licence,
          subjectIds: [...prior.native.subjectIds],
          visibility: 'draft',
        },
      },
      signal,
    );
    if (!result.ok) return result;
    const selection = { ...result.value, permissions: { edit: true, publish: true } };
    const entry = selectedEntries.get(save.postId);
    if (entry) {
      const updated = {
        ...entry,
        revisionId: selection.revision.exact.revisionId,
        title: selection.revision.title,
        savedAt: selection.revision.savedAt,
        licence: selection.native?.licence ?? entry.licence,
        subjectIds: selection.native?.subjectIds ?? entry.subjectIds,
        mediaIds: selection.revision.mediaIds,
      };
      selectedEntries.set(save.postId, updated);
      visibleEntries.set(save.postId, updated);
    }
    selections.set(save.postId, selection);
    return { ok: true, value: selection };
  }

  async function reviewPublication(
    request: Parameters<StudioPort['reviewPublication']>[0],
    _signal: AbortSignal,
  ): Promise<StudioResult<PublicationReview>> {
    if (request.target.kind !== 'article')
      return failure('invalid', 'Account article review requires one selected Post.');
    const selection = selections.get(request.target.document.postId);
    if (!selection?.native || !sameExact(selection.revision.exact, request.target.document))
      return failure('stale', 'Reload the saved account draft before reviewing it.');
    const review: PublicationReview = {
      reviewId: '',
      authority: 'local',
      target: structuredClone(request.target),
      expectedPublicationRevision: null,
      expiresAt: '9999-12-31T23:59:59.999Z',
      bookOutline: null,
      entries: [{ occurrenceId: null, title: selection.revision.title, document: selection.revision.exact }],
      notices: [],
      articleSnapshot: {
        boardId: selection.native.boardId,
        licence: selection.native.licence,
        subjectIds: [...selection.native.subjectIds],
        mediaIds: [...selection.revision.mediaIds],
        body: structuredClone(selection.revision.body),
      },
    };
    return { ok: true, value: review };
  }

  async function publish(
    request: Parameters<StudioPort['publish']>[0],
    signal: AbortSignal,
  ): Promise<StudioResult<PublicationRecord>> {
    const { review } = request;
    if (
      review.authority !== 'local' ||
      review.target.kind !== 'article' ||
      !review.articleSnapshot ||
      !commands ||
      !commands.revise
    )
      return failure('invalid', 'This account publication intent is unavailable. Review the saved version again.');
    const target = review.target.document;
    const prior = selections.get(target.postId);
    const snapshot = review.articleSnapshot;
    if (!prior?.native || !sameExact(prior.revision.exact, target))
      return failure('stale', 'The acknowledged draft changed after review. Review its current revision again.');
    const result = await commands.revise(
      {
        postId: target.postId,
        revisionId: target.revisionId,
        body: snapshot.body,
        idempotencyKey: request.idempotencyKey,
        mediaIds: [...snapshot.mediaIds],
        boardId: snapshot.boardId,
        licence: snapshot.licence,
        subjectIds: [...snapshot.subjectIds],
        visibility: 'published',
      },
      signal,
    );
    if (!result.ok) return writeFailure(result.reason);
    if (!isCurrent()) return { ok: false, error: uncertain };
    const post = result.post;
    if (
      post.id !== target.postId ||
      post.threadId !== prior.native.threadId ||
      post.authorId !== accountId ||
      post.visibility !== 'published' ||
      post.availability !== 'available' ||
      !checkDocument(post.body) ||
      serializeDocument(post.body) !== serializeDocument(snapshot.body) ||
      !sameList(post.mediaIds, snapshot.mediaIds) ||
      post.boardId !== snapshot.boardId ||
      post.licence !== snapshot.licence ||
      !sameList(post.subjectIds, snapshot.subjectIds) ||
      (await editionDocumentDigest(post.body)) !== post.sha256
    )
      return { ok: false, error: uncertain };
    const readback = await commands.readback(post.id, signal);
    if (
      typeof readback === 'string' ||
      readback.state !== 'available' ||
      readback.visibility !== 'published' ||
      readback.revision !== post.revisionId ||
      !readback.body ||
      serializeDocument(readback.body) !== serializeDocument(snapshot.body) ||
      !sameList(readback.mediaIds, snapshot.mediaIds) ||
      !isCurrent()
    )
      return { ok: false, error: uncertain };
    const revision = {
      exact: { postId: post.id, revisionId: readback.revision, sha256: post.sha256 },
      title: review.entries[0]?.title ?? prior.revision.title,
      body: readback.body,
      mediaIds: [...readback.mediaIds],
      savedAt: post.revisedAt ?? post.createdAt,
    };
    const readbackSelection: StudioSelection = {
      revision,
      visibility: 'published',
      native: {
        threadId: post.threadId,
        boardId: post.boardId,
        licence: post.licence,
        subjectIds: [...post.subjectIds],
      },
      permissions: { edit: false, publish: false },
    };
    selections.set(post.id, readbackSelection);
    const publication: PublicationRecord = {
      publicationId: `post:${post.id}`,
      revision: readback.revision,
      publishedAt: null,
      state: 'published',
      entries: [{ occurrenceId: null, title: revision.title, document: revision.exact }],
      readbackSelection,
    };
    return { ok: true, value: publication };
  }

  return {
    isCurrent,
    async documents(request, signal) {
      if (!isCurrent() || request.projectId !== projectId)
        return failure('denied', 'Open Studio with its current account.');
      const page = await reader.list(
        {
          accountId,
          ...(authnEpoch === null ? {} : { authnEpoch }),
          cursor: request.cursor,
        },
        signal,
      );
      if (typeof page === 'string') return readFailure(page);
      if (!isCurrent() || page.drafts.length > 20) return { ok: false, error: unavailable };
      if (authnEpoch !== null && authnEpoch !== page.viewer.authnEpoch)
        return failure('denied', 'The account authorization changed. Reopen Studio.');
      authnEpoch = page.viewer.authnEpoch;
      visibleEntries.clear();
      for (const entry of page.drafts) visibleEntries.set(entry.id, entry);
      return {
        ok: true,
        value: { items: page.drafts.map(summary), nextCursor: page.next },
      };
    },
    open: (request, signal) =>
      request.projectId === projectId
        ? open(request.postId, signal)
        : Promise.resolve(failure('denied', 'Open Studio with its current account.')),
    createDraft: async () => failure('unavailable', 'Use the native account draft form to create this document.'),
    createNativeDraft,
    saveDraft,
    versions: (request, signal) => documents.versions(request, signal),
    revision: (request, signal) => documents.revision(request, signal),
    reviewPublication,
    publish,
    publications: async () => ({ ok: true, value: { items: [] as PublicationRecord[], nextCursor: null } }),
  };
}
