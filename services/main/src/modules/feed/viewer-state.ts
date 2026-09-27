import type { ReadPosition } from '../work/read-session.ts';
import type { FeedViewerState } from './contract.ts';
import type { FeedReader } from './read.ts';

/** G-285 owns the private shelves/progress/spoiler batch and its disclosure
 * fences. Keys are requested activity IDs; absent entries mean unavailable.
 * The feed passes at most eight admitted public cards, never anonymous readers. */
export interface FeedViewerStateReader {
  read(reader: FeedReader, targets: readonly { activity: string; work: string | null; occurrence?: string }[],
    position: ReadPosition): Promise<ReadonlyMap<string, Extract<FeedViewerState, { status: 'available' }>>>;
}
