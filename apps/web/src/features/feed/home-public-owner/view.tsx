import type { ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import type { FeedItem } from '../../pages/home-feed-read';
import { homeFeedDestination, homeFeedRealmDestination, homeFeedTitle } from '../../pages/home-feed-destination';

type SpaceSummary = Extract<FeedItem['summary'], { address: string }>;

function HomeSpaceCarrierContext({
  item,
  summary,
  locale,
}: {
  item: FeedItem;
  summary: SpaceSummary;
  locale: string;
}) {
  const options = { locale: locale as Locale };
  if (!('realm' in summary) || summary.realm === undefined)
    return (
      <p className="text-muted-foreground" data-home-carrier-state="unavailable">
        {m.home_owner_carrier_unavailable({}, options)}
      </p>
    );
  if (summary.realm === null)
    return (
      <p className="text-muted-foreground" data-home-carrier-state="none">
        {m.home_owner_carrier_none({}, options)}
      </p>
    );

  const realm = summary.realm;
  const state = realm.title === null ? 'title-unavailable' : realm.title === '' ? 'title-empty' : 'current';
  const title =
    realm.title === null
      ? m.home_owner_carrier_title_unavailable({}, options)
      : realm.title === ''
        ? m.home_owner_carrier_title_empty({}, options)
        : realm.title;
  const href = homeFeedRealmDestination(item, locale);
  return (
    <p
      className="text-muted-foreground"
      data-home-carrier-state={state}
      data-home-carrier-id={realm.id}
    >
      <bdi>{m.space_realm_heading({}, options)}:</bdi>{' '}
      {href ? (
        <a
          data-home-carrier-link
          data-realm-id={realm.id}
          href={href}
          className="text-primary underline underline-offset-4"
        >
          <bdi>{title}</bdi>
        </a>
      ) : (
        <bdi>{title}</bdi>
      )}
    </p>
  );
}

/** Only native page summaries: no target hydration, membership inference or private cache. */
export function HomePublicOwnerContext({ item, locale }: { item: FeedItem; locale: string }) {
  const kind = item.destination.kind;
  if (kind !== 'collection' && kind !== 'space') return null;
  const options = { locale: locale as Locale };
  if (!homeFeedDestination(item, locale)) return <p role="status">{m.home_owner_context_unavailable({}, options)}</p>;
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
      {kind === 'space' && 'address' in summary ? (
        <p className="text-muted-foreground" data-home-space-address={summary.address}>
          <bdi>{m.space_setup_address({}, options)}:</bdi> <bdi>{summary.address}</bdi>
        </p>
      ) : null}
      {kind === 'collection' ? (
        <p className="text-muted-foreground">{m.home_owner_curator_unavailable({}, options)}</p>
      ) : 'address' in summary ? (
        <HomeSpaceCarrierContext item={item} summary={summary} locale={locale} />
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
