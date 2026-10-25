import type { Pool } from 'pg';
import type { MediaStorage } from './media-storage.ts';
import { unfinishedPort } from './model.ts';

export type CollectionOutcome = Readonly<{
  partition: number;
  examined: number;
  collected: number;
  complete: boolean;
}>;
export type CollectionJob = Readonly<{
  collectPartition(partition: number, batchSize: number): Promise<CollectionOutcome>;
}>;
export function createCollectionJob(_pool: Pool, _storage: MediaStorage): CollectionJob {
  throw unfinishedPort('createCollectionJob');
}
export function collectPartition(
  _pool: Pool,
  _storage: MediaStorage,
  _partition: number,
  _batchSize: number,
): Promise<CollectionOutcome> {
  throw unfinishedPort('collectPartition');
}
