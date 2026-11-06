import { ERASURE_PARTICIPANTS, readErasureStatus, type ErasureStatus } from '../../access/erasure.ts';
import type { Pool } from 'pg';
import { routeOf } from '../../route/route.ts';

/** Custody owners this Zone/account cleanup observes. Semantic never acknowledges for them. */
export const ZONE_CLEANUP_PARTICIPANTS = Object.freeze(['content', 'library', 'auth', 'search'] as const);
export type ZoneCleanupParticipant = (typeof ZONE_CLEANUP_PARTICIPANTS)[number];
export type ZoneCleanupParticipantState = Readonly<{
  participant: ZoneCleanupParticipant;
  outcome: 'pending' | 'erased' | 'none' | 'missing';
}>;
export type ZoneCleanupCustody = Readonly<{
  accountId: string;
  complete: boolean;
  participants: readonly ZoneCleanupParticipantState[];
}>;

function listed(): readonly string[] {
  return ERASURE_PARTICIPANTS[1];
}

function outcomeOf(status: ErasureStatus | null, participant: ZoneCleanupParticipant): ZoneCleanupParticipantState {
  if (!status) return { participant, outcome: 'missing' };
  const recorded = status.participants[participant];
  if (!recorded) return { participant, outcome: 'missing' };
  if (recorded.outcome === 'pending') return { participant, outcome: 'pending' };
  if (recorded.outcome === 'erased') return { participant, outcome: 'erased' };
  return { participant, outcome: 'none' };
}

/** Independent readback of the adopted Content, Library, Auth and Search participants.
 * A missing or pending owner keeps cleanup incomplete; this function never writes an ACK. */
export async function readZoneCleanupParticipants(pool: Pool, accountId: string): Promise<ZoneCleanupCustody> {
  if (routeOf(accountId) === null) throw new TypeError('Zone cleanup participants need a routed account');
  for (const participant of ZONE_CLEANUP_PARTICIPANTS) {
    if (!listed().includes(participant)) throw new TypeError(`Erasure participant ${participant} is not registered`);
  }
  const status = await readErasureStatus(pool, accountId);
  const participants = ZONE_CLEANUP_PARTICIPANTS.map((participant) => outcomeOf(status, participant));
  return {
    accountId,
    complete: participants.every((row) => row.outcome === 'erased' || row.outcome === 'none'),
    participants,
  };
}
