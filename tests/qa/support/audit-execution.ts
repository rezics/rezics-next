import { execFileSync } from 'node:child_process';
import { auditBaseline } from '../fixtures/audit-corpus-contract.ts';

/** Execution custody added by the shared producer, never by assertion templates.
 * The historical baseline and frozen source snapshots retain their own identities. */
export interface AuditExecutionMetadata {
  format: 'audit-execution-v1';
  productBaseline: typeof auditBaseline;
  productRevision: string;
  testRevision: string;
  fixtureGeneration: string;
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
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requirePin(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`TEST PREMISE: audit execution ${detail}; no product assertion reached`);
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
  requirePin(typeof execution.fixtureGeneration === 'string' && generation.test(execution.fixtureGeneration), 'fixture generation must be a retained source key');
  const environment = options.environment ?? process.env;
  for (const [field, variable] of [
    ['productRevision', 'REZICS_AUDIT_PRODUCT_REVISION'],
    ['testRevision', 'REZICS_AUDIT_TEST_REVISION'],
    ['fixtureGeneration', 'REZICS_AUDIT_FIXTURE_GENERATION'],
  ] as const) requirePin(environment[variable] === execution[field], `${variable} must explicitly match ${field}`);
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
  for (const revision of [execution.productRevision, execution.testRevision]) {
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
  return { format: 'audit-execution-v1', productBaseline: auditBaseline,
    productRevision: execution.productRevision, testRevision: execution.testRevision,
    fixtureGeneration: execution.fixtureGeneration };
}
