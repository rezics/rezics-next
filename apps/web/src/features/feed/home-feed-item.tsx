import type { ReactNode } from 'react';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { Cover } from '@rezics/ui/cover';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { continueProgress } from '../../library/continue-source';
import { progressView } from '../../library/progress-label';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { homeFeedDestination, homeFeedResume, homeFeedTitle } from '../pages/home-feed-destination';
import type { FeedItem } from '../pages/home-feed-read';
import type { FeedItemPresentation } from './feed-results';

function homeFeedKindLabel(item: FeedItem, locale: string): string | undefined {
  const options = { locale: locale as Locale };
  if (item.key.kind === 'collection' || item.destination.kind === 'collection')
    return m.library_following_kind_collection({}, options);
  if (item.key.kind === 'space' || item.destination.kind === 'space')
    return m.library_following_kind_space({}, options);
  if ('kind' in item.summary && item.summary.kind === 'review') return m.home_feed_kind_review({}, options);
}

function homeFeedPreview(summary: FeedItem['summary']): string | undefined {
  if ('excerpt' in summary && summary.excerpt) return summary.excerpt;
  if ('description' in summary && summary.description) return summary.description;
  if (summary && 'address' in summary && typeof summary.summary === 'string' && summary.summary)
    return summary.summary;
}

/** Home's installed native FeedItem projection; it performs no reads and keeps each owner-provided field. */
export function homeFeedItemPresentation(item: FeedItem, locale: string): FeedItemPresentation {
  const options = { locale: locale as Locale };
  const title = homeFeedTitle(item, locale);
  const href = homeFeedDestination(item, locale);
  const resume = homeFeedResume(item, locale);
  const summary = item.summary;
  const progress =
    item.source === 'continue' ? progressView(continueProgress(item.continue.activeProgressSession), locale) : null;
  let visual: ReactNode | undefined;
  if ('label' in summary) {
    visual = (
      <div className="w-20 shrink-0 sm:w-24">
        <Cover
          subject={coverSubject(summary.id, title, summary)}
          cover={coverOf(summary)}
          size="fill"
          src={coverSrc}
          decorative
        />
      </div>
    );
  } else if ('avatar' in summary && summary.avatar) {
    visual = (
      <div className="w-16 shrink-0">
        <Cover
          subject={{ id: summary.id, title, types: [] }}
          cover={{ ...summary.avatar, variants: [...summary.avatar.variants] }}
          ratio="1:1"
          size="fill"
          src={coverSrc}
          decorative
        />
      </div>
    );
  }
  const titleLang = 'label' in summary ? summary.label?.language : undefined;
  const preview = homeFeedPreview(summary);
  const author = 'author' in summary ? summary.author : undefined;
  const authorName = author?.displayName || (author?.handle ? `@${author.handle}` : undefined);
  const identity = author ? (
    <span className="inline-flex items-center gap-2">
      {author.avatar ? (
        <span className="block w-8 shrink-0">
          <Cover
            subject={{ id: item.id, title: authorName ?? '', types: [] }}
            cover={{ ...author.avatar, variants: [...author.avatar.variants] }}
            ratio="1:1"
            size="fill"
            src={coverSrc}
            decorative
          />
        </span>
      ) : null}
      {authorName ? <span>{authorName}</span> : null}
      {author.displayName && author.handle ? <span>@{author.handle}</span> : null}
    </span>
  ) : undefined;
  const metadata = author?.handle ? <a href={accountHref(locale, author.handle)}>{identity}</a> : identity;
  const kindLabel = homeFeedKindLabel(item, locale);
  const reviewed =
    'kind' in summary && summary.kind === 'review' && summary.subject?.title
      ? {
          title: summary.subject.title,
          href: subjectHref({ id: summary.subject.id, label: summary.subject.title }, locale).href,
        }
      : undefined;
  const realmTitle =
    item.key.kind === 'space' && 'realm' in summary && summary.realm?.title ? summary.realm.title : undefined;
  const context = kindLabel ? (
    <span>
      {kindLabel}
      {reviewed ? (
        <>
          {' '}
          <a href={reviewed.href}>{reviewed.title}</a>
        </>
      ) : null}
      {realmTitle ? <> · {realmTitle}</> : null}
    </span>
  ) : undefined;
  return {
    'data-feed-id': item.id,
    'data-feed-source': item.source,
    title,
    ...(href === undefined ? {} : { href }),
    ...(titleLang === undefined ? {} : { titleLang }),
    visual,
    context,
    metadata,
    preview: preview || undefined,
    state: progress?.text,
    actions:
      resume === undefined ? undefined : (
        <a
          href={resume}
          className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
        >
          {m.home_continue_label({ title }, options)}
        </a>
      ),
  };
}
