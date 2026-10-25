import type { Pool } from 'pg';
import type { MediaStorage, MediaVariant } from './media.ts';
import type { MediaId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type ImageJobOutcome = Readonly<{
  mediaId: MediaId;
  state: 'available' | 'rejected' | 'already_terminal';
  variants: readonly MediaVariant[];
}>;
export type ImageJob = Readonly<{ process(mediaId: MediaId): Promise<ImageJobOutcome> }>;

export function createImageJob(_pool: Pool, _storage: MediaStorage): ImageJob {
  throw unfinishedPort('createImageJob');
}

export async function processImage(_pool: Pool, _storage: MediaStorage, _mediaId: MediaId): Promise<ImageJobOutcome> {
  throw unfinishedPort('processImage');
}
