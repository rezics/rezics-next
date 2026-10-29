import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { MetaLine } from '@rezics/ui/meta-line';
import { initials } from './initials';
import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthor } from '../identity/read';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export function timeText(createdAt: string, now: string, locale: string): string {
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

export function fullDateTime(createdAt: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(
    new Date(createdAt),
  );
}

const personLink = 'underline-offset-4 hover:underline focus-visible:underline';

/** The author of a post or thread: avatar with initials, display name and handle linked to the person, and the time. */
export function Byline({
  author,
  createdAt,
  now,
  showAuthor = true,
  size = 'default',
  className,
  children,
}: {
  author: PageAuthor | undefined;
  createdAt: string;
  now: string;
  showAuthor?: boolean;
  size?: 'default' | 'sm';
  className?: string;
  /** Further facts that follow the time, such as when a post was edited. */
  children?: ReactNode;
}) {
  const locale = getLocale();
  // A deleted account is known by `state` and `kind` alone; whatever else the read carries is not shown.
  const deleted = author?.state === 'deleted';
  const unknown = showAuthor && !deleted && (!author || (!author.displayName && !author.handle));
  const person = deleted || !author?.handle ? null : `/${locale}/@${encodeURIComponent(author.handle)}`;

  return (
    <div className={cn('flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground', className)}>
      {showAuthor ? (
        <Avatar aria-hidden="true" size={size === 'sm' ? 'sm' : 'default'}>
          <AvatarFallback>
            {deleted || unknown ? '?' : initials(author?.displayName ?? author?.handle ?? '')}
          </AvatarFallback>
        </Avatar>
      ) : null}
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <MetaLine
          className="min-w-0 flex-1"
          items={[
            showAuthor ? (
              deleted ? (
                <span>
                  {author?.kind === 'organization' ? m.thread_author_deleted_organization() : m.thread_author_deleted()}
                </span>
              ) : unknown ? (
                <span>{m.thread_author_unknown()}</span>
              ) : (
                <>
                  {author?.displayName ? (
                    person ? (
                      <a className={cn('font-medium text-foreground', personLink)} href={person}>
                        {author.displayName}
                      </a>
                    ) : (
                      <span className="font-medium text-foreground">{author.displayName}</span>
                    )
                  ) : null}
                  {author?.displayName && author.handle ? ' ' : null}
                  {author?.handle ? (
                    !author.displayName && person ? (
                      <a
                        className={cn('max-w-full min-w-0 truncate font-medium text-foreground', personLink)}
                        href={person}
                      >
                        @{author.handle}
                      </a>
                    ) : (
                      <span className="max-w-full min-w-0 truncate">@{author.handle}</span>
                    )
                  ) : null}
                </>
              )
            ) : null,
            <time dateTime={createdAt} title={fullDateTime(createdAt, locale)}>
              {timeText(createdAt, now, locale)}
            </time>,
            children,
          ]}
        />
      </p>
    </div>
  );
}
