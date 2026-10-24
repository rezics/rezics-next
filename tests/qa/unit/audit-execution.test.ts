import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import { auditBaseline } from '../fixtures/audit-corpus-contract.ts';
import { assertAuditExecution, type AuditExecutionMetadata } from '../support/audit-execution.ts';

let checkout: string, productRevision: string, testRevision: string, otherProduct: string;
const fixtureGeneration = `rs-audit-corpus-${'a'.repeat(64)}`;
const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitFile(path: string, content: string) {
  writeFileSync(join(checkout, path), content);
  git('add', path);
  git('-c', 'user.name=Audit execution unit', '-c', 'user.email=audit-execution@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-m', path);
  return git('rev-parse', 'HEAD');
}
beforeAll(() => {
  mkdirSync(resolve('.temp'), { recursive: true });
  checkout = mkdtempSync(resolve('.temp/audit-execution-unit-'));
  git('init', '--quiet');
  writeFileSync(join(checkout, '.git/info/exclude'), '.temp/\n');
  mkdirSync(join(checkout, 'services'));
  mkdirSync(join(checkout, 'tests/qa/support'), { recursive: true });
  for (const path of ['generated/model/manifest.json', 'infra/dev/compose.yaml', 'infra/jena/fuseki-text.ttl',
    'infra/jena/fuseki-text-qa.ttl', 'services/account/package.json']) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), 'unit storage compatibility input\n');
    git('add', path);
  }
  for (const path of ['services/account/migrations', 'services/content/migrations',
    'services/main/migrations/access', 'services/main/migrations/relay']) mkdirSync(join(checkout, path), { recursive: true });
  otherProduct = commitFile('services/product.ts', 'export const repaired = false;\n');
  productRevision = commitFile('services/product.ts', 'export const repaired = true;\n');
  testRevision = commitFile('tests/qa/support/proof.ts', 'export const originalAssertions = true;\n');
});
afterAll(() => { if (checkout) rmSync(checkout, { recursive: true, force: true }); });

function fixture(changes: Partial<AuditExecutionMetadata> = {}) {
  const execution: AuditExecutionMetadata = { format: 'audit-execution-v1', productBaseline: auditBaseline,
    productRevision, testRevision, fixtureGeneration, ...changes };
  return { execution };
}
const environment = () => ({ REZICS_AUDIT_PRODUCT_REVISION: productRevision,
  REZICS_AUDIT_TEST_REVISION: testRevision, REZICS_AUDIT_FIXTURE_GENERATION: fixtureGeneration });

test('a pinned repaired product admits committed independent support without advancing the historical baseline', () => {
  const manifest = fixture();
  expect(productRevision).not.toBe(auditBaseline);
  expect(testRevision).not.toBe(productRevision);
  expect(assertAuditExecution(manifest, { checkout, environment: environment() })).toEqual(manifest.execution);
});

test('product and test may be pinned to the same repaired commit', () => {
  expect(assertAuditExecution(fixture({ productRevision: testRevision }), { checkout,
    environment: { ...environment(), REZICS_AUDIT_PRODUCT_REVISION: testRevision } }).productRevision).toBe(testRevision);
});

test('missing metadata and missing explicit pins cannot reuse a historical manifest silently', () => {
  expect(() => assertAuditExecution({}, { checkout, environment: environment() })).toThrow('metadata is missing');
  expect(() => assertAuditExecution(fixture(), { checkout, environment: {} })).toThrow('REZICS_AUDIT_PRODUCT_REVISION');
});

test('historical baseline, product, test and fixture identities cannot substitute for one another', () => {
  expect(() => assertAuditExecution(fixture({ productBaseline: productRevision as typeof auditBaseline }),
    { checkout, environment: environment() })).toThrow('historical product baseline differs');
  for (const field of ['productRevision', 'testRevision', 'fixtureGeneration'] as const) {
    const value = field === 'fixtureGeneration' ? `rs-audit-corpus-${'b'.repeat(64)}` : otherProduct;
    expect(() => assertAuditExecution(fixture({ [field]: value }), { checkout, environment: environment() }))
      .toThrow('must explicitly match');
  }
});

test('an explicitly nominated commit must exist and the checkout must match the test pin', () => {
  expect(() => assertAuditExecution(fixture({ productRevision: 'f'.repeat(40) }), { checkout,
    environment: { ...environment(), REZICS_AUDIT_PRODUCT_REVISION: 'f'.repeat(40) } })).toThrow('cannot be resolved');
  expect(() => assertAuditExecution(fixture({ testRevision: productRevision }), { checkout,
    environment: { ...environment(), REZICS_AUDIT_TEST_REVISION: productRevision } })).toThrow('checkout differs');
});

test('an earlier product pin cannot admit later product changes as a test overlay', () => {
  expect(() => assertAuditExecution(fixture({ productRevision: otherProduct }), { checkout,
    environment: { ...environment(), REZICS_AUDIT_PRODUCT_REVISION: otherProduct } })).toThrow('product tree differs');
});

test('existing manifest aliases must agree with the separate execution identities', () => {
  expect(() => assertAuditExecution(fixture(), { checkout, environment: environment(),
    productRevision: otherProduct })).toThrow('manifest productRevision differs');
  expect(() => assertAuditExecution(fixture(), { checkout, environment: environment(),
    fixtureGeneration: `rs-audit-corpus-${'c'.repeat(64)}` })).toThrow('manifest fixtureGeneration differs');
});

test('uncommitted test changes cannot masquerade as the nominated test revision', () => {
  const path = join(checkout, 'tests/qa/support/proof.ts');
  try {
    writeFileSync(path, 'export const changedAssertions = true;\n');
    expect(() => assertAuditExecution(fixture(), { checkout, environment: environment() })).toThrow('uncommitted files');
  } finally { git('restore', 'tests/qa/support/proof.ts'); }
});

test('untracked product files cannot evade revision validation', () => {
  const path = join(checkout, 'services/untracked.ts');
  try {
    writeFileSync(path, 'export const untracked = true;\n');
    expect(() => assertAuditExecution(fixture(), { checkout, environment: environment() })).toThrow('uncommitted files');
  } finally { rmSync(path); }
});

// Synthetic launch evidence exercises metadata admission only, never product readiness.
function launchFixture() {
  const launch = 'recipes-build-unit-abcdef';
  mkdirSync(join(checkout, '.temp'), { recursive: true });
  const root = relative(checkout, mkdtempSync(join(checkout, '.temp/launch-unit-')));
  const attempt = `${root}/attempts/${launch}`, backupFile = `${root}/backups/launch-unit/backup.json`;
  const pin = (file: string, value: unknown) => {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    const bytes = JSON.stringify(value) + '\n';
    writeFileSync(join(checkout, file), bytes);
    return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const compatibility = loadCompatibility(checkout);
  const project = `rezics-catalogue-work-profile-${launch}-launch-unit-${compatibility.digest.slice(0, 16)}`;
  const backup = { format: 'command-catalogue-backup-v1', project, runId: launch,
    directory: dirname(join(checkout, backupFile)), compatibility, preparationMs: 100 };
  const recorded = { ...fixture().execution, testRevision: productRevision, fixtureGeneration: launch,
    frontendRevision: productRevision, preparationStartedAt: '2026-10-19T07:55:42.712Z', assertionsReached: false };
  const prepared = { sourceRunId: launch, backup: join(checkout, backupFile), preparationMs: 1500,
    execution: join(checkout, attempt, 'execution.json'), assertionsReached: false,
    pending: ['unit original-topology backup intentionally absent'] };
  const restore = { backup: prepared.backup, target: `unit-smoke-${launch}`, preparation: { totalMs: 2000 } };
  const body = 'unit body object', objectDigest = createHash('sha256').update(body).digest('hex');
  const objectPin = { file: `${dirname(backupFile)}/objects/${objectDigest}`, sha256: objectDigest };
  mkdirSync(dirname(join(checkout, objectPin.file)), { recursive: true });
  writeFileSync(join(checkout, objectPin.file), body);
  const custody = { classification: 'retained-custody-qualified', readyPublicDomainManifest: false,
    assertionsReached: false, sourceRunId: launch, preparationMs: prepared.preparationMs,
    backup: { ...pin(backupFile, backup), project, stopped: true,
      volumesPresent: ['postgres_data', 'fuseki_data', 'rustfs_data'].map(kind => `${project}_${kind}`),
      objects: [objectPin], compatibilityDigest: compatibility.digest, compatibleProduct: productRevision,
      compatibilityFilesMatched: Object.keys(compatibility.files).length },
    retainedFiles: [pin(`${attempt}/execution.json`, recorded), pin(`${attempt}/preparation.json`, prepared),
      pin(`${attempt}/restore.json`, restore)], smokeRestore: restore };
  const manifest = { ...fixture({ fixtureGeneration: launch, frontendRevision: productRevision }),
    preparationQaRun: launch, preparationMs: prepared.preparationMs, backup: backupFile };
  const persist = () => {
    custody.backup.sha256 = pin(backupFile, backup).sha256;
    custody.retainedFiles = [pin(`${attempt}/execution.json`, recorded), pin(`${attempt}/preparation.json`, prepared),
      pin(`${attempt}/restore.json`, restore)];
    manifest.execution.retainedCustody = pin(`${root}/custody.json`, custody);
  };
  persist();
  return { manifest, recorded, prepared, restore, backup, custody, persist, objectPin,
    original: join(checkout, attempt, 'execution.json'),
    environment: { ...environment(), REZICS_AUDIT_FIXTURE_GENERATION: launch,
      REZICS_AUDIT_FRONTEND_REVISION: productRevision } };
}

test('actual launch custody admits a separate proof overlay without rewriting original execution or requiring rs topology', () => {
  const unit = launchFixture(), before = readFileSync(unit.original);
  expect(assertAuditExecution(unit.manifest, { checkout, environment: unit.environment })).toEqual(unit.manifest.execution);
  expect(unit.recorded.testRevision).toBe(productRevision);
  expect(unit.manifest.execution.testRevision).toBe(testRevision);
  expect(readFileSync(unit.original)).toEqual(before);
  expect(unit.custody.readyPublicDomainManifest).toBe(false);
});

test('an unbound launch name or arbitrary generation cannot declare successful execution', () => {
  for (const value of ['recipes-build-unit-abcdef', 'adhoc-ready', 'rs-not-a-digest']) {
    expect(() => assertAuditExecution(fixture({ fixtureGeneration: value }), { checkout,
      environment: { ...environment(), REZICS_AUDIT_FIXTURE_GENERATION: value } })).toThrow('TEST PREMISE');
  }
  const unit = launchFixture();
  unit.manifest.execution.fixtureGeneration = fixtureGeneration;
  expect(() => assertAuditExecution(unit.manifest, { checkout,
    environment: { ...unit.environment, REZICS_AUDIT_FIXTURE_GENERATION: fixtureGeneration } }))
    .toThrow('rs source key cannot substitute');
});

test('frontend has its own explicit pin and must match the retained execution', () => {
  const unit = launchFixture();
  expect(() => assertAuditExecution(unit.manifest, { checkout, environment: environment() }))
    .toThrow('must explicitly match fixtureGeneration');
  expect(() => assertAuditExecution(unit.manifest, { checkout,
    environment: { ...unit.environment, REZICS_AUDIT_FRONTEND_REVISION: undefined } })).toThrow('FRONTEND_REVISION');
  unit.manifest.execution.frontendRevision = otherProduct;
  expect(() => assertAuditExecution(unit.manifest, { checkout,
    environment: { ...unit.environment, REZICS_AUDIT_FRONTEND_REVISION: otherProduct } })).toThrow('original execution differs');
});

for (const kind of ['source-run', 'original-product', 'original-generation', 'preparation-run', 'manifest-backup',
  'execution-path', 'over-budget', 'backup-run', 'running-backup', 'missing-volume', 'bound-product',
  'storage-input', 'no-objects', 'smoke-backup', 'smoke-budget'] as const) {
  test(`qualified launch still refuses ${kind} tampering even with recomputed file pins`, () => {
    const unit = launchFixture();
    if (kind === 'source-run') unit.custody.sourceRunId = 'recipes-build-other-abcdef';
    else if (kind === 'original-product') unit.recorded.productRevision = otherProduct;
    else if (kind === 'original-generation') unit.recorded.fixtureGeneration = 'recipes-build-other-abcdef';
    else if (kind === 'preparation-run') unit.prepared.sourceRunId = 'recipes-build-other-abcdef';
    else if (kind === 'manifest-backup') unit.manifest.backup += '.other';
    else if (kind === 'execution-path') unit.prepared.execution += '.other';
    else if (kind === 'over-budget') {
      unit.prepared.preparationMs = unit.manifest.preparationMs = unit.custody.preparationMs = 600_001;
    } else if (kind === 'backup-run') unit.backup.runId = 'recipes-build-other-abcdef';
    else if (kind === 'running-backup') unit.custody.backup.stopped = false;
    else if (kind === 'missing-volume') unit.custody.backup.volumesPresent.pop();
    else if (kind === 'bound-product') unit.custody.backup.compatibleProduct = otherProduct;
    else if (kind === 'storage-input') unit.backup.compatibility.files['generated/model/manifest.json'] = '0'.repeat(64);
    else if (kind === 'no-objects') unit.custody.backup.objects = [];
    else if (kind === 'smoke-backup') unit.restore.backup += '.other';
    else unit.restore.preparation.totalMs = 600_001;
    unit.persist();
    expect(() => assertAuditExecution(unit.manifest, { checkout, environment: unit.environment })).toThrow('TEST PREMISE');
  });
}

test('retained custody and object bytes cannot be changed behind their pins', () => {
  const unit = launchFixture();
  writeFileSync(join(checkout, unit.objectPin.file), 'tampered object');
  expect(() => assertAuditExecution(unit.manifest, { checkout, environment: unit.environment })).toThrow('digest differs');
  const other = launchFixture();
  writeFileSync(other.original, '{}');
  expect(() => assertAuditExecution(other.manifest, { checkout, environment: other.environment })).toThrow('digest differs');
  const last = launchFixture();
  writeFileSync(join(checkout, last.manifest.execution.retainedCustody!.file), '{}');
  expect(() => assertAuditExecution(last.manifest, { checkout, environment: last.environment })).toThrow('digest differs');
});

test('a ready flag cannot replace retained execution/preparation/restore receipts', () => {
  const unit = launchFixture();
  unit.custody.retainedFiles.pop();
  const bytes = JSON.stringify({ ...unit.custody, readyPublicDomainManifest: true });
  writeFileSync(join(checkout, unit.manifest.execution.retainedCustody!.file), bytes);
  unit.manifest.execution.retainedCustody!.sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(() => assertAuditExecution(unit.manifest, { checkout, environment: unit.environment })).toThrow('retained restore.json');
});
