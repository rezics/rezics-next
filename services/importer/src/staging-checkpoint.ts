import { createHash } from 'node:crypto';
import type { SourceId } from '@rezics/conversion';

/** First explicit local staging cursor. Compressed, archive and multi-file producers are out of scope. */
export const STAGING_CHECKPOINT_VERSION = 1;
export const STAGING_DECODER_ID = 'dumps-uncompressed-v1';
export const STAGING_CHECKPOINT_SOURCES = ['openlibrary', 'wikidata'] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const ZERO_DIGEST = '0'.repeat(64);

export type StagingCheckpointSource = (typeof STAGING_CHECKPOINT_SOURCES)[number];

export type StagingCaptureIdentity = Readonly<{
  sha256: string;
  bytes: number;
  sourceAlias: string;
  sourceKind: SourceId;
  converterRevision: string;
  decoderId: string;
  checkpointVersion: number;
  disappearanceThreshold: number;
}>;

export type StagingPrefixRecord = Readonly<{
  ordinal: number;
  recordKey: string;
  digest: string;
}>;

export type StagingCheckpoint = Readonly<{
  version: number;
  identity: StagingCaptureIdentity;
  committedOrdinal: number;
  skipped: number;
  rollingDigest: string;
}>;

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
  'Checkpointed staging is limited to one uncompressed Open Library or Wikidata regular file. VNDB archives, metadata sidecars, multi-file manifests, gzip and stdin are unsupported in this checkpoint format.';

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
  'Resume re-hashes the complete file and re-decodes from the first record to verify the committed prefix before converting remaining records. Path, inode, size, mtime and prefix hashes are not sufficient.';

export function isStagingCheckpointSource(value: string): value is StagingCheckpointSource {
  return value === 'openlibrary' || value === 'wikidata';
}

export function emptyPrefixDigest(): string {
  return ZERO_DIGEST;
}

export function extendPrefixDigest(prior: string, record: StagingPrefixRecord): string {
  if (!SHA256.test(prior) || !SHA256.test(record.digest))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 1)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  return createHash('sha256')
    .update(Buffer.from(prior, 'hex'))
    .update(`${record.ordinal}\0${record.recordKey}\0${record.digest}`)
    .digest('hex');
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
  if (value.decoderId !== STAGING_DECODER_ID) throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  if (value.checkpointVersion !== STAGING_CHECKPOINT_VERSION)
    throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  if (
    typeof value.disappearanceThreshold !== 'number' ||
    !Number.isFinite(value.disappearanceThreshold) ||
    value.disappearanceThreshold < 0 ||
    value.disappearanceThreshold > 1
  )
    throw new StagingCheckpointError('configuration', STAGING_INCOMPATIBLE);
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

export function identitiesMatch(left: StagingCaptureIdentity, right: StagingCaptureIdentity): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.sourceAlias === right.sourceAlias &&
    left.sourceKind === right.sourceKind &&
    left.converterRevision === right.converterRevision &&
    left.decoderId === right.decoderId &&
    left.checkpointVersion === right.checkpointVersion &&
    left.disappearanceThreshold === right.disappearanceThreshold
  );
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
}): StagingCheckpoint {
  if (row.version !== STAGING_CHECKPOINT_VERSION) throw new StagingCheckpointError('version', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.committedOrdinal) || row.committedOrdinal < 0)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.skipped) || row.skipped < 0)
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  if (row.committedOrdinal === 0 ? row.rollingDigest !== ZERO_DIGEST : !SHA256.test(row.rollingDigest))
    throw new StagingCheckpointError('corrupt', STAGING_INCOMPATIBLE);
  const identity = admitStagingIdentity({
    sha256: row.sha256,
    bytes: row.bytes,
    sourceAlias: row.sourceAlias,
    sourceKind: row.sourceKind as SourceId,
    converterRevision: row.converterRevision,
    decoderId: row.decoderId,
    checkpointVersion: row.version,
    disappearanceThreshold: row.disappearanceThreshold,
  });
  return {
    version: row.version,
    identity,
    committedOrdinal: row.committedOrdinal,
    skipped: row.skipped,
    rollingDigest: row.rollingDigest,
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
  if (state.prepared || state.pending || state.covers) return { ok: false, code: 'prepared', message: STAGING_SEALED_RESUME };
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
      stored.identity.disappearanceThreshold !== expected.disappearanceThreshold
    )
      return { ok: false, code: 'configuration', message: STAGING_INCOMPATIBLE };
    if (stored.identity.sha256 !== expected.sha256 || stored.identity.bytes !== expected.bytes)
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

export function resumeStagingInvocation(source: string, generation: string): string {
  return `bun services/importer/src/cli.ts --source ${source} --dump <original-file> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin> --resume-staging --generation ${generation}`;
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
  return `Compatible checkpoint for ${input.source} generation ${input.generation}: committed prefix ${committed} records, ${input.checkpoint.identity.bytes} hashed bytes. ${STAGING_COST} Next: ${resumeStagingInvocation(input.source, input.generation)}`;
}
