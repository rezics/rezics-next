import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PeopleRead } from '../people-profile';
import { peopleAgentType, peopleBiographyGroups } from '../people-biography';
import { producerHistoryStreams, producerHistoryUnreleased } from '../producer-history';

export type OrganizationCurrent = Extract<PeopleRead, { ok: true }> & { public: SubjectRead };
export type OrganizationReading = Pick<OrganizationCurrent, 'public'> & {
  release: Pick<OrganizationCurrent['release'], 'types' | 'properties'>;
};
export type OrganizationFact = SubjectRead['subject']['statements'][string][number];
export type OrganizationField = {
  id: string;
  label: ReturnType<typeof pickText>;
  kind: 'history' | 'dates' | 'relations';
  facts: OrganizationFact[];
  unavailable: boolean;
};
export const organizationBounds = {
  bytes: 2 * 1024 * 1024,
  fields: 32,
  facts: 20,
  qualifiers: 32,
  references: 16,
  parts: 16,
};

/** The public response is the evidence. Neither dates nor names manufacture an edge. */
export function organizationHistory(read: OrganizationReading, locale: string) {
  const { release, public: current } = read;
  const type = current.subject.type;
  if (peopleAgentType(release, type) !== 'schema:Organization') return;
  const groups = peopleBiographyGroups(release, type, locale, current);
  const affiliationIds = groups.flatMap((group) => group.fields.map((field) => field.id));
  const streams = producerHistoryStreams(release, type, locale).filter((stream) => stream.direction === 'forward');
  const credits = (release.types[type]?.properties ?? []).filter(
    (id) => release.properties[id]?.relation?.group === 'credit',
  );
  const relationIds = new Set([...affiliationIds, ...streams.map((stream) => stream.property), ...credits]);
  const identity = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
  const fields: OrganizationField[] = [];
  let limited = false;
  for (const id of release.types[type]?.properties ?? []) {
    const property = release.properties[id];
    if (!property || identity.has(id)) continue;
    const kind = relationIds.has(id)
      ? 'relations'
      : property.datatype === 'time'
        ? 'dates'
        : ['string', 'monolingualtext', 'document'].includes(property.datatype)
          ? 'history'
          : undefined;
    if (!kind) continue;
    if (fields.length === organizationBounds.fields) {
      limited = true;
      break;
    }
    const facts = current.subject.statements[id] ?? [];
    const accepted: OrganizationFact[] = [];
    for (const fact of facts.slice(0, organizationBounds.facts)) {
      // Evidence is indivisible: never display a value stripped of oversized citations or qualifiers.
      if (
        fact.qualifiers.length > organizationBounds.qualifiers ||
        fact.references.length > organizationBounds.references ||
        fact.references.some((reference) => reference.parts.length > organizationBounds.parts)
      ) {
        limited = true;
        continue;
      }
      if (fact.property.id !== id || fact.property.data_type !== property.datatype) {
        limited = true;
        continue;
      }
      accepted.push(fact);
    }
    if (facts.length > organizationBounds.facts) limited = true;
    fields.push({
      id,
      label: pickText(property.labels, locale),
      kind,
      facts: accepted,
      unavailable: facts.length > 0 && accepted.length === 0,
    });
  }
  return {
    grain: pickText(release.types[type]?.labels ?? {}, locale),
    fields,
    limited,
    authoredUnsupported: !(release.types[type]?.properties ?? []).some(
      (id) => release.properties[id]?.datatype === 'document',
    ),
    unreleased: producerHistoryUnreleased(release, type),
  };
}

/** Admit the released composition pair without manufacturing a complete native release envelope. */
export function organizationAdmission(read: OrganizationReading, id: string, context: string): boolean {
  if (
    read.public.subject.id !== id ||
    read.public.subject.context !== context ||
    peopleAgentType(read.release, read.public.subject.type) !== 'schema:Organization'
  )
    return false;
  try {
    return new TextEncoder().encode(JSON.stringify(read.public)).byteLength <= organizationBounds.bytes;
  } catch {
    return false;
  }
}

/** Admit a bounded current observation before mounting document or evidence readers. */
export function organizationCurrent(read: PeopleRead, id: string, context: string): OrganizationCurrent | undefined {
  if (!read.ok || !read.public || !organizationAdmission({ public: read.public, release: read.release }, id, context))
    return;
  return { ...read, public: read.public };
}
