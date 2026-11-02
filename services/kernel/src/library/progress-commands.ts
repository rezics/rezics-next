import type { CommandTransaction } from '../command/command.ts';
import type { ProgressSession, ProgressSessionUpdate } from './progress-model.ts';
import clearUnits from './progress-commands-clear-units.sql';

/** Clear is an exact, exclusive intent, never a new profiled value or a lifecycle transition. */
export function isProgressClear(record: Record<string, unknown>): boolean {
  return record.clear === true && Object.keys(record).length === 1;
}

/** The existing session writer owns authorization, subject/session locks, CAS and history. */
export async function clearProgressValues(
  client: CommandTransaction,
  route: number,
  session: ProgressSession,
): Promise<ProgressSessionUpdate> {
  if (session.mode === 'completed_units')
    await clearUnits.run({ query: client.query.bind(client) }, { route, session_id: session.id });
  return {
    amount: null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: session.state,
    completedAt: session.completedAt,
  };
}
