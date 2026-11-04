import { pickText } from '@rezics/composition';
import { RELEASE_LIMITS, type Release } from '@rezics/definitions';
import type { SubjectRead } from '@rezics/client';

export const releaseTypes = ['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'] as const;
export const releaseUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Native association pages default to 20 and admit at most 100 rows. */
export const RELEASE_ASSOCIATION_LIMIT = 20;
export const RELEASE_ASSOCIATION_MAX = 100;
export const WORK_PROPERTY = 'schema:exampleOfWork';
export const WORK_COMPLETENESS_QUALIFIER = 'wdt:P31';
export const CONTAINED_WORK_PROPERTY = 'bf:hasPart';
const termProperties = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
const identifierDatatypes = new Set(['external-id', 'url']);
const statusCandidates = ['schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus'];
const regionCandidates = ['schema:contentLocation', 'schema:spatialCoverage', 'wdt:P495', 'wdt:P17'];
const TIME_PRECISION = { 9: 'year', 10: 'month', 11: 'day' } as const;
const GREGORIAN_CALENDAR = 'http://www.wikidata.org/entity/Q1985727';

export type ReleaseType = (typeof releaseTypes)[number];
export type ReleaseGroupId = 'work' | 'classification' | 'credits' | 'identifiers' | 'dates' | 'facts' | 'relations';
export type DateKind = 'exact' | 'partial' | 'tba' | 'none' | 'absent' | 'invalid' | 'unsupported';
export type DateReading = {
  kind: DateKind;
  property: string;
  statementId?: string;
  text?: string;
  precision?: 'year' | 'month' | 'day';
  historical: boolean;
};
export type ReleaseStream = {
  key: string;
  property: string;
  direction: 'forward' | 'inverse';
  kind: 'release' | 'file';
  label: { text: string; lang: string | null };
};
export type VisitComponent = {
  id: 'descriptor' | 'subject' | 'association' | 'detail';
  calls: number;
  rows: number;
  bytes: number;
  rowCap: number | 'unavailable';
  byteCap: number | 'unavailable';
};
export type VisitWork = {
  calls: number;
  rows: number;
  bytes: number;
  components: VisitComponent[];
};

type Definitions = Pick<Release, 'types' | 'properties'>;
type Statement = SubjectRead['subject']['statements'][string][number];

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function emptyVisit(): VisitWork {
  return { calls: 0, rows: 0, bytes: 0, components: [] };
}

export function recordComponent(work: VisitWork, component: VisitComponent): VisitWork {
  return {
    calls: work.calls + component.calls,
    rows: work.rows + component.rows,
    bytes: work.bytes + component.bytes,
    components: [...work.components, component],
  };
}

/** Descriptor, subject, one association page, and at most one explicitly selected detail. */
export const RELEASE_VISIT_COMPONENTS = 4;
export const RELEASE_VISIT_CAPS = {
  descriptor: { rows: RELEASE_LIMITS.types, bytes: RELEASE_LIMITS.bytes },
  subject: { rows: RELEASE_LIMITS.propertiesPerType, bytes: 'unavailable' as const },
  association: { rows: RELEASE_ASSOCIATION_LIMIT, bytes: 'unavailable' as const },
  detail: { rows: 1, bytes: 'unavailable' as const },
} as const;

export function visitBound(caps = RELEASE_VISIT_CAPS) {
  return {
    calls: RELEASE_VISIT_COMPONENTS,
    rows: caps.descriptor.rows + caps.subject.rows + caps.association.rows + caps.detail.rows,
    bytes:
      typeof caps.descriptor.bytes === 'number' &&
      typeof caps.subject.bytes === 'number' &&
      typeof caps.association.bytes === 'number' &&
      typeof caps.detail.bytes === 'number'
        ? caps.descriptor.bytes + caps.subject.bytes + caps.association.bytes + caps.detail.bytes
        : ('unavailable' as const),
  };
}

export function isA(release: Definitions, type: string, base: string, seen = new Set<string>()): boolean {
  if (type === base) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((parent) => isA(release, parent, base, seen));
}

export function isReleaseType(release: Definitions, type: string): boolean {
  return !!release.types[type] && releaseTypes.some((id) => isA(release, type, id));
}

export function admittedProperty(release: Definitions, type: string, property: string): boolean {
  return !!release.types[type]?.properties.includes(property) && !!release.properties[property];
}

export function propertyLabel(release: Definitions, property: string, locale: string) {
  return pickText(release.properties[property]?.labels ?? {}, locale);
}

/** Historical accepting meaning is the statement's pinned release, never the current editor admission. */
export function historicalStatement(statement: Statement, currentDigest: string): boolean {
  return statement.rezics.release !== currentDigest;
}

export function selectedStatements(statements: Statement[] | undefined): Statement[] {
  const preferred = (statements ?? []).filter((item) => item.rank === 'preferred');
  const normal = (statements ?? []).filter((item) => item.rank === 'normal');
  return preferred.length ? preferred : normal;
}

export function releaseGroups(release: Definitions, type: string): Record<ReleaseGroupId, string[]> {
  const groups: Record<ReleaseGroupId, string[]> = {
    work: [],
    classification: [],
    credits: [],
    identifiers: [],
    dates: [],
    facts: [],
    relations: [],
  };
  if (!isReleaseType(release, type)) return groups;
  for (const id of release.types[type]?.properties ?? []) {
    const property = release.properties[id];
    if (!property || termProperties.has(id)) continue;
    if (id === WORK_PROPERTY) groups.work.push(id);
    else if (property.datatype === 'time') groups.dates.push(id);
    else if (property.relation?.group === 'classification') groups.classification.push(id);
    else if (property.relation?.group === 'credit') groups.credits.push(id);
    else if (property.relation) groups.relations.push(id);
    else if (
      identifierDatatypes.has(property.datatype) ||
      (property.datatype === 'string' && 'pattern' in property.value)
    )
      groups.identifiers.push(id);
    else groups.facts.push(id);
  }
  return groups;
}

export function scalarFields(release: Definitions, type: string): string[] {
  const groups = releaseGroups(release, type);
  return [...groups.identifiers, ...groups.dates, ...groups.facts].filter((id) => !release.properties[id]?.relation);
}

export function statusProperty(release: Definitions, type: string): string | undefined {
  return statusCandidates.find((id) => admittedProperty(release, type, id));
}

export function regionProperty(release: Definitions, type: string): string | undefined {
  return regionCandidates.find((id) => admittedProperty(release, type, id));
}

type ConcreteTime = Readonly<{
  precision: NonNullable<DateReading['precision']>;
  signedYear: string;
  month?: number;
  day?: number;
}>;

function leapYear(year: bigint): boolean {
  return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
}

function concreteTime(content: unknown): ConcreteTime | 'invalid' | 'unsupported' {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return 'invalid';
  const value = content as { time?: unknown; precision?: unknown; calendarmodel?: unknown };
  if (value.calendarmodel !== undefined && value.calendarmodel !== GREGORIAN_CALENDAR) return 'unsupported';
  const precision = typeof value.precision === 'number' && value.precision in TIME_PRECISION
    ? TIME_PRECISION[value.precision as keyof typeof TIME_PRECISION]
    : undefined;
  if (!precision) return 'unsupported';
  if (typeof value.time !== 'string') return 'invalid';
  const match = /^([+-])(\d{4,64})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value.time);
  if (!match) return 'invalid';
  const signedYear = `${match[1] === '-' ? '-' : ''}${match[2]}`;
  const year = BigInt(match[2]!);
  const monthValue = Number(match[3]);
  const dayValue = Number(match[4]);
  if (Number(match[5]) > 23 || Number(match[6]) > 59 || Number(match[7]) > 59) return 'invalid';
  if (monthValue > 12 || dayValue > 31) return 'invalid';
  if (precision === 'year') {
    if (monthValue !== 0 || dayValue !== 0) return 'invalid';
    return { precision, signedYear };
  }
  if (monthValue === 0) return 'invalid';
  const daysInMonth = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (precision === 'month') {
    if (dayValue !== 0) return 'invalid';
    return { precision, signedYear, month: monthValue };
  }
  if (dayValue === 0) return 'invalid';
  if (dayValue > daysInMonth[monthValue - 1]!) return 'invalid';
  return { precision, signedYear, month: monthValue, day: dayValue };
}

/** Format only the locale's month/day ordering; the payload year never passes through Date or Number. */
function formatConcreteTime(value: ConcreteTime, locale: string): string {
  const date = new Date(Date.UTC(2000, (value.month ?? 1) - 1, value.day ?? 1));
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    ...(value.month === undefined ? {} : { month: 'long' as const }),
    ...(value.day === undefined ? {} : { day: 'numeric' as const }),
  });
  return formatter
    .formatToParts(date)
    .map((part) => (part.type === 'year' ? value.signedYear : part.value))
    .join('');
}

/** TBA is an explicit unknown date. It is never a missing statement, year zero or the Unix epoch. */
export function dateReading(
  statements: Statement[] | undefined,
  property: string,
  currentDigest: string,
  locale: string,
): DateReading {
  const selected = selectedStatements(statements);
  if (!selected.length) return { kind: 'absent', property, historical: false };
  const statement = selected[0]!;
  const historical = historicalStatement(statement, currentDigest);
  if (statement.value.type === 'somevalue') return { kind: 'tba', property, statementId: statement.id, historical };
  if (statement.value.type === 'novalue') return { kind: 'none', property, statementId: statement.id, historical };
  const concrete = concreteTime(statement.value.content);
  if (concrete === 'invalid' || concrete === 'unsupported')
    return { kind: concrete, property, statementId: statement.id, historical };
  const text = formatConcreteTime(concrete, locale);
  return {
    kind: concrete.precision === 'day' ? 'exact' : 'partial',
    property,
    statementId: statement.id,
    text,
    precision: concrete.precision,
    historical,
  };
}

export function relatedTarget(statement: Statement): string | undefined {
  return statement.value.type === 'value' && typeof statement.value.content === 'string'
    ? statement.value.content
    : undefined;
}

export function relatedReadable(related: SubjectRead['related'], id: string): 'readable' | 'concealed' | 'unreadable' {
  if (!Object.hasOwn(related, id)) return 'unreadable';
  const labels = related[id]?.labels ?? {};
  return Object.keys(labels).length ? 'readable' : 'concealed';
}

/** Directed release-to-release and file associations only. Work identity and anthology parts stay separate. */
export function releaseStreams(release: Definitions, type: string, locale: string): ReleaseStream[] {
  if (!isReleaseType(release, type)) return [];
  const streams: ReleaseStream[] = [];
  for (const [id, property] of Object.entries(release.properties)) {
    const relation = property.relation;
    if (!relation || property.datatype !== 'wikibase-item') continue;
    if (id === WORK_PROPERTY || id === CONTAINED_WORK_PROPERTY) continue;
    const targets = property.targets ?? [];
    const releaseTarget = targets.some((target) =>
      releaseTypes.some((base) => isA(release, target, base) || target === base),
    );
    const fileTarget = targets.some(
      (target) => isCatalogueFileType(release, target) || isReleaseGroupType(release, target),
    );
    if (!releaseTarget && !fileTarget) continue;
    const kind: ReleaseStream['kind'] = fileTarget && !releaseTarget ? 'file' : 'release';
    if (admittedProperty(release, type, id)) {
      streams.push({
        key: `forward:${id}`,
        property: id,
        direction: 'forward',
        kind,
        label: pickText(property.labels, locale),
      });
    }
    if (relation.inverse && relation.inverse !== 'none' && targets.some((target) => isA(release, type, target))) {
      streams.push({
        key: `inverse:${id}`,
        property: id,
        direction: 'inverse',
        kind,
        label: pickText(relation.inverseLabels ?? {}, locale),
      });
    }
  }
  return streams;
}

export const fileTypeCandidates = ['schema:MediaObject', 'rezics:CatalogueFile', 'wd:Q82753'] as const;
export const groupTypeCandidates = ['rezics:ReleaseGroup', 'wd:Q55327'] as const;

export function isCatalogueFileType(release: Definitions, type: string): boolean {
  return !!release.types[type] && fileTypeCandidates.some((id) => isA(release, type, id) || type === id);
}

export function isReleaseGroupType(release: Definitions, type: string): boolean {
  return !!release.types[type] && groupTypeCandidates.some((id) => isA(release, type, id) || type === id);
}

export function fileProfileReleased(release: Definitions): boolean {
  return Object.keys(release.types).some(
    (type) => isCatalogueFileType(release, type) || isReleaseGroupType(release, type),
  );
}

/** Completeness of this exact release for the linked work; never a work-level development status. */
export function workCompletenessQualifier(
  statement: Statement | undefined,
): Statement['qualifiers'][number] | undefined {
  return statement?.qualifiers.find((part) => part.property.id === WORK_COMPLETENESS_QUALIFIER);
}

export function unknownProvenance(statement: Statement): string[] {
  return statement.qualifiers.concat(statement.references.flatMap((reference) => reference.parts)).flatMap((part) => {
    if (part.value.type !== 'value' || typeof part.value.content !== 'string') return [];
    if (
      !['schema:sameAs', 'schema:identifier', 'wdt:P973'].includes(part.property.id) &&
      part.property.data_type !== 'external-id'
    )
      return [];
    return [part.value.content];
  });
}
