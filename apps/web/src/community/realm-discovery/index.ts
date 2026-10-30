import { createElement, type ReactElement } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { RealmPresentationImage } from '../../threads/board-community-source';
import { m } from '../../paraglide/messages.js';

export type RealmDiscoverySort = 'popular' | 'trending';
export type RealmDiscoveryCard = Readonly<{
  realmId: string;
  spaceId: string;
  name: string;
  description: string;
  avatar: RealmPresentationImage | null;
}>;
export type RealmDiscoveryState =
  | { kind: 'loading' }
  | { kind: 'ready'; realms: readonly RealmDiscoveryCard[]; next: string | null }
  | { kind: 'unavailable' | 'closed' };
export type RealmDiscoverySectionProps = Readonly<{
  sort: RealmDiscoverySort;
  state: RealmDiscoveryState;
  locale: string;
  onNext?: () => void;
  onRetry?: () => void;
}>;

/** Temporary Content producer boundary. Replace with the sole Content section when it is integrated. */
export function RealmDiscoverySection({
  sort,
  state,
  locale,
  onNext,
  onRetry,
}: RealmDiscoverySectionProps): ReactElement {
  const options = { locale: locale as never };
  const title =
    sort === 'popular'
      ? m.header_search_popular_realms({}, options)
      : m.header_search_trending_communities({}, options);
  // No cards or image URLs are inferred by this uninstalled presentation producer.
  return createElement(
    'section',
    { 'aria-label': title, 'data-realm-discovery-boundary': 'temporary', className: 'space-y-3' },
    createElement('h2', { className: 'text-lg font-semibold' }, title),
    createElement(
      'p',
      { role: 'status', className: 'text-sm text-muted-foreground' },
      state.kind === 'closed'
        ? m.discovery_closed({}, options)
        : state.kind === 'loading'
          ? m.discovery_loading({}, options)
          : m.discovery_not_ready({}, options),
    ),
    state.kind === 'ready' && state.next !== null
      ? createElement(
          Button,
          { type: 'button', variant: 'outline', disabled: !onNext, onClick: onNext },
          m.search_more({}, options),
        )
      : null,
    state.kind === 'unavailable' && onRetry
      ? createElement(
          Button,
          { type: 'button', variant: 'outline', onClick: onRetry },
          m.search_facet_retry({}, options),
        )
      : null,
  );
}
