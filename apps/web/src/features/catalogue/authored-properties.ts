import type { Release } from '@rezics/definitions';

export function authoredProperties(release: Release, type: string): string[] {
  return (release.types[type]?.properties ?? []).filter((id) => release.properties[id]?.datatype === 'document');
}
