import type { FeedItem } from '../../features/pages/home-feed-read';

type DiscoveryCollectionCard = Extract<FeedItem['summary'], { card: unknown }>['card'];

/** The closed public card Search supplies for a discovery Collection: dynamic, uncovered and without preview facts. */
export function discoveryCollectionCard(input: {
  id: string;
  title: string;
  description: string | null;
}): DiscoveryCollectionCard {
  return {
    kind: 'collection',
    id: input.id,
    destination: `/collections/${input.id}`,
    title: input.title,
    description: input.description,
    visibility: 'public',
    revision: 1,
    sourceGeneration: '1',
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
    curator: { state: 'unavailable', reason: 'native_projection' },
    preview: { state: 'unavailable' },
    membershipKind: 'dynamic',
    outputGeneration: '1',
  };
}
