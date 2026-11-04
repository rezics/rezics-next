import type { SubjectRead } from '@rezics/client';
import { pageDocumentReferences, pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { peopleBiographyRequested } from '../people-biography';

export type PersonDefinitions = Pick<Release, 'types' | 'properties'>;
export type PersonStatement = SubjectRead['subject']['statements'][string][number];
export type PersonGroup = {
  kind: keyof typeof peopleBiographyRequested;
  fields: {
    id: string;
    label: ReturnType<typeof pickText>;
    facts: PersonStatement[];
    more: boolean;
    presentable: boolean;
  }[];
  more: boolean;
};
export const personBounds = { fields: 15, facts: 20, qualifiers: 32, references: 32, parts: 32 };

/** The same native selection is used by the compact profile and its local continuation. */
export function profileFieldFacts(release: PersonDefinitions, read: SubjectRead, id: string, locale: string) {
  if (!release.types[read.subject.type]?.properties.includes(id) || !release.properties[id]) return [];
  const all = read.subject.statements[id] ?? [];
  const rank = all.some((row) => row.rank === 'preferred') ? 'preferred' : 'normal';
  const rows = all.filter((row) => row.rank === rank);
  if (release.properties[id]?.datatype !== 'document') return rows;
  const selected = pageDocumentReferences(read.subject, [id], locale)[0]?.candidate;
  return selected ? rows.filter((row) => row.id === selected) : [];
}

/** Explicit profile scalar fields; occupations never come from directed credit roles. */
export function personScalarFields(release: PersonDefinitions, read: SubjectRead) {
  return [
    ...new Set([
      'schema:alternateName',
      'wdt:P1559',
      'schema:birthDate',
      'schema:deathDate',
      'schema:gender',
      'schema:height',
      'schema:weight',
      'schema:url',
      'schema:sameAs',
      ...(release.types[read.subject.type]?.properties ?? []).filter(
        (id) => release.properties[id]?.datatype === 'external-id',
      ),
    ]),
  ];
}

/** Select current native rank and document language once for each displayed field. */
export function profileFields(release: PersonDefinitions, read: SubjectRead, ids: readonly string[], locale: string) {
  const admitted = release.types[read.subject.type]?.properties ?? [];
  return ids
    .filter((id) => admitted.includes(id) && release.properties[id])
    .slice(0, personBounds.fields)
    .map((id) => {
      const facts = profileFieldFacts(release, read, id, locale);
      return {
        id,
        label: pickText(release.properties[id]?.labels ?? {}, locale),
        presentable: true,
        facts: facts.slice(0, personBounds.facts),
        more: facts.length > personBounds.facts,
      };
    });
}

/** Only emitted effective properties confer support. Credits never supply occupation facts. */
export function personGroups(release: PersonDefinitions, read: SubjectRead, locale: string): PersonGroup[] {
  if (read.subject.type !== 'schema:Person') return [];
  const admitted = release.types[read.subject.type]?.properties ?? [];
  const kinds: PersonGroup['kind'][] = ['biography', 'occupations', 'languages'];
  return kinds.map((kind) => {
    const requested: readonly string[] = peopleBiographyRequested[kind];
    const ids =
      kind === 'biography'
        ? [...new Set([...requested, ...admitted.filter((id) => release.properties[id]?.datatype === 'document')])]
        : requested;
    const supported = ids.filter((id) => admitted.includes(id) && release.properties[id]);
    return {
      kind,
      more: supported.length > personBounds.fields,
      fields: profileFields(release, read, supported, locale).map((field) => {
        return {
          ...field,
          presentable: release.properties[field.id]?.datatype === (kind === 'biography' ? 'document' : 'wikibase-item'),
        };
      }),
    };
  });
}

export function personEvidenceFits(statement: PersonStatement): boolean {
  return (
    statement.qualifiers.length <= personBounds.qualifiers &&
    statement.references.length <= personBounds.references &&
    statement.references.every((reference) => reference.parts.length <= personBounds.parts)
  );
}
