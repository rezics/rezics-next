import { useCallback, useId, useLayoutEffect, useMemo, useState, type ComponentProps } from 'react';
import { DocumentBody, type DocumentMentions } from '../document-body';
import { getLocale } from '../paraglide/runtime.js';
import { NativeDocumentImage } from './document-media';
import { documentImagesForPost, type ThreadDocumentMedia } from './document-media-read';
import type { ThreadPost } from './reads';
import { projectReadingOutline } from './post-reading-outline';
import { PostReadingOutlineView } from './post-reading-outline-view';
import { PostReadingPosition } from './post-reading-position';
import './post-reading.css';

type ReadingProps = ComponentProps<typeof DocumentBody> & {
  /** The supplied source/viewer/route visit; replacing it retires equal document bytes as well. */
  readerIdentity?: unknown;
  isReaderCurrent?: () => boolean;
};

/**
 * Keep the supplied document intact in the existing renderer. The grid gives prose a reading
 * measure while figures, tables and code can use the available width without moving in document order.
 * Unknown document language stays unknown; locale selects control labels and destinations only.
 */
export function PostReadingBody(props: ReadingProps) {
  const [visit, setVisit] = useState(() => ({
    document: props.document,
    identity: props.readerIdentity,
    generation: 0,
    position: new PostReadingPosition(),
  }));
  if (visit.document !== props.document || visit.identity !== props.readerIdentity) {
    visit.position.retire();
    setVisit({
      document: props.document,
      identity: props.readerIdentity,
      generation: visit.generation + 1,
      position: new PostReadingPosition(),
    });
    return null;
  }
  visit.position.setGuard(props.isReaderCurrent);
  return <ReadingVisit key={visit.generation} {...props} position={visit.position} />;
}

function ReadingVisit({
  position,
  className,
  readerIdentity: _identity,
  isReaderCurrent: _current,
  locale = getLocale(),
  headingAttributes: callerAttributes,
  onDisclosureChange: callerDisclosure,
  ...props
}: ReadingProps & { position: PostReadingPosition }) {
  const namespace = `reading-${useId().replaceAll(':', '')}`;
  const [disclosed, setDisclosed] = useState<ReadonlySet<number>>(() => new Set());
  const outline = useMemo(() => projectReadingOutline(props.document, disclosed), [props.document, disclosed]);
  useLayoutEffect(() => position.connect(), [position]);
  const attributes = useMemo(() => {
    const bindings = new Map(
      outline.entries.map((entry) => [
        entry.nodeId,
        {
          id: `${namespace}-h-${entry.position}`,
          tabIndex: -1 as const,
          ref: (element: HTMLHeadingElement | null) => position.bind(entry.position, element),
        },
      ]),
    );
    return (nodeId: string) => bindings.get(nodeId) ?? callerAttributes?.(nodeId);
  }, [outline, namespace, position, callerAttributes]);
  const disclosure = useCallback(
    (revealed: ReadonlySet<number>) => {
      if (!position.isCurrent()) return;
      setDisclosed(revealed);
      callerDisclosure?.(revealed);
    },
    [position, callerDisclosure],
  );
  // Opening, dismissing and returning only render the controls; they never traverse the snapshot again.
  const body = useMemo(
    () => (
      <DocumentBody
        {...props}
        locale={locale}
        headingAttributes={attributes}
        onDisclosureChange={disclosure}
        className={`post-reading-document ${className ?? ''}`}
      />
    ),
    [props.document, props.mentions, props.labels, props.renderImage, locale, attributes, disclosure, className],
  );
  return (
    <div
      ref={(element) => position.setRoot(element)}
      data-slot="post-reading-body"
      className="post-reading-body min-w-0"
      lang=""
      dir="auto"
      tabIndex={-1}
      onFocusCapture={(event) => position.rememberFocus(event.target as HTMLElement)}
    >
      <PostReadingOutlineView outline={outline} position={position} locale={locale} />
      {body}
    </div>
  );
}

/** One index per supplied disclosure, then constant-time admission for every image node. No new reads. */
export function ThreadPostReadingBody({
  post,
  documentMedia,
  mentions,
  locale = getLocale(),
  readerIdentity,
  isReaderCurrent,
}: {
  post: ThreadPost;
  documentMedia?: ThreadDocumentMedia | undefined;
  mentions: DocumentMentions;
  locale?: string;
  readerIdentity?: unknown;
  isReaderCurrent?: () => boolean;
}) {
  const images = useMemo(() => documentImagesForPost(documentMedia, post), [documentMedia, post]);
  if (post.availability !== 'available') return null;
  return (
    <PostReadingBody
      // An exact replacement revision is a fresh spoiler/image visit, even when its text is equal.
      key={`${post.id}:${post.revisionId}:${post.sha256}`}
      readerIdentity={readerIdentity}
      {...(isReaderCurrent ? { isReaderCurrent } : {})}
      document={post.body}
      mentions={mentions}
      locale={locale}
      renderImage={({ mediaId, alt }) => (
        <NativeDocumentImage image={images.get(mediaId) ?? null} alt={alt} locale={locale} />
      )}
    />
  );
}
