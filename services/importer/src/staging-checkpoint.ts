import { createHash } from 'node:crypto';
import type { SourceId, SourceRecord } from '@rezics/conversion';
import { DEFAULT_DECODED_DUMP_BYTES, type DumpCompression } from './compressed-dump.ts';
import type { OpenLibraryDumpFamily } from './dumps.ts';

/** Version 1 is one uncompressed regular file. Version 2 is compressed and/or ordered members. */
export const STAGING_CHECKPOINT_VERSION = 1;
export const STAGING_CHECKPOINT_VERSION_V2 = 2;
export const STAGING_DECODER_ID = 'dumps-uncompressed-v1';
export const STAGING_DECODER_GZIP_ID = 'dumps-gzip-v1';
export const STAGING_DECODER_ZSTD_ID = 'dumps-zstd-v1';
export const STAGING_DECODER_DUMP_SET_ID = 'open-library-dump-set-v1';
export const STAGING_CHECKPOINT_SOURCES = ['bangumi', 'openlibrary', 'wikidata'] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const ZERO_DIGEST = '0'.repeat(64);
const V2_DECODERS = new Set([STAGING_DECODER_GZIP_ID, STAGING_DECODER_ZSTD_ID, STAGING_DECODER_DUMP_SET_ID]);

export type StagingCheckpointSource = (typeof STAGING_CHECKPOINT_SOURCES)[number];
export type StagingInputKind = 'file' | 'dump-set';
export type StagingMemberFamily = OpenLibraryDumpFamily | null;

export type StagingMemberIdentity = Readonly<{
  index: number;
  family: StagingMemberFamily;
  compression: DumpCompression;
  sha256: string;
  bytes: number;
}>;

export type StagingCaptureIdentity = Readonly<{
  sha256: string;
  bytes: number;
  sourceAlias: string;
  sourceKind: SourceId;
  converterRevision: string;
  decoderId: string;
  checkpointVersion: number;
  disappearanceThreshold: number;
  decodeBudget?: number;
  inputKind?: StagingInputKind;
  manifestVersion?: 1 | 2;
  members?: readonly StagingMemberIdentity[];
}>;

export type StagingPrefixRecord = Readonly<{
  ordinal: number;
  recordKey: string;
  digest: string;
  memberIndex?: number;
}>;

export type StagingCheckpoint = Readonly<{
  version: number;
  identity: StagingCaptureIdentity;
  committedOrdinal: number;
  skipped: number;
  rollingDigest: string;
  completedMembers: number;
}>;

export type StagingStreamEvent =
  | { readonly kind: 'record'; readonly memberIndex: number; readonly record: SourceRecord }
  | { readonly kind: 'member-end'; readonly memberIndex: number };

export type StagingCompatibility =
  | { readonly ok: true; readonly checkpoint: StagingCheckpoint }
  | { readonly ok: false; readonly code: StagingIncompatibility; readonly message: string };

export type StagingIncompatibility =
  | 'unsupported-format'
  | 'missing'
  | 'version'
  | 'identity'
  | 'converter'
  | 'configuration'
  | 'corrupt'
  | 'sealed'
  | 'prepared'
  | 'old-staging';

export class StagingCheckpointError extends Error {
  readonly code: StagingIncompatibility;
  constructor(code: StagingIncompatibility, message: string) {
    super(message);
    this.name = 'StagingCheckpointError';
    this.code = code;
  }
}

export const STAGING_UNSUPPORTED_INPUT =
  'Checkpointed staging admits one uncompressed Bangumi regular file, one Open Library or Wikidata regular file (plain, gzip, or Wikidata zstd), or one Open Library dump-set manifest. VNDB archives, metadata sidecars, stdin and other producers are unsupported in this checkpoint format.';

export const STAGING_INCOMPATIBLE =
  'This staging checkpoint is incompatible with the supplied file or configuration. Use a deliberate fresh import; there is no in-place upgrade, reseal or force flag.';

export const STAGING_SEALED_RESUME =
  'This generation is already sealed. Resume with the ordinary import command and the original requests; do not replace input or use --resume-staging.';

export const STAGING_OLD_UNSUPPORTED =
  'This staging generation has no versioned checkpoint. Incomplete acquisition without a checkpoint cannot be resumed; ordinary import discards it and starts again.';

export const STAGING_MISSING_STATE = 'No importer state database exists at the given path.';

export const STAGING_MISSING_GENERATION =
  'The named source/generation is not the current staging capture. Resume names an exact existing generation and never starts a replacement.';

export const STAGING_ACTIVE_GENERATION =
  'This source already has an active generation. Resume a compatible checkpoint with --resume-staging, or use ordinary import for sealed work.';

export const STAGING_COST =
  'Resume re-hashes every original file and replays the production decoder from the start of each member to verify the committed prefix before converting remaining records. Path, inode, size, mtime and prefix hashes are not sufficient. Replayed verification is not newly converted work. Local conversion is not publication; native application starts after a valid seal.';

export function isStagingCheckpointSource(value: string): value is StagingCheckpointSource {
  return (STAGING_CHECKPOINT_SOURCES as readonly string[]).includes(value);
}

export function emptyPrefixDigest(): string {
  return ZERO_DIGEST;
}

export function extendPrefixDigest(prior: string, record: StagingPrefixRecord, version = STAGING_CHECKPOINT_VERSION): string {
  if (!SHA256.test(prior) || !SHA256.test(record.digest))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 1)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const memberIndex = record.memberIndex ?? 0;
  if (!Number.isSafeInteger(memberIndex) || memberIndex < 0)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const payload =
    version === STAGING_CHECKPOINT_VERSION_V2
      ? `${record.ordinal}\0${memberIndex}\0${record.recordKey}\0${record.digest}`
      : `${record.ordinal}\0${record.recordKey}\0${record.digest}`;
  return createHash('sha256').update(Buffer.from(prior, 'hex')).update(payload).digest('hex');
}

function admitMember(value: StagingMemberIdentity, index: number): StagingMemberIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (value.index !== index || !Number.isSafeInteger(value.index) || value.index < 0)
    throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  if (value.family !== null && value.family !== 'author' && value.family !== 'work' && value.family !== 'edition')
    throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  if (value.compression !== 'none' && value.compression !== 'gzip' && value.compression !== 'zstd')
    throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  if (value.compression === 'zstd' && value.family !== null)
    throw new StagingCheckpointError('unsupported-format', STAGING_UNSUPPORTED_INPUT);
  if (!SHA256.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
    throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  return {
    index: value.index,
    family: value.family,
    compression: value.compression,
    sha256: value.sha256,
    bytes: value.bytes,
  };
}

function admitV2Extras(value: StagingCaptureIdentity): Pick<
  StagingCaptureIdentity,
  'decodeBudget' | 'inputKind' | 'manifestVersion' | 'members'
> {
  if (!V2_DECODERS.has(value.decoderId)) throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  const budget = value.decodeBudget ?? DEFAULT_DECODED_DUMP_BYTES;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
  const inputKind = value.inputKind ?? (value.decoderId === STAGING_DECODER_DUMP_SET_ID ? 'dump-set' : 'file');
  if (inputKind !== 'file' && inputKind !== 'dump-set')
    throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
  if (inputKind === 'dump-set') {
    if (value.decoderId !== STAGING_DECODER_DUMP_SET_ID || value.sourceKind !== 'openlibrary')
      throw new StagingCheckpointError('unsupported-format', STAGING_UNSUPPORTED_INPUT);
    if (value.manifestVersion !== 1 && value.manifestVersion !== 2)
      throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
  } else if (value.manifestVersion !== undefined)
    throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
  if (value.decoderId === STAGING_DECODER_ZSTD_ID && value.sourceKind !== 'wikidata')
    throw new StagingCheckpointError('unsupported-format', STAGING_UNSUPPORTED_INPUT);
  if (value.decoderId === STAGING_DECODER_GZIP_ID && value.sourceKind !== 'openlibrary' && value.sourceKind !== 'wikidata')
    throw new StagingCheckpointError('unsupported-format', STAGING_UNSUPPORTED_INPUT);
  if (!Array.isArray(value.members) || value.members.length === 0 || value.members.length > 64)
    throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  const members = value.members.map((member, index) => admitMember(member, index));
  if (inputKind === 'file') {
    if (members.length !== 1 || members[0]!.family !== null)
      throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
    if (value.decoderId === STAGING_DECODER_GZIP_ID && members[0]!.compression !== 'gzip')
      throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
    if (value.decoderId === STAGING_DECODER_ZSTD_ID && members[0]!.compression !== 'zstd')
      throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  } else {
    for (const member of members) {
      if (member.family === null || (member.compression !== 'none' && member.compression !== 'gzip'))
        throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
    }
  }
  const bytes = members.reduce((sum, member) => sum + member.bytes, 0);
  if (bytes !== value.bytes) throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  return {
    decodeBudget: budget,
    inputKind,
    ...(inputKind === 'dump-set' ? { manifestVersion: value.manifestVersion } : {}),
    members,
  };
}

export function admitStagingIdentity(value: StagingCaptureIdentity): StagingCaptureIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (!SHA256.test(value.sha256)) throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0)
    throw new StagingCheckpointError('identity', STAGING_INCOMPATIBLE);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value.sourceAlias))
    throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
  if (!isStagingCheckpointSource(value.sourceKind))
    throw new StagingCheckpointError('unsupported-format', STAGING_UNSUPPORTED_INPUT);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}$/.test(value.converterRevision))
    throw new StagingCheckpointError('converter', STAGING_INCOMPATIBLE);
  if (
    typeof value.disappearanceThreshold !== 'number' ||
    !Number.isFinite(value.disappearanceThreshold) ||
    value.disappearanceThreshold < 0 ||
    value.disappearanceThreshold > 1
  )
    throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
  if (value.checkpointVersion === STAGING_CHECKPOINT_VERSION) {
    if (value.decoderId !== STAGING_DECODER_ID) throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
    if (
      value.decodeBudget !== undefined ||
      value.inputKind !== undefined ||
      value.manifestVersion !== undefined ||
      value.members !== undefined
    )
      throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
    return {
      sha256: value.sha256,
      bytes: value.bytes,
      sourceAlias: value.sourceAlias,
      sourceKind: value.sourceKind,
      converterRevision: value.converterRevision,
      decoderId: value.decoderId,
      checkpointVersion: value.checkpointVersion,
      disappearanceThreshold: value.disappearanceThreshold,
    };
  }
  if (value.checkpointVersion !== STAGING_CHECKPOINT_VERSION_V2)
    throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  const extras = admitV2Extras(value);
  return {
    sha256: value.sha256,
    bytes: value.bytes,
    sourceAlias: value.sourceAlias,
    sourceKind: value.sourceKind,
    converterRevision: value.converterRevision,
    decoderId: value.decoderId,
    checkpointVersion: value.checkpointVersion,
    disappearanceThreshold: value.disappearanceThreshold,
    ...extras,
  };
}

export function captureIdentity(input: {
  sha256: string;
  bytes: number;
  sourceAlias: string;
  sourceKind: SourceId;
  converterRevision: string;
  disappearanceThreshold: number;
}): StagingCaptureIdentity {
  return admitStagingIdentity({
    ...input,
    decoderId: STAGING_DECODER_ID,
    checkpointVersion: STAGING_CHECKPOINT_VERSION,
  });
}

export function captureFileIdentity(input: {
  sha256: string;
  bytes: number;
  sourceAlias: string;
  sourceKind: SourceId;
  converterRevision: string;
  disappearanceThreshold: number;
  compression: 'gzip' | 'zstd';
  decodeBudget?: number;
}): StagingCaptureIdentity {
  return admitStagingIdentity({
    sha256: input.sha256,
    bytes: input.bytes,
    sourceAlias: input.sourceAlias,
    sourceKind: input.sourceKind,
    converterRevision: input.converterRevision,
    decoderId: input.compression === 'zstd' ? STAGING_DECODER_ZSTD_ID : STAGING_DECODER_GZIP_ID,
    checkpointVersion: STAGING_CHECKPOINT_VERSION_V2,
    disappearanceThreshold: input.disappearanceThreshold,
    decodeBudget: input.decodeBudget ?? DEFAULT_DECODED_DUMP_BYTES,
    inputKind: 'file',
    members: [
      {
        index: 0,
        family: null,
        compression: input.compression,
        sha256: input.sha256,
        bytes: input.bytes,
      },
    ],
  });
}

export function dumpSetIdentityDigest(members: readonly StagingMemberIdentity[]): { sha256: string; bytes: number } {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const member of members) {
    hash.update(`${member.index}\0${member.family ?? ''}\0${member.compression}\0${member.sha256}\0${member.bytes}\n`);
    bytes += member.bytes;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export function captureDumpSetIdentity(input: {
  members: readonly StagingMemberIdentity[];
  sourceAlias: string;
  converterRevision: string;
  disappearanceThreshold: number;
  decodeBudget?: number;
  manifestVersion: 1 | 2;
}): StagingCaptureIdentity {
  const admitted = input.members.map((member, index) => admitMember(member, index));
  const digest = dumpSetIdentityDigest(admitted);
  return admitStagingIdentity({
    sha256: digest.sha256,
    bytes: digest.bytes,
    sourceAlias: input.sourceAlias,
    sourceKind: 'openlibrary',
    converterRevision: input.converterRevision,
    decoderId: STAGING_DECODER_DUMP_SET_ID,
    checkpointVersion: STAGING_CHECKPOINT_VERSION_V2,
    disappearanceThreshold: input.disappearanceThreshold,
    decodeBudget: input.decodeBudget ?? DEFAULT_DECODED_DUMP_BYTES,
    inputKind: 'dump-set',
    manifestVersion: input.manifestVersion,
    members: admitted,
  });
}

function membersMatch(
  left: readonly StagingMemberIdentity[] | undefined,
  right: readonly StagingMemberIdentity[] | undefined,
): boolean {
  if (left === undefined && right === undefined) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (member, index) =>
      member.index === right[index]!.index &&
      member.family === right[index]!.family &&
      member.compression === right[index]!.compression &&
      member.sha256 === right[index]!.sha256 &&
      member.bytes === right[index]!.bytes,
  );
}

export function identitiesMatch(left: StagingCaptureIdentity, right: StagingCaptureIdentity): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.sourceAlias === right.sourceAlias &&
    left.sourceKind === right.sourceKind &&
    left.converterRevision === right.converterRevision &&
    left.decoderId === right.decoderId &&
    left.checkpointVersion === right.checkpointVersion &&
    left.disappearanceThreshold === right.disappearanceThreshold &&
    left.decodeBudget === right.decodeBudget &&
    left.inputKind === right.inputKind &&
    left.manifestVersion === right.manifestVersion &&
    membersMatch(left.members, right.members)
  );
}

export function encodeStagingIdentityJson(identity: StagingCaptureIdentity): string | null {
  if (identity.checkpointVersion !== STAGING_CHECKPOINT_VERSION_V2) return null;
  return JSON.stringify({
    decodeBudget: identity.decodeBudget,
    inputKind: identity.inputKind,
    ...(identity.manifestVersion === undefined ? {} : { manifestVersion: identity.manifestVersion }),
    members: identity.members,
  });
}

export function parseStagingIdentityJson(raw: string | null | undefined): Pick<
  StagingCaptureIdentity,
  'decodeBudget' | 'inputKind' | 'manifestVersion' | 'members'
> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 65536)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const keys = Object.keys(parsed);
  if (keys.some((key) => !['decodeBudget', 'inputKind', 'manifestVersion', 'members'].includes(key)))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const value = parsed as {
    decodeBudget?: number;
    inputKind?: StagingInputKind;
    manifestVersion?: 1 | 2;
    members?: StagingMemberIdentity[];
  };
  return {
    ...(value.decodeBudget === undefined ? {} : { decodeBudget: value.decodeBudget }),
    ...(value.inputKind === undefined ? {} : { inputKind: value.inputKind }),
    ...(value.manifestVersion === undefined ? {} : { manifestVersion: value.manifestVersion }),
    ...(value.members === undefined ? {} : { members: value.members }),
  };
}

export function admitStagingCheckpoint(row: {
  version: number;
  sha256: string;
  bytes: number;
  sourceAlias: string;
  sourceKind: string;
  converterRevision: string;
  decoderId: string;
  disappearanceThreshold: number;
  committedOrdinal: number;
  skipped: number;
  rollingDigest: string;
  completedMembers?: number;
  identityJson?: string | null;
}): StagingCheckpoint {
  if (row.version !== STAGING_CHECKPOINT_VERSION && row.version !== STAGING_CHECKPOINT_VERSION_V2)
    throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.committedOrdinal) || row.committedOrdinal < 0)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.skipped) || row.skipped < 0)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const completedMembers = row.completedMembers ?? 0;
  if (!Number.isSafeInteger(completedMembers) || completedMembers < 0)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (row.committedOrdinal === 0 ? row.rollingDigest !== ZERO_DIGEST : !SHA256.test(row.rollingDigest))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const extras =
    row.version === STAGING_CHECKPOINT_VERSION_V2 ? parseStagingIdentityJson(row.identityJson) : {};
  if (row.version === STAGING_CHECKPOINT_VERSION && row.identityJson)
    throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  const identity = admitStagingIdentity({
    sha256: row.sha256,
    bytes: row.bytes,
    sourceAlias: row.sourceAlias,
    sourceKind: row.sourceKind as SourceId,
    converterRevision: row.converterRevision,
    decoderId: row.decoderId,
    checkpointVersion: row.version,
    disappearanceThreshold: row.disappearanceThreshold,
    ...extras,
  });
  if (identity.members && completedMembers > identity.members.length)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  return {
    version: row.version,
    identity,
    committedOrdinal: row.committedOrdinal,
    skipped: row.skipped,
    rollingDigest: row.rollingDigest,
    completedMembers,
  };
}

export function evaluateResume(
  stored: StagingCheckpoint | null,
  observed: StagingCaptureIdentity,
  state: { status: string; prepared: number; pending: boolean; covers: boolean },
): StagingCompatibility {
  if (state.status === 'ready' || state.status === 'finalizing')
    return { ok: false, code: 'sealed', message: STAGING_SEALED_RESUME };
  if (state.status !== 'staging') return { ok: false, code: 'old-staging', message: STAGING_OLD_UNSUPPORTED };
  if (state.prepared || state.pending || state.covers)
    return { ok: false, code: 'prepared', message: STAGING_SEALED_RESUME };
  if (!stored) return { ok: false, code: 'missing', message: STAGING_OLD_UNSUPPORTED };
  try {
    const expected = admitStagingIdentity(observed);
    if (stored.identity.converterRevision !== expected.converterRevision)
      return { ok: false, code: 'converter', message: STAGING_INCOMPATIBLE };
    if (
      stored.identity.sourceAlias !== expected.sourceAlias ||
      stored.identity.sourceKind !== expected.sourceKind ||
      stored.identity.decoderId !== expected.decoderId ||
      stored.identity.checkpointVersion !== expected.checkpointVersion ||
      stored.identity.disappearanceThreshold !== expected.disappearanceThreshold ||
      stored.identity.decodeBudget !== expected.decodeBudget ||
      stored.identity.inputKind !== expected.inputKind ||
      stored.identity.manifestVersion !== expected.manifestVersion
    )
      return { ok: false, code: 'configuration', message: STAGING_INCOMPATIBLE };
    if (
      stored.identity.sha256 !== expected.sha256 ||
      stored.identity.bytes !== expected.bytes ||
      !membersMatch(stored.identity.members, expected.members)
    )
      return { ok: false, code: 'identity', message: STAGING_INCOMPATIBLE };
    return { ok: true, checkpoint: stored };
  } catch (error) {
    if (error instanceof StagingCheckpointError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'corrupt', message: STAGING_INCOMPATIBLE };
  }
}

export function checkpointProgress(source: string, generation: string, committed: number, observed: number): string {
  return `Source ${source} generation ${generation}: verified committed prefix ${committed} of ${observed} decoded records. ${STAGING_COST}`;
}

export function resumeStagingInvocation(
  source: string,
  generation: string,
  identity?: StagingCaptureIdentity,
): string {
  const credentials =
    '--state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>';
  if (identity?.inputKind === 'dump-set')
    return `bun services/importer/src/cli.ts --source ${source} --dump-set <original-manifest> ${credentials} --resume-staging --generation ${generation}`;
  const compression =
    identity?.decoderId === STAGING_DECODER_GZIP_ID
      ? ' --compression gzip'
      : identity?.decoderId === STAGING_DECODER_ZSTD_ID
        ? ' --compression zstd'
        : '';
  return `bun services/importer/src/cli.ts --source ${source} --dump <original-file>${compression} ${credentials} --resume-staging --generation ${generation}`;
}

export function sealedResumeInvocation(source: string): string {
  return `bun services/importer/src/cli.ts --source ${source} --dump <complete-input-path> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`;
}

export function stagingResumeGuidance(input: {
  status: string;
  checkpoint: StagingCheckpoint | null;
  source: string;
  generation: string;
  committed?: number;
}): string {
  if (input.status === 'ready' || input.status === 'finalizing')
    return `${STAGING_SEALED_RESUME} Next: ${sealedResumeInvocation(input.source)}`;
  if (input.status !== 'staging')
    return 'The existing importer requires a complete validated input before it can resume; incomplete acquisition is discarded by its ordinary workflow.';
  if (!input.checkpoint)
    return `${STAGING_OLD_UNSUPPORTED} Ordinary import still discards this uncheckpointed staging run.`;
  const committed = input.committed ?? input.checkpoint.committedOrdinal;
  const members = input.checkpoint.identity.members?.length;
  const memberText =
    members && members > 1
      ? `, ${input.checkpoint.completedMembers} of ${members} members complete`
      : '';
  return `Compatible checkpoint for ${input.source} generation ${input.generation}: committed prefix ${committed} records${memberText}, ${input.checkpoint.identity.bytes} hashed bytes. ${STAGING_COST} Next: ${resumeStagingInvocation(input.source, input.generation, input.checkpoint.identity)}`;
}

export function isStagingStreamEvent(value: unknown): value is StagingStreamEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    'kind' in value &&
    ((value as StagingStreamEvent).kind === 'record' || (value as StagingStreamEvent).kind === 'member-end')
  );
}

export function decoderIdForCompression(compression: DumpCompression): string {
  if (compression === 'gzip') return STAGING_DECODER_GZIP_ID;
  if (compression === 'zstd') return STAGING_DECODER_ZSTD_ID;
  return STAGING_DECODER_ID;
}
