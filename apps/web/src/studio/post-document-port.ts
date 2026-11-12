import { checkDocument, hasDocumentContent, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { revisePost, type EditFailure } from '../threads/actions';
import { draftFetch } from '../threads/composer';
import { readExactRevision } from '../threads/exact-revision-read';
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
import { readPostHistory } from '../threads/reads';
import {
  sameExact,
  type ExactDocument,
  type StudioFailure,
  type StudioPort,
  type StudioResult,
  type StudioRevision,
  type StudioSelection,
} from './contract';
import { readPostDocumentHead } from './post-document-read';

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
const unavailable = () => failure('unavailable', 'This document operation is unavailable. Try again.');
const uncertain = () => failure('uncertain', 'The save result is unknown. Retry the same save to recover its result.');
const stale = () => failure('stale', 'The saved revision changed. Reopen the document before editing.');

function writeFailure(result: EditFailure): { ok: false; error: StudioFailure } {
  switch (result.reason) {
    case 'stale':
    case 'conflict':
      return stale();
    case 'forbidden':
      return failure('denied', 'You cannot edit this document with the current account.');
    case 'invalid':
      return failure('invalid', 'The document could not be saved. Check its contents.');
    case 'media-unavailable':
      return failure('unavailable', 'Document media is unavailable. Retry this save when it is ready.');
    case 'rate-limited':
      return failure('unavailable', 'Saving is temporarily limited. Retry the same save later.');
    case 'closed':
      return failure('unavailable', 'Saving is currently closed. Retry the same save later.');
    case 'not-found':
      return unavailable();
    case 'unavailable':
      return uncertain();
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

/**
 * One private mounted visit, with fresh native reads and no persistent document cache.
 * Exact reads serve the shared comparison and copy-into-working-draft UI. Saving that copy uses
 * the same conditional revision writer; Content's erased-Post restoration is a different operation.
 */
export function createPostDocumentPort(visit: PostDocumentVisit): PostDocumentPort {
  const origin = visit.source.read();
  let retired = false;
  let reads = 0;
  // Retain one command admission so an uncertain retry can reach native idempotency even after its head advanced.
  let attempt: { key: string; intent: string; title: string } | null = null;
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
    if (!admitted(input.projectId, input.postId, signal)) return unavailable();
    try {
      const result = await readPostDocumentHead({ data: { postId: input.postId, accountId: visit.accountId }, signal });
      if (!admitted(input.projectId, input.postId, signal)) return unavailable();
      if (!result.ok) return result;
      const { post, title, viewerId } = result.value;
      if (post.id !== input.postId || viewerId !== visit.accountId) return unavailable();
      const revision = await projectRevision(post, title);
      if (!revision || !admitted(input.projectId, input.postId, signal)) return unavailable();
      return {
        ok: true,
        value: {
          revision,
          permissions: {
            edit:
              post.visibility === 'draft' && post.authorId === visit.accountId && origin.csrfReady && !!visit.csrfToken,
            // Content's draft-to-published command does not implement Studio's reviewed publication contract.
            publish: false,
          },
          visibility: post.visibility,
          native: {
            threadId: post.threadId,
            boardId: post.boardId,
            licence: post.licence,
            subjectIds: [...post.subjectIds],
          },
        },
      };
    } catch {
      return unavailable();
    }
  }

  return {
    isCurrent,
    documents: async () => failure('unavailable', 'Content has no project document inventory.'),
    createDraft: async () => failure('unavailable', 'Content has no title-only private draft creation operation.'),
    open,
    async saveDraft(input, signal) {
      if (!admitted(input.projectId, input.postId, signal)) return unavailable();
      if (!visit.csrfToken || !origin.csrfReady) return failure('denied', 'Editing requires a current write session.');
      if (
        !uuid.test(input.idempotencyKey) ||
        !checkDocument(input.body) ||
        input.body.profile !== 'blocks' ||
        !hasDocumentContent(input.body) ||
        input.mediaIds.length > 32 ||
        input.mediaIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(input.mediaIds).size !== input.mediaIds.length
      )
        return failure('invalid', 'The draft contents or save key are invalid.');
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
        return failure('invalid', 'A save key cannot be reused for different edits.');
      if (attempt && attempt.key !== input.idempotencyKey)
        return failure('uncertain', 'Retry the pending save before starting another one.');
      if (!attempt) {
        const current = await open(input, signal);
        if (!current.ok) return current;
        if (current.value.revision.exact.revisionId !== input.expectedRevisionId) return stale();
        if (!current.value.permissions.edit)
          return failure('unavailable', 'Only existing private drafts can be saved privately.');
        attempt = { key: input.idempotencyKey, intent, title: current.value.revision.title };
      }
      if (!admitted(input.projectId, input.postId, signal)) return unavailable();
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
        if (!admitted(input.projectId, input.postId, signal)) return uncertain();
        if (!result.ok) {
          const mapped = writeFailure(result);
          if (mapped.error.kind !== 'uncertain' && mapped.error.kind !== 'unavailable') attempt = null;
          return mapped;
        }
        const post = result.post;
        if (
          post.id !== input.postId ||
          post.availability !== 'available' ||
          post.visibility !== 'draft' ||
          post.authorId !== visit.accountId
        )
          return uncertain();
        const currentHead = await open(input, signal);
        if (
          !currentHead.ok ||
          currentHead.value.revision.exact.revisionId !== post.revisionId ||
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
          return uncertain();
        attempt = null;
        return { ok: true, value: currentHead.value };
      } catch {
        return uncertain();
      }
    },
    async versions(input, signal) {
      if (!admitted(input.projectId, input.postId, signal)) return unavailable();
      const request = binding({
        kind: 'post-history',
        postId: input.postId,
        cursor: input.cursor,
        locale: visit.locale,
        credentialMode: 'session',
      });
      try {
        const response = await readPostHistory({
          data: {
            postId: input.postId,
            ...(input.cursor === null ? {} : { cursor: input.cursor }),
            locale: visit.locale,
            credentialMode: 'session',
            binding: request,
          },
          signal,
        });
        if (!admitted(input.projectId, input.postId, signal) || !accepts(request, response)) return unavailable();
        const page = response.data;
        if (!page.available || !page.context || page.context.conversation.title === null) return unavailable();
        const title = page.context.conversation.title;
        const items: Omit<StudioRevision, 'body' | 'mediaIds'>[] = [];
        for (const post of page.revisions) {
          // Studio's summary cannot express withheld/erased identities. Do not forge a digest or an empty page.
          if (post.id !== input.postId || post.availability !== 'available' || !digest.test(post.sha256))
            return unavailable();
          items.push({
            exact: { postId: post.id, revisionId: post.revisionId, sha256: post.sha256 },
            title,
            savedAt: post.revisedAt ?? post.createdAt,
          });
        }
        return { ok: true, value: { items, nextCursor: page.next } };
      } catch {
        return unavailable();
      }
    },
    async revision(input, signal) {
      const exact: ExactDocument = input.document;
      if (!admitted(input.projectId, exact.postId, signal)) return unavailable();
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
        if (!admitted(input.projectId, exact.postId, signal) || !accepts(request, response)) return unavailable();
        const page = response.data;
        if (page.state !== 'ready' || page.thread.title === null) return unavailable();
        const revision = await projectRevision(page.revision, page.thread.title);
        if (!revision || !sameExact(revision.exact, exact))
          return failure('invalid', 'The response did not match the selected exact revision.');
        if (!admitted(input.projectId, exact.postId, signal)) return unavailable();
        return { ok: true, value: revision };
      } catch {
        return unavailable();
      }
    },
  };
}
