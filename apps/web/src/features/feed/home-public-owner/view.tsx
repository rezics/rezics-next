import type { ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import type { FeedItem } from '../../pages/home-feed-read';
import { homeFeedDestination, homeFeedTitle } from '../../pages/home-feed-destination';

/** Only native page summaries: no target hydration, membership inference or private cache. */
export function HomePublicOwnerContext({ item, locale }: { item: FeedItem; locale: string }) {
  const kind = item.destination.kind;
  if (kind !== 'collection' && kind !== 'space') return null;
  const options = { locale: locale as Locale };
  if (!homeFeedDestination(item, locale))
    return <p role="status">{m.home_owner_context_unavailable({}, options)}</p>;
  const summary = item.summary;
  const description =
    kind === 'collection' && 'description' in summary
      ? summary.description
      : kind === 'space' && 'address' in summary
        ? summary.summary
        : undefined;
  return (
    <div className="space-y-1 text-sm [overflow-wrap:anywhere]" data-home-public-owner-context={kind}>
      {description ? (
        <p className="line-clamp-4 whitespace-pre-line" data-feed-card-preview>
          <bdi>{description}</bdi>
        </p>
      ) : (
        <p className="text-muted-foreground" data-owner-description={description === '' ? 'empty' : 'unavailable'}>
          {description === ''
            ? m.home_owner_description_empty({}, options)
            : m.home_owner_description_unavailable({}, options)}
        </p>
      )}
      {kind === 'collection' ? (
        <p className="text-muted-foreground">{m.home_owner_curator_unavailable({}, options)}</p>
      ) : !('realm' in summary) || !summary.realm?.title ? (
        <p className="text-muted-foreground">{m.home_owner_carrier_unavailable({}, options)}</p>
      ) : null}
      <p className="text-muted-foreground">{m.home_owner_follow_context({}, options)}</p>
    </div>
  );
}

/** Insertion seam in Home's existing action owner. Private actions await the native bounded projection. */
export function HomePublicOwnerActions({
  item,
  locale,
  signedIn,
  children,
}: {
  item: FeedItem;
  locale: string;
  signedIn: boolean;
  children?: ReactNode;
}) {
  const options = { locale: locale as Locale };
  const href = homeFeedDestination(item, locale);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-home-public-owner-actions>
      {href ? (
        <a href={href} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} min-h-11 whitespace-normal`}>
          {m.home_card_open({ title: homeFeedTitle(item, locale) }, options)}
        </a>
      ) : null}
      {signedIn ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_follow_unavailable({}, options)}
        </p>
      ) : null}
      {children}
    </div>
  );
}
