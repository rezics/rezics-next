import { roleIri, type ExactDefinition } from '../relation/change.ts';

/** Kinds the lexicon reads. A property is named like a relation; other definition kinds stay out of this route. */
export const PUBLIC_DEFINITION_KINDS = ['relation', 'property'] as const;

/**
 * A property stores no participant roles. Its reviewed name is one presentation
 * direction, subject → value, selected by the same language rules as a relation
 * projection. The subject end is the resource a statement is about.
 */
export const PROPERTY_NAME_FROM = 'subject';
export const PROPERTY_NAME_TO = 'value';

export function namedMeaning(meaning: ExactDefinition): ExactDefinition {
  if (meaning.kind !== 'property' || meaning.roles.length > 0) return meaning;
  const keys = [PROPERTY_NAME_FROM, PROPERTY_NAME_TO] as const;
  const roles = keys.map((key) => ({
    role: roleIri(meaning.definition, key),
    minParticipants: 1,
    maxParticipants: 1,
    ordered: false,
  }));
  return {
    ...meaning,
    roles,
    roleKeys: Object.fromEntries(roles.map((role, index) => [role.role, keys[index]!])),
  };
}

/** The direction whose labels name this definition. A property is always read from its subject. */
export function definitionViewingRole(meaning: ExactDefinition): string | undefined {
  if (meaning.kind === 'property') return PROPERTY_NAME_FROM;
  return meaning.workSubjectRole ?? Object.values(meaning.roleKeys)[0];
}
