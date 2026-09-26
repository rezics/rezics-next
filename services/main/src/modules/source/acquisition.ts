import type { Pool } from 'pg';
import { SourceRunDriftReader } from './acquisition-drift.ts';
import { SourceFeedStore } from './acquisition-feed.ts';
import { SourceRunStore, type SourceRunOptions } from './acquisition-run.ts';

/** The general acquisition owner: bounded runs, their drift and dump/change feeds. */
export interface SourceAcquisitionServices {
  runs: SourceRunStore;
  feeds: SourceFeedStore;
  drift: SourceRunDriftReader;
}

export function sourceAcquisitionServices(pool: Pool, options: SourceRunOptions): SourceAcquisitionServices {
  const runs = new SourceRunStore(pool, options);
  return { runs, feeds: new SourceFeedStore(pool, runs), drift: new SourceRunDriftReader(pool) };
}
