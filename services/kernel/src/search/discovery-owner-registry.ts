import { classifyDiscoveryMetadataProducers } from './discovery-readiness.ts';
import type {
  DiscoveryCapabilityWitnesses,
} from './discovery-readiness.ts';
import type {
  DiscoveryMetadataKind,
  DiscoveryMetadataProducer,
  DiscoveryMetadataProducers,
  DiscoveryOmittedKind,
  DiscoveryOwnerAdapterSlots,
  DiscoveryProducerEntry,
} from './index.ts';

const DISCOVERY_OWNER_METADATA = {
  collection: {
    labels: {
      de: 'Sammlungen',
      en: 'Collections',
      es: 'Colecciones',
      fr: 'Collections',
      ja: 'コレクション',
      ko: '컬렉션',
      'zh-Hans': '收藏集',
      'zh-Hant': '收藏集',
    },
  },
  review: {
    labels: {
      de: 'Rezensionen',
      en: 'Reviews',
      es: 'Reseñas',
      fr: 'Avis',
      ja: 'レビュー',
      ko: '리뷰',
      'zh-Hans': '评论',
      'zh-Hant': '評論',
    },
  },
  space: {
    labels: {
      de: 'Spaces',
      en: 'Spaces',
      es: 'Espacios',
      fr: 'Espaces',
      ja: 'スペース',
      ko: '스페이스',
      'zh-Hans': '空间',
      'zh-Hant': '空間',
    },
  },
} as const;

export type ResolvedDiscoveryOwnerAdapters = Readonly<{
  ownerAdapters: DiscoveryOwnerAdapterSlots;
  metadataProducers: DiscoveryMetadataProducers;
  omittedKinds: readonly DiscoveryOmittedKind[];
  capabilityWitnesses: DiscoveryCapabilityWitnesses;
}>;

/** Resolve readiness for the current registry and bind candidates to the published kind set. */
export async function resolveDiscoveryOwnerAdapters(
  producers: Pick<DiscoveryProducerEntry, 'ownerAdapters' | 'metadataProducers'>,
  publishedKinds?: readonly string[],
): Promise<ResolvedDiscoveryOwnerAdapters> {
  const classification = await classifyDiscoveryMetadataProducers(producers.metadataProducers);
  const published = publishedKinds === undefined ? undefined : new Set(publishedKinds);
  const available = new Set(
    classification.availableKinds.filter((kind) => published === undefined || published.has(kind)),
  );
  const omittedKinds: DiscoveryOmittedKind[] = [
    ...classification.omittedKinds.map(({ kind, state }) => ({
      id: kind,
      labels: DISCOVERY_OWNER_METADATA[kind].labels,
      state,
    })),
    ...classification.availableKinds
      .filter((kind) => published !== undefined && !published.has(kind))
      .map((kind) => ({ id: kind, labels: DISCOVERY_OWNER_METADATA[kind].labels, state: 'preparing' as const })),
  ];
  const metadataProducers = Object.freeze(
    Object.fromEntries([...available].map((kind) => [kind, producers.metadataProducers[kind]!])) as Partial<
      Record<DiscoveryMetadataKind, DiscoveryMetadataProducer>
    >,
  );
  const capabilityWitnesses = Object.freeze(
    Object.fromEntries(
      Object.entries(classification.witnesses).filter(([kind]) => available.has(kind as DiscoveryMetadataKind)),
    ),
  ) as DiscoveryCapabilityWitnesses;
  const unavailable = Object.freeze({ readiness: 'unavailable' as const });
  const ownerAdapters: DiscoveryOwnerAdapterSlots = Object.freeze({
    collection: available.has('collection') ? producers.ownerAdapters.collection : unavailable,
    review: available.has('review') ? producers.ownerAdapters.review : unavailable,
    space: available.has('space') ? producers.ownerAdapters.space : unavailable,
  });
  return Object.freeze({
    ownerAdapters,
    metadataProducers,
    omittedKinds: Object.freeze(omittedKinds),
    capabilityWitnesses,
  });
}
