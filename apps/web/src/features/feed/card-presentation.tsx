import { useState, type ReactNode } from 'react';
import {
  BookOpenIcon,
  BoxesIcon,
  CircleUserRoundIcon,
  FileTextIcon,
  LibraryBigIcon,
  MessageCircleIcon,
  MessageSquareQuoteIcon,
  MessagesSquareIcon,
} from 'lucide-react';
import { Cover } from '@rezics/ui/cover';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { FeedItem } from '../pages/home-feed-read';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { exactRevisionHref } from '../../threads/exact-revision-href';
import { threadLocation } from '../../threads/thread-href';

export type FeedCardKind = 'work' | 'subject' | 'discussion' | 'reply' | 'review' | 'collection' | 'account' | 'space';

/** Classify admitted fields only. A catalogue Subject is not necessarily a creative work. */
export function feedCardKind(item: FeedItem): FeedCardKind {
  switch (item.destination.kind) {
    case 'collection':
      return 'collection';
    case 'space':
      return 'space';
    case 'account':
      return 'account';
    case 'post':
      return 'reply';
    case 'thread':
      return 'kind' in item.summary && item.summary.kind === 'review' ? 'review' : 'discussion';
    case 'subject':
      return 'creativeWork' in item.summary && item.summary.creativeWork ? 'work' : 'subject';
  }
}

const kindIcons = {
  work: BookOpenIcon,
  subject: FileTextIcon,
  discussion: MessagesSquareIcon,
  reply: MessageCircleIcon,
  review: MessageSquareQuoteIcon,
  collection: LibraryBigIcon,
  account: CircleUserRoundIcon,
  space: BoxesIcon,
};

export function feedCardKindLabel(kind: FeedCardKind, locale: string): string {
  const options = { locale: locale as Locale };
  switch (kind) {
    case 'work':
      return m.home_card_kind_work({}, options);
    case 'subject':
      return m.home_card_kind_subject({}, options);
    case 'discussion':
      return m.home_card_kind_discussion({}, options);
    case 'reply':
      return m.home_card_kind_reply({}, options);
    case 'review':
      return m.home_feed_kind_review({}, options);
    case 'collection':
      return m.library_following_kind_collection({}, options);
    case 'account':
      return m.home_card_kind_account({}, options);
    case 'space':
      return m.library_following_kind_space({}, options);
  }
}

/** The supplied source branch is the entire explanation; no ranking rationale is implied. */
export function FeedCardContext({ item, kind, locale }: { item: FeedItem; kind: FeedCardKind; locale: string }) {
  const options = { locale: locale as Locale };
  const Icon = kindIcons[kind];
  const source =
    item.source === 'discovery'
      ? m.home_card_source_discovery({}, options)
      : item.source === 'following'
        ? m.home_card_source_following({}, options)
        : m.home_card_source_continue({}, options);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-feed-card-kind={kind}>
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {feedCardKindLabel(kind, locale)}
      </span>
      <span aria-hidden="true">·</span>
      <span data-feed-card-source={item.source}>{source}</span>
    </div>
  );
}

export const feedCardLinkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center gap-2 rounded-sm ' +
  '[overflow-wrap:anywhere] text-primary underline-offset-4 hover:underline ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** One supplied cover or avatar. No collage or image lookup. */
export function FeedCardVisual({
  item,
  title,
  href,
  locale,
}: {
  item: FeedItem;
  title: string;
  href: string | undefined;
  locale: string;
}): ReactNode | undefined {
  const summary = item.summary;
  const options = { locale: locale as Locale };
  let visual: ReactNode;
  if ('label' in summary) {
    const cover = coverOf(summary);
    visual = (
      <div className="w-20 sm:w-24">
        <Cover subject={coverSubject(summary.id, title, summary)} cover={cover} size="fill" src={coverSrc} decorative />
      </div>
    );
    // A withheld Cover owns its reveal button; it cannot be nested in a link.
    if (cover?.withheld) return visual;
  } else if ('avatar' in summary) {
    visual = (
      <div className="w-16 overflow-hidden rounded-full sm:w-20">
        <Cover
          subject={{ id: summary.id, title, types: [] }}
          cover={summary.avatar ? { ...summary.avatar, variants: [...summary.avatar.variants] } : null}
          ratio="1:1"
          size="fill"
          src={coverSrc}
          decorative
        />
      </div>
    );
  } else return undefined;
  return href ? (
    <a href={href} aria-label={m.home_card_open({ title }, options)} className={feedCardLinkClassName}>
      {visual}
    </a>
  ) : (
    visual
  );
}

/** The summary supplies plain text, not a document or permission to fetch one. */
export function FeedCardPreview({ item }: { item: FeedItem }) {
  const summary = item.summary;
  const text =
    'excerpt' in summary
      ? summary.excerpt
      : 'description' in summary
        ? summary.description
        : 'address' in summary && 'summary' in summary
          ? summary.summary
          : undefined;
  return text ? (
    <p className="line-clamp-4 whitespace-pre-line [overflow-wrap:anywhere]" data-feed-card-preview>
      <bdi>{text}</bdi>
    </p>
  ) : null;
}

/** Review work comes from the current Content witness; Space Realm names remain unlinked carrier context. */
export function FeedCardSubjectContext({
  item,
  locale,
  contextCurrent = true,
}: {
  item: FeedItem;
  locale: string;
  contextCurrent?: boolean;
}) {
  const summary = item.summary;
  const options = { locale: locale as Locale };
  if (!contextCurrent) return null;
  if ('kind' in summary && summary.kind === 'review') {
    const context = 'reviewContext' in summary ? summary.reviewContext : undefined;
    const subject = context
      ? context.target.state === 'available'
        ? {
            id: context.target.subject.id,
            title: context.target.subject.label?.value ?? null,
            language: context.target.subject.label?.language,
          }
        : null
      : item.source === 'discovery' && 'subject' in summary && summary.subject
        ? summary.subject
        : null;
    if (!subject) return null;
    const title = subject.title ?? m.subject_value_unlabelled({}, options);
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2" data-feed-card-reviewed-subject>
        <span>{m.home_card_review_subject({}, options)}</span>
        <a
          href={subjectHref({ id: subject.id, label: title }, locale).href}
          className={feedCardLinkClassName}
          lang={'language' in subject ? subject.language : undefined}
        >
          <bdi>{title}</bdi>
        </a>
      </span>
    );
  }
  if (item.destination.kind === 'space' && 'realm' in summary && summary.realm?.title) {
    return (
      <span className="min-w-0 [overflow-wrap:anywhere]" data-feed-card-carrier>
        {m.home_card_carrier({}, options)} <bdi>{summary.realm.title}</bdi>
      </span>
    );
  }
  return null;
}

export function FeedCardReviewCitation({
  item,
  locale,
  contextCurrent = true,
}: {
  item: FeedItem;
  locale: string;
  contextCurrent?: boolean;
}) {
  if (!contextCurrent || !('reviewContext' in item.summary) || !item.summary.reviewContext) return null;
  const citation = item.summary.reviewContext.citation;
  const options = { locale: locale as Locale };
  if (citation.state === 'absent')
    return <p data-feed-review-citation="absent">{m.thread_provenance_unscored({}, options)}</p>;
  if (citation.state === 'withheld')
    return <p data-feed-review-citation="withheld">{m.post_history_score_concealed({}, options)}</p>;

  const number = new Intl.NumberFormat(locale);
  const grain = {
    work: m.home_question_work,
    release: m.home_question_release,
    episode: m.home_question_episode,
    character: m.home_question_character,
  }[citation.question.grain]({}, options);
  return (
    <dl className="grid min-w-0 gap-x-2 gap-y-1 text-sm sm:grid-cols-[auto_1fr]" data-feed-review-citation="available">
      <dt>{m.post_history_question_presentation({}, options)}</dt>
      <dd>
        {m.home_question_metadata(
          {
            label: citation.question.label,
            revision: number.format(citation.question.revision),
            grain,
            min: number.format(citation.question.scale.min),
            max: number.format(citation.question.scale.max),
            step: number.format(citation.question.scale.displayStep),
          },
          options,
        )}
      </dd>
      <dt>{m.post_history_rating_recorded({}, options)}</dt>
      <dd>
        {m.thread_provenance_vote(
          {
            units: number.format(citation.units),
            questionId: citation.question.id,
            revision: number.format(citation.voteRevision),
          },
          options,
        )}
      </dd>
    </dl>
  );
}

function ParentExcerpt({
  excerpt,
  language,
  spoiler,
  locale,
}: {
  excerpt: string;
  language: string | null;
  spoiler: boolean;
  locale: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const options = { locale: locale as Locale };
  if (spoiler && !revealed)
    return (
      <button
        type="button"
        className={feedCardLinkClassName}
        aria-expanded={false}
        onClick={() => setRevealed(true)}
      >
        {m.thread_reveal_spoiler({}, options)}
      </button>
    );
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]" lang={language ?? undefined} data-feed-parent-excerpt>
      <bdi>{excerpt}</bdi>
    </span>
  );
}

/** Only the selected reply's exact immediate parent is rendered; withheld identities never fall back. */
export function FeedCardParentContext({
  item,
  locale,
  contextCurrent = true,
  contextKey = '',
}: {
  item: FeedItem;
  locale: string;
  contextCurrent?: boolean;
  contextKey?: string;
}) {
  if (!contextCurrent || item.destination.kind !== 'post' || !('parentContext' in item.summary)) return null;
  const context = item.summary.parentContext;
  if (!context || context.kind === 'opening') return null;
  const options = { locale: locale as Locale };
  const parent = context.parent;
  if (parent.state === 'removed')
    return <p data-feed-parent-context="removed">{m.thread_reply_parent_deleted({}, options)}</p>;
  if (parent.state === 'withheld')
    return <p data-feed-parent-context="withheld">{m.thread_reply_parent_unavailable({}, options)}</p>;

  const authorName =
    parent.author?.displayName ||
    (parent.author?.handle ? `@${parent.author.handle}` : m.thread_author_unknown({}, options));
  const handle = parent.author?.handle;
  const linkableHandle = handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle) ? handle : null;
  const threadHref = threadLocation(
    locale,
    { id: item.destination.threadId, title: item.destination.title },
    undefined,
    parent.id,
  );
  const revisionHref = exactRevisionHref({ postId: parent.id, revisionId: parent.revisionId }, locale);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-feed-parent-context="available">
      <span>{m.thread_reply_parent({}, options)}</span>
      <a href={threadHref} className={feedCardLinkClassName}>
        {m.thread_reply_parent_view({}, options)}
      </a>
      <a href={revisionHref} className={feedCardLinkClassName}>
        {m.post_history_open_exact({}, options)}
      </a>
      <span data-feed-parent-author>
        {m.home_card_by({}, options)}{' '}
        {linkableHandle ? (
          <a href={accountHref(locale, linkableHandle)} className={feedCardLinkClassName}>
            <bdi>{authorName}</bdi>
          </a>
        ) : (
          <bdi>{authorName}</bdi>
        )}
      </span>
      {parent.language ? <span data-feed-parent-language>{parent.language}</span> : null}
      {parent.excerpt ? (
        <ParentExcerpt
          key={JSON.stringify([contextKey, item.source, item.id, parent.id, parent.revisionId])}
          excerpt={parent.excerpt}
          language={parent.language}
          spoiler={parent.spoiler}
          locale={locale}
        />
      ) : null}
    </div>
  );
}
