import type { PropertyDefinition, Release } from '@rezics/definitions';
import { checkSubjectRelease } from '@rezics/definitions/validate';
export type { ItemTarget } from '@rezics/definitions/validate';

// Single-subject writes accept authored documents; media still needs the bulk content hook.
export const rejectContent = (property: PropertyDefinition) => property.datatype === 'media';

// Bulk facts retain their original rule; only sourced summary and cover installs opt out.
export const rejectBulkContent = (property: PropertyDefinition) =>
  property.datatype === 'document' || property.datatype === 'media';

export function checkTyped(release: Release, _digest: string, input: unknown) {
  return checkSubjectRelease(input, release, rejectContent, false, true);
}
