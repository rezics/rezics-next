import type { FilterDocument } from '@rezics/filter';

export type ConditionDirection = 'direct' | 'inverse';
type StatementCondition = Extract<FilterDocument, { statement: unknown }>;

export function conditionDirection(statement: StatementCondition['statement']): ConditionDirection {
  return 'inverse' in statement && statement.inverse === true ? 'inverse' : 'direct';
}

/** Change only traversal direction; the selected operands and same-statement qualifiers stay attached. */
export function changeConditionDirection(value: StatementCondition, direction: ConditionDirection): StatementCondition {
  const statement = value.statement;
  if (direction === 'inverse' && !('in' in statement)) return value;
  if (direction === 'inverse') return { statement: { ...statement, inverse: true } };
  if (!('inverse' in statement) || statement.inverse !== true) return value;
  const direct = { ...statement };
  delete direct.inverse;
  return { statement: direct };
}
