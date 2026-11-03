import type { RelationDraft } from '../../subject/relation-candidates';
import { candidateContext } from '../../subject/candidates';

export const creditIdentityTypes = ['schema:Person', 'schema:Organization'] as const;
export type CreditIdentityType = (typeof creditIdentityTypes)[number];

export type CreatedCreditIdentity = { id: string; type: CreditIdentityType; label: string };
export type CreditTargetHandoff = {
  token: string;
  createdAt: number;
  workId: string;
  reader: string;
  context: typeof candidateContext;
  releaseDigest: string;
  propertyId: string;
  targets: string[];
  admittedTypes: CreditIdentityType[];
  draft: RelationDraft;
  citation: string;
  phase: 'creating' | 'ready' | 'returning' | 'returned';
  createdId?: string;
  identity?: CreatedCreditIdentity;
};

const prefix = 'rezics:credit-target-handoff:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const handoffLifetime = 30 * 60 * 1000;

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
  return typeof property?.id === 'string' && property.id.length > 0 && property.id.length <= 256 && validValue(item?.value);
}

function validIdentity(value: unknown, createdId?: string): value is CreatedCreditIdentity {
  const item = record(value);
  return (
    !!item &&
    typeof item.id === 'string' &&
    uuid.test(item.id) &&
    item.id === createdId &&
    creditIdentityTypes.includes(item.type as CreditIdentityType) &&
    typeof item.label === 'string' &&
    item.label.length > 0 &&
    item.label.length <= 2048
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

function decode(token: string, value: unknown): CreditTargetHandoff | undefined {
  const item = record(value);
  if (
    !item ||
    item.version !== 1 ||
    item.token !== token ||
    typeof item.createdAt !== 'number' ||
    Date.now() - item.createdAt > handoffLifetime ||
    typeof item.workId !== 'string' ||
    !uuid.test(item.workId) ||
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
    !Array.isArray(item.targets) ||
    item.targets.length > 32 ||
    !item.targets.every((target) => typeof target === 'string' && target.length > 0 && target.length <= 256) ||
    !Array.isArray(item.admittedTypes) ||
    !item.admittedTypes.length ||
    !item.admittedTypes.every(
      (type) => creditIdentityTypes.includes(type as CreditIdentityType) && (item.targets as unknown[]).includes(type),
    ) ||
    typeof item.citation !== 'string' ||
    item.citation.length > 8192 ||
    !['creating', 'ready', 'returning', 'returned'].includes(String(item.phase)) ||
    (item.createdId !== undefined && (typeof item.createdId !== 'string' || !uuid.test(item.createdId))) ||
    !validDraft(item.draft, item.propertyId)
  )
    return undefined;
  if (item.identity !== undefined && !validIdentity(item.identity, item.createdId as string | undefined))
    return undefined;
  if ((item.phase === 'ready' || item.phase === 'returning' || item.phase === 'returned') && !item.identity)
    return undefined;
  return item as unknown as CreditTargetHandoff;
}

function persist(value: CreditTargetHandoff): boolean {
  const target = store();
  if (!target) return false;
  try {
    target.setItem(`${prefix}${value.token}`, JSON.stringify({ ...value, version: 1 }));
    return true;
  } catch {
    return false;
  }
}

export function createCreditTargetHandoff(
  input: Omit<CreditTargetHandoff, 'token' | 'createdAt' | 'phase' | 'createdId' | 'identity'>,
): CreditTargetHandoff | undefined {
  if (
    !uuid.test(input.workId) ||
    !input.reader ||
    input.context !== candidateContext ||
    !input.releaseDigest ||
    !input.admittedTypes.length ||
    !input.admittedTypes.every(
      (type) => creditIdentityTypes.includes(type) && input.targets.includes(type),
    ) ||
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

export function readCreditTargetHandoff(token: string): CreditTargetHandoff | undefined {
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

export function recordCreatedCreditIdentity(
  token: string,
  workId: string,
  reader: string,
  id: string,
  identity?: CreatedCreditIdentity,
): CreditTargetHandoff | undefined {
  const value = readCreditTargetHandoff(token);
  if (!value || value.phase !== 'creating' || value.workId !== workId || value.reader !== reader || !uuid.test(id))
    return undefined;
  if (value.createdId && value.createdId !== id) {
    discardCreditTargetHandoff(token);
    return undefined;
  }
  value.createdId = id;
  const createdIdentity = identity && value.admittedTypes.includes(identity.type) && validIdentity(identity, id)
    ? identity
    : undefined;
  if (createdIdentity) value.identity = createdIdentity;
  else delete value.identity;
  value.phase = createdIdentity ? 'ready' : 'creating';
  return persist(value) ? value : undefined;
}

export function beginCreditTargetReturn(token: string, workId: string, reader: string): boolean {
  const value = readCreditTargetHandoff(token);
  if (!value || value.phase !== 'ready' || value.workId !== workId || value.reader !== reader || !value.identity)
    return false;
  value.phase = 'returning';
  return persist(value);
}

export function claimCreditTargetReturn(
  token: string,
  workId: string,
  reader: string,
): CreditTargetHandoff | undefined {
  const value = readCreditTargetHandoff(token);
  if (!value || value.phase !== 'returning' || value.workId !== workId || value.reader !== reader || !value.identity) {
    discardCreditTargetHandoff(token);
    return undefined;
  }
  value.phase = 'returned';
  return persist(value) ? value : undefined;
}

export function discardCreditTargetHandoff(token: string): void {
  if (!uuid.test(token)) return;
  const target = store();
  try {
    target?.removeItem(`${prefix}${token}`);
  } catch {
    // Storage may be disabled after the handoff was created.
  }
}
