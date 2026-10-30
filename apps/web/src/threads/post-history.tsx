import { DocumentBody } from '@rezics/ui/document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { useId, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Byline } from './byline';
import { readPostHistory } from './reads';

type HistoryPage = Extract<Awaited<ReturnType<typeof readPostHistory>>, { available: true }>;
type Revision = HistoryPage['revisions'][number];

/** A bounded, cursor-paged view of the immutable revisions returned by the native post history API. */
export function PostHistory({ postId }: { postId: string }) {
  const regionId = `post-history-${useId().replaceAll(':', '')}`;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [authors, setAuthors] = useState<HistoryPage['authors']>({});
  const [mentions, setMentions] = useState<HistoryPage['mentions']>({});
  const [next, setNext] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());

  async function load(cursor?: string) {
    if (loading || !available) return;
    setLoading(true);
    try {
      const result = await readPostHistory({ data: { postId, ...(cursor ? { cursor } : {}) } });
      if (!result.available) {
        setAvailable(false);
        setLoaded(true);
        return;
      }
      setRevisions((current) => (cursor ? [...current, ...result.revisions] : result.revisions));
      setAuthors((current) => ({ ...(current ?? {}), ...(result.authors ?? {}) }));
      setMentions((current) => ({ ...current, ...result.mentions }));
      setNext(result.next);
      setNow(result.now);
      setLoaded(true);
    } catch {
      setAvailable(false);
      setLoaded(true);
    } finally {
      setLoading(false);
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
            <p role="status" className="text-sm text-muted-foreground">
              {m.thread_history_unavailable()}
            </p>
          ) : null}
          {available && loaded && revisions.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.thread_history_unavailable()}
            </p>
          ) : null}
          {available && revisions.length > 0 ? (
            <ol className="space-y-5" aria-label={m.thread_history_heading()}>
              {revisions.map((revision, index) => (
                <RevisionEntry
                  key={revision.id}
                  revision={revision}
                  number={index + 1}
                  authors={authors}
                  mentions={mentions}
                  now={now}
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

function RevisionEntry({
  revision,
  number,
  authors,
  mentions,
  now,
}: {
  revision: Revision;
  number: number;
  authors: HistoryPage['authors'];
  mentions: HistoryPage['mentions'];
  now: string;
}) {
  return (
    <li className="space-y-3 border-t border-border/60 pt-4 first:border-0 first:pt-0">
      <h4 className="font-semibold">{m.thread_history_version({ number: String(number) })}</h4>
      <Byline author={authors?.[revision.authorId]} createdAt={revision.createdAt} now={now} showAuthor />
      <p className="text-sm text-muted-foreground">
        <span className="font-medium">{m.thread_history_licence()}:</span> {revision.licence}
      </p>
      {revision.body ? <DocumentBody document={revision.body} mentions={mentions} locale={getLocale()} /> : null}
    </li>
  );
}
