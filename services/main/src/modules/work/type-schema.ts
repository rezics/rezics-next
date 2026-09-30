import { creatableWorkTypeOptions } from '../types/registry.ts';
import {
  assertNativeWorkTypeCombination,
  InvalidWorkSemanticTypes,
  normalizeWorkSemanticTypes,
} from './activate.ts';

export const WORK_TYPE_PROFILE = 'https://rezics.com/definition/work-type-v3';
export class WorkTypeConflict extends Error {}
/** Native type edits admit live descriptive registry entries. */
export const WORK_TYPE_OPTIONS = creatableWorkTypeOptions;
export const WORK_TYPE_OPTIONS_V1 = WORK_TYPE_OPTIONS.filter(
  (type) => type !== 'https://schema.org/VideoGame',
);
export const WORK_TYPE_COST = {
  types: 3,
  graphCalls: 16,
  graphBytes: 2 * 1024 * 1024,
  deadlineMs: 10_000,
} as const;

export function checkedWorkTypes(types: readonly string[]): string[] {
  const normalized = normalizeWorkSemanticTypes(types);
  if (
    normalized.some(
      (type) => !WORK_TYPE_OPTIONS.includes(type as (typeof WORK_TYPE_OPTIONS)[number]),
    )
  ) {
    throw new InvalidWorkSemanticTypes('unsupported Work type');
  }
  assertNativeWorkTypeCombination(normalized);
  return normalized;
}
