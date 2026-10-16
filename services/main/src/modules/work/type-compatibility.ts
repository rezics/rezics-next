import { nativeWorkTypeCompatibility } from '../../../../../packages/model/src/generated/types.ts';

/** A type without a declared combination is admitted on its own. */
const policy: { neutral: readonly string[]; combinations: readonly (readonly string[])[] } =
  nativeWorkTypeCompatibility;

export function nativeWorkTypesCompatible(types: readonly string[]): boolean {
  const specific = types.filter(type => !policy.neutral.includes(type));
  return specific.length <= 1 || policy.combinations.some(set => specific.every(type => set.includes(type)));
}
