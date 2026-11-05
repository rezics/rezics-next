import type { RealmPresentationImage } from '../../threads/board-community-source';

export type RealmDiscoverySort = 'popular' | 'trending';

export type RealmDiscoveryCard = Readonly<{
  realmId: string;
  spaceId: string;
  name: string;
  description: string;
  avatar: RealmPresentationImage | null;
}>;

export type RealmDiscoveryState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; realms: readonly RealmDiscoveryCard[]; next: string | null }>
  | Readonly<{ kind: 'unavailable' | 'closed' }>;

export type RealmDiscoverySectionProps = Readonly<{
  sort: RealmDiscoverySort;
  state: RealmDiscoveryState;
  locale: string;
  pending?: boolean;
  retry?: boolean;
  restart?: boolean;
  onNext?: () => void;
  onRetry?: () => void;
}>;

export { RealmDiscoverySection } from './RealmDiscoverySection';
export { loadRealmDiscovery } from './source';
