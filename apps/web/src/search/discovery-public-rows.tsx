import type { ReactNode } from 'react';
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
  actions,
  subjectHrefFor,
  memberKindLabel,
}: {
  id: string;
  summary: PublicCollectionSummary;
  actions?: ReactNode;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
  memberKindLabel?: ((type: string) => string) | undefined;
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
        <div>
          <span>
            {kind}
            {summary.card.membershipKind === 'curated'
              ? ` · ${m.library_collection_item_count({ count: summary.card.memberCount }, options(locale))}`
              : ''}
          </span>
          <p>
            {summary.card.curator.state === 'available' ? (
              <>
                {m.discovery_collection_curator({}, options(locale))}{' '}
                {summary.card.curator.destination ? (
                  <a
                    className="text-primary underline"
                    href={`/${encodeURIComponent(locale)}${summary.card.curator.destination}`}
                  >
                    {summary.card.curator.label || m.discovery_unnamed_account({}, options(locale))}
                  </a>
                ) : (
                  <span>{summary.card.curator.label || m.discovery_unnamed_account({}, options(locale))}</span>
                )}
              </>
            ) : (
              m.discovery_collection_curator_unavailable({}, options(locale))
            )}
          </p>
        </div>
      }
      preview={
        <div className="space-y-2">
          {summary.description ? <p className="line-clamp-2 break-words">{summary.description}</p> : null}
          {summary.card.preview.state === 'available' ? (
            <div>
              <ul aria-label={m.discovery_collection_preview({}, options(locale))}>
                {summary.card.preview.members.map((member) => (
                  <li key={member.id} data-subject-type={member.subject.type}>
                    <a
                      className="text-primary underline"
                      href={
                        subjectHrefFor?.({ id: member.subject.id, label: member.subject.label?.value ?? '' }) ??
                        subjectHref({ id: member.subject.id, label: member.subject.label?.value ?? '' }, locale).href
                      }
                    >
                      {member.subject.label?.value || m.subject_value_unlabelled({}, options(locale))}
                    </a>
                    {summary.card.presentationKind === null ? (
                      <span className="ml-2 text-sm text-muted-foreground">
                        {memberKindLabel?.(member.subject.type) ?? member.subject.type}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {summary.card.preview.partial ? <p>{m.discovery_collection_partial({}, options(locale))}</p> : null}
              {summary.card.preview.truncated ? <p>{m.discovery_collection_truncated({}, options(locale))}</p> : null}
            </div>
          ) : (
            <p>
              {summary.card.preview.state === 'empty'
                ? m.discovery_collection_empty({}, options(locale))
                : summary.card.preview.state === 'withheld'
                  ? m.discovery_collection_withheld({}, options(locale))
                  : m.discovery_collection_preview_unavailable({}, options(locale))}
            </p>
          )}
          {actions ?? <p>{m.library_follow_unavailable({}, options(locale))}</p>}
        </div>
      }
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
  actions,
  memberKindLabel,
}: {
  actions?: ReactNode;
  memberKindLabel?: ((type: string) => string) | undefined;
  hit: PublicDiscoveryHit;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  const { id } = hit.key;
  const summary = hit.summary;
  switch (summary.kind) {
    case 'collection':
      return (
        <PublicCollectionRow
          id={id}
          summary={summary.value}
          kind={kind}
          locale={locale}
          subjectHrefFor={subjectHrefFor}
          actions={actions}
          memberKindLabel={memberKindLabel}
        />
      );
    case 'review':
      return <ReviewRow id={id} summary={summary.value} kind={kind} locale={locale} subjectHrefFor={subjectHrefFor} />;
    case 'space':
      return <SpaceRow id={id} summary={summary.value} kind={kind} locale={locale} />;
  }
}
