import type { RelationDraft, RelationSlot } from '../../subject/relation-candidates';
import { candidateContext } from '../../subject/candidates';

/** Released work-to-work groups. Membership, credit, appearance and classification keep their owners. */
export const relatedWorkRelationGroups = ['derivation', 'world', 'association', 'order'] as const;
export type RelatedWorkRelationGroup = (typeof relatedWorkRelationGroups)[number];

export type CreatedRelatedWork = { id: string; type: string; label: string; bases: string[] };
export type RelatedWorkHandoff = {
  token: string;
  createdAt: number;
  workId: string;
  sourceLabel: string;
  reader: string;
  context: typeof candidateContext;
  releaseDigest: string;
  propertyId: string;
  propertyLabel: string;
  group: RelatedWorkRelationGroup;
  targets: string[];
  slot?: RelationSlot;
  draft: RelationDraft;
  citation: string;
  rank: 'normal' | 'preferred';
  qualifierIdentities: number[];
  phase: 'creating' | 'ready' | 'returning' | 'returningDraft' | 'returned';
  createdId?: string;
  identity?: CreatedRelatedWork;
};

const prefix = 'rezics:related-work-handoff:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const typeId = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]{1,256}$/;
const handoffLifetime = 30 * 60 * 1000;

export function isRelatedWorkGroup(group: string): group is RelatedWorkRelationGroup {
  return (relatedWorkRelationGroups as readonly string[]).includes(group);
}

/** Exact Type or a listed structural base from the current creation descriptor; never a hardcoded Type. */
export function relatedWorkTargetAdmitted(type: string, bases: readonly string[], targets: readonly string[]): boolean {
  return targets.includes(type) || bases.some((base) => targets.includes(base));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function store() {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function validValue(value: unknown): boolean {
  const item = record(value);
  if (!item || !['value', 'somevalue', 'novalue'].includes(String(item.type))) return false;
  return item.type !== 'value' || typeof item.content === 'string' || typeof item.content === 'number';
}

function validSnak(value: unknown): boolean {
  const item = record(value);
  const property = record(item?.property);
  return (
    typeof property?.id === 'string' && property.id.length > 0 && property.id.length <= 256 && validValue(item?.value)
  );
}

function validSlot(value: unknown): value is RelationSlot {
  const item = record(value);
  return (
    !!item &&
    typeof item.property === 'string' &&
    item.property.length > 0 &&
    item.property.length <= 256 &&
    ((typeof item.target === 'string' && uuid.test(item.target) && item.sameAs === undefined) ||
      (typeof item.sameAs === 'string' && item.target === undefined)) &&
    (item.key === undefined || (typeof item.key === 'string' && uuid.test(item.key)))
  );
}

function validIdentity(value: unknown, createdId?: string): value is CreatedRelatedWork {
  const item = record(value);
  return (
    !!item &&
    typeof item.id === 'string' &&
    uuid.test(item.id) &&
    item.id === createdId &&
    typeof item.type === 'string' &&
    typeId.test(item.type) &&
    typeof item.label === 'string' &&
    item.label.length > 0 &&
    item.label.length <= 2048 &&
    Array.isArray(item.bases) &&
    item.bases.length <= 32 &&
    item.bases.every((base) => typeof base === 'string' && typeId.test(base))
  );
}

function validDraft(value: unknown, propertyId: string): value is RelationDraft {
  const item = record(value);
  const property = record(item?.property);
  const relationValue = record(item?.value);
  if (
    !item ||
    !property ||
    property.id !== propertyId ||
    property.data_type !== 'wikibase-item' ||
    relationValue?.type !== 'somevalue' ||
    !Array.isArray(item.qualifiers) ||
    item.qualifiers.length > 16 ||
    !item.qualifiers.every(validSnak) ||
    !Array.isArray(item.references) ||
    item.references.length > 16
  )
    return false;
  return item.references.every((reference) => {
    const entry = record(reference);
    return !!entry && Array.isArray(entry.parts) && entry.parts.length <= 16 && entry.parts.every(validSnak);
  });
}

function decode(token: string, value: unknown): RelatedWorkHandoff | undefined {
  const item = record(value);
  if (
    !item ||
    item.version !== 1 ||
    item.token !== token ||
    typeof item.createdAt !== 'number' ||
    Date.now() - item.createdAt > handoffLifetime ||
    typeof item.workId !== 'string' ||
    !uuid.test(item.workId) ||
    typeof item.sourceLabel !== 'string' ||
    item.sourceLabel.length > 2048 ||
    typeof item.reader !== 'string' ||
    item.reader.length < 1 ||
    item.reader.length > 256 ||
    item.context !== candidateContext ||
    typeof item.releaseDigest !== 'string' ||
    item.releaseDigest.length < 1 ||
    item.releaseDigest.length > 512 ||
    typeof item.propertyId !== 'string' ||
    item.propertyId.length < 1 ||
    item.propertyId.length > 256 ||
    typeof item.propertyLabel !== 'string' ||
    item.propertyLabel.length > 2048 ||
    !isRelatedWorkGroup(String(item.group)) ||
    !Array.isArray(item.targets) ||
    item.targets.length < 1 ||
    item.targets.length > 32 ||
    !item.targets.every((target) => typeof target === 'string' && target.length > 0 && target.length <= 256) ||
    (item.slot !== undefined && !validSlot(item.slot)) ||
    typeof item.citation !== 'string' ||
    item.citation.length > 8192 ||
    (item.rank !== 'normal' && item.rank !== 'preferred') ||
    !Array.isArray(item.qualifierIdentities) ||
    item.qualifierIdentities.length > 16 ||
    !item.qualifierIdentities.every((id) => Number.isInteger(id) && Number(id) >= 0 && Number(id) < 1_000_000) ||
    !['creating', 'ready', 'returning', 'returningDraft', 'returned'].includes(String(item.phase)) ||
    (item.createdId !== undefined && (typeof item.createdId !== 'string' || !uuid.test(item.createdId))) ||
    !validDraft(item.draft, item.propertyId)
  )
    return undefined;
  const draft = item.draft as RelationDraft;
  if (item.qualifierIdentities.length !== draft.qualifiers.length) return undefined;
  if (item.identity !== undefined && !validIdentity(item.identity, item.createdId as string | undefined))
    return undefined;
  if ((item.phase === 'ready' || item.phase === 'returning' || item.phase === 'returned') && !item.identity)
    return undefined;
  return item as unknown as RelatedWorkHandoff;
}

function persist(value: RelatedWorkHandoff): boolean {
  const target = store();
  if (!target) return false;
  try {
    target.setItem(`${prefix}${value.token}`, JSON.stringify({ ...value, version: 1 }));
    return true;
  } catch {
    return false;
  }
}

export function createRelatedWorkHandoff(
  input: Omit<RelatedWorkHandoff, 'token' | 'createdAt' | 'phase' | 'createdId' | 'identity'>,
): RelatedWorkHandoff | undefined {
  if (
    !uuid.test(input.workId) ||
    !input.reader ||
    input.context !== candidateContext ||
    !input.releaseDigest ||
    !isRelatedWorkGroup(input.group) ||
    !input.targets.length ||
    (input.slot !== undefined && input.slot.property !== input.propertyId) ||
    input.qualifierIdentities.length !== input.draft.qualifiers.length ||
    !validDraft(input.draft, input.propertyId)
  )
    return undefined;
  const token = crypto.randomUUID();
  const value = { ...structuredClone(input), token, createdAt: Date.now(), phase: 'creating' as const };
  const target = store();
  if (!target) return undefined;
  try {
    target.setItem(`${prefix}${token}`, JSON.stringify({ ...value, version: 1 }));
    return value;
  } catch {
    return undefined;
  }
}

export function readRelatedWorkHandoff(token: string): RelatedWorkHandoff | undefined {
  if (!uuid.test(token)) return undefined;
  const target = store();
  if (!target) return undefined;
  try {
    const raw = target.getItem(`${prefix}${token}`);
    if (!raw || raw.length > 65536) return undefined;
    const value = decode(token, JSON.parse(raw));
    if (!value) target.removeItem(`${prefix}${token}`);
    return value;
  } catch {
    return undefined;
  }
}

export function recordCreatedRelatedWork(
  token: string,
  workId: string,
  reader: string,
  id: string,
  identity?: CreatedRelatedWork,
): RelatedWorkHandoff | undefined {
  const value = readRelatedWorkHandoff(token);
  if (!value || value.phase !== 'creating' || value.workId !== workId || value.reader !== reader || !uuid.test(id))
    return undefined;
  if (value.createdId && value.createdId !== id) {
    discardRelatedWorkHandoff(token);
    return undefined;
  }
  value.createdId = id;
  const createdIdentity =
    identity && validIdentity(identity, id) && relatedWorkTargetAdmitted(identity.type, identity.bases, value.targets)
      ? identity
      : undefined;
  if (createdIdentity) value.identity = createdIdentity;
  else delete value.identity;
  value.phase = createdIdentity ? 'ready' : 'creating';
  return persist(value) ? value : undefined;
}

export function beginRelatedWorkReturn(token: string, workId: string, reader: string): boolean {
  const value = readRelatedWorkHandoff(token);
  if (!value || value.phase !== 'ready' || value.workId !== workId || value.reader !== reader || !value.identity)
    return false;
  value.phase = 'returning';
  return persist(value);
}

export function beginRelatedWorkDraftReturn(token: string, workId: string, reader: string): boolean {
  const value = readRelatedWorkHandoff(token);
  if (!value || value.phase !== 'creating' || value.workId !== workId || value.reader !== reader || value.createdId)
    return false;
  value.phase = 'returningDraft';
  return persist(value);
}

export function claimRelatedWorkReturn(token: string, workId: string, reader: string): RelatedWorkHandoff | undefined {
  const value = readRelatedWorkHandoff(token);
  if (
    !value ||
    (value.phase !== 'returning' && value.phase !== 'returningDraft') ||
    value.workId !== workId ||
    value.reader !== reader ||
    (value.phase === 'returning' && !value.identity)
  ) {
    discardRelatedWorkHandoff(token);
    return undefined;
  }
  value.phase = 'returned';
  return persist(value) ? value : undefined;
}

export function discardRelatedWorkHandoff(token: string): void {
  if (!uuid.test(token)) return;
  const target = store();
  try {
    target?.removeItem(`${prefix}${token}`);
  } catch {
    // Storage may be disabled after the handoff was created.
  }
}
