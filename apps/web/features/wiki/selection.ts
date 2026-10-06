import type { ZonePackage } from '@rezics/zone-sdk';
import { parsePosition, type PositionChoice } from './position.ts';
import { positionOf, type PositionState } from './state.ts';
import { type ZoneContinuity, zoneContinuity } from './zone-continuity.ts';

type Search = Record<string, string | string[] | undefined>;

/** What a Zone reads at the reader's position and continuity, in the data the package declares. */
export type ZoneData = Pick<ZonePackage, 'positions' | 'continuity'>;

/**
 * The reader's chosen position and continuity for a Zone page. It follows the package's declarations whether or not
 * its presentation runs, so safe mode and the standard look change how the page looks, never what it shows.
 */
export async function readingSelection(data: ZoneData | null, zone: string, search: Search):
  Promise<{ choice: PositionChoice; state: PositionState | null; reading: ZoneContinuity | null }> {
  const choice = parsePosition(search);
  const state = await positionOf(data, zone, choice);
  return { choice, state, reading: await zoneContinuity(data, state, search) };
}
