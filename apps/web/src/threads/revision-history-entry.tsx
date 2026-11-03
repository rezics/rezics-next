import { DocumentBody } from '../document-body';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Byline, fullDateTime } from './byline';
import { NativeDocumentImage } from './document-media';
import { exactRevisionHref } from './exact-revision-href';
import { revisionDocumentImage } from './exact-revision-media';
import { RevisionProvenance } from './revision-provenance-view';
import { CopyDiscussionLink } from './copy-discussion-link';
import type { HistoryPage } from './post-history-lifetime';
import type { PageAuthor } from '../identity/read';
import {
  revisionHistoryAnchor,
  type HistoryRevision as Revision,
  type RevisionSummary,
} from './revision-history-summary';

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
  focusBoundary = false,
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
  focusBoundary?: boolean;
}) {
  const locale = getLocale();
  const headingId = `revision-entry-${useId().replaceAll(':', '')}`;
  return (
    <li className="min-w-0 border-t border-border/60 pt-4 first:border-0 first:pt-0">
      <ContentItemFrame
        as="article"
        data-slot="content-item-frame"
        aria-labelledby={headingId}
        className="min-w-0 space-y-3 rounded-xl [overflow-wrap:anywhere]"
      >
        <ContentItemHeading
          level={4}
          id={headingId}
          tabIndex={focusBoundary ? -1 : undefined}
          data-history-focus-boundary={focusBoundary ? '' : undefined}
          className="font-semibold"
        >
          <a
            href={exactRevisionHref({ postId: revision.id, revisionId: revision.revisionId }, locale)}
            className="inline-flex min-h-11 max-w-full items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.thread_history_version({ number: String(number) })}
          </a>
        </ContentItemHeading>
        <Byline
          author={authors?.[revision.authorId]}
          createdAt={revision.revisedAt ?? revision.createdAt}
          now={now}
          showAuthor
          className="[&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:whitespace-normal"
        />
        <RevisionInspector
          revision={revision}
          mentions={mentions}
          documentMedia={documentMedia}
          subjects={subjects}
          currentVote={currentVote}
          review={review}
        />
      </ContentItemFrame>
    </li>
  );
}

/** The original body/media/provenance composition, mounted only for the selected returned row. */
function RevisionInspector({
  revision,
  mentions,
  documentMedia,
  subjects,
  currentVote,
  review,
}: {
  revision: Revision;
  mentions: HistoryPage['mentions'];
  documentMedia: HistoryPage['documentMedia'];
  subjects: HistoryPage['subjects'];
  currentVote: HistoryPage['reviewVotes'][string] | undefined;
  review: boolean;
}) {
  const locale = getLocale();
  return (
    <>
      {revision.availability === 'available' && revision.body ? (
        <DocumentBody
          className="mx-0! w-full overflow-x-auto [overflow-wrap:anywhere]"
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
    </>
  );
}

const historyAction =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 text-start text-sm whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** A compact row keeps its immutable address even while its full inspector is unmounted. */
export function RevisionSummaryRow({
  summary,
  entry,
  expanded,
  active,
  triggerId,
  inspectorId,
  mentions,
  subjects,
  currentVote,
  inspectorAuthor,
  now,
  review,
  focusBoundary,
  onInspect,
  onCollapse,
  onNavigate,
}: {
  summary: RevisionSummary;
  entry: { revision: Revision; documentMedia: HistoryPage['documentMedia'] };
  expanded: boolean;
  active: boolean;
  triggerId: string;
  inspectorId: string;
  mentions: HistoryPage['mentions'];
  subjects: HistoryPage['subjects'];
  currentVote: HistoryPage['reviewVotes'][string] | undefined;
  inspectorAuthor: PageAuthor | undefined;
  now: string;
  review: boolean;
  focusBoundary: boolean;
  onInspect: () => void;
  onCollapse: () => void;
  onNavigate: () => void;
}) {
  const locale = getLocale();
  const headingId = `${triggerId}-heading`;
  const availabilityId = `${triggerId}-availability`;
  const ordinal = new Intl.NumberFormat(locale).format(summary.index + 1);
  const href = exactRevisionHref({ postId: summary.postId, revisionId: summary.revisionId }, locale);
  const bodyAvailable = summary.availability === 'available';
  const timestamp = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(summary.recordedAt));

  return (
    <li
      id={revisionHistoryAnchor(summary.postId, summary.revisionId)}
      className="min-w-0 scroll-mt-6 border-t border-border/60 py-3 first:border-0"
      data-history-summary=""
      data-history-selected={expanded ? '' : undefined}
    >
      <ContentItemFrame
        as="article"
        data-slot="content-item-frame"
        aria-labelledby={headingId}
        className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      >
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 flex-1 space-y-1">
            <ContentItemHeading
              level={4}
              id={headingId}
              tabIndex={focusBoundary ? -1 : undefined}
              data-history-focus-boundary={focusBoundary ? '' : undefined}
              className="font-semibold"
            >
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={m.revision_history_new_tab()}
                className={historyAction}
              >
                {m.thread_history_version({ number: ordinal })}
              </a>
            </ContentItemHeading>
            <p className="text-sm text-muted-foreground">
              {summary.authorHref ? (
                <a href={summary.authorHref} className={historyAction}>
                  {summary.author}
                </a>
              ) : (
                <span>{summary.author}</span>
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              <span>{summary.revised ? m.revision_history_revised() : m.revision_history_created()} </span>
              <time dateTime={summary.recordedAt} title={fullDateTime(summary.recordedAt, locale)}>
                {timestamp} UTC
              </time>
            </p>
          </div>
          <Button
            id={triggerId}
            type="button"
            variant={expanded ? 'secondary' : 'outline'}
            aria-expanded={expanded}
            aria-controls={expanded ? inspectorId : undefined}
            aria-describedby={availabilityId}
            data-history-inspect={summary.index}
            onClick={expanded ? onCollapse : onInspect}
            className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere]"
          >
            {expanded
              ? m.revision_history_collapse({ number: ordinal })
              : m.revision_history_inspect({ number: ordinal })}
          </Button>
        </header>
        <ul id={availabilityId} className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <li>
            {bodyAvailable
              ? m.revision_history_body_available()
              : summary.availability === 'erased'
                ? m.revision_history_body_erased()
                : m.revision_history_body_unavailable()}
          </li>
          {summary.licence ? (
            <li>
              {m.thread_history_licence()}: {summary.licence}
            </li>
          ) : null}
          {summary.subjectCount > 0 ? (
            <li>
              {m.revision_history_subjects({ count: new Intl.NumberFormat(locale).format(summary.subjectCount) })}
            </li>
          ) : null}
          {summary.scored ? (
            <li>{m.revision_history_rating_recorded()}</li>
          ) : review ? (
            <li>{m.thread_provenance_unscored()}</li>
          ) : null}
        </ul>
        {expanded && active ? (
          <section
            id={inspectorId}
            aria-label={m.revision_history_inspector({ number: ordinal })}
            data-history-inspector=""
            className="min-w-0 space-y-4 rounded-xl border border-border bg-background p-3 sm:p-5"
            onKeyDown={(event) => {
              // Nested media, spoiler and provenance controls retain their own Escape behaviour.
              if (event.key === 'Escape' && !event.defaultPrevented && event.target === event.currentTarget) {
                event.preventDefault();
                onCollapse();
              }
            }}
            tabIndex={-1}
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{m.revision_history_inspector({ number: ordinal })}</p>
              <Button
                type="button"
                variant="ghost"
                onClick={onCollapse}
                className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere]"
              >
                {m.revision_history_close_inspector()}
              </Button>
            </div>
            {!bodyAvailable ? (
              <p role="note" className="text-sm text-muted-foreground">
                {summary.availability === 'erased'
                  ? m.revision_history_erased_explanation()
                  : m.revision_history_unavailable_explanation()}
              </p>
            ) : null}
            <Byline
              author={inspectorAuthor}
              createdAt={summary.recordedAt}
              now={now}
              className="[&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:whitespace-normal"
            />
            <RevisionInspector
              revision={entry.revision}
              mentions={mentions}
              documentMedia={entry.documentMedia}
              subjects={subjects}
              currentVote={currentVote}
              review={review}
            />
            <footer className="space-y-2 border-t border-border/60 pt-3">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                <a href={href} target="_blank" rel="noopener noreferrer" className={historyAction}>
                  {m.revision_history_open_exact()}
                </a>
                <CopyDiscussionLink href={href} copyOnly />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onNavigate}
                  className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere]"
                >
                  {m.revision_history_back_to_navigator()}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{m.revision_history_return_help()}</p>
            </footer>
          </section>
        ) : null}
      </ContentItemFrame>
    </li>
  );
}
