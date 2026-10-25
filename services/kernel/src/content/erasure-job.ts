import type { Pool } from 'pg';
import type { MediaStorage } from './media.ts';
import type { MediaId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type PurgeOutcome = Readonly<{
  mediaId: MediaId;
  objectKey: string;
  outcome: 'purged' | 'already_absent' | 'fenced';
}>;
export type ErasureJob = Readonly<{ purgeObject(mediaId: MediaId, objectKey: string): Promise<PurgeOutcome> }>;

export function createErasureJob(_pool: Pool, _storage: MediaStorage): ErasureJob {
  throw unfinishedPort('createErasureJob');
}

export async function purgeObject(
  _pool: Pool,
  _storage: MediaStorage,
  _mediaId: MediaId,
  _objectKey: string,
): Promise<PurgeOutcome> {
  throw unfinishedPort('purgeObject');
}
