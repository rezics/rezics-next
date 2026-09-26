import { npmBytes, npmDocuments, npmPackage, type NpmFixturePackage } from './npm-lock-snapshot.ts';

export const npmPlatformCases = ['platform-branch', 'optional-child-platform', 'shared-platform-required',
  'required-missing', 'optional-missing', 'required-peer-shadow', 'optional-peer-shadow',
  'optional-peer-host', 'optional-cycle', 'shared-optional', 'selectors'] as const;
export type NpmPlatformCase = typeof npmPlatformCases[number];
export const npmTargets = [{ os: 'linux', cpu: 'x64' }, { os: 'win32', cpu: 'x64' },
  { os: 'linux', cpu: 'arm64' }] as const;

export function npmPlatformDocuments(kind: NpmPlatformCase = 'platform-branch') {
  const manifest: NpmFixturePackage = { name: 'platform-root', version: '1.0.0',
    dependencies: { core: '1.0.0', shared: '1.0.0' }, optionalDependencies: { addon: '1.0.0' } };
  const packages: Record<string, NpmFixturePackage> = {
    '': manifest,
    'node_modules/core': { ...npmPackage('core', '1.0.0'),
      optionalDependencies: { helper: '1.0.0' }, peerDependencies: { ghost: '1.0.0' },
      peerDependenciesMeta: { ghost: { optional: true } } },
    'node_modules/shared': npmPackage('shared', '1.0.0'),
    'node_modules/helper': { ...npmPackage('helper', '1.0.0'), optional: true, os: ['win32'] },
    'node_modules/addon': { ...npmPackage('addon', '1.0.0'), optional: true, os: ['linux'], cpu: ['x64'],
      dependencies: { leaf: '1.0.0', shared: '1.0.0' } },
    'node_modules/leaf': { ...npmPackage('leaf', '1.0.0'), optional: true },
  };
  if (kind === 'optional-child-platform' || kind === 'optional-cycle') {
    delete packages['node_modules/addon']!.os;
    delete packages['node_modules/addon']!.cpu;
    packages['node_modules/leaf']!.os = ['linux'];
    if (kind === 'optional-cycle') packages['node_modules/leaf']!.dependencies = { addon: '1.0.0' };
  }
  if (kind === 'shared-platform-required') packages['node_modules/shared']!.os = ['linux'];
  if (kind === 'required-missing') delete packages['node_modules/shared'];
  if (kind === 'optional-missing') {
    (manifest.optionalDependencies as Record<string, string>).absent = '1.0.0';
  }
  if (kind === 'optional-peer-host') {
    packages['node_modules/core']!.peerDependencies = { shared: '1.0.0' };
    packages['node_modules/core']!.peerDependenciesMeta = { shared: { optional: true } };
  }
  if (kind === 'shared-optional') {
    (manifest.optionalDependencies as Record<string, string>).other = '1.0.0';
    packages['node_modules/other'] = { ...npmPackage('other', '1.0.0'), optional: true,
      dependencies: { leaf: '1.0.0' } };
  }
  if (kind === 'selectors') {
    packages['node_modules/addon']!.os = ['linux', '!win32'];
    packages['node_modules/addon']!.cpu = ['!arm64'];
    packages['node_modules/helper']!.os = 'any';
    packages['node_modules/helper']!.cpu = [];
  }
  if (kind === 'required-peer-shadow' || kind === 'optional-peer-shadow') {
    const old = npmDocuments();
    Object.assign(old.manifest.dependencies, { shared: '2.0.0' });
    old.lock.packages['']!.dependencies = structuredClone(old.manifest.dependencies);
    old.lock.packages['node_modules/shared'] = npmPackage('shared', '2.0.0');
    const plugin = old.lock.packages['node_modules/left/node_modules/plugin']!;
    plugin.peerDependencies = { shared: '2.0.0' };
    if (kind === 'optional-peer-shadow') plugin.peerDependenciesMeta = { shared: { optional: true } };
    return old;
  }
  return { manifest, lock: { name: manifest.name!, version: manifest.version,
    lockfileVersion: 3, requires: true, packages } };
}

export function npmPlatformRequest(manifest: unknown, lock: unknown,
  target: { os: string; cpu: string } = npmTargets[0]) {
  return { profile: 'npm-lock-v3-topology-v2' as const, npmVersion: '11.19.1',
    policy: 'literal-sources-optional-platform-v2', target: { ...target },
    manifest: npmBytes(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)),
    lock: npmBytes(typeof lock === 'string' ? lock : JSON.stringify(lock)) };
}
export function npmPlatformFixture(kind: NpmPlatformCase = 'platform-branch', target = npmTargets[0] as { os: string; cpu: string }) {
  const { manifest, lock } = npmPlatformDocuments(kind);
  return npmPlatformRequest(manifest, lock, target);
}
