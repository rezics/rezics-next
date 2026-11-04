import type { ReactNode } from 'react';
import type { SpaceEntryRow } from './space-entry/contract';
import { SpaceEntryAvatar } from './space-entry/presentation';
import { SpaceEntryControls } from './space-entry/controls';
import { ContentItem } from '@rezics/ui/content-item';
import { Cover } from '@rezics/ui/cover';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { subjectHref, type SubjectHrefInput } from '../subject/subject-href';
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
      visual={
        <div className="w-[72px] sm:w-24">
          <Cover
            subject={{
              id,
              title: summary.title,
              types: summary.card.presentationKind ? [summary.card.presentationKind] : [],
            }}
            cover={summary.card.cover}
            src={coverSrc}
            size="fill"
            decorative
          />
        </div>
      }
      metadata={
        <span>
          {kind}
          {summary.card.membershipKind === 'curated'
            ? ` · ${m.library_collection_item_count({ count: summary.card.memberCount }, options(locale))}`
            : ''}
        </span>
      }
      preview={summary.description ? <p className="line-clamp-2 break-words">{summary.description}</p> : undefined}
    />
  );
}

function ReviewRow({
  id,
  summary,
  kind,
  locale,
  subjectHrefFor,
}: {
  id: string;
  summary: PublicReviewSummary;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  const reviewedSubject = summary.subject;
  const reviewedTitle = reviewedSubject?.title;
  const context = (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span>{kind}</span>
      {reviewedSubject && reviewedTitle ? (
        <a
          href={
            subjectHrefFor?.({ id: reviewedSubject.id, label: reviewedTitle }) ??
            subjectHref({ id: reviewedSubject.id, label: reviewedTitle }, locale).href
          }
        >
          {reviewedTitle}
        </a>
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
  actions,
  entry,
}: {
  id: string;
  summary: PublicSpaceSummary;
  actions?: ReactNode;
  entry?: SpaceEntryRow | undefined;
  kind: string;
  locale: string;
}) {
  const realmTitle = summary.realm?.title;
  return (
    <ContentItem
      data-discovery-space={id}
      data-discovery-personal-row={JSON.stringify(['community', 'space', id])}
      title={summary.presentation?.identity.name ?? summary.title}
      visual={
        summary.presentation ? (
          <SpaceEntryAvatar
            key={JSON.stringify(summary.presentation)}
            presentation={summary.presentation}
            locale={locale}
          />
        ) : undefined
      }
      actions={
        actions ?? (
          <SpaceEntryControls
            id={id}
            row={entry}
            locale={locale}
            returnTo={
              typeof window === 'undefined'
                ? `/${locale}/search`
                : window.location.pathname + window.location.search + window.location.hash
            }
          />
        )
      }

      href={discoverySpaceHref(summary.address, locale)}
      context={
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span>{kind}</span>
          {summary.realm ? (
            <span>{realmTitle ?? m.space_realm_heading({}, options(locale))}</span>
          ) : (
            <span>{m.search_space_standalone({}, options(locale))}</span>
          )}
          {summary.presentation?.identity.kind === 'realm' && summary.presentation.identity.name !== summary.title ? (
            <span>{summary.title}</span>
          ) : null}
        </span>
      }
      metadata={<span className="break-all">{summary.address}</span>}
      preview={summary.summary ? <p className="line-clamp-2 break-words">{summary.summary}</p> : undefined}
    />
  );
}

/** Current public summaries only; rendering does not read, hydrate, rank, or enrich a row. */
export function DiscoveryPublicRow({
  hit,
  kind,
  locale,
  subjectHrefFor,
  actions,
  entry,
}: {
  actions?: ReactNode;
  entry?: SpaceEntryRow | undefined;
  hit: PublicDiscoveryHit;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  const { id } = hit.key;
  const summary = hit.summary;
  switch (summary.kind) {
    case 'collection':
      return <PublicCollectionRow id={id} summary={summary.value} kind={kind} locale={locale} />;
    case 'review':
      return <ReviewRow id={id} summary={summary.value} kind={kind} locale={locale} subjectHrefFor={subjectHrefFor} />;
    case 'space':
      return <SpaceRow id={id} summary={summary.value} kind={kind} locale={locale} actions={actions} entry={entry} />;
  }
}
