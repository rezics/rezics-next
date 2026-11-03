import type { Release } from '@rezics/definitions';
import { candidateContext } from '../../subject/candidates';
import { typeExtends } from '../pages/graph-browser';
import { statementInput, type StatementInput } from './statement-editor';
import { conceptTypeAdmitted } from './source-concept-explorer';
import { factHolder, factLocked, type FactDraft } from './subject-facts';

export type CreatedClassificationIdentity = { id: string; type: string; label: string; bases: string[] };
export type ClassificationDraftSnapshot = {
  holder: string;
  property: string;
  source: string | null;
  included: boolean;
  statement: StatementInput;
  baseline: StatementInput | null;
};
export type ClassificationCreateHandoff = {
  token: string;
  createdAt: number;
  sourceId: string;
  sourceLabel: string;
  sourceType: string;
  returnPath: string;
  reader: string;
  context: typeof candidateContext;
  releaseDigest: string;
  propertyId: string;
  propertyLabel: string;
  holder: string;
  originalStatementId: string | null;
  targets: string[];
  drafts: ClassificationDraftSnapshot[];
  reviewFingerprint: string;
  phase: 'creating' | 'ready' | 'returning' | 'returningDraft' | 'returned';
  createdId?: string;
  identity?: CreatedClassificationIdentity;
};

const prefix = 'rezics:classification-create-handoff:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const typeId = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]{1,256}$/;
const handoffLifetime = 30 * 60 * 1000;

export function classificationHandoffSearch(input: Record<string, unknown>): string | undefined {
  return typeof input.classificationHandoff === 'string' && uuid.test(input.classificationHandoff)
    ? input.classificationHandoff
    : undefined;
}

/** Exact Type or a listed structural base from the current creation descriptor. */
export function classificationTargetAdmitted(
  type: string,
  bases: readonly string[],
  targets: readonly string[],
): boolean {
  return targets.includes(type) || bases.some((base) => targets.includes(base));
}

export function classificationMissingConceptTargets(release: Release, property: string): string[] {
  const definition = release.properties[property];
  if (!definition || definition.datatype !== 'wikibase-item' || definition.relation?.group !== 'classification')
    return [];
  return (definition.targets ?? []).filter((target) => typeof target === 'string' && target.length > 0);
}

export function classificationMissingConceptAdmitted(release: Release, property: string): boolean {
  const targets = classificationMissingConceptTargets(release, property);
  if (!targets.length) return false;
  return Object.keys(release.types).some(
    (id) => conceptTypeAdmitted(release, id) && classificationTargetAdmitted(id, release.types[id]?.bases ?? [], targets),
  );
}

export function classificationCreatedTypeAdmitted(
  release: Release,
  property: string,
  type: string,
  bases: readonly string[],
): boolean {
  const targets = classificationMissingConceptTargets(release, property);
  return conceptTypeAdmitted(release, type) && classificationTargetAdmitted(type, bases, targets);
}

type RankedStatement = Parameters<typeof statementInput>[0] & { rank?: string };

/** Correction drafts keep admitted preferred rank; initial creation stays normal. */
export function classificationStatementInput(statement: RankedStatement): StatementInput {
  const input = statementInput(statement);
  return statement.rank === 'preferred' ? { ...input, rank: 'preferred' } : input;
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

function validStatement(value: unknown): value is StatementInput {
  const item = record(value);
  const property = record(item?.property);
  if (
    !item ||
    !property ||
    typeof property.id !== 'string' ||
    property.id.length < 1 ||
    property.id.length > 256 ||
    !validValue(item.value) ||
    (item.qualifiers !== undefined &&
      (!Array.isArray(item.qualifiers) || item.qualifiers.length > 16 || !item.qualifiers.every(validSnak))) ||
    !Array.isArray(item.references) ||
    item.references.length > 16 ||
    (item.rank !== 'normal' && item.rank !== 'preferred')
  )
    return false;
  return item.references.every((reference) => {
    const entry = record(reference);
    return !!entry && Array.isArray(entry.parts) && entry.parts.length <= 16 && entry.parts.every(validSnak);
  });
}

function validIdentity(value: unknown, createdId?: string): value is CreatedClassificationIdentity {
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

function validSnapshot(value: unknown): value is ClassificationDraftSnapshot {
  const item = record(value);
  return (
    !!item &&
    typeof item.holder === 'string' &&
    uuid.test(item.holder) &&
    typeof item.property === 'string' &&
    item.property.length > 0 &&
    item.property.length <= 256 &&
    (item.source === null || (typeof item.source === 'string' && uuid.test(item.source))) &&
    typeof item.included === 'boolean' &&
    validStatement(item.statement) &&
    (item.baseline === null || validStatement(item.baseline))
  );
}

function decode(token: string, value: unknown): ClassificationCreateHandoff | undefined {
  const item = record(value);
  if (
    !item ||
    item.version !== 1 ||
    item.token !== token ||
    typeof item.createdAt !== 'number' ||
    Date.now() - item.createdAt > handoffLifetime ||
    typeof item.sourceId !== 'string' ||
    !uuid.test(item.sourceId) ||
    typeof item.sourceLabel !== 'string' ||
    item.sourceLabel.length > 2048 ||
    typeof item.sourceType !== 'string' ||
    typeId.test(item.sourceType) === false ||
    typeof item.returnPath !== 'string' ||
    item.returnPath.length < 1 ||
    item.returnPath.length > 2048 ||
    item.returnPath.includes('://') ||
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
    typeof item.holder !== 'string' ||
    !uuid.test(item.holder) ||
    (item.originalStatementId !== null &&
      (typeof item.originalStatementId !== 'string' || !uuid.test(item.originalStatementId))) ||
    !Array.isArray(item.targets) ||
    item.targets.length < 1 ||
    item.targets.length > 32 ||
    !item.targets.every((target) => typeof target === 'string' && target.length > 0 && target.length <= 256) ||
    !Array.isArray(item.drafts) ||
    item.drafts.length < 1 ||
    item.drafts.length > 16 ||
    !item.drafts.every(validSnapshot) ||
    typeof item.reviewFingerprint !== 'string' ||
    item.reviewFingerprint.length > 65536 ||
    !['creating', 'ready', 'returning', 'returningDraft', 'returned'].includes(String(item.phase)) ||
    (item.createdId !== undefined && (typeof item.createdId !== 'string' || !uuid.test(item.createdId)))
  )
    return undefined;
  const drafts = item.drafts as ClassificationDraftSnapshot[];
  if (!drafts.some((draft) => draft.holder === item.holder && draft.property === item.propertyId)) return undefined;
  if (item.identity !== undefined && !validIdentity(item.identity, item.createdId as string | undefined))
    return undefined;
  if ((item.phase === 'ready' || item.phase === 'returning' || item.phase === 'returned') && !item.identity)
    return undefined;
  return item as unknown as ClassificationCreateHandoff;
}

function persist(value: ClassificationCreateHandoff): boolean {
  const target = store();
  if (!target) return false;
  try {
    target.setItem(`${prefix}${value.token}`, JSON.stringify({ ...value, version: 1 }));
    return true;
  } catch {
    return false;
  }
}

export function snapshotClassificationDrafts(drafts: readonly FactDraft[]): ClassificationDraftSnapshot[] | undefined {
  if (!drafts.length || drafts.length > 16) return undefined;
  const snapshots: ClassificationDraftSnapshot[] = [];
  for (const draft of drafts) {
    const holder = factHolder(draft);
    if (!uuid.test(holder) || factLocked(draft) || draft.command) return undefined;
    if (!validStatement(draft.statement) || (draft.baseline !== null && !validStatement(draft.baseline))) return undefined;
    snapshots.push({
      holder,
      property: draft.property,
      source: draft.source,
      included: draft.included,
      statement: structuredClone(draft.statement),
      baseline: draft.baseline ? structuredClone(draft.baseline) : null,
    });
  }
  return snapshots;
}

export function restoreClassificationDrafts(snapshots: readonly ClassificationDraftSnapshot[]): FactDraft[] {
  return snapshots.map((snapshot) => ({
    holder: snapshot.holder,
    property: snapshot.property,
    source: snapshot.source,
    included: snapshot.included,
    statement: structuredClone(snapshot.statement),
    baseline: snapshot.baseline ? structuredClone(snapshot.baseline) : null,
  }));
}

export function classificationTargetUnchosen(statement: StatementInput): boolean {
  return statement.value.type === 'value' && !String(statement.value.content ?? '').trim();
}

export function createClassificationCreateHandoff(
  input: Omit<ClassificationCreateHandoff, 'token' | 'createdAt' | 'phase' | 'createdId' | 'identity'>,
): ClassificationCreateHandoff | undefined {
  if (
    !uuid.test(input.sourceId) ||
    !input.reader ||
    input.context !== candidateContext ||
    !input.releaseDigest ||
    !input.targets.length ||
    !uuid.test(input.holder) ||
    !input.drafts.some((draft) => draft.holder === input.holder && draft.property === input.propertyId) ||
    input.drafts.some((draft) => !validSnapshot(draft))
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

export function readClassificationCreateHandoff(token: string): ClassificationCreateHandoff | undefined {
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

export function recordCreatedClassificationIdentity(
  token: string,
  sourceId: string,
  reader: string,
  id: string,
  identity?: CreatedClassificationIdentity,
): ClassificationCreateHandoff | undefined {
  const value = readClassificationCreateHandoff(token);
  if (!value || value.phase !== 'creating' || value.sourceId !== sourceId || value.reader !== reader || !uuid.test(id))
    return undefined;
  if (value.createdId && value.createdId !== id) {
    discardClassificationCreateHandoff(token);
    return undefined;
  }
  value.createdId = id;
  const createdIdentity =
    identity &&
    validIdentity(identity, id) &&
    classificationTargetAdmitted(identity.type, identity.bases, value.targets)
      ? identity
      : undefined;
  if (createdIdentity) value.identity = createdIdentity;
  else delete value.identity;
  value.phase = createdIdentity ? 'ready' : 'creating';
  return persist(value) ? value : undefined;
}

export function beginClassificationReturn(token: string, sourceId: string, reader: string): boolean {
  const value = readClassificationCreateHandoff(token);
  if (!value || value.phase !== 'ready' || value.sourceId !== sourceId || value.reader !== reader || !value.identity)
    return false;
  value.phase = 'returning';
  return persist(value);
}

export function beginClassificationDraftReturn(token: string, sourceId: string, reader: string): boolean {
  const value = readClassificationCreateHandoff(token);
  if (!value || value.phase !== 'creating' || value.sourceId !== sourceId || value.reader !== reader || value.createdId)
    return false;
  value.phase = 'returningDraft';
  return persist(value);
}

export function claimClassificationReturn(
  token: string,
  sourceId: string,
  reader: string,
): ClassificationCreateHandoff | undefined {
  const value = readClassificationCreateHandoff(token);
  if (value?.phase === 'returned' && value.sourceId === sourceId && value.reader === reader) return value;
  if (
    !value ||
    (value.phase !== 'returning' && value.phase !== 'returningDraft') ||
    value.sourceId !== sourceId ||
    value.reader !== reader ||
    (value.phase === 'returning' && !value.identity)
  ) {
    discardClassificationCreateHandoff(token);
    return undefined;
  }
  value.phase = 'returned';
  return persist(value) ? value : undefined;
}

export function discardClassificationCreateHandoff(token: string): void {
  if (!uuid.test(token)) return;
  const target = store();
  try {
    target?.removeItem(`${prefix}${token}`);
  } catch {
    // Storage may be disabled after the handoff was created.
  }
}

export function classificationReturnHref(returnPath: string, token: string): string {
  const [path, query] = returnPath.split('?');
  const params = new URLSearchParams(query);
  params.set('classificationHandoff', token);
  const search = params.toString();
  return search ? `${path}?${search}` : `${path}?classificationHandoff=${encodeURIComponent(token)}`;
}

export function classificationCreateHref(locale: string, token: string): string {
  return `/${locale}/catalogue/concept?classificationHandoff=${encodeURIComponent(token)}`;
}

export function currentEditorReturnPath(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  params.delete('classificationHandoff');
  const search = params.toString();
  return search ? `${window.location.pathname}?${search}` : window.location.pathname;
}

export function classificationConceptTypeAdmitted(release: Pick<Release, 'types' | 'properties'>, type: string): boolean {
  return typeExtends(release, type, 'skos:Concept') || typeExtends(release, type, 'skos:ConceptScheme');
}
