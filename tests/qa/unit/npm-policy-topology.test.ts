import { expect, test } from 'bun:test';
import { validateNpmPolicySnapshot } from '../../../services/main/src/modules/package/npm-composition.ts';
import { npmPolicyFixture } from '../fixtures/npm-policy-snapshot.ts';

test('PKG04/PKG12: an exact root override and engine target bind one immutable virtual-tree result', () => {
  const request = npmPolicyFixture();
  const result = validateNpmPolicySnapshot(request);
  expect(result.status).toBe('validated');
  expect(result.overrideSelections).toContainEqual({ fromPath: 'node_modules/renamed',
    toPath: 'node_modules/leaf', name: 'leaf', declaredSpecifier: '1.0.0', effectiveSpecifier: '2.0.0' });
  expect(result.engineChecks).toContainEqual({ path: 'node_modules/leaf',
    node: '>=20.0.0', npm: '>=11.0.0', compatible: true });
  expect(result.instances.find(node => node.path === 'node_modules/leaf')?.version).toBe('2.0.0');
  expect(result.lockId).not.toBe(validateNpmPolicySnapshot({ ...request,
    engineTarget: { ...request.engineTarget, nodeVersion: '27.0.0' } }).lockId);
});

test('PKG04/PKG13: incompatible engines and missing provenance never become validated', () => {
  const incompatible = validateNpmPolicySnapshot(npmPolicyFixture('engine-incompatible'));
  expect(incompatible.status).toBe('invalid-topology');
  expect(incompatible.issues.some(issue => issue.kind === 'engine-incompatible')).toBe(true);
  const missing = validateNpmPolicySnapshot(npmPolicyFixture('missing-provenance'));
  expect(missing.status).toBe('incomplete-source-data');
  expect(missing.issues.some(issue => issue.kind === 'missing-provenance')).toBe(true);
  for (const kind of ['nested-override', 'direct-conflict'] as const) {
    const unsupported = validateNpmPolicySnapshot(npmPolicyFixture(kind));
    expect(unsupported.status).toBe('unsupported-semantics');
    expect(unsupported.instances).toEqual([]);
  }
});

test('PKG04/PKG13: absent and malformed policy rules cannot manufacture a valid override', () => {
  const absent = validateNpmPolicySnapshot(npmPolicyFixture('absent-override'));
  expect(absent.status).toBe('invalid-topology');
  expect(absent.overrideSelections).toEqual([]);
  expect(() => validateNpmPolicySnapshot(npmPolicyFixture('malformed-override')))
    .toThrow('malformed npm root override value');
  for (const kind of ['range-override', 'override-budget', 'engine-range'] as const) {
    const result = validateNpmPolicySnapshot(npmPolicyFixture(kind));
    expect(result.status).not.toBe('validated');
    expect(result.instances).toEqual([]);
    expect(result.edges).toEqual([]);
  }
  expect(validateNpmPolicySnapshot({ ...npmPolicyFixture(),
    engineTarget: { nodeVersion: '26.x', npmVersion: '11.19.1' } }).status)
    .toBe('unsupported-semantics');
});
