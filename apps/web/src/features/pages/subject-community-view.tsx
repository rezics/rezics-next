import { createContext, useContext } from 'react';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { m } from '../../paraglide/messages.js';
import { Byline } from '../../threads/byline';
import { threadLocation } from '../../threads/thread-href';
import type { ThreadReactionsProps } from '../../threads/thread-reactions';
import type { CommunityKind, CommunityRegion, SubjectCommunity } from './subject-community';
import { SubjectCommunityPreview } from './subject-community-preview';
import { linkClass, linkColor } from './shared';
import { StreamHeading } from './view-heading';

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
  node,
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
  node?: string;
  preparedTransport?: ThreadReactionsProps['preparedTransport'];
}) {
  const options = { locale: locale as never };
  const community = useContext(SubjectCommunityContext);
  const review = kind === 'review';
  const title = review ? m.subject_reviews({}, options) : m.subject_discussion({}, options);
  const threads = region.state === 'ready' ? region.threads : [];
  const empty = region.state === 'ready' && threads.length === 0;
  const next = region.state === 'ready' ? region.next : null;
  const state = empty ? (next ? 'continuation' : 'empty') : region.state === 'ready' ? 'populated' : region.state;
  const [path, search = ''] = href.split('?');
  const retryHref = paged ? href : `?${search}`;

  const nextHref = (() => {
    if (!paged || !next) return href;
    const query = new URLSearchParams(search);
    query.set('cursor', next);
    if (node) query.set('node', node);
    return `${path}?${query}`;
  })();

  return (
    <section
      data-slot={review ? 'review-list' : 'thread-list'}
      data-state={state}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <StreamHeading node={paged ? id : undefined} id={`${id}-title`} className={headingClass}>
          {title}
        </StreamHeading>
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
          <a data-slot="retry" className={actionClass} href={retryHref}>
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
          {!next ? (
            <p>{m.subject_community_board_unavailable({}, options)}</p>
          ) : null}
        </div>
      )}
      {threads.length > 0 && (
        <ul className="min-w-0">
          {threads.map((thread) => {
            const threadHref = threadLocation(locale, thread);
            const reader = community?.reader ?? null;
            return (
              <li key={thread.id} className="min-w-0">
                <ContentItemFrame as="div" className="min-w-0 space-y-3 py-3 sm:py-4">
                  <ContentItemHeading
                    level={3}
                    className="min-w-0 text-[17px] leading-snug font-semibold [overflow-wrap:anywhere] sm:text-lg md:text-xl"
                  >
                    <ContentItemTitleLink
                      className={`${linkClass} block min-h-11 content-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                      href={threadHref}
                    >
                      {thread.title || m.threads_untitled({}, options)}
                    </ContentItemTitleLink>
                  </ContentItemHeading>
                  <ListRowControl
                    data-content-item-slot="metadata"
                    className="min-w-0 [overflow-wrap:anywhere] [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
                  >
                    <Byline
                      author={authors?.[thread.authorId]}
                      createdAt={thread.createdAt}
                      now={now}
                      showAuthor
                      size="sm"
                    />
                  </ListRowControl>
                  {thread.summary && (
                    <p
                      data-content-item-slot="preview"
                      className="text-sm break-words text-muted-foreground [overflow-wrap:anywhere]"
                    >
                      {thread.summary}
                    </p>
                  )}
                  <SubjectCommunityPreview
                    kind={kind}
                    thread={thread}
                    subject={subject}
                    locale={locale}
                    reader={reader}
                  />
                  <ListRowControl
                    data-content-item-slot="actions"
                    className="flex flex-wrap gap-x-4 gap-y-2 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a]:rounded-sm [&_a]:px-2 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
                  >
                    <a
                      className={actionClass}
                      href={`/${encodeURIComponent(locale)}/boards/${encodeURIComponent(thread.boardId)}`}
                    >
                      {m.subject_community_board({}, options)}
                    </a>
                  </ListRowControl>
                </ContentItemFrame>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <a data-slot="community-next" className={actionClass} href={nextHref}>
          {m.subject_community_more({}, options)}
        </a>
      )}
    </section>
  );
}

export function useSubjectCommunity(kind: CommunityKind, node?: string) {
  const data = useContext(SubjectCommunityContext);
  const region = node && data?.nodes ? data.nodes[node] : data?.regions[kind];
  return data && region
    ? {
        region,
        authors: data.authors,
        now: data.now,
        reader: data.reader ?? null,
        contextId: data.contextId ?? null,
        sourceKey: data.sourceKey ?? data.now,
      }
    : undefined;
}
