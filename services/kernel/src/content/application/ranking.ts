import type { ContentAmbient, ContentApplicationPorts, ContentPool } from '../contract/index.ts';
import { CONTENT_PARTITION_COUNT } from '../contract/index.ts';
import { admitCollectionPartitions, lemmyActiveRank } from '../core/index.ts';

export function createRanking(ports: Pick<ContentApplicationPorts, 'ranking'>, ambient: ContentAmbient) {
  return {
    activeRank(score: number, activityAt: Date): number {
      return lemmyActiveRank(score, activityAt, ambient.clock());
    },
    async refresh(pool: ContentPool, partitions?: readonly number[]): Promise<number> {
      const selected =
        partitions ?? Array.from({ length: CONTENT_PARTITION_COUNT }, (_, partition) => partition);
      if (!admitCollectionPartitions(selected, CONTENT_PARTITION_COUNT)) {
        throw new RangeError('Invalid board rank partitions');
      }
      return ports.ranking.refreshBatch(pool, ambient.clock(), selected);
    },
  };
}
