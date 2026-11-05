import { releaseDigest, type Release } from '@rezics/definitions';
import type { RelationTypeDescriptorReader } from '../../subject/relation-candidates';

/** Test-only adapter that gives recorded full releases the exact descriptor shape used by the Web editor. */
export function relationDescriptorReader(release: Release): RelationTypeDescriptorReader {
  const digest = releaseDigest(release);
  return async (typeId) => {
    const definition = release.types[typeId];
    if (!definition) return { ok: false, reason: 'missing' };
    const ids = new Set(definition.properties);
    for (const id of definition.properties) {
      const property = release.properties[id];
      if (!property) return { ok: false, reason: 'unavailable' };
      property.qualifiers.forEach((qualifier) => ids.add(qualifier));
    }
    const properties = Object.fromEntries(
      [...ids].flatMap((id) => (release.properties[id] ? [[id, release.properties[id]]] : [])),
    );
    if ([...ids].some((id) => !properties[id])) return { ok: false, reason: 'unavailable' };
    return {
      ok: true,
      descriptor: { typeId, releaseDigest: digest, definition, properties },
    };
  };
}
