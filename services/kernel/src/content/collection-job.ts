import type { Pool } from 'pg';
import type { CollectionFence, MediaStorage } from './media.ts';
import { unfinishedPort } from './model.ts';

export type CollectionOutcome = Readonly<{
  partition: number;
  examined: number;
  collected: number;
  nextKey: string | null;
  fence: bigint;
  complete: boolean;
}>;
export type CollectionJob = Readonly<{
  collectPartition(partition: number, batchSize: number): Promise<CollectionOutcome>;
}>;

export function createCollectionJob(_pool: Pool, _storage: MediaStorage): CollectionJob {
  throw unfinishedPort('createCollectionJob');
}

export async function collectPartition(
  _pool: Pool,
  _storage: MediaStorage,
  _partition: number,
  _batchSize: number,
): Promise<CollectionOutcome> {
  throw unfinishedPort('collectPartition');
}

export async function readCollectionProgress(_pool: Pool, _partition: number): Promise<CollectionFence | null> {
  throw unfinishedPort('readCollectionProgress');
}
