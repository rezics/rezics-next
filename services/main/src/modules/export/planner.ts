import { createHash } from 'node:crypto';
import { EXPORT_BASIS_KINDS, EXPORT_MAPPINGS, EXPORT_OBLIGATIONS, EXPORT_RESIDUAL_KINDS, EXPORT_SOURCE_GRAINS,
  EXPORT_SOURCE_OWNERS, EXPORT_USE_SCOPES, type ExportMemberRow, type ExportResidualRow,
  type ExportRightsBasisRow } from './schema.ts';

/** Values in this exchange profile carry their source form, not a JavaScript approximation. */
export type PortableValue =
  | { kind: 'absent' | 'null' | 'unknown' | 'no-value' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; lexical: string; language: string | null }
  | { kind: 'integer' | 'decimal'; lexical: string }
  | { kind: 'time'; lexical: string; precision: string; calendar: string;
      timezone: string | null; before: string | null; after: string | null }
  | { kind: 'quantity'; lexical: string; unit: string | null; lower: string | null;
      upper: string | null };

/** Supplied only by an owner reader that has verified this exact revision and disclosure. */
export interface VerifiedExportMember {
  sourceOwner: ExportMemberRow['source_owner'];
  sourceNamespace: string;
  sourceGrain: ExportMemberRow['source_grain'];
  exactRef: string;
  contentRevisionId: string | null;
  refDigest: string;
  ownerDataEpoch: string;
  ownerSequence: string;
  sourcePosition: string | null;
  targetGrain: string | null;
  mapping: ExportMemberRow['mapping'];
  /** The exact owner read's bounded exchange value, if this member is a value. */
  value?: PortableValue;
  /** Bounded owner-verified facts and qualifications for this exact revision. */
  data?: Record<string, unknown>;
}

export interface ExportLoss {
  memberOrdinal: number | null;
  kind: ExportResidualRow['kind'];
  path: string | null;
  detail: Record<string, unknown>;
}

export interface ExportBasis {
  basisKind: ExportRightsBasisRow['basis_kind'];
  basisRef: string | null;
  licenseExpression: string | null;
  notice: string | null;
  obligations: ExportRightsBasisRow['obligations'];
  /** One basis never silently authorizes another use. */
  useScope: typeof EXPORT_USE_SCOPES[number];
  result: 'supported' | 'conditional' | 'undetermined' | 'prohibited';
  memberOrdinals: number[];
}

/** Exact Content rights-material key derived by an owner reader, never from a request. */
export interface ExportRightsMaterialKey {
  scopeKind: 'source_provider' | 'source_record' | 'content_variant' | 'media_asset';
  provider: string | null;
  namespace: string | null;
  sourceRecordId: string | null;
  contentVariantId: string | null;
  mediaAsset: string | null;
  component: string;
}

export interface ExportRightsTarget {
  owner: 'graph' | 'content' | 'source' | 'media';
  resource: string;
  component: string;
  revision: string;
}

export interface ExportRightsIdentity {
  /** Content resolves this reader-verified exact key to its immutable material row. */
  material: ExportRightsMaterialKey;
  target: ExportRightsTarget;
}

export interface ExportPlan {
  profile: 'export-plan-v1';
  targetProfile: string;
  useScope: typeof EXPORT_USE_SCOPES[number];
  completeness: 'complete' | 'partial';
  licenseScope: 'determined' | 'uncertain' | 'blocked';
  licenseExpression: string | null;
  members: Array<VerifiedExportMember & { ordinal: number }>;
  residuals: Array<ExportLoss & { ordinal: number }>;
  bases: Array<ExportBasis & { ordinal: number }>;
  manifestDigest: string;
  work: { members: number; residuals: number; bases: number; basisLinks: number; bytes: number };
}

export class InvalidExportPlan extends Error {}

const SHA256 = /^[0-9a-f]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const TARGET = /^[a-z0-9][a-z0-9.-]{0,62}-v[1-9][0-9]{0,3}$/;
const MEMBER_LIMIT = 256;
const LOSS_LIMIT = 1024;
const BASIS_LIMIT = 256;
const BYTE_LIMIT = 1_048_576;

function validValue(value: PortableValue): boolean {
  switch (value.kind) {
    case 'absent': case 'null': case 'unknown': case 'no-value':
      return Object.keys(value).length === 1;
    case 'boolean': return typeof value.value === 'boolean';
    case 'text': return typeof value.lexical === 'string'
      && (value.language === null || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language));
    case 'integer': return /^-?(0|[1-9][0-9]*)$/.test(value.lexical);
    case 'decimal': return /^-?(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.lexical);
    case 'time': return typeof value.lexical === 'string' && value.lexical.length > 0
      && typeof value.precision === 'string' && value.precision.length > 0
      && typeof value.calendar === 'string' && value.calendar.length > 0
      && [value.timezone, value.before, value.after].every(item => item === null || typeof item === 'string');
    case 'quantity': return typeof value.lexical === 'string' && value.lexical.length > 0
      && [value.unit, value.lower, value.upper].every(item => item === null || typeof item === 'string');
    default: return false;
  }
}

/** Stable canonical bytes; omission and explicit null have different encodings. */
export function canonicalExport(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 16_384 || depth > 16) throw new InvalidExportPlan('export JSON exceeds its shape bound');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || seen.has(item)
      || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) {
      throw new InvalidExportPlan('export contains an unsupported JSON value');
    }
    seen.add(item);
    const result = Array.isArray(item) ? `[${item.map(child => visit(child, depth + 1)).join(',')}]`
      : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit(
        (item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    seen.delete(item);
    return result;
  };
  return visit(value, 0);
}

/** G-051 can implement this hook against its exact use assessments and current restrictions. */
export type LicenseScopeHook = (members: readonly VerifiedExportMember[],
  useScope: ExportPlan['useScope']) => Promise<readonly ExportBasis[]>;

/** Attach the exact rights identity after each member has been read from its owner. */
export async function attachRightsIdentities(members: readonly VerifiedExportMember[],
  identities: readonly ExportRightsIdentity[]): Promise<VerifiedExportMember[]> {
  if (members.length !== identities.length || members.length > MEMBER_LIMIT) {
    throw new InvalidExportPlan('rights identities do not match the exact export members');
  }
  return members.map((member, index) => ({ ...member, data: {
    ...(member.data ?? {}), rightsIdentity: identities[index]!,
  } }));
}

/** Pure post-read planner. It does not certify the owner reads or make a disclosure decision. */
export async function planExport(input: { targetProfile: string; useScope: ExportPlan['useScope'];
  members: readonly VerifiedExportMember[]; residuals: readonly ExportLoss[] },
  rights: LicenseScopeHook): Promise<ExportPlan> {
  if (!TARGET.test(input.targetProfile) || !(EXPORT_USE_SCOPES as readonly string[]).includes(input.useScope)
    || !input.members.length || input.members.length > MEMBER_LIMIT || input.residuals.length > LOSS_LIMIT) {
    throw new InvalidExportPlan('export selection exceeds the admitted profile');
  }
  for (const member of input.members) {
    if (!(EXPORT_SOURCE_OWNERS as readonly string[]).includes(member.sourceOwner)
      || !(EXPORT_SOURCE_GRAINS as readonly string[]).includes(member.sourceGrain)
      || !(EXPORT_MAPPINGS as readonly string[]).includes(member.mapping)
      || !member.sourceNamespace || member.sourceNamespace.length > 300
      || !member.exactRef || member.exactRef.length > 512 || !SHA256.test(member.refDigest)
      || !member.ownerDataEpoch || !INTEGER.test(member.ownerSequence)
      || (member.sourcePosition !== null && (!member.sourcePosition || member.sourcePosition.length > 512))
      || (member.targetGrain !== null && (!member.targetGrain || member.targetGrain.length > 200))
      || (member.mapping === 'unmapped') !== (member.targetGrain === null)
      || (member.sourceOwner === 'content') !== (member.contentRevisionId !== null)
      || (member.contentRevisionId !== null && member.contentRevisionId !== member.exactRef)
      || (member.value !== undefined && !validValue(member.value))) {
      throw new InvalidExportPlan('member is not an exact mapped owner position');
    }
  }
  const residuals = input.residuals.map((loss, index) => {
    if (!(EXPORT_RESIDUAL_KINDS as readonly string[]).includes(loss.kind)
      || (loss.memberOrdinal !== null && (!Number.isInteger(loss.memberOrdinal)
        || loss.memberOrdinal < 1 || loss.memberOrdinal > input.members.length))
      || (loss.path !== null && (!loss.path || loss.path.length > 512))
      || canonicalExport(loss.detail).length > 4096) {
      throw new InvalidExportPlan('residual differs from its bounded member');
    }
    return { ...loss, ordinal: index + 1 };
  });
  const residualByMember = new Set(residuals.map(loss => loss.memberOrdinal));
  const unmapped = new Set(residuals.filter(loss => loss.kind === 'unmapped_grain')
    .map(loss => loss.memberOrdinal));
  input.members.forEach((member, index) => {
    if (member.mapping === 'unmapped' && !unmapped.has(index + 1)) {
      throw new InvalidExportPlan('unmapped grain requires its own residual');
    }
    if (member.mapping !== 'exact' && !residualByMember.has(index + 1)) {
      throw new InvalidExportPlan('non-exact mapping requires its own residual');
    }
  });
  const supplied = await rights(input.members, input.useScope);
  if (supplied.length > BASIS_LIMIT) throw new InvalidExportPlan('rights basis exceeds the admitted profile');
  const bases = supplied.map((basis, index) => {
    if (!(EXPORT_BASIS_KINDS as readonly string[]).includes(basis.basisKind)
      || basis.useScope !== input.useScope || !basis.memberOrdinals.length
      || basis.memberOrdinals.length > MEMBER_LIMIT
      || new Set(basis.memberOrdinals).size !== basis.memberOrdinals.length
      || basis.memberOrdinals.some(ordinal => !Number.isInteger(ordinal)
        || ordinal < 1 || ordinal > input.members.length)
      || (['license_offering', 'use_assessment', 'statutory_exception', 'native_contribution']
        .includes(basis.basisKind) && !basis.basisRef)
      || (basis.basisRef !== null && basis.basisRef.length > 512)
      || (basis.basisKind === 'license_offering' && !basis.licenseExpression)
      || (basis.licenseExpression !== null && (!basis.licenseExpression || basis.licenseExpression.length > 500))
      || (basis.notice !== null && (!basis.notice || basis.notice.length > 4000))
      || basis.obligations.length > 6
      || basis.obligations.some(obligation => !(EXPORT_OBLIGATIONS as readonly string[]).includes(obligation))
      || !['supported', 'conditional', 'undetermined', 'prohibited'].includes(basis.result)) {
      throw new InvalidExportPlan('rights basis does not cover this use and selection');
    }
    return { ...basis, ordinal: index + 1 };
  });
  const covered = new Set(bases.filter(basis => basis.result === 'supported' || basis.result === 'conditional')
    .flatMap(basis => basis.memberOrdinals));
  const blocked = bases.some(basis => basis.result === 'prohibited');
  const expressions = new Set(bases.filter(basis => basis.result === 'supported' || basis.result === 'conditional')
    .map(basis => basis.licenseExpression).filter((item): item is string => item !== null));
  const uncertain = bases.some(basis => basis.result === 'undetermined')
    || input.members.some((_, index) => !covered.has(index + 1)) || expressions.size > 1;
  const licenseScope = blocked ? 'blocked' : uncertain ? 'uncertain' : 'determined';
  const licenseExpression = licenseScope === 'determined' ? [...expressions][0] ?? null : null;
  // The Content schema requires a license expression for determined scope. A
  // public-domain/fact-only export therefore remains explicit uncertainty here.
  const persistedScope: ExportPlan['licenseScope'] =
    licenseScope === 'determined' && !licenseExpression ? 'uncertain' : licenseScope;
  const members = input.members.map((member, index) => ({ ...member, ordinal: index + 1 }));
  const core = { profile: 'export-plan-v1' as const, targetProfile: input.targetProfile,
    useScope: input.useScope, completeness: residuals.length ? 'partial' as const : 'complete' as const,
    licenseScope: persistedScope, licenseExpression, members, residuals, bases };
  const bytes = canonicalExport(core);
  if (Buffer.byteLength(bytes) > BYTE_LIMIT) throw new InvalidExportPlan('export plan exceeds its byte bound');
  return { ...core, manifestDigest: createHash('sha256').update(bytes).digest('hex'),
    work: { members: members.length, residuals: residuals.length, bases: bases.length,
      basisLinks: bases.reduce((sum, basis) => sum + basis.memberOrdinals.length, 0),
      bytes: Buffer.byteLength(bytes) } };
}
