import type { ReactNode } from 'react';
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
import { subjectHref } from '../../subject/subject-href';

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

/** Review Subjects are secondary destinations; Realm names are unlinked Space carrier context. */
export function FeedCardSubjectContext({ item, locale }: { item: FeedItem; locale: string }) {
  const summary = item.summary;
  const options = { locale: locale as Locale };
  if ('kind' in summary && summary.kind === 'review' && 'subject' in summary && summary.subject) {
    const subject = summary.subject;
    const title = subject.title ?? m.subject_value_unlabelled({}, options);
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2" data-feed-card-reviewed-subject>
        <span>{m.home_card_review_subject({}, options)}</span>
        <a href={subjectHref({ id: subject.id, label: title }, locale).href} className={feedCardLinkClassName}>
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
