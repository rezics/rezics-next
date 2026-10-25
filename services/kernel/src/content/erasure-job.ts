import type { Pool } from 'pg';
import type { MediaStorage } from './media-storage.ts';
import type { MediaId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type PurgeOutcome = Readonly<{ mediaId: MediaId; outcome: 'purged' | 'already_absent' | 'fenced' }>;
export type ErasureJob = Readonly<{ purgeObject(mediaId: MediaId): Promise<PurgeOutcome> }>;
export function createErasureJob(_pool: Pool, _storage: MediaStorage): ErasureJob {
  throw unfinishedPort('createErasureJob');
}
export function purgeObject(_pool: Pool, _storage: MediaStorage, _mediaId: MediaId): Promise<PurgeOutcome> {
  throw unfinishedPort('purgeObject');
}
