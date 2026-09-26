import { npmBytes, npmPackage } from './npm-lock-snapshot.ts';

export const npmIdentityCases = ['registry-alias', 'two-aliases', 'scoped-alias', 'alias-peer', 'alias-peer-host', 'alias-host-environments',
  'alias-identity-mismatch', 'workspace-peer', 'workspace-name-path', 'workspace-internal',
  'workspace-peer-shadow', 'workspace-peer-local', 'workspace-slot-mismatch', 'workspace-target-mismatch',
  'missing-workspace-target', 'missing-workspace-link', 'missing-link-source', 'malformed-link',
  'missing-source', 'missing-integrity', 'malformed-source', 'malformed-integrity',
  'unknown-source', 'overrides', 'engines'] as const;
export type NpmIdentityCase = typeof npmIdentityCases[number];
export interface NpmIdentityDocuments {
  manifest: Record<string, unknown>;
  lock: { name: string; version: string; lockfileVersion: number; requires: boolean;
    packages: Record<string, Record<string, unknown>> };
  workspaces: Array<{ path: string; manifest: Record<string, unknown> }>;
}
export function npmIdentityDocuments(kind: NpmIdentityCase = 'workspace-peer'): NpmIdentityDocuments {
  const manifest: Record<string, unknown> = { name: 'identity-root', version: '1.0.0',
    dependencies: { renamed: 'npm:actual@1.0.0', host: '1.0.0' } };
  const packages: Record<string, Record<string, unknown>> = {
    '': manifest, 'node_modules/renamed': { ...npmPackage('actual', '1.0.0'), name: 'actual',
      peerDependencies: { host: '1.0.0' } }, 'node_modules/host': npmPackage('host', '1.0.0'),
  };
  const workspaces: NpmIdentityDocuments['workspaces'] = [];
  const deps = manifest.dependencies as Record<string, string>;
  if (kind === 'two-aliases') {
    deps.second = deps.renamed!;
    packages['node_modules/second'] = structuredClone(packages['node_modules/renamed']!);
  }
  if (kind === 'scoped-alias') {
    delete deps.renamed; delete packages['node_modules/renamed'];
    deps['@slots/renamed'] = 'npm:@origin/actual@1.0.0';
    packages['node_modules/@slots/renamed'] = { ...npmPackage('@origin/actual', '1.0.0'),
      name: '@origin/actual', peerDependencies: { host: '1.0.0' } };
  }
  if (kind === 'alias-peer') packages['node_modules/renamed']!.peerDependencies = { host: '2.0.0' };
  if (kind === 'alias-peer-host') {
    deps.host = 'npm:actual-host@1.0.0';
    packages['node_modules/host'] = { ...npmPackage('actual-host', '1.0.0'), name: 'actual-host' };
    packages['node_modules/renamed']!.peerDependencies = { host: 'npm:actual-host@1.0.0' };
  }
  if (kind === 'alias-host-environments') {
    delete deps.renamed;
    for (const side of ['left', 'right']) {
      deps[side] = '1.0.0';
      packages[`node_modules/${side}`] = { ...npmPackage(side, '1.0.0'), dependencies: { renamed: 'npm:actual@1.0.0', host: '1.0.0' } };
      packages[`node_modules/${side}/node_modules/renamed`] = structuredClone(packages['node_modules/renamed']!);
      packages[`node_modules/${side}/node_modules/host`] = npmPackage('host', '1.0.0');
    }
    delete packages['node_modules/renamed'];
  }
  if (kind === 'alias-identity-mismatch') packages['node_modules/renamed']!.name = 'different';
  if (kind.includes('workspace') || kind === 'missing-link-source' || kind === 'malformed-link') {
    const path = kind === 'workspace-name-path' ? 'modules/unrelated-directory' : 'packages/widget';
    const workspace = { name: 'widget', version: '1.0.0', dependencies: { leaf: '1.0.0' },
      peerDependencies: { host: '1.0.0' } };
    manifest.workspaces = [path];
    workspaces.push({ path, manifest: workspace });
    packages[path] = structuredClone(workspace);
    packages['node_modules/widget'] = { resolved: path, link: true };
    packages[`${path}/node_modules/leaf`] = npmPackage('leaf', '1.0.0');
    if (kind === 'workspace-internal' || kind === 'workspace-target-mismatch') {
      (manifest.workspaces as string[]).push('packages/other');
      const other = { name: 'other', version: '1.0.0' };
      workspaces.push({ path: 'packages/other', manifest: other });
      packages['packages/other'] = other;
      packages['node_modules/other'] = { resolved: 'packages/other', link: true };
      if (kind === 'workspace-internal') {
        Object.assign(workspace.dependencies, { other: '1.0.0' });
        packages[path] = structuredClone(workspace);
      } else packages['node_modules/widget']!.resolved = 'packages/other';
    }
    if (kind === 'workspace-peer-local') packages[`${path}/node_modules/host`] = npmPackage('host', '1.0.0');
    if (kind === 'workspace-peer-shadow') {
      packages[`${path}/node_modules/plugin`] = { ...npmPackage('plugin', '1.0.0'), peerDependencies: { host: '1.0.0' } };
      packages[`${path}/node_modules/host`] = npmPackage('host', '2.0.0');
      delete (workspace as Partial<typeof workspace>).peerDependencies;
      Object.assign(workspace.dependencies, { plugin: '1.0.0', host: '2.0.0' });
      packages[path] = structuredClone(workspace);
    }
    if (kind === 'workspace-slot-mismatch') {
      packages['node_modules/wrong'] = packages['node_modules/widget']!;
      delete packages['node_modules/widget'];
    }
    if (kind === 'missing-workspace-target') delete packages[path];
    if (kind === 'missing-workspace-link') delete packages['node_modules/widget'];
    if (kind === 'missing-link-source') delete packages['node_modules/widget']!.resolved;
    if (kind === 'malformed-link') packages['node_modules/widget']!.link = 'yes';
  }
  if (kind === 'missing-source') delete packages['node_modules/renamed']!.resolved;
  if (kind === 'missing-integrity') delete packages['node_modules/renamed']!.integrity;
  if (kind === 'malformed-source') packages['node_modules/renamed']!.resolved = 7;
  if (kind === 'malformed-integrity') packages['node_modules/renamed']!.integrity = 'sha512-nope';
  if (kind === 'unknown-source') packages['node_modules/renamed']!.resolved = 'git+https://example.com/repo.git';
  if (kind === 'overrides') manifest.overrides = { host: '1.0.0' };
  if (kind === 'engines') manifest.engines = { node: '>=99' };
  return { manifest, lock: { name: 'identity-root', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, workspaces };
}
export function npmIdentityRequest(documents: NpmIdentityDocuments = npmIdentityDocuments()) {
  return { profile: 'npm-lock-v3-topology-v3' as const, npmVersion: '11.19.1',
    policy: 'literal-sources-alias-workspace-v3', manifest: npmBytes(JSON.stringify(documents.manifest)),
    lock: npmBytes(JSON.stringify(documents.lock)),
    workspaces: documents.workspaces.map(item => ({ path: item.path, manifest: npmBytes(JSON.stringify(item.manifest)) })) };
}
export function npmIdentityFixture(kind: NpmIdentityCase = 'workspace-peer') {
  return npmIdentityRequest(npmIdentityDocuments(kind));
}
