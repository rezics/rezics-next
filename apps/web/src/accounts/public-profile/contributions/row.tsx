import { useContext, useEffect, useRef, useState } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { Cover, ReadingDisclosureScope } from '@rezics/ui/cover';
import { DocumentValue, readableDocument } from '../../../features/pages/values';
import type { OverviewValue } from '../../../features/pages/overview';
import { isRecord } from '../../../features/pages/shared';
import { feedCardKindLabel, feedCardLinkClassName } from '../../../features/feed/card-presentation';
import { PublicReplyParent, PublicReviewDetails, feedCardTime } from '../../../features/feed/card-attribution';
import { feedConversationActivity, formatConversationReplyCount } from '../../../threads/activity';
import { threadLocation } from '../../../threads/thread-href';
import { exactRevisionHref } from '../../../threads/exact-revision-href';
import { accountHref } from '../../../subject/subject-href';
import { coverSrc } from '../../../media/cover-src';
import { m } from '../../../paraglide/messages.js';
import { locales, type Locale } from '../../../paraglide/runtime.js';
import { rememberContribution, restoreContribution, restoreContributionRecovery } from './navigation';

export type ContributionKind = 'reply' | 'review' | 'discussion';

const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const publicItem = (item: Record<string, unknown>) =>
  (item.availability === undefined || item.availability === 'available') &&
  (item.visibility === undefined || item.visibility === 'published' || item.visibility === 'protected');

function threadAddress(id: string, title: unknown): { id: string; title?: string | null } {
  return typeof title === 'string' || title === null ? { id, title } : { id };
}

/** Native IDs select destinations; the title supplies only the optional canonical slug. */
export function contributionDestination(item: Record<string, unknown>, kind: ContributionKind, locale: string) {
  if (!key(item.id)) return undefined;
  if (kind !== 'reply') return threadLocation(locale, threadAddress(item.id, item.title));
  if (!key(item.threadId)) return undefined;
  const thread = isRecord(item.thread) && item.thread.id === item.threadId ? item.thread : undefined;
  return threadLocation(locale, threadAddress(item.threadId, thread?.title), undefined, item.id);
}

/** Content owns the missing author-page card context; no recursive thread/Subject fallback is permitted. */
export const AUTHOR_CONTRIBUTION_CONTEXT_OWNER = 'Content: author_posts.list / author_threads.list';

function ContextUnavailable({ locale }: { locale: Locale }) {
  return (
    <p role="status" data-profile-context="unavailable" className="text-sm text-muted-foreground">
      {m.profile_contribution_context_unavailable({}, { locale })}
    </p>
  );
}

export function ContributionRow(props: {
  item: Record<string, unknown>;
  kind: ContributionKind;
  value: OverviewValue;
}) {
  const [visit, setVisit] = useState({ item: props.item, locale: props.value.locale, generation: 0 });
  if (visit.item !== props.item || visit.locale !== props.value.locale) {
    setVisit({ item: props.item, locale: props.value.locale, generation: visit.generation + 1 });
    return null;
  }
  return <ContributionVisit key={visit.generation} {...props} />;
}

/** Keep the public list usable when the clicked contribution or its exact destination has changed. */
export function ContributionReturnRecovery({
  rows,
  locale,
}: {
  rows: readonly Record<string, unknown>[];
  locale: string;
}) {
  const notice = useRef<HTMLParagraphElement>(null);
  const activeLocale = locales.find((candidate) => candidate === locale) ?? 'en';
  useEffect(() => {
    const restore = () => {
      if (notice.current) restoreContributionRecovery(notice.current);
    };
    restore();
    window.addEventListener('pageshow', restore);
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('popstate', restore);
    };
  }, [rows]);
  return (
    <p
      ref={notice}
      hidden
      tabIndex={-1}
      role="status"
      data-slot="contribution-return-recovery"
      className="text-sm text-muted-foreground"
    >
      {m.profile_contribution_return_recovered({}, { locale: activeLocale })}
    </p>
  );
}

function ContributionVisit({
  item,
  kind,
  value,
}: {
  item: Record<string, unknown>;
  kind: ContributionKind;
  value: OverviewValue;
}) {
  const root = useRef<HTMLDivElement>(null);
  const disclosure = useContext(ReadingDisclosureScope);
  const locale = locales.find((candidate) => candidate === value.locale) ?? 'en';
  const options = { locale };
  const id = key(item.id) ? item.id : '';
  useEffect(() => {
    if (!root.current || !id) return;
    const restore = () => {
      const row = root.current?.closest('li');
      if (row) restoreContribution(row, id);
    };
    restore();
    window.addEventListener('pageshow', restore);
    window.addEventListener('popstate', restore);
    return () => {
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('popstate', restore);
    };
  }, [id]);
  // Refuse replacement/hidden rows even if a stale composition contains their old authored fields.
  if (!publicItem(item) || (kind !== 'reply' && item.kind !== kind)) return null;
  const first =
    kind === 'reply'
      ? item
      : isRecord(item.firstPost) && (item.firstPost.threadId === undefined || item.firstPost.threadId === item.id)
        ? item.firstPost
        : undefined;
  const readable = first && publicItem(first) ? first : undefined;
  const document = readableDocument(readable?.body);
  const thread = kind === 'reply' && isRecord(item.thread) && item.thread.id === item.threadId ? item.thread : item;
  const title = typeof thread.title === 'string' && thread.title ? thread.title : m.threads_untitled({}, options);
  const href = contributionDestination(item, kind, locale);
  const author = item.authorId === value.profile?.id ? value.profile : undefined;
  const authorName =
    author?.displayName || (author?.handle ? `@${author.handle}` : m.thread_author_unknown({}, options));
  const created = feedCardTime(typeof readable?.createdAt === 'string' ? readable.createdAt : null, locale);
  const review = kind === 'review' && isRecord(item.reviewContext) ? item.reviewContext : undefined;
  const suppliedParent = kind === 'reply' && isRecord(item.parentContext) ? item.parentContext : undefined;
  const parent =
    suppliedParent?.kind === 'reply' &&
    isRecord(suppliedParent.parent) &&
    (suppliedParent.parent.state === 'withheld' || (key(item.parentId) && suppliedParent.parent.id === item.parentId))
      ? suppliedParent
      : undefined;
  const activity = feedConversationActivity(item);
  const exact =
    readable && key(readable.id) && key(readable.revisionId)
      ? exactRevisionHref({ postId: readable.id, revisionId: readable.revisionId }, locale)
      : undefined;
  return (
    <ContentItem
      onClickCapture={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest('a[href]');
        const destination = link?.getAttribute('href');
        if (id && destination) rememberContribution(id, destination);
      }}
      title={title}
      {...(href ? { href } : {})}
      headingLevel={3}
      context={<span data-profile-contribution-kind={kind}>{feedCardKindLabel(kind, locale)}</span>}
      metadata={
        <div className="min-w-0 space-y-1" data-profile-contribution-id={id}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span>{m.home_card_by({}, options)}</span>
            {author?.handle ? (
              <a href={accountHref(locale, author.handle)} className={feedCardLinkClassName}>
                <bdi>{authorName}</bdi>
              </a>
            ) : (
              <bdi>{authorName}</bdi>
            )}
            {created ? <time dateTime={created.value}>{created.text}</time> : null}
          </span>
          {kind === 'review' ? (
            <>
              {review ? (
                <PublicReviewDetails key={disclosure} context={review} locale={locale} />
              ) : (
                <ContextUnavailable locale={locale} />
              )}
              {review && (!isRecord(review.target) || review.target.state !== 'available') ? (
                <ContextUnavailable locale={locale} />
              ) : null}
              {review?.citation && isRecord(review.citation) && review.citation.state === 'available' ? (
                <p className="text-sm text-muted-foreground">
                  {m.profile_contribution_historical_citation({}, options)}
                </p>
              ) : null}
            </>
          ) : null}
          {activity.state === 'current' ? (
            <p data-slot="conversation-activity" className="text-sm text-muted-foreground">
              {m.board_thread_replies({ count: formatConversationReplyCount(activity.count, locale) }, options)}
              {activity.lastActivityAt ? (
                <>
                  {' '}
                  ·{' '}
                  <time dateTime={activity.lastActivityAt}>{feedCardTime(activity.lastActivityAt, locale)?.text}</time>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      }
      visual={
        author?.avatar ? (
          <div className="w-12 overflow-hidden rounded-full">
            <Cover
              subject={{ id: author.id, title: authorName, types: [] }}
              cover={author.avatar}
              size="fill"
              ratio="1:1"
              src={coverSrc}
              decorative
            />
          </div>
        ) : undefined
      }
      preview={
        <div ref={root} className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
          {kind === 'reply' ? (
            <section data-profile-conversation>
              <span>{m.home_card_kind_discussion({}, options)}: </span>
              {key(item.threadId) ? (
                <a
                  href={threadLocation(locale, threadAddress(item.threadId, thread.title))}
                  className={feedCardLinkClassName}
                >
                  <bdi>{title}</bdi>
                </a>
              ) : (
                <bdi>{title}</bdi>
              )}
            </section>
          ) : null}
          {document ? (
            <div className="max-h-40 overflow-hidden" data-slot="excerpt">
              <DocumentValue document={document} lang={undefined} locale={locale} labels={value.labels} />
            </div>
          ) : null}
          {kind === 'reply' && key(item.threadId) ? (
            parent ? (
              <PublicReplyParent
                key={disclosure}
                context={parent}
                locale={locale}
                thread={threadAddress(item.threadId, thread.title)}
              />
            ) : item.parentId !== null ? (
              <ContextUnavailable locale={locale} />
            ) : null
          ) : null}
          {exact ? (
            <a href={exact} className={feedCardLinkClassName}>
              {m.exact_revision_heading({}, options)}
            </a>
          ) : null}
        </div>
      }
    />
  );
}
