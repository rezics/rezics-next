import type { ReactNode } from 'react';
import { ReviewContextDetails } from './review-context-details';
import { localizedLabel, SubjectMeta } from './results';
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
  targetTypes,
}: {
  id: string;
  summary: PublicReviewSummary;
  kind: string;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
  targetTypes?: Record<string, Record<string, string>> | undefined;
}) {
  const searchContext = summary.searchContext;
  const target =
    searchContext?.state === 'available' && searchContext.target.state === 'available'
      ? searchContext.target.subject
      : null;
  // An enriched withheld state never falls back to the earlier title-only slot.
  const reviewedSubject = searchContext
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
              subjectHrefFor?.({
                id: reviewedSubject.id,
                label: reviewedTitle,
              }) ?? subjectHref({ id: reviewedSubject.id, label: reviewedTitle }, locale).href
            }
          >
            {reviewedTitle}
          </a>
        ) : searchContext ? (
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
              subject={{
                id: target.id,
                title: reviewedTitle,
                types: target.types,
              }}
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
          {summary.excerpt && (!searchContext || searchContext.state === 'available') ? (
            searchContext?.state === 'available' && searchContext.spoiler ? (
              <details key={`${id}:${summary.source?.openingRevisionId}:${summary.source?.sourceVersion}:${locale}`}>
                <summary className="inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4">
                  {m.subject_spoiler_show({}, options(locale))}
                </summary>
                <p lang={searchContext.language ?? undefined} className="line-clamp-3 break-words">
                  {summary.excerpt}
                </p>
              </details>
            ) : (
              <p
                lang={searchContext?.state === 'available' ? (searchContext.language ?? undefined) : undefined}
                className="line-clamp-3 break-words"
              >
                {summary.excerpt}
              </p>
            )
          ) : null}
          {searchContext ? <ReviewContextDetails context={searchContext} locale={locale} /> : null}
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
  memberKindLabel,
  entry,
  targetTypes,
}: {
  actions?: ReactNode;
  memberKindLabel?: ((type: string) => string) | undefined;
  entry?: SpaceEntryRow | undefined;
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
      return <SpaceRow id={id} summary={summary.value} kind={kind} locale={locale} actions={actions} entry={entry} />;
  }
}
