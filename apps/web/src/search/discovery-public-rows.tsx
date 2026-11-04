import { ContentItem } from '@rezics/ui/content-item';
import { Cover } from '@rezics/ui/cover';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { ReviewContextDetails } from './review-context-details';
import { localizedLabel, SubjectMeta } from './results';
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
  targetTypes,
}: {
  id: string;
  summary: PublicReviewSummary;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
  targetTypes?: Record<string, Record<string, string>> | undefined;
}) {
  const reviewContext = summary.reviewContext;
  const target =
    reviewContext?.state === 'available' && reviewContext.target.state === 'available'
      ? reviewContext.target.subject
      : null;
  // An enriched withheld state never falls back to the earlier title-only slot.
  const reviewedSubject = reviewContext
    ? target && { id: target.id, title: target.label?.value ?? null }
    : summary.subject;
  const reviewedTitle = reviewedSubject?.title || m.subject_value_unlabelled({}, options(locale));
  const context = (
    <div className="min-w-0 space-y-1">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span>{kind}</span>
        {reviewedSubject ? (
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-4 [overflow-wrap:anywhere]"
            lang={target?.label?.language}
            href={
              subjectHrefFor?.({ id: reviewedSubject.id, label: reviewedTitle }) ??
              subjectHref({ id: reviewedSubject.id, label: reviewedTitle }, locale).href
            }
          >
            {reviewedTitle}
          </a>
        ) : reviewContext ? (
          <span>{m.discussion_provenance_details_subject_unavailable({}, options(locale))}</span>
        ) : null}
      </span>
      {target ? (
        <>
          <SubjectMeta
            type={localizedLabel(targetTypes?.[target.type] ?? { en: target.type }, locale)}
            year={undefined}
            locale={locale}
          />
          <p className="break-all text-xs text-muted-foreground" dir="ltr">
            {target.id}
          </p>
        </>
      ) : null}
    </div>
  );
  const authorName = summary.author?.displayName || (summary.author?.handle ? `@${summary.author.handle}` : undefined);
  const authorHandle = summary.author?.displayName && summary.author.handle ? `@${summary.author.handle}` : undefined;

  return (
    <ContentItem
      data-discovery-review={id}
      title={reviewTitle(summary.title, locale)}
      href={discoveryReviewHref(id, summary.title, locale)}
      context={context}
      visual={
        target ? (
          <div className="w-[72px] sm:w-24">
            <Cover
              subject={{ id: target.id, title: reviewedTitle, types: target.types }}
              cover={target.cover}
              src={coverSrc}
              size="fill"
              decorative
            />
          </div>
        ) : undefined
      }
      metadata={
        authorName ? (
          <span>
            {authorName}
            {authorHandle ? ` ${authorHandle}` : ''}
          </span>
        ) : undefined
      }
      preview={
        <div className="min-w-0 space-y-3">
          {summary.excerpt ? (
            reviewContext?.state === 'available' && reviewContext.spoiler ? (
              <details key={`${id}:${summary.source?.openingRevisionId}`}>
                <summary className="inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4">
                  {m.subject_spoiler_show({}, options(locale))}
                </summary>
                <p lang={reviewContext.language ?? undefined} className="line-clamp-3 break-words">
                  {summary.excerpt}
                </p>
              </details>
            ) : (
              <p
                lang={reviewContext?.state === 'available' ? (reviewContext.language ?? undefined) : undefined}
                className="line-clamp-3 break-words"
              >
                {summary.excerpt}
              </p>
            )
          ) : null}
          {reviewContext ? <ReviewContextDetails context={reviewContext} locale={locale} /> : null}
        </div>
      }
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
export function DiscoveryPublicRow({
  hit,
  kind,
  locale,
  subjectHrefFor,
  targetTypes,
}: {
  hit: PublicDiscoveryHit;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
  targetTypes?: Record<string, Record<string, string>> | undefined;
}) {
  const { id } = hit.key;
  const summary = hit.summary;
  switch (summary.kind) {
    case 'collection':
      return <PublicCollectionRow id={id} summary={summary.value} kind={kind} locale={locale} />;
    case 'review':
      return (
        <ReviewRow
          id={id}
          summary={summary.value}
          kind={kind}
          locale={locale}
          subjectHrefFor={subjectHrefFor}
          targetTypes={targetTypes}
        />
      );
    case 'space':
      return <SpaceRow id={id} summary={summary.value} kind={kind} locale={locale} />;
  }
}
