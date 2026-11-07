import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { MediaDependencies } from './media.ts';
import type { DocumentImagePresentation } from './media-presentation.ts';
import type { PostEntry } from './reads.ts';
import { ContentIdSchema, DocumentImagePresentationSchema } from './schemas.ts';
import { selectReadingPageDocumentMedia as selectDocuments } from './application/index.ts';
import { readingPageCapabilities } from './adapters/reading-page-bind.ts';
import { READING_PAGE_DOCUMENT_LIMIT, READING_PAGE_DOCUMENT_MEDIA_LIMIT } from './contract/index.ts';
import type {
  ReadingPageDocumentMedia as DocumentMedia,
  ReadingPageDocument as DocumentProjection,
  ProjectedReadingPageImage,
} from './contract/index.ts';
export { READING_PAGE_DOCUMENT_LIMIT, READING_PAGE_DOCUMENT_MEDIA_LIMIT };
export { projectReadingPageDocumentMedia } from './application/index.ts';
export type { SelectedReadingPageDocument, ReadingPageDocumentSelection } from './contract/index.ts';
export type ReadingPageDocumentMedia = DocumentMedia<DocumentImagePresentation>;
export type ReadingPageDocument = DocumentProjection<DocumentImagePresentation>;
export type ReadingPageDocumentImage = ProjectedReadingPageImage<DocumentImagePresentation>;
const closed = { additionalProperties: false } as const;

function ReadingPageDocumentImageSchema() {
  return memoizedValue(ReadingPageDocumentImageSchema, () =>
    t.Union([
      t.Object(
        {
          id: ContentIdSchema,
          state: t.Literal('available'),
          presentation: DocumentImagePresentationSchema(),
        },
        closed,
      ),
      t.Object({ id: ContentIdSchema, state: t.Literal('unavailable') }, closed),
    ]),
  );
}
export function ReadingPageDocumentMediaSchema() {
  return memoizedValue(ReadingPageDocumentMediaSchema, () =>
    t.Unsafe<ReadingPageDocumentMedia>(
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
                images: t.Array(ReadingPageDocumentImageSchema(), { maxItems: READING_PAGE_DOCUMENT_MEDIA_LIMIT }),
              },
              closed,
            ),
            { maxItems: READING_PAGE_DOCUMENT_LIMIT },
          ),
        },
        closed,
      ),
    ),
  );
}

export function selectReadingPageDocumentMedia(threadId: string, posts: readonly PostEntry[]) {
  return selectDocuments(threadId, posts, (id) => routeOf(id) !== null);
}
export function readReadingPageDocumentMedia(
  dependencies: MediaDependencies & Readonly<{ routeKey: Uint8Array }>,
  actor: Actor,
  threadId: string,
  posts: readonly PostEntry[],
  deadline: number,
): Promise<ReadingPageDocumentMedia> {
  return readingPageCapabilities().readDocuments(
    dependencies,
    actor,
    selectReadingPageDocumentMedia(threadId, posts),
    deadline,
  );
}
export type ReadingPageDocumentMediaResponse = Static<ReturnType<typeof ReadingPageDocumentMediaSchema>>;
