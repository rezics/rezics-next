import { releaseDigest } from './release-digest.ts';
import type {
  PropertyDefinition,
  RelationDirection,
  Release,
  ReleasedRelationDirectionFailure,
  ReleasedRelationDirectionResult,
  ReleasedRelationQualifierMeaning,
} from './portable.ts';

export type ReleasedRelationDirectionKind = RelationDirection;

export type ReleasedRelationDirectionResolver = {
  release: string | null;
  resolve(
    subjectType: string,
    property: string,
    direction: ReleasedRelationDirectionKind,
    options?: { viaQualifier?: string },
  ): ReleasedRelationDirectionResult;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function subtype(release: Release, type: string, base: string, seen = new Set<string>()): boolean {
  if (type === base) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((candidate) => subtype(release, candidate, base, seen));
}

/** Build one bounded index over a pinned release for page, Search and list-context producers. */
export function createReleasedRelationDirectionResolver(
  release: Release | undefined,
  digest: string | undefined,
): ReleasedRelationDirectionResolver {
  if (!release || !digest)
    return {
      release: null,
      resolve: (_subjectType, property, direction) => ({
        state: 'unavailable',
        property,
        direction,
        release: null,
        reason: 'missing-release-pin',
      }),
    };

  let pinned = false;
  try {
    pinned = releaseDigest(release) === digest;
  } catch {
    pinned = false;
  }
  const sources = new Map<string, string[]>();
  for (const [type, definition] of Object.entries(release.types))
    for (const property of definition.properties) {
      const owners = sources.get(property) ?? [];
      owners.push(type);
      sources.set(property, owners);
    }
  const inverses = new Map<string, string[]>();
  for (const [property, definition] of Object.entries(release.properties)) {
    const inverse = definition.relation?.inverse;
    if (!inverse) continue;
    const owners = inverses.get(inverse) ?? [];
    owners.push(property);
    inverses.set(inverse, owners);
  }

  const failure = (
    property: string,
    direction: ReleasedRelationDirectionKind,
    reason: ReleasedRelationDirectionFailure['reason'],
    state: ReleasedRelationDirectionFailure['state'] = 'unsupported',
  ): ReleasedRelationDirectionFailure => ({ state, property, direction, release: digest, reason });

  const resolver: ReleasedRelationDirectionResolver = {
    release: digest,
    resolve(subjectType, requestedProperty, direction, options = {}) {
      if (!pinned) return failure(requestedProperty, direction, 'stale-release', 'unavailable');
      if (!release.types[subjectType]) return failure(requestedProperty, direction, 'inapplicable-type');

      const direct = release.properties[requestedProperty];
      let propertyId = requestedProperty;
      let property: PropertyDefinition | undefined = direct;
      if (direction === 'inverse' && !direct) {
        const candidates = inverses.get(requestedProperty) ?? [];
        if (candidates.length > 1) return failure(requestedProperty, direction, 'ambiguous-inverse');
        propertyId = candidates[0] ?? '';
        property = propertyId ? release.properties[propertyId] : undefined;
      }
      if (!property)
        return failure(requestedProperty, direction, direction === 'inverse' ? 'missing-inverse' : 'missing-property');
      if (property.datatype !== 'wikibase-item' || !property.relation)
        return failure(requestedProperty, direction, 'stale-descriptor', 'unavailable');

      const inverse = property.relation.inverse;
      if (direction === 'inverse') {
        if (direct && (inverses.get(requestedProperty) ?? []).length)
          return failure(requestedProperty, direction, 'ambiguous-inverse');
        if (!inverse) return failure(requestedProperty, direction, 'missing-inverse');
        if (direct && requestedProperty !== propertyId)
          return failure(requestedProperty, direction, 'ambiguous-inverse');
        const aliases = inverses.get(inverse) ?? [];
        if (aliases.length !== 1 || aliases[0] !== propertyId || release.properties[inverse])
          return failure(requestedProperty, direction, 'ambiguous-inverse');
        if (!record(property.relation.inverseLabels) || !Object.keys(property.relation.inverseLabels).length)
          return failure(requestedProperty, direction, 'missing-inverse');
      }

      const sourceTypes = [...(sources.get(propertyId) ?? [])].sort();
      const targetTypes = [...(property.targets ?? [])].sort();
      if (!sourceTypes.length || !targetTypes.length || targetTypes.some((type) => !release.types[type]))
        return failure(requestedProperty, direction, 'stale-descriptor', 'unavailable');
      if (direction === 'forward' && !sourceTypes.some((type) => subtype(release, subjectType, type)))
        return failure(requestedProperty, direction, 'inapplicable-type');

      let viaQualifier: string | undefined;
      if (direction === 'inverse') {
        if (options.viaQualifier !== undefined) {
          const qualifier = release.properties[options.viaQualifier];
          if (
            !property.qualifiers.includes(options.viaQualifier) ||
            !qualifier ||
            qualifier.datatype !== 'wikibase-item' ||
            !qualifier.targets?.length ||
            !qualifier.targets.some((type) => release.types[type] && subtype(release, subjectType, type))
          )
            return failure(requestedProperty, direction, 'inapplicable-type');
          viaQualifier = options.viaQualifier;
        } else if (!targetTypes.some((type) => subtype(release, subjectType, type))) {
          return failure(requestedProperty, direction, 'inapplicable-type');
        }
      }

      const qualifiers: ReleasedRelationQualifierMeaning[] = [];
      for (const id of property.qualifiers) {
        const qualifier = release.properties[id];
        if (!qualifier) return failure(requestedProperty, direction, 'stale-descriptor', 'unavailable');
        qualifiers.push({ id, datatype: qualifier.datatype, labels: qualifier.labels });
      }
      return {
        state: 'admitted',
        property: propertyId,
        direction,
        inverse: inverse ?? null,
        sourceTypes,
        targetTypes,
        ...(viaQualifier === undefined ? {} : { viaQualifier }),
        release: digest,
        qualifiers,
      };
    },
  };
  return resolver;
}
