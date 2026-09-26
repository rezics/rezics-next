import { createHash } from 'node:crypto';

export function npmBytes(text: string) {
  return { bytesBase64: Buffer.from(text).toString('base64'),
    sha256: createHash('sha256').update(text).digest('hex') };
}
export interface NpmFixturePackage {
  name?: string; version: string; resolved?: string; integrity?: string;
  dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}
export function npmPackage(name: string, version: string): NpmFixturePackage {
  return { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
    integrity: `sha512-${createHash('sha512').update(`${name}@${version}`).digest('base64')}` };
}
export function npmDocuments() {
  const manifest = { name: 'fixture-root', version: '1.0.0',
    dependencies: { left: '1.0.0', right: '1.0.0' } };
  const packages: Record<string, NpmFixturePackage> = {
    '': structuredClone(manifest),
    'node_modules/left': { ...npmPackage('left', '1.0.0'),
      dependencies: { shared: '1.0.0', plugin: '1.0.0' } },
    'node_modules/right': { ...npmPackage('right', '1.0.0'),
      dependencies: { shared: '2.0.0', plugin: '2.0.0' } },
    'node_modules/left/node_modules/shared': npmPackage('shared', '1.0.0'),
    'node_modules/right/node_modules/shared': npmPackage('shared', '2.0.0'),
    'node_modules/left/node_modules/plugin': { ...npmPackage('plugin', '1.0.0'),
      peerDependencies: { shared: '1.0.0' } },
    'node_modules/right/node_modules/plugin': { ...npmPackage('plugin', '2.0.0'),
      peerDependencies: { shared: '2.0.0' } },
  };
  return { manifest, lock: { name: manifest.name, version: manifest.version,
    lockfileVersion: 3, requires: true, packages } };
}
export const npmNativeCases = ['nested-peers', 'incompatible-peer', 'missing-peer',
  'ancestor-shadow', 'child-local-peer', 'root-peer', 'scoped-peer', 'same-artifact-hosts'] as const;
export type NpmNativeCase = typeof npmNativeCases[number];
export function npmFixture(kind: NpmNativeCase = 'nested-peers') {
  const { manifest, lock } = npmDocuments();
  const left = lock.packages['node_modules/left']!;
  const plugin = lock.packages['node_modules/left/node_modules/plugin']!;
  if (kind === 'incompatible-peer') plugin.peerDependencies = { shared: '2.0.0' };
  if (kind === 'missing-peer') {
    delete left.dependencies!.shared;
    delete lock.packages['node_modules/left/node_modules/shared'];
  }
  if (kind === 'ancestor-shadow') {
    lock.packages['node_modules/shared'] = npmPackage('shared', '2.0.0');
    lock.packages[''].dependencies!.shared = '2.0.0';
    Object.assign(manifest.dependencies, { shared: '2.0.0' });
    plugin.peerDependencies = { shared: '2.0.0' };
  }
  if (kind === 'child-local-peer') {
    lock.packages['node_modules/left/node_modules/plugin/node_modules/shared'] = npmPackage('shared', '1.0.0');
  }
  if (kind === 'root-peer') {
    Object.assign(manifest, { peerDependencies: { left: '1.0.0' } });
    lock.packages['']!.peerDependencies = { left: '1.0.0' };
    // A name declared as both dependency and peer is outside the bounded profile.
    delete (manifest.dependencies as Record<string, string>).left;
    delete lock.packages['']!.dependencies!.left;
  }
  if (kind === 'scoped-peer') {
    const oldPath = 'node_modules/left/node_modules/shared';
    lock.packages['node_modules/left/node_modules/@scope/shared'] = npmPackage('@scope/shared', '1.0.0');
    delete lock.packages[oldPath];
    delete left.dependencies!.shared;
    left.dependencies!['@scope/shared'] = '1.0.0';
    plugin.peerDependencies = { '@scope/shared': '1.0.0' };
  }
  if (kind === 'same-artifact-hosts') {
    lock.packages['node_modules/right']!.dependencies = { shared: '1.0.0', plugin: '1.0.0' };
    lock.packages['node_modules/right/node_modules/shared'] = npmPackage('shared', '1.0.0');
    lock.packages['node_modules/right/node_modules/plugin'] = structuredClone(plugin);
  }
  return npmRequest(manifest, lock);
}
export function npmRequest(manifest: unknown, lock: unknown) {
  return { profile: 'npm-lock-v3-topology-v1' as const, npmVersion: '11.19.1',
    policy: 'literal-sources-required-peers-v1',
    manifest: npmBytes(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)),
    lock: npmBytes(typeof lock === 'string' ? lock : JSON.stringify(lock)) };
}
