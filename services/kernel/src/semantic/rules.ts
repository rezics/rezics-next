import type { PropertyDefinition, Release } from '@rezics/definitions';
import { checkSubjectRelease } from '@rezics/definitions/validate';
export type { ItemTarget } from '@rezics/definitions/validate';

// Content's write hooks are not yet wired into semantic writes.
export const rejectContent = (property: PropertyDefinition) =>
  property.datatype === 'document' || property.datatype === 'media';

export function checkTyped(release: Release, _digest: string, input: unknown) {
  return checkSubjectRelease(input, release, rejectContent);
}
