import { clearedProgressValues } from '@rezics/progress';
import type { CommandTransaction } from '../command/command.ts';
import type { ProgressSession, ProgressSessionUpdate } from './progress-model.ts';
import { sessionUnitClearPlan } from './session-operation-bounds.ts';

export { isProgressClear } from '@rezics/progress';

/** The existing writer owns authority, locks, CAS, sparse-set effects and history. */
export async function clearProgressValues(
  client: CommandTransaction,
  route: number,
  session: ProgressSession,
  measureId?: string,
): Promise<ProgressSessionUpdate> {
  const projected = clearedProgressValues(session, measureId);
  if (!projected.ok) throw new TypeError('Unknown progress measure');
  if (measureId === undefined && session.mode === 'completed_units')
    await sessionUnitClearPlan({ route, session_id: session.id }).run(client);
  return projected.value;
}
