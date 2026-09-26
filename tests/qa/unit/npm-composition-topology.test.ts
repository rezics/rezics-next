import { expect, test } from 'bun:test';
import { NpmResolutionInvalid } from '../../../services/main/src/modules/package/npm-lock.ts';
import { validateNpmCompositionSnapshot as validate, type NpmCompositionRequest } from '../../../services/main/src/modules/package/npm-composition.ts';
import { npmCompositionDocuments as documents, npmCompositionFixture as fixture,
  npmCompositionRequest as request, npmCompositionTargets as targets } from '../fixtures/npm-composition-snapshot.ts';
import { npmBytes, npmPackage } from '../fixtures/npm-lock-snapshot.ts';

function empty(result: ReturnType<typeof validate>) {
  for (const field of ['instances', 'edges', 'activeInstances', 'activeEdges', 'omittedInstances', 'omittedEdges'] as const) {
    expect(result[field]).toEqual([]);
  }
}
test('PKG04/PKG12: composed receipts keep alias and workspace identities through four explicit targets', () => {
  const results = targets.map(target => validate(fixture('workspace-optional-child', target)));
  for (const [i, result] of results.entries()) {
    expect(result.status).toBe('validated');
    const byPath = new Map(result.instances.map(node => [node.path, node]));
    const alias = byPath.get('node_modules/renamed')!;
    const workspace = byPath.get('modules/unrelated-directory')!;
    const link = byPath.get('node_modules/widget')!;
    expect(alias).toMatchObject({ kind: 'registry', slotName: 'renamed', name: 'actual', optional: true,
      resolved: npmPackage('actual', '1.0.0').resolved, integrity: npmPackage('actual', '1.0.0').integrity });
    expect(workspace).toMatchObject({ kind: 'workspace', name: 'widget', slotName: null, optional: false });
    expect(link).toMatchObject({ kind: 'link', name: 'widget', slotName: 'widget', optional: false,
      linkTarget: { id: workspace.id, path: workspace.path } });
    expect(result.edges.filter(edge => edge.from === link.id)).toEqual([]);
    expect(workspace.peerHosts).toEqual([{ name: 'host', specifier: '1.0.0', optional: false,
      host: byPath.get('node_modules/host')!.id, path: 'node_modules/host' }]);
    expect(result.activeInstances).toContain(workspace.id);
    expect(result.activeInstances).toContain(link.id);
    expect(result.activeInstances).toContain(byPath.get('node_modules/host')!.id);
    expect(result.omittedInstances.map(node => [node.path, node.causePath])).toEqual(i === 0 ? [] : [
      ['node_modules/leaf', alias.path], [alias.path, alias.path] ]);
    expect(result.omittedEdges.filter(edge => edge.reason === 'platform').map(edge => edge.causePath))
      .toEqual(i === 0 ? [] : [alias.path, alias.path]);
    expect(result.edges).toContainEqual({ from: workspace.id, to: alias.id, kind: 'dependency', optional: true,
      name: 'renamed', requestedName: 'actual', specifier: 'npm:actual@1.0.0' });
    expect(validate(fixture('workspace-optional-child', targets[i]))).toEqual(result);
  }
  expect(new Set(results.map(result => result.lockId)).size).toBe(4);
  expect(new Set(results.flatMap(result => result.instances.map(node => node.id))).size).toBe(24);
});

test('PKG04: required ancestry, optional cycles and shared consumers determine exact omission causes', () => {
  const child = validate(fixture('optional-alias-child', targets[1]));
  expect(child.status).toBe('validated');
  expect(child.omittedInstances.map(node => [node.path, node.causePath])).toEqual([
    ['node_modules/leaf', 'node_modules/leaf'], ['node_modules/renamed', 'node_modules/leaf'] ]);
  expect(child.omittedEdges.every(edge => edge.causePath === 'node_modules/leaf')).toBe(true);
  const cycle = validate(fixture('optional-cycle', targets[1]));
  expect(cycle.status).toBe('validated'); expect(cycle.omittedInstances).toHaveLength(2);
  const shared = validate(fixture('shared-optional', targets[1]));
  expect(shared.status).toBe('validated');
  expect(shared.omittedInstances.map(node => node.path)).toEqual(['node_modules/renamed']);
  expect(shared.activeInstances).toContain(shared.instances.find(node => node.name === 'leaf')!.id);
  const required = validate(fixture('shared-alias', targets[1]));
  expect(required.status).toBe('validated');
  expect(required.instances.find(node => node.name === 'actual')!.optional).toBe(false);
  expect(required.omittedInstances).toEqual([]);
  const workspacePeer = validate(fixture('workspace-required-peer'));
  expect(workspacePeer.status).toBe('validated');
  expect(workspacePeer.instances.find(node => node.name === 'host')!.optional).toBe(false);
  expect(workspacePeer.edges.filter(edge => edge.name === 'host')).toHaveLength(1);
  expect(workspacePeer.edges.find(edge => edge.name === 'host')!.kind).toBe('peer');
  for (const kind of ['shared-alias-platform', 'workspace-required-peer', 'workspace-platform'] as const) {
    const result = validate(fixture(kind, targets[1]));
    expect(result.status).toBe('invalid-topology'); empty(result);
    expect(result.issues.some(issue => issue.kind === 'platform-incompatible')).toBe(true);
  }
});

test('PKG04/PKG13: projection cannot erase missing required edges or unproven identities', () => {
  for (const [kind, status, issue] of [
    ['missing-required', 'incomplete-source-data', 'missing-dependency'],
    ['missing-workspace-peer', 'incomplete-source-data', 'missing-peer'],
    ['missing-workspace-manifest', 'incomplete-source-data', 'missing-workspace-manifest'],
    ['missing-workspace-target', 'incomplete-source-data', 'missing-workspace-target'],
    ['missing-link-source', 'incomplete-source-data', 'missing-link-source'],
    ['missing-source', 'incomplete-source-data', 'missing-provenance'],
    ['missing-integrity', 'incomplete-source-data', 'missing-provenance'],
    ['workspace-target-mismatch', 'invalid-topology', 'link-target-mismatch'],
    ['optional-flag-mismatch', 'invalid-topology', 'optional-flag-mismatch'],
  ] as const) for (const target of targets) {
    const result = validate(fixture(kind, target));
    expect(result.status).toBe(status); empty(result);
    expect(result.issues.some(item => item.kind === issue)).toBe(true);
  }
  for (const kind of ['alias-identity-mismatch', 'plain-identity-mismatch', 'overrides', 'engines'] as const) {
    const result = validate(fixture(kind, targets[1]));
    expect(result.status).toBe('unsupported-semantics'); empty(result);
  }
  for (const kind of ['malformed-source', 'malformed-integrity'] as const) {
    expect(() => validate(fixture(kind, targets[1]))).toThrow(NpmResolutionInvalid);
  }
});

test('PKG04/PKG12: optional peer witnesses retain shadowing, absence and omitted exact host identity', () => {
  const shadow = validate(fixture('optional-peer-shadow', targets[1]));
  expect(shadow.status).toBe('invalid-topology'); empty(shadow);
  expect(shadow.issues).toContainEqual({ kind: 'version-mismatch', name: 'host', specifier: '1.0.0',
    path: 'modules/unrelated-directory/node_modules/renamed', foundPath: 'modules/unrelated-directory/node_modules/host' });
  const absent = validate(fixture('optional-peer-absent', targets[1]));
  expect(absent.status).toBe('validated');
  expect(absent.omittedEdges).toContainEqual(expect.objectContaining({ kind: 'peer', name: 'ghost', requestedName: 'ghost-package',
    reason: 'absent-optional', causePath: null, to: null, foundPath: null, path: 'node_modules/renamed' }));
  const peer = validate(fixture('optional-alias-peer', targets[1]));
  expect(peer.status).toBe('validated');
  const alias = peer.instances.find(node => node.name === 'actual')!;
  const workspace = peer.instances.find(node => node.kind === 'workspace')!;
  expect(workspace.peerHosts).toContainEqual({ name: 'renamed', specifier: 'npm:actual@1.0.0',
    optional: true, host: alias.id, path: alias.path });
  expect(peer.omittedEdges).toContainEqual({ from: workspace.id, path: workspace.path, to: alias.id, foundPath: alias.path,
    kind: 'peer', optional: true, name: 'renamed', requestedName: 'actual', specifier: 'npm:actual@1.0.0',
    reason: 'platform', causePath: alias.path });
  const local = validate(fixture('workspace-local-peer', targets[1]));
  expect(local.status).toBe('validated');
  expect(local.instances.find(node => node.kind === 'workspace')!.peerHosts[0]!.path)
    .toBe('modules/unrelated-directory/node_modules/host');
  expect(validate(fixture('workspace-internal', targets[1])).status).toBe('validated');
});

test('PKG12: exact workspace bytes, selectors and paths bind the composed request before projection', () => {
  const original = fixture();
  const changed = structuredClone(original);
  changed.workspaces[0]!.manifest = npmBytes(Buffer.from(changed.workspaces[0]!.manifest.bytesBase64, 'base64').toString() + '\n');
  expect(validate(changed).lockId).not.toBe(validate(original).lockId);
  for (const target of [null, {}, { os: 'linux' }, { os: 1, cpu: 'x64' }, { os: 'linux', cpu: 'x64', libc: 'glibc' }]) {
    expect(() => validate({ ...original, target } as NpmCompositionRequest)).toThrow(NpmResolutionInvalid);
  }
  for (const bytes of [npmBytes('{'), npmBytes('{"name":1,"na\\u006de":2}'),
    { ...original.workspaces[0]!.manifest, sha256: '0'.repeat(64) },
    { ...original.workspaces[0]!.manifest, bytesBase64: original.workspaces[0]!.manifest.bytesBase64 + '\n' }]) {
    expect(() => validate({ ...original, workspaces: [{ ...original.workspaces[0]!, manifest: bytes }] })).toThrow(NpmResolutionInvalid);
  }
  for (const modify of [
    (docs: ReturnType<typeof documents>) => { docs.workspaces[0]!.path = '../escape'; },
    (docs: ReturnType<typeof documents>) => { docs.workspaces.push(structuredClone(docs.workspaces[0]!)); },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages['modules/unrelated-directory'] = { ...docs.workspaces[0]!.manifest, os: ['linux'] }; },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages['node_modules/renamed']!.os = [1]; },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages['node_modules/renamed']!.peerDependenciesMeta = { absent: { optional: true } }; },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages['node_modules/widget']!.resolved = '../escape'; },
  ]) {
    const docs = documents(); modify(docs);
    expect(() => validate(request(docs, targets[1]))).toThrow(NpmResolutionInvalid);
  }
  for (const os of [[], ['any'], 'linux', ['!win32'], ['linux', '!linux']]) {
    const docs = documents(); docs.lock.packages['node_modules/renamed']!.os = os;
    const result = validate(request(docs));
    expect(result.status).toBe('validated');
    expect(result.omittedInstances.some(node => node.path === 'node_modules/renamed'))
      .toBe(Array.isArray(os) && os.includes('!linux'));
  }
});

test('PKG04/PKG13: unqualified composition grammar never disappears in an optional branch', () => {
  for (const change of [{ target: { os: 'darwin', cpu: 'x64' } }, { policy: 'other' }, { npmVersion: '12.0.0' }]) {
    expect(validate({ ...fixture(), ...change }).status).toBe('unsupported-semantics');
  }
  for (const [field, value] of Object.entries({ devDependencies: {}, overrides: {}, engines: {}, libc: ['glibc'],
    scripts: {}, hasInstallScript: true, os: ['future'] })) {
    const docs = documents(); docs.lock.packages['node_modules/renamed']![field] = value;
    const result = validate(request(docs, targets[1])); expect(result.status).toBe('unsupported-semantics'); empty(result);
  }
  for (const paths of [['modules/*'], ['modules/unrelated-directory', 'modules/unrelated-directory/sub']]) {
    const docs = documents(); docs.manifest.workspaces = paths;
    expect(validate(request(docs)).status).toBe('unsupported-semantics');
  }
  const overlap = documents();
  overlap.workspaces[0]!.manifest.dependencies = { renamed: 'npm:actual@1.0.0' };
  expect(validate(request(overlap)).status).toBe('unsupported-semantics');
  const linkAlias = documents();
  linkAlias.workspaces[0]!.manifest.optionalDependencies = { widget: 'npm:widget@1.0.0' };
  const result = validate(request(linkAlias, targets[1]));
  expect(result.status).toBe('unsupported-semantics'); empty(result);
});

test('PKG13: combined byte, node, edge, workspace, selector and ancestor budgets publish no partial graph', () => {
  const original = fixture();
  expect(validate({ ...original, lock: npmBytes(' '.repeat(65_536) + '{}') }))
    .toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm raw file byte limit' });
  expect(validate({ ...original, workspaces: Array.from({ length: 5 }, (_, i) => ({ path: `p${i}`,
    manifest: npmBytes(' '.repeat(60_000) + '{}') })) })).toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm aggregate byte limit' });
  expect(validate({ ...original, lock: npmBytes('['.repeat(34) + '0' + ']'.repeat(34)) }).status).toBe('budget-exhausted');
  for (const modify of [
    (docs: ReturnType<typeof documents>) => { docs.manifest.workspaces = Array.from({ length: 17 }, (_, i) => `p${i}`); },
    (docs: ReturnType<typeof documents>) => { docs.manifest.workspaces = ['a/'.repeat(8) + 'b']; },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages['node_modules/renamed']!.os = Array(17).fill('linux'); },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages['node_modules/renamed']!.dependencies = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`p${i}`, '1.0.0'])); },
    (docs: ReturnType<typeof documents>) => { docs.lock.packages[Array(17).fill('node_modules/a').join('/')] = npmPackage('a', '1.0.0'); },
  ]) {
    const docs = documents(); modify(docs);
    const result = validate(request(docs)); expect(result.status).toBe('budget-exhausted'); empty(result);
  }
  const deep = documents('optional-alias');
  deep.manifest.dependencies = {}; deep.manifest.optionalDependencies = {};
  deep.lock.packages = { '': deep.manifest };
  let path = '';
  for (let depth = 1; depth <= 16; depth++) {
    path += `${path ? '/' : ''}node_modules/a`;
    deep.lock.packages[path] = { ...npmPackage('a', '1.0.0'), ...(depth < 16 ? {} : {
      optionalDependencies: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p${i}`, 'npm:actual@1.0.0'])) }) };
  }
  const bounded = validate(request(deep));
  expect(bounded).toMatchObject({ status: 'budget-exhausted', budgetReason: 'npm ancestor lookup limit', cost: { ancestorLookups: 4097 } });
  empty(bounded);
});

test('PKG13: increasing alias populations and shared optional regions retain counted bounded work', () => {
  for (const size of [8, 32, 128, 129]) {
    const docs = documents('optional-alias');
    const optionalDependencies: Record<string, string> = {};
    docs.manifest.dependencies = {}; docs.manifest.optionalDependencies = optionalDependencies;
    docs.lock.packages = { '': docs.manifest };
    for (let i = 0; i < size; i++) {
      optionalDependencies[`slot${i}`] = 'npm:actual@1.0.0';
      docs.lock.packages[`node_modules/slot${i}`] = { ...npmPackage('actual', '1.0.0'), name: 'actual', optional: true, os: ['linux'] };
    }
    const result = validate(request(docs, targets[1]));
    expect(result.status).toBe(size > 128 ? 'budget-exhausted' : 'validated');
    if (size > 128) empty(result);
    else {
      expect(result.cost).toMatchObject({ nodeCount: size + 1, edgeCount: size, ancestorLookups: size });
      expect(result.cost.graphVisits).toBeLessThanOrEqual(16 * size + 8);
      expect(result.activeInstances).toHaveLength(1); expect(result.omittedInstances).toHaveLength(size);
    }
  }
  for (const size of [8, 24, 48]) {
    const docs = documents('optional-alias');
    docs.manifest.dependencies = {}; docs.manifest.optionalDependencies = {};
    docs.lock.packages = { '': docs.manifest };
    for (let i = 0; i < size; i++) {
      (docs.manifest.optionalDependencies as Record<string, string>)[`slot${i}`] = 'npm:actual@1.0.0';
      docs.lock.packages[`node_modules/slot${i}`] = { ...npmPackage('actual', '1.0.0'), name: 'actual',
        optional: true, os: ['linux'], dependencies: { leaf: '1.0.0' } };
    }
    docs.lock.packages['node_modules/leaf'] = { ...npmPackage('leaf', '1.0.0'), optional: true };
    const result = validate(request(docs, targets[1]));
    expect(result.status).toBe('validated');
    expect(result.omittedInstances).toHaveLength(size + 1);
    expect(result.cost.graphVisits).toBeLessThanOrEqual(4 * size * size + 30 * size);
    expect(result.cost.graphVisits).toBeLessThan(65536);
  }
});
