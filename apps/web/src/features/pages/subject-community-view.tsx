import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { m } from '../../paraglide/messages.js';
import { Byline } from '../../threads/byline';
import { threadLocation } from '../../threads/thread-href';
import type { ThreadReactionsProps } from '../../threads/thread-reactions';
import type { ThreadWatchProps } from '../../threads/thread-watch';
import type { CommunityKind, CommunityRegion, SubjectCommunity } from './subject-community';
import {
  communityBoardHref,
  communityRegionAnchor,
  communityRegionLinks,
  communityRegionReturnTo,
} from './subject-community-navigation';
import { SubjectCommunityPreview } from './subject-community-preview';
import { useSubjectCommunityReading } from './subject-community-lifetime';
import { linkClass, linkColor } from './shared';
import { StreamHeading } from './view-heading';
import { CommunityCardPresentation } from './subject-community-card-view';
import { CommunityNativeByline, CommunityNativePresentation } from './subject-community-card-view';
import type { VerificationConfig } from '../../report/turnstile';
import { SubjectCommunityInteractions } from './subject-community-interactions';

export const SubjectCommunityContext = createContext<SubjectCommunity | undefined>(undefined);
export const SubjectCommunityVerificationContext = createContext<VerificationConfig | undefined>(undefined);
export const SubjectCommunityRefreshContext = createContext<(() => Promise<void>) | undefined>(undefined);
const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
const actionClass = `${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm text-sm font-medium whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

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
  currentHref,
  preparedTransport,
  preparedWatch,
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
  currentHref?: string;
  preparedTransport?: ThreadReactionsProps['preparedTransport'];
  preparedWatch?: ThreadWatchProps['native'];
}) {
  const options = { locale: locale as never };
  const community = useContext(SubjectCommunityContext);
  const verification = useContext(SubjectCommunityVerificationContext);
  const refreshAdvice = useContext(SubjectCommunityRefreshContext);
  const reading = useSubjectCommunityReading({
    source: community?.sourceKey ?? region,
    reader: community?.reader ?? null,
    descriptor: JSON.stringify([
      id,
      node,
      subject.id,
      kind,
      locale,
      href,
      paged,
      community?.contextId,
      region.state,
      region.request,
      region.state === 'ready' ? region.context : null,
      region.state === 'ready' ? region.reactionsAsOf : null,
      region.state === 'ready'
        ? region.threads.map(({ id, rowKey, position, postRevisionId, card, nativeCard, actions }) => [
            id,
            rowKey,
            position,
            postRevisionId,
            card,
            nativeCard,
            actions,
          ])
        : null,
    ]),
  });
  if (!reading.available) region = { state: 'unavailable' };
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    // A replacing page removes its focused card. Keep keyboard recovery at this region's stable heading.
    if (focused.current instanceof Element && !focused.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [reading.key, reading.available]);
  const review = kind === 'review';
  const title = review ? m.subject_reviews({}, options) : m.subject_discussion({}, options);
  const threads = region.state === 'ready' ? region.threads : [];
  const empty = region.state === 'ready' && threads.length === 0;
  const next = region.state === 'ready' ? region.next : null;
  const reactionsAsOf = region.state === 'ready' ? region.reactionsAsOf : null;
  const currentContext = region.state === 'ready' ? region.context : undefined;
  const currentSubject = currentContext?.subjectLabel ?? currentContext?.subjectId;
  const currentPlace = currentContext
    ? currentContext.place.kind === 'global'
      ? m.prq_global({}, options)
      : `${m.space_realm_heading({}, options)} · ${currentContext.place.title}`
    : undefined;
  const returnTo = currentHref
    ? communityRegionReturnTo({
        currentHref,
        locale,
        id,
        subjectId: subject.id,
        kind,
        paged,
        ...(node ? { node } : {}),
        region,
      })
    : undefined;
  const state = empty ? (next ? 'continuation' : 'empty') : region.state === 'ready' ? 'populated' : region.state;
  const links = communityRegionLinks({ href, paged, ...(node ? { node } : {}), region });
  const retryHref = links.retry;
  const nextHref = links.next;
  const occurrences = new Map<string, number>();
  const rows = threads.map((thread) => {
    const occurrence = occurrences.get(thread.id) ?? 0;
    occurrences.set(thread.id, occurrence + 1);
    return { thread, key: thread.rowKey ?? `${thread.id}:${occurrence}` };
  });
  return (
    <section
      id={communityRegionAnchor(id)}
      data-slot={review ? 'review-list' : 'thread-list'}
      data-state={state}
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-4"
      onClickCapture={(event) => {
        // A queued click must not navigate or reveal retired card content.
        if (reading.available && !reading.isCurrent()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <StreamHeading
          ref={heading}
          tabIndex={-1}
          node={paged ? id : undefined}
          id={`${id}-title`}
          className={headingClass}
        >
          {title}
        </StreamHeading>
        {!paged && region.state === 'ready' && (
          <a data-slot="see-all" className={actionClass} href={href}>
            {m.home_see_all({}, options)}
          </a>
        )}
      </div>
      {currentContext && currentSubject && currentPlace && (
        <p
          data-slot="community-current-context"
          data-context-subject-id={currentContext.subjectId}
          data-context-place-kind={currentContext.place.kind}
          data-context-place-id={currentContext.place.id}
          className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
        >
          {m.subject_community_context_current({ subject: currentSubject, place: currentPlace }, options)}
        </p>
      )}
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
      {region.state === 'expired' && (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {m.subject_community_frontier_expired({}, options)}
          </p>
          <a data-slot="community-restart" className={actionClass} href={links.restart}>
            {m.subject_relation_restart({}, options)}
          </a>
        </div>
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
        </div>
      )}
      {threads.length > 0 && (
        <ul key={reading.key} className="min-w-0">
          {rows.map(({ thread, key }) => {
            const threadHref = threadLocation(locale, thread);
            const reader = community?.reader ?? null;
            return (
              <li key={key} data-row-key={key} className="min-w-0">
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
                    {thread.nativeCard ? (
                      <CommunityNativeByline
                        card={thread.nativeCard}
                        createdAt={thread.createdAt}
                        now={now}
                        locale={locale}
                      />
                    ) : (
                      <Byline
                        author={authors?.[thread.authorId]}
                        createdAt={thread.createdAt}
                        now={now}
                        showAuthor
                        size="sm"
                      />
                    )}
                  </ListRowControl>
                  {thread.nativeCard ? (
                    <CommunityNativePresentation
                      card={thread.nativeCard}
                      summary={thread.summary}
                      locale={locale}
                      now={now}
                      retryHref={retryHref}
                    />
                  ) : (
                    thread.summary && (
                      <p
                        data-content-item-slot="preview"
                        className="text-sm break-words text-muted-foreground [overflow-wrap:anywhere]"
                      >
                        {thread.summary}
                      </p>
                    )
                  )}
                  {thread.card ? <CommunityCardPresentation card={thread.card} locale={locale} now={now} /> : null}
                  <SubjectCommunityPreview
                    kind={kind}
                    thread={thread}
                    subject={subject}
                    locale={locale}
                    reader={reader}
                    reactionsAsOf={reactionsAsOf}
                  />
                  <SubjectCommunityInteractions
                    thread={thread}
                    subject={subject}
                    locale={locale}
                    href={threadHref}
                    contextId={community?.contextId ?? null}
                    reader={reader}
                    source={community?.sourceKey ?? community?.now ?? ''}
                    reactionsAsOf={reactionsAsOf}
                    {...(refreshAdvice ? { refreshAdvice } : {})}
                    {...(verification ? { verification } : {})}
                    {...(preparedTransport ? { preparedTransport } : {})}
                    {...(preparedWatch ? { preparedWatch } : {})}
                  />
                  <ListRowControl
                    data-content-item-slot="actions"
                    className="flex flex-wrap gap-x-4 gap-y-2 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a]:rounded-sm [&_a]:px-2 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
                  >
                    <a className={actionClass} href={communityBoardHref(locale, thread.boardId, returnTo)}>
                      {m.subject_community_board({}, options)}
                    </a>
                  </ListRowControl>
                </ContentItemFrame>
              </li>
            );
          })}
        </ul>
      )}
      {region.state === 'ready' && (!empty || !next) && (
        <div
          data-slot="community-entry-unavailable"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground"
        >
          <p role="status">{m.subject_community_board_unavailable({}, options)}</p>
          <a className={actionClass} href={retryHref}>
            {m.subject_section_retry({}, options)}
          </a>
        </div>
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
