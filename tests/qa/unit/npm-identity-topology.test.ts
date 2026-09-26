import { expect, test } from 'bun:test';
import { NpmResolutionInvalid, validateNpmSnapshot } from '../../../services/main/src/modules/package/npm-lock.ts';
import { validateNpmPlatformSnapshot } from '../../../services/main/src/modules/package/npm-platform.ts';
import { validateNpmIdentitySnapshot as validate } from '../../../services/main/src/modules/package/npm-identity.ts';
import { npmIdentityDocuments, npmIdentityFixture, npmIdentityRequest } from '../fixtures/npm-identity-snapshot.ts';
import { npmBytes, npmPackage } from '../fixtures/npm-lock-snapshot.ts';

test('PKG04/PKG12: alias slots preserve requested identity, source, SRI and peer hosts separately', () => {
  const request = npmIdentityFixture('two-aliases');
  const result = validate(request);
  expect(result.status).toBe('validated');
  const aliases = result.instances.filter(node => node.name === 'actual');
  expect(aliases.map(node => node.slotName)).toEqual(['renamed', 'second']);
  expect(aliases[0]!.id).not.toBe(aliases[1]!.id);
  expect(aliases[0]!.resolved).toBe(aliases[1]!.resolved);
  expect(aliases[0]!.integrity).toBe(aliases[1]!.integrity);
  expect(aliases[0]!.peerHosts).toEqual(aliases[1]!.peerHosts);
  expect(result.edges.filter(edge => edge.requestedName === 'actual').map(edge => [edge.name, edge.specifier]))
    .toEqual([['renamed', 'npm:actual@1.0.0'], ['second', 'npm:actual@1.0.0']]);
  expect(validate(npmIdentityFixture('scoped-alias')).instances).toContainEqual(expect.objectContaining({
    slotName: '@slots/renamed', name: '@origin/actual', path: 'node_modules/@slots/renamed' }));
  expect(validate(request)).toEqual(result);
  const hosted = validate(npmIdentityFixture('alias-host-environments'));
  expect(hosted.status).toBe('validated');
  const nested = hosted.instances.filter(node => node.name === 'actual');
  expect(nested[0]!.resolved).toBe(nested[1]!.resolved);
  expect(nested[0]!.id).not.toBe(nested[1]!.id);
  expect(nested[0]!.peerHosts[0]!.host).not.toBe(nested[1]!.peerHosts[0]!.host);
  const aliasedHost = validate(npmIdentityFixture('alias-peer-host'));
  expect(aliasedHost.status).toBe('validated');
  expect(aliasedHost.instances.find(node => node.slotName === 'host')!.name).toBe('actual-host');
  expect(aliasedHost.instances.find(node => node.name === 'actual')!.peerHosts[0])
    .toMatchObject({ name: 'host', specifier: 'npm:actual-host@1.0.0', path: 'node_modules/host' });
});

test('PKG04/PKG12: workspace basename, link slot and target environment do not collapse', () => {
  const result = validate(npmIdentityFixture('workspace-name-path'));
  expect(result.status).toBe('validated');
  const target = result.instances.find(node => node.kind === 'workspace')!;
  const link = result.instances.find(node => node.kind === 'link')!;
  expect(target).toMatchObject({ path: 'modules/unrelated-directory', name: 'widget', slotName: null,
    resolved: null, integrity: null, linkTarget: null });
  expect(link).toMatchObject({ path: 'node_modules/widget', name: 'widget', slotName: 'widget',
    resolved: target.path, integrity: null, peerHosts: [], linkTarget: { id: target.id, path: target.path } });
  expect(result.edges.filter(edge => edge.from === link.id)).toEqual([]);
  const leaf = result.instances.find(node => node.name === 'leaf')!;
  expect(result.edges).toContainEqual(expect.objectContaining({ from: target.id, to: leaf.id, kind: 'dependency' }));
  expect(target.peerHosts[0]!.path).toBe('node_modules/host');
  const local = validate(npmIdentityFixture('workspace-peer-local'));
  expect(local.status).toBe('validated');
  expect(local.instances.find(node => node.kind === 'workspace')!.peerHosts[0]!.path)
    .toBe('packages/widget/node_modules/host');
  expect(validate(npmIdentityFixture('workspace-internal')).status).toBe('validated');
  const request = npmIdentityFixture();
  const changed = structuredClone(request);
  const input = changed.workspaces[0]!;
  input.manifest = npmBytes(Buffer.from(input.manifest.bytesBase64, 'base64').toString() + '\n');
  const a = validate(request); const b = validate(changed);
  expect(b.status).toBe('validated');
  expect(b.lockId).not.toBe(a.lockId);
  expect(b.instances.every(node => !a.instances.some(previous => previous.id === node.id))).toBe(true);
});

test('PKG04/PKG13: native mismatch, missing evidence and stricter admission stay distinct', () => {
  for (const [kind, status, issue] of [
    ['alias-peer', 'invalid-topology', 'version-mismatch'],
    ['workspace-peer-shadow', 'invalid-topology', 'version-mismatch'],
    ['workspace-slot-mismatch', 'incomplete-source-data', 'missing-dependency'],
    ['workspace-target-mismatch', 'invalid-topology', 'link-target-mismatch'],
    ['missing-workspace-target', 'incomplete-source-data', 'missing-workspace-target'],
    ['missing-workspace-link', 'incomplete-source-data', 'missing-dependency'],
    ['missing-link-source', 'incomplete-source-data', 'missing-link-source'],
    ['missing-source', 'incomplete-source-data', 'missing-provenance'],
    ['missing-integrity', 'incomplete-source-data', 'missing-provenance'],
  ] as const) {
    const result = validate(npmIdentityFixture(kind));
    expect(result.status).toBe(status);
    expect(result.instances).toEqual([]); expect(result.edges).toEqual([]);
    expect(result.issues.some(item => item.kind === issue)).toBe(true);
  }
  for (const kind of ['alias-identity-mismatch', 'unknown-source', 'overrides', 'engines'] as const) {
    expect(validate(npmIdentityFixture(kind))).toMatchObject({ status: 'unsupported-semantics', instances: [], edges: [], issues: [] });
  }
  for (const kind of ['malformed-link', 'malformed-source', 'malformed-integrity'] as const) {
    expect(() => validate(npmIdentityFixture(kind))).toThrow(NpmResolutionInvalid);
  }
  const absent = npmIdentityFixture(); absent.workspaces = [];
  expect(validate(absent)).toMatchObject({ status: 'incomplete-source-data', instances: [], edges: [] });
  expect(validate(absent).issues.some(issue => issue.kind === 'missing-workspace-manifest')).toBe(true);
});

test('PKG12: exact workspace bytes, paths and manifest/lock bindings reject ambiguity', () => {
  for (const modify of [
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.lock.packages['packages/widget']!.name = 'changed'; },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.lock.packages['packages/widget']!.dependencies = {}; },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.lock.packages[''] = { ...docs.manifest, workspaces: [] }; },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.lock.packages['node_modules/widget']!.resolved = '../escape'; },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.workspaces.push(structuredClone(docs.workspaces[0]!)); },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.workspaces[0]!.path = 'packages/undeclared'; },
  ]) {
    const docs = npmIdentityDocuments(); modify(docs);
    expect(() => validate(npmIdentityRequest(docs))).toThrow(NpmResolutionInvalid);
  }
  const duplicate = npmIdentityDocuments('workspace-internal');
  duplicate.workspaces[1]!.manifest.name = 'widget';
  expect(() => validate(npmIdentityRequest(duplicate))).toThrow(NpmResolutionInvalid);
  const request = npmIdentityFixture();
  for (const bytes of [npmBytes('{'), npmBytes('{"name":1,"na\\u006de":2}'),
    { ...request.workspaces[0]!.manifest, sha256: '0'.repeat(64) },
    { ...request.workspaces[0]!.manifest, bytesBase64: request.workspaces[0]!.manifest.bytesBase64 + '\n' },
    { bytesBase64: '/w==', sha256: 'a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89' }]) {
    expect(() => validate({ ...request, workspaces: [{ path: 'packages/widget', manifest: bytes }] })).toThrow(NpmResolutionInvalid);
  }
  const badPath = npmIdentityDocuments();
  badPath.lock.packages['packages/widget/node_modules/../bad'] = npmPackage('bad', '1.0.0');
  expect(() => validate(npmIdentityRequest(badPath))).toThrow(NpmResolutionInvalid);
});

test('PKG04/PKG13: unsupported workspace grammar, hidden metadata and source clauses cannot disappear', () => {
  for (const raw of [['packages/*'], ['!packages/widget'], { packages: ['packages/widget'] },
    ['packages/widget', 'packages/widget/sub']]) {
    const docs = npmIdentityDocuments(); docs.manifest.workspaces = raw;
    expect(validate(npmIdentityRequest(docs)).status).toBe('unsupported-semantics');
  }
  for (const selector of ['npm:actual', 'npm:actual@^1.0.0', 'npm:actual@latest', 'workspace:*',
    'file:packages/widget', 'git+https://example.com/p.git', '=1.0.0']) {
    const docs = npmIdentityDocuments();
    (docs.manifest.dependencies as Record<string, string>).renamed = selector;
    expect(validate(npmIdentityRequest(docs)).status).toBe('unsupported-semantics');
  }
  for (const [field, value] of Object.entries({ optional: false, optionalDependencies: {}, devDependencies: {},
    peerDependenciesMeta: {}, os: ['linux'], cpu: ['x64'], engines: {}, overrides: {}, scripts: {}, hasInstallScript: true })) {
    const docs = npmIdentityDocuments();
    docs.lock.packages['node_modules/unused'] = { ...npmPackage('unused', '1.0.0'), [field]: value };
    expect(validate(npmIdentityRequest(docs))).toMatchObject({ status: 'unsupported-semantics', instances: [], edges: [] });
  }
  const nested = npmIdentityDocuments();
  nested.lock.packages['node_modules/renamed/node_modules/widget'] = { link: true, resolved: 'packages/widget' };
  expect(validate(npmIdentityRequest(nested)).status).toBe('unsupported-semantics');
  const overlap = npmIdentityDocuments(); (overlap.manifest.dependencies as Record<string, string>).widget = '1.0.0';
  expect(validate(npmIdentityRequest(overlap)).status).toBe('unsupported-semantics');
  const old = npmIdentityFixture('registry-alias'); const { workspaces: _workspaces, ...base } = old;
  expect(validateNpmSnapshot({ ...base, profile: 'npm-lock-v3-topology-v1', policy: 'literal-sources-required-peers-v1' }).status)
    .toBe('unsupported-semantics');
  expect(validateNpmPlatformSnapshot({ ...base, profile: 'npm-lock-v3-topology-v2',
    policy: 'literal-sources-optional-platform-v2', target: { os: 'linux', cpu: 'x64' } }).status).toBe('unsupported-semantics');
});

test('PKG13: byte, workspace, node, edge and path work budgets return no partial graph', () => {
  const request = npmIdentityFixture();
  expect(validate({ ...request, workspaces: [{ path: 'packages/widget', manifest: npmBytes(' '.repeat(65_536) + '{}') }] }))
    .toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm raw file byte limit', instances: [], edges: [] });
  const huge = { ...request, workspaces: Array.from({ length: 5 }, (_, i) => ({ path: `packages/p${i}`,
    manifest: npmBytes(' '.repeat(60_000) + '{}') })) };
  expect(validate(huge)).toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm aggregate byte limit', cost: { nodeCount: 0 } });
  expect(validate({ ...request, lock: npmBytes('['.repeat(34) + '0' + ']'.repeat(34)) }).status).toBe('budget-exhausted');
  for (const modify of [
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.manifest.workspaces = Array.from({ length: 17 }, (_, i) => `p${i}`); },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.manifest.workspaces = ['a/'.repeat(8) + 'b']; },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.lock.packages[Array(17).fill('node_modules/deep').join('/')] = npmPackage('deep', '1.0.0'); },
    (docs: ReturnType<typeof npmIdentityDocuments>) => { docs.lock.packages['node_modules/renamed']!.dependencies =
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`p${i}`, '1.0.0'])); },
  ]) {
    const docs = npmIdentityDocuments(); modify(docs);
    expect(validate(npmIdentityRequest(docs))).toMatchObject({ status: 'budget-exhausted', instances: [], edges: [] });
  }
  for (const size of [8, 32, 128, 129]) {
    const docs = npmIdentityDocuments('registry-alias');
    docs.manifest.dependencies = {};
    docs.lock.packages = { '': docs.manifest };
    for (let i = 0; i < size; i++) {
      (docs.manifest.dependencies as Record<string, string>)[`slot${i}`] = 'npm:actual@1.0.0';
      docs.lock.packages[`node_modules/slot${i}`] = { ...npmPackage('actual', '1.0.0'), name: 'actual' };
    }
    const result = validate(npmIdentityRequest(docs));
    expect(result.status).toBe(size > 128 ? 'budget-exhausted' : 'validated');
    if (size <= 128) {
      expect(result.cost).toMatchObject({ nodeCount: size + 1, edgeCount: size, ancestorLookups: size });
      expect(result.cost.graphVisits).toBe(2 * size + 1);
    } else expect(result.instances).toEqual([]);
  }
});

test('PKG13: workspace ancestor traversals and cycles have bounded counted work', () => {
  const docs = npmIdentityDocuments();
  let path = 'packages/widget';
  for (let depth = 1; depth <= 16; depth++) {
    path += '/node_modules/a';
    docs.lock.packages[path] = { ...npmPackage('a', '1.0.0'), ...(depth < 16 ? {} : {
      dependencies: Object.fromEntries(Array.from({ length: 252 }, (_, i) => [`p${i}`, '1.0.0'])) }) };
  }
  // Existing root/peer/workspace edges leave fewer than 256 slots; remove them for this lookup ceiling probe.
  docs.manifest.dependencies = {};
  docs.workspaces[0]!.manifest.dependencies = {};
  delete docs.workspaces[0]!.manifest.peerDependencies;
  docs.lock.packages['packages/widget'] = structuredClone(docs.workspaces[0]!.manifest);
  delete docs.lock.packages['node_modules/renamed']; delete docs.lock.packages['node_modules/host'];
  delete docs.lock.packages['packages/widget/node_modules/leaf'];
  expect(validate(npmIdentityRequest(docs))).toMatchObject({ status: 'budget-exhausted',
    budgetReason: 'npm ancestor lookup limit', cost: { ancestorLookups: 4097 }, instances: [], edges: [] });
  const cycle = npmIdentityDocuments('workspace-internal');
  cycle.workspaces[1]!.manifest.dependencies = { widget: '1.0.0' };
  cycle.lock.packages['packages/other'] = structuredClone(cycle.workspaces[1]!.manifest);
  const result = validate(npmIdentityRequest(cycle));
  expect(result.status).toBe('validated');
  expect(result.cost.graphVisits).toBeLessThan(40);
  expect(new Set(result.instances.map(node => node.id)).size).toBe(result.instances.length);
});
