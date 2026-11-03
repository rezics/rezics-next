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
      fields: supported.slice(0, personBounds.fields).map((id) => {
        const all = read.subject.statements[id] ?? [];
        const rank = all.some((row) => row.rank === 'preferred') ? 'preferred' : 'normal';
        const rows = all.filter((row) => row.rank === rank);
        const selected =
          kind === 'biography' ? pageDocumentReferences(read.subject, [id], locale)[0]?.candidate : undefined;
        // Native rank/language selection also owns which document may be hydrated.
        const facts = selected ? rows.filter((row) => row.id === selected) : rows;
        return {
          id,
          label: pickText(release.properties[id]?.labels ?? {}, locale),
          presentable: release.properties[id]?.datatype === (kind === 'biography' ? 'document' : 'wikibase-item'),
          facts: facts.slice(0, personBounds.facts),
          more: facts.length > personBounds.facts,
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
