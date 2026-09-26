import { describe, expect, test } from 'bun:test';
import { cargoPlatformMatches, CargoCfgSyntax } from '../../../services/main/src/modules/package/cargo-cfg.ts';
import { cargoCompatibility, cargoRequirementMatches, parseCargoRequirement, parseCargoVersion }
  from '../../../services/main/src/modules/package/cargo-semver.ts';
import { CargoSolveInvalid, solveCargoRegistry, type CargoSolveInput, type CargoSolveOutcome }
  from '../../../services/main/src/modules/package/cargo-solver.ts';
import { CARGO_LIVE_HOST, CARGO_LIVE_REGISTRY, CARGO_LIVE_SCENARIOS, type CargoLiveScenario }
  from '../fixtures/cargo-live-scenarios.ts';
import { cargoLiveIndex, cargoLiveProcMacros, cargoNativeRecord, cargoNativeView }
  from '../fixtures/cargo-live-snapshot.ts';
import { CARGO_SYNTHETIC_PROC_MACROS, CARGO_SYNTHETIC_SCENARIOS, cargoSyntheticIndex }
  from '../fixtures/cargo-synthetic-registry.ts';

const live = cargoLiveIndex();
const liveProcMacros = cargoLiveProcMacros();
const native = cargoNativeRecord();
const scenario = (id: string) => [...CARGO_LIVE_SCENARIOS, ...CARGO_SYNTHETIC_SCENARIOS]
  .find(item => item.id === id)!;
const encoder = new TextEncoder();

function request(item: CargoLiveScenario, variant = item.variants[0]!,
  files: Map<string, Uint8Array> = item.id.startsWith('synthetic') ? cargoSyntheticIndex() : live,
  extra: Partial<CargoSolveInput> = {}): CargoSolveInput {
  return { registryIndexUrl: CARGO_LIVE_REGISTRY, manifest: item.manifest, host: CARGO_LIVE_HOST,
    target: variant.target, features: variant.features, defaultFeatures: variant.defaultFeatures,
    includeDev: variant.includeDev,
    procMacros: item.id.startsWith('synthetic') ? CARGO_SYNTHETIC_PROC_MACROS : liveProcMacros,
    loadIndex: async name => files.get(name) ?? null, ...extra };
}
async function compareNative(id: string): Promise<CargoSolveOutcome[]> {
  const item = scenario(id);
  const outcomes: CargoSolveOutcome[] = [];
  for (const variant of item.variants) {
    const outcome = await solveCargoRegistry(request(item, variant));
    const { error: _error, ...expected } = native[`${id}/${variant.label}`]!;
    expect(cargoNativeView(outcome)).toEqual(expected);
    outcomes.push(outcome);
  }
  return outcomes;
}

function line(name: string, vers: string, deps: Array<{ name: string; req: string }> = [],
  extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, vers, deps: deps.map(dep => ({ features: [], optional: false,
    default_features: true, target: null, kind: 'normal', registry: null, package: null, ...dep })),
  cksum: 'a'.repeat(64), features: {}, yanked: false, ...extra });
}
function files(entries: Record<string, string[]>): Map<string, Uint8Array> {
  return new Map(Object.entries(entries).map(([name, lines]) =>
    [name, encoder.encode(`${lines.join('\n')}\n`)]));
}
function manifest(deps: string): string {
  return `[package]\nname = "synthetic-root"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${deps}\n`;
}
function synthetic(deps: string, index: Map<string, Uint8Array>,
  extra: Partial<CargoSolveInput> = {}): Promise<CargoSolveOutcome> {
  return solveCargoRegistry({ registryIndexUrl: CARGO_LIVE_REGISTRY, manifest: manifest(deps),
    host: CARGO_LIVE_HOST, target: CARGO_LIVE_HOST, features: [], defaultFeatures: true,
    includeDev: false, procMacros: [], loadIndex: async name => index.get(name) ?? null, ...extra });
}
// Every p_i has two candidates; c's only candidates need a missing major of v.
// Chronological search must revisit every p_i combination before proving unsat.
function exponential(width: number): { deps: string; index: Map<string, Uint8Array> } {
  const entries: Record<string, string[]> = {
    c: [line('c', '1.0.0', [{ name: 'w', req: '=1.0.0' }]), line('c', '2.0.0', [{ name: 'w', req: '=2.0.0' }])],
    w: [line('w', '1.0.0', [{ name: 'v', req: '^5' }]), line('w', '2.0.0', [{ name: 'v', req: '^5' }])],
    v: [line('v', '1.0.0')],
  };
  const deps: string[] = [];
  for (let index = 0; index < width; index++) {
    entries[`p${index}`] = [line(`p${index}`, '1.0.0'), line(`p${index}`, '2.0.0')];
    deps.push(`p${index} = ">=1, <3"`);
  }
  return { deps: [...deps, 'c = ">=1, <3"'].join('\n'), index: files(entries) };
}

describe('Cargo registry solver', () => {
  test('PKG01: live crates.io resolver 2 feature, target and dev instances equal native Cargo 1.98.1', async () => {
    const outcomes = await compareNative('features-resolver2');
    const linux = outcomes[0]!;
    expect(linux.status).toBe('solved');
    expect(linux.resolver).toBe('2');
    // Build dependency cc and its libc run on the host with std; target libc stays feature-free.
    expect(linux.instances.filter(item => item.name === 'libc').map(item =>
      `${item.role}:${item.features.join(',')}`)).toEqual(['host:default,std', 'target:']);
    const windows = outcomes[4]!;
    expect(windows.instances.some(item => item.name === 'windows_x86_64_msvc')).toBe(true);
    expect(windows.instances.some(item => item.name === 'libc' && item.role === 'target')).toBe(false);
    const dev = outcomes[1]!;
    expect(dev.instances.find(item => item.name === 'serde_derive')?.role).toBe('host');
    expect(dev.procMacros.map(id => id.split('#')[1])).toContain('serde_derive@1.0.229');
    await compareNative('synthetic-resolver2');
  });

  test('PKG01: resolver 1 unifies features where resolver 2 separates host, target and platforms, as native Cargo does', async () => {
    const [unified] = await compareNative('features-resolver1');
    await compareNative('synthetic-resolver1');
    const [decoupled] = await compareNative('features-resolver2');
    const libc = (outcome: CargoSolveOutcome) => outcome.instances.filter(item => item.name === 'libc')
      .map(item => `${item.role}:${item.features.join(',')}`);
    expect(libc(unified!)).toEqual(['host:default,std', 'target:default,std']);
    expect(libc(decoupled!)).toEqual(['host:default,std', 'target:']);
    // The weak `opt2?/std` feature keeps opt2 in the lock but activates no instance.
    const weak = await solveCargoRegistry(request(scenario('synthetic-resolver2')));
    expect(weak.selected.map(item => item.name)).toContain('opt2');
    expect(weak.instances.some(item => item.name === 'opt2')).toBe(false);
  });

  test('PKG02: live semver backtracking, native links backtracking and yanked ranges select the native Cargo lock', async () => {
    const [semver] = await compareNative('semver-backtracking');
    expect(semver!.cost.backtracks).toBeGreaterThan(0);
    expect(semver!.selected.map(item => `${item.name}@${item.version}`)).toEqual(
      expect.arrayContaining(['serde@1.0.100', 'serde_json@1.0.144', 'itoa@1.0.4', 'shlex@1.0.0']));
    const [links] = await compareNative('links-backtracking');
    expect(links!.cost.backtracks).toBeGreaterThan(0);
    expect(links!.selected.map(item => `${item.name}@${item.version}`)).toEqual(
      expect.arrayContaining(['rusqlite@0.28.0', 'libsqlite3-sys@0.25.2']));
    const [yanked] = await compareNative('yanked-range');
    expect(yanked!.selected.find(item => item.name === 'cc')?.version).toBe('1.0.83');
  });

  test('PKG02: live compat-bucket, native-links and yanked conflicts are unsatisfiable with witnesses where native Cargo fails', async () => {
    const expected = { 'unsat-bucket': 'activated-incompatible', 'unsat-links': 'native-links',
      'unsat-yanked': 'no-matching-release' } as const;
    for (const [id, reason] of Object.entries(expected)) {
      const [outcome] = await compareNative(id);
      expect(native[`${id}/linux`]!.error).toContain('failed to select a version');
      expect(outcome!.status).toBe('unsatisfiable');
      expect(outcome!.conflicts.some(item => item.reason === reason)).toBe(true);
      expect(outcome!.missing).toEqual([]);
      expect(outcome!.selected).toEqual([]);
    }
    const yanked = await solveCargoRegistry(request(scenario('unsat-yanked')));
    expect(yanked.conflicts).toEqual([expect.objectContaining({ package: 'cc',
      requirement: '=1.0.84', matching: 1, reason: 'no-matching-release' })]);
  });

  test('PKG02: Cargo requirement semantics follow the semver crate', () => {
    const cases: Array<[string, string, boolean]> = [
      ['1.2.3', '1.9.0', true], ['1.2.3', '2.0.0', false], ['1.2.3', '1.2.2', false],
      ['0.2.3', '0.2.9', true], ['0.2.3', '0.3.0', false], ['0.0.3', '0.0.4', false],
      ['^0.0', '0.0.9', true], ['^0', '0.9.0', true], ['~1.2', '1.2.9', true],
      ['~1.2.3', '1.3.0', false], ['1.*', '1.9.9', true], ['1.2.*', '1.3.0', false],
      ['*', '3.0.0', true], ['*', '3.0.0-rc.1', false], ['>=1.2, <1.5', '1.4.9', true],
      ['>=1.2, <1.5', '1.5.0', false], ['>1.2', '1.2.9', false], ['>1.2', '1.3.0', true],
      ['<=1.2', '1.2.9', true], ['=1.2', '1.2.7', true], ['1.2.3-alpha.2', '1.2.3-alpha.10', true],
      ['1.2.3-alpha', '1.2.4-alpha', false], ['1.2.3-alpha', '1.2.3', true],
      ['>=1.0.0', '1.1.0-beta', false], ['1.0.0+build', '1.0.0+other', true],
    ];
    for (const [req, version, matches] of cases) {
      expect([req, version, cargoRequirementMatches(parseCargoRequirement(req),
        parseCargoVersion(version))]).toEqual([req, version, matches]);
    }
    expect(['1.4.2', '0.7.1', '0.0.9', '2.0.0-rc.1'].map(item =>
      cargoCompatibility(parseCargoVersion(item)))).toEqual(['1', '0.7', '0.0.9', '2']);
    expect(() => parseCargoRequirement('>=1.*')).toThrow();
    expect(() => parseCargoVersion('01.0.0')).toThrow();
    expect(cargoPlatformMatches('cfg(all(unix, target_pointer_width = "64", not(target_os = "macos")))',
      'x86_64-unknown-linux-gnu')).toBe(true);
    expect(cargoPlatformMatches('cfg(any())', 'x86_64-unknown-linux-gnu')).toBe(false);
    expect(cargoPlatformMatches('x86_64-pc-windows-msvc', 'x86_64-pc-windows-msvc')).toBe(true);
    expect(() => cargoPlatformMatches('cfg(all(unix)', 'x86_64-unknown-linux-gnu')).toThrow(CargoCfgSyntax);
  });

  test('PKG13: the same live snapshot yields unsatisfiable, incomplete and budget outcomes without a false unsat proof', async () => {
    const bucket = scenario('unsat-bucket');
    const unsat = await solveCargoRegistry(request(bucket));
    expect(unsat.status).toBe('unsatisfiable');
    const withoutSerde = new Map(live);
    withoutSerde.delete('serde');
    const incomplete = await solveCargoRegistry(request(bucket, undefined, withoutSerde));
    expect([incomplete.status, incomplete.missing, incomplete.conflicts])
      .toEqual(['incomplete-source-data', ['serde'], []]);
    // Data absent only on an explored failing branch still forbids an unsat proof.
    const links = scenario('unsat-links');
    const withoutHashlink = new Map(live);
    withoutHashlink.delete('hashlink');
    const branch = await solveCargoRegistry(request(links, undefined, withoutHashlink));
    expect([branch.status, branch.missing]).toEqual(['incomplete-source-data', ['hashlink']]);
    const steps = await solveCargoRegistry(request(scenario('semver-backtracking'), undefined, live,
      { limits: { maxSteps: 20 } }));
    expect([steps.status, steps.budget, steps.selected, steps.conflicts])
      .toEqual(['budget-exhausted', { kind: 'steps', limit: 20, used: 21 }, [], []]);
    let clock = 0;
    const timed = await solveCargoRegistry(request(scenario('semver-backtracking'), undefined, live,
      { now: () => clock++, deadline: 40 }));
    expect([timed.status, timed.budget?.kind]).toEqual(['budget-exhausted', 'time']);
    expect(new Set([unsat.status, incomplete.status, steps.status]).size).toBe(3);
  });

  test('PKG13: an exponential unsatisfiable search stays budget-exhausted until the budget admits the exhaustive proof', async () => {
    const observed: number[] = [];
    for (const width of [2, 4, 6]) {
      const { deps, index } = exponential(width);
      const outcome = await synthetic(deps, index);
      expect(outcome.status).toBe('unsatisfiable');
      expect(outcome.conflicts.map(item => `${item.requiredBy.split('#')[1]}:${item.reason}`))
        .toEqual(['w@1.0.0:no-matching-release', 'w@2.0.0:no-matching-release']);
      observed.push(outcome.cost.steps);
    }
    // Chronological backtracking doubles per independent binary choice: the counter observes it.
    expect(observed[1]! / observed[0]!).toBeGreaterThan(3);
    expect(observed[2]! / observed[1]!).toBeGreaterThan(3);
    const { deps, index } = exponential(14);
    const bounded = await synthetic(deps, index, { limits: { maxSteps: 2_000 } });
    expect([bounded.status, bounded.budget, bounded.conflicts])
      .toEqual(['budget-exhausted', { kind: 'steps', limit: 2_000, used: 2_001 }, []]);
  });

  test('PKG19: lazy loading reads only reachable index files as the unrelated universe grows', async () => {
    const item = scenario('features-resolver2');
    const variant = item.variants[1]!;
    const costs: unknown[] = [];
    for (const size of [100, 1_000, 10_000]) {
      const universe = new Map(live);
      for (let index = 0; index < size; index++) {
        universe.set(`unrelated-${index}`, encoder.encode(`${line(`unrelated-${index}`, '1.0.0',
          [{ name: 'serde', req: '^1' }])}\n`));
      }
      const requested: string[] = [];
      const outcome = await solveCargoRegistry(request(item, variant, universe, {
        loadIndex: async name => { requested.push(name); return universe.get(name) ?? null; } }));
      const { error: _error, ...expected } = native[`${item.id}/${variant.label}`]!;
      expect(cargoNativeView(outcome)).toEqual(expected);
      expect(requested.every(name => live.has(name))).toBe(true);
      expect(new Set(requested).size).toBe(requested.length);
      costs.push(outcome.cost);
    }
    expect(costs[1]).toEqual(costs[0]);
    expect(costs[2]).toEqual(costs[0]);
    expect((costs[0] as { indexFilesLoaded: number }).indexFilesLoaded).toBeLessThan(live.size);
  });

  test('PKG19: long version histories are parsed lazily with constant solver work', async () => {
    const costs: Array<CargoSolveOutcome['cost']> = [];
    for (const size of [100, 1_000, 10_000]) {
      const lines: string[] = [];
      for (let index = 0; index < size; index++) lines.push(line('wide', `1.${index}.0`));
      const outcome = await synthetic('wide = ">=1.50.0, <1.51.0"', files({ wide: lines }));
      expect(outcome.selected.map(pkg => pkg.version)).toEqual(['1.50.0']);
      costs.push(outcome.cost);
    }
    expect(costs.map(cost => [cost.steps, cost.releasesParsed, cost.indexFilesLoaded]))
      .toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
    expect(costs[2]!.indexBytesLoaded / costs[1]!.indexBytesLoaded).toBeLessThan(11);
  });

  test('PKG19: cancellation stops loading and reports cancelled without a graph', async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    let loads = 0;
    const outcome = await solveCargoRegistry(request(scenario('features-resolver2'), undefined, live, {
      signal: controller.signal,
      loadIndex: async (name, signal) => {
        signals.push(signal);
        if (++loads === 5) controller.abort();
        return live.get(name) ?? null;
      } }));
    expect([outcome.status, outcome.selected, outcome.instances, outcome.conflicts])
      .toEqual(['cancelled', [], [], []]);
    expect(outcome.cost.indexFilesLoaded).toBe(4);
    expect(signals.every(signal => signal === controller.signal)).toBe(true);
  });

  test('PKG19: file and byte budgets report the exhausted budget truthfully, never unsatisfiable', async () => {
    const item = scenario('features-resolver2');
    const filesOutcome = await solveCargoRegistry(request(item, undefined, live,
      { limits: { maxIndexFiles: 10 } }));
    expect([filesOutcome.status, filesOutcome.budget, filesOutcome.selected])
      .toEqual(['budget-exhausted', { kind: 'index-files', limit: 10, used: 11 }, []]);
    const bytes = await solveCargoRegistry(request(item, undefined, live,
      { limits: { maxIndexBytes: 100_000 } }));
    expect([bytes.status, bytes.budget?.kind, bytes.budget?.limit])
      .toEqual(['budget-exhausted', 'index-bytes', 100_000]);
    expect(bytes.budget!.used).toBeGreaterThan(100_000);
  });

  test('PKG13: unsupported index semantics and malformed roots are neither solved nor unsatisfiable', async () => {
    const index = files({ foreign: [line('foreign', '1.0.0', [{ name: 'x', req: '^1',
      registry: 'https://other.example/index' } as never])] });
    const foreign = await synthetic('foreign = "1"', index);
    expect([foreign.status, foreign.unsupportedClauses])
      .toEqual(['unsupported-semantics', ['foreign@1.0.0: cross-registry dependency x']]);
    const patched = await solveCargoRegistry({ ...request(scenario('yanked-range')),
      manifest: `${scenario('yanked-range').manifest}\n[patch.crates-io]\ncc = { path = "cc" }\n` });
    expect([patched.status, patched.unsupportedClauses])
      .toEqual(['unsupported-semantics', ['root manifest table patch']]);
    expect(solveCargoRegistry({ ...request(scenario('yanked-range')), features: ['absent'] }))
      .rejects.toBeInstanceOf(CargoSolveInvalid);
  });
});
