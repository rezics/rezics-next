import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { MetaLine } from '@rezics/ui/meta-line';
import { initials } from './initials';
import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthor } from '../identity/read';
import { coverSrc } from '../media/cover-src';

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

const personLink =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm text-start whitespace-normal [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The author of a post or thread: avatar with initials, display name and handle linked to the person, and the time. */
export function Byline({
  author,
  createdAt,
  revisedAt,
  now,
  showAuthor = true,
  size = 'default',
  className,
  children,
}: {
  author: PageAuthor | undefined;
  createdAt: string;
  revisedAt?: string | null | undefined;
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
  // Only a summary supplied by the existing identity batch can supply an image. Never read a profile per row.
  const avatar = !deleted && !unknown && author && 'avatar' in author ? author.avatar : null;
  const variant = avatar?.variants.find((item) => item.format === 'webp' && item.width >= 48) ?? avatar?.variants[0];
  const identityTitle =
    deleted || unknown
      ? undefined
      : [author?.displayName, author?.handle ? `@${author.handle}` : null].filter(Boolean).join(' ');

  return (
    <div className={cn('flex min-w-0 items-start gap-2.5 text-sm text-muted-foreground', className)}>
      {showAuthor ? (
        <Avatar aria-hidden="true" size={size === 'sm' ? 'sm' : 'default'}>
          {avatar && variant ? (
            <AvatarImage src={coverSrc(avatar.media, variant.format, variant.width)} alt="" loading="lazy" />
          ) : null}
          <AvatarFallback>
            {deleted || unknown ? '?' : initials(author?.displayName ?? author?.handle ?? '')}
          </AvatarFallback>
        </Avatar>
      ) : null}
      <p className="min-w-0 flex-1">
        <span className="block min-w-0">
          {showAuthor ? (
            <span className="block min-w-0 whitespace-normal [overflow-wrap:anywhere]" title={identityTitle}>
              {deleted ? (
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
                      <a className={cn('font-medium text-foreground', personLink)} href={person}>
                        @{author.handle}
                      </a>
                    ) : (
                      <span>@{author.handle}</span>
                    )
                  ) : null}
                </>
              )}
            </span>
          ) : null}{' '}
          <MetaLine
            className="block"
            items={[
              <time dateTime={createdAt} title={fullDateTime(createdAt, locale)}>
                {timeText(createdAt, now, locale)}
              </time>,
              revisedAt && new Date(revisedAt).getTime() > new Date(createdAt).getTime() ? (
                <time dateTime={revisedAt} title={fullDateTime(revisedAt, locale)}>
                  {m.thread_post_edited()}
                </time>
              ) : null,
              children,
            ]}
          />
        </span>
      </p>
    </div>
  );
}
