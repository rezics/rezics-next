import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PreviewPlan, PreviewRecordRow } from './dump-preview-store.ts';
import { compareRetainedProjections, parseJsonField, type SideProjection } from './plan-comparison-diff.ts';
import {
  ComparisonStoreFailure,
  DEFAULT_COMPARISON_PAGE,
  MAX_COMPARISON_PAGE,
  PlanComparisonStore,
  type ComparisonKind,
  type ComparisonPartRow,
  type ComparisonPlan,
  type ComparisonRecordRow,
} from './plan-comparison-store.ts';

export class PlanComparisonFailure extends ComparisonStoreFailure {}

export type PlanComparisonOptions = Readonly<{
  leftDir: string;
  rightDir: string;
  outputDir?: string;
  signal?: AbortSignal;
  maxStoreBytes?: number;
  instrumentDatabase?: (database: Database) => Database;
  observer?: PlanComparisonObserver;
}>;

export type PlanComparisonObserver = Readonly<{
  onRecordVisit?(): void;
  onPartVisit?(): void;
  onPlanRead?(): void;
}>;

export type CapturedPlanIdentity = Readonly<{
  previewId: string;
  source: string;
  sourceKind: string;
  converterRevision: string;
  dumpPath: string;
  viewKind: string;
  baselineId: string | null;
  baselinePresent: number;
  admitted: number;
  skipped: number;
  vanishedCount: number;
  complete: boolean;
  storedBytes: number;
  size: number;
}>;

type OpenedPlan = {
  directory: string;
  path: string;
  descriptor: FileHandle;
  database: Database;
  plan: PreviewPlan;
  identity: CapturedPlanIdentity;
  captureDigest: string;
};

const RECORD_PAGE = 100;
const REQUIRED_PLAN_COLUMNS = [
  'preview_id',
  'source',
  'source_kind',
  'converter_revision',
  'dump_path',
  'view_kind',
  'baseline_id',
  'baseline_present',
  'complete',
  'error_identity',
  'error_message',
  'admitted',
  'skipped',
  'new_count',
  'changed_count',
  'unchanged_count',
  'vanished_count',
  'prior',
  'survivors',
  'stored_bytes',
] as const;
const REQUIRED_RECORD_COLUMNS = [
  'preview_id',
  'source',
  'kind',
  'record_key',
  'record_revision',
  'digest',
  'converter_revision',
  'skipped',
  'comparison_json',
  'display_json',
  'diagnostics_json',
  'operations_json',
  'provenance_json',
] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function throwIfAborted(signal: AbortSignal | undefined, message = 'Comparison was cancelled.'): void {
  if (signal?.aborted) throw new PlanComparisonFailure(message, 130);
}

function identityPin(identity: CapturedPlanIdentity): string {
  return sha256(
    JSON.stringify({
      v: 1,
      previewId: identity.previewId,
      source: identity.source,
      sourceKind: identity.sourceKind,
      converterRevision: identity.converterRevision,
      dumpPath: identity.dumpPath,
      viewKind: identity.viewKind,
      baselineId: identity.baselineId,
      baselinePresent: identity.baselinePresent,
      admitted: identity.admitted,
      skipped: identity.skipped,
      vanishedCount: identity.vanishedCount,
      complete: identity.complete,
      storedBytes: identity.storedBytes,
      size: identity.size,
    }),
  );
}

function captureDigest(left: CapturedPlanIdentity, right: CapturedPlanIdentity): string {
  return sha256(JSON.stringify({ v: 1, left: identityPin(left), right: identityPin(right) }));
}

function tableColumns(database: Database, table: string): Set<string> {
  const found = database.query('SELECT 1 AS found FROM sqlite_schema WHERE type=? AND name=?').get('table', table) as {
    found: number;
  } | null;
  if (!found) throw new PlanComparisonFailure(`Unsupported preview plan schema: table ${table} is missing.`, 2);
  return new Set(
    database
      .query(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as { name: string }).name),
  );
}

function requireColumns(actual: Set<string>, required: readonly string[], table: string): void {
  const missing = required.find((column) => !actual.has(column));
  if (missing)
    throw new PlanComparisonFailure(`Unsupported preview plan schema: column ${table}.${missing} is missing.`, 2);
}

function mapPreviewPlan(row: Record<string, unknown>): PreviewPlan {
  let inputFamilies: PreviewPlan['inputFamilies'] = [];
  if (typeof row.input_selection === 'string' && row.input_selection.length) {
    try {
      const parsed = JSON.parse(row.input_selection) as unknown;
      if (Array.isArray(parsed))
        inputFamilies = parsed.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const family = Reflect.get(item, 'family');
          const compression = Reflect.get(item, 'compression');
          return typeof family === 'string' && typeof compression === 'string' ? [{ family, compression }] : [];
        });
    } catch {
      inputFamilies = [];
    }
  }
  return {
    previewId: String(row.preview_id),
    source: String(row.source),
    sourceKind: String(row.source_kind),
    converterRevision: String(row.converter_revision),
    dumpPath: String(row.dump_path),
    inputKind: row.input_kind === 'dump-set' ? 'dump-set' : 'dump',
    inputFamilies,
    viewKind: row.view_kind as PreviewPlan['viewKind'],
    baselineId: row.baseline_id === null ? null : String(row.baseline_id),
    baselinePresent: Number(row.baseline_present),
    complete: Number(row.complete) === 1,
    errorIdentity: row.error_identity === null ? null : String(row.error_identity),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    disappearanceWouldBlock: Number(row.disappearance_would_block) === 1,
    admitted: Number(row.admitted),
    skipped: Number(row.skipped),
    newCount: Number(row.new_count),
    changedCount: Number(row.changed_count),
    unchangedCount: Number(row.unchanged_count),
    vanishedCount: Number(row.vanished_count),
    prior: Number(row.prior),
    survivors: Number(row.survivors),
    storedBytes: Number(row.stored_bytes),
  };
}

async function openPreviewSqlite(directory: string): Promise<OpenedPlan> {
  const resolved = resolve(directory);
  let dirHandle: FileHandle | undefined;
  let descriptor: FileHandle | undefined;
  let database: Database | undefined;
  try {
    dirHandle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    const dirStat = await dirHandle.stat();
    if (!dirStat.isDirectory()) throw new PlanComparisonFailure('Preview plan path is not a directory.', 2);
    const path = join(resolved, 'preview.sqlite');
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    descriptor = await open(path, flags);
    const identity = await descriptor.stat();
    if (!identity.isFile()) throw new PlanComparisonFailure('Preview plan database is not a regular file.', 2);
    database = new Database(path, { readonly: true, create: false, strict: true });
    const afterOpen = await stat(path);
    if (!sameFile(identity, afterOpen))
      throw new PlanComparisonFailure('Preview plan path changed while it was being opened.', 2);
    requireColumns(tableColumns(database, 'preview_plans'), REQUIRED_PLAN_COLUMNS, 'preview_plans');
    requireColumns(tableColumns(database, 'preview_records'), REQUIRED_RECORD_COLUMNS, 'preview_records');
    tableColumns(database, 'preview_vanished');
    const rows = database.query('SELECT * FROM preview_plans LIMIT 2').all() as Record<string, unknown>[];
    if (rows.length !== 1)
      throw new PlanComparisonFailure('Preview directory does not contain exactly one completed plan.', 2);
    const plan = mapPreviewPlan(rows[0]!);
    if (!plan.complete)
      throw new PlanComparisonFailure('Preview plan is incomplete and cannot enter a completed comparison.', 2);
    if (plan.viewKind !== 'first-import' && plan.viewKind !== 'baseline-comparison')
      throw new PlanComparisonFailure('Preview plan view kind is unsupported.', 2);
    const captured: CapturedPlanIdentity = {
      previewId: plan.previewId,
      source: plan.source,
      sourceKind: plan.sourceKind,
      converterRevision: plan.converterRevision,
      dumpPath: plan.dumpPath,
      viewKind: plan.viewKind,
      baselineId: plan.baselineId,
      baselinePresent: plan.baselinePresent,
      admitted: plan.admitted,
      skipped: plan.skipped,
      vanishedCount: plan.vanishedCount,
      complete: plan.complete,
      storedBytes: plan.storedBytes,
      size: identity.size,
    };
    const opened: OpenedPlan = {
      directory: resolved,
      path,
      descriptor,
      database,
      plan,
      identity: captured,
      captureDigest: identityPin(captured),
    };
    descriptor = undefined;
    database = undefined;
    return opened;
  } catch (error) {
    database?.close();
    await descriptor?.close().catch(() => {});
    if (error instanceof PlanComparisonFailure) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new PlanComparisonFailure('Preview plan directory or database does not exist.', 2);
    if (code === 'ELOOP') throw new PlanComparisonFailure('Preview plan path must not be a symbolic link.', 2);
    if (
      error instanceof Error &&
      /not a database|unable to open database|database disk image is malformed/i.test(error.message)
    )
      throw new PlanComparisonFailure('Preview plan file is not a supported readable SQLite database.', 2);
    throw new PlanComparisonFailure(
      `Unable to open preview plan ${JSON.stringify(resolved)}${code ? ` (${code})` : ''}.`,
      2,
    );
  } finally {
    await dirHandle?.close().catch(() => {});
  }
}

function pageRecords(opened: OpenedPlan, after: string | null): PreviewRecordRow[] {
  const sql =
    after === null
      ? `SELECT record_key AS recordKey, kind, record_revision AS recordRevision, digest,
                converter_revision AS converterRevision, skipped, comparison_json AS comparisonJson,
                display_json AS displayJson, diagnostics_json AS diagnosticsJson,
                operations_json AS operationsJson, provenance_json AS provenanceJson
         FROM preview_records
         WHERE preview_id=? AND source=?
         ORDER BY record_key LIMIT ?`
      : `SELECT record_key AS recordKey, kind, record_revision AS recordRevision, digest,
                converter_revision AS converterRevision, skipped, comparison_json AS comparisonJson,
                display_json AS displayJson, diagnostics_json AS diagnosticsJson,
                operations_json AS operationsJson, provenance_json AS provenanceJson
         FROM preview_records
         WHERE preview_id=? AND source=? AND record_key>?
         ORDER BY record_key LIMIT ?`;
  const rows = (
    after === null
      ? opened.database.query(sql).all(opened.plan.previewId, opened.plan.source, RECORD_PAGE)
      : opened.database.query(sql).all(opened.plan.previewId, opened.plan.source, after, RECORD_PAGE)
  ) as {
    recordKey: string;
    kind: PreviewRecordRow['kind'];
    recordRevision: string;
    digest: string;
    converterRevision: string;
    skipped: number;
    comparisonJson: string;
    displayJson: string;
    diagnosticsJson: string;
    operationsJson: string;
    provenanceJson: string;
  }[];
  return rows.map((row) => ({
    recordKey: row.recordKey,
    kind: row.kind,
    recordRevision: row.recordRevision,
    digest: row.digest,
    converterRevision: row.converterRevision,
    skipped: row.skipped === 1,
    comparisonJson: row.comparisonJson,
    displayJson: row.displayJson,
    diagnosticsJson: row.diagnosticsJson,
    operationsJson: row.operationsJson,
    provenanceJson: row.provenanceJson,
  }));
}

function vanishedHas(opened: OpenedPlan, recordKey: string): boolean {
  return !!opened.database
    .query('SELECT 1 AS found FROM preview_vanished WHERE preview_id=? AND source=? AND record_key=?')
    .get(opened.plan.previewId, opened.plan.source, recordKey);
}

async function closePlan(opened: OpenedPlan | undefined): Promise<void> {
  if (!opened) return;
  try {
    opened.database.close();
  } catch {
    // The snapshot is already finished.
  }
  await opened.descriptor.close().catch(() => {});
}

function sideFromRecord(record: PreviewRecordRow): { side: SideProjection | null; unavailable: boolean } {
  const display = parseJsonField(record.displayJson, 'display');
  const operations = parseJsonField(record.operationsJson, 'operations');
  const provenance = parseJsonField(record.provenanceJson, 'provenance');
  const diagnostics = parseJsonField(record.diagnosticsJson, 'diagnostics');
  if (!display.ok || !operations.ok || !provenance.ok || !diagnostics.ok) return { side: null, unavailable: true };
  return {
    unavailable: false,
    side: {
      recordKey: record.recordKey,
      kind: record.kind,
      recordRevision: record.recordRevision,
      digest: record.digest,
      converterRevision: record.converterRevision,
      skipped: record.skipped,
      display: display.value,
      operations: operations.value,
      provenance: provenance.value,
      diagnostics: diagnostics.value,
    },
  };
}

function classify(
  left: PreviewRecordRow | null,
  right: PreviewRecordRow | null,
  diff: ReturnType<typeof compareRetainedProjections>,
  unavailable: boolean,
): ComparisonKind {
  if (unavailable) return 'unavailable';
  if (left && !right) return 'only-left';
  if (!left && right) return 'only-right';
  if (diff.skippedDiffers) return 'skipped';
  if (diff.digestDiffers || diff.converterDiffers || diff.revisionDiffers || !diff.retainedEqual) return 'changed';
  return 'unchanged';
}

function jsonSide(record: PreviewRecordRow | null, vanished: boolean): string | null {
  if (!record) return JSON.stringify({ presence: 'absent', vanished });
  return JSON.stringify({
    presence: 'present',
    vanished,
    kind: record.kind,
    recordRevision: record.recordRevision,
    digest: record.digest,
    converterRevision: record.converterRevision,
    skipped: record.skipped,
    display: parseJsonField(record.displayJson, 'display').ok ? JSON.parse(record.displayJson) : { unavailable: true },
    operations: parseJsonField(record.operationsJson, 'operations').ok
      ? JSON.parse(record.operationsJson)
      : { unavailable: true },
    provenance: parseJsonField(record.provenanceJson, 'provenance').ok
      ? JSON.parse(record.provenanceJson)
      : { unavailable: true },
  });
}

async function createOutputDir(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    const opened = await open(resolved, constants.O_NOFOLLOW ?? 0);
    try {
      const identity = await opened.stat();
      if (!identity.isDirectory()) throw new PlanComparisonFailure('Comparison output path is not a directory.', 2);
    } finally {
      await opened.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(resolved, { recursive: false, mode: 0o700 });
      return resolved;
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new PlanComparisonFailure('Comparison output path must not be a symbolic link.', 2);
    if (error instanceof PlanComparisonFailure) throw error;
    throw new PlanComparisonFailure('Comparison output directory could not be created.', 2);
  }
  const sqlite = join(resolved, 'comparison.sqlite');
  try {
    await stat(sqlite);
    throw new PlanComparisonFailure(
      'Comparison output directory already contains a database; refusing to overwrite it.',
      2,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error instanceof PlanComparisonFailure
      ? error
      : new PlanComparisonFailure(
          'Comparison output directory already contains a database; refusing to overwrite it.',
          2,
        );
  }
}

export function admitComparablePlans(left: PreviewPlan, right: PreviewPlan): void {
  if (left.source !== right.source || left.sourceKind !== right.sourceKind)
    throw new PlanComparisonFailure(
      'Plans name different configured sources or provider kinds; they are not comparable refresh alternatives.',
      2,
    );
  const leftBaseline = left.baselineId;
  const rightBaseline = right.baselineId;
  if (leftBaseline === null && rightBaseline === null) return;
  if (leftBaseline !== rightBaseline || left.baselinePresent !== right.baselinePresent)
    throw new PlanComparisonFailure(
      'Plans capture different baselines; a fresh common capture is required before comparing refresh alternatives.',
      2,
    );
}

export class PlanComparison {
  private constructor(
    readonly directory: string,
    readonly retainDirectory: boolean,
    readonly store: PlanComparisonStore,
    readonly plan: ComparisonPlan,
  ) {}

  static async open(directory: string): Promise<PlanComparison> {
    const store = new PlanComparisonStore(join(directory, 'comparison.sqlite'));
    try {
      const plan = store.loadPlan();
      if (!plan) throw new PlanComparisonFailure('Comparison directory does not contain a plan.', 2);
      if (!plan.complete)
        throw new PlanComparisonFailure('Comparison is incomplete and cannot be reopened as a completed capture.', 2);
      if (plan.version !== 1) throw new PlanComparisonFailure('Comparison format version is unsupported.', 2);
      return new PlanComparison(directory, true, store, plan);
    } catch (error) {
      store.close();
      throw error;
    }
  }

  static async build(options: PlanComparisonOptions): Promise<PlanComparison> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const retain = Boolean(options.outputDir);
    const ownedDir = options.outputDir
      ? await createOutputDir(options.outputDir)
      : await mkdtemp(join(tmpdir(), 'rezics-plan-comparison-'));
    const store = new PlanComparisonStore(join(ownedDir, 'comparison.sqlite'), {
      ...(options.maxStoreBytes === undefined ? {} : { maxStoreBytes: options.maxStoreBytes }),
      ...(options.instrumentDatabase === undefined ? {} : { instrumentDatabase: options.instrumentDatabase }),
    });
    const comparisonId = randomUUID();
    let left: OpenedPlan | undefined;
    let right: OpenedPlan | undefined;
    try {
      left = await openPreviewSqlite(options.leftDir);
      right = await openPreviewSqlite(options.rightDir);
      options.observer?.onPlanRead?.();
      options.observer?.onPlanRead?.();
      throwIfAborted(signal);
      admitComparablePlans(left.plan, right.plan);
      const digest = captureDigest(left.identity, right.identity);
      store.beginPlan({
        comparisonId,
        captureDigest: digest,
        source: left.plan.source,
        sourceKind: left.plan.sourceKind,
        leftPreviewId: left.plan.previewId,
        rightPreviewId: right.plan.previewId,
        leftConverter: left.plan.converterRevision,
        rightConverter: right.plan.converterRevision,
        leftDump: left.plan.dumpPath,
        rightDump: right.plan.dumpPath,
        leftView: left.plan.viewKind,
        rightView: right.plan.viewKind,
        leftBaseline: left.plan.baselineId,
        rightBaseline: right.plan.baselineId,
        leftBaselinePresent: left.plan.baselinePresent,
        rightBaselinePresent: right.plan.baselinePresent,
        leftAdmitted: left.plan.admitted,
        rightAdmitted: right.plan.admitted,
        leftSkipped: left.plan.skipped,
        rightSkipped: right.plan.skipped,
        leftVanished: left.plan.vanishedCount,
        rightVanished: right.plan.vanishedCount,
        inputDiffers: left.plan.dumpPath !== right.plan.dumpPath,
        converterDiffers: left.plan.converterRevision !== right.plan.converterRevision,
      });
      let leftAfter: string | null = null;
      let rightAfter: string | null = null;
      let leftPage = pageRecords(left, null);
      let rightPage = pageRecords(right, null);
      let leftIndex = 0;
      let rightIndex = 0;
      const takeLeft = (): PreviewRecordRow | null => {
        if (leftIndex >= leftPage.length) {
          if (leftPage.length < RECORD_PAGE) return null;
          leftAfter = leftPage.at(-1)!.recordKey;
          leftPage = pageRecords(left!, leftAfter);
          leftIndex = 0;
          if (!leftPage.length) return null;
        }
        return leftPage[leftIndex++]!;
      };
      const takeRight = (): PreviewRecordRow | null => {
        if (rightIndex >= rightPage.length) {
          if (rightPage.length < RECORD_PAGE) return null;
          rightAfter = rightPage.at(-1)!.recordKey;
          rightPage = pageRecords(right!, rightAfter);
          rightIndex = 0;
          if (!rightPage.length) return null;
        }
        return rightPage[rightIndex++]!;
      };
      let leftRecord = takeLeft();
      let rightRecord = takeRight();
      while (leftRecord || rightRecord) {
        throwIfAborted(signal);
        let emitLeft: PreviewRecordRow | null = null;
        let emitRight: PreviewRecordRow | null = null;
        if (leftRecord && rightRecord) {
          if (leftRecord.recordKey === rightRecord.recordKey) {
            emitLeft = leftRecord;
            emitRight = rightRecord;
            leftRecord = takeLeft();
            rightRecord = takeRight();
          } else if (leftRecord.recordKey < rightRecord.recordKey) {
            emitLeft = leftRecord;
            leftRecord = takeLeft();
          } else {
            emitRight = rightRecord;
            rightRecord = takeRight();
          }
        } else if (leftRecord) {
          emitLeft = leftRecord;
          leftRecord = takeLeft();
        } else {
          emitRight = rightRecord;
          rightRecord = takeRight();
        }
        options.observer?.onRecordVisit?.();
        const recordKey = (emitLeft ?? emitRight)!.recordKey;
        const leftSide = emitLeft ? sideFromRecord(emitLeft) : { side: null, unavailable: false };
        const rightSide = emitRight ? sideFromRecord(emitRight) : { side: null, unavailable: false };
        const unavailable = leftSide.unavailable || rightSide.unavailable;
        const diff = unavailable
          ? {
              parts: [],
              truncated: false,
              retainedEqual: false,
              digestDiffers: Boolean(emitLeft && emitRight && emitLeft.digest !== emitRight.digest),
              converterDiffers: Boolean(
                emitLeft && emitRight && emitLeft.converterRevision !== emitRight.converterRevision,
              ),
              revisionDiffers: Boolean(emitLeft && emitRight && emitLeft.recordRevision !== emitRight.recordRevision),
              skippedDiffers: Boolean(emitLeft && emitRight && emitLeft.skipped !== emitRight.skipped),
              unavailable: true,
            }
          : compareRetainedProjections(leftSide.side, rightSide.side);
        const kind = classify(emitLeft, emitRight, diff, unavailable);
        const leftVanished = vanishedHas(left, recordKey);
        const rightVanished = vanishedHas(right, recordKey);
        const summary = {
          kind,
          inputDifference: !emitLeft || !emitRight,
          withdrawalBelongsToPlan: true,
          digestDiffers: diff.digestDiffers,
          converterDiffers: diff.converterDiffers,
          retainedEqual: diff.retainedEqual,
          truncated: diff.truncated,
          unavailable,
        };
        const row: ComparisonRecordRow = {
          recordKey,
          kind,
          leftKind: emitLeft?.kind ?? null,
          rightKind: emitRight?.kind ?? null,
          leftDigest: emitLeft?.digest ?? null,
          rightDigest: emitRight?.digest ?? null,
          leftRevision: emitLeft?.recordRevision ?? null,
          rightRevision: emitRight?.recordRevision ?? null,
          leftConverter: emitLeft?.converterRevision ?? null,
          rightConverter: emitRight?.converterRevision ?? null,
          leftSkipped: emitLeft ? emitLeft.skipped : null,
          rightSkipped: emitRight ? emitRight.skipped : null,
          leftVanished,
          rightVanished,
          digestDiffers: diff.digestDiffers,
          converterDiffers: diff.converterDiffers,
          retainedEqual: diff.retainedEqual,
          summaryJson: JSON.stringify(summary),
          leftJson: jsonSide(emitLeft, leftVanished),
          rightJson: jsonSide(emitRight, rightVanished),
        };
        store.insertRecord(comparisonId, row);
        diff.parts.forEach((part, ordinal) => {
          options.observer?.onPartVisit?.();
          const stored: ComparisonPartRow = {
            address: part.address,
            domain: part.domain,
            change: part.change,
            beforeJson: part.before === undefined ? null : JSON.stringify(part.before),
            afterJson: part.after === undefined ? null : JSON.stringify(part.after),
            ordinal,
          };
          store.insertPart(comparisonId, recordKey, stored);
        });
      }
      await closePlan(left);
      left = undefined;
      await closePlan(right);
      right = undefined;
      const plan = store.seal(comparisonId, { complete: true });
      return new PlanComparison(ownedDir, retain, store, plan);
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      try {
        if (store.loadPlan())
          store.seal(comparisonId, {
            complete: false,
            errorIdentity: interrupted ? 'cancelled' : 'invalid-input',
            errorMessage: interrupted
              ? 'Comparison was cancelled.'
              : error instanceof PlanComparisonFailure || error instanceof ComparisonStoreFailure
                ? error.message
                : 'Comparison input is incomplete or invalid.',
          });
      } catch {
        // Incomplete identity is best-effort once construction has failed.
      }
      await closePlan(left);
      await closePlan(right);
      const plan = store.loadPlan();
      if (plan && !interrupted) return new PlanComparison(ownedDir, retain, store, plan);
      store.close();
      if (!retain) await rm(ownedDir, { recursive: true, force: true });
      if (interrupted) throw new PlanComparisonFailure('Comparison was cancelled.', 130);
      if (error instanceof PlanComparisonFailure || error instanceof ComparisonStoreFailure) throw error;
      throw new PlanComparisonFailure(error instanceof Error ? error.message : 'Comparison failed safely.', 1);
    }
  }

  page(kind: ComparisonKind, options: { limit?: number; cursor?: string } = {}) {
    return this.store.pageRecords(this.plan.comparisonId, kind, options);
  }

  record(recordKey: string) {
    return this.store.recordDetail(this.plan.comparisonId, recordKey);
  }

  parts(recordKey: string, options: { limit?: number; cursor?: string } = {}) {
    return this.store.pageParts(this.plan.comparisonId, recordKey, options);
  }

  async close(): Promise<void> {
    this.store.close();
    if (!this.retainDirectory) await rm(this.directory, { recursive: true, force: true });
  }
}

export { DEFAULT_COMPARISON_PAGE, MAX_COMPARISON_PAGE };
