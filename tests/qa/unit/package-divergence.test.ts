import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { solveCargoSnapshot } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { solveCargoRegistry } from '../../../services/main/src/modules/package/cargo-solver.ts';
import { explainCargoDivergence, explainCargoSolverDivergence, explainGoDivergence,
  explainGoLiveDivergence, explainModDivergence,
  explainNixDivergence } from '../../../services/main/src/modules/package/divergence.ts';
import { solveGoMvsSnapshot } from '../../../services/main/src/modules/package/go-mvs.ts';
import { solveGoLiveGraph } from '../../../services/main/src/modules/package/go-live-mvs.ts';
import { solveModCaptures, type ModCapture, type ModRequest } from '../../../services/main/src/modules/package/mod-profile.ts';
import { cargoFixture } from '../fixtures/cargo-snapshot.ts';
import { goPrunedDirectivesFixture } from '../fixtures/go-pruned-directives.ts';
import { NIX_IMAGE, type NixOutcome } from '../../../services/main/src/modules/package/nix-graph.ts';
import { CARGO_LIVE_HOST, CARGO_LIVE_SCENARIOS } from '../fixtures/cargo-live-scenarios.ts';
import { cargoLiveCapture, cargoLiveIndex, cargoLiveProcMacros, cargoNativeRecord }
  from '../fixtures/cargo-live-snapshot.ts';
import { GO_LIVE_SCENARIOS } from '../fixtures/go-live-scenarios.ts';
import { goLiveCapture, goLiveFiles, goLiveLoader, goNativeRecord }
  from '../fixtures/go-live-snapshot.ts';

const snapshotDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('PKG12: Cargo explains matching scoped selection and feature divergence on one captured index', () => {
  const outcome = solveCargoSnapshot(cargoFixture());
  expect(outcome.status).toBe('solved');
  const requestDigest = snapshotDigest(cargoFixture());
  const receipt = { requestDigest, outcome };
  const identities = new Map(outcome.instances.map(item => [item.id,
    `${item.source}#${item.name}@${item.version}`]));
  const native = {
    requestDigest,
    status: 'solved' as const,
    selected: outcome.selected.map(({ source, name, version }) => ({ source, name, version })),
    instances: outcome.instances.map(({ source, name, version, role, features }) =>
      ({ source, name, version, role, features: [...features] })),
    edges: outcome.edges.map(edge => ({ from: identities.get(edge.from) ?? edge.from,
    to: identities.get(edge.to) ?? edge.to,
    kind: edge.kind, target: edge.target, features: [...edge.requestedFeatures] })),
  };
  expect(explainCargoDivergence(receipt, native).correspondence).toBe('identical');
  const differentFeatures = { ...native, instances: native.instances.map(instance => instance.name === 'shared'
    && instance.role === 'host' ? { ...instance, features: [] } : instance) };
  const report = explainCargoDivergence(receipt, differentFeatures);
  expect(report.correspondence).toBe('divergent');
  expect(report.divergences).toContainEqual(expect.objectContaining({ kind: 'features' }));
});

test('PKG12: Cargo registry solver explains its pinned native lock and metadata observation', async () => {
  const scenario = CARGO_LIVE_SCENARIOS.find(item => item.id === 'features-resolver2')!;
  const variant = scenario.variants.find(item => item.label === 'linux')!;
  const index = cargoLiveIndex();
  const outcome = await solveCargoRegistry({ registryIndexUrl: 'https://index.crates.io/',
    manifest: scenario.manifest, host: CARGO_LIVE_HOST, target: variant.target,
    features: variant.features, defaultFeatures: variant.defaultFeatures, includeDev: variant.includeDev,
    procMacros: cargoLiveProcMacros(), loadIndex: async name => index.get(name) ?? null });
  const sourceDigest = snapshotDigest({ capture: cargoLiveCapture(), scenario: scenario.id, variant });
  const native = { sourceDigest, ...cargoNativeRecord()[`${scenario.id}/${variant.label}`]! };
  expect(explainCargoSolverDivergence({ sourceDigest, outcome }, native)).toMatchObject({
    ecosystem: 'cargo', correspondence: 'identical', divergences: [],
  });
  expect(explainCargoSolverDivergence({ sourceDigest: 'other-snapshot', outcome }, native).divergences)
    .toContainEqual(expect.objectContaining({ kind: 'source', explanation: expect.stringContaining('different source snapshots') }));
  const changed = { ...native, selected: native.selected.slice(1) };
  expect(explainCargoSolverDivergence({ sourceDigest, outcome }, changed).divergences)
    .toContainEqual(expect.objectContaining({ kind: 'selection' }));
});

test('PKG12: Go explains MVS correspondence and replacement-source divergence over captured manifests', () => {
  const outcome = solveGoMvsSnapshot(goPrunedDirectivesFixture());
  expect(outcome.status).toBe('solved');
  const requestDigest = snapshotDigest(goPrunedDirectivesFixture());
  const receipt = { requestDigest, outcome };
  const replacements = new Map((outcome.selectedSources ?? []).map(item =>
    [`${item.original.path}@${item.original.version}`, item.source]));
  const native = { requestDigest, status: 'solved' as const, modules: outcome.buildList.map(item => {
    const replacement = replacements.get(`${item.path}@${item.version}`);
    return { ...item, ...(replacement ? { replacement } : {}) };
  }) };
  expect(explainGoDivergence(receipt, native).correspondence).toBe('identical');
  const changed = { ...native, modules: native.modules.map(item => item.path === 'example.com/a'
    ? { ...item, replacement: { path: 'example.com/unobserved-fork', version: 'v1.0.0' } } : item) };
  const report = explainGoDivergence(receipt, changed);
  expect(report.correspondence).toBe('divergent');
  expect(report.divergences.some(item => item.kind === 'selection'
    && item.explanation.includes('source absent'))).toBe(true);
});

test('PKG12: Go live MVS explains native list and retraction annotations from the same proxy capture', async () => {
  const scenario = GO_LIVE_SCENARIOS[0]!;
  const files = goLiveFiles();
  const outcome = await solveGoLiveGraph({ mainModule: scenario.mainModule, loader: goLiveLoader(files) });
  const sourceDigest = snapshotDigest({ capture: goLiveCapture(), scenario: scenario.id,
    mainModule: scenario.mainModule });
  const native = goNativeRecord()[scenario.id]!;
  const report = explainGoLiveDivergence({ sourceDigest, outcome }, { sourceDigest,
    list: native.list, modules: native.modules });
  expect(report.correspondence).toBe('identical');
  expect(report.divergences).toEqual([]);
  expect(explainGoLiveDivergence({ sourceDigest: 'other-snapshot', outcome }, { sourceDigest,
    list: native.list, modules: native.modules }).divergences)
    .toContainEqual(expect.objectContaining({ kind: 'source' }));
  expect(explainGoLiveDivergence({ sourceDigest, outcome }, { sourceDigest,
    list: native.list, modules: native.modules.map((item, index) => index === 0
      ? { ...item, version: 'v0.0.0' } : item) }).correspondence).toBe('divergent');
});

test('PKG12: Nix keeps locked inputs, derivations and runtime closure as distinct comparison stages', () => {
  const graph: NixOutcome['inputGraph'] = { root: 'root',
    nodes: [{ id: 'root', original: null, locked: null, sourceHash: null }], edges: [] };
  const derivation: NonNullable<NixOutcome['derivationGraph']> = { selectedDrvPath: '/nix/store/a.drv',
    nodes: [{ drvPath: '/nix/store/a.drv', system: 'x86_64-linux', outputs: [], sourcePaths: [] }], edges: [] };
  const closure: NixOutcome['runtimeClosure'] = { status: 'observed', outputPath: '/nix/store/a',
    paths: [{ path: '/nix/store/a', narHash: 'sha256-a', references: [] }] };
  const outcome: NixOutcome = { status: 'observed', failure: null,
    evaluator: { version: '2.35.2', image: NIX_IMAGE, system: 'x86_64-linux', network: 'none' },
    inputGraph: graph, derivationGraph: derivation, runtimeClosure: closure,
    work: { inputNodes: 1, inputEdges: 0, derivations: 1, buildEdges: 0, closurePaths: 1, nativeRuns: 1 } };
  const requestDigest = snapshotDigest({ flakeLock: 'the retained exact flake.lock bytes', files: [] });
  const receipt = { requestDigest, outcome };
  const native = { ...outcome, requestDigest };
  const matching = explainNixDivergence(receipt, native);
  expect(matching.correspondence).toBe('identical');
  const different = explainNixDivergence(receipt, { ...native,
    runtimeClosure: { status: 'unobserved', outputPath: null, paths: [] } });
  expect(different.correspondence).toBe('divergent');
  expect(different.divergences).toContainEqual(expect.objectContaining({
    kind: 'execution-stage', identity: 'runtime-closure',
  }));
});

function capture(identity: string, surface: string, value: unknown): ModCapture {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { identity, surface, status: 'observed', bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
function modRequest(ecosystem: ModRequest['ecosystem']): ModRequest {
  const root = ecosystem === 'curseforge' ? '1' : ecosystem === 'steam' ? '12345'
    : ecosystem === 'modrinth' ? 'v1' : 'root';
  if (ecosystem === 'fabric') return { profile: 'mod-native-capture-v1', ecosystem, root, side: 'CLIENT',
    captures: [capture(root, 'manifest', { schemaVersion: 1, id: root, version: '1.0.0',
      depends: { helper: '*' } }), capture('helper', 'manifest', { schemaVersion: 1, id: 'helper', version: '1.0.0' })] };
  if (ecosystem === 'forge' || ecosystem === 'neoforge') return { profile: 'mod-native-capture-v1',
    ecosystem, root, side: 'CLIENT', runtime: { loaderVersion: ecosystem === 'forge' ? '52' : '4', gameVersion: '1.21.1' },
    captures: [capture(root, 'manifest', `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"`)] };
  if (ecosystem === 'modrinth') return { profile: 'mod-native-capture-v1', ecosystem, root, side: 'CLIENT',
    captures: [capture(root, 'version', { id: root, project_id: 'project', version_number: '1.0.0', dependencies: [] })] };
  if (ecosystem === 'curseforge') return { profile: 'mod-native-capture-v1', ecosystem, root, side: 'CLIENT',
    captures: [capture(root, 'file', { id: 1, modId: 2, dependencies: [] })] };
  if (ecosystem === 'steam') return { profile: 'mod-native-capture-v1', ecosystem, root, side: 'CLIENT',
    captures: [capture(root, 'ugc-children', { publishedfileid: root, file_type: 0, num_children: 0, children: [] })] };
  return { profile: 'mod-native-capture-v1', ecosystem, root, side: 'CLIENT',
    captures: [capture(root, 'file-version-range', {})] };
}

test('PKG12: mod loader and provider receipts explain each admitted ecosystem without merging vocabularies', () => {
  for (const ecosystem of ['fabric', 'forge', 'neoforge', 'modrinth', 'curseforge', 'nexus', 'steam'] as const) {
    const receipt = solveModCaptures(modRequest(ecosystem));
    const request = modRequest(ecosystem);
    const requestDigest = snapshotDigest(request);
    const native = { requestDigest, ecosystem, status: receipt.selection, relations: [...receipt.relations],
      independentDownloads: [...receipt.independentDownloads], coverage: [...receipt.coverage] };
    const report = explainModDivergence({ request, requestDigest, outcome: receipt }, native);
    expect(report.ecosystem).toBe(ecosystem);
    expect(report.correspondence).toBe(receipt.selection === 'valid' ? 'identical' : 'both-failed');
    expect(report.profile).toContain(ecosystem);
  }
  const fabric = solveModCaptures(modRequest('fabric'));
  const request = modRequest('fabric');
  const requestDigest = snapshotDigest(request);
  const changedNative = { requestDigest, ecosystem: 'fabric' as const, status: 'valid' as const,
    relations: fabric.relations.map(item => ({ ...item, strength: 'advisory' as const })),
    independentDownloads: fabric.independentDownloads, coverage: fabric.coverage };
  const report = explainModDivergence({ request, requestDigest, outcome: fabric }, changedNative);
  expect(report.correspondence).toBe('divergent');
  expect(report.divergences).toContainEqual(expect.objectContaining({ kind: 'edge' }));
  const v2Request = { ...modRequest('curseforge'), profile: 'mod-native-capture-v2' as const };
  const v2Outcome = solveModCaptures(v2Request);
  const v2Digest = snapshotDigest(v2Request);
  const v2Report = explainModDivergence({ request: v2Request,
    requestDigest: v2Digest, outcome: v2Outcome }, { requestDigest: v2Digest,
    ecosystem: 'curseforge', status: v2Outcome.selection,
    relations: v2Outcome.relations, independentDownloads: v2Outcome.independentDownloads,
    coverage: v2Outcome.coverage });
  expect(v2Report.profile).toBe('mod-native-capture-v2:curseforge');
});
