import { createContext, useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { Byline } from '../../threads/byline';
import { threadLocation } from '../../threads/thread-href';
import { reviewThreadHref } from '../../threads/review-policy';
import type { CommunityKind, CommunityRegion, SubjectCommunity } from './subject-community';
import { linkClass, linkColor } from './shared';

export const SubjectCommunityContext = createContext<SubjectCommunity | undefined>(undefined);
const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
const actionClass = `${linkClass} ${linkColor} text-sm font-medium hover:underline`;

/** Shared by the real overview, full views and Patterns. Every state keeps a stable heading and region. */
export function SubjectCommunityRegion({
  id,
  kind,
  region,
  authors,
  now,
  subject,
  locale,
  href,
  paged = false,
}: {
  id: string;
  kind: CommunityKind;
  region: CommunityRegion;
  authors: SubjectCommunity['authors'];
  now: string;
  subject: { id: string; label: string };
  locale: string;
  href: string;
  paged?: boolean;
}) {
  const options = { locale: locale as never };
  const review = kind === 'review';
  const title = review ? m.subject_reviews({}, options) : m.subject_discussion({}, options);
  const threads = region.state === 'ready' ? region.threads : [];
  const empty = region.state === 'ready' && threads.length === 0;
  const next = region.state === 'ready' ? region.next : null;
  const state = empty ? (next ? 'continuation' : 'empty') : region.state === 'ready' ? 'populated' : region.state;

  return (
    <section
      data-slot={review ? 'review-list' : 'thread-list'}
      data-state={state}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={`${id}-title`} className={headingClass}>
          {title}
        </h2>
        {!paged && region.state === 'ready' && (
          <a data-slot="see-all" className={actionClass} href={href}>
            {m.home_see_all({}, options)}
          </a>
        )}
      </div>
      {region.state === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.subject_community_loading({}, options)}
        </p>
      )}
      {region.state === 'closed' && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.platform_closed_message({}, options)}
        </p>
      )}
      {region.state === 'unavailable' && (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {m.subject_section_failed({}, options)}
          </p>
          <a data-slot="retry" className={actionClass} href={paged ? href : '?'}>
            {m.subject_section_retry({}, options)}
          </a>
        </div>
      )}
      {empty && (
        <div className="space-y-2 rounded-lg border p-5 text-sm text-muted-foreground">
          <p>
            {next
              ? m.subject_community_continue({}, options)
              : review
                ? m.subject_reviews_empty({}, options)
                : m.subject_threads_empty({}, options)}
          </p>
          {!next && <p>{m.subject_community_board_unavailable({}, options)}</p>}
        </div>
      )}
      {threads.length > 0 && (
        <ul className="divide-y rounded-lg border px-4 sm:px-5">
          {threads.map((thread) => (
            <li key={thread.id} className="min-w-0 space-y-3 py-5">
              <h3 className="font-medium break-words">
                <a className={`${linkClass} hover:text-primary hover:underline`} href={threadLocation(locale, thread)}>
                  {thread.title || m.threads_untitled({}, options)}
                </a>
              </h3>
              <Byline author={authors?.[thread.authorId]} createdAt={thread.createdAt} now={now} showAuthor size="sm" />
              {thread.summary && (
                <p className="line-clamp-3 text-sm break-words text-muted-foreground">{thread.summary}</p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <a
                  className={actionClass}
                  href={`/${encodeURIComponent(locale)}/boards/${encodeURIComponent(thread.boardId)}`}
                >
                  {m.subject_community_board({}, options)}
                </a>
                <a
                  data-slot="create-thread"
                  className={actionClass}
                  href={reviewThreadHref(locale, thread.boardId, subject.id, subject.label)}
                >
                  {review ? m.subject_community_review({}, options) : m.subject_community_discuss({}, options)}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <a
          data-slot="community-next"
          className={actionClass}
          href={paged ? `${href}?cursor=${encodeURIComponent(next)}` : href}
        >
          {m.subject_community_more({}, options)}
        </a>
      )}
    </section>
  );
}

export function useSubjectCommunity(kind: CommunityKind) {
  const data = useContext(SubjectCommunityContext);
  const region = data?.regions[kind];
  return data && region ? { region, authors: data.authors, now: data.now } : undefined;
}
