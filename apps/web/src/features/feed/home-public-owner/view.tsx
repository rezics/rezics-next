import type { ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { homeCollectionMemberHref } from './member-destination';
import { accountHref } from '../../../subject/subject-href';
import type { FeedItem } from '../../pages/home-feed-read';
import { homeFeedDestination, homeFeedRealmDestination, homeFeedTitle } from '../../pages/home-feed-destination';

type SpaceSummary = Extract<FeedItem['summary'], { address: string }>;
type CollectionCard = Extract<FeedItem['summary'], { card: unknown }>['card'];

function HomeSpaceCarrierContext({ item, summary, locale }: { item: FeedItem; summary: SpaceSummary; locale: string }) {
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
    <p className="text-muted-foreground" data-home-carrier-state={state} data-home-carrier-id={realm.id}>
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

/** Only a same-application `/@handle` curator destination becomes a link; anything else stays text. */
function curatorHref(locale: string, destination: string | null): string | undefined {
  const handle = destination?.startsWith('/@') ? destination.slice(2) : undefined;
  return handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle) ? accountHref(locale, handle) : undefined;
}

/** Native curator facts: an available curator names itself, and unavailable reasons stay unlabelled. */
function HomeCollectionCurator({ curator, locale }: { curator: CollectionCard['curator']; locale: string }) {
  const options = { locale: locale as Locale };
  if (curator.state !== 'available')
    return (
      <p
        className="text-muted-foreground"
        data-home-curator-state="unavailable"
        data-home-curator-reason={curator.reason}
      >
        {m.discovery_collection_curator_unavailable({}, options)}
      </p>
    );
  const label = curator.label || m.discovery_unnamed_account({}, options);
  const href = curatorHref(locale, curator.destination);
  return (
    <p className="text-muted-foreground" data-home-curator-state="available">
      {m.discovery_collection_curator({}, options)}{' '}
      {href ? (
        <a href={href} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">
          <bdi>{label}</bdi>
        </a>
      ) : (
        <bdi>{label}</bdi>
      )}
    </p>
  );
}

/** The admitted preview members link to their exact occurrence; empty, withheld and unavailable stay distinct. */
function HomeCollectionPreview({
  preview,
  locale,
  href,
}: {
  preview: CollectionCard['preview'];
  locale: string;
  href: string;
}) {
  const options = { locale: locale as Locale };
  if (preview.state !== 'available')
    return (
      <p className="text-sm text-muted-foreground" data-home-collection-preview={preview.state}>
        {preview.state === 'empty'
          ? m.discovery_collection_empty({}, options)
          : preview.state === 'withheld'
            ? m.discovery_collection_withheld({}, options)
            : m.discovery_collection_preview_unavailable({}, options)}
      </p>
    );
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3" data-home-collection-preview="available">
      <p className="text-sm font-medium">{m.discovery_collection_preview({}, options)}</p>
      <ul className="space-y-1" aria-label={m.discovery_collection_preview({}, options)}>
        {preview.members.map((member) => {
          const label = member.subject.label?.value ?? '';
          return (
            <li key={member.id} data-collection-member-id={member.id} className="min-w-0">
              <a
                lang={member.subject.label?.language}
                href={homeCollectionMemberHref({ id: member.subject.id, label, locale, collectionHref: href, memberId: member.id })}
                className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
              >
                <bdi>{label || m.subject_value_unlabelled({}, options)}</bdi>
              </a>
            </li>
          );
        })}
      </ul>
      {preview.partial ? (
        <p className="text-sm text-muted-foreground">{m.discovery_collection_partial({}, options)}</p>
      ) : null}
      {preview.truncated ? (
        <p className="text-sm text-muted-foreground">{m.discovery_collection_truncated({}, options)}</p>
      ) : null}
    </div>
  );
}

/** Library's owner-presentation badge and kind, as one feed line; the Library help copy stays on Library. */
function HomeCollectionPresentation({ card, locale }: { card: CollectionCard; locale: string }) {
  const options = { locale: locale as Locale };
  const kind = card.presentationKindSource === 'owner' ? card.presentationKind : null;
  const dynamic = card.membershipKind === 'dynamic';
  return (
    <p
      className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm"
      data-home-collection-presentation={dynamic ? 'dynamic' : 'ordered'}
    >
      <span className="rounded-md bg-muted px-2 py-0.5">
        {dynamic ? m.collection_presentation_dynamic({}, options) : m.collection_presentation_ordered({}, options)}
      </span>
      <span
        className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]"
        data-home-collection-kind={kind ?? 'mixed'}
      >
        {m.library_collection_kind({}, options)}: {kind ?? m.library_collection_mixed_label({}, options)}
      </span>
    </p>
  );
}

/** The installed curator, owner presentation and preview states of one discovery Collection. */
function HomeCollectionContext({ card, locale, href }: { card: CollectionCard; locale: string; href: string }) {
  const options = { locale: locale as Locale };
  return (
    <div className="min-w-0 space-y-2">
      <HomeCollectionCurator curator={card.curator} locale={locale} />
      {card.membershipKind === 'curated' ? (
        <p className="text-sm text-muted-foreground">
          {m.library_collection_item_count({ count: card.memberCount }, options)}
        </p>
      ) : null}
      <HomeCollectionPresentation card={card} locale={locale} />
      <HomeCollectionPreview preview={card.preview} locale={locale} href={href} />
    </div>
  );
}

/** Only native page summaries: no target hydration, membership inference or private cache. */
export function HomePublicOwnerContext({ item, locale }: { item: FeedItem; locale: string }) {
  const kind = item.destination.kind;
  if (kind !== 'collection' && kind !== 'space') return null;
  const options = { locale: locale as Locale };
  const href = homeFeedDestination(item, locale);
  if (!href) return <p role="status">{m.home_owner_context_unavailable({}, options)}</p>;
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
        // Following Collection rows supply no curator or preview facts, so their curator stays unavailable.
        'card' in summary ? (
          <HomeCollectionContext card={summary.card} locale={locale} href={href} />
        ) : (
          <p className="text-muted-foreground">{m.home_owner_curator_unavailable({}, options)}</p>
        )
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
