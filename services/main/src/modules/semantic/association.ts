import type { DefinitionState, RelationRole } from './change.ts';
import { SemanticChangeRejected } from './command.ts';

export type SemanticChangeProfile = 'semantic-change-v1' | 'semantic-change-v2';
export interface AssociationBinding {
  kind: 'appearance' | 'credit';
  workRole: string;
  subjectRoles: string[];
}
export interface RetainedCreditMapping {
  origin: 'work-author-credit-v1' | 'native-agent-credit-v1' | 'source-reported-credit-v1';
  storedRole: 'author' | 'translator' | 'editor' | 'director' | 'artist' | 'animation-studio' | 'transcriber';
  subjectRole: string;
  externalNamespace?: { provider: string; namespace: string };
}

const invalid = (message: string): never => { throw new SemanticChangeRejected('invalid-association-binding', message); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) return invalid('association binding has unsupported fields');
  return value as Record<string, unknown>;
};
export const qualifiedSourceKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) && value.length <= 128;

/** These bindings are authored meaning, never inferred from labels or participant types. */
export function checkedAssociation(value: unknown, roles: readonly RelationRole[], workSubjectRole: unknown): AssociationBinding {
  const row = object(value, ['kind', 'workRole', 'subjectRoles']);
  if (row.kind !== 'appearance' && row.kind !== 'credit') return invalid('association kind is invalid');
  if (typeof row.workRole !== 'string' || row.workRole !== workSubjectRole
    || !roles.some(role => role.key === row.workRole && role.minParticipants === 1 && role.maxParticipants === 1)) {
    return invalid('association Work role must be the declared required singleton authority role');
  }
  if (!Array.isArray(row.subjectRoles) || !row.subjectRoles.length || row.subjectRoles.length > 15
    || new Set(row.subjectRoles).size !== row.subjectRoles.length
    || row.subjectRoles.some(key => typeof key !== 'string' || key === row.workRole
      || !roles.some(role => role.key === key && role.maxParticipants >= 1))) {
    return invalid('association subjects must name distinct declared non-Work roles');
  }
  return { kind: row.kind, workRole: row.workRole, subjectRoles: [...row.subjectRoles as string[]].sort() };
}

export function checkedRetainedCredit(value: unknown, association: AssociationBinding | undefined): RetainedCreditMapping {
  const row = object(value, ['origin', 'storedRole', 'subjectRole', 'externalNamespace']);
  if (association?.kind !== 'credit' || typeof row.subjectRole !== 'string'
    || !association.subjectRoles.includes(row.subjectRole)
    || !['work-author-credit-v1', 'native-agent-credit-v1', 'source-reported-credit-v1'].includes(row.origin as string)
    || !['author', 'translator', 'editor', 'director', 'artist', 'animation-studio', 'transcriber'].includes(row.storedRole as string)
    || row.storedRole === 'transcriber' && row.origin !== 'source-reported-credit-v1') {
    return invalid('retained credit mapping must bind an exact credit origin, stored role and association subject role');
  }
  let externalNamespace: RetainedCreditMapping['externalNamespace'];
  if (row.externalNamespace !== undefined) {
    const namespace = object(row.externalNamespace, ['provider', 'namespace']);
    if (row.origin !== 'source-reported-credit-v1' || !qualifiedSourceKey(namespace.provider)
      || !qualifiedSourceKey(namespace.namespace)) return invalid('external namespace requires a qualified source-reported credit origin');
    externalNamespace = { provider: namespace.provider, namespace: namespace.namespace };
  }
  return { origin: row.origin as RetainedCreditMapping['origin'], storedRole: row.storedRole as RetainedCreditMapping['storedRole'],
    subjectRole: row.subjectRole, ...(externalNamespace ? { externalNamespace } : {}) };
}

/** V1 revisions stay unclassified. Once authored, changing a binding requires a successor component. */
export function assertAssociationMeaning(previous: DefinitionState, next: DefinitionState): void {
  for (const field of ['association', 'retainedCredit'] as const) {
    if (previous[field] !== undefined && JSON.stringify(previous[field]) !== JSON.stringify(next[field])) {
      throw new SemanticChangeRejected('immutable-meaning', 'association meaning requires a new definition and explicit successor');
    }
  }
}
