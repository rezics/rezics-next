import {
  createReleasedRelationDirectionResolver,
  type Release,
  type ReleasedRelationDirectionResult,
} from '@rezics/definitions';
import { facetProperties } from '@rezics/filter';

export type CataloguePageDefinitions = Pick<Release, 'types' | 'properties'>;
export type CataloguePageMetadata = {
  state: 'released' | 'unsupported' | 'unavailable';
  type: string;
  digest?: string;
  definitions?: CataloguePageDefinitions;
  directions?: ReleasedRelationDirectionResult[];
};

const catalogueFileTypes = ['schema:MediaObject', 'rezics:CatalogueFile', 'wd:Q82753'];
const catalogueGroupTypes = ['rezics:ReleaseGroup', 'wd:Q55327'];
const catalogueMusicTypes = ['schema:MusicAlbum', 'schema:MusicRelease', 'schema:MusicRecording'];
const catalogueCharacterTypes = ['wd:Q95074'];
const cataloguePeopleTypes = ['schema:Person', 'schema:Organization'];
const catalogueReleaseTypes = ['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'];
const catalogueLiteraryTypes = ['schema:Book', 'schema:BookSeries', 'bf:Instance'];

function typeIsA(release: CataloguePageDefinitions, type: string, base: string, seen = new Set<string>()): boolean {
  if (type === base) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((candidate) => typeIsA(release, candidate, base, seen));
}

/** Person and Organization, including descendants, admit biography and producer history on the ordinary page. */
export function peopleProducerTypeAdmitted(release: CataloguePageDefinitions | undefined, type: string) {
  return cataloguePeopleTypes.some((base) => release !== undefined && typeIsA(release, type, base));
}

/** Carry the bounded current release closure for existing page readers and inherited CreativeWork tags. */
export function cataloguePageMetadata(
  release: Release | undefined,
  digest: string | undefined,
  type: string,
): CataloguePageMetadata | undefined {
  const candidate = [
    ...catalogueFileTypes,
    ...catalogueGroupTypes,
    ...catalogueMusicTypes,
    ...catalogueCharacterTypes,
    ...cataloguePeopleTypes,
    ...catalogueReleaseTypes,
    ...catalogueLiteraryTypes,
  ].includes(type);
  const file = catalogueFileTypes.some((base) => release && typeIsA(release, type, base));
  const group = catalogueGroupTypes.some((base) => release && typeIsA(release, type, base));
  const music = catalogueMusicTypes.some((base) => release && typeIsA(release, type, base));
  const character = catalogueCharacterTypes.some((base) => release && typeIsA(release, type, base));
  const people = peopleProducerTypeAdmitted(release, type);
  const catalogueRelease = catalogueReleaseTypes.some((base) => release && typeIsA(release, type, base));
  const literary = catalogueLiteraryTypes.some((base) => release && typeIsA(release, type, base));
  const work = release !== undefined && typeIsA(release, type, 'schema:CreativeWork');
  if (!candidate && !file && !group && !music && !people && !catalogueRelease && !literary && !work) return;
  if (!release || !digest) return { state: 'unavailable', type, directions: [] };
  if (
    !release.types[type] ||
    (!file && !group && !music && !character && !people && !catalogueRelease && !literary && !work)
  )
    return { state: 'unsupported', type, digest, directions: [] };

  const hierarchy = new Set<string>();
  const addHierarchy = (id: string) => {
    if (hierarchy.has(id) || !release.types[id]) return;
    hierarchy.add(id);
    for (const base of release.types[id]?.bases ?? []) addHierarchy(base);
  };
  addHierarchy(type);

  const facetIds = facetProperties(release, [...hierarchy]);
  const propertyIds = new Set([...(release.types[type]?.properties ?? []), ...facetIds]);
  const inversePropertyIds = new Set<string>();
  for (const [id, property] of Object.entries(release.properties)) {
    if (property.relation && (property.targets ?? []).some((target) => typeIsA(release, type, target))) {
      propertyIds.add(id);
      inversePropertyIds.add(id);
    }
  }
  const pendingProperties = [...propertyIds];
  for (let index = 0; index < pendingProperties.length; index++)
    for (const qualifier of release.properties[pendingProperties[index]!]?.qualifiers ?? [])
      if (!propertyIds.has(qualifier)) {
        propertyIds.add(qualifier);
        pendingProperties.push(qualifier);
      }
  const properties = Object.fromEntries(
    [...propertyIds].flatMap((id) => (release.properties[id] ? [[id, release.properties[id]]] : [])),
  );
  const resolveDirection = createReleasedRelationDirectionResolver(release, digest);
  const directionProperties = new Set([...release.types[type]!.properties, ...facetIds, ...inversePropertyIds]);
  const directions = [...directionProperties]
    .filter((id) => release.properties[id]?.relation)
    .sort()
    .flatMap((id) => [
      ...(inversePropertyIds.has(id) ? [resolveDirection.resolve(type, id, 'inverse')] : []),
      ...(release.types[type]!.properties.includes(id) || facetIds.includes(id)
        ? [resolveDirection.resolve(type, id, 'forward')]
        : []),
    ]);
  const types = new Set<string>(hierarchy);
  const addType = (id: string) => {
    if (types.has(id) || !release.types[id]) return;
    types.add(id);
    for (const base of release.types[id]?.bases ?? []) addType(base);
  };
  for (const property of Object.values(properties)) for (const target of property.targets ?? []) addType(target);
  for (const [owner, definition] of Object.entries(release.types))
    if ((definition.properties ?? []).some((id) => inversePropertyIds.has(id))) addType(owner);
  const typeDefinitions = Object.fromEntries(
    [...types].flatMap((id) => (release.types[id] ? [[id, release.types[id]]] : [])),
  );
  return {
    state: 'released',
    type,
    digest,
    directions,
    definitions: { types: typeDefinitions, properties },
  };
}
