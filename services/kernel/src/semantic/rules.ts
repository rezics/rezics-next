import type { PropertyDefinition, Release } from '@rezics/definitions';
import { checkSubjectRelease } from '@rezics/definitions/validate';
export type { ItemTarget } from '@rezics/definitions/validate';

// Single-subject writes and single-statement routes reject document and media.
// A sourced bulk summary or cover opts out and stores content's reference instead.
export const rejectContent = (property: PropertyDefinition) =>
  property.datatype === 'document' || property.datatype === 'media';

export function checkTyped(release: Release, _digest: string, input: unknown) {
  return checkSubjectRelease(input, release, rejectContent);
}
