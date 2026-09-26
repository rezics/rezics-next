import { expect, test } from 'bun:test';
import { NpmResolutionInvalid, validateNpmSnapshot } from '../../../services/main/src/modules/package/npm-lock.ts';
import { npmBytes, npmDocuments, npmFixture, npmPackage, npmRequest } from '../fixtures/npm-lock-snapshot.ts';

test('PKG03/PKG12/PKG13: nested npm slots and exact peer environments remain distinct', () => {
  const request = npmFixture();
  const outcome = validateNpmSnapshot(request);
  expect(outcome.status).toBe('validated');
  expect(outcome.instances.filter(node => node.name === 'shared').map(node => node.version)).toEqual(['1.0.0', '2.0.0']);
  for (const side of ['left', 'right']) {
    const host = outcome.instances.find(node => node.path === `node_modules/${side}/node_modules/shared`)!;
    const plugin = outcome.instances.find(node => node.path === `node_modules/${side}/node_modules/plugin`)!;
    expect(plugin.peerHosts).toEqual([{ name: 'shared', specifier: host.version, host: host.id, path: host.path }]);
  }
  const same = validateNpmSnapshot(npmFixture('same-artifact-hosts'));
  const plugins = same.instances.filter(node => node.name === 'plugin');
  expect(plugins[0]!.resolved).toBe(plugins[1]!.resolved);
  expect(plugins[0]!.integrity).toBe(plugins[1]!.integrity);
  expect(plugins[0]!.id).not.toBe(plugins[1]!.id);
  expect(plugins[0]!.peerHosts[0]!.host).not.toBe(plugins[1]!.peerHosts[0]!.host);
  expect(validateNpmSnapshot(request)).toEqual(outcome);
  const whitespace = { ...request, lock: npmBytes(Buffer.from(request.lock.bytesBase64, 'base64').toString() + '\n') };
  expect(validateNpmSnapshot(whitespace).lockId).not.toBe(outcome.lockId);
  expect(validateNpmSnapshot(npmFixture('root-peer')).status).toBe('validated');
  expect(validateNpmSnapshot(npmFixture('scoped-peer')).status).toBe('validated');
});

test('PKG03: invalid or absent peer never falls back to a matching name elsewhere', () => {
  for (const [kind, status, issueKind, foundPath] of [
    ['incompatible-peer', 'invalid-topology', 'version-mismatch', 'node_modules/left/node_modules/shared'],
    ['ancestor-shadow', 'invalid-topology', 'version-mismatch', 'node_modules/left/node_modules/shared'],
    ['missing-peer', 'incomplete-source-data', 'missing-peer', null],
    ['child-local-peer', 'invalid-topology', 'peer-local', 'node_modules/left/node_modules/plugin/node_modules/shared'],
  ] as const) {
    const result = validateNpmSnapshot(npmFixture(kind));
    expect(result.status).toBe(status);
    expect(result.instances).toEqual([]); expect(result.edges).toEqual([]);
    expect(result.issues).toContainEqual({ kind: issueKind, path: 'node_modules/left/node_modules/plugin',
      name: 'shared', specifier: kind === 'incompatible-peer' || kind === 'ancestor-shadow' ? '2.0.0' : '1.0.0', foundPath });
  }
});

test('PKG12: malformed, duplicate, changed-root and ambiguous paths are rejected', () => {
  const { manifest, lock } = npmDocuments();
  const text = JSON.stringify(lock);
  for (const malformed of ['{', text + 'null', text.replace('"lockfileVersion":3', '"lockfileVersion":3,"lockfileVersion":3'),
    text.replace('"packages":{', '"packages":{"node_modules\\u002fleft":{},'), '\ufeff' + text]) {
    expect(() => validateNpmSnapshot(npmRequest(manifest, malformed))).toThrow(NpmResolutionInvalid);
  }
  for (const change of [(copy: typeof lock) => { copy.name = 'changed'; },
    (copy: typeof lock) => { copy.packages['']!.dependencies = {}; },
    (copy: typeof lock) => { delete copy.packages['']; },
    (copy: typeof lock) => { copy.packages['node_modules/../left'] = npmPackage('left', '1.0.0'); },
    (copy: typeof lock) => { copy.packages['node_modules/left']!.integrity = 'sha512-AAAA'; }]) {
    const copy = structuredClone(lock); change(copy);
    expect(() => validateNpmSnapshot(npmRequest(manifest, copy))).toThrow(NpmResolutionInvalid);
  }
  const request = npmFixture();
  for (const bad of [{ ...request, manifest: { ...request.manifest, sha256: '0'.repeat(64) } },
    { ...request, lock: { ...request.lock, bytesBase64: request.lock.bytesBase64 + '\n' } },
    { ...request, manifest: { bytesBase64: '/w==', sha256: 'a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89' } }]) {
    expect(() => validateNpmSnapshot(bad)).toThrow(NpmResolutionInvalid);
  }
});

test('PKG12: unsupported clauses and policies cannot vanish from a supplied tree', () => {
  for (const [field, value] of Object.entries({ link: true, optional: false, dev: false,
    optionalDependencies: {}, peerDependenciesMeta: {}, os: ['linux'], cpu: ['x64'], libc: ['glibc'],
    engines: {}, hasInstallScript: true, bin: 'run.js', inBundle: true, hasShrinkwrap: true,
    workspaces: [], overrides: {}, scripts: {} })) {
    const { manifest, lock } = npmDocuments();
    lock.packages['node_modules/left']![field] = value;
    const result = validateNpmSnapshot(npmRequest(manifest, lock));
    expect(result.status).toBe('unsupported-semantics');
    expect(result.instances).toEqual([]);
  }
  for (const selector of ['^1.0.0', '=1.0.0', 'latest', 'npm:other@1.0.0', 'file:../other',
    'workspace:*', '1.0.0-beta.1', '01.0.0', '9007199254740992.0.0']) {
    const { manifest, lock } = npmDocuments();
    lock.packages['node_modules/left']!.dependencies!.shared = selector;
    expect(validateNpmSnapshot(npmRequest(manifest, lock)).status).toBe('unsupported-semantics');
  }
  for (const change of [{ npmVersion: '12.0.0' }, { policy: 'legacy-peers' }]) {
    expect(validateNpmSnapshot({ ...npmFixture(), ...change }).status).toBe('unsupported-semantics');
  }
  const oldLock = npmDocuments(); oldLock.lock.lockfileVersion = 2;
  expect(validateNpmSnapshot(npmRequest(oldLock.manifest, oldLock.lock)))
    .toMatchObject({ status: 'unsupported-semantics', lockfileVersion: 2, instances: [] });
  const { manifest, lock } = npmDocuments();
  lock.packages['node_modules/left']!.name = 'other';
  expect(validateNpmSnapshot(npmRequest(manifest, lock)).status).toBe('unsupported-semantics');
  lock.packages['node_modules/left']!.name = 'left';
  lock.packages['node_modules/left']!.peerDependencies = { shared: '1.0.0' };
  expect(validateNpmSnapshot(npmRequest(manifest, lock)).status).toBe('unsupported-semantics');
});

test('PKG13: missing records, provenance and unused locked entries are truthful failures', () => {
  for (const field of ['resolved', 'integrity'] as const) {
    const { manifest, lock } = npmDocuments(); delete lock.packages['node_modules/left']![field];
    expect(validateNpmSnapshot(npmRequest(manifest, lock))).toMatchObject({ status: 'incomplete-source-data', instances: [], edges: [] });
  }
  const { manifest, lock } = npmDocuments();
  delete lock.packages['node_modules/left'];
  const missing = validateNpmSnapshot(npmRequest(manifest, lock));
  expect(missing.status).toBe('incomplete-source-data');
  expect(missing.issues.some(issue => issue.kind === 'missing-parent')).toBe(true);
  const unused = npmDocuments();
  unused.lock.packages['node_modules/unused'] = npmPackage('unused', '1.0.0');
  expect(validateNpmSnapshot(npmRequest(unused.manifest, unused.lock))).toMatchObject({ status: 'invalid-topology',
    instances: [], issues: [{ kind: 'unreachable', path: 'node_modules/unused' }] });
});

test('PKG13: byte, node, edge and nesting limits bound topology work without partial success', () => {
  for (const size of [8, 32, 128, 129]) {
    const manifest = { name: 'scale', version: '1.0.0', dependencies: {} as Record<string, string> };
    const packages: Record<string, unknown> = { '': manifest };
    for (let i = 0; i < size; i++) {
      manifest.dependencies[`p${i}`] = '1.0.0';
      packages[`node_modules/p${i}`] = npmPackage(`p${i}`, '1.0.0');
    }
    const result = validateNpmSnapshot(npmRequest(manifest, { name: manifest.name,
      version: manifest.version, lockfileVersion: 3, packages }));
    expect(result.status).toBe(size > 128 ? 'budget-exhausted' : 'validated');
    if (size <= 128) expect(result.cost).toMatchObject({ nodeCount: size + 1, edgeCount: size, ancestorLookups: size });
    else expect(result.instances).toEqual([]);
  }
  const { manifest, lock } = npmDocuments();
  lock.packages['node_modules/left']!.dependencies = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`p${i}`, '1.0.0']));
  const edges = validateNpmSnapshot(npmRequest(manifest, lock));
  expect(edges).toMatchObject({ status: 'budget-exhausted', instances: [], edges: [], cost: { edgeCount: 257 } });
  const request = npmFixture();
  const bytes = validateNpmSnapshot({ ...request, manifest: npmBytes(' '.repeat(65_536) + '{}') });
  expect(bytes).toMatchObject({ status: 'budget-exhausted', cost: { nodeCount: 0, edgeCount: 0 } });
  const nested = validateNpmSnapshot(npmRequest('['.repeat(34) + '0' + ']'.repeat(34), '{}'));
  expect(nested.status).toBe('budget-exhausted');
  const deep = npmDocuments();
  deep.lock.packages[Array(17).fill('node_modules/deep').join('/')] = npmPackage('deep', '1.0.0');
  expect(validateNpmSnapshot(npmRequest(deep.manifest, deep.lock))).toMatchObject({
    status: 'budget-exhausted', budgetReason: 'npm path nesting limit', instances: [], edges: [] });
});

test('PKG03: peer cycles retain finite path identity and host references', () => {
  const manifest = { name: 'cycle', version: '1.0.0', dependencies: { a: '1.0.0' } };
  const lock = { name: 'cycle', version: '1.0.0', lockfileVersion: 3, packages: { '': manifest,
    'node_modules/a': { ...npmPackage('a', '1.0.0'), peerDependencies: { b: '1.0.0' } },
    'node_modules/b': { ...npmPackage('b', '1.0.0'), peerDependencies: { a: '1.0.0' } } } };
  const result = validateNpmSnapshot(npmRequest(manifest, lock));
  expect(result.status).toBe('validated'); expect(result.cost.edgeCount).toBe(3);
  expect(new Set(result.instances.map(node => node.id)).size).toBe(3);
});
