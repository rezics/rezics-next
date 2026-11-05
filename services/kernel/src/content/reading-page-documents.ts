import type { DocumentNode } from '@rezics/document';
import { classifyUnavailability } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { routeOf } from '../route/route.ts';
import type { MediaDependencies } from './media.ts';
import { readDocumentMediaPresentations, type DocumentImagePresentation } from './media-presentation.ts';
import type { PostEntry } from './reads.ts';
import { ContentIdSchema, DocumentImagePresentationSchema } from './schemas.ts';

const closed = { additionalProperties: false } as const;
export const READING_PAGE_DOCUMENT_MEDIA_LIMIT = 32;
export const READING_PAGE_DOCUMENT_LIMIT = 21;

export type ReadingPageDocumentImage =
  | Readonly<{ id: string; state: 'available'; presentation: DocumentImagePresentation }>
  | Readonly<{ id: string; state: 'unavailable' }>;
export type ReadingPageDocument = Readonly<{
  postId: string;
  threadId: string;
  revisionId: string;
  sha256: string;
  state: 'available' | 'unavailable' | 'overflow';
  images: readonly ReadingPageDocumentImage[];
}>;
export type ReadingPageDocumentMedia = Readonly<{
  state: 'available' | 'unavailable' | 'overflow';
  documents: readonly ReadingPageDocument[];
}>;

const ReadingPageDocumentImageSchema = t.Union([
  t.Object(
    {
      id: ContentIdSchema,
      state: t.Literal('available'),
      presentation: DocumentImagePresentationSchema,
    },
    closed,
  ),
  t.Object({ id: ContentIdSchema, state: t.Literal('unavailable') }, closed),
]);
export const ReadingPageDocumentMediaSchema = t.Unsafe<ReadingPageDocumentMedia>(
  t.Object(
    {
      state: t.Union([t.Literal('available'), t.Literal('unavailable'), t.Literal('overflow')]),
      documents: t.Array(
        t.Object(
          {
            postId: ContentIdSchema,
            threadId: ContentIdSchema,
            revisionId: ContentIdSchema,
            sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
            state: t.Union([t.Literal('available'), t.Literal('unavailable'), t.Literal('overflow')]),
            images: t.Array(ReadingPageDocumentImageSchema, { maxItems: READING_PAGE_DOCUMENT_MEDIA_LIMIT }),
          },
          closed,
        ),
        { maxItems: READING_PAGE_DOCUMENT_LIMIT },
      ),
    },
    closed,
  ),
);

export type SelectedReadingPageDocument = Readonly<{
  postId: string;
  threadId: string;
  revisionId: string;
  sha256: string;
  mediaIds: readonly string[];
}>;
export type ReadingPageDocumentSelection =
  | Readonly<{ state: 'selected'; documents: readonly SelectedReadingPageDocument[]; mediaIds: readonly string[] }>
  | Readonly<{ state: 'overflow'; documents: readonly SelectedReadingPageDocument[] }>;

function referencedImages(document: DocumentNode, declared: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  const pending = [document];
  while (pending.length && ids.size <= READING_PAGE_DOCUMENT_MEDIA_LIMIT) {
    const node = pending.pop()!;
    const source = node.type === 'image' ? node.attrs?.src : undefined;
    if (typeof source === 'string' && declared.has(source) && routeOf(source) !== null) ids.add(source);
    for (const child of node.content ?? []) pending.push(child);
  }
  return [...ids];
}

/** Select only declared image IDs in the current readable documents of one native page. */
export function selectReadingPageDocumentMedia(
  threadId: string,
  posts: readonly PostEntry[],
): ReadingPageDocumentSelection {
  if (posts.length > READING_PAGE_DOCUMENT_LIMIT) throw new RangeError('Reading page document bound exceeded');
  const selected: SelectedReadingPageDocument[] = [];
  const allIds = new Set<string>();
  for (const post of posts) {
    if (post.availability !== 'available' || post.threadId !== threadId || !('revisionId' in post)) continue;
    const declared = new Set(post.mediaIds.filter((id) => routeOf(id) !== null));
    const mediaIds = referencedImages(post.body.doc, declared);
    if (!mediaIds.length) continue;
    selected.push({
      postId: post.id,
      threadId: post.threadId,
      revisionId: post.revisionId,
      sha256: post.sha256,
      mediaIds,
    });
    for (const id of mediaIds) {
      allIds.add(id);
      if (allIds.size > READING_PAGE_DOCUMENT_MEDIA_LIMIT) break;
    }
  }
  if (allIds.size > READING_PAGE_DOCUMENT_MEDIA_LIMIT) return { state: 'overflow', documents: selected };
  return { state: 'selected', documents: selected, mediaIds: [...allIds] };
}

function unavailableDocument(document: SelectedReadingPageDocument): ReadingPageDocument {
  return {
    postId: document.postId,
    threadId: document.threadId,
    revisionId: document.revisionId,
    sha256: document.sha256,
    state: 'unavailable',
    images: [],
  };
}

/** Native optional composition runs before ReadingPage's final source admission. */
export async function readReadingPageDocumentMedia(
  dependencies: MediaDependencies & Readonly<{ routeKey: Uint8Array }>,
  actor: Actor,
  threadId: string,
  posts: readonly PostEntry[],
  deadline: number,
): Promise<ReadingPageDocumentMedia> {
  const selection = selectReadingPageDocumentMedia(threadId, posts);
  if (selection.state === 'overflow')
    return {
      state: 'overflow',
      documents: selection.documents.map((document) => ({
        ...unavailableDocument(document),
        state: 'overflow' as const,
      })),
    };
  if (!selection.documents.length) return { state: 'available', documents: [] };
  let presentations: readonly DocumentImagePresentation[];
  try {
    presentations = (
      await readDocumentMediaPresentations(dependencies, actor, selection.mediaIds, {
        deadline,
        routeKey: dependencies.routeKey,
      })
    ).images;
  } catch (error) {
    if (
      classifyUnavailability(error) === undefined &&
      !(error instanceof ProblemError && error.code === 'dependency_unavailable')
    )
      throw error;
    return { state: 'unavailable', documents: selection.documents.map(unavailableDocument) };
  }
  const byId = new Map<string, DocumentImagePresentation>();
  for (const image of presentations) {
    if (!selection.mediaIds.includes(image.id) || byId.has(image.id))
      return { state: 'unavailable', documents: selection.documents.map(unavailableDocument) };
    byId.set(image.id, image);
  }
  const documents = selection.documents.map<ReadingPageDocument>((document) => {
    const images = document.mediaIds.map<ReadingPageDocumentImage>((id) => {
      const presentation = byId.get(id);
      return presentation?.containerId === document.threadId
        ? { id, state: 'available', presentation }
        : { id, state: 'unavailable' };
    });
    return {
      postId: document.postId,
      threadId: document.threadId,
      revisionId: document.revisionId,
      sha256: document.sha256,
      state: images.every((image) => image.state === 'available') ? 'available' : 'unavailable',
      images,
    };
  });
  return {
    state: documents.every((document) => document.state === 'available') ? 'available' : 'unavailable',
    documents,
  };
}

export type ReadingPageDocumentMediaResponse = Static<typeof ReadingPageDocumentMediaSchema>;
