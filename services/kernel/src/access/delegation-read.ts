import { systemClock, type KernelClock } from '../clock.ts';
import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { throwAccessUnavailable } from './unavailable.ts';
import { accessNativeWork, type AccessWorkAccounting } from './work.ts';
import readStatement from './delegation-read.sql';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const referencePattern = new RegExp(`^urn:rezics:request:(${uuid}):(${uuid})$`);
export type AssignmentEvidence =
  | { kind: 'none' }
  | { kind: 'unresolved' }
  | { kind: 'resolved'; principalId: string; assignedActorId: string; requestId: string; valid: string };

/** Separately anchored point read for trusted Auth issuance and other Access
 * consumers. A present but unresolvable principal never becomes absence.
 */
export async function readAssignment(
  client: AccessClient,
  requestedBy: string | null,
  assignedActorId: string,
  clock: KernelClock = systemClock,
  work?: AccessWorkAccounting,
): Promise<AssignmentEvidence> {
  if (requestedBy === null) return { kind: 'none' };
  const match = typeof requestedBy === 'string' ? referencePattern.exec(requestedBy) : null;
  if (!match || match[0] !== requestedBy || routeOf(assignedActorId) === null) return { kind: 'unresolved' };
  try {
    const input = {
      route: routeOf(match[1]!)!,
      principal_id: match[1]!,
      request_id: match[2]!,
      actor_id: assignedActorId,
      at: clock().toISOString(),
    };
    const row = await accessNativeWork(work, 'assignment', input, {}, () => readStatement.run(client, input));
    if (!row) return { kind: 'unresolved' };
    return { kind: 'resolved', principalId: match[1]!, assignedActorId, requestId: match[2]!, valid: row.valid };
  } catch (error) {
    throwAccessUnavailable(error);
    return { kind: 'unresolved' };
  }
}
