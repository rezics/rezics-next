import { RV } from '../work/activate.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import { checkedSemanticValue, type SemanticValue } from '../semantic/value.ts';

/**
 * Owner schema for identified relation occurrences (MODEL05/06). An occurrence
 * references one exact relation DefinitionRef (a `semantic-definition-v1`
 * revision); each participation binds one role and one participant to that
 * occurrence only. Occurrence identities are allocated, never derived from the
 * participants, so the same participants in two associations stay two occurrences.
 * Revisions reuse `rv:RevisionAnchor`, the graph receipt and the outbox batch.
 */
export const RELATION_TERMS = {
  occurrence: `${RV}RelationOccurrence`,
  revision: `${RV}RelationOccurrenceRevision`,
  definition: `${RV}relationDefinition`,
  head: `${RV}occurrenceHead`,
  participation: `${RV}participation`,
  role: `${RV}role`,
  participant: `${RV}participant`,
  back: `${RV}occurrence`,
  format: `${RV}participationFormat`,
  creditedName: `${RV}creditedName`,
} as const;

/** Marks a participation that routes to the `relation-occurrence-v2` shape. */
export const PARTICIPATION_FORMAT_V2 = `${RV}CreditedNameV2`;

export const RELATION_LIMITS = { participants: 64, applicability: 8, position: 1023, creditedName: 200 } as const;

export type Participant = Extract<SemanticValue, { kind: 'resource' } | { kind: 'external' }>;

/** The name credited to the participant in one occurrence; the participant keeps its own names. */
export interface CreditedName { lexical: string; language: string }

export interface Participation {
  /** Role IRI declared by the exact relation definition revision. */
  role: string;
  participant: Participant;
  position?: number;
  /** Absent on v1 occurrences. */
  creditedName?: CreditedName;
}

/** Current occurrence envelope in the current graph. */
export interface RelationOccurrenceHead {
  occurrence: string;
  definition: string;
  head: string;
  participations: readonly (Participation & { iri: string })[];
  applicability: readonly string[];
}

/** Immutable occurrence revision; `definition` stays the exact revision it was written under. */
export interface RelationOccurrenceRevision {
  revision: string;
  occurrence: string;
  predecessor: string | null;
  definition: string;
  lifecycle: 'active' | 'retired';
  participantCount: number;
  operation: string;
  manifest: string;
  modelGeneration: string;
  dataEpoch: string;
  sequence: string;
}

/** Role declaration retained in a relation definition revision's manifest. */
export interface RelationRoleDefinition {
  role: string;
  minParticipants: number;
  maxParticipants: number;
  ordered: boolean;
}

export class InvalidRelationOccurrence extends Error {}

function checkedCreditedName(value: unknown): CreditedName {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'lexical' && key !== 'language')) {
    throw new InvalidRelationOccurrence('credited name must be a language-tagged string');
  }
  const row = value as Record<string, unknown>;
  let checked: SemanticValue;
  try {
    checked = checkedSemanticValue({ kind: 'language-string', lexical: row.lexical, language: row.language });
  } catch {
    throw new InvalidRelationOccurrence('credited name must be a language-tagged string');
  }
  if (checked.kind !== 'language-string' || !checked.lexical.trim()
    || checked.lexical.length > RELATION_LIMITS.creditedName) {
    throw new InvalidRelationOccurrence('credited name is outside the admitted bound');
  }
  return { lexical: checked.lexical, language: checked.language };
}

/**
 * Validate participations against the definition's roles. A repeated
 * (role, participant) pair in one occurrence is rejected; repetition across
 * occurrences is the caller's intent and keeps separate identities.
 */
export function checkedParticipations(roles: readonly RelationRoleDefinition[],
  participations: readonly unknown[]): Participation[] {
  if (!participations.length || participations.length > RELATION_LIMITS.participants) {
    throw new InvalidRelationOccurrence('participant count is outside the admitted bound');
  }
  const byRole = new Map(roles.map(role => [role.role, role]));
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const checked = participations.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['role', 'participant', 'position', 'creditedName'].includes(key))) {
      throw new InvalidRelationOccurrence('participation has unsupported fields');
    }
    const row = item as Record<string, unknown>;
    const role = typeof row.role === 'string' ? byRole.get(row.role) : undefined;
    if (!role) throw new InvalidRelationOccurrence('participation role is not declared by the definition');
    const participant = checkedSemanticValue(row.participant);
    if (participant.kind !== 'resource' && participant.kind !== 'external') {
      throw new InvalidRelationOccurrence('participant must be a native or external reference');
    }
    const position = row.position;
    if (role.ordered !== (position !== undefined) || (position !== undefined && (!Number.isInteger(position)
      || (position as number) < 0 || (position as number) > RELATION_LIMITS.position))) {
      throw new InvalidRelationOccurrence('participation position does not match the role order');
    }
    const creditedName = row.creditedName === undefined ? undefined : checkedCreditedName(row.creditedName);
    const key = JSON.stringify([role.role, participant]);
    if (seen.has(key)) throw new InvalidRelationOccurrence('participant repeats within one role');
    seen.add(key);
    counts.set(role.role, (counts.get(role.role) ?? 0) + 1);
    return { role: role.role, participant, ...(position === undefined ? {} : { position: position as number }),
      ...(creditedName ? { creditedName } : {}) };
  });
  for (const role of roles) {
    const count = counts.get(role.role) ?? 0;
    if (count < role.minParticipants || count > role.maxParticipants) {
      throw new InvalidRelationOccurrence('role cardinality differs from the definition');
    }
  }
  return checked;
}

export function checkedApplicability(values: readonly string[]): string[] {
  if (values.length > RELATION_LIMITS.applicability || new Set(values).size !== values.length) {
    throw new InvalidRelationOccurrence('applicability references are invalid');
  }
  return values.map(checkedNativeIri).sort();
}

/**
 * `work-author-credit-v1` is the bounded, append-only profile of this owner. Its
 * credits stay in their reviewed shape; relation reads map them onto the general
 * occurrence view instead of copying them into a second occurrence model. Role
 * IRIs identify roles only; no `schema:author` edge is asserted.
 */
const AUTHOR_CREDIT = 'https://rezics.com/definition/work-author-credit-v1';

export const AUTHOR_CREDIT_RELATION = {
  definition: AUTHOR_CREDIT,
  occurrenceType: `${RV}AuthorCredit`,
  revisionType: `${RV}AuthorCreditRevision`,
  roles: [
    { role: `${AUTHOR_CREDIT}/role/work`, minParticipants: 1, maxParticipants: 1, ordered: false },
    { role: `${AUTHOR_CREDIT}/role/author`, minParticipants: 1, maxParticipants: 1, ordered: true },
  ],
  appendOnly: true,
} as const satisfies { roles: readonly RelationRoleDefinition[] } & Record<string, unknown>;

/** Map one retained author credit onto the general participations. */
export function authorCreditParticipations(credit: { work: string; externalKey: string; position: number }): Participation[] {
  return [
    { role: `${AUTHOR_CREDIT}/role/work`, participant: { kind: 'resource', ref: checkedNativeIri(credit.work) } },
    { role: `${AUTHOR_CREDIT}/role/author`, position: credit.position,
      participant: { kind: 'external', provider: 'open-library', namespace: 'author', key: credit.externalKey } },
  ];
}
