import { describe, expect, test } from 'bun:test';
import { NpmResolutionInvalid, npmSha, npmStable } from '../../../services/main/src/modules/package/npm-lock.ts';
import { admitNpmRegistryRequest, pickNpmManifest, projectNpmPackument, type NpmRegistryOutcome,
  type NpmRegistryRequest, type NpmRegistrySnapshot } from '../../../services/main/src/modules/package/npm-registry.ts';
import { NpmRegistryCancelled, resolveNpmRegistry, revalidateNpmRegistry }
  from '../../../services/main/src/modules/package/npm-registry-capture.ts';
import { explainNpmDivergence, npmFamilyStrategyStatus, type NpmNativeObservation }
  from '../../../services/main/src/modules/package/npm-divergence.ts';
import { compareNpmVersions, npmSatisfiesText, parseNpmVersion }
  from '../../../services/main/src/modules/package/npm-semver.ts';
import { npmBytes, npmRegistryLiveScenarios, npmRegistryRequest } from '../fixtures/npm-registry-scenarios.ts';
import { syntheticNpmFetcher, syntheticPackument, syntheticTarball, type SyntheticNpmFaults,
  type SyntheticNpmRegistry } from '../fixtures/npm-registry-synthetic.ts';
import live from '../fixtures/npm-registry-live.json';

type LiveEntry = { request: NpmRegistryRequest; requestDigest: string; outcomeDigest: string;
  status: NpmRegistryOutcome['status']; snapshot: NpmRegistrySnapshot; native: NpmNativeObservation | null;
  correspondence: string | null };
const frozen = live as unknown as Record<string, LiveEntry>;

function request(manifest: Record<string, unknown>, extra: Partial<NpmRegistryRequest> = {}): NpmRegistryRequest {
  return { ...npmRegistryRequest({ name: 'unit', manifest, native: false,
    expect: { status: 'solved', correspondence: null, allowedDivergences: [] } }), ...extra };
}
async function solve(registry: SyntheticNpmRegistry, manifest: Record<string, unknown>,
  extra: Partial<NpmRegistryRequest> = {}, faults: SyntheticNpmFaults = {}) {
  const { fetcher, requests } = syntheticNpmFetcher(registry, faults);
  const body = request(manifest, extra);
  const digest = npmSha(npmStable(body));
  const outcome = await resolveNpmRegistry(body, digest, { fetcher });
  // Every receipt is reproducible offline from its retained snapshot, with no provider access.
  expect(npmStable(await revalidateNpmRegistry(body, digest, outcome.sourceSnapshot))).toBe(npmStable(outcome));
  return { outcome, requests, body };
}
const paths = (outcome: NpmRegistryOutcome) => Object.fromEntries(outcome.instances
  .filter(item => item.kind !== 'root').map(item => [item.path, item.version]));

const chain: SyntheticNpmRegistry = {
  a: { versions: { '1.0.0': { deps: { c: '^1.0.0' } } } },
  b: { versions: { '1.0.0': { deps: { c: '^2.0.0' } } } },
  c: { tags: { latest: '2.1.0' }, versions: { '1.0.0': {}, '1.4.0': {}, '2.0.0': {}, '2.1.0': {}, '3.0.0-beta.1': {} } },
};

describe('npm registry range profile', () => {
  test('PKG03/PKG12: frozen live snapshots replay offline and keep their native npm correspondence', async () => {
    const names = npmRegistryLiveScenarios.map(item => item.name).sort();
    expect(Object.keys(frozen).sort()).toEqual(names);
    for (const scenario of npmRegistryLiveScenarios) {
      const entry = frozen[scenario.name]!;
      expect(npmSha(npmStable(entry.request))).toBe(entry.requestDigest);
      const outcome = await revalidateNpmRegistry(entry.request, entry.requestDigest, entry.snapshot);
      expect([scenario.name, outcome.status]).toEqual([scenario.name, scenario.expect.status]);
      expect(npmSha(npmStable(outcome))).toBe(entry.outcomeDigest);
      if (!entry.native) continue;
      const report = explainNpmDivergence(outcome, entry.native);
      expect([scenario.name, report.correspondence]).toEqual([scenario.name, scenario.expect.correspondence]);
      expect(report.divergences).toEqual([]);
    }
    const nested = frozen['nested-incompatible']!;
    const solved = await revalidateNpmRegistry(nested.request, nested.requestDigest, nested.snapshot);
    expect(paths(solved)).toMatchObject({ 'node_modules/is-even/node_modules/is-number': expect.stringMatching(/^3\./),
      'node_modules/is-number': expect.stringMatching(/^6\./) });
    const peers = await revalidateNpmRegistry(frozen['nested-peer-host']!.request, frozen['nested-peer-host']!.requestDigest,
      frozen['nested-peer-host']!.snapshot);
    const keywords = peers.instances.find(item => item.path === 'node_modules/schema-utils/node_modules/ajv-keywords')!;
    expect(keywords.peerHosts).toEqual([{ name: 'ajv', spec: '^6.9.1', optional: false,
      hostPath: 'node_modules/schema-utils/node_modules/ajv' }]);
    expect(peers.instances.find(item => item.path === 'node_modules/ajv')!.version).toMatch(/^8\./);
    expect(peers.artifactVerification).toBe('verified');
    expect(peers.sourceSnapshot.artifacts.every(item => item.status === 'verified')).toBe(true);
    const optional = frozen['optional-platform']!;
    const platform = await revalidateNpmRegistry(optional.request, optional.requestDigest, optional.snapshot);
    const fsevents = platform.instances.find(item => item.name === 'fsevents')!;
    expect(fsevents).toMatchObject({ optional: true, active: false });
    expect(platform.omitted).toEqual([{ id: fsevents.id, path: fsevents.path, reason: 'platform', causePath: fsevents.path }]);
    expect(platform.sourceSnapshot.artifacts.some(item => item.name === 'fsevents')).toBe(false);
  });

  test('PKG12: a different npm-family layout over the same snapshot is logical correspondence with explained layout', async () => {
    const entry = frozen['nested-incompatible']!;
    const nested = { ...entry.request, strategy: 'npm-nested' };
    const digest = npmSha(npmStable(nested));
    const outcome = await revalidateNpmRegistry(nested, digest, entry.snapshot);
    const report = explainNpmDivergence(outcome, entry.native!);
    expect(report.correspondence).toBe('logical');
    expect(report.divergences.length).toBeGreaterThan(0);
    expect(new Set(report.divergences.map(item => item.kind))).toEqual(new Set(['layout']));
    expect(report.divergences.find(item => item.path === 'node_modules/is-odd/node_modules/is-number')).toEqual({
      kind: 'layout', path: 'node_modules/is-odd/node_modules/is-number', name: 'is-number',
      rezics: expect.stringMatching(/^is-number@6\./), native: null,
      explanation: 'npm installs the same logical instance at another path (hoisting difference only)' });
    expect(report.divergences.find(item => item.path === 'node_modules/is-number')).toMatchObject({ rezics: null,
      explanation: 'REZICS installs the same logical instance at another path (hoisting difference only)' });
    expect(report.logicalInstances.shared).toBe(report.logicalInstances.native);
  });

  test('PKG12: selection, source, flag, failure-class and stricter-admission divergences are explained', async () => {
    const entry = frozen['nested-incompatible']!;
    const outcome = await revalidateNpmRegistry(entry.request, entry.requestDigest, entry.snapshot);
    const lock = structuredClone((entry.native as Extract<NpmNativeObservation, { status: 'solved' }>).lock);
    const top = lock.packages['node_modules/is-number']!;
    lock.packages['node_modules/is-number'] = { ...top, version: '6.0.1-native', dev: true };
    const selection = explainNpmDivergence(outcome, { status: 'solved', lock });
    expect(selection.correspondence).toBe('divergent');
    expect(selection.divergences.find(item => item.path === 'node_modules/is-number')).toMatchObject({ kind: 'selection',
      explanation: expect.stringContaining('by highest-satisfying; npm placed 6.0.1-native here') });
    expect(selection.divergences.find(item => item.path === 'node_modules/is-odd')).toMatchObject({ kind: 'selection',
      explanation: expect.stringContaining('resolves is-number to is-number@6.') });
    const flags = structuredClone((entry.native as Extract<NpmNativeObservation, { status: 'solved' }>).lock);
    flags.packages['node_modules/is-odd'] = { ...flags.packages['node_modules/is-odd']!, dev: true,
      integrity: 'sha512-other' };
    const flagged = explainNpmDivergence(outcome, { status: 'solved', lock: flags });
    expect(flagged.divergences.map(item => item.kind).sort()).toEqual(['flags', 'source']);
    const conflict = frozen['root-peer-conflict']!;
    const unsat = await revalidateNpmRegistry(conflict.request, conflict.requestDigest, conflict.snapshot);
    expect(explainNpmDivergence(unsat, { status: 'failed', code: 'ERESOLVE' }).correspondence).toBe('both-failed');
    expect(explainNpmDivergence(unsat, { status: 'failed', code: 'E404' }).divergences[0]).toMatchObject({
      kind: 'failure-class', rezics: 'unsatisfiable:peer-conflict', native: 'E404' });
    const pnpm = frozen['pnpm-strategy']!;
    const refused = await revalidateNpmRegistry(pnpm.request, pnpm.requestDigest, pnpm.snapshot);
    expect(explainNpmDivergence(refused, { status: 'solved', lock }).divergences[0]).toMatchObject({
      kind: 'stricter-admission', rezics: 'unsupported-semantics:strategy:pnpm-isolated' });
  });

  test('PKG03: node-semver ranges, prerelease tuples and npm manifest ordering', () => {
    const cases: Array<[string, string, boolean]> = [
      ['1.2.3', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
      ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false],
      ['1.9.0', '1.x', true], ['2.0.0', '1.x || >=3.0.0', false], ['3.1.0', '1.x || >=3.0.0', true],
      ['1.5.0', '1.2 - 1.6', true], ['1.6.9', '1.2 - 1.6', true], ['1.7.0', '1.2 - 1.6', false],
      ['1.2.3-beta.2', '>=1.2.3-beta.1', true], ['1.2.4-beta.2', '>=1.2.3-beta.1', false], ['2.0.0-0', '<2.0.0', false],
      ['1.0.0', '*', true], ['1.0.0-rc.1', '*', false], ['4.0.0', '>= 3.0.0 < 5', true], ['5.0.0', '< 5', false],
      ['1.2.3', '=1.2.3', true], ['1.2.3', 'v1.2.3', true], ['0.0.0', '<1', true], ['1.0.0', '<=1', true], ['2.0.0', '<=1', false],
    ];
    for (const [version, range, expected] of cases) expect([version, range, npmSatisfiesText(version, range)]).toEqual([version, range, expected]);
    expect(compareNpmVersions(parseNpmVersion('1.0.0-alpha.1')!, parseNpmVersion('1.0.0-alpha.beta')!)).toBe(-1);
    expect(compareNpmVersions(parseNpmVersion('1.0.0')!, parseNpmVersion('1.0.0-rc.1')!)).toBe(1);
    const registry: SyntheticNpmRegistry = { p: { tags: { latest: '1.1.0', next: '2.0.0-rc.1' }, versions: {
      '1.0.0': {}, '1.1.0': {}, '1.2.0': { deprecated: 'no' }, '1.3.0': { engines: { node: '<10' } }, '2.0.0-rc.1': {} } } };
    const packument = projectNpmPackument('p', Buffer.from(syntheticPackument('p', registry)));
    const engine = { nodeVersion: '26.8.2', npmVersion: '11.19.1' };
    const pick = (value: string, type: 'range' | 'version' | 'tag' = 'range') =>
      pickNpmManifest(packument, { type, value, packageName: 'p', alias: false }, engine);
    expect(pick('^1.0.0')).toMatchObject({ record: { version: '1.1.0' }, reason: 'latest-tag',
      higherSatisfying: ['1.2.0', '1.3.0'] });
    expect(pick('>=1.2.0 <2')).toMatchObject({ record: { version: '1.2.0' }, reason: 'engine-or-deprecation-preference',
      higherSatisfying: ['1.3.0'] });
    expect(pick('1.3.0', 'version')).toMatchObject({ record: { version: '1.3.0' }, reason: 'exact-version' });
    expect(pick('next', 'tag')).toMatchObject({ record: { version: '2.0.0-rc.1' }, reason: 'dist-tag' });
    expect(pick('^2.0.0')).toBeNull();
  });

  test('PKG03: nested incompatible ranges keep distinct scoped instances and lazily fetch only reached packages', async () => {
    const registry = { ...chain, unrelated: { versions: { '9.9.9': {} } } };
    const { outcome, requests } = await solve(registry, { name: 'root', version: '1.0.0', dependencies: { a: '^1.0.0', b: '^1.0.0' } });
    expect(outcome.status).toBe('solved');
    expect(paths(outcome)).toEqual({ 'node_modules/a': '1.0.0', 'node_modules/b': '1.0.0',
      'node_modules/c': '1.4.0', 'node_modules/b/node_modules/c': '2.1.0' });
    expect(requests.filter(url => !url.endsWith('.tgz')).sort()).toEqual(['a', 'b', 'c']
      .map(name => `https://registry.npmjs.org/${name}`));
    expect(requests.filter(url => url.endsWith('.tgz'))).toHaveLength(4);
    expect(outcome.sourceSnapshot.packuments.find(item => item.name === 'c')!.records.map(item => item.version).sort())
      .toEqual(['1.0.0', '1.4.0', '2.0.0', '2.1.0']);
    expect(outcome.edges.find(edge => edge.from === 'node_modules/b' && edge.name === 'c'))
      .toMatchObject({ to: 'node_modules/b/node_modules/c', valid: true });
    const other = await solve(registry, { name: 'root2', version: '1.0.0', dependencies: { a: '^1.0.0', b: '^1.0.0' } });
    expect(other.outcome.resolutionId).not.toBe(outcome.resolutionId);
    expect(new Set(other.outcome.instances.map(item => item.id)).isDisjointFrom(new Set(outcome.instances.map(item => item.id)))).toBe(true);
  });

  test('PKG03: strict peer sets use the nearest host scope or fail instead of collapsing names', async () => {
    const registry: SyntheticNpmRegistry = {
      host: { versions: { '1.0.0': {}, '2.0.0': {} } },
      plugin: { versions: { '1.0.0': { peers: { host: '^1.0.0' } } } },
      wrapper: { versions: { '1.0.0': { deps: { host: '^1.0.0', plugin: '^1.0.0' } } } },
      lonely: { versions: { '1.0.0': { deps: { plugin: '^1.0.0' } } } },
    };
    const nested = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { host: '^2.0.0', wrapper: '^1.0.0' } });
    expect(paths(nested.outcome)).toEqual({ 'node_modules/host': '2.0.0', 'node_modules/wrapper': '1.0.0',
      'node_modules/wrapper/node_modules/host': '1.0.0', 'node_modules/wrapper/node_modules/plugin': '1.0.0' });
    expect(nested.outcome.instances.find(item => item.name === 'plugin')!.peerHosts[0]!.hostPath)
      .toBe('node_modules/wrapper/node_modules/host');
    const conflict = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { host: '^2.0.0', plugin: '^1.0.0' } });
    expect(conflict.outcome).toMatchObject({ status: 'unsatisfiable', instances: [], edges: [],
      conflict: { kind: 'peer-conflict', name: 'host', spec: '^1.0.0' } });
    const autoPeer = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { lonely: '^1.0.0' } });
    expect(paths(autoPeer.outcome)).toEqual({ 'node_modules/lonely': '1.0.0', 'node_modules/plugin': '1.0.0',
      'node_modules/host': '1.0.0' });
    expect(autoPeer.outcome.instances.find(item => item.name === 'host')).toMatchObject({ peer: true });
  });

  test('PKG04: optional platform regions, aliases, workspaces, overrides and strategies keep native semantics', async () => {
    const registry: SyntheticNpmRegistry = {
      native: { versions: { '1.0.0': { os: ['darwin'], deps: { helper: '^1.0.0' } } } },
      helper: { versions: { '1.0.0': {} } },
      tool: { versions: { '1.0.0': { optional: { native: '^1.0.0' }, deps: { shared: '^1.0.0' } } } },
      shared: { versions: { '1.0.0': {}, '2.0.0': {} } },
      needs: { versions: { '1.0.0': { deps: { shared: '^1.0.0' } } } },
      missing: { versions: { '1.0.0': {} } },
    };
    const optional = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { tool: '1.0.0' },
      optionalDependencies: { missing: '^9.0.0' } });
    expect(optional.outcome.status).toBe('solved');
    expect(optional.outcome.omitted.map(item => [item.path, item.causePath])).toEqual([
      ['node_modules/helper', 'node_modules/native'], ['node_modules/native', 'node_modules/native']]);
    expect(optional.outcome.edges.find(edge => edge.from === '' && edge.name === 'missing'))
      .toMatchObject({ to: null, valid: false, type: 'optional' });
    expect(optional.outcome.sourceSnapshot.artifacts.map(item => item.name).sort()).toEqual(['shared', 'tool']);
    const required = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { native: '^1.0.0' } });
    expect(required.outcome).toMatchObject({ status: 'unsatisfiable', conflict: { kind: 'platform', path: 'node_modules/native' } });
    const darwin = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { native: '^1.0.0' } },
      { target: { os: 'darwin', cpu: 'arm64' } });
    expect(darwin.outcome.status).toBe('solved');
    const alias = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { shared: '^2.0.0', old: 'npm:shared@^1.0.0' } });
    expect(alias.outcome.instances.find(item => item.path === 'node_modules/old')).toMatchObject({ name: 'shared',
      slotName: 'old', version: '1.0.0' });
    const override = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { needs: '^1.0.0' },
      overrides: { shared: '^2.0.0' } });
    expect(override.outcome.edges.find(edge => edge.name === 'shared')).toMatchObject({ spec: '^1.0.0',
      effectiveSpec: '^2.0.0', to: 'node_modules/shared' });
    expect(paths(override.outcome)['node_modules/shared']).toBe('2.0.0');
    const eoverride = await solve(registry, { name: 'r', version: '1.0.0', dependencies: { shared: '^1.0.0' },
      overrides: { shared: '^2.0.0' } });
    expect(eoverride.outcome).toMatchObject({ status: 'unsupported-semantics',
      unsupportedClauses: ['override:direct-conflict-EOVERRIDE'] });
    const workspaces = await solve(registry, { name: 'r', version: '1.0.0', workspaces: ['packages/*', 'tools/cli'] }, {
      workspaces: [
        { path: 'packages/a', manifest: npmBytes({ name: 'wa', version: '1.0.0', dependencies: { shared: '^2.0.0', wb: '^1.0.0' } }) },
        { path: 'packages/b', manifest: npmBytes({ name: 'wb', version: '1.1.0', dependencies: { shared: '^1.0.0' } }) },
        { path: 'tools/cli', manifest: npmBytes({ name: 'cli', version: '0.1.0', devDependencies: { needs: '^1.0.0' } }) },
      ] });
    expect(paths(workspaces.outcome)).toEqual({ 'node_modules/cli': '0.1.0', 'node_modules/needs': '1.0.0',
      'node_modules/shared': '2.0.0', 'node_modules/wa': '1.0.0', 'node_modules/wb': '1.1.0',
      'packages/a': '1.0.0', 'packages/b': '1.1.0', 'packages/b/node_modules/shared': '1.0.0',
      'node_modules/needs/node_modules/shared': '1.0.0', 'tools/cli': '0.1.0' });
    expect(workspaces.outcome.instances.find(item => item.path === 'node_modules/wb')).toMatchObject({ kind: 'link',
      linkTarget: 'packages/b' });
    expect(workspaces.outcome.instances.find(item => item.path === 'node_modules/needs')).toMatchObject({ dev: true });
    const missingWorkspace = await solve(registry, { name: 'r', version: '1.0.0', workspaces: ['packages/a'] });
    expect(missingWorkspace.outcome).toMatchObject({ status: 'incomplete-source-data', issues: [{ kind: 'missing-workspace' }] });
    const nested = await solve(chain, { name: 'r', version: '1.0.0', dependencies: { a: '^1.0.0' } }, { strategy: 'npm-nested' });
    expect(paths(nested.outcome)).toEqual({ 'node_modules/a': '1.0.0', 'node_modules/a/node_modules/c': '1.4.0' });
    for (const [strategy, status] of Object.entries(npmFamilyStrategyStatus)) {
      if (status !== 'unsupported-no-oracle') continue;
      const refused = await solve(chain, { name: 'r', version: '1.0.0', dependencies: { a: '^1.0.0' } }, { strategy });
      expect(refused.outcome).toMatchObject({ status: 'unsupported-semantics', unsupportedClauses: [`strategy:${strategy}`] });
      expect(refused.requests).toEqual([]);
    }
  });

  test('PKG03/PKG13: unavailable, malformed, unsatisfiable, unsupported and budget outcomes stay distinct', async () => {
    const root = { name: 'r', version: '1.0.0', dependencies: { a: '^1.0.0', b: '^1.0.0' } };
    const unavailable = await solve(chain, root, {}, { unavailable: new Set(['c']) });
    expect(unavailable.outcome).toMatchObject({ status: 'incomplete-source-data', instances: [],
      issues: [{ kind: 'unavailable-packument', name: 'c' }] });
    const absent = await solve(chain, { name: 'r', version: '1.0.0', dependencies: { ghost: '^1.0.0' } });
    expect(absent.outcome).toMatchObject({ status: 'incomplete-source-data', issues: [{ name: 'ghost',
      detail: 'package is not published' }] });
    // npm skips an inaccessible optional dependency; REZICS keeps it as missing evidence, not an empty set.
    const optionalAbsent = await solve(chain, { name: 'r', version: '1.0.0', optionalDependencies: { ghost: '^1.0.0' } });
    expect(optionalAbsent.outcome.status).toBe('incomplete-source-data');
    const malformed = await solve(chain, root, {}, { malformed: new Set(['c']) });
    expect(malformed.outcome).toMatchObject({ status: 'inconsistent-source-data', issues: [{ kind: 'malformed-packument' }] });
    const etarget = await solve(chain, { name: 'r', version: '1.0.0', dependencies: { c: '^9.0.0' } });
    expect(etarget.outcome).toMatchObject({ status: 'unsatisfiable', conflict: { kind: 'no-matching-version', candidates: ['2.1.0'] } });
    const git = await solve(chain, { name: 'r', version: '1.0.0', dependencies: { a: 'git+https://example.test/a.git' } });
    expect(git.outcome).toMatchObject({ status: 'unsupported-semantics', unsupportedClauses: ['spec:git+https'] });
    expect(git.requests).toEqual([]);
    const libc = await solve({ l: { versions: { '1.0.0': { libc: ['glibc'] } } } }, { name: 'r', version: '1.0.0',
      dependencies: { l: '^1.0.0' } });
    expect(libc.outcome.unsupportedClauses).toEqual(['registry:libc-selector']);
    const wide: SyntheticNpmRegistry = Object.fromEntries(Array.from({ length: 70 }, (_, index) =>
      [`p${index}`, { versions: { '1.0.0': index < 69 ? { deps: { [`p${index + 1}`]: '^1.0.0' } } : {} } }]));
    const budget = await solve(wide, { name: 'r', version: '1.0.0', dependencies: { p0: '^1.0.0' } }, { artifacts: 'metadata-only' });
    expect(budget.outcome).toMatchObject({ status: 'budget-exhausted', budgetReason: 'packument count limit', instances: [] });
    expect(budget.requests).toHaveLength(64);
    let clock = 0;
    const slow = syntheticNpmFetcher(chain);
    const timed = request(root);
    const deadline = await resolveNpmRegistry(timed, 'digest', { fetcher: async (input, init) => {
      clock += 40_000;
      return slow.fetcher(input, init);
    }, now: () => clock });
    expect(deadline).toMatchObject({ status: 'budget-exhausted', budgetReason: 'capture deadline' });
    expect(deadline.sourceSnapshot.deadlineExceeded).toBe('c');
    expect(npmStable(await revalidateNpmRegistry(timed, 'digest', deadline.sourceSnapshot))).toBe(npmStable(deadline));
    const controller = new AbortController();
    controller.abort();
    await expect(resolveNpmRegistry(request(root), 'digest', { fetcher: slow.fetcher, signal: controller.signal }))
      .rejects.toBeInstanceOf(NpmRegistryCancelled);
    expect(() => admitNpmRegistryRequest({ ...request(root), manifest: { bytesBase64: 'e30=', sha256: '0'.repeat(64) } }))
      .toThrow(NpmResolutionInvalid);
    expect(() => admitNpmRegistryRequest({ ...request(root), engineTarget: { nodeVersion: 'v26', npmVersion: '11' } }))
      .toThrow(NpmResolutionInvalid);
    expect(() => admitNpmRegistryRequest(request(root, { workspaces: [{ path: 'packages/a',
      manifest: npmBytes({ name: 'a', version: '1.0.0' }) }] }))).toThrow(NpmResolutionInvalid);
    expect(() => admitNpmRegistryRequest(request({ ...root, dependencies: { a: 'git+https://example.test/a.git' } })))
      .not.toThrow();
  });

  test('PKG03: selected tarballs are fetched from the fixed origin and checked against registry SRI', async () => {
    const root = { name: 'r', version: '1.0.0', dependencies: { a: '^1.0.0', b: '^1.0.0' } };
    const verified = await solve(chain, root);
    expect(verified.outcome.artifactVerification).toBe('verified');
    expect(verified.outcome.sourceSnapshot.artifacts.map(item => [item.name, item.version, item.status, item.algorithm]))
      .toEqual([['a', '1.0.0', 'verified', 'sha512'], ['b', '1.0.0', 'verified', 'sha512'],
        ['c', '1.4.0', 'verified', 'sha512'], ['c', '2.1.0', 'verified', 'sha512']]);
    const tampered = await solve(chain, root, {}, { tamper: new Set([syntheticTarball('c', '2.1.0')]) });
    expect(tampered.outcome).toMatchObject({ status: 'inconsistent-source-data', artifactVerification: 'failed',
      instances: [], issues: [{ kind: 'integrity-mismatch', name: 'c', version: '2.1.0' }] });
    const missing = await solve(chain, root, {}, { missingTarballs: new Set([syntheticTarball('a', '1.0.0')]) });
    expect(missing.outcome).toMatchObject({ status: 'incomplete-source-data', issues: [{ kind: 'unavailable-artifact', name: 'a' }] });
    const oversized = await solve(chain, root, {}, { oversizedTarballs: new Set([syntheticTarball('b', '1.0.0')]) });
    expect(oversized.outcome).toMatchObject({ status: 'budget-exhausted', budgetReason: 'artifact byte limit' });
    const foreign = await solve({ x: { versions: { '1.0.0': { tarball: 'https://cdn.example.test/x-1.0.0.tgz' } } } },
      { name: 'r', version: '1.0.0', dependencies: { x: '^1.0.0' } });
    expect(foreign.outcome).toMatchObject({ status: 'unsupported-semantics', unsupportedClauses: ['artifact:origin'] });
    const noSri = await solve({ x: { versions: { '1.0.0': { integrity: null } } } },
      { name: 'r', version: '1.0.0', dependencies: { x: '^1.0.0' } });
    expect(noSri.outcome).toMatchObject({ status: 'incomplete-source-data', issues: [{ kind: 'unavailable-artifact' }] });
    const metadata = await solve(chain, root, { artifacts: 'metadata-only' });
    expect(metadata.outcome.artifactVerification).toBe('not-requested');
    expect(metadata.requests.some(url => url.endsWith('.tgz'))).toBe(false);
  });

  test('PKG03/PKG19: provider requests and solver work grow with reached packages, not unrelated versions or names', async () => {
    const measure = async (width: number, unrelatedVersions: number) => {
      const registry: SyntheticNpmRegistry = Object.fromEntries([
        ...Array.from({ length: width }, (_, index) => [`leaf${index}`, { tags: { latest: '1.0.0' }, versions: Object.fromEntries([
          ['1.0.0', {}], ...Array.from({ length: unrelatedVersions }, (_, v) => [`0.${v}.0`, {}])]) }]),
        ...Array.from({ length: 200 }, (_, index) => [`noise${index}`, { versions: { '1.0.0': {} } }]),
      ]);
      const dependencies = Object.fromEntries(Array.from({ length: width }, (_, index) => [`leaf${index}`, '^1.0.0']));
      const { outcome, requests } = await solve(registry, { name: 'r', version: '1.0.0', dependencies }, { artifacts: 'metadata-only' });
      expect(outcome.status).toBe('solved');
      return { requests: requests.length, ...outcome.cost };
    };
    const small = await measure(8, 0);
    const noisy = await measure(8, 400);
    const large = await measure(32, 0);
    expect(noisy.requests).toBe(small.requests);
    expect(noisy.placementChecks).toBe(small.placementChecks);
    expect(noisy.retainedRecords).toBe(small.retainedRecords);
    expect([small.requests, large.requests]).toEqual([8, 32]);
    expect(large.placementChecks).toBe(4 * small.placementChecks);
    expect(large.lookups).toBeLessThanOrEqual(4 * small.lookups * 4 + 64);
    expect(large.nodes).toBe(33);
  });
});
