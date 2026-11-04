import type { Release } from '@rezics/definitions';
import { facetProperties, readNativeSpoilerLevel } from '@rezics/filter';
import type { Related, Subject } from '../../../subject/types';
import { subjectHref } from '../../../subject/subject-href';
import { bestRank, pageText, type Stmt } from '../../pages/shared';
import { typeExtends } from '../../pages/graph-browser';

export const WORK_TAG_PAGE_SIZE = 12;

export type WorkTagAssertion = {
  key: string;
  property: string;
  facetLabel: ReturnType<typeof pageText>;
  targetId: string;
  statement: Stmt;
  spoilerLevel: number;
  hasSpoilerQualifier: boolean;
  spoilerQualifiers: { property: string; in: string[] }[];
};

export type WorkTagProjection = {
  state: 'available' | 'empty' | 'unsupported' | 'unavailable';
  rows: WorkTagAssertion[];
  disclosedCount: number;
  hasUnavailable: boolean;
  workHref: string;
  sourceKey: string;
};

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identity(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    id = ++nextIdentity;
    identities.set(value, id);
  }
  return id;
}

export function workTagSourceKey(input: {
  subject: Subject;
  related: Related;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
  locale: string;
  spoilerThreshold: number;
  currentHref?: string | undefined;
  realm?: string | undefined;
}): string {
  const { subject, related, definitions, locale, spoilerThreshold, currentHref, realm } = input;
  return [
    identity(subject),
    identity(related),
    definitions ? identity(definitions) : 'none',
    subject.id,
    subject.context,
    subject.release,
    subject.revision,
    locale,
    spoilerThreshold,
    currentHref ?? '',
    realm ?? '',
  ].join(':');
}

export function conceptLabel(
  targetId: string,
  related: Related,
  definitions: Pick<Release, 'types' | 'properties'>,
  locale: string,
): ReturnType<typeof pageText> | undefined {
  const entry = Object.hasOwn(related, targetId) ? related[targetId] : undefined;
  if (!entry?.type || !typeExtends(definitions, entry.type, 'skos:Concept')) return undefined;
  const label = pageText(entry.labels, locale);
  return label.text ? label : undefined;
}

export function projectWorkTags(input: {
  subject: Subject;
  related: Related;
  definitions?: Pick<Release, 'types' | 'properties'> | undefined;
  locale: string;
  spoilerThreshold: number;
  currentHref?: string | undefined;
  realm?: string | undefined;
}): WorkTagProjection | null {
  const { subject, related, definitions, locale, spoilerThreshold } = input;
  const workHref = subjectHref({ id: subject.id, label: pageText(subject.labels, locale).text }, locale).href;
  const sourceKey = workTagSourceKey(input);
  if (!definitions) return { state: 'unavailable', rows: [], disclosedCount: 0, hasUnavailable: false, workHref, sourceKey };
  if (!definitions.types[subject.type])
    return { state: 'unavailable', rows: [], disclosedCount: 0, hasUnavailable: false, workHref, sourceKey };
  if (!typeExtends(definitions, subject.type, 'schema:CreativeWork'))
    return { state: 'unsupported', rows: [], disclosedCount: 0, hasUnavailable: false, workHref, sourceKey };

  const propertyIds = facetProperties(definitions, [subject.type]);
  const rows: WorkTagAssertion[] = [];
  let itemFacets = 0;
  let missingFacetLabel = false;
  let disclosedCount = 0;
  let hasUnavailable = false;

  for (const property of propertyIds) {
    const definition = definitions.properties[property];
    if (
      definition?.datatype !== 'wikibase-item' ||
      !definition.targets?.some((target) => typeExtends(definitions, target, 'skos:Concept'))
    )
      continue;
    const facetLabel = pageText(definition.labels, locale);
    if (!facetLabel.text) {
      missingFacetLabel = true;
      continue;
    }
    itemFacets += 1;
    const supplied = Object.hasOwn(subject.statements, property)
      ? ((subject.statements[property] ?? []) as unknown as Stmt[])
      : [];
    const statements = subject.relationCounts ? supplied : bestRank(supplied);

    for (const statement of statements) {
      if (
        statement.rank === 'deprecated' ||
        statement.property.id !== property ||
        statement.value.type !== 'value' ||
        statement.property.data_type !== 'wikibase-item' ||
        typeof statement.value.content !== 'string'
      )
        continue;

      const spoilerParts = statement.qualifiers.filter((qualifier) => qualifier.property.id === 'rezics:spoilerLevel');
      const spoilerLevels = spoilerParts.map((qualifier) =>
        qualifier.value.type === 'value' ? readNativeSpoilerLevel(qualifier.value.content) : null,
      );
      if (spoilerLevels.some((level) => level === null)) {
        hasUnavailable = true;
        continue;
      }
      const spoilerQualifiers = spoilerParts.map((qualifier, index) => ({
        property: qualifier.property.id,
        in: [spoilerLevels[index]!],
      }));
      const level = spoilerLevels.reduce<number>((maximum, value) => Math.max(maximum, Number(value)), 0);

      const row: WorkTagAssertion = {
        key: `${property}:${statement.id}`,
        property,
        facetLabel,
        targetId: statement.value.content,
        statement,
        spoilerLevel: level,
        hasSpoilerQualifier: spoilerParts.length > 0,
        spoilerQualifiers,
      };
      rows.push(row);

      // Hidden associations do not contribute labels or counts before their own gate is opened.
      if (row.spoilerLevel <= spoilerThreshold) {
        if (conceptLabel(row.targetId, related, definitions, locale)) disclosedCount += 1;
        else hasUnavailable = true;
      }
    }
  }

  const state =
    itemFacets === 0
      ? missingFacetLabel
        ? 'unavailable'
        : 'unsupported'
      : rows.length === 0
        ? missingFacetLabel || hasUnavailable
          ? 'unavailable'
          : 'empty'
        : 'available';

  return { state, rows, disclosedCount, hasUnavailable, workHref, sourceKey };
}
