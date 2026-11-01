import { DocumentBody } from '../document-body';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Byline } from './byline';
import { NativeDocumentImage } from './document-media';
import { exactRevisionHref } from './exact-revision-href';
import { revisionDocumentImage } from './exact-revision-media';
import { readPostHistory } from './reads';
import { RevisionProvenance } from './revision-provenance-view';
import {
  historicalBindingCurrent,
  sameHistoricalReadBinding,
  type HistoricalReaderSource,
} from './historical-reader-provenance';
import {
  historySessionReady,
  PostHistoryLifetime,
  postHistorySessionSource,
  type HistoryPage,
} from './post-history-lifetime';

type Revision = HistoryPage['revisions'][number];

type PostHistoryProps = {
  postId: string;
  viewerId?: string;
  readAuthority?: object;
  review?: boolean;
  /** Allows the same producer's control and expanded region to participate in the post footer. */
  className?: string;
};

const noSubscription = () => () => {};
const serverRevision = () => 0;

/** A disclosure belongs to its original caller and actual browser session cache lifetime. */
export function PostHistory(props: PostHistoryProps) {
  const { postId, viewerId, readAuthority } = props;
  const client = useContext(QueryClientContext);
  const source = client && typeof window !== 'undefined' ? postHistorySessionSource(client) : undefined;
  const observation = source?.read();
  const revision = useSyncExternalStore(
    source?.subscribe ?? noSubscription,
    source?.revision ?? serverRevision,
    serverRevision,
  );
  const locale = getLocale();
  const credentialMode =
    observation?.state === 'signed-in' && observation.subject
      ? 'session'
      : !source && viewerId
        ? 'session'
        : 'anonymous';
  const binding = useMemo(
    () => ({ postId, viewerId, readAuthority, source, revision, locale, credentialMode }),
    [postId, viewerId, readAuthority, source, revision, locale, credentialMode],
  );
  const current = useRef(binding);
  current.current = binding;
  const lifetime = useMemo(
    () =>
      new PostHistoryLifetime(
        () => current.current === binding && (!source || source.revision() === revision),
        source?.subscribe,
      ),
    [binding, source, revision],
  );
  const previous = useRef(lifetime);
  if (previous.current !== lifetime) {
    // The parent is already replacing the old subtree; clear it without notifying during render.
    previous.current.retire(false);
    previous.current = lifetime;
  }
  useLayoutEffect(lifetime.connect, [lifetime]);
  return (
    <HistoryDisclosure
      key={lifetime.id}
      {...props}
      lifetime={lifetime}
      source={source}
      locale={locale}
      credentialMode={credentialMode}
      ready={() => historySessionReady(source, viewerId)}
    />
  );
}

/** A bounded, cursor-paged view of the immutable revisions returned by the native post history API. */
function HistoryDisclosure({
  postId,
  viewerId,
  review = false,
  className = 'mt-3',
  lifetime,
  source,
  locale,
  credentialMode,
  ready,
}: PostHistoryProps & {
  lifetime: PostHistoryLifetime;
  source: HistoricalReaderSource | undefined;
  locale: string;
  credentialMode: 'anonymous' | 'session';
  ready: () => boolean;
}) {
  const regionId = `post-history-${useId().replaceAll(':', '')}`;
  const {
    open,
    loading,
    loaded,
    available,
    failedCursor,
    revisions,
    authors,
    mentions,
    subjects,
    reviewVotes,
    next,
    now,
  } = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  const connection = lifetime.ticket();

  async function load(cursor?: string) {
    const request = lifetime.begin(connection, source, postId, cursor, locale, credentialMode, viewerId);
    if (!request) return;
    lifetime.update(connection, (view) => ({ ...view, loading: true }));
    try {
      // Fence the queued transport itself, before it can borrow replacement session credentials.
      await Promise.resolve();
      if (!lifetime.owns(request) || !historicalBindingCurrent(source, request.binding)) return;
      if (!ready()) {
        lifetime.update(connection, (view) => ({ ...view, available: false, loaded: true, failedCursor: cursor }));
        return;
      }
      const result = await readPostHistory({
        data: {
          postId,
          ...(cursor !== undefined ? { cursor } : {}),
          locale,
          credentialMode,
          binding: request.binding,
        },
      });
      if (!lifetime.owns(request)) return;
      const target = request.binding.target;
      const resultBinding = result.provenance?.binding;
      if (
        !resultBinding ||
        !sameHistoricalReadBinding(request.binding, resultBinding) ||
        target.kind !== 'post-history' ||
        target.postId !== postId ||
        target.cursor !== (cursor ?? null) ||
        target.locale !== locale ||
        target.credentialMode !== credentialMode ||
        !Number.isSafeInteger(result.provenance.responseGeneration) ||
        result.provenance.responseGeneration <= 0 ||
        !historicalBindingCurrent(source, request.binding, result.provenance.actualReader) ||
        !lifetime.acceptReader(request, result.provenance.actualReader)
      ) {
        if (lifetime.owns(request)) lifetime.resetDisclosure(connection);
        return;
      }
      if (!result.data.available) {
        lifetime.update(connection, (view) => ({ ...view, available: false, loaded: true, failedCursor: cursor }));
        return;
      }
      const page = result.data;
      const entries = page.revisions.map((revision) => ({ revision, documentMedia: page.documentMedia }));
      lifetime.update(connection, (view) => ({
        ...view,
        revisions: cursor ? [...view.revisions, ...entries] : entries,
        authors: { ...(view.authors ?? {}), ...(page.authors ?? {}) },
        mentions: { ...view.mentions, ...page.mentions },
        subjects: [...new Map([...view.subjects, ...page.subjects].map((subject) => [subject.id, subject])).values()],
        reviewVotes: { ...view.reviewVotes, ...page.reviewVotes },
        next: page.next,
        now: page.now,
        loaded: true,
        available: true,
        failedCursor: undefined,
      }));
    } catch {
      if (lifetime.owns(request)) {
        lifetime.update(connection, (view) => ({ ...view, available: false, loaded: true, failedCursor: cursor }));
      }
    } finally {
      lifetime.finish(request);
    }
  }

  function toggle() {
    if (!lifetime.ownsConnection(connection)) return;
    const view = lifetime.snapshot();
    const reveal = !view.open;
    lifetime.update(connection, (current) => ({ ...current, open: reveal }));
    if (reveal && !view.loaded && !view.loading) void load();
  }

  return (
    <div className={className}>
      <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={regionId} onClick={toggle}>
        {open ? m.thread_history_hide() : m.thread_history_show()}
      </Button>
      <section
        id={regionId}
        hidden={!open}
        role="region"
        aria-label={m.thread_history_heading()}
        className="order-last mt-3 min-w-0 basis-full space-y-4 rounded-xl border border-border/70 bg-card p-4 sm:p-5"
      >
        <ContentItemHeading level={3} className="text-base font-semibold">
          {m.thread_history_heading()}
        </ContentItemHeading>
        {loading && !loaded ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.thread_history_loading()}
          </p>
        ) : null}
        {!available ? (
          <div className="space-y-3">
            <p role="status" className="text-sm text-muted-foreground">
              {m.thread_history_unavailable()}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void load(failedCursor)}
            >
              {m.exact_revision_retry()}
            </Button>
          </div>
        ) : null}
        {available && loaded && revisions.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.thread_history_unavailable()}
          </p>
        ) : null}
        {available && revisions.length > 0 ? (
          <ol className="space-y-5" aria-label={m.thread_history_heading()}>
            {revisions.map(({ revision, documentMedia }, index) => (
              <RevisionEntry
                key={revision.revisionId}
                revision={revision}
                number={index + 1}
                authors={authors}
                mentions={mentions}
                documentMedia={documentMedia}
                now={now}
                subjects={subjects}
                currentVote={viewerId === revision.authorId ? reviewVotes[revision.id] : undefined}
                review={review}
              />
            ))}
          </ol>
        ) : null}
        {loading && loaded ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.thread_history_loading()}
          </p>
        ) : null}
        {available && next ? (
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load(next!)}>
            {m.thread_history_more()}
          </Button>
        ) : null}
      </section>
    </div>
  );
}

export function RevisionEntry({
  revision,
  number,
  authors,
  mentions,
  documentMedia,
  now,
  subjects,
  currentVote,
  review,
}: {
  revision: Revision;
  number: number;
  authors: HistoryPage['authors'];
  mentions: HistoryPage['mentions'];
  documentMedia: HistoryPage['documentMedia'];
  now: string;
  subjects: HistoryPage['subjects'];
  currentVote: HistoryPage['reviewVotes'][string] | undefined;
  review: boolean;
}) {
  const locale = getLocale();
  return (
    <li className="min-w-0 border-t border-border/60 pt-4 first:border-0 first:pt-0">
      <ContentItemFrame
        as="article"
        data-slot="content-item-frame"
        aria-labelledby={`revision-entry-${revision.revisionId}`}
        className="min-w-0 space-y-3 rounded-xl"
      >
        <ContentItemHeading level={4} id={`revision-entry-${revision.revisionId}`} className="font-semibold">
          <a
            href={exactRevisionHref({ postId: revision.id, revisionId: revision.revisionId }, locale)}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            {m.thread_history_version({ number: String(number) })}
          </a>
        </ContentItemHeading>
        <Byline
          author={authors?.[revision.authorId]}
          createdAt={revision.revisedAt ?? revision.createdAt}
          now={now}
          showAuthor
        />
        {revision.availability === 'available' && revision.body ? (
          <DocumentBody
            document={revision.body}
            mentions={mentions}
            locale={locale}
            renderImage={({ mediaId, alt }) => (
              <NativeDocumentImage
                image={revisionDocumentImage(documentMedia, revision, mediaId)}
                alt={alt}
                locale={locale}
              />
            )}
          />
        ) : null}
        <RevisionProvenance revision={revision} subjects={subjects} currentVote={currentVote ?? null} review={review} />
      </ContentItemFrame>
    </li>
  );
}
