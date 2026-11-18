import type { Pool } from 'pg';
import { withBoundedReadConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { DiscoveryGeneration } from './generations.ts';
import { classifyDiscoveryMetadataProducers } from './discovery-readiness.ts';
import type { DiscoveryCapabilityWitnesses } from './discovery-readiness.ts';
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

/** Allocation creates the same owner slots in every home in one transaction. Home zero is
 * a bounded scope lookup for both enrollment and active serving. */
export function readDiscoveryScope(pool: Pool, prefix: string, deadline: number, generation?: number | 'preparation') {
  const selection =
    generation === 'preparation'
      ? "g.state IN ('active','ready','reconciling','populating','replaying')"
      : generation === undefined
        ? "g.state='active'"
        : "g.generation=$2 AND g.state IN ('populating','replaying','reconciling','ready','active','retiring')";
  return withBoundedReadConnection(
    pool,
    deadline,
    async (client) => {
      const result = await client.query<
        Omit<DiscoveryGeneration, 'kinds'> & { metadataKinds: DiscoveryMetadataKind[] }
      >(
        `SELECT g.prefix,g.generation::float8 AS generation,g.index_uuid AS uuid,g.incarnation::text,
              g.state,g.capability,
              ARRAY(SELECT p.owner FROM search.discovery_population p
                    WHERE (p.partition_no,p.prefix,p.generation)=(g.partition_no,g.prefix,g.generation)
                      AND p.owner IN ('collection','review','space') ORDER BY p.owner) AS "metadataKinds"
       FROM search.discovery_generation g WHERE g.partition_no=0 AND g.prefix=$1 AND ${selection}
       ORDER BY (g.state='active') DESC,g.generation DESC LIMIT 2`,
        typeof generation === 'number' ? [prefix, generation] : [prefix],
      );
      const [first, second] = result.rows;
      if (generation === 'preparation' && second?.state !== 'active') return first;
      return second ? undefined : first;
    },
    {
      deadlineError: () => new ProblemError('deadline_exceeded'),
      isUncertainSettledQueryError: () => true,
    },
  );
}

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
