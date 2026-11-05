import type { Release } from '@rezics/definitions';
import { correctionProperty } from './statement-editor';
import type { FactsCurrent } from './subject-facts';

/** Effective native datatypes and code patterns, in Type order; never a provider inventory. */
export function identifierProperties(release: Pick<Release, 'types' | 'properties'>, type: string): string[] {
  return (release.types[type]?.properties ?? []).filter((id) => {
    if (!correctionProperty(release, type, id)) return false;
    const property = release.properties[id]!;
    return (
      property.datatype === 'external-id' ||
      property.datatype === 'url' ||
      (property.datatype === 'string' &&
        'pattern' in property.value &&
        typeof property.value.pattern === 'string' &&
        property.value.pattern.length > 0)
    );
  });
}

export function identifierFields(read: FactsCurrent): string[] {
  return identifierProperties(read.release, read.public.subject.type);
}
