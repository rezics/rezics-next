import { assertNativeWorkTypeCombination, InvalidWorkSemanticTypes,
  normalizeWorkSemanticTypes } from './activate.ts';

export const WORK_TYPE_PROFILE = 'https://rezics.com/definition/work-type-v1';
export class WorkTypeConflict extends Error {}
/** The command admits only types with a reviewed structural or operational role. */
export const WORK_TYPE_OPTIONS = [
  'https://schema.org/Book', 'https://schema.org/DigitalDocument', 'https://schema.org/Recipe',
  'https://schema.org/SoftwareApplication', 'https://schema.org/SoftwareSourceCode',
  'https://rezics.com/vocab/ModPackage', 'https://rezics.com/vocab/SkillPackage',
  'https://rezics.com/vocab/PromptTemplate',
] as const;
export const WORK_TYPE_COST = { types: 3, graphCalls: 16, graphBytes: 2 * 1024 * 1024,
  deadlineMs: 10_000 } as const;

export function checkedWorkTypes(types: readonly string[]): string[] {
  const normalized = normalizeWorkSemanticTypes(types);
  if (normalized.some(type => !WORK_TYPE_OPTIONS.includes(type as typeof WORK_TYPE_OPTIONS[number]))) {
    throw new InvalidWorkSemanticTypes('unsupported Work type');
  }
  assertNativeWorkTypeCombination(normalized);
  return normalized;
}
