import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { subjectHref } from '../../../subject/subject-href';
import { authoredProperties } from '../authored-field';
import { correctionProperty } from '../statement-editor';

export const peopleBiographyRequested = {
  biography: ['schema:abstract'] as const,
  occupations: ['wdt:P106', 'schema:hasOccupation', 'schema:occupation'] as const,
  languages: ['schema:knowsLanguage'] as const,
};

export type PeopleFieldStatus = 'unsupported' | 'absent' | 'unreadable' | 'current';
export type PeopleBiographyKind = 'biography' | 'occupations' | 'languages' | 'affiliations';
export type PeopleBiographyFact = {
  id: string;
  property: string;
  statement: SubjectRead['subject']['statements'][string][number];
  target?: { id: string; label: string; lang: string | null };
};
export type PeopleBiographyField = {
  id: string;
  kind: PeopleBiographyKind;
  status: PeopleFieldStatus;
  label: { text: string; lang: string | null };
  description: { text: string; lang: string | null };
  datatype?: PropertyDefinition['datatype'];
  editor: 'authored' | 'item' | 'relation' | 'none';
  facts: PeopleBiographyFact[];
};
export type PeopleBiographyGroup = {
  kind: PeopleBiographyKind;
  requested: readonly string[];
  fields: PeopleBiographyField[];
};
type Definitions = Pick<Release, 'types' | 'properties'>;

function isType(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

export function peopleAgentType(release: Definitions, type: string): 'schema:Person' | 'schema:Organization' | null {
  if (isType(release, type, 'schema:Person')) return 'schema:Person';
  if (isType(release, type, 'schema:Organization')) return 'schema:Organization';
  return null;
}

function admittedProperty(release: Definitions, type: string, id: string): PropertyDefinition | undefined {
  return release.types[type]?.properties.includes(id) ? release.properties[id] : undefined;
}

function disclosedTarget(
  related: SubjectRead['related'],
  id: string,
  locale: string,
): PeopleBiographyFact['target'] | undefined {
  if (!id || !Object.hasOwn(related, id)) return undefined;
  const summary = related[id];
  if (!summary || !('labels' in summary)) return undefined;
  const label = pickText(summary.labels ?? {}, locale);
  return label.text ? { id, label: label.text, lang: label.lang } : { id, label: '', lang: null };
}

function factStatus(
  admitted: PropertyDefinition | undefined,
  statements: SubjectRead['subject']['statements'][string] | undefined,
  readable: boolean,
): PeopleFieldStatus {
  if (!admitted) return 'unsupported';
  if (!readable) return 'unreadable';
  return statements?.length ? 'current' : 'absent';
}

function itemFacts(
  property: string,
  subject: SubjectRead | null,
  locale: string,
): PeopleBiographyFact[] {
  if (!subject) return [];
  return (subject.subject.statements[property] ?? []).map((statement) => {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    const target =
      statement.property.data_type === 'wikibase-item' && typeof content === 'string'
        ? disclosedTarget(subject.related, content, locale)
        : undefined;
    return { id: statement.id, property, statement, ...(target ? { target } : {}) };
  });
}

function itemEditor(definition: PropertyDefinition): PeopleBiographyField['editor'] {
  if (definition.datatype === 'document') return 'authored';
  if (definition.datatype !== 'wikibase-item') return 'none';
  if (definition.relation?.group === 'classification' || !definition.relation) return 'item';
  return 'relation';
}

function requestedField(
  release: Release,
  type: string,
  kind: PeopleBiographyKind,
  id: string,
  locale: string,
  subject: SubjectRead | null,
  readable: boolean,
): PeopleBiographyField {
  const definition = admittedProperty(release, type, id);
  const facts = definition ? itemFacts(id, subject, locale) : [];
  const unreadable = definition ? facts.some((fact) => fact.statement.value.type === 'value' && !disclosedOrScalar(fact)) : false;
  return {
    id,
    kind,
    status: unreadable && readable ? 'unreadable' : factStatus(definition, subject?.subject.statements[id], readable),
    label: pickText(definition?.labels ?? release.properties[id]?.labels ?? {}, locale),
    description: pickText(definition?.descriptions ?? release.properties[id]?.descriptions ?? {}, locale),
    ...(definition ? { datatype: definition.datatype } : {}),
    editor: definition ? itemEditor(definition) : 'none',
    facts,
  };
}

function disclosedOrScalar(fact: PeopleBiographyFact): boolean {
  if (fact.statement.value.type !== 'value') return true;
  if (fact.statement.property.data_type !== 'wikibase-item') return true;
  return !!fact.target;
}

/** Requested biography, occupation and language IDs bind only when this release admits them. */
export function peopleBiographyGroups(
  release: Release,
  type: string,
  locale: string,
  subject: SubjectRead | null = null,
  readable = true,
): PeopleBiographyGroup[] {
  const agent = peopleAgentType(release, type);
  const biographyIds = [...peopleBiographyRequested.biography, ...authoredProperties(release, type)].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  const occupationIds = [...peopleBiographyRequested.occupations];
  const languageIds = [...peopleBiographyRequested.languages];
  const groups: PeopleBiographyGroup[] = [];
  if (agent === 'schema:Person') {
    groups.push(
      {
        kind: 'biography',
        requested: peopleBiographyRequested.biography,
        fields: biographyIds.map((id) => requestedField(release, type, 'biography', id, locale, subject, readable)),
      },
      {
        kind: 'occupations',
        requested: occupationIds,
        fields: occupationIds.map((id) => requestedField(release, type, 'occupations', id, locale, subject, readable)),
      },
      {
        kind: 'languages',
        requested: languageIds,
        fields: languageIds.map((id) => requestedField(release, type, 'languages', id, locale, subject, readable)),
      },
    );
  }
  const affiliations = affiliationFields(release, type, locale, subject, readable);
  if (agent && affiliations.fields.length) groups.push(affiliations);
  return groups;
}

function affiliationFields(
  release: Release,
  type: string,
  locale: string,
  subject: SubjectRead | null,
  readable: boolean,
): PeopleBiographyGroup {
  const properties = (release.types[type]?.properties ?? []).filter((id) => {
    const property = release.properties[id];
    return (
      property?.datatype === 'wikibase-item' &&
      !!property.relation &&
      property.targets?.some((target) => isType(release, target, 'schema:Organization') || target === 'schema:Organization')
    );
  });
  return {
    kind: 'affiliations',
    requested: properties,
    fields: properties.map((id) => requestedField(release, type, 'affiliations', id, locale, subject, readable)),
  };
}

/** Scalar facts stay on the existing multi-field editor; grouped dedicated editors are omitted here. */
export function peopleScalarFields(release: Release, type: string, locale: string): string[] {
  const grouped = new Set(
    peopleBiographyGroups(release, type, locale).flatMap((group) =>
      group.fields.filter((field) => field.editor !== 'none').map((field) => field.id),
    ),
  );
  return (release.types[type]?.properties ?? []).filter((property) => {
    return correctionProperty(release, type, property) && !grouped.has(property);
  });
}

export function peopleBiographyHref(id: string, label: string, locale: string, property?: string): string {
  const authored = `${subjectHref({ id, label }, locale).href}/authored`;
  return property ? `${authored}?property=${encodeURIComponent(property)}` : authored;
}

export function peopleRelationHref(id: string, label: string, locale: string): string {
  return `${subjectHref({ id, label }, locale).href}/relation-edit`;
}

/** A previously chosen assertion is editable only while that exact statement remains selected. */
export function peopleSelectedFact(source: string, facts: readonly PeopleBiographyFact[]): PeopleBiographyFact | undefined {
  return facts.find((fact) => fact.id === source);
}
