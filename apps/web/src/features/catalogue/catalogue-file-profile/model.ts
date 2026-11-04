import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import type { SubjectRead } from '@rezics/client';
import {
  admittedProperty,
  encodedBytes,
  emptyVisit,
  historicalStatement,
  isA,
  isCatalogueFileType,
  isReleaseGroupType,
  isReleaseType,
  recordComponent,
  relatedReadable,
  relatedTarget,
  RELEASE_ASSOCIATION_LIMIT,
  RELEASE_VISIT_CAPS,
  RELEASE_VISIT_COMPONENTS,
  releaseUuid,
  selectedStatements,
  visitBound,
  type VisitWork,
} from '../release-fidelity/model';

export {
  encodedBytes,
  emptyVisit,
  fileProfileReleased,
  isCatalogueFileType,
  isReleaseGroupType,
  recordComponent,
  RELEASE_ASSOCIATION_LIMIT,
  RELEASE_ASSOCIATION_MAX,
  RELEASE_VISIT_CAPS,
  RELEASE_VISIT_COMPONENTS,
  visitBound,
  type VisitWork,
} from '../release-fidelity/model';

export const fileUuid = releaseUuid;
const termProperties = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
const hashCandidates = ['wdt:P4092', 'schema:sha256', 'rezics:ed2k', 'rezics:crc32', 'schema:identifier'];
const codecCandidates = ['rezics:codec', 'schema:encodingFormat', 'wdt:P2364'];
const sizeCandidates = ['wdt:P3575', 'schema:contentSize'];
const qualityCandidates = ['rezics:fileQuality', 'wdt:P3791', 'schema:quality'];
const episodeCandidates = ['schema:encodesCreativeWork', 'schema:isPartOf', 'wdt:P179'];
const groupCandidates = ['rezics:releaseGroup', 'schema:publisher', 'wdt:P437', 'schema:producer'];
const releaseLinkCandidates = ['schema:associatedMedia', 'schema:exampleOfWork', 'schema:isBasedOn', 'wdt:P361'];

type Definitions = Pick<Release, 'types' | 'properties'>;
type Statement = SubjectRead['subject']['statements'][string][number];

export type FileGroupId = 'identifiers' | 'technical' | 'language' | 'group' | 'credits' | 'relations' | 'facts';
export type FileStream = {
  key: string;
  property: string;
  direction: 'forward' | 'inverse';
  kind: 'episode' | 'release' | 'file' | 'group';
  label: { text: string; lang: string | null };
};

export function isFileOrGroupType(release: Definitions, type: string): boolean {
  return isCatalogueFileType(release, type) || isReleaseGroupType(release, type);
}

export function firstAdmitted(release: Definitions, type: string, candidates: readonly string[]): string | undefined {
  return candidates.find((id) => admittedProperty(release, type, id));
}

export function hashProperty(release: Definitions, type: string) {
  return firstAdmitted(release, type, hashCandidates);
}
export function codecProperty(release: Definitions, type: string) {
  return firstAdmitted(release, type, codecCandidates);
}
export function sizeProperty(release: Definitions, type: string) {
  return firstAdmitted(release, type, sizeCandidates);
}
export function qualityProperty(release: Definitions, type: string) {
  return firstAdmitted(release, type, qualityCandidates);
}

export function fileGroups(release: Definitions, type: string): Record<FileGroupId, string[]> {
  const groups: Record<FileGroupId, string[]> = {
    identifiers: [],
    technical: [],
    language: [],
    group: [],
    credits: [],
    relations: [],
    facts: [],
  };
  if (!isFileOrGroupType(release, type)) return groups;
  const hash = new Set([
    hashProperty(release, type),
    codecProperty(release, type),
    sizeProperty(release, type),
    qualityProperty(release, type),
  ]);
  const groupSet = new Set(groupCandidates);
  for (const id of release.types[type]?.properties ?? []) {
    const property = release.properties[id];
    if (!property || termProperties.has(id)) continue;
    if (id === 'schema:inLanguage') groups.language.push(id);
    else if (hash.has(id) || ['external-id'].includes(property.datatype)) {
      if (hash.has(id) && property.datatype !== 'external-id' && property.datatype !== 'url') groups.technical.push(id);
      else groups.identifiers.push(id);
    } else if (groupSet.has(id) || (property.relation && isReleaseGroupType(release, property.targets?.[0] ?? '')))
      groups.group.push(id);
    else if (property.relation?.group === 'credit') groups.credits.push(id);
    else if (property.relation) groups.relations.push(id);
    else if (property.datatype === 'url' || property.datatype === 'external-id') groups.identifiers.push(id);
    else groups.facts.push(id);
  }
  return groups;
}

export function fileScalarFields(release: Definitions, type: string): string[] {
  const groups = fileGroups(release, type);
  return [...groups.identifiers, ...groups.technical, ...groups.language, ...groups.facts].filter(
    (id) => !release.properties[id]?.relation,
  );
}

export function fileStreams(release: Definitions, type: string, locale: string): FileStream[] {
  if (!isFileOrGroupType(release, type)) return [];
  const streams: FileStream[] = [];
  const kindOf = (candidate: string): FileStream['kind'] | undefined => {
    if (candidate === 'schema:Episode' || isA(release, candidate, 'schema:Episode')) return 'episode';
    if (isReleaseType(release, candidate) || releaseTypesIncludes(candidate)) return 'release';
    if (isCatalogueFileType(release, candidate)) return 'file';
    if (isReleaseGroupType(release, candidate)) return 'group';
  };
  for (const [id, property] of Object.entries(release.properties)) {
    const relation = property.relation;
    if (!relation || property.datatype !== 'wikibase-item') continue;
    const targets = property.targets ?? [];
    const forwardKind = targets.map(kindOf).find((candidate) => candidate !== undefined);
    const inverseKind = Object.entries(release.types)
      .filter(([owner, definition]) =>
        definition.properties?.includes(id) &&
        targets.some((target) => typeIsA(release, type, target)) &&
        owner !== type,
      )
      .map(([owner]) => kindOf(owner))
      .find((candidate) => candidate !== undefined);
    if (admittedProperty(release, type, id)) {
      if (!forwardKind) continue;
      streams.push({
        key: `forward:${id}`,
        property: id,
        direction: 'forward',
        kind: forwardKind,
        label: pickText(property.labels, locale),
      });
    }
    if (relation.inverse && relation.inverse !== 'none' && targets.some((target) => isA(release, type, target))) {
      if (!inverseKind) continue;
      streams.push({
        key: `inverse:${id}`,
        property: id,
        direction: 'inverse',
        kind: inverseKind,
        label: pickText(relation.inverseLabels ?? {}, locale),
      });
    }
  }
  return streams;
}

function releaseTypesIncludes(target: string) {
  return ['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'].includes(target);
}

function typeIsA(release: Definitions, type: string, base: string, seen = new Set<string>()): boolean {
  if (type === base) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((candidate) => typeIsA(release, candidate, base, seen));
}

export function rawIdentifier(statement: Statement): { raw: string; display: string } | undefined {
  if (statement.value.type !== 'value') return;
  const content = statement.value.content;
  if (typeof content === 'string') return { raw: content, display: content };
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    const text = (content as { text: string; language?: string }).text;
    return { raw: text, display: text };
  }
  return;
}

export function quantityDisplay(statement: Statement, related: SubjectRead['related'], locale: string) {
  if (statement.value.type !== 'value' || !statement.value.content || typeof statement.value.content !== 'object')
    return;
  const content = statement.value.content as { amount?: unknown; unit?: unknown };
  if (typeof content.amount !== 'string') return;
  const unitId = typeof content.unit === 'string' ? content.unit : undefined;
  const unit = unitId ? pickText(related[unitId]?.labels ?? {}, locale).text : undefined;
  return { amount: content.amount, unit: unit ?? unitId, raw: content.amount };
}

export { historicalStatement, relatedReadable, relatedTarget, selectedStatements };
export const FILE_VISIT_CAPS = RELEASE_VISIT_CAPS;
export const FILE_VISIT_COMPONENTS = RELEASE_VISIT_COMPONENTS;
export const fileVisitBound = visitBound;
export const episodeProperties = episodeCandidates;
export const groupProperties = groupCandidates;
export const releaseLinkProperties = releaseLinkCandidates;
