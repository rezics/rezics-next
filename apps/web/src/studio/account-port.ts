import { checkDocument, hasDocumentContent, serializeDocument } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { m } from '../paraglide/messages.js';
import { getLocale, isLocale, type Locale } from '../paraglide/runtime.js';
import {
  readSelectedOwnDraft,
  type OwnDraftCommands,
  type OwnDraftEntry,
  type OwnDraftIdentity,
  type OwnDraftPageData,
  type OwnDraftReader,
} from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { createPostDocumentPort, projectPostDocumentHead, type PostDocumentPort } from './post-document-port';
import { readPostDocumentHead, type PostDocumentHead } from './post-document-read';
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

function failure(error: StudioFailure['kind'], message: string): StudioResult<never> {
  return { ok: false, error: { kind: error, message } };
}

function accountOptions(locale: string): { locale: Locale } {
  return { locale: isLocale(locale) ? locale : getLocale() };
}

function unavailable(locale: string): StudioFailure {
  return { kind: 'unavailable', message: m.studio_operation_unavailable({}, accountOptions(locale)) };
}

function uncertain(locale: string): StudioFailure {
  return { kind: 'uncertain', message: m.studio_result_unknown({}, accountOptions(locale)) };
}

function readFailure(value: string, locale: string): StudioResult<never> {
  const options = accountOptions(locale);
  if (value === 'denied') return failure('denied', m.studio_account_visit_closed({}, options));
  if (value === 'stale') return failure('stale', m.studio_draft_changed({}, options));
  if (value === 'concealed') return failure('withdrawn', m.studio_draft_withdrawn({}, options));
  return { ok: false, error: unavailable(locale) };
}

function writeFailure(reason: string, locale: string): StudioResult<never> {
  const options = accountOptions(locale);
  if (reason === 'forbidden') return failure('denied', m.studio_draft_write_denied({}, options));
  if (reason === 'stale' || reason === 'conflict')
    return failure('stale', m.studio_draft_revision_changed({}, options));
  if (reason === 'invalid' || reason === 'media-unavailable')
    return failure('invalid', m.studio_draft_refused({}, options));
  if (reason === 'unavailable' || reason === 'rate-limited' || reason === 'closed')
    return { ok: false, error: uncertain(locale) };
  return failure('withdrawn', m.studio_draft_withdrawn({}, options));
}

function summary(entry: OwnDraftEntry, locale: string): StudioDocument {
  return {
    postId: entry.id,
    title: entry.title ?? m.own_drafts_no_title({}, accountOptions(locale)),
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

function openingEntry({ post, title }: Pick<PostDocumentHead, 'post' | 'title'>): OwnDraftEntry {
  return {
    id: post.id,
    threadId: post.threadId,
    firstPostId: post.id,
    revisionId: post.revisionId,
    authorId: post.authorId,
    kind: 'discussion',
    documentKind: 'opening',
    title,
    savedAt: post.revisedAt ?? post.createdAt,
    licence: post.licence,
    subjectIds: [...post.subjectIds],
    mediaIds: [...post.mediaIds],
    board: { id: post.boardId, title: null, realmId: null },
    language: null,
    actions: {
      resume: `/v1/accounts/${post.authorId}/drafts/${post.id}?threadId=${post.threadId}`,
      edit: null,
      publish: null,
      erase: null,
    },
  };
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
): StudioPort & { resume(postId: string, signal: AbortSignal): Promise<StudioResult<StudioSelection>> } {
  const { identity, reader, commands, source, locale } = input;
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

  async function openEntry(
    entry: OwnDraftEntry,
    signal: AbortSignal,
    load: () => Promise<StudioResult<StudioSelection>>,
  ): Promise<StudioResult<StudioSelection>> {
    const resumed = await readSelectedOwnDraft(reader, { ...identity, authnEpoch }, entry, signal, isCurrent);
    if (typeof resumed === 'string') return readFailure(resumed, locale);
    const result = await load();
    if (!result.ok) return result;
    const selection = result.value;
    if (
      signal.aborted ||
      !documents.isCurrent() ||
      resumed.post.parentId !== null ||
      !exactSelection(selection, entry, accountId) ||
      serializeDocument(selection.revision.body) !== serializeDocument(resumed.post.body) ||
      !sameList(selection.revision.mediaIds, resumed.post.mediaIds)
    )
      return failure('stale', m.studio_opening_stale({}, accountOptions(locale)));
    const admitted = { ...selection, permissions: { edit: true, publish: true } };
    selectedEntries.clear();
    selections.clear();
    selectedEntries.set(entry.id, entry);
    selections.set(entry.id, admitted);
    return { ok: true, value: admitted };
  }

  async function open(postId: string, signal: AbortSignal): Promise<StudioResult<StudioSelection>> {
    const entry = selectedEntries.get(postId) ?? visibleEntries.get(postId);
    if (!entry || entry.documentKind !== 'opening' || entry.kind !== 'discussion')
      return failure('withdrawn', m.studio_discussion_only({}, accountOptions(locale)));
    return openEntry(entry, signal, () => documents.open({ projectId, postId }, signal));
  }

  async function resume(postId: string, signal: AbortSignal): Promise<StudioResult<StudioSelection>> {
    if (signal.aborted || !documents.isCurrent()) return { ok: false, error: unavailable(locale) };
    try {
      // The explicit Post address resolves one current opening, then the exact account reader confirms it.
      const head = await readPostDocumentHead({
        data: { postId, accountId, locale: accountOptions(locale).locale, ownDiscussionOpening: true },
        signal,
      });
      if (!head.ok) return head;
      const { post, viewerId } = head.value;
      if (post.id !== postId || viewerId !== accountId || signal.aborted || !documents.isCurrent())
        return { ok: false, error: unavailable(locale) };
      return await openEntry(openingEntry(head.value), signal, async () => {
        const selection = await projectPostDocumentHead(head.value, source.read().csrfReady && !!input.csrfToken);
        return selection ? { ok: true, value: selection } : { ok: false, error: unavailable(locale) };
      });
    } catch {
      return { ok: false, error: unavailable(locale) };
    }
  }

  async function createNativeDraft(
    draft: NativeDraftCreate & { idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioSelection>> {
    if (!isCurrent() || !commands?.create)
      return failure('denied', m.studio_create_session({}, accountOptions(locale)));
    const result = await commands.create(draft, signal);
    if (!result.ok) return writeFailure(result.reason, locale);
    if (!isCurrent()) return { ok: false, error: uncertain(locale) };
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
      return { ok: false, error: uncertain(locale) };
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
    const entry = openingEntry({
      post: { ...post, boardId: thread.boardId, licence: thread.licence, subjectIds: thread.subjectIds },
      title: thread.title,
    });
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
      return failure('stale', m.studio_reopen_before_save({}, accountOptions(locale)));
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
      if (!visibleEntries.has(save.postId) && visibleEntries.size === 20)
        visibleEntries.delete([...visibleEntries.keys()].at(-1)!);
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
      return failure('invalid', m.studio_article_review_one({}, accountOptions(locale)));
    const selection = selections.get(request.target.document.postId);
    if (!selection?.native || !sameExact(selection.revision.exact, request.target.document))
      return failure('stale', m.studio_reload_before_review({}, accountOptions(locale)));
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
      return failure('invalid', m.studio_publish_intent_unavailable({}, accountOptions(locale)));
    const target = review.target.document;
    const prior = selections.get(target.postId);
    const snapshot = review.articleSnapshot;
    if (!prior?.native || !sameExact(prior.revision.exact, target))
      return failure('stale', m.studio_review_stale({}, accountOptions(locale)));
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
    if (!result.ok) return writeFailure(result.reason, locale);
    if (!isCurrent()) return { ok: false, error: uncertain(locale) };
    const post = result.post;
    if (
      post.id !== target.postId ||
      post.threadId !== prior.native.threadId ||
      post.availability !== 'available' ||
      !checkDocument(post.body) ||
      serializeDocument(post.body) !== serializeDocument(snapshot.body) ||
      !sameList(post.mediaIds, snapshot.mediaIds) ||
      post.boardId !== snapshot.boardId ||
      post.licence !== snapshot.licence ||
      !sameList(post.subjectIds, snapshot.subjectIds) ||
      (await editionDocumentDigest(post.body)) !== post.sha256
    )
      return { ok: false, error: uncertain(locale) };
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
      return { ok: false, error: uncertain(locale) };
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
    resume,
    async documents(request, signal) {
      if (!isCurrent() || request.projectId !== projectId)
        return failure('denied', m.studio_open_current_account({}, accountOptions(locale)));
      const page = await reader.list(
        {
          accountId,
          ...(authnEpoch === null ? {} : { authnEpoch }),
          cursor: request.cursor,
        },
        signal,
      );
      if (typeof page === 'string') return readFailure(page, locale);
      if (!isCurrent() || page.drafts.length > 20) return { ok: false, error: unavailable(locale) };
      if (authnEpoch !== null && authnEpoch !== page.viewer.authnEpoch)
        return failure('denied', m.studio_authorization_changed({}, accountOptions(locale)));
      authnEpoch = page.viewer.authnEpoch;
      visibleEntries.clear();
      for (const entry of page.drafts) visibleEntries.set(entry.id, entry);
      return {
        ok: true,
        value: { items: page.drafts.map((entry) => summary(entry, locale)), nextCursor: page.next },
      };
    },
    open: (request, signal) =>
      request.projectId === projectId
        ? open(request.postId, signal)
        : Promise.resolve(failure('denied', m.studio_open_current_account({}, accountOptions(locale)))),
    createDraft: async () => failure('unavailable', m.studio_use_account_form({}, accountOptions(locale))),
    createNativeDraft,
    saveDraft,
    versions: (request, signal) => documents.versions(request, signal),
    revision: (request, signal) => documents.revision(request, signal),
    reviewPublication,
    publish,
    publications: async () => ({ ok: true, value: { items: [] as PublicationRecord[], nextCursor: null } }),
  };
}
