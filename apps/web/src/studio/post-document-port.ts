import { checkDocument, hasDocumentContent, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { m } from '../paraglide/messages.js';
import { getLocale, isLocale, type Locale } from '../paraglide/runtime.js';
import { draftFetch, readExactRevision, revisePost, type EditFailure } from '../threads/studio-document';
import {
  createHistoricalReadBinding,
  historicalActualMatches,
  historicalBindingCurrent,
  historicalSessionReaderReady,
  sameHistoricalReadBinding,
  type HistoricalReadBinding,
  type HistoricalReadEnvelope,
  type HistoricalReaderSource,
} from '../threads/historical-reader-provenance';
import {
  sameExact,
  type ExactDocument,
  type StudioFailure,
  type StudioPort,
  type StudioResult,
  type StudioRevision,
  type StudioSelection,
} from './contract';
import { readPostDocumentHead, type PostDocumentHead } from './post-document-read';
import { readPostRevisionHeaders } from './post-revision-headers-read';

/** Compose exact Post reads and conditional revisions; account inventory and private creation have their own owner. */
export type PostDocumentPort = Pick<
  StudioPort,
  'isCurrent' | 'documents' | 'open' | 'createDraft' | 'saveDraft' | 'versions' | 'revision'
>;
export type PostDocumentVisit = Readonly<{
  projectId: string;
  accountId: string;
  locale: string;
  source: HistoricalReaderSource;
  /** Captured by the owning private visit. Replace the adapter when this credential changes. */
  csrfToken: string | null;
  isCurrent(): boolean;
  /** Current native project/resource admission, supplied by the host; never inferred from readable bytes. */
  admitsPost(postId: string): boolean;
}>;

type NativeDocument = Readonly<{
  id: string;
  revisionId: string;
  sha256: string;
  body: DocumentSnapshot;
  mediaIds: readonly string[];
  createdAt: string;
  revisedAt: string | null;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
function failure(kind: StudioFailure['kind'], message: string): { ok: false; error: StudioFailure } {
  return { ok: false, error: { kind, message } };
}
function documentOptions(locale: string): { locale: Locale } {
  return { locale: isLocale(locale) ? locale : getLocale() };
}
const unavailable = (locale: string) =>
  failure('unavailable', m.studio_document_operation_unavailable({}, documentOptions(locale)));
const uncertain = (locale: string) => failure('uncertain', m.studio_save_unknown({}, documentOptions(locale)));
const stale = (locale: string) => failure('stale', m.studio_document_stale({}, documentOptions(locale)));

function writeFailure(result: EditFailure, locale: string): { ok: false; error: StudioFailure } {
  const options = documentOptions(locale);
  switch (result.reason) {
    case 'stale':
    case 'conflict':
      return stale(locale);
    case 'forbidden':
      return failure('denied', m.studio_document_edit_denied({}, options));
    case 'invalid':
      return failure('invalid', m.studio_document_invalid({}, options));
    case 'media-unavailable':
      return failure('unavailable', m.studio_media_unavailable({}, options));
    case 'rate-limited':
      return failure('unavailable', m.studio_save_limited({}, options));
    case 'closed':
      return failure('unavailable', m.studio_save_closed({}, options));
    case 'not-found':
      return unavailable(locale);
    case 'unavailable':
      return uncertain(locale);
  }
}

async function projectRevision(post: NativeDocument, title: string): Promise<StudioRevision | null> {
  if (
    !digest.test(post.sha256) ||
    !checkDocument(post.body) ||
    !Number.isFinite(Date.parse(post.revisedAt ?? post.createdAt)) ||
    (await editionDocumentDigest(post.body)) !== post.sha256
  )
    return null;
  return {
    exact: { postId: post.id, revisionId: post.revisionId, sha256: post.sha256 },
    title,
    body: post.body,
    mediaIds: [...post.mediaIds],
    savedAt: post.revisedAt ?? post.createdAt,
  };
}

export async function projectPostDocumentHead(
  { post, title, viewerId }: PostDocumentHead,
  canWrite: boolean,
): Promise<StudioSelection | null> {
  const revision = await projectRevision(post, title);
  if (!revision) return null;
  return {
    revision,
    permissions: {
      edit: post.visibility === 'draft' && post.authorId === viewerId && canWrite,
      // The document port has no authority to publish.
      publish: false,
    },
    visibility: post.visibility,
    native: {
      threadId: post.threadId,
      boardId: post.boardId,
      licence: post.licence,
      subjectIds: [...post.subjectIds],
    },
  };
}

/**
 * One private mounted visit, with fresh native reads and no persistent document cache.
 * Exact reads serve the shared comparison and copy-into-working-draft UI. Saving that copy uses
 * the same conditional revision writer; Content's erased-Post restoration is a different operation.
 */
export function createPostDocumentPort(visit: PostDocumentVisit): PostDocumentPort {
  const options = documentOptions(visit.locale);
  const origin = visit.source.read();
  let retired = false;
  let reads = 0;
  // Retain one command admission so an uncertain retry can reach native idempotency even after its head advanced.
  let attempt: { key: string; intent: string; title: string; threadId: string } | null = null;
  function isCurrent() {
    const now = visit.source.read();
    if (
      !visit.isCurrent() ||
      now.sourceId !== origin.sourceId ||
      now.generation !== origin.generation ||
      !historicalSessionReaderReady(now) ||
      now.subject !== visit.accountId
    )
      retired = true;
    return !retired;
  }
  function admitted(projectId: string, postId: string, signal: AbortSignal) {
    return !signal.aborted && isCurrent() && projectId === visit.projectId && visit.admitsPost(postId);
  }
  function binding(target: Parameters<typeof createHistoricalReadBinding>[1]) {
    return createHistoricalReadBinding(visit.source, target, 0, 0, ++reads);
  }
  function accepts<T>(request: HistoricalReadBinding, response: HistoricalReadEnvelope<T>) {
    return (
      sameHistoricalReadBinding(request, response.provenance.binding) &&
      response.provenance.actualReader.credentialMode === 'session' &&
      historicalActualMatches(request, response.provenance.actualReader) &&
      historicalBindingCurrent(visit.source, request, response.provenance.actualReader)
    );
  }
  async function open(
    input: Parameters<StudioPort['open']>[0],
    signal: AbortSignal,
  ): Promise<StudioResult<StudioSelection>> {
    if (!admitted(input.projectId, input.postId, signal)) return unavailable(visit.locale);
    try {
      const result = await readPostDocumentHead({
        data: { postId: input.postId, accountId: visit.accountId, locale: options.locale },
        signal,
      });
      if (!admitted(input.projectId, input.postId, signal)) return unavailable(visit.locale);
      if (!result.ok) return result;
      const { post, viewerId } = result.value;
      if (post.id !== input.postId || viewerId !== visit.accountId) return unavailable(visit.locale);
      const selection = await projectPostDocumentHead(result.value, origin.csrfReady && !!visit.csrfToken);
      if (!selection || !admitted(input.projectId, input.postId, signal)) return unavailable(visit.locale);
      return { ok: true, value: selection };
    } catch {
      return unavailable(visit.locale);
    }
  }

  return {
    isCurrent,
    documents: async () => failure('unavailable', m.studio_no_inventory({}, options)),
    createDraft: async () => failure('unavailable', m.studio_no_title_draft({}, options)),
    open,
    async saveDraft(input, signal) {
      if (!admitted(input.projectId, input.postId, signal)) return unavailable(visit.locale);
      if (!visit.csrfToken || !origin.csrfReady) return failure('denied', m.studio_write_session({}, options));
      if (
        !uuid.test(input.idempotencyKey) ||
        !checkDocument(input.body) ||
        input.body.profile !== 'blocks' ||
        !hasDocumentContent(input.body) ||
        input.mediaIds.length > 32 ||
        input.mediaIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(input.mediaIds).size !== input.mediaIds.length
      )
        return failure('invalid', m.studio_draft_invalid({}, options));
      const intent = JSON.stringify([
        input.projectId,
        input.postId,
        input.expectedRevisionId,
        input.title,
        serializeDocument(input.body),
        input.mediaIds,
        input.native ?? null,
      ]);
      if (attempt?.key === input.idempotencyKey && attempt.intent !== intent)
        return failure('invalid', m.studio_save_key_mismatch({}, options));
      if (attempt && attempt.key !== input.idempotencyKey)
        return failure('uncertain', m.studio_pending_save({}, options));
      if (!attempt) {
        const current = await open(input, signal);
        if (!current.ok) return current;
        if (current.value.revision.exact.revisionId !== input.expectedRevisionId) return stale(visit.locale);
        if (!current.value.permissions.edit || !current.value.native)
          return failure('unavailable', m.studio_private_only({}, options));
        attempt = {
          key: input.idempotencyKey,
          intent,
          title: current.value.revision.title,
          threadId: current.value.native.threadId,
        };
      }
      if (!admitted(input.projectId, input.postId, signal)) return unavailable(visit.locale);
      const command = attempt;
      try {
        // revisePost delegates to post-writes.ts: original If-Match, key, media and native refusal behavior.
        const result = await revisePost({
          data: {
            postId: input.postId,
            revisionId: input.expectedRevisionId,
            body: input.body,
            mediaIds: [...input.mediaIds],
            ...(input.title === command.title ? {} : { title: input.title }),
            ...(input.native
              ? {
                  boardId: input.native.boardId,
                  licence: input.native.licence,
                  subjectIds: [...input.native.subjectIds],
                  visibility: input.native.visibility,
                }
              : { visibility: 'draft' as const }),
            idempotencyKey: input.idempotencyKey,
          },
          headers: { 'X-CSRF-Token': visit.csrfToken },
          signal,
          fetch: draftFetch(input.body),
        });
        if (!admitted(input.projectId, input.postId, signal)) return uncertain(visit.locale);
        if (!result.ok) {
          const mapped = writeFailure(result, visit.locale);
          if (mapped.error.kind !== 'uncertain' && mapped.error.kind !== 'unavailable') attempt = null;
          return mapped;
        }
        const post = result.post;
        if (
          post.id !== input.postId ||
          post.threadId !== command.threadId ||
          post.availability !== 'available' ||
          post.visibility !== 'draft' ||
          post.authorId !== visit.accountId
        )
          return uncertain(visit.locale);
        const currentHead = await open(input, signal);
        if (
          !currentHead.ok ||
          !currentHead.value.permissions.edit ||
          currentHead.value.native?.threadId !== command.threadId ||
          !sameExact(currentHead.value.revision.exact, {
            postId: post.id,
            revisionId: post.revisionId,
            sha256: post.sha256,
          }) ||
          currentHead.value.revision.title !== input.title ||
          serializeDocument(currentHead.value.revision.body) !== serializeDocument(input.body) ||
          currentHead.value.revision.mediaIds.length !== input.mediaIds.length ||
          !currentHead.value.revision.mediaIds.every((id, index) => id === input.mediaIds[index]) ||
          (input.native &&
            (currentHead.value.native?.boardId !== input.native.boardId ||
              currentHead.value.native?.licence !== input.native.licence ||
              JSON.stringify(currentHead.value.native?.subjectIds) !== JSON.stringify(input.native.subjectIds))) ||
          !admitted(input.projectId, input.postId, signal)
        )
          return uncertain(visit.locale);
        attempt = null;
        return { ok: true, value: currentHead.value };
      } catch {
        return uncertain(visit.locale);
      }
    },
    async versions(input, signal) {
      if (!admitted(input.projectId, input.postId, signal)) return unavailable(visit.locale);
      const request = binding({
        kind: 'post-revision-headers',
        postId: input.postId,
        cursor: input.cursor,
        locale: visit.locale,
        credentialMode: 'session',
      });
      try {
        const response = await readPostRevisionHeaders({
          data: {
            postId: input.postId,
            ...(input.cursor === null ? {} : { cursor: input.cursor }),
            locale: visit.locale,
            credentialMode: 'session',
            binding: request,
          },
          signal,
        });
        if (!admitted(input.projectId, input.postId, signal) || !accepts(request, response))
          return unavailable(visit.locale);
        return response.data;
      } catch {
        return unavailable(visit.locale);
      }
    },
    async revision(input, signal) {
      const exact: ExactDocument = input.document;
      if (!admitted(input.projectId, exact.postId, signal)) return unavailable(visit.locale);
      const request = binding({
        kind: 'exact-revision',
        postId: exact.postId,
        revisionId: exact.revisionId,
        locale: visit.locale,
        credentialMode: 'session',
      });
      try {
        const response = await readExactRevision({
          data: {
            postId: exact.postId,
            revisionId: exact.revisionId,
            locale: visit.locale,
            credentialMode: 'session',
            binding: request,
          },
          signal,
        });
        if (!admitted(input.projectId, exact.postId, signal) || !accepts(request, response))
          return unavailable(visit.locale);
        const page = response.data;
        if (page.state !== 'ready' || page.thread.title === null) return unavailable(visit.locale);
        const revision = await projectRevision(page.revision, page.thread.title);
        if (!revision || !sameExact(revision.exact, exact))
          return failure('invalid', m.studio_revision_mismatch({}, options));
        if (!admitted(input.projectId, exact.postId, signal)) return unavailable(visit.locale);
        return { ok: true, value: revision };
      } catch {
        return unavailable(visit.locale);
      }
    },
  };
}
