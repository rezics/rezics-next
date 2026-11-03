import type { CommandTransaction } from '../command/command.ts';
import type { ProgressScalarMeasure, ProgressSession, ProgressSessionUpdate } from './progress-model.ts';
import clearUnits from './progress-commands-clear-units.sql';

/** Clear is an exact, exclusive intent, never a new profiled value or a lifecycle transition. */
export function isProgressClear(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return (
    record.clear === true &&
    keys.every((key) => key === 'clear' || key === 'measureId') &&
    (!Object.hasOwn(record, 'measureId') || typeof record.measureId === 'string')
  );
}

/** The existing session writer owns authorization, subject/session locks, CAS and history. */
export async function clearProgressValues(
  client: CommandTransaction,
  route: number,
  session: ProgressSession,
  measureId?: string,
): Promise<ProgressSessionUpdate> {
  if (measureId !== undefined) {
    if (session.mode !== 'scalar_amount') throw new TypeError('Only scalar progress measures can be cleared separately');
    if (measureId === session.unit)
      return {
        amount: null,
        locator: session.locator,
        position: session.position,
        completedUnitCount: session.completedUnitCount,
        state: session.state,
        completedAt: session.completedAt,
        ...(session.measures === undefined
          ? {}
          : {
              measures: session.measures.map((measure) =>
                measure.unit === measureId ? { ...measure, amount: null } : measure,
              ),
            }),
      };
    const measures: ProgressScalarMeasure[] | undefined = session.measures?.map((measure) =>
      measure.unit === measureId ? { ...measure, amount: null } : measure,
    );
    if (!measures?.some((measure) => measure.unit === measureId)) throw new TypeError('Unknown progress measure');
    return {
      amount: session.amount,
      locator: session.locator,
      position: session.position,
      completedUnitCount: session.completedUnitCount,
      state: session.state,
      completedAt: session.completedAt,
      measures,
    };
  }
  if (session.mode === 'completed_units')
    await clearUnits.run({ query: client.query.bind(client) }, { route, session_id: session.id });
  return {
    amount: null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: session.state,
    completedAt: session.completedAt,
    ...(session.measures === undefined
      ? {}
      : { measures: session.measures.map((measure) => ({ ...measure, amount: null })) }),
  };
}
