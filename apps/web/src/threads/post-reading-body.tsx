import { useMemo, type ComponentProps } from 'react';
import { DocumentBody, type DocumentMentions } from '../document-body';
import { getLocale } from '../paraglide/runtime.js';
import { NativeDocumentImage } from './document-media';
import { documentImagesForPost, type ThreadDocumentMedia } from './document-media-read';
import type { ThreadPost } from './reads';
import './post-reading.css';

/**
 * Keep the supplied document intact in the existing renderer. The grid gives prose a reading
 * measure while figures, tables and code can use the available width without moving in document order.
 * Unknown document language stays unknown; locale selects control labels and destinations only.
 */
export function PostReadingBody({ className, ...props }: ComponentProps<typeof DocumentBody>) {
  return (
    <div data-slot="post-reading-body" className="post-reading-body min-w-0" lang="" dir="auto">
      <DocumentBody {...props} className={`post-reading-document ${className ?? ''}`} />
    </div>
  );
}

/** One index per supplied disclosure, then constant-time admission for every image node. No new reads. */
export function ThreadPostReadingBody({
  post,
  documentMedia,
  mentions,
  locale = getLocale(),
}: {
  post: ThreadPost;
  documentMedia?: ThreadDocumentMedia | undefined;
  mentions: DocumentMentions;
  locale?: string;
}) {
  const images = useMemo(() => documentImagesForPost(documentMedia, post), [documentMedia, post]);
  if (post.availability !== 'available') return null;
  return (
    <PostReadingBody
      // An exact replacement revision is a fresh spoiler/image visit, even when its text is equal.
      key={`${post.id}:${post.revisionId}:${post.sha256}`}
      document={post.body}
      mentions={mentions}
      locale={locale}
      renderImage={({ mediaId, alt }) => (
        <NativeDocumentImage image={images.get(mediaId) ?? null} alt={alt} locale={locale} />
      )}
    />
  );
}
