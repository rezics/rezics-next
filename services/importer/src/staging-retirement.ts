import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { ImportSession, importOwnerAvailability, type ImportOwnership } from './import-session.ts';
import { RetentionFailure } from './retention-errors.ts';
import {
  RETENTION_DELETE_PAGE,
  RETENTION_MAX_PAGE,
  RETENTION_MAX_PLAN_BYTES,
  RETENTION_PLAN_VERSION,
  RETENTION_PRESERVED,
  RETENTION_SCHEMA,
  RETENTION_SQLITE_NOTE,
  admitRetentionGenerationId,
  admitRetentionPlanId,
  admitRetentionSource,
  assertRetentionKnownSchema,
  ensureRetentionWork,
  exactRetentionObject,
  openRetentionReadonly,
  openRetentionWritable,
  retentionCatalog,
  retentionCountRows,
  retentionExistsFlag,
  retentionInteger,
  retentionOptionalCount,
  retentionOwnershipRow,
  retentionSnapshotAdvice,
  retentionSourcePins,
  retentionUserVersion,
  retentionWorkRow,
  runRetentionDeletePhase,
  throwIfRetentionAborted,
  type RetentionCatalog,
  type RetentionDeletePhase,
  type RetentionOptions,
} from './retention.ts';
import { StagingCheckpointError, admitStagingCheckpoint } from './staging-checkpoint.ts';

export const STAGING_RETIREMENT_PLAN_KIND = 'rezics-importer-staging-retirement';
export const STAGING_RETIREMENT_SCHEMA = 'importer-staging-retirement-v1';
export const STAGING_RETIREMENT_DELETE_PHASES = [
  'diagnostics',
  'diagnostic_records',
  'staging_prefix',
  'staging_checkpoints',
  'vndb_spool',
  'vndb_rows',
  'vndb_runs',
  'entries',
  'tombstone',
] as const satisfies readonly RetentionDeletePhase[];
export type StagingRetirementDeletePhase = (typeof STAGING_RETIREMENT_DELETE_PHASES)[number];

export type StagingRetirementEligibilityReason =
  | 'unpublished-staging'
  | 'missing'
  | 'status-ineligible'
  | 'prepared-or-effect'
  | 'sealed-evidence'
  | 'corrupt-checkpoint'
  | 'retirement-in-progress'
  | 'deliberately-retired'
  | 'vndb-pre-native'
  | 'unknown-status';

export type StagingRetirementOwnerAvailability = 'absent' | 'live' | 'stale' | 'uninspectable' | 'unavailable';

export type StagingRetirementCheckpointState = 'absent' | 'present' | 'corrupt' | 'unavailable';

export type StagingRetirementCounts = Readonly<{
  entries: number;
  diagnostics: number;
  diagnosticRecords: number;
  stagingCheckpoints: number;
  stagingPrefix: number;
}>;

export type StagingRetirementReview = Readonly<{
  version: 1;
  operation: 'review';
  source: string;
  generation: string;
  status: string;
  seq: number | null;
  pin: 'active' | 'baseline' | 'none';
  eligible: boolean;
  reason: StagingRetirementEligibilityReason;
  explanation: string;
  ownerAvailability: StagingRetirementOwnerAvailability;
  baseline: string | null;
  active: string | null;
  presentCount: number | null;
  sequence: number | null;
  prepared: number | null;
  checkpoint: null | Readonly<{
    state: StagingRetirementCheckpointState;
    committedOrdinal?: number;
    bytes?: number;
    sha256?: string;
  }>;
  captureRevision: string | null;
  counts: StagingRetirementCounts;
  resumeConsequence: string;
  preserved: readonly string[];
  unavailable: readonly string[];
  sqliteNote: string;
  snapshot: string;
}>;

export type StagingRetirementPlanDocument = Readonly<{
  version: 1;
  kind: typeof STAGING_RETIREMENT_PLAN_KIND;
  planId: string;
  createdAt: string;
  state: Readonly<{ path: string; dev: number; ino: number; userVersion: number }>;
  source: string;
  generation: string;
  schema: Readonly<{
    compatibility: typeof RETENTION_SCHEMA;
    retirement: typeof STAGING_RETIREMENT_SCHEMA;
    tables: readonly string[];
  }>;
  pins: Readonly<{
    baseline: string | null;
    active: string | null;
    presentCount: number;
    sequence: number;
    ownershipRow: 'present' | 'absent' | 'unavailable';
    ownerPid: number | null;
    ownerBirth: string | null;
  }>;
  captureRevision: string;
  review: StagingRetirementReview;
  applyable: boolean;
  preserved: readonly string[];
  unavailable: readonly string[];
  sqliteNote: string;
  snapshot: string;
  apply: string;
}>;

export type StagingRetirementApplyDocument = Readonly<{
  version: 1;
  operation: 'apply';
  status: 'complete' | 'cancelled';
  planId: string;
  source: string;
  generation: string;
  retired: readonly string[];
  inProgress: readonly string[];
  sqliteNote: string;
  snapshot: string;
}>;

export type StagingRetirementOptions = RetentionOptions;

const UNAVAILABLE = [
  'selected-generation unsealed run_entries',
  'selected-generation run_staging_checkpoints and run_staging_prefix',
  'selected-generation conversion diagnostics when present',
  'selected-generation VNDB materialization leftovers when those tables exist for this native generation',
] as const;

type GenerationFacts = Readonly<{
  id: string;
  seq: number;
  status: string;
  supplied: number;
  prepared: number;
  classified: number;
  resolved: number;
  changed: number;
  expected: number;
  cursor: string;
  invalid: number;
}>;

function emptyCounts(): StagingRetirementCounts {
  return { entries: 0, diagnostics: 0, diagnosticRecords: 0, stagingCheckpoints: 0, stagingPrefix: 0 };
}

function countsFor(
  database: Database,
  source: string,
  id: string,
  tables: ReadonlySet<string>,
): StagingRetirementCounts {
  return {
    entries: retentionCountRows(
      database,
      'SELECT COUNT(*) AS n FROM run_entries WHERE source=? AND run_id=?',
      source,
      id,
    ),
    diagnostics: retentionOptionalCount(database, 'run_conversion_diagnostics', source, id, tables),
    diagnosticRecords: retentionOptionalCount(database, 'run_conversion_diagnostic_records', source, id, tables),
    stagingCheckpoints: retentionOptionalCount(database, 'run_staging_checkpoints', source, id, tables),
    stagingPrefix: retentionOptionalCount(database, 'run_staging_prefix', source, id, tables),
  };
}

function ownerAvailability(
  database: Database,
  source: string,
  tables: ReadonlySet<string>,
): StagingRetirementOwnerAvailability {
  const row = retentionOwnershipRow(database, source, tables);
  if (row === 'unavailable') return 'unavailable';
  if (row === 'absent') return 'absent';
  const owner = database.query('SELECT pid,birth FROM import_owners WHERE source=?').get(source) as {
    pid: number;
    birth: string;
  } | null;
  if (!owner) return 'absent';
  return importOwnerAvailability(owner);
}

function ownerIdentity(
  database: Database,
  source: string,
  tables: ReadonlySet<string>,
): { pid: number | null; birth: string | null } {
  if (retentionOwnershipRow(database, source, tables) !== 'present') return { pid: null, birth: null };
  const owner = database.query('SELECT pid,birth FROM import_owners WHERE source=?').get(source) as {
    pid: number;
    birth: string;
  } | null;
  return owner ? { pid: owner.pid, birth: owner.birth } : { pid: null, birth: null };
}

function readGeneration(database: Database, source: string, id: string): GenerationFacts | null {
  const row = database
    .query(
      `SELECT id,seq,status,supplied,prepared,classified,resolved,changed,expected,cursor,invalid
       FROM run_generations WHERE source=? AND id=?`,
    )
    .get(source, id) as {
    id: unknown;
    seq: unknown;
    status: unknown;
    supplied: unknown;
    prepared: unknown;
    classified: unknown;
    resolved: unknown;
    changed: unknown;
    expected: unknown;
    cursor: unknown;
    invalid: unknown;
  } | null;
  if (!row) return null;
  return {
    id: String(row.id),
    seq: retentionInteger(row.seq, 'run_generations.seq', 1),
    status: String(row.status),
    supplied: retentionInteger(row.supplied, 'run_generations.supplied'),
    prepared: retentionInteger(row.prepared, 'run_generations.prepared'),
    classified: retentionInteger(row.classified, 'run_generations.classified'),
    resolved: retentionInteger(row.resolved, 'run_generations.resolved'),
    changed: retentionInteger(row.changed, 'run_generations.changed'),
    expected: retentionInteger(row.expected, 'run_generations.expected'),
    cursor: String(row.cursor ?? ''),
    invalid: retentionInteger(row.invalid, 'run_generations.invalid'),
  };
}

function effectPin(
  database: Database,
  source: string,
  id: string,
  tables: ReadonlySet<string>,
  generation: GenerationFacts,
): string | null {
  if (generation.prepared || generation.classified || generation.resolved || generation.changed)
    return 'prepared-or-effect';
  if (generation.expected !== 0 || generation.cursor !== '') return 'sealed-evidence';
  const probes: [string, string, ReadonlySet<string> | null][] = [
    ['run_envelopes', 'SELECT EXISTS(SELECT 1 FROM run_envelopes WHERE source=? AND run_id=? LIMIT 1) AS n', null],
    ['run_commands', 'SELECT EXISTS(SELECT 1 FROM run_commands WHERE source=? AND run_id=? LIMIT 1) AS n', null],
    [
      'run_aggregate_operations',
      'SELECT EXISTS(SELECT 1 FROM run_aggregate_operations WHERE source=? AND run_id=? LIMIT 1) AS n',
      tables,
    ],
    [
      'run_disappearance_stops',
      'SELECT EXISTS(SELECT 1 FROM run_disappearance_stops WHERE source=? AND run_id=? LIMIT 1) AS n',
      tables,
    ],
    [
      'run_disappearance_missing',
      'SELECT EXISTS(SELECT 1 FROM run_disappearance_missing WHERE source=? AND run_id=? LIMIT 1) AS n',
      tables,
    ],
  ];
  for (const [table, sql, present] of probes) {
    if (present && !present.has(table)) continue;
    if (retentionExistsFlag(database, sql, source, id))
      return table === 'run_disappearance_stops' || table === 'run_disappearance_missing'
        ? 'sealed-evidence'
        : 'prepared-or-effect';
  }
  if (
    retentionExistsFlag(
      database,
      `SELECT EXISTS(SELECT 1 FROM run_entries WHERE source=? AND run_id=?
        AND (remaining>0 OR pending=1 OR cover_pending=1 OR bytes IS NOT NULL OR kind IS NOT NULL) LIMIT 1) AS n`,
      source,
      id,
    )
  )
    return 'prepared-or-effect';
  return null;
}

function readCheckpoint(
  database: Database,
  source: string,
  id: string,
  tables: ReadonlySet<string>,
): StagingRetirementReview['checkpoint'] {
  if (!tables.has('run_staging_checkpoints')) return { state: 'unavailable' };
  const row = database
    .query(
      `SELECT version,sha256,bytes,source_alias,source_kind,converter_revision,decoder_id,
        disappearance_threshold,committed_ordinal,skipped,rolling_digest
       FROM run_staging_checkpoints WHERE source=? AND run_id=?`,
    )
    .get(source, id) as {
    version: number;
    sha256: string;
    bytes: number;
    source_alias: string;
    source_kind: string;
    converter_revision: string;
    decoder_id: string;
    disappearance_threshold: number;
    committed_ordinal: number;
    skipped: number;
    rolling_digest: string;
  } | null;
  if (!row) return { state: 'absent' };
  try {
    const checkpoint = admitStagingCheckpoint({
      version: row.version,
      sha256: row.sha256,
      bytes: row.bytes,
      sourceAlias: row.source_alias,
      sourceKind: row.source_kind,
      converterRevision: row.converter_revision,
      decoderId: row.decoder_id,
      disappearanceThreshold: row.disappearance_threshold,
      committedOrdinal: row.committed_ordinal,
      skipped: row.skipped,
      rollingDigest: row.rolling_digest,
    });
    return {
      state: 'present',
      committedOrdinal: checkpoint.committedOrdinal,
      bytes: checkpoint.identity.bytes,
      sha256: checkpoint.identity.sha256,
    };
  } catch (error) {
    if (error instanceof StagingCheckpointError) return { state: 'corrupt' };
    throw error;
  }
}

function captureRevision(input: {
  generation: GenerationFacts;
  checkpoint: StagingRetirementReview['checkpoint'];
  counts: StagingRetirementCounts;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        seq: input.generation.seq,
        status: input.generation.status,
        supplied: input.generation.supplied,
        prepared: input.generation.prepared,
        classified: input.generation.classified,
        resolved: input.generation.resolved,
        changed: input.generation.changed,
        expected: input.generation.expected,
        cursor: input.generation.cursor,
        checkpoint: input.checkpoint,
        counts: input.counts,
      }),
    )
    .digest('hex');
}

function statusExplanation(status: string): { reason: StagingRetirementEligibilityReason; explanation: string } {
  if (status === 'ready')
    return {
      reason: 'status-ineligible',
      explanation:
        'This generation is sealed ready work. Staging retirement never cancels prepared or sealed native recovery.',
    };
  if (status === 'finalizing')
    return {
      reason: 'status-ineligible',
      explanation: 'This generation is finalizing. Staging retirement does not cancel in-flight native application.',
    };
  if (status === 'complete')
    return {
      reason: 'status-ineligible',
      explanation: 'Completed baseline and superseded complete captures stay on the existing retention command.',
    };
  if (status === 'abandoned' || status === 'invalid-input' || status === 'mass-disappearance')
    return {
      reason: 'status-ineligible',
      explanation: `Generations with status ${status} remain retained; this journey owns only unpublished staging.`,
    };
  return {
    reason: 'unknown-status',
    explanation: 'The stored status is not unpublished staging; it is not inferred into eligibility.',
  };
}

function classifyOnDatabase(
  database: Database,
  input: { source: string; generation: string; statePath: string },
  catalog: RetentionCatalog,
): StagingRetirementReview {
  const pins = retentionSourcePins(database, input.source);
  const owner = ownerAvailability(database, input.source, catalog.tables);
  const generation = readGeneration(database, input.source, input.generation);
  const base = {
    version: 1 as const,
    operation: 'review' as const,
    source: input.source,
    generation: input.generation,
    pin: 'none' as const,
    ownerAvailability: owner,
    baseline: pins.baseline,
    active: pins.active,
    presentCount: pins.presentCount,
    sequence: pins.sequence,
    preserved: [...RETENTION_PRESERVED, 'VNDB table/spool rows that have not become this native staging generation'],
    unavailable: [...UNAVAILABLE],
    sqliteNote: RETENTION_SQLITE_NOTE,
    snapshot: retentionSnapshotAdvice(input.statePath),
  };
  if (pins.sourceState === 'absent' && !generation) {
    return {
      ...base,
      status: 'missing',
      seq: null,
      eligible: false,
      reason: 'missing',
      explanation: 'No source state exists for this configured identifier.',
      prepared: null,
      checkpoint: null,
      captureRevision: null,
      counts: emptyCounts(),
      resumeConsequence: 'There is no capture to resume or retire.',
    };
  }
  if (!generation) {
    const vndb =
      catalog.tables.has('vndb_table_runs') &&
      retentionExistsFlag(
        database,
        'SELECT EXISTS(SELECT 1 FROM vndb_table_runs WHERE source=? AND run_id=? LIMIT 1) AS n',
        input.source,
        input.generation,
      );
    return {
      ...base,
      status: 'missing',
      seq: null,
      eligible: false,
      reason: vndb ? 'vndb-pre-native' : 'missing',
      explanation: vndb
        ? 'This identifier is a VNDB table acquisition that has not become native staging. It stays unsupported here and its tables are not deleted.'
        : 'No native generation with this exact ID exists. VNDB table acquisitions that have not become native staging stay unsupported and are not deleted.',
      prepared: null,
      checkpoint: null,
      captureRevision: null,
      counts: emptyCounts(),
      resumeConsequence: 'VNDB pre-native acquisition is a distinct engine and is not retired here.',
    };
  }
  const pin: StagingRetirementReview['pin'] =
    generation.id === pins.active ? 'active' : generation.id === pins.baseline ? 'baseline' : 'none';
  const counts = countsFor(database, input.source, generation.id, catalog.tables);
  const checkpoint = readCheckpoint(database, input.source, generation.id, catalog.tables) ?? {
    state: 'absent' as const,
  };
  const revision = captureRevision({ generation, checkpoint, counts });
  const review = {
    ...base,
    status: generation.status,
    seq: generation.seq,
    pin,
    prepared: generation.prepared,
    checkpoint,
    captureRevision: revision,
    counts,
  };
  if (generation.status === 'retired')
    return {
      ...review,
      eligible: false,
      reason: 'deliberately-retired',
      explanation:
        'This generation is a permanent retirement tombstone; the unpublished input cannot be resumed under its old ID.',
      resumeConsequence: 'Start a separate ordinary import with the desired input.',
    };
  if (generation.status === 'retiring')
    return {
      ...review,
      eligible: false,
      reason: 'retirement-in-progress',
      explanation:
        'Retirement of this unpublished capture is already in progress for a local plan; finish that plan instead of selecting it again.',
      resumeConsequence: 'Re-run the same retire-staging apply. Same-source import waits for that local cleanup.',
    };
  if (generation.status !== 'staging') {
    const detail = statusExplanation(generation.status);
    return {
      ...review,
      eligible: false,
      ...detail,
      resumeConsequence: 'Use the existing sealed-resume or retention commands for this stored status.',
    };
  }
  if (checkpoint.state === 'corrupt')
    return {
      ...review,
      eligible: false,
      reason: 'corrupt-checkpoint',
      explanation:
        'The stored staging checkpoint is corrupt or unrecognised. Retirement is refused rather than inferred.',
      resumeConsequence: 'The capture is not treated as eligible unpublished staging.',
    };
  const pinKind = effectPin(database, input.source, generation.id, catalog.tables, generation);
  if (pinKind)
    return {
      ...review,
      eligible: false,
      reason: pinKind === 'sealed-evidence' ? 'sealed-evidence' : 'prepared-or-effect',
      explanation:
        pinKind === 'sealed-evidence'
          ? 'Sealed complete-input or recovery evidence is present for this generation; a shallow staging label is not enough.'
          : 'Prepared commands, envelopes, observation operations or other native-effect pins are present; staging retirement does not cancel that work.',
      resumeConsequence: 'Finish or retain this generation through the ordinary sealed path. Do not force discard.',
    };
  const resumeConsequence =
    checkpoint.state === 'present'
      ? 'Retiring this capture permanently drops the unpublished prefix and checkpoint; --resume-staging cannot recreate it under this ID.'
      : checkpoint.state === 'unavailable'
        ? 'Checkpoint tables are unavailable on this schema; remaining unsealed rows can still be released without the original file.'
        : 'This uncheckpointed staging run cannot be resumed; ordinary import would discard it, and explicit retirement releases it without replacement input.';
  return {
    ...review,
    eligible: true,
    reason: 'unpublished-staging',
    explanation:
      'This generation is strictly unpublished staging with no sealed, prepared, observation or recovery pin on the delivered schema.',
    resumeConsequence,
  };
}

function revalidatePins(
  database: Database,
  plan: StagingRetirementPlanDocument,
  catalog: RetentionCatalog,
  options: { activeMayBeReleased?: boolean } = {},
): void {
  const pins = retentionSourcePins(database, plan.source);
  if (pins.baseline !== plan.pins.baseline)
    throw new RetentionFailure('Observed baseline changed; build a fresh explicit plan.', 'stale');
  if (pins.sequence !== plan.pins.sequence || pins.presentCount !== plan.pins.presentCount)
    throw new RetentionFailure(
      'Observed source sequence or present count changed; build a fresh explicit plan.',
      'stale',
    );
  if (!options.activeMayBeReleased && pins.active !== plan.pins.active)
    throw new RetentionFailure(
      'Observed baseline or recoverable generation changed; build a fresh explicit plan.',
      'stale',
    );
  if (options.activeMayBeReleased && pins.active !== plan.pins.active && pins.active !== null)
    throw new RetentionFailure(
      'Observed baseline or recoverable generation changed; build a fresh explicit plan.',
      'stale',
    );
  if (catalog.userVersion !== plan.state.userVersion)
    throw new RetentionFailure('State schema version changed; build a fresh explicit plan.', 'stale');
}

function revalidatePlan(
  database: Database,
  plan: StagingRetirementPlanDocument,
  catalog: RetentionCatalog,
): StagingRetirementReview {
  revalidatePins(database, plan, catalog);
  const review = classifyOnDatabase(
    database,
    { source: plan.source, generation: plan.generation, statePath: plan.state.path },
    catalog,
  );
  if (review.captureRevision !== plan.captureRevision)
    throw new RetentionFailure(
      'Staging progress, seal or capture revision changed; build a fresh explicit plan.',
      'stale',
    );
  return review;
}

export function reviewStagingRetirementOnDatabase(
  database: Database,
  input: { source: string; generation: string; statePath: string },
  catalog: RetentionCatalog,
): StagingRetirementReview {
  return classifyOnDatabase(database, input, catalog);
}

export async function reviewStagingRetirement(
  input: { state: string; source: string; generation: string },
  options: StagingRetirementOptions = {},
): Promise<StagingRetirementReview> {
  admitRetentionSource(input.source);
  admitRetentionGenerationId(input.generation);
  const store = await openRetentionReadonly(input.state, options);
  try {
    throwIfRetentionAborted(options.signal);
    const database = options.instrumentDatabase?.(store.database) ?? store.database;
    assertRetentionKnownSchema(database);
    return classifyOnDatabase(
      database,
      { source: input.source, generation: input.generation, statePath: store.path },
      retentionCatalog(database),
    );
  } finally {
    await store.close();
  }
}

export async function buildStagingRetirementPlan(
  input: { state: string; source: string; generation: string; output: string },
  options: StagingRetirementOptions = {},
): Promise<StagingRetirementPlanDocument> {
  admitRetentionSource(input.source);
  admitRetentionGenerationId(input.generation);
  if (!input.output || !input.output.trim() || input.output === '-')
    throw new RetentionFailure('A staging retirement plan requires --output <path>.', 'usage');
  const store = await openRetentionReadonly(input.state, options);
  let handle: FileHandle | undefined;
  try {
    throwIfRetentionAborted(options.signal);
    const database = options.instrumentDatabase?.(store.database) ?? store.database;
    const tables = assertRetentionKnownSchema(database);
    const catalog = retentionCatalog(database);
    const pins = retentionSourcePins(database, input.source);
    if (pins.sourceState === 'absent')
      throw new RetentionFailure(`No source state exists for ${JSON.stringify(input.source)}.`, 'missing');
    const review = classifyOnDatabase(
      database,
      { source: input.source, generation: input.generation, statePath: store.path },
      catalog,
    );
    const identity = await stat(store.path);
    const owner = ownerIdentity(database, input.source, catalog.tables);
    const planId = randomBytes(24).toString('hex');
    if (!review.captureRevision && review.eligible)
      throw new RetentionFailure('Eligible unpublished staging must carry a capture revision.', 'failed');
    const document: StagingRetirementPlanDocument = {
      version: RETENTION_PLAN_VERSION,
      kind: STAGING_RETIREMENT_PLAN_KIND,
      planId,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      state: { path: store.path, dev: identity.dev, ino: identity.ino, userVersion: retentionUserVersion(database) },
      source: input.source,
      generation: input.generation,
      schema: { compatibility: RETENTION_SCHEMA, retirement: STAGING_RETIREMENT_SCHEMA, tables },
      pins: {
        baseline: pins.baseline,
        active: pins.active,
        presentCount: pins.presentCount ?? 0,
        sequence: pins.sequence ?? 0,
        ownershipRow: retentionOwnershipRow(database, input.source, catalog.tables),
        ownerPid: owner.pid,
        ownerBirth: owner.birth,
      },
      captureRevision: review.captureRevision ?? '',
      review,
      applyable: review.eligible,
      preserved: review.preserved,
      unavailable: review.unavailable,
      sqliteNote: RETENTION_SQLITE_NOTE,
      snapshot: retentionSnapshotAdvice(store.path),
      apply: `bun services/importer/src/cli.ts retire-staging --state ${JSON.stringify(store.path)} --plan ${JSON.stringify(resolve(input.output))} --confirm ${planId} --apply`,
    };
    throwIfRetentionAborted(options.signal);
    const payload = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(payload) > RETENTION_MAX_PLAN_BYTES)
      throw new RetentionFailure('Staging retirement plan exceeds its stored bound.', 'failed');
    const output = resolve(input.output);
    try {
      handle = await open(output, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST')
        throw new RetentionFailure('Plan path already exists and will not be replaced.', 'unsafe-file');
      if (code === 'ELOOP') throw new RetentionFailure('Plan path must not be a symbolic link.', 'unsafe-file');
      throw new RetentionFailure('Unable to create an exclusive owner-only plan file.', 'unsafe-file');
    }
    const written = await handle.write(Buffer.from(payload, 'utf8'), 0, Buffer.byteLength(payload), 0);
    if (written.bytesWritten !== Buffer.byteLength(payload))
      throw new RetentionFailure('Plan file could not be written completely.', 'failed');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(output, 0o600);
    return document;
  } finally {
    await handle?.close().catch(() => {});
    await store.close();
  }
}

function parseReview(value: unknown): StagingRetirementReview {
  const row = exactRetentionObject(
    value,
    [
      'version',
      'operation',
      'source',
      'generation',
      'status',
      'seq',
      'pin',
      'eligible',
      'reason',
      'explanation',
      'ownerAvailability',
      'baseline',
      'active',
      'presentCount',
      'sequence',
      'prepared',
      'checkpoint',
      'captureRevision',
      'counts',
      'resumeConsequence',
      'preserved',
      'unavailable',
      'sqliteNote',
      'snapshot',
    ],
    'review',
  );
  const counts = exactRetentionObject(
    row.counts,
    ['entries', 'diagnostics', 'diagnosticRecords', 'stagingCheckpoints', 'stagingPrefix'],
    'review.counts',
  );
  return {
    version: 1,
    operation: 'review',
    source: String(row.source),
    generation: String(row.generation),
    status: String(row.status),
    seq: row.seq === null ? null : retentionInteger(row.seq, 'review.seq'),
    pin: row.pin as StagingRetirementReview['pin'],
    eligible: row.eligible === true,
    reason: row.reason as StagingRetirementEligibilityReason,
    explanation: String(row.explanation),
    ownerAvailability: row.ownerAvailability as StagingRetirementOwnerAvailability,
    baseline: row.baseline === null ? null : String(row.baseline),
    active: row.active === null ? null : String(row.active),
    presentCount: row.presentCount === null ? null : retentionInteger(row.presentCount, 'review.presentCount'),
    sequence: row.sequence === null ? null : retentionInteger(row.sequence, 'review.sequence'),
    prepared: row.prepared === null ? null : retentionInteger(row.prepared, 'review.prepared'),
    checkpoint: row.checkpoint as StagingRetirementReview['checkpoint'],
    captureRevision: row.captureRevision === null ? null : String(row.captureRevision),
    counts: {
      entries: retentionInteger(counts.entries, 'counts.entries'),
      diagnostics: retentionInteger(counts.diagnostics, 'counts.diagnostics'),
      diagnosticRecords: retentionInteger(counts.diagnosticRecords, 'counts.diagnosticRecords'),
      stagingCheckpoints: retentionInteger(counts.stagingCheckpoints, 'counts.stagingCheckpoints'),
      stagingPrefix: retentionInteger(counts.stagingPrefix, 'counts.stagingPrefix'),
    },
    resumeConsequence: String(row.resumeConsequence),
    preserved: row.preserved as string[],
    unavailable: row.unavailable as string[],
    sqliteNote: String(row.sqliteNote),
    snapshot: String(row.snapshot),
  };
}

export async function readStagingRetirementPlanFile(path: string): Promise<StagingRetirementPlanDocument> {
  const resolved = resolve(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const identity = await handle.stat();
    if (!identity.isFile()) throw new RetentionFailure('Plan path is not a regular file.', 'unsafe-file');
    if ((identity.mode & 0o077) !== 0)
      throw new RetentionFailure('Plan file must be owner-only (mode 0600).', 'unsafe-file');
    if (identity.size > RETENTION_MAX_PLAN_BYTES)
      throw new RetentionFailure('Plan file exceeds its stored bound.', 'incompatible');
    const buffer = Buffer.alloc(Number(identity.size));
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (read.bytesRead !== buffer.byteLength)
      throw new RetentionFailure('Plan file could not be read completely.', 'incompatible');
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      throw new RetentionFailure('Plan file is not valid JSON.', 'incompatible');
    }
    const document = exactRetentionObject(
      parsed,
      [
        'version',
        'kind',
        'planId',
        'createdAt',
        'state',
        'source',
        'generation',
        'schema',
        'pins',
        'captureRevision',
        'review',
        'applyable',
        'preserved',
        'unavailable',
        'sqliteNote',
        'snapshot',
        'apply',
      ],
      'plan',
    );
    if (document.version !== 1 || document.kind !== STAGING_RETIREMENT_PLAN_KIND)
      throw new RetentionFailure('Plan file is not a supported staging retirement plan.', 'incompatible');
    admitRetentionPlanId(document.planId);
    admitRetentionSource(document.source);
    admitRetentionGenerationId(document.generation);
    const state = exactRetentionObject(document.state, ['path', 'dev', 'ino', 'userVersion'], 'plan.state');
    const schema = exactRetentionObject(document.schema, ['compatibility', 'retirement', 'tables'], 'plan.schema');
    const pins = exactRetentionObject(
      document.pins,
      ['baseline', 'active', 'presentCount', 'sequence', 'ownershipRow', 'ownerPid', 'ownerBirth'],
      'plan.pins',
    );
    if (schema.compatibility !== RETENTION_SCHEMA || schema.retirement !== STAGING_RETIREMENT_SCHEMA)
      throw new RetentionFailure('Plan schema compatibility does not match this importer.', 'stale');
    if (!Array.isArray(schema.tables) || !Array.isArray(document.preserved) || !Array.isArray(document.unavailable))
      throw new RetentionFailure('Plan file is not a supported staging retirement plan.', 'incompatible');
    return {
      version: 1,
      kind: STAGING_RETIREMENT_PLAN_KIND,
      planId: document.planId as string,
      createdAt: String(document.createdAt),
      state: {
        path: String(state.path),
        dev: retentionInteger(state.dev, 'state.dev'),
        ino: retentionInteger(state.ino, 'state.ino'),
        userVersion: retentionInteger(state.userVersion, 'state.userVersion'),
      },
      source: document.source as string,
      generation: document.generation as string,
      schema: {
        compatibility: RETENTION_SCHEMA,
        retirement: STAGING_RETIREMENT_SCHEMA,
        tables: schema.tables as string[],
      },
      pins: {
        baseline: pins.baseline === null ? null : (admitRetentionGenerationId(pins.baseline), pins.baseline as string),
        active: pins.active === null ? null : (admitRetentionGenerationId(pins.active), pins.active as string),
        presentCount: retentionInteger(pins.presentCount, 'pins.presentCount'),
        sequence: retentionInteger(pins.sequence, 'pins.sequence'),
        ownershipRow: pins.ownershipRow as StagingRetirementPlanDocument['pins']['ownershipRow'],
        ownerPid: pins.ownerPid === null ? null : retentionInteger(pins.ownerPid, 'pins.ownerPid'),
        ownerBirth: pins.ownerBirth === null ? null : String(pins.ownerBirth),
      },
      captureRevision: String(document.captureRevision),
      review: parseReview(document.review),
      applyable: document.applyable === true,
      preserved: document.preserved as string[],
      unavailable: document.unavailable as string[],
      sqliteNote: String(document.sqliteNote),
      snapshot: String(document.snapshot),
      apply: String(document.apply),
    };
  } catch (error) {
    if (error instanceof RetentionFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RetentionFailure('Plan file does not exist.', 'missing');
    if (code === 'ELOOP') throw new RetentionFailure('Plan path must not be a symbolic link.', 'unsafe-file');
    throw new RetentionFailure('Unable to read the staging retirement plan file.', 'unsafe-file');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function phaseIndex(phase: string): number {
  const index = STAGING_RETIREMENT_DELETE_PHASES.indexOf(phase as StagingRetirementDeletePhase);
  if (index < 0) throw new RetentionFailure('Retirement work cursor names an unknown deletion phase.', 'incompatible');
  return index;
}

function beginOrResumeWork(
  database: Database,
  plan: StagingRetirementPlanDocument,
  catalog: RetentionCatalog,
  session: ImportSession,
): ReturnType<typeof retentionWorkRow> {
  const existing = retentionWorkRow(database, plan.planId);
  const selected = [plan.generation];
  if (existing) {
    if (existing.source !== plan.source || existing.selected_json !== JSON.stringify(selected))
      throw new RetentionFailure(
        'Stored retention work does not match this plan; build a fresh explicit plan.',
        'stale',
      );
    return existing;
  }
  if (!plan.review.eligible || plan.review.reason !== 'unpublished-staging')
    throw new RetentionFailure(plan.review.explanation, 'ineligible');
  const review = revalidatePlan(database, plan, catalog);
  if (!review.eligible || review.reason !== 'unpublished-staging')
    throw new RetentionFailure(review.explanation, review.reason === 'missing' ? 'missing' : 'ineligible');
  session.store.releaseStagingForRetirement(plan.source, plan.generation);
  database
    .query(
      `INSERT INTO run_retention_work(plan_id,source,selected_json,bound_json,status,generation_id,phase,cursor,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      plan.planId,
      plan.source,
      JSON.stringify(selected),
      JSON.stringify(plan.pins),
      'applying',
      plan.generation,
      STAGING_RETIREMENT_DELETE_PHASES[0],
      '',
      plan.createdAt,
    );
  const inserted = retentionWorkRow(database, plan.planId);
  if (!inserted) throw new RetentionFailure('Retention work row was not stored for this plan.', 'failed');
  return inserted;
}

export function applyStagingRetirementOnDatabase(
  database: Database,
  plan: StagingRetirementPlanDocument,
  session: ImportSession,
  ownership: ImportOwnership,
  statePath: string,
  catalog: RetentionCatalog,
  options: StagingRetirementOptions = {},
): StagingRetirementApplyDocument {
  const pageSize = options.pageSize ?? RETENTION_DELETE_PAGE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > RETENTION_MAX_PAGE)
    throw new RetentionFailure('Deletion page size must be an integer from 1 through 100.', 'usage');
  const started = database
    .transaction(() => {
      session.assertHeld(ownership);
      if (!catalog.tables.has('run_retention_work')) ensureRetentionWork(database);
      const existing = retentionWorkRow(database, plan.planId);
      if (existing?.status === 'complete') return existing;
      if (existing) {
        revalidatePins(database, plan, catalog, { activeMayBeReleased: true });
        return existing;
      }
      revalidatePlan(database, plan, catalog);
      return beginOrResumeWork(database, plan, catalog, session);
    })
    .immediate();
  if (!started) throw new RetentionFailure('Retention work row was not stored for this plan.', 'failed');
  if (started.status === 'complete') {
    const retired = started.result_json
      ? (JSON.parse(started.result_json) as { retired: string[] }).retired
      : [plan.generation];
    return {
      version: 1,
      operation: 'apply',
      status: 'complete',
      planId: plan.planId,
      source: plan.source,
      generation: plan.generation,
      retired,
      inProgress: [],
      sqliteNote: RETENTION_SQLITE_NOTE,
      snapshot: retentionSnapshotAdvice(statePath),
    };
  }
  let generationId = started.generation_id;
  let phase = started.phase as StagingRetirementDeletePhase;
  let cursor = started.cursor;
  while (generationId) {
    throwIfRetentionAborted(options.signal);
    options.observer?.beforePage?.({ generation: generationId, phase });
    throwIfRetentionAborted(options.signal);
    const advanced = database
      .transaction(() => {
        session.assertHeld(ownership);
        revalidatePins(database, plan, catalog, { activeMayBeReleased: true });
        const current = retentionWorkRow(database, plan.planId);
        if (!current || current.status !== 'applying')
          throw new RetentionFailure('Retention work is no longer the applying local plan.', 'stale');
        const page = runRetentionDeletePhase(
          database,
          plan.source,
          generationId,
          phase,
          cursor,
          pageSize,
          catalog.tables,
        );
        let nextPhase = phase;
        let nextCursor = page.cursor;
        let complete = false;
        if (page.done) {
          const nextIndex = phaseIndex(phase) + 1;
          if (nextIndex < STAGING_RETIREMENT_DELETE_PHASES.length) {
            nextPhase = STAGING_RETIREMENT_DELETE_PHASES[nextIndex]!;
            nextCursor = '';
          } else complete = true;
        }
        database
          .query(
            `UPDATE run_retention_work SET generation_id=?, phase=?, cursor=?, status=?, result_json=? WHERE plan_id=? AND status=?`,
          )
          .run(
            complete ? '' : generationId,
            complete ? '' : nextPhase,
            complete ? '' : nextCursor,
            complete ? 'complete' : 'applying',
            complete ? JSON.stringify({ retired: [plan.generation] }) : null,
            plan.planId,
            'applying',
          );
        return { nextPhase, nextCursor, complete };
      })
      .immediate();
    if (advanced.complete) {
      return {
        version: 1,
        operation: 'apply',
        status: 'complete',
        planId: plan.planId,
        source: plan.source,
        generation: plan.generation,
        retired: [plan.generation],
        inProgress: [],
        sqliteNote: RETENTION_SQLITE_NOTE,
        snapshot: retentionSnapshotAdvice(statePath),
      };
    }
    phase = advanced.nextPhase;
    cursor = advanced.nextCursor;
  }
  return {
    version: 1,
    operation: 'apply',
    status: 'complete',
    planId: plan.planId,
    source: plan.source,
    generation: plan.generation,
    retired: [plan.generation],
    inProgress: [],
    sqliteNote: RETENTION_SQLITE_NOTE,
    snapshot: retentionSnapshotAdvice(statePath),
  };
}

export async function applyStagingRetirementPlan(
  input: { state: string; plan: string; confirm: string },
  options: StagingRetirementOptions = {},
): Promise<StagingRetirementApplyDocument> {
  admitRetentionPlanId(input.confirm);
  const plan = await readStagingRetirementPlanFile(input.plan);
  if (plan.planId !== input.confirm)
    throw new RetentionFailure(
      'Apply requires the current plan identity as --confirm; the selected capture is never expanded.',
      'usage',
    );
  if (!plan.applyable)
    throw new RetentionFailure(
      'This plan is not an eligible unpublished staging capture; build a fresh explicit plan.',
      'ineligible',
    );
  let opened: Awaited<ReturnType<typeof openRetentionWritable>> | undefined;
  let session: ImportSession | undefined;
  try {
    throwIfRetentionAborted(options.signal);
    opened = await openRetentionWritable(input.state, options);
    if (opened.identity.dev !== plan.state.dev || opened.identity.ino !== plan.state.ino)
      throw new RetentionFailure('State file identity does not match the plan; build a fresh explicit plan.', 'stale');
    const database = opened.database;
    assertRetentionKnownSchema(database);
    session = new ImportSession(database);
    const ownership = session.acquire(plan.source);
    if (ownership === 'busy') throw new RetentionFailure('A live or uninspectable owner holds this source.', 'busy');
    try {
      return applyStagingRetirementOnDatabase(
        database,
        plan,
        session,
        ownership,
        opened.path,
        retentionCatalog(database),
        options,
      );
    } finally {
      session.release(ownership);
    }
  } catch (error) {
    if (error instanceof RetentionFailure && error.kind === 'cancelled') {
      return {
        version: 1,
        operation: 'apply',
        status: 'cancelled',
        planId: plan.planId,
        source: plan.source,
        generation: plan.generation,
        retired: [],
        inProgress: [plan.generation],
        sqliteNote: RETENTION_SQLITE_NOTE,
        snapshot: retentionSnapshotAdvice(opened?.path ?? plan.state.path),
      };
    }
    throw error;
  } finally {
    session?.close();
    opened?.close({ database: session === undefined });
  }
}
