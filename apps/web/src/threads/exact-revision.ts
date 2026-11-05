import type { KernelClient } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import { readPageAuthors, type PageAuthors } from '../identity/read';
import { readDocumentMentions } from '../kernel/mentions';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { threadTitle } from './thread-href';
import {
  loadRevisionDocumentMedia,
  revisionDocumentImageIds,
  type RevisionDocumentMedia,
} from './exact-revision-media';

type RevisionResource = ReturnType<ReturnType<KernelClient['posts']>['revisions']>;
export type ExactRevisionResponse = NonNullable<Awaited<ReturnType<RevisionResource['get']>>['data']>;
export type ExactRevision = Extract<ExactRevisionResponse['post'], { availability: 'available' }>;
export type ExactRevisionIdentity = { postId: string; revisionId: string };
export type ExactRevisionState =
  | { state: 'loading' }
  | { state: 'unavailable'; status: number }
  | { state: 'problem'; status: number; code: string | null }
  | {
      state: 'ready';
      revision: ExactRevision;
      thread: { id: string; title: string | null; differentHead: boolean };
      authors: PageAuthors;
      mentions: DocumentMentions;
      documentMedia: RevisionDocumentMedia;
      now: string;
    };

function failure(status: number, error: unknown): ExactRevisionState {
  if (status === 401 || status === 403 || status === 404) return { state: 'unavailable', status };
  const value = error && typeof error === 'object' && 'value' in error ? error.value : null;
  const code =
    value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : null;
  return { state: 'problem', status: status >= 400 ? status : 502, code };
}

/** Fresh exact disclosure, then one current thread point read. Never read a head, history page or parent chain. */
export async function loadExactRevision(
  client: KernelClient,
  identity: ExactRevisionIdentity,
  authorization: string | null = null,
): Promise<ExactRevisionState> {
  const options = authorization ? { headers: { authorization } } : {};
  try {
    const result = await client
      .posts({ id: identity.postId })
      .revisions({ revisionId: identity.revisionId })
      .get(options);
    if (result.error || !result.data) return failure(result.status, result.error);
    const revision = result.data.post;
    // Native absence and placeholders assert no erasure reason. Never retain a previous readable body.
    if (
      revision.id !== identity.postId ||
      revision.availability !== 'available' ||
      revision.revisionId !== identity.revisionId
    )
      return { state: 'unavailable', status: 404 };

    const context = await client.threads({ id: revision.threadId }).get(options);
    if (context.error || !context.data) return failure(context.status, context.error);
    const thread = context.data.thread;
    if (thread.id !== revision.threadId) return { state: 'unavailable', status: 404 };
    const opening = thread.firstPost;
    const [authors, mentions, documentMedia] = await Promise.all([
      readPageAuthors(client, [revision.authorId]),
      readDocumentMentions(client, [revision.body]),
      loadRevisionDocumentMedia(client, revisionDocumentImageIds([revision]), authorization),
    ]);
    return {
      state: 'ready',
      revision,
      // Do not serialize today's body, subjects or vote, or a title remembered on another page.
      thread: {
        id: thread.id,
        title: opening.availability === 'available' ? threadTitle(thread) : null,
        differentHead:
          opening.availability === 'available' &&
          opening.id === revision.id &&
          opening.revisionId !== revision.revisionId,
      },
      authors,
      mentions,
      documentMedia,
      now: new Date().toISOString(),
    };
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return { state: 'problem', status: 503, code: null };
  }
}
