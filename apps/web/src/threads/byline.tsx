import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthor } from '../identity/read';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

function timeText(createdAt: string, now: string, locale: string): string {
  const difference = new Date(createdAt).getTime() - new Date(now).getTime();
  const distance = Math.abs(difference);
  if (distance <= 7 * day) {
    const [unit, milliseconds] =
      distance < minute
        ? (['second', 1_000] as const)
        : distance < hour
          ? (['minute', minute] as const)
          : distance < day
            ? (['hour', hour] as const)
            : (['day', day] as const);
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(difference / milliseconds), unit);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(createdAt));
}

function fullDateTime(createdAt: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(
    new Date(createdAt),
  );
}

export function Byline({
  author,
  createdAt,
  now,
  showAuthor = true,
}: {
  author: PageAuthor | undefined;
  createdAt: string;
  now: string;
  showAuthor?: boolean;
}) {
  const locale = getLocale();
  const deleted = author?.state === 'deleted';
  const unknown = showAuthor && (!author || (!author.displayName && !author.handle));
  const hasAuthor = showAuthor && (deleted || unknown || Boolean(author?.displayName || author?.handle));

  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-muted-foreground">
      {showAuthor ? (
        deleted ? (
          <span>{m.thread_author_deleted()}</span>
        ) : unknown ? (
          <span>{m.thread_author_unknown()}</span>
        ) : (
          <>
            {author?.displayName ? <span className="text-foreground">{author.displayName}</span> : null}
            {author?.handle ? <span>@{author.handle}</span> : null}
          </>
        )
      ) : null}
      {hasAuthor ? <span aria-hidden="true">·</span> : null}
      <time dateTime={createdAt} title={fullDateTime(createdAt, locale)}>
        {timeText(createdAt, now, locale)}
      </time>
    </p>
  );
}
