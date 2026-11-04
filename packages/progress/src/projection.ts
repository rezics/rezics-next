import type { ProgressMode, ProgressOutcome, ProgressRecord, ProgressState } from './intent.ts';
import type { ProgressScalarMeasure } from './values.ts';

/** The editable facts of one occurrence. Identity, revision and profile pin belong to its owner. */
export type ProgressValues = Readonly<{
  mode: ProgressMode;
  unit: string;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: ProgressState;
  completedAt: string | null;
  measures?: readonly ProgressScalarMeasure[];
}>;
export type ProgressValueUpdate = {
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: ProgressState;
  completedAt: string | null;
  measures?: ProgressScalarMeasure[];
};

/** Clear is exclusive. An empty value, a zero and an omitted property never imply this intent. */
export function isProgressClear(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return (
    record.clear === true &&
    keys.every((key) => key === 'clear' || key === 'measureId') &&
    (!Object.hasOwn(record, 'measureId') || typeof record.measureId === 'string')
  );
}

function copyValues(current: ProgressValues): ProgressValueUpdate {
  return {
    amount: current.amount,
    locator: current.locator,
    position: current.position,
    completedUnitCount: current.completedUnitCount,
    state: current.state,
    completedAt: current.completedAt,
    ...(current.measures === undefined ? {} : { measures: current.measures.map((measure) => ({ ...measure })) }),
  };
}

/** Project a clear after native admission. The sparse-set adapter removes rows separately. */
export function clearedProgressValues(
  current: ProgressValues,
  measureId?: string,
): ProgressOutcome<ProgressValueUpdate> {
  const next = copyValues(current);
  if (measureId !== undefined) {
    if (current.mode !== 'scalar_amount') return { ok: false, field: 'measureId' };
    if (measureId !== current.unit && !current.measures?.some((measure) => measure.unit === measureId))
      return { ok: false, field: 'measureId' };
    if (measureId === current.unit) next.amount = null;
    if (next.measures)
      next.measures = next.measures.map((measure) =>
        measure.unit === measureId ? { ...measure, amount: null } : measure,
      );
    return { ok: true, value: next };
  }
  next.amount = null;
  next.locator = null;
  next.position = null;
  next.completedUnitCount = 0;
  if (next.measures) next.measures = next.measures.map((measure) => ({ ...measure, amount: null }));
  return { ok: true, value: next };
}

/** Project validated scalar/cursor values. Completed-unit membership is a native fact, never inferred from IDs. */
export function recordedProgressValues(
  current: ProgressValues,
  record: ProgressRecord,
  measureId?: string,
): ProgressOutcome<ProgressValueUpdate> {
  const next = copyValues(current);
  if (current.state !== 'active') return { ok: false, field: 'state' };
  if ('amount' in record) {
    if (current.mode !== 'scalar_amount') return { ok: false, field: 'mode' };
    if (
      measureId !== undefined &&
      measureId !== current.unit &&
      !current.measures?.some((measure) => measure.unit === measureId)
    )
      return { ok: false, field: 'measureId' };
    if (measureId === undefined || measureId === current.unit) next.amount = record.amount;
    // The primary amount has its existing native column; sibling measures retain independent values and totals.
    if (measureId !== undefined && measureId !== current.unit && next.measures)
      next.measures = next.measures.map((measure) =>
        measure.unit === measureId ? { ...measure, amount: record.amount } : measure,
      );
    return { ok: true, value: next };
  }
  if ('locator' in record) {
    if (current.mode !== 'cursor_position' || measureId !== undefined) return { ok: false, field: 'mode' };
    next.locator = record.locator;
    next.position = record.position;
    return { ok: true, value: next };
  }
  return { ok: false, field: 'completedUnitCount' };
}
