import { Cover, type CoverSummary } from '@rezics/ui/cover';
import { LanguageTag, SpoilerGate } from '../pages/values';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { coverSrc } from '../../media/cover-src';
import { exactRevisionHref } from '../../threads/exact-revision-href';
import { threadLocation } from '../../threads/thread-href';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { FeedItem } from '../pages/home-feed-read';
import { FeedCardSubjectContext, feedCardLinkClassName, type FeedCardKind } from './card-presentation';

/** An explicit UTC zone keeps server and client rendering stable across midnight. */
export function feedCardTime(value: string | null | undefined, locale: string): { value: string; text: string } | null {
  if (!value) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  return {
    value,
    text:
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(instant) +
      ' UTC',
  };
}

function FeedCardTime({ value, locale, label }: { value: string | null | undefined; locale: string; label: string }) {
  const time = feedCardTime(value, locale);
  return (
    <span className="inline-flex min-w-0 flex-wrap gap-x-1" data-feed-card-time={label}>
      <span>{label}</span>
      {time ? (
        <time dateTime={time.value}>{time.text}</time>
      ) : (
        <span>{m.home_card_time_unknown({}, { locale: locale as Locale })}</span>
      )}
    </span>
  );
}

/** Same admission grammar as Home's primary account destination. */
function readableHandle(handle: string | null | undefined): handle is string {
  return Boolean(handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle));
}

function FeedCardAuthor({ item, locale }: { item: FeedItem; locale: string }) {
  const summary = item.summary;
  const author = 'author' in summary ? summary.author : undefined;
  const authorAvatar = (author && 'avatar' in author ? author.avatar : null) as CoverSummary | null;
  const options = { locale: locale as Locale };
  const name = author?.displayName || (author?.handle ? `@${author.handle}` : m.thread_author_unknown({}, options));
  const identity = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 [overflow-wrap:anywhere]">
      {authorAvatar ? (
        <span className="block w-8 shrink-0 overflow-hidden rounded-full">
          <Cover
            subject={{ id: item.id, title: name, types: [] }}
            cover={{ ...authorAvatar, variants: [...authorAvatar.variants] }}
            ratio="1:1"
            size="fill"
            src={coverSrc}
            decorative
          />
        </span>
      ) : null}
      <span className="min-w-0">
        <bdi>{name}</bdi>
        {author?.displayName && author.handle ? (
          <>
            {' '}
            <bdi className="text-muted-foreground">@{author.handle}</bdi>
          </>
        ) : null}
      </span>
    </span>
  );
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2" data-feed-card-author>
      <span>{m.home_card_by({}, options)}</span>
      {readableHandle(author?.handle) ? (
        <a href={accountHref(locale, author.handle)} className={feedCardLinkClassName}>
          {identity}
        </a>
      ) : (
        identity
      )}
    </span>
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function FeedCardReviewContext({ item, locale }: { item: FeedItem; locale: string }) {
  const summary: unknown = item.summary;
  if (
    item.key.owner !== 'content' ||
    item.destination.kind !== 'thread' ||
    !record(summary) ||
    summary.kind !== 'review' ||
    !id(summary.id) ||
    item.key.id !== summary.id ||
    item.destination.id !== summary.id
  )
    return null;
  return <PublicReviewDetails context={summary.reviewContext} locale={locale} />;
}

/** Shared admitted review context; labels never replace the native citation identity. */
export function PublicReviewDetails({ context: supplied, locale }: { context: unknown; locale: string }) {
  const context = record(supplied) ? supplied : undefined;
  if (!context) return null;
  const options = { locale: locale as Locale };
  const target = record(context.target) ? context.target : undefined;
  const targetSubject =
    target?.state === 'available' && record(target.subject) && id(target.subject.id) ? target.subject : undefined;
  const subjectId = targetSubject && id(targetSubject.id) ? targetSubject.id : undefined;
  const label = record(targetSubject?.label) ? targetSubject.label : undefined;
  const subjectLabel = typeof label?.value === 'string' ? label.value : m.subject_value_unlabelled({}, options);
  const subjectLanguage = typeof label?.language === 'string' ? label.language : undefined;
  const citation = record(context.citation) ? context.citation : undefined;
  const questionRecord = record(citation?.question) ? citation.question : undefined;
  const questionId = questionRecord && id(questionRecord.id) ? questionRecord.id : undefined;
  const questionLabel = typeof questionRecord?.label === 'string' ? questionRecord.label : undefined;
  const questionRevision = questionRecord?.revision;
  const citedUnits = citation?.units;
  const question =
    subjectId &&
    citation?.state === 'available' &&
    questionId &&
    questionLabel !== undefined &&
    typeof questionRevision === 'number' &&
    Number.isSafeInteger(questionRevision) &&
    typeof citedUnits === 'number' &&
    Number.isSafeInteger(citedUnits)
      ? { id: questionId, label: questionLabel, revision: questionRevision, units: citedUnits }
      : undefined;
  const status =
    citation?.state === 'withheld' || citation?.state === 'absent'
      ? m.post_history_score_concealed({}, options)
      : citation?.state === 'failed'
        ? m.post_history_score_failed({}, options)
        : undefined;
  if (!subjectId && !question && !status) return null;
  return (
    <section className="min-w-0 space-y-1" data-feed-review-context>
      {subjectId ? (
        <p className="flex min-w-0 flex-wrap gap-x-2" data-feed-review-subject={subjectId}>
          <span>{m.thread_review_details_selected_subject({ title: subjectLabel }, options)}</span>
          <a
            href={subjectHref({ id: subjectId, label: subjectLabel }, locale).href}
            className={feedCardLinkClassName}
            lang={subjectLanguage}
          >
            <bdi>{subjectLabel}</bdi>
          </a>
        </p>
      ) : null}
      {question ? (
        <div className="min-w-0" data-feed-review-citation>
          <p>
            {m.post_history_question({}, options)}: <bdi>{question.label}</bdi>
          </p>
          <p className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{m.post_history_citation_identity()}</span>
            <bdi data-feed-review-question={question.id}>{question.id}</bdi>
            <span data-feed-review-question-revision={question.revision}>
              {m.thread_history_version({ number: question.revision }, options)}
            </span>
          </p>
          <p
            data-feed-review-units={question.units}
            data-feed-review-vote-revision={
              typeof citation?.voteRevision === 'number' && Number.isSafeInteger(citation.voteRevision)
                ? citation.voteRevision
                : undefined
            }
          >
            {m.home_feed_review_cited_units({ units: new Intl.NumberFormat(locale).format(question.units) }, options)}
          </p>
        </div>
      ) : status ? (
        <p role="status" data-feed-review-citation-state={citation?.state}>
          {status}
        </p>
      ) : null}
    </section>
  );
}

function FeedCardParentContext({ item, locale }: { item: FeedItem; locale: string }) {
  const summary: unknown = item.summary;
  const destination = item.destination;
  if (
    item.key.owner !== 'content' ||
    item.key.kind !== 'post' ||
    destination.kind !== 'post' ||
    !record(summary) ||
    !id(summary.threadId) ||
    !id(summary.id) ||
    item.key.id !== summary.id ||
    destination.postId !== summary.id ||
    destination.threadId !== summary.threadId
  )
    return null;
  return (
    <PublicReplyParent
      context={summary.parentContext}
      locale={locale}
      thread={{ id: destination.threadId, title: destination.title }}
    />
  );
}

/** Only the supplied immediate parent, with its own spoiler and exact revision destination. */
export function PublicReplyParent({
  context: supplied,
  locale,
  thread,
}: {
  context: unknown;
  locale: string;
  thread: { id: string; title?: string | null };
}) {
  const context = record(supplied) ? supplied : undefined;
  if (!context || context.kind !== 'reply' || !record(context.parent)) return null;
  const parent = context.parent;
  const options = { locale: locale as Locale };
  const parentId = id(parent.id) ? parent.id : undefined;
  if (parent.state === 'withheld')
    return <p data-feed-parent-context="withheld">{m.thread_reply_parent_unavailable({}, options)}</p>;
  if (parent.state === 'removed' && parentId)
    return (
      <p data-feed-parent-context="removed">
        <a href={threadLocation(locale, thread, undefined, parentId)} className={feedCardLinkClassName}>
          {m.thread_reply_parent_deleted({}, options)}
        </a>
      </p>
    );
  const revisionId = id(parent.revisionId) ? parent.revisionId : undefined;
  const spoiler = parent.spoiler;
  const excerptValue = parent.excerpt;
  const languageValue = parent.language;
  if (
    parent.state !== 'available' ||
    !parentId ||
    !revisionId ||
    typeof spoiler !== 'boolean' ||
    !(excerptValue === null || typeof excerptValue === 'string') ||
    !(languageValue === null || typeof languageValue === 'string')
  )
    return null;
  const author = record(parent.author) ? parent.author : undefined;
  const handle = typeof author?.handle === 'string' ? author.handle : undefined;
  const readable = handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle) ? handle : undefined;
  const authorName =
    (typeof author?.displayName === 'string' && author.displayName) ||
    (handle ? `@${handle}` : m.thread_author_unknown({}, options));
  const postHref = threadLocation(locale, thread, undefined, parentId);
  const excerpt = excerptValue;
  const language = languageValue;
  return (
    <section
      className="min-w-0 space-y-1"
      data-feed-parent-context="available"
      data-feed-parent-language={language ?? undefined}
    >
      <p className="flex min-w-0 flex-wrap items-center gap-x-2">
        <a href={postHref} className={feedCardLinkClassName}>
          {m.thread_reply_parent_view({}, options)}
        </a>
        {readable ? (
          <a href={accountHref(locale, readable)} className={feedCardLinkClassName}>
            <bdi>{authorName}</bdi>
          </a>
        ) : (
          <bdi>{authorName}</bdi>
        )}
        <LanguageTag lang={language} locale={locale} />
      </p>
      {excerpt ? (
        spoiler ? (
          <SpoilerGate label={m.thread_reveal_spoiler({}, options)} hideLabel={m.subject_spoiler_hide({}, options)}>
            <p lang={language ?? undefined} className="whitespace-pre-line [overflow-wrap:anywhere]">
              <bdi>{excerpt}</bdi>
            </p>
          </SpoilerGate>
        ) : (
          <p lang={language ?? undefined} className="whitespace-pre-line [overflow-wrap:anywhere]">
            <bdi>{excerpt}</bdi>
          </p>
        )
      ) : null}
      <a href={exactRevisionHref({ postId: parentId, revisionId }, locale)} className={feedCardLinkClassName}>
        {m.exact_revision_heading({}, options)}
      </a>
    </section>
  );
}

function FeedCardAccount({ item, locale }: { item: FeedItem; locale: string }) {
  const summary = item.summary;
  if (!('displayName' in summary)) return null;
  const options = { locale: locale as Locale };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-feed-card-account>
      {summary.handle ? <bdi>@{summary.handle}</bdi> : null}
      {summary.accountKind === 'organization' ? <span>{m.home_card_organization({}, options)}</span> : null}
      {summary.automated ? <span>{m.home_card_automated({}, options)}</span> : null}
      {summary.verifiedAgent ? (
        <a
          href={subjectHref({ id: summary.verifiedAgent.id, label: summary.verifiedAgent.label }, locale).href}
          className={feedCardLinkClassName}
        >
          <bdi>{m.discovery_verified_as({ name: summary.verifiedAgent.label }, options)}</bdi>
        </a>
      ) : null}
    </div>
  );
}

function safeCreditHref(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return;
  }
}

/** Credit stays outside the cover link. Its licence never becomes a licence for the work. */
export function FeedCardImageCredit({
  cover,
  locale,
}: {
  cover: Pick<CoverSummary, 'credit' | 'withheld'> | null | undefined;
  locale: string;
}) {
  const credit = cover?.withheld ? null : cover?.credit;
  if (!credit) return null;
  const options = { locale: locale as Locale };
  const via = safeCreditHref(credit.via?.url);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs" data-feed-card-image-credit>
      <span>{m.subject_cover_credit({}, options)}</span>
      <bdi>{credit.rightsHolder}</bdi>
      {credit.via?.name ? (
        <>
          <span>{m.home_card_credit_via({}, options)}</span>
          {via ? (
            <a href={via} className={feedCardLinkClassName}>
              <bdi>{credit.via.name}</bdi>
            </a>
          ) : (
            <bdi>{credit.via.name}</bdi>
          )}
        </>
      ) : null}
      {credit.license ? <bdi>{credit.license}</bdi> : null}
      {'obligations' in credit && Array.isArray(credit.obligations)
        ? credit.obligations.map((obligation, index) =>
            typeof obligation === 'string' ? <bdi key={index}>{obligation}</bdi> : null,
          )
        : null}
    </span>
  );
}

export function FeedCardAttribution({ item, kind, locale }: { item: FeedItem; kind: FeedCardKind; locale: string }) {
  const summary = item.summary;
  const options = { locale: locale as Locale };
  const content = kind === 'discussion' || kind === 'reply' || kind === 'review';
  const cover =
    'cover' in summary
      ? summary.cover
      : 'avatar' in summary
        ? summary.avatar
        : 'card' in summary
          ? summary.card.cover
          : undefined;
  const authorCover =
    'author' in summary && summary.author && 'avatar' in summary.author ? summary.author.avatar : undefined;
  return (
    <div className="flex min-w-0 w-full flex-col gap-1" data-feed-card-attribution>
      {content ? <FeedCardAuthor item={item} locale={locale} /> : null}
      {content ? <FeedCardReviewContext item={item} locale={locale} /> : null}
      {content ? <FeedCardParentContext item={item} locale={locale} /> : null}
      {kind === 'account' ? <FeedCardAccount item={item} locale={locale} /> : null}
      <FeedCardSubjectContext item={item} locale={locale} />
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <FeedCardTime value={item.occurredAt} locale={locale} label={m.home_card_occurrence({}, options)} />
        {'createdAt' in summary ? (
          <FeedCardTime value={summary.createdAt} locale={locale} label={m.home_card_created({}, options)} />
        ) : null}
      </div>
      <FeedCardImageCredit cover={cover} locale={locale} />
      <FeedCardImageCredit cover={authorCover} locale={locale} />
    </div>
  );
}
