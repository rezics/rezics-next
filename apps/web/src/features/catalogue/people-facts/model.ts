import { profileFieldFacts, personEvidenceFits, type PersonStatement } from '../person-reader/model';
import type { ProfileReading } from '../person-reader/reader';
import { valueRequest, valueExplanationHref } from '../value-explanation';

export const factVisitBounds = { bytes: 1024 * 1024, fields: 64, facts: 4096, rows: 20, filter: 128, href: 4096 };
export type FactProjection = { fields: Record<string, PersonStatement[]>; bytes: number; entries: number };

/** Admission is all-or-unavailable. It never truncates a statement's evidence or fetches a document. */
export function admitFacts(reading: ProfileReading, ids: readonly string[]): FactProjection | undefined {
  const fields: FactProjection['fields'] = {};
  const related: Record<string, unknown> = {};
  const definitions: Record<string, unknown> = {};
  let entries = 0;
  const unique = [...new Set(ids)];
  if (unique.length > factVisitBounds.fields) return;
  for (const id of unique) {
    const facts = profileFieldFacts(reading.release, reading.public, id, reading.locale);
    entries += facts.length;
    if (entries > factVisitBounds.facts || facts.some((fact) => !personEvidenceFits(fact))) return;
    fields[id] = facts;
    definitions[id] = reading.release.properties[id];
    for (const fact of facts) {
      for (const part of [fact, ...fact.qualifiers, ...fact.references.flatMap((reference) => reference.parts)]) {
        entries++;
        definitions[part.property.id] = reading.release.properties[part.property.id];
        if (part.property.data_type === 'wikibase-item' && part.value.type === 'value') {
          const target = part.value.content;
          if (typeof target === 'string' && Object.hasOwn(reading.public.related, target))
            related[target] = reading.public.related[target];
        }
      }
    }
  }
  // Include every admitted label, evidence part and document representation, not just a row count.
  const bytes = new TextEncoder().encode(
    JSON.stringify({ fields, related, definitions, documents: reading.documents }),
  ).byteLength;
  if (bytes > factVisitBounds.bytes) return;
  return { fields, bytes, entries };
}

export function factAddress(reading: ProfileReading, statement: PersonStatement) {
  try {
    const address = valueRequest({
      id: reading.public.subject.id,
      property: statement.property.id,
      statement: statement.id,
      context: reading.public.subject.context,
      locale: reading.locale,
    });
    // Labels are cosmetic; never put an unbounded label or local filter in a return URL.
    const href = valueExplanationHref({ ...address, title: '' }, reading.locale);
    if (new TextEncoder().encode(href).byteLength > factVisitBounds.href) return;
    return { address, href };
  } catch {
    return;
  }
}

export const factFieldAnchor = (id: string) => `profile-fact-${encodeURIComponent(id)}`;
