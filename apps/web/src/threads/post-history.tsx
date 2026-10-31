import { DocumentBody } from '../document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Byline } from './byline';
import { NativeDocumentImage } from './document-media';
import { exactRevisionHref } from './exact-revision-href';
import { revisionDocumentImage } from './exact-revision-media';
import { readPostHistory } from './reads';
import { RevisionProvenance } from './revision-provenance-view';

type HistoryPage = Extract<Awaited<ReturnType<typeof readPostHistory>>, { available: true }>;
type Revision = HistoryPage['revisions'][number];

type PostHistoryProps = {
  postId: string;
  viewerId?: string;
  readAuthority?: object;
  review?: boolean;
};

/** A disclosure belongs to one post and the current reader's existing authority. */
export function PostHistory(props: PostHistoryProps) {
  const { postId, viewerId, readAuthority } = props;
  const [scope, setScope] = useState({ postId, viewerId, readAuthority, generation: 0 });
  if (scope.postId !== postId || scope.viewerId !== viewerId || scope.readAuthority !== readAuthority) {
    setScope({ postId, viewerId, readAuthority, generation: scope.generation + 1 });
  }
  return <HistoryDisclosure key={scope.generation} {...props} />;
}

/** A bounded, cursor-paged view of the immutable revisions returned by the native post history API. */
function HistoryDisclosure({ postId, viewerId, review = false }: PostHistoryProps) {
  const regionId = `post-history-${useId().replaceAll(':', '')}`;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);
  const [failedCursor, setFailedCursor] = useState<string>();
  const [revisions, setRevisions] = useState<{ revision: Revision; documentMedia: HistoryPage['documentMedia'] }[]>([]);
  const [authors, setAuthors] = useState<HistoryPage['authors']>({});
  const [mentions, setMentions] = useState<HistoryPage['mentions']>({});
  const [subjects, setSubjects] = useState<HistoryPage['subjects']>([]);
  const [reviewVotes, setReviewVotes] = useState<HistoryPage['reviewVotes']>({});
  const [next, setNext] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const request = useRef<{ pending: boolean } | undefined>(undefined);

  useEffect(() => {
    request.current = { pending: false };
    return () => {
      request.current = undefined;
    };
  }, []);

  async function load(cursor?: string) {
    const current = request.current;
    if (!current || current.pending) return;
    current.pending = true;
    setLoading(true);
    try {
      const result = await readPostHistory({ data: { postId, ...(cursor ? { cursor } : {}) } });
      if (request.current !== current) return;
      if (!result.available) {
        setAvailable(false);
        setLoaded(true);
        setFailedCursor(cursor);
        return;
      }
      const entries = result.revisions.map((revision) => ({ revision, documentMedia: result.documentMedia }));
      setRevisions((current) => (cursor ? [...current, ...entries] : entries));
      setAuthors((current) => ({ ...(current ?? {}), ...(result.authors ?? {}) }));
      setMentions((current) => ({ ...current, ...result.mentions }));
      setSubjects((current) => [
        ...new Map([...current, ...result.subjects].map((subject) => [subject.id, subject])).values(),
      ]);
      setReviewVotes((current) => ({ ...current, ...result.reviewVotes }));
      setNext(result.next);
      setNow(result.now);
      setLoaded(true);
      setAvailable(true);
      setFailedCursor(undefined);
    } catch {
      if (request.current === current) {
        setAvailable(false);
        setLoaded(true);
        setFailedCursor(cursor);
      }
    } finally {
      if (request.current === current) {
        current.pending = false;
        setLoading(false);
      }
    }
  }

  function toggle() {
    const reveal = !open;
    setOpen(reveal);
    if (reveal && !loaded && !loading) void load();
  }

  return (
    <div className="mt-3">
      <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={regionId} onClick={toggle}>
        {open ? m.thread_history_hide() : m.thread_history_show()}
      </Button>
      {open ? (
        <section
          id={regionId}
          role="region"
          aria-label={m.thread_history_heading()}
          className="mt-3 space-y-4 rounded-xl border border-border/70 bg-card p-4 sm:p-5"
        >
          <h3 className="text-base font-semibold">{m.thread_history_heading()}</h3>
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
      ) : null}
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
    <li className="space-y-3 border-t border-border/60 pt-4 first:border-0 first:pt-0">
      <h4 className="font-semibold">
        <a
          href={exactRevisionHref({ postId: revision.id, revisionId: revision.revisionId }, locale)}
          className="inline-flex min-h-11 items-center underline underline-offset-4"
        >
          {m.thread_history_version({ number: String(number) })}
        </a>
      </h4>
      <Byline author={authors?.[revision.authorId]} createdAt={revision.createdAt} now={now} showAuthor />
      <RevisionProvenance revision={revision} subjects={subjects} currentVote={currentVote ?? null} review={review} />
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
    </li>
  );
}
