import { createHash } from 'node:crypto';
import type { NpmRegistryOutcome, NpmRegistryRequest } from '../../../services/main/src/modules/package/npm-registry.ts';
import type { NpmDivergenceKind, NpmDivergenceReport } from '../../../services/main/src/modules/package/npm-divergence.ts';

export function npmBytes(value: unknown): { bytesBase64: string; sha256: string } {
  const bytes = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return { bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
}
export interface NpmRegistryScenario {
  name: string; strategy?: string; artifacts?: NpmRegistryRequest['artifacts'];
  manifest: Record<string, unknown>; workspaces?: Array<{ path: string; manifest: Record<string, unknown> }>;
  /** False when running npm would leave the loopback snapshot (for example a hosted Git spec). */
  native: boolean;
  expect: { status: NpmRegistryOutcome['status']; correspondence: NpmDivergenceReport['correspondence'] | null;
    allowedDivergences: NpmDivergenceKind[] };
}
export function npmRegistryRequest(scenario: NpmRegistryScenario): NpmRegistryRequest {
  return { profile: 'npm-registry-range-v1', npmVersion: '11.19.1', policy: 'npm-strict-peers-advisory-engines-v1',
    strategy: scenario.strategy ?? 'npm-hoisted', registry: 'https://registry.npmjs.org/',
    target: { os: 'linux', cpu: 'x64' }, engineTarget: { nodeVersion: '26.8.2', npmVersion: '11.19.1' },
    artifacts: scenario.artifacts ?? 'verify-sri', manifest: npmBytes(scenario.manifest),
    workspaces: (scenario.workspaces ?? []).map(item => ({ path: item.path, manifest: npmBytes(item.manifest) })) };
}
const solved = { status: 'solved' as const, correspondence: 'identical' as const, allowedDivergences: [] };
const failed = (status: NpmRegistryOutcome['status']) => ({ status, correspondence: 'both-failed' as const,
  allowedDivergences: [] });

/** Live scenarios use long-published packages whose current ranges still exercise each semantic. */
export const npmRegistryLiveScenarios: NpmRegistryScenario[] = [
  { name: 'nested-incompatible', native: true, expect: solved,
    manifest: { name: 'pkg03-nested', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1', 'is-even': '^1.0.0' } } },
  { name: 'nested-peer-host', native: true, expect: solved,
    manifest: { name: 'pkg03-peer-host', version: '1.0.0', dependencies: { ajv: '^8.12.0', 'schema-utils': '^2.7.1' } } },
  { name: 'root-peer-conflict', native: true, expect: failed('unsatisfiable'),
    manifest: { name: 'pkg03-peer-conflict', version: '1.0.0', dependencies: { ajv: '^8.12.0', 'ajv-keywords': '^3.5.2' } } },
  { name: 'optional-platform', native: true, expect: solved,
    manifest: { name: 'pkg04-optional', version: '1.0.0', dependencies: { chokidar: '3.6.0' } } },
  { name: 'alias-slots', native: true, expect: solved,
    manifest: { name: 'pkg04-alias', version: '1.0.0', dependencies: { 'is-number': '^7.0.0', num6: 'npm:is-number@^6.0.0' } } },
  { name: 'workspaces', native: true, expect: solved,
    manifest: { name: 'pkg04-workspaces', version: '1.0.0', private: true, workspaces: ['packages/*'] },
    workspaces: [
      { path: 'packages/a', manifest: { name: 'ws-a', version: '1.0.0',
        dependencies: { 'is-number': '^7.0.0', 'ws-b': '^1.0.0' } } },
      { path: 'packages/b', manifest: { name: 'ws-b', version: '1.2.0', dependencies: { 'is-number': '^6.0.0' },
        devDependencies: { 'is-odd': '^3.0.1' } } },
    ] },
  { name: 'flat-override', native: true, expect: solved,
    manifest: { name: 'pkg04-override', version: '1.0.0', dependencies: { 'is-even': '^1.0.0' },
      overrides: { 'is-number': '^7.0.0' } } },
  { name: 'dev-tag', native: true, expect: solved,
    manifest: { name: 'pkg04-dev-tag', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1' },
      devDependencies: { 'is-number': 'latest' } } },
  { name: 'strategy-nested', strategy: 'npm-nested', native: true, expect: solved,
    manifest: { name: 'pkg04-nested', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1', 'is-even': '^1.0.0' } } },
  { name: 'strategy-shallow', strategy: 'npm-shallow', native: true, expect: solved,
    manifest: { name: 'pkg04-shallow', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1', 'is-even': '^1.0.0' } } },
  { name: 'no-matching-version', native: true, expect: failed('unsatisfiable'),
    manifest: { name: 'pkg03-etarget', version: '1.0.0', dependencies: { 'is-number': '^99.0.0' } } },
  { name: 'unpublished-package', native: true, expect: failed('incomplete-source-data'),
    manifest: { name: 'pkg03-e404', version: '1.0.0', dependencies: { 'rezics-g074-unpublished-package-zz': '^1.0.0' } } },
  { name: 'pnpm-strategy', strategy: 'pnpm-isolated', native: false,
    expect: { status: 'unsupported-semantics', correspondence: null, allowedDivergences: [] },
    manifest: { name: 'pkg04-pnpm', version: '1.0.0', dependencies: { 'is-odd': '^3.0.1' } } },
  { name: 'hosted-git-spec', native: false,
    expect: { status: 'unsupported-semantics', correspondence: null, allowedDivergences: [] },
    manifest: { name: 'pkg04-git', version: '1.0.0', dependencies: { 'is-odd': 'github:jonschlinkert/is-odd' } } },
];
