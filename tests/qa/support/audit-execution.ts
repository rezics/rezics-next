import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from '../../../scripts/load/compatibility.ts';
import { auditBaseline, auditPreparationBudgetMs, type AuditFilePin } from '../fixtures/audit-corpus-contract.ts';

/** Execution custody added by the shared producer, never by assertion templates.
 * The historical baseline and frozen source snapshots retain their own identities. */
export interface AuditExecutionMetadata {
  format: 'audit-execution-v1';
  productBaseline: typeof auditBaseline;
  productRevision: string;
  testRevision: string;
  fixtureGeneration: string;
  frontendRevision?: string;
  /** Existing producer qualification; original execution/preparation/backup bytes stay immutable. */
  retainedCustody?: AuditFilePin;
}

export interface AuditExecutionOptions {
  checkout?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Bind existing manifest aliases without changing their historical meaning. */
  productBaseline?: string;
  productRevision?: string;
  fixtureGeneration?: string;
}

const commit = /^[a-f0-9]{40}$/;
const generation = /^rs-[a-z][a-z0-9-]{0,80}-[a-f0-9]{64}$/;
const launchGeneration = /^recipes-build-[a-z0-9]+-[a-f0-9]{6}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requirePin(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`TEST PREMISE: audit execution ${detail}; no product assertion reached`);
}

function retainedBytes(pin: unknown, checkout: string): Buffer {
  requirePin(object(pin) && typeof pin.file === 'string' && !isAbsolute(pin.file)
    && typeof pin.sha256 === 'string' && /^[a-f0-9]{64}$/.test(pin.sha256), 'retained custody needs a file/digest pin');
  const file = realpathSync(resolve(checkout, pin.file)), local = relative(realpathSync(checkout), file);
  requirePin(local.startsWith('.temp/'), 'retained custody must stay in checkout .temp');
  const bytes = readFileSync(file);
  requirePin(createHash('sha256').update(bytes).digest('hex') === pin.sha256, 'retained custody digest differs');
  return bytes;
}
function retainedJson(pin: unknown, checkout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(retainedBytes(pin, checkout).toString('utf8'));
  requirePin(object(value), 'retained custody record is not an object');
  return value;
}

/** Reuse actual launch receipts and the existing stopped-backup qualification, never an rs alias. */
function assertLaunchCustody(manifest: Record<string, unknown>, execution: Record<string, unknown>, checkout: string): void {
  const custody = retainedJson(execution.retainedCustody, checkout);
  requirePin(custody.classification === 'retained-custody-qualified' && custody.sourceRunId === execution.fixtureGeneration
    && object(custody.backup) && Array.isArray(custody.retainedFiles), 'launch generation lacks qualified custody');
  const backupPin = custody.backup, files: unknown[] = custody.retainedFiles;
  for (const pin of files) retainedBytes(pin, checkout);
  const saved = (name: string) => {
    const pins = files.filter(pin => object(pin) && typeof pin.file === 'string'
      && pin.file.endsWith(`/attempts/${execution.fixtureGeneration}/${name}`));
    requirePin(pins.length === 1, `launch custody needs exactly one retained ${name}`);
    return { pin: pins[0] as AuditFilePin, value: retainedJson(pins[0], checkout) };
  };
  const original = saved('execution.json'), preparation = saved('preparation.json'), restore = saved('restore.json');
  const recorded = original.value, prepared = preparation.value, backup = retainedJson(backupPin, checkout);
  const binds = (path: unknown, file: unknown) => typeof path === 'string' && typeof file === 'string'
    && (path === file || path.endsWith(`/${file}`));
  requirePin(recorded.format === execution.format && recorded.productBaseline === auditBaseline
    && recorded.productRevision === execution.productRevision && recorded.fixtureGeneration === execution.fixtureGeneration
    && typeof recorded.testRevision === 'string' && commit.test(recorded.testRevision)
    && recorded.frontendRevision === execution.frontendRevision && typeof recorded.frontendRevision === 'string'
    && commit.test(recorded.frontendRevision) && recorded.assertionsReached === false,
  'launch original execution differs from product/frontend/generation pins');
  requirePin(prepared.sourceRunId === execution.fixtureGeneration && manifest.preparationQaRun === execution.fixtureGeneration
    && binds(prepared.execution, original.pin.file) && binds(prepared.backup, backupPin.file)
    && manifest.backup === backupPin.file && manifest.preparationMs === prepared.preparationMs
    && custody.preparationMs === prepared.preparationMs && typeof prepared.preparationMs === 'number'
    && Number.isFinite(prepared.preparationMs) && prepared.preparationMs > 0 && prepared.preparationMs <= auditPreparationBudgetMs,
  'launch preparation/run/backup binding differs');
  requirePin(backup.format === 'command-catalogue-backup-v1' && backup.runId === execution.fixtureGeneration
    && backup.project === backupPin.project && typeof backup.project === 'string'
    && backup.directory === dirname(String(prepared.backup)) && backupPin.stopped === true
    && backupPin.compatibleProduct === execution.productRevision && object(backup.compatibility)
    && backup.compatibility.digest === backupPin.compatibilityDigest && object(backup.compatibility.files)
    && backupPin.compatibilityFilesMatched === Object.keys(backup.compatibility.files).length
    && Array.isArray(backupPin.volumesPresent)
    && isDeepStrictEqual([...backupPin.volumesPresent].sort(),
      ['postgres_data', 'fuseki_data', 'rustfs_data'].map(kind => `${backup.project}_${kind}`).sort()),
  'launch stopped backup/product custody differs');
  const compatibility = backup.compatibility as unknown as LoadCompatibility;
  const current = loadCompatibility(checkout);
  requirePin(compatibility.digest === current.digest && compatibleLoadStorage(compatibility, current),
    'launch backup storage differs from pinned product');
  requirePin(Array.isArray(backupPin.objects) && backupPin.objects.length > 0, 'launch backup object custody is missing');
  for (const pin of backupPin.objects) {
    requirePin(object(pin) && pin.file === `${dirname(String(backupPin.file))}/objects/${pin.sha256}`,
      'launch backup object binding differs');
    retainedBytes(pin, checkout);
  }
  requirePin(restore.value.backup === prepared.backup && isDeepStrictEqual(custody.smokeRestore, restore.value)
    && object(restore.value.preparation) && typeof restore.value.preparation.totalMs === 'number'
    && Number.isFinite(restore.value.preparation.totalMs) && restore.value.preparation.totalMs > 0
    && restore.value.preparation.totalMs <= auditPreparationBudgetMs, 'launch isolated smoke custody differs');
}

/** Stack-free admission only. Storage compatibility, stopped backup custody and
 * isolated restore checks remain with their existing producer/consumer owners. */
export function assertAuditExecution(manifest: unknown, options: AuditExecutionOptions = {}): AuditExecutionMetadata {
  requirePin(object(manifest) && object(manifest.execution), 'metadata is missing');
  const execution = manifest.execution;
  requirePin(execution.format === 'audit-execution-v1', 'metadata format differs');
  requirePin(execution.productBaseline === auditBaseline, 'historical product baseline differs');
  requirePin(typeof execution.productRevision === 'string' && commit.test(execution.productRevision), 'product revision must be a full commit');
  requirePin(typeof execution.testRevision === 'string' && commit.test(execution.testRevision), 'test revision must be a full commit');
  requirePin(typeof execution.fixtureGeneration === 'string'
    && (generation.test(execution.fixtureGeneration) || launchGeneration.test(execution.fixtureGeneration)),
  'fixture generation must be a retained source key or qualified launch run');
  const environment = options.environment ?? process.env;
  for (const [field, variable] of [
    ['productRevision', 'REZICS_AUDIT_PRODUCT_REVISION'],
    ['testRevision', 'REZICS_AUDIT_TEST_REVISION'],
    ['fixtureGeneration', 'REZICS_AUDIT_FIXTURE_GENERATION'],
  ] as const) requirePin(environment[variable] === execution[field], `${variable} must explicitly match ${field}`);
  if (execution.frontendRevision !== undefined) {
    requirePin(typeof execution.frontendRevision === 'string' && commit.test(execution.frontendRevision), 'frontend revision must be a full commit');
    requirePin(environment.REZICS_AUDIT_FRONTEND_REVISION === execution.frontendRevision,
      'REZICS_AUDIT_FRONTEND_REVISION must explicitly match frontendRevision');
  }
  for (const field of ['productBaseline', 'productRevision', 'fixtureGeneration'] as const) {
    if (options[field] !== undefined) requirePin(options[field] === execution[field], `manifest ${field} differs`);
  }

  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: options.checkout ?? process.cwd(), encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      throw new Error('TEST PREMISE: audit execution Git identity cannot be resolved; no product assertion reached', { cause });
    }
  };
  for (const revision of [execution.productRevision, execution.testRevision,
    ...(execution.frontendRevision ? [execution.frontendRevision as string] : [])]) {
    requirePin(git('rev-parse', '--verify', `${revision}^{commit}`).trim() === revision, 'revision is not the nominated commit object');
  }
  requirePin(git('rev-parse', 'HEAD').trim() === execution.testRevision, 'checkout differs from test revision');
  requirePin(!git('status', '--porcelain', '--untracked-files=all').trim(), 'checkout has uncommitted files');
  // The product may be pinned before independently authored proof/support commits.
  // Any other difference would silently run a different product than the pin.
  const overlay = (path: string) => /^(?:docs\/|tests\/qa\/|scripts\/qa\/|scripts\/goal\/|\.agents\/)/.test(path)
    || path === 'AGENTS.md' || path === 'GOAL.md';
  const productChanges = git('diff', '--name-only', '-z', execution.productRevision, execution.testRevision, '--')
    .split('\0').filter(path => path && !overlay(path));
  requirePin(productChanges.length === 0, `product tree differs outside proof/support overlays: ${productChanges.join(', ')}`);
  if (launchGeneration.test(execution.fixtureGeneration)) {
    assertLaunchCustody(manifest, execution, options.checkout ?? process.cwd());
  } else requirePin(execution.retainedCustody === undefined, 'rs source key cannot substitute for a launch generation');
  return { format: 'audit-execution-v1', productBaseline: auditBaseline,
    productRevision: execution.productRevision, testRevision: execution.testRevision,
    fixtureGeneration: execution.fixtureGeneration,
    ...(execution.frontendRevision !== undefined ? { frontendRevision: execution.frontendRevision as string } : {}),
    ...(execution.retainedCustody !== undefined ? { retainedCustody: execution.retainedCustody as AuditFilePin } : {}) };
}
