import { Cover, type CoverSummary } from '@rezics/ui/cover';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { coverSrc } from '../../media/cover-src';
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
  const options = { locale: locale as Locale };
  const name = author?.displayName || (author?.handle ? `@${author.handle}` : m.thread_author_unknown({}, options));
  const identity = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 [overflow-wrap:anywhere]">
      {author?.avatar ? (
        <span className="block w-8 shrink-0 overflow-hidden rounded-full">
          <Cover
            subject={{ id: item.id, title: name, types: [] }}
            cover={{ ...author.avatar, variants: [...author.avatar.variants] }}
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
function FeedCardImageCredit({ cover, locale }: { cover: CoverSummary | null | undefined; locale: string }) {
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
  const cover = 'cover' in summary ? summary.cover : 'avatar' in summary ? summary.avatar : undefined;
  const authorCover = 'author' in summary ? summary.author?.avatar : undefined;
  return (
    <div className="flex min-w-0 w-full flex-col gap-1" data-feed-card-attribution>
      {content ? <FeedCardAuthor item={item} locale={locale} /> : null}
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
