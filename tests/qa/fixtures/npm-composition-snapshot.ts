import { npmIdentityDocuments, npmIdentityRequest, type NpmIdentityDocuments } from './npm-identity-snapshot.ts';
import { npmPackage } from './npm-lock-snapshot.ts';

export const npmCompositionTargets = [
  { os: 'linux', cpu: 'x64' }, { os: 'win32', cpu: 'x64' },
  { os: 'linux', cpu: 'arm64' }, { os: 'win32', cpu: 'arm64' },
] as const;
export const npmCompositionCases = ['optional-alias', 'optional-alias-child', 'shared-alias',
  'shared-alias-platform', 'workspace-optional-child', 'workspace-required-peer', 'workspace-local-peer',
  'workspace-platform', 'workspace-internal', 'optional-peer-shadow', 'optional-peer-absent',
  'optional-alias-peer', 'optional-cycle', 'shared-optional', 'missing-required', 'missing-workspace-peer',
  'alias-identity-mismatch', 'plain-identity-mismatch', 'workspace-target-mismatch',
  'missing-source', 'missing-integrity', 'malformed-source', 'malformed-integrity',
  'missing-workspace-manifest', 'missing-workspace-target', 'missing-link-source',
  'optional-flag-mismatch', 'overrides', 'engines'] as const;
export type NpmCompositionCase = typeof npmCompositionCases[number];

export function npmCompositionDocuments(kind: NpmCompositionCase = 'workspace-optional-child'): NpmIdentityDocuments {
  const docs = npmIdentityDocuments('workspace-name-path');
  const { manifest, lock: { packages }, workspaces } = docs;
  const workspace = workspaces[0]!;
  const path = workspace.path;
  // A required workspace with a differently named directory owns an optional alias branch.
  workspace.manifest.dependencies = {};
  workspace.manifest.optionalDependencies = { renamed: 'npm:actual@1.0.0' };
  packages[path] = workspace.manifest;
  delete packages[`${path}/node_modules/leaf`];
  manifest.dependencies = { host: '1.0.0' };
  packages['node_modules/renamed'] = { ...npmPackage('actual', '1.0.0'), name: 'actual',
    optional: true, os: ['linux'], cpu: ['x64'], dependencies: { leaf: '1.0.0' } };
  packages['node_modules/leaf'] = { ...npmPackage('leaf', '1.0.0'), optional: true };
  const alias = packages['node_modules/renamed']!;
  if (kind === 'optional-alias' || kind === 'optional-alias-child') {
    manifest.workspaces = []; docs.workspaces = [];
    delete packages[path]; delete packages['node_modules/widget'];
    manifest.optionalDependencies = { renamed: 'npm:actual@1.0.0' };
  }
  if (kind === 'optional-alias-child') {
    delete alias.os; delete alias.cpu;
    packages['node_modules/leaf']!.os = ['linux'];
    packages['node_modules/leaf']!.cpu = ['x64'];
  }
  if (kind === 'shared-alias' || kind === 'shared-alias-platform') {
    (manifest.dependencies as Record<string, string>).renamed = 'npm:actual@1.0.0';
    alias.optional = false; packages['node_modules/leaf']!.optional = false;
    if (kind === 'shared-alias') { delete alias.os; delete alias.cpu; }
  }
  if (kind === 'workspace-required-peer') {
    manifest.dependencies = {}; // Required exclusively through the workspace's peer edge.
    packages['node_modules/host']!.os = ['linux'];
  }
  if (kind === 'workspace-local-peer') packages[`${path}/node_modules/host`] = npmPackage('host', '1.0.0');
  if (kind === 'workspace-platform') workspace.manifest.os = ['linux'];
  if (kind === 'workspace-internal' || kind === 'workspace-target-mismatch') {
    (manifest.workspaces as string[]).push('modules/other-directory');
    const other = { name: 'other', version: '1.0.0',
      ...(kind === 'workspace-internal' ? { dependencies: { widget: '1.0.0' } } : {}) };
    workspaces.push({ path: 'modules/other-directory', manifest: other });
    packages['modules/other-directory'] = other;
    packages['node_modules/other'] = { resolved: 'modules/other-directory', link: true };
    if (kind === 'workspace-target-mismatch') packages['node_modules/widget']!.resolved = 'modules/other-directory';
  }
  if (kind === 'optional-peer-shadow') {
    alias.peerDependencies = { host: '1.0.0' };
    alias.peerDependenciesMeta = { host: { optional: true } };
    workspace.manifest.optionalDependencies = { renamed: 'npm:actual@1.0.0' };
    (workspace.manifest.dependencies as Record<string, string>).host = '2.0.0';
    delete workspace.manifest.peerDependencies;
    packages[`${path}/node_modules/renamed`] = alias; delete packages['node_modules/renamed'];
    packages[`${path}/node_modules/host`] = npmPackage('host', '2.0.0');
  }
  if (kind === 'optional-peer-absent') {
    alias.peerDependencies = { ghost: 'npm:ghost-package@1.0.0' };
    alias.peerDependenciesMeta = { ghost: { optional: true } };
  }
  if (kind === 'optional-alias-peer') {
    delete alias.os; delete alias.cpu;
    delete workspace.manifest.optionalDependencies;
    workspace.manifest.peerDependencies = { host: '1.0.0', renamed: 'npm:actual@1.0.0' };
    workspace.manifest.peerDependenciesMeta = { renamed: { optional: true } };
    alias.os = ['linux'];
  }
  if (kind === 'optional-cycle') packages['node_modules/leaf']!.dependencies = { renamed: 'npm:actual@1.0.0' };
  if (kind === 'shared-optional') {
    manifest.optionalDependencies = { other: '1.0.0' };
    packages['node_modules/other'] = { ...npmPackage('other', '1.0.0'), optional: true,
      dependencies: { leaf: '1.0.0' } };
  }
  if (kind === 'missing-required') delete packages['node_modules/leaf'];
  if (kind === 'missing-workspace-peer') {
    manifest.dependencies = {}; delete packages['node_modules/host'];
  }
  if (kind === 'alias-identity-mismatch') alias.name = 'different';
  if (kind === 'plain-identity-mismatch') workspace.manifest.optionalDependencies = { renamed: '1.0.0' };
  if (kind === 'missing-source') delete alias.resolved;
  if (kind === 'missing-integrity') delete alias.integrity;
  if (kind === 'malformed-source') alias.resolved = 7;
  if (kind === 'malformed-integrity') alias.integrity = 'sha512-nope';
  if (kind === 'missing-workspace-manifest') docs.workspaces = [];
  if (kind === 'missing-workspace-target') delete packages[path];
  if (kind === 'missing-link-source') delete packages['node_modules/widget']!.resolved;
  if (kind === 'optional-flag-mismatch') alias.optional = false;
  if (kind === 'overrides') manifest.overrides = { host: '1.0.0' };
  if (kind === 'engines') workspace.manifest.engines = { node: '>=99' };
  return docs;
}

export function npmCompositionRequest(docs = npmCompositionDocuments(),
  target: { os: string; cpu: string } = npmCompositionTargets[0]) {
  return { ...npmIdentityRequest(docs), profile: 'npm-lock-v3-topology-v4' as const,
    policy: 'literal-sources-composed-v4', target: { ...target } };
}
export function npmCompositionFixture(kind: NpmCompositionCase = 'workspace-optional-child',
  target: { os: string; cpu: string } = npmCompositionTargets[0]) {
  return npmCompositionRequest(npmCompositionDocuments(kind), target);
}
