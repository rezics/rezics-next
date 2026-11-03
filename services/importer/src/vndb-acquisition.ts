import { createHash } from 'node:crypto';

/** First explicit VNDB table/spool acquisition cursor. Record staging remains a different engine. */
export const VNDB_ACQUISITION_CHECKPOINT_VERSION = 1;
export const VNDB_ARCHIVE_FORMAT = 'posix-ustar-v1';
export const VNDB_PLAIN_CODEC = 'vndb-archive-plain-v1';
export const VNDB_ZSTD_CODEC = 'vndb-archive-zstd-v1';
export const VNDB_TABLE_PROJECTION = 'vndb-vn-vn_titles-entry_meta-columns-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const ACQUISITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VndbAcquisitionCodec = typeof VNDB_PLAIN_CODEC | typeof VNDB_ZSTD_CODEC;
export type VndbAcquisitionPhase = 'loading' | 'spool-drain' | 'validating';

export type VndbAcquisitionIdentity = Readonly<{
  sha256: string;
  bytes: number;
  archiveFormat: typeof VNDB_ARCHIVE_FORMAT;
  codec: VndbAcquisitionCodec;
  sourceAlias: string;
  sourceKind: 'vndb';
  converterRevision: string;
  projection: typeof VNDB_TABLE_PROJECTION;
  checkpointVersion: number;
  childCap: number;
  maxRows: number;
  maxSourceRecords: number;
  maxArchiveBytes: number;
  maxArchiveEntries: number;
  decodeBudget: number;
}>;

export type VndbAcquisitionCheckpoint = Readonly<{
  version: number;
  identity: VndbAcquisitionIdentity;
  lastCompleteOrdinal: number;
  currentOrdinal: number;
  currentLines: number;
  currentRole: string;
  spoolTable: string;
  spoolAfter: number;
  phase: VndbAcquisitionPhase;
  headers: Readonly<Record<string, readonly string[]>>;
  archiveComplete: boolean;
}>;

export type VndbAcquisitionCompatibility =
  | { readonly ok: true; readonly action: 'load'; readonly checkpoint: VndbAcquisitionCheckpoint }
  | { readonly ok: true; readonly action: 'publish' }
  | { readonly ok: false; readonly code: VndbAcquisitionIncompatibility; readonly message: string };

export type VndbAcquisitionIncompatibility =
  | 'unsupported-format'
  | 'missing'
  | 'version'
  | 'identity'
  | 'converter'
  | 'configuration'
  | 'corrupt'
  | 'ready'
  | 'linked'
  | 'old-staging'
  | 'failed';

export class VndbAcquisitionError extends Error {
  readonly code: VndbAcquisitionIncompatibility | 'interrupted';
  constructor(code: VndbAcquisitionIncompatibility | 'interrupted', message: string) {
    super(message);
    this.name = 'VndbAcquisitionError';
    this.code = code;
  }
}

export const VNDB_ACQUISITION_UNSUPPORTED =
  'Checkpointed VNDB table acquisition admits one regular local archive with plain tar or owned zstd decoding. Stdin, dump-set manifests, gzip and other sources are unsupported.';

export const VNDB_ACQUISITION_INCOMPATIBLE =
  'This VNDB table checkpoint is incompatible with the supplied file or configuration. Use a deliberate fresh acquisition with a separate ID; there is no in-place upgrade, reseal or force flag.';

export const VNDB_ACQUISITION_OLD_UNSUPPORTED =
  'This VNDB table capture has no versioned checkpoint. Incomplete acquisition without a checkpoint cannot be resumed; ordinary import starts a separate ID.';

export const VNDB_ACQUISITION_FAILED =
  'This VNDB table capture already failed. Incomplete invalid input is not shortened into a ready acquisition; start a fresh acquisition with a separate ID.';

export const VNDB_ACQUISITION_MISSING =
  'The named VNDB table acquisition is not the current capture. Resume names an exact existing acquisition ID and never starts a replacement.';

export const VNDB_ACQUISITION_LINKED =
  'This table acquisition is already linked to a source generation. Resume sealed work with the ordinary import command and original requests; do not rematerialize the archive.';

export const VNDB_ACQUISITION_READY =
  'This VNDB table acquisition is already complete. Resume publication with --resume-acquisition and the same ID; do not replace input or restart table loading.';

export const VNDB_ACQUISITION_COST =
  'Resume re-hashes the complete original file and replays the archive from the first member to verify the committed prefix before inserting remaining rows. Path, inode, size, mtime and prefix hashes are not sufficient.';

export const VNDB_ACQUISITION_MISSING_STATE = 'No importer state database exists at the given path.';

export function isVndbAcquisitionId(value: string): boolean {
  return ACQUISITION_ID.test(value);
}

export function vndbCodec(compression: 'none' | 'gzip' | 'zstd'): VndbAcquisitionCodec {
  if (compression === 'zstd') return VNDB_ZSTD_CODEC;
  if (compression === 'none') return VNDB_PLAIN_CODEC;
  throw new VndbAcquisitionError('unsupported-format', VNDB_ACQUISITION_UNSUPPORTED);
}

export function memberPathDigest(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

export function admitVndbAcquisitionIdentity(value: VndbAcquisitionIdentity): VndbAcquisitionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (!SHA256.test(value.sha256)) throw new VndbAcquisitionError('identity', VNDB_ACQUISITION_INCOMPATIBLE);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0)
    throw new VndbAcquisitionError('identity', VNDB_ACQUISITION_INCOMPATIBLE);
  if (value.archiveFormat !== VNDB_ARCHIVE_FORMAT)
    throw new VndbAcquisitionError('unsupported-format', VNDB_ACQUISITION_UNSUPPORTED);
  if (value.codec !== VNDB_PLAIN_CODEC && value.codec !== VNDB_ZSTD_CODEC)
    throw new VndbAcquisitionError('unsupported-format', VNDB_ACQUISITION_UNSUPPORTED);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value.sourceAlias))
    throw new VndbAcquisitionError('configuration', VNDB_ACQUISITION_INCOMPATIBLE);
  if (value.sourceKind !== 'vndb') throw new VndbAcquisitionError('unsupported-format', VNDB_ACQUISITION_UNSUPPORTED);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}$/.test(value.converterRevision))
    throw new VndbAcquisitionError('converter', VNDB_ACQUISITION_INCOMPATIBLE);
  if (value.projection !== VNDB_TABLE_PROJECTION)
    throw new VndbAcquisitionError('converter', VNDB_ACQUISITION_INCOMPATIBLE);
  if (value.checkpointVersion !== VNDB_ACQUISITION_CHECKPOINT_VERSION)
    throw new VndbAcquisitionError('version', VNDB_ACQUISITION_INCOMPATIBLE);
  for (const field of [
    'childCap',
    'maxRows',
    'maxSourceRecords',
    'maxArchiveBytes',
    'maxArchiveEntries',
    'decodeBudget',
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0)
      throw new VndbAcquisitionError('configuration', VNDB_ACQUISITION_INCOMPATIBLE);
  }
  return {
    sha256: value.sha256,
    bytes: value.bytes,
    archiveFormat: value.archiveFormat,
    codec: value.codec,
    sourceAlias: value.sourceAlias,
    sourceKind: 'vndb',
    converterRevision: value.converterRevision,
    projection: value.projection,
    checkpointVersion: value.checkpointVersion,
    childCap: value.childCap,
    maxRows: value.maxRows,
    maxSourceRecords: value.maxSourceRecords,
    maxArchiveBytes: value.maxArchiveBytes,
    maxArchiveEntries: value.maxArchiveEntries,
    decodeBudget: value.decodeBudget,
  };
}

export function captureVndbIdentity(
  input: Omit<VndbAcquisitionIdentity, 'archiveFormat' | 'projection' | 'checkpointVersion' | 'sourceKind'> & {
    sourceKind?: 'vndb';
  },
): VndbAcquisitionIdentity {
  return admitVndbAcquisitionIdentity({
    ...input,
    sourceKind: 'vndb',
    archiveFormat: VNDB_ARCHIVE_FORMAT,
    projection: VNDB_TABLE_PROJECTION,
    checkpointVersion: VNDB_ACQUISITION_CHECKPOINT_VERSION,
  });
}

export function vndbIdentitiesMatch(left: VndbAcquisitionIdentity, right: VndbAcquisitionIdentity): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.archiveFormat === right.archiveFormat &&
    left.codec === right.codec &&
    left.sourceAlias === right.sourceAlias &&
    left.sourceKind === right.sourceKind &&
    left.converterRevision === right.converterRevision &&
    left.projection === right.projection &&
    left.checkpointVersion === right.checkpointVersion &&
    left.childCap === right.childCap &&
    left.maxRows === right.maxRows &&
    left.maxSourceRecords === right.maxSourceRecords &&
    left.maxArchiveBytes === right.maxArchiveBytes &&
    left.maxArchiveEntries === right.maxArchiveEntries &&
    left.decodeBudget === right.decodeBudget
  );
}

export function admitVndbAcquisitionCheckpoint(row: {
  version: number;
  identity: VndbAcquisitionIdentity;
  lastCompleteOrdinal: number;
  currentOrdinal: number;
  currentLines: number;
  currentRole: string;
  spoolTable: string;
  spoolAfter: number;
  phase: string;
  headers: unknown;
  archiveComplete: number | boolean;
}): VndbAcquisitionCheckpoint {
  if (row.version !== VNDB_ACQUISITION_CHECKPOINT_VERSION)
    throw new VndbAcquisitionError('version', VNDB_ACQUISITION_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.lastCompleteOrdinal) || row.lastCompleteOrdinal < 0)
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.currentOrdinal) || row.currentOrdinal < 0)
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.currentLines) || row.currentLines < 0)
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (!Number.isSafeInteger(row.spoolAfter) || row.spoolAfter < 0)
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (row.phase !== 'loading' && row.phase !== 'spool-drain' && row.phase !== 'validating')
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (typeof row.currentRole !== 'string' || row.currentRole.length > 64)
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  if (typeof row.spoolTable !== 'string' || row.spoolTable.length > 32)
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  const headers = admitHeaders(row.headers);
  const identity = admitVndbAcquisitionIdentity(row.identity);
  return {
    version: row.version,
    identity,
    lastCompleteOrdinal: row.lastCompleteOrdinal,
    currentOrdinal: row.currentOrdinal,
    currentLines: row.currentLines,
    currentRole: row.currentRole,
    spoolTable: row.spoolTable,
    spoolAfter: row.spoolAfter,
    phase: row.phase,
    headers,
    archiveComplete: Boolean(row.archiveComplete),
  };
}

function admitHeaders(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
  const headers: Record<string, readonly string[]> = {};
  for (const [table, names] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z_]+$/.test(table) || !Array.isArray(names) || names.length > 32)
      throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
    if (!names.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 64))
      throw new VndbAcquisitionError('corrupt', VNDB_ACQUISITION_INCOMPATIBLE);
    headers[table] = names;
  }
  return headers;
}

export function evaluateVndbResume(
  stored: VndbAcquisitionCheckpoint | null,
  observed: VndbAcquisitionIdentity,
  state: { status: string; materializedGeneration: string | null },
): VndbAcquisitionCompatibility {
  if (state.status === 'ready') {
    if (state.materializedGeneration) return { ok: false, code: 'linked', message: VNDB_ACQUISITION_LINKED };
    return { ok: true, action: 'publish' };
  }
  if (state.status === 'failed') return { ok: false, code: 'failed', message: VNDB_ACQUISITION_FAILED };
  if (state.status !== 'staging' && state.status !== 'new')
    return { ok: false, code: 'old-staging', message: VNDB_ACQUISITION_OLD_UNSUPPORTED };
  if (!stored) return { ok: false, code: 'old-staging', message: VNDB_ACQUISITION_OLD_UNSUPPORTED };
  try {
    const expected = admitVndbAcquisitionIdentity(observed);
    if (stored.identity.converterRevision !== expected.converterRevision)
      return { ok: false, code: 'converter', message: VNDB_ACQUISITION_INCOMPATIBLE };
    if (
      stored.identity.sourceAlias !== expected.sourceAlias ||
      stored.identity.codec !== expected.codec ||
      stored.identity.archiveFormat !== expected.archiveFormat ||
      stored.identity.projection !== expected.projection ||
      stored.identity.checkpointVersion !== expected.checkpointVersion ||
      stored.identity.childCap !== expected.childCap ||
      stored.identity.maxRows !== expected.maxRows ||
      stored.identity.maxSourceRecords !== expected.maxSourceRecords ||
      stored.identity.maxArchiveBytes !== expected.maxArchiveBytes ||
      stored.identity.maxArchiveEntries !== expected.maxArchiveEntries ||
      stored.identity.decodeBudget !== expected.decodeBudget
    )
      return { ok: false, code: 'configuration', message: VNDB_ACQUISITION_INCOMPATIBLE };
    if (stored.identity.sha256 !== expected.sha256 || stored.identity.bytes !== expected.bytes)
      return { ok: false, code: 'identity', message: VNDB_ACQUISITION_INCOMPATIBLE };
    return { ok: true, action: 'load', checkpoint: stored };
  } catch (error) {
    if (error instanceof VndbAcquisitionError)
      return {
        ok: false,
        code: error.code === 'interrupted' ? 'corrupt' : error.code,
        message: error.message,
      };
    return { ok: false, code: 'corrupt', message: VNDB_ACQUISITION_INCOMPATIBLE };
  }
}

export function resumeVndbAcquisitionInvocation(acquisition: string): string {
  return `bun services/importer/src/cli.ts --source vndb --dump <original-file> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin> --resume-acquisition --acquisition ${acquisition}`;
}

export function vndbAcquisitionProgress(acquisition: string, committed: number, complete: boolean): string {
  const archive = complete ? 'archive complete' : 'archive incomplete';
  return `VNDB table acquisition ${acquisition}: committed ${committed} durable rows, ${archive}. ${VNDB_ACQUISITION_COST}`;
}

export function vndbAcquisitionGuidance(input: {
  status: string;
  checkpoint: VndbAcquisitionCheckpoint | null;
  acquisition: string;
  materializedGeneration?: string | null;
}): string {
  if (input.status === 'ready' && input.materializedGeneration)
    return `${VNDB_ACQUISITION_LINKED} Next: bun services/importer/src/cli.ts --source vndb --dump <complete-input-path> --state <same-state-path> --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`;
  if (input.status === 'ready')
    return `${VNDB_ACQUISITION_READY} Next: ${resumeVndbAcquisitionInvocation(input.acquisition)}`;
  if (input.status === 'failed') return `${VNDB_ACQUISITION_FAILED} Ordinary import starts a separate acquisition ID.`;
  if (!input.checkpoint) return `${VNDB_ACQUISITION_OLD_UNSUPPORTED} Ordinary import still starts a separate ID.`;
  return `Compatible VNDB table checkpoint for acquisition ${input.acquisition}: committed through member ${input.checkpoint.lastCompleteOrdinal}, ${input.checkpoint.identity.bytes} hashed bytes. ${VNDB_ACQUISITION_COST} Next: ${resumeVndbAcquisitionInvocation(input.acquisition)}`;
}
