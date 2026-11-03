import { ContentItem } from '@rezics/ui/content-item';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { discoveryCollectionHref, discoveryReviewHref, discoverySpaceHref } from './discovery-public-links';
import type { PublicCollectionSummary, PublicDiscoveryHit, PublicReviewSummary, PublicSpaceSummary } from './discovery';

function options(locale: string) {
  return { locale: locale as Locale };
}

function reviewTitle(title: string | null, locale: string): string {
  return title || m.threads_untitled({}, options(locale));
}

function PublicCollectionRow({
  id,
  summary,
  kind,
  locale,
}: {
  id: string;
  summary: PublicCollectionSummary;
  kind: string;
  locale: string;
}) {
  return (
    <ContentItem
      data-discovery-collection={id}
      title={summary.title}
      href={discoveryCollectionHref(id, locale)}
      metadata={<span>{kind}</span>}
      preview={summary.description ? <p className="line-clamp-2 break-words">{summary.description}</p> : undefined}
    />
  );
}

function ReviewRow({
  id,
  summary,
  kind,
  locale,
}: {
  id: string;
  summary: PublicReviewSummary;
  kind: string;
  locale: string;
}) {
  const reviewedSubject = summary.subject;
  const reviewedTitle = reviewedSubject?.title;
  const context = (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span>{kind}</span>
      {reviewedSubject && reviewedTitle ? (
        <a href={subjectHref({ id: reviewedSubject.id, label: reviewedTitle }, locale).href}>{reviewedTitle}</a>
      ) : null}
    </span>
  );
  const authorName = summary.author?.displayName || (summary.author?.handle ? `@${summary.author.handle}` : undefined);
  const authorHandle = summary.author?.displayName && summary.author.handle ? `@${summary.author.handle}` : undefined;

  return (
    <ContentItem
      data-discovery-review={id}
      title={reviewTitle(summary.title, locale)}
      href={discoveryReviewHref(id, summary.title, locale)}
      context={context}
      metadata={
        authorName ? (
          <span>
            {authorName}
            {authorHandle ? ` ${authorHandle}` : ''}
          </span>
        ) : undefined
      }
      preview={summary.excerpt ? <p className="line-clamp-3 break-words">{summary.excerpt}</p> : undefined}
    />
  );
}

function SpaceRow({
  id,
  summary,
  kind,
  locale,
}: {
  id: string;
  summary: PublicSpaceSummary;
  kind: string;
  locale: string;
}) {
  const realmTitle = summary.realm?.title;
  return (
    <ContentItem
      data-discovery-space={id}
      title={summary.title}
      href={discoverySpaceHref(summary.address, locale)}
      context={
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span>{kind}</span>
          {realmTitle ? <span>{realmTitle}</span> : null}
        </span>
      }
      metadata={<span className="break-all">{summary.address}</span>}
      preview={summary.summary ? <p className="line-clamp-2 break-words">{summary.summary}</p> : undefined}
    />
  );
}

/** Current public summaries only; rendering does not read, hydrate, rank, or enrich a row. */
export function DiscoveryPublicRow({ hit, kind, locale }: { hit: PublicDiscoveryHit; kind: string; locale: string }) {
  const { id } = hit.key;
  const summary = hit.summary;
  switch (summary.kind) {
    case 'collection':
      return <PublicCollectionRow id={id} summary={summary.value} kind={kind} locale={locale} />;
    case 'review':
      return <ReviewRow id={id} summary={summary.value} kind={kind} locale={locale} />;
    case 'space':
      return <SpaceRow id={id} summary={summary.value} kind={kind} locale={locale} />;
  }
}
