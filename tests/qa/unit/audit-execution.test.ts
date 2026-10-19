import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  mkdirSync(join(checkout, 'services'));
  mkdirSync(join(checkout, 'tests/qa/support'), { recursive: true });
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
