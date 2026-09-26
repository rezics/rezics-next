import { expect, test } from 'bun:test';
import { NpmResolutionInvalid, validateNpmSnapshot } from '../../../services/main/src/modules/package/npm-lock.ts';
import { validateNpmPlatformSnapshot as validate, type NpmPlatformRequest } from '../../../services/main/src/modules/package/npm-platform.ts';
import { npmBytes, npmPackage, npmRequest, type NpmFixturePackage } from '../fixtures/npm-lock-snapshot.ts';
import { npmPlatformDocuments, npmPlatformFixture, npmPlatformRequest, npmTargets } from '../fixtures/npm-platform-snapshot.ts';

const activePaths = (request: NpmPlatformRequest) => {
  const result = validate(request);
  expect(result.status).toBe('validated');
  return result.instances.filter(node => result.activeInstances.includes(node.id)).map(node => node.path);
};
test('PKG04/PKG12: declared npm targets retain the complete lock and exact optional omission evidence', () => {
  const linux = validate(npmPlatformFixture());
  const windows = validate(npmPlatformFixture('platform-branch', npmTargets[1]));
  expect(linux.status).toBe('validated'); expect(windows.status).toBe('validated');
  expect(linux.instances.map(node => node.path)).toEqual(windows.instances.map(node => node.path));
  expect(linux.lockId).not.toBe(windows.lockId);
  expect(linux.instances[0]!.id).not.toBe(windows.instances[0]!.id);
  expect(linux.omittedInstances.map(node => [node.path, node.causePath])).toEqual([
    ['node_modules/helper', 'node_modules/helper']]);
  expect(windows.omittedInstances.map(node => [node.path, node.causePath])).toEqual([
    ['node_modules/addon', 'node_modules/addon'], ['node_modules/leaf', 'node_modules/addon']]);
  expect(windows.activeInstances).toContain(windows.instances.find(node => node.name === 'shared')!.id);
  for (const result of [linux, windows]) {
    expect(result.omittedEdges).toContainEqual(expect.objectContaining({ path: 'node_modules/core',
      name: 'ghost', kind: 'peer', optional: true, to: null, foundPath: null, reason: 'absent-optional' }));
    expect(result.edges.every(edge => result.instances.some(node => node.id === edge.to))).toBe(true);
    expect(result.instances.find(node => node.name === 'addon')).toMatchObject({ optional: true, os: ['linux'], cpu: ['x64'] });
    expect(result.instances.find(node => node.name === 'shared')!.optional).toBe(false);
  }
  expect(activePaths(npmPlatformFixture('platform-branch', npmTargets[2]))).not.toContain('node_modules/addon');
  const request = npmPlatformFixture();
  const changed = { ...request, lock: npmBytes(Buffer.from(request.lock.bytesBase64, 'base64').toString() + '\n') };
  expect(validate(changed).lockId).not.toBe(linux.lockId);
  expect(validate(request)).toEqual(linux);
});

test('PKG04: an incompatible optional child prunes its required ancestors but preserves external dependents', () => {
  for (const kind of ['optional-child-platform', 'optional-cycle'] as const) {
    const result = validate(npmPlatformFixture(kind, npmTargets[1]));
    expect(result.status).toBe('validated');
    expect(result.omittedInstances.map(node => [node.path, node.causePath])).toEqual([
      ['node_modules/addon', 'node_modules/leaf'], ['node_modules/leaf', 'node_modules/leaf']]);
  }
  const shared = npmPlatformFixture('shared-optional', npmTargets[1]);
  expect(activePaths(shared)).toContain('node_modules/leaf');
  expect(activePaths(shared)).toContain('node_modules/other');
  expect(validate(shared).omittedInstances.map(node => node.path)).toEqual(['node_modules/addon']);
});

test('PKG04/PKG13: optional absence is distinct from missing required sources and incompatible required platforms', () => {
  const missingOptional = validate(npmPlatformFixture('optional-missing'));
  expect(missingOptional.status).toBe('validated');
  expect(missingOptional.omittedEdges).toContainEqual(expect.objectContaining({ name: 'absent', reason: 'absent-optional' }));
  for (const request of [npmPlatformFixture('required-missing', npmTargets[1]),
    npmPlatformFixture('shared-platform-required', npmTargets[1])]) {
    const result = validate(request);
    expect(result.status).toBe(request.lock.sha256 === npmPlatformFixture('required-missing').lock.sha256
      ? 'incomplete-source-data' : 'invalid-topology');
    for (const field of ['instances', 'edges', 'activeInstances', 'activeEdges', 'omittedInstances', 'omittedEdges'] as const) {
      expect(result[field]).toEqual([]);
    }
  }
  const docs = npmPlatformDocuments();
  delete docs.lock.packages['node_modules/addon']!.integrity;
  expect(validate(npmPlatformRequest(docs.manifest, docs.lock, npmTargets[1])))
    .toMatchObject({ status: 'incomplete-source-data', issues: [{ kind: 'missing-provenance', path: 'node_modules/addon' }] });
  docs.lock.packages['node_modules/addon']!.integrity = npmPackage('addon', '1.0.0').integrity;
  delete docs.lock.packages['node_modules/leaf'];
  expect(validate(npmPlatformRequest(docs.manifest, docs.lock, npmTargets[1])))
    .toMatchObject({ status: 'incomplete-source-data', issues: [{ kind: 'missing-dependency', path: 'node_modules/addon' }] });
});

test('PKG04: optional peers permit absence but retain exact hosts, shadowing and child-local errors', () => {
  const host = validate(npmPlatformFixture('optional-peer-host'));
  const shared = host.instances.find(node => node.name === 'shared')!;
  expect(host.instances.find(node => node.name === 'core')!.peerHosts).toEqual([
    { name: 'shared', specifier: '1.0.0', optional: true, host: shared.id, path: shared.path }]);
  for (const kind of ['required-peer-shadow', 'optional-peer-shadow'] as const) {
    const result = validate(npmPlatformFixture(kind));
    expect(result).toMatchObject({ status: 'invalid-topology', issues: [{ kind: 'version-mismatch',
      path: 'node_modules/left/node_modules/plugin', foundPath: 'node_modules/left/node_modules/shared' }] });
  }
  const docs = npmPlatformDocuments('optional-peer-host');
  docs.lock.packages['node_modules/core/node_modules/shared'] = npmPackage('shared', '1.0.0');
  expect(validate(npmPlatformRequest(docs.manifest, docs.lock))).toMatchObject({ status: 'invalid-topology',
    issues: [{ kind: 'peer-local', path: 'node_modules/core', foundPath: 'node_modules/core/node_modules/shared' }] });
});

test('PKG04: optional flags cannot conceal required nodes or invent optional eligibility', () => {
  for (const [path, value] of [['node_modules/shared', true], ['node_modules/addon', false]] as const) {
    const docs = npmPlatformDocuments(); docs.lock.packages[path]!.optional = value;
    expect(validate(npmPlatformRequest(docs.manifest, docs.lock, npmTargets[1])))
      .toMatchObject({ status: 'invalid-topology', issues: [{ kind: 'optional-flag-mismatch', path }] });
  }
});

test('PKG12: unknown targets and semantic clauses stay unsupported, malformed selectors are rejected', () => {
  const request = npmPlatformFixture();
  for (const change of [{ target: { os: 'darwin', cpu: 'x64' } }, { target: { os: 'linux', cpu: 'mips' } },
    { policy: 'legacy-peers' }, { npmVersion: '12.0.0' }]) {
    expect(validate({ ...request, ...change })).toMatchObject({ status: 'unsupported-semantics', instances: [] });
  }
  for (const target of [null, {}, { os: 'linux' }, { os: 1, cpu: 'x64' }, { os: 'linux', cpu: 'x64', libc: 'glibc' }]) {
    expect(() => validate({ ...request, target } as NpmPlatformRequest)).toThrow(NpmResolutionInvalid);
  }
  for (const field of ['os', 'cpu'] as const) {
    for (const value of [null, 1, {}, [1], [''], ['!'], ['!!linux'], ['linux || win32']]) {
      const docs = npmPlatformDocuments(); docs.lock.packages['node_modules/addon']![field] = value;
      expect(() => validate(npmPlatformRequest(docs.manifest, docs.lock))).toThrow(NpmResolutionInvalid);
    }
    const docs = npmPlatformDocuments(); docs.lock.packages['node_modules/addon']![field] = ['future'];
    expect(validate(npmPlatformRequest(docs.manifest, docs.lock)).status).toBe('unsupported-semantics');
  }
  for (const [field, value] of Object.entries({ name: 'alias', workspaces: [], overrides: {}, engines: {}, libc: ['glibc'],
    dev: false, link: true, hasInstallScript: true })) {
    const docs = npmPlatformDocuments(); docs.lock.packages['node_modules/addon']![field] = value;
    expect(validate(npmPlatformRequest(docs.manifest, docs.lock, npmTargets[1])).status).toBe('unsupported-semantics');
  }
  const docs = npmPlatformDocuments();
  docs.lock.packages['node_modules/addon']!.dependencies!.leaf = 'npm:leaf@1.0.0';
  expect(validate(npmPlatformRequest(docs.manifest, docs.lock)).status).toBe('unsupported-semantics');
  const v1 = npmRequest(npmPlatformDocuments().manifest, npmPlatformDocuments().lock);
  expect(validateNpmSnapshot(v1).status).toBe('unsupported-semantics');
});

test('PKG04/PKG12: selector exclusions win and absent/empty metadata keeps precise meaning', () => {
  expect(activePaths(npmPlatformFixture('selectors'))).toContain('node_modules/addon');
  expect(activePaths(npmPlatformFixture('selectors', npmTargets[1]))).not.toContain('node_modules/addon');
  expect(activePaths(npmPlatformFixture('selectors', npmTargets[2]))).not.toContain('node_modules/addon');
  for (const os of [[], ['any'], 'linux', ['!win32'], ['linux', '!linux']]) {
    const docs = npmPlatformDocuments(); docs.lock.packages['node_modules/addon']!.os = os;
    const result = validate(npmPlatformRequest(docs.manifest, docs.lock));
    expect(result.status).toBe('validated');
    expect(result.omittedInstances.some(node => node.path === 'node_modules/addon'))
      .toBe(Array.isArray(os) && os.includes('!linux'));
  }
  for (const [field, value] of Object.entries({ os: ['linux'], optionalDependencies: { addon: '2.0.0' },
    peerDependenciesMeta: { missing: { optional: true } } })) {
    const docs = npmPlatformDocuments(); docs.lock.packages[''] = { ...docs.lock.packages['']!, [field]: value };
    expect(() => validate(npmPlatformRequest(docs.manifest, docs.lock))).toThrow(NpmResolutionInvalid);
  }
  for (const value of [{ ghost: { optional: 'yes' } }, { unknown: { optional: true } }]) {
    const docs = npmPlatformDocuments(); docs.lock.packages['node_modules/core']!.peerDependenciesMeta = value;
    expect(() => validate(npmPlatformRequest(docs.manifest, docs.lock))).toThrow(NpmResolutionInvalid);
  }
  const docs = npmPlatformDocuments();
  const malformedManifest = { ...docs.manifest, os: null };
  expect(() => validate(npmPlatformRequest(malformedManifest, docs.lock))).toThrow(NpmResolutionInvalid);
});

test('PKG13: target graph work, bytes, nodes, edges, selectors and ancestor traversal are bounded', () => {
  for (const size of [8, 32, 128, 129]) {
    const manifest: NpmFixturePackage = { name: 'scale', version: '1.0.0', optionalDependencies: {} };
    const packages: Record<string, NpmFixturePackage> = { '': manifest };
    for (let i = 0; i < size; i++) {
      (manifest.optionalDependencies as Record<string, string>)[`p${i}`] = '1.0.0';
      packages[`node_modules/p${i}`] = { ...npmPackage(`p${i}`, '1.0.0'), optional: true, os: ['win32'] };
    }
    const result = validate(npmPlatformRequest(manifest, { name: manifest.name, version: manifest.version,
      lockfileVersion: 3, packages }));
    expect(result.status).toBe(size > 128 ? 'budget-exhausted' : 'validated');
    if (size <= 128) {
      expect(result.cost.ancestorLookups).toBe(size);
      expect(result.cost.graphVisits).toBeLessThanOrEqual(10 * size + 8);
      expect(result.activeInstances).toHaveLength(1);
      expect(result.omittedInstances).toHaveLength(size);
    }
  }
  const request = npmPlatformFixture();
  expect(validate({ ...request, lock: npmBytes(' '.repeat(65_536) + '{}') }))
    .toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm raw file byte limit', instances: [] });
  expect(validate(npmPlatformRequest('['.repeat(34) + '0' + ']'.repeat(34), '{}')).status).toBe('budget-exhausted');
  for (const modify of [
    (packages: Record<string, NpmFixturePackage>) => { packages['node_modules/addon']!.os = Array(17).fill('linux'); },
    (packages: Record<string, NpmFixturePackage>) => { packages['node_modules/addon']!.dependencies =
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`p${i}`, '1.0.0'])); },
    (packages: Record<string, NpmFixturePackage>) => { packages[Array(17).fill('node_modules/deep').join('/')] = npmPackage('deep', '1.0.0'); },
  ]) {
    const docs = npmPlatformDocuments(); modify(docs.lock.packages);
    expect(validate(npmPlatformRequest(docs.manifest, docs.lock))).toMatchObject({ status: 'budget-exhausted', instances: [], omittedInstances: [] });
  }
  const manifest: NpmFixturePackage = { name: 'deep', version: '1.0.0' };
  const packages: Record<string, NpmFixturePackage> = { '': manifest };
  let path = '';
  for (let depth = 1; depth <= 16; depth++) {
    path += `${path ? '/' : ''}node_modules/a`;
    packages[path] = { ...npmPackage('a', '1.0.0'), ...(depth < 16 ? {} : {
      optionalDependencies: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p${i}`, '1.0.0'])) }) };
  }
  expect(validate(npmPlatformRequest(manifest, { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages })))
    .toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm ancestor lookup limit', cost: { ancestorLookups: 4097 }, instances: [] });
});
