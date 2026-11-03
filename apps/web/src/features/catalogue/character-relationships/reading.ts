import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { candidateContext, candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import type { CurrentTypeDescriptor, CurrentTypeRead } from '../type-directory-client';
import { characterType, characterUuid } from '../character-profile';

type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
type InversePage = NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>;

export const appearanceProperty = 'schema:character';
export const voiceProperty = 'wdt:P725';
export const voiceCharacterSlot = 'wdt:P453';
export const spoilerProperty = 'rezics:spoilerLevel';
export const appearanceRoleProperty = 'wdt:P3831';
const pageLimit = 20;
const descriptorConcurrency = 4;

export type CharacterAssociationKind = 'appearance' | 'voice' | 'relationship';
export type UnavailableConfigurationId = 'age-at-appearance' | 'main-character-linkage' | 'character-relationship';
export type CharacterAssociationStream = {
  key: string;
  kind: CharacterAssociationKind;
  property: string;
  direction: 'forward' | 'inverse';
  label: { text: string; lang: string | null };
  slotKey?: string;
  filter?: string;
};
export type CharacterAssociationRow = {
  holder: string;
  statementId: string;
  statement?: ForwardPage['relations'][number]['statement'];
  summary: ForwardPage['relations'][number]['summary'] | null;
  related: SubjectRead['related'];
  holderType?: string | undefined;
};
export type CharacterAssociationLabels = Record<string, ReturnType<typeof pickText>>;
export type UnavailableConfiguration = { id: UnavailableConfigurationId; admitted: false };
export type IndependentlyUnreadable = { key: string; reason: CandidateFailure['reason'] };
export type CharacterRelationshipsAddress = {
  id: string;
  stream?: string | undefined;
  cursor?: string | undefined;
  work?: string | undefined;
};
export type CharacterRelationshipsRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      streams: CharacterAssociationStream[];
      stream?: CharacterAssociationStream;
      rows: CharacterAssociationRow[];
      labels: CharacterAssociationLabels;
      next: string | null;
      count?: ForwardPage['count'];
      caughtUp: boolean;
      session?: string;
      unavailable: UnavailableConfiguration[];
      descriptors: Record<string, CurrentTypeRead>;
      independentlyUnreadable?: IndependentlyUnreadable;
    };

function isType(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

function targetsCharacter(property: PropertyDefinition | undefined, release: Definitions): boolean {
  return !!property?.targets?.some((target) => isType(release, characterType, target) || isType(release, target, characterType));
}

/** Quantity appearance qualifiers that are not spoiler stay on that exact work statement. */
export function isAppearanceMeasureQualifier(
  propertyId: string,
  properties: Record<string, PropertyDefinition | undefined>,
): boolean {
  const property = properties[propertyId];
  return property?.datatype === 'quantity' && propertyId !== spoilerProperty;
}

export function unavailableConfigurations(release: Definitions): UnavailableConfiguration[] {
  const appearance = release.properties[appearanceProperty];
  const unavailable: UnavailableConfiguration[] = [];
  const ageAdmitted = appearance?.qualifiers.some((id) => isAppearanceMeasureQualifier(id, release.properties));
  if (!ageAdmitted) unavailable.push({ id: 'age-at-appearance', admitted: false });
  const relationships = Object.entries(release.properties).some(([, property]) => {
    const group = property.relation?.group;
    return (
      property.datatype === 'wikibase-item' &&
      (group === 'association' || group === 'world') &&
      targetsCharacter(property, release)
    );
  });
  if (!relationships) unavailable.push({ id: 'character-relationship', admitted: false });
  // Related-character identity (VNDB main) is omitted from the current release; appearance role remains wdt:P3831.
  unavailable.push({ id: 'main-character-linkage', admitted: false });
  return unavailable;
}

/** Directions and kind come from the current emitted definitions; nothing is inferred from a source name. */
export function characterAssociationStreams(
  release: Definitions,
  type: string,
  locale: string,
  characterId: string,
): CharacterAssociationStream[] {
  if (type !== characterType) return [];
  const streams: CharacterAssociationStream[] = [];
  const appearance = release.properties[appearanceProperty];
  if (appearance?.datatype === 'wikibase-item' && appearance.relation?.group === 'appearance') {
    streams.push({
      key: `inverse:${appearanceProperty}`,
      kind: 'appearance',
      property: appearanceProperty,
      direction: 'inverse',
      label: pickText(appearance.relation.inverseLabels ?? appearance.labels, locale),
    });
  }
  const voice = release.properties[voiceProperty];
  if (
    voice?.datatype === 'wikibase-item' &&
    voice.relation?.group === 'credit' &&
    (voice.relation.slotKey === voiceCharacterSlot || voice.qualifiers.includes(voiceCharacterSlot))
  ) {
    streams.push({
      key: `inverse:${voiceProperty}`,
      kind: 'voice',
      property: voiceProperty,
      direction: 'inverse',
      label: pickText(voice.relation.inverseLabels ?? voice.labels, locale),
      ...(voice.relation.slotKey ? { slotKey: voice.relation.slotKey } : {}),
      filter: characterId,
    });
  }
  for (const [id, property] of Object.entries(release.properties)) {
    const relation = property.relation;
    if (
      !relation ||
      property.datatype !== 'wikibase-item' ||
      (relation.group !== 'association' && relation.group !== 'world') ||
      !targetsCharacter(property, release)
    )
      continue;
    const forward = release.types[type]?.properties.includes(id);
    const inverse =
      relation.inverse &&
      relation.inverse !== 'none' &&
      (relation.symmetric || targetsCharacter(property, release));
    if (forward) {
      streams.push({
        key: `forward:${id}`,
        kind: 'relationship',
        property: id,
        direction: 'forward',
        label: pickText(property.labels, locale),
        ...(relation.slotKey ? { slotKey: relation.slotKey } : {}),
      });
    }
    if (inverse && (!forward || !relation.symmetric)) {
      streams.push({
        key: `inverse:${id}`,
        kind: 'relationship',
        property: id,
        direction: 'inverse',
        label: pickText(relation.inverseLabels ?? property.labels, locale),
        ...(relation.slotKey ? { slotKey: relation.slotKey } : {}),
      });
    }
  }
  return streams;
}

export function associationLabels(
  release: Definitions,
  rows: CharacterAssociationRow[],
  locale: string,
): CharacterAssociationLabels {
  const labels: CharacterAssociationLabels = {};
  for (const row of rows) {
    if (!row.statement) continue;
    for (const snak of [
      row.statement,
      ...row.statement.qualifiers,
      ...row.statement.references.flatMap((reference) => reference.parts),
    ]) {
      const property = release.properties[snak.property.id];
      if (property) labels[snak.property.id] = pickText(property.labels, locale);
    }
  }
  return labels;
}

export function streamKindGroup(kind: CharacterAssociationKind): 'appearances' | 'relationships' | 'voice' {
  if (kind === 'appearance') return 'appearances';
  if (kind === 'voice') return 'voice';
  return 'relationships';
}

/** Qualifiers admitted on this holder Type for the selected appearance or credit property. */
export function admittedQualifiers(
  descriptor: CurrentTypeDescriptor | undefined,
  property: string,
): readonly string[] {
  return descriptor?.properties[property]?.qualifiers ?? [];
}

export function isCurrentCharacterRelationshipsRead(
  read: CharacterRelationshipsRead | undefined,
  query: { isSuccess: boolean; isFetching: boolean },
  address: CharacterRelationshipsAddress,
): read is Extract<CharacterRelationshipsRead, { ok: true }> {
  return (
    query.isSuccess &&
    !query.isFetching &&
    read?.ok === true &&
    read.public.subject.id === address.id &&
    read.public.subject.type === characterType &&
    (address.stream === undefined || read.stream?.key === address.stream)
  );
}

function relatedMap(
  values: ForwardPage['relations'][number]['related'] | InversePage['links'][number]['related'],
): SubjectRead['related'] {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, summary]) => [
      key,
      {
        type: summary.type,
        labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
      },
    ]),
  );
}

function pageRows(id: string, page: ForwardPage | InversePage): CharacterAssociationRow[] {
  if ('relations' in page) {
    return page.relations.map((row) => ({
      holder: id,
      statementId: row.statement.id,
      statement: row.statement,
      summary: row.summary,
      related: relatedMap(row.related),
      holderType: row.summary?.type,
    }));
  }
  return page.links.map((row) => ({
    holder: row.subject,
    statementId: row.statement,
    ...(row.assertion ? { statement: row.assertion } : {}),
    summary: row.summary,
    related: relatedMap(row.related),
    holderType: row.summary?.type ?? row.type,
  }));
}

/** Deduplicate within this page and allow four concurrent exact Type reads; retain no descriptor between calls. */
export async function admitAssociationDescriptors(
  types: readonly string[],
  read: (typeId: string) => Promise<CurrentTypeRead>,
): Promise<Record<string, CurrentTypeRead>> {
  const unique = [...new Set(types.filter((type) => typeof type === 'string' && type.length > 0))];
  const descriptors: Record<string, CurrentTypeRead> = {};
  for (let index = 0; index < unique.length; index += descriptorConcurrency) {
    const batch = unique.slice(index, index + descriptorConcurrency);
    const reads = await Promise.all(
      batch.map(async (typeId) => {
        try {
          return [typeId, await read(typeId)] as const;
        } catch {
          return [typeId, { ok: false as const, reason: 'unavailable' as const }] as const;
        }
      }),
    );
    for (const [typeId, result] of reads) descriptors[typeId] = result;
  }
  return descriptors;
}

export async function readCharacterRelationships(
  client: KernelClient,
  authorization: string,
  release: Definitions | Promise<Definitions>,
  id: string,
  locale: string,
  streamKey?: string,
  cursor?: string,
  session?: string,
  workType?: (typeId: string) => Promise<CurrentTypeRead>,
): Promise<CharacterRelationshipsRead> {
  if (!characterUuid.test(id) || (streamKey !== undefined && (streamKey.length === 0 || streamKey.length > 256)))
    return candidateFailure(400);
  if (cursor && !streamKey) return candidateFailure(400);
  try {
    const headers = { authorization, ...(session ? { 'rezics-session-token': session } : {}) };
    const [current, definitions] = await Promise.all([client.subjects({ id }).get({ headers }), release]);
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id || current.data.subject.context !== candidateContext)
      return candidateFailure(400);
    if (current.data.subject.type !== characterType) return candidateFailure(400);
    const streams = characterAssociationStreams(definitions, current.data.subject.type, locale, id);
    const stream = streamKey ? streams.find((item) => item.key === streamKey) : streams[0];
    if (streamKey && !stream) return candidateFailure(400);
    const unavailable = unavailableConfigurations(definitions);
    if (!stream) {
      return {
        ok: true,
        public: current.data,
        streams,
        rows: [],
        labels: {},
        next: null,
        caughtUp: true,
        unavailable,
        descriptors: {},
      };
    }
    const query = {
      property: stream.property,
      context: candidateContext,
      language: locale,
      limit: pageLimit,
      ...(stream.filter ? { filter: stream.filter } : {}),
      ...(cursor ? { cursor } : {}),
    };
    let independentlyUnreadable: IndependentlyUnreadable | undefined;
    let page: ForwardPage | InversePage | undefined;
    let streamHeaders: Headers | undefined;
    try {
      const result =
        stream.direction === 'forward'
          ? await client.subjects({ id }).relations.get({ query, headers })
          : await client.subjects({ id }).links.get({ query, headers });
      if (result.status !== 200 || !result.data) {
        independentlyUnreadable = { key: stream.key, reason: candidateFailure(result.status).reason };
      } else {
        page = result.data;
        streamHeaders = new Headers(result.headers);
      }
    } catch {
      independentlyUnreadable = { key: stream.key, reason: 'unavailable' };
    }
    const rows = page ? pageRows(id, page) : [];
    const holderTypes = rows.flatMap((row) => (row.holderType ? [row.holderType] : []));
    const descriptors = workType ? await admitAssociationDescriptors(holderTypes, workType) : {};
    const token = streamHeaders?.get('rezics-session-token') ?? new Headers(current.headers).get('rezics-session-token');
    return {
      ok: true,
      public: current.data,
      streams,
      stream,
      rows,
      labels: associationLabels(definitions, rows, locale),
      next: page && typeof page.next === 'string' && page.next ? page.next : null,
      ...(page?.count ? { count: page.count } : {}),
      caughtUp: page ? page.freshness.caught_up : true,
      unavailable,
      descriptors,
      ...(token ? { session: token } : {}),
      ...(independentlyUnreadable ? { independentlyUnreadable } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
