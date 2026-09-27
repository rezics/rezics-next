import type { CargoResolution } from './cargo-resolution.ts';
import type { CargoSolveOutcome } from './cargo-solver.ts';
import type { GoMvsResolution } from './go-mvs.ts';
import type { GoLiveOutcome } from './go-live-mvs.ts';
import type { ModEcosystem, ModOutcome } from './mod-profile.ts';
import type { ModResolution } from './mod-resolution.ts';
import type { NixOutcome } from './nix-graph.ts';
import type { NixResolution } from './nix-resolution.ts';

export type DivergenceKind = 'selection' | 'scope' | 'features' | 'edge' | 'source'
  | 'advisory' | 'execution-stage' | 'outcome';
export interface ProfileDivergence {
  kind: DivergenceKind;
  identity: string | null;
  rezics: string | null;
  native: string | null;
  explanation: string;
}
export interface ProfileDivergenceReport {
  ecosystem: string;
  profile: string;
  correspondence: 'identical' | 'logical' | 'divergent' | 'both-failed';
  rezicsStatus: string;
  nativeStatus: string;
  logicalInstances: { rezics: number; native: number; shared: number };
  divergences: ProfileDivergence[];
}

export interface CargoNativeObservation {
  requestDigest: string;
  status: 'solved' | 'failed';
  selected: Array<{ source: string; name: string; version: string }>;
  instances: Array<{ source: string; name: string; version: string; role: 'host' | 'target'; features: string[] }>;
  edges: Array<{ from: string; to: string; kind: string; target: string | null; features: string[] }>;
  error?: string;
}

function sorted(values: string[]): string[] { return [...values].sort(); }
function multiset(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}
/** Bounded deterministic multiset diff; O(N log N) time and O(N) temporary memory. */
function compareSets(ecosystem: string, profile: string, rezicsStatus: string, nativeStatus: string,
  rezics: string[], native: string[], reason: (item: string, side: 'rezics' | 'native') => string,
  kind: DivergenceKind = 'selection'): ProfileDivergenceReport {
  const left = multiset(rezics);
  const right = multiset(native);
  const shared = [...left].reduce((sum, [key, count]) => sum + Math.min(count, right.get(key) ?? 0), 0);
  const divergences: ProfileDivergence[] = [];
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const missingLeft = Math.max(0, (right.get(key) ?? 0) - (left.get(key) ?? 0));
    const missingRight = Math.max(0, (left.get(key) ?? 0) - (right.get(key) ?? 0));
    if (missingLeft) divergences.push({ kind, identity: key, rezics: null, native: key,
      explanation: reason(key, 'native') });
    if (missingRight) divergences.push({ kind, identity: key, rezics: key, native: null,
      explanation: reason(key, 'rezics') });
  }
  const bothFailed = rezicsStatus !== 'solved' && nativeStatus !== 'solved';
  return { ecosystem, profile, rezicsStatus, nativeStatus,
    correspondence: bothFailed ? (divergences.length ? 'divergent' : 'both-failed')
      : divergences.length ? 'divergent' : 'identical',
    logicalInstances: { rezics: rezics.length, native: native.length, shared }, divergences };
}

const cargoIdentity = (item: { source: string; name: string; version: string }): string =>
  `${item.source}#${item.name}@${item.version}`;

/** Compare selected Cargo package identity, host/target instances, activated features and active edges.
 * Work is O(I log I + E log E) over the two bounded receipt graphs; it performs no owner or registry reads.
 */
/** Constant-time request identity fence; refuses comparisons over different captured inputs. */
function differentSnapshots(ecosystem: string, profile: string, rezicsStatus: string, nativeStatus: string,
  rezicsDigest: string, nativeDigest: string): ProfileDivergenceReport | null {
  if (rezicsDigest === nativeDigest) return null;
  return { ecosystem, profile, rezicsStatus, nativeStatus, correspondence: 'divergent',
    logicalInstances: { rezics: 0, native: 0, shared: 0 }, divergences: [{ kind: 'source', identity: null,
      rezics: rezicsDigest, native: nativeDigest,
      explanation: 'native and REZICS results are bound to different source snapshots; comparison is not meaningful' }] };
}

export function explainCargoDivergence(receipt: Pick<CargoResolution, 'requestDigest' | 'outcome'>,
  native: CargoNativeObservation): ProfileDivergenceReport {
  const outcome = receipt.outcome;
  const snapshotMismatch = differentSnapshots('cargo', 'cargo-index-exact-resolver2', outcome.status,
    native.status === 'solved' ? 'solved' : native.error ?? 'failed', receipt.requestDigest, native.requestDigest);
  if (snapshotMismatch) return snapshotMismatch;
  const rezicsScopes = outcome.instances.map(item => `${cargoIdentity(item)}|${item.role}`);
  const nativeScopes = native.instances.map(item => `${cargoIdentity(item)}|${item.role}`);
  const base = compareSets('cargo', 'cargo-index-exact-resolver2', outcome.status,
    native.status === 'solved' ? 'solved' : native.error ?? 'failed',
    rezicsScopes, nativeScopes,
    (item, side) => side === 'native' ? `native Cargo has an active scoped instance absent from REZICS: ${item}`
      : `REZICS has an active scoped instance absent from native Cargo: ${item}`, 'scope');
  if (outcome.status !== 'solved' || native.status !== 'solved') {
    const sameFailure = outcome.status !== 'solved' && native.status === 'failed'
      && native.error === outcome.status;
    if (sameFailure) return { ...base, correspondence: 'both-failed', divergences: [] };
    return { ...base, correspondence: 'divergent', divergences: [{ kind: 'outcome', identity: null,
      rezics: outcome.status, native: native.status === 'failed' ? native.error ?? 'failed' : 'solved',
      explanation: `Cargo and REZICS report different resolution outcomes (${outcome.status} versus ${native.status})` }] };
  }
  const selected = compareSets('cargo', 'cargo-index-exact-resolver2', 'solved', 'solved',
    outcome.selected.map(cargoIdentity), native.selected.map(cargoIdentity),
    (item, side) => side === 'native' ? `native Cargo selected ${item}, absent from the REZICS lock selection`
      : `REZICS selected ${item}, absent from the native Cargo lock selection`);
  const nativeFeatures = new Map(native.instances.map(item =>
    [`${cargoIdentity(item)}|${item.role}`, sorted(item.features).join(',')]));
  const featureDiffs = outcome.instances.flatMap(item => {
    const key = `${cargoIdentity(item)}|${item.role}`;
    const rezicsFeatures = sorted(item.features).join(',');
    const features = nativeFeatures.get(key);
    return features !== undefined && features !== rezicsFeatures ? [{ kind: 'features' as const,
      identity: key, rezics: rezicsFeatures, native: features,
      explanation: `Cargo activates different features for scoped instance ${key}` }] : [];
  });
  const nativeEdges = native.edges.map(edge => `${edge.from}->${edge.to}|${edge.kind}|${edge.target ?? ''}|${sorted(edge.features).join(',')}`);
  const rezicsEdges = outcome.edges.map(edge => {
    const target = outcome.instances.find(item => item.id === edge.to);
    const source = outcome.instances.find(item => item.id === edge.from);
    return `${source ? cargoIdentity(source) : edge.from}->${target ? cargoIdentity(target) : edge.to}|${edge.kind}|${edge.target ?? ''}|${sorted(edge.requestedFeatures).join(',')}`;
  });
  const edgeReport = compareSets('cargo', 'cargo-index-exact-resolver2', outcome.status, native.status,
    rezicsEdges, nativeEdges, (item, side) => side === 'native'
      ? `native Cargo has an edge or feature request absent from REZICS: ${item}`
      : `REZICS has an edge or feature request absent from native Cargo: ${item}`, 'edge');
  const divergences = [...base.divergences, ...selected.divergences, ...featureDiffs, ...edgeReport.divergences];
  return { ...base, correspondence: divergences.length ? 'divergent' : 'identical', divergences };
}

export interface CargoSolverNativeObservation {
  sourceDigest: string;
  status: 'solved' | 'failed';
  selected: string[];
  lockEdges: string[];
  instances: string[];
  error?: string | null;
}

/** Compare the captured-index Cargo solver projection with the pinned native Cargo lock/metadata oracle.
 * Work is O(P log P + E log E + I log I) for bounded selected packages, edges and scoped feature instances.
 */
export function explainCargoSolverDivergence(receipt: { sourceDigest: string; outcome: CargoSolveOutcome },
  native: CargoSolverNativeObservation): ProfileDivergenceReport {
  const { outcome } = receipt;
  const nativeStatus = native.status === 'solved' ? 'solved' : native.error ?? 'failed';
  const snapshotMismatch = differentSnapshots('cargo', 'cargo-registry-resolver', outcome.status,
    nativeStatus, receipt.sourceDigest, native.sourceDigest);
  if (snapshotMismatch) return snapshotMismatch;
  const rootName = outcome.root.replace(/^root#/, '').replace(/@[^@]*$/, '');
  const byId = new Map(outcome.selected.map(item => [item.id, `${item.name}@${item.version}`]));
  const ident = (id: string) => byId.get(id) ?? rootName;
  const selected = compareSets('cargo', 'cargo-registry-resolver', outcome.status, nativeStatus,
    outcome.selected.map(item => `${item.name}@${item.version}`), native.selected,
    item => `Cargo lock selection differs for ${item}`);
  const edges = compareSets('cargo', 'cargo-registry-resolver', outcome.status, nativeStatus,
    [...new Set(outcome.lockEdges.map(edge => `${ident(edge.from)}->${ident(edge.to)}`))], native.lockEdges,
    item => `Cargo dependency topology differs at ${item}`, 'edge');
  const instances = compareSets('cargo', 'cargo-registry-resolver', outcome.status, nativeStatus,
    outcome.instances.filter(item => item.package !== outcome.root)
      .map(item => `${item.name}@${item.version}#${item.role}|${sorted(item.features).join(',')}`),
    native.instances, (item, side) => side === 'native'
      ? `native Cargo activates a different host/target feature instance: ${item}`
      : `REZICS activates a different host/target feature instance: ${item}`, 'features');
  const divergences = [...selected.divergences, ...edges.divergences, ...instances.divergences];
  const correspondence = outcome.status !== 'solved' && native.status === 'failed'
    ? divergences.length ? 'divergent' : 'both-failed'
    : divergences.length ? 'divergent' : 'identical';
  return { ...selected, correspondence, logicalInstances: instances.logicalInstances, divergences };
}

export interface GoNativeObservation {
  requestDigest: string;
  status: 'solved' | 'failed';
  modules: Array<{ path: string; version: string; replacement?: { path: string; version?: string } | null }>;
  error?: string;
}

/** Go correspondence is the MVS build list plus the source selected by each replacement.
 * Work is O(M log M) for at most the profile's bounded build list; no native command runs here.
 */
export function explainGoDivergence(receipt: Pick<GoMvsResolution, 'requestDigest' | 'outcome'>,
  native: GoNativeObservation): ProfileDivergenceReport {
  const outcome = receipt.outcome;
  const goValue = (item: { path: string; version: string }, replacement?: { path: string; version?: string }): string =>
    `${item.path}@${item.version}${replacement ? `=>${replacement.path}@${replacement.version ?? ''}` : ''}`;
  const sources = new Map((outcome.selectedSources ?? []).map(item =>
    [`${item.original.path}@${item.original.version}`, item.source]));
  const rezics = outcome.buildList.map(item => {
    const source = sources.get(`${item.path}@${item.version}`);
    return goValue(item, source);
  });
  const nativeValues = native.modules.map(item => goValue(item, item.replacement ?? undefined));
  const snapshotMismatch = differentSnapshots('go', 'go-mvs', outcome.status,
    native.status === 'solved' ? 'solved' : native.error ?? 'failed', receipt.requestDigest, native.requestDigest);
  if (snapshotMismatch) return snapshotMismatch;
  const report = compareSets('go', 'go-mvs', outcome.status,
    native.status === 'solved' ? 'solved' : native.error ?? 'failed', rezics, nativeValues,
    (item, side) => side === 'native' ? `native Go selects a module/source absent from REZICS: ${item}`
      : `REZICS selects a module/source absent from native Go: ${item}`);
  if (outcome.status !== 'solved' || native.status !== 'solved') {
    return { ...report, correspondence: outcome.status !== 'solved' && native.status === 'failed'
      && native.error === outcome.status
      ? 'both-failed' : 'divergent', divergences: outcome.status !== 'solved' && native.status === 'failed'
        && native.error === outcome.status
        ? [] : [{ kind: 'outcome', identity: null, rezics: outcome.status,
          native: native.status === 'failed' ? native.error ?? 'failed' : 'solved',
          explanation: `Go and REZICS report different resolution outcomes (${outcome.status} versus ${native.status})` }] };
  }
  return report;
}

export interface GoLiveNativeObservation {
  sourceDigest: string;
  list: string[];
  modules: Array<{ path: string; version: string; retracted: string[] | null; update: string | null }>;
}

/** Compare Go's captured-proxy native list, including retraction/update annotations, to the REZICS MVS result. */
export function explainGoLiveDivergence(receipt: { sourceDigest: string; outcome: GoLiveOutcome },
  native: GoLiveNativeObservation): ProfileDivergenceReport {
  const { outcome } = receipt;
  const snapshotMismatch = differentSnapshots('go', 'go-live-mvs', outcome.status, 'solved',
    receipt.sourceDigest, native.sourceDigest);
  if (snapshotMismatch) return snapshotMismatch;
  const modules = (items: GoLiveNativeObservation['modules']) => items.map(item =>
    `${item.path}@${item.version}|retracted=${item.retracted?.join(';') ?? '-'}|update=${item.update ?? '-'}`);
  const rezics = modules(outcome.buildList);
  const nativeValues = modules(native.modules);
  const report = compareSets('go', 'go-live-mvs', outcome.status, 'solved', rezics, nativeValues,
    (item, side) => side === 'native' ? `native Go selects or annotates a module differently: ${item}`
      : `REZICS selects or annotates a module differently: ${item}`);
  const nativeList = sorted(native.list);
  const rezicsList = sorted(outcome.buildList.map(item => `${item.path} ${item.version}`));
  const listReport = compareSets('go', 'go-live-mvs', outcome.status, 'solved', rezicsList, nativeList,
    item => `Go build-list membership differs for ${item}`);
  const divergences = [...report.divergences, ...listReport.divergences];
  return { ...report, correspondence: outcome.status !== 'solved' ? 'divergent'
    : divergences.length ? 'divergent' : 'identical', divergences };
}

export interface NixNativeObservation {
  requestDigest: string;
  status: NixOutcome['status'];
  inputGraph: NixOutcome['inputGraph'];
  derivationGraph: NixOutcome['derivationGraph'];
  runtimeClosure: NixOutcome['runtimeClosure'];
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Keep Nix inputs, derivations and runtime closures as separate comparison stages.
 * Work is O(N + E + D + C) across bounded input, build and closure graphs.
 */
export function explainNixDivergence(receipt: Pick<NixResolution, 'requestDigest' | 'outcome'>,
  native: NixNativeObservation): ProfileDivergenceReport {
  const outcome = receipt.outcome;
  const snapshotMismatch = differentSnapshots('nix', 'nix-flake-native-v1', outcome.status,
    native.status, receipt.requestDigest, native.requestDigest);
  if (snapshotMismatch) return snapshotMismatch;
  const divergences: ProfileDivergence[] = [];
  const inputsSame = stable(outcome.inputGraph) === stable(native.inputGraph);
  if (!inputsSame) divergences.push({ kind: 'source', identity: 'flake-input-graph', rezics: stable(outcome.inputGraph),
    native: stable(native.inputGraph), explanation: 'locked flake inputs, follows edges, or source hashes differ' });
  if (stable(outcome.derivationGraph) !== stable(native.derivationGraph)) divergences.push({
    kind: 'execution-stage', identity: 'derivation-graph', rezics: stable(outcome.derivationGraph),
    native: stable(native.derivationGraph), explanation: 'Nix derivation outputs or build-input edges differ for the same locked flake' });
  if (stable(outcome.runtimeClosure) !== stable(native.runtimeClosure)) divergences.push({
    kind: 'execution-stage', identity: 'runtime-closure', rezics: stable(outcome.runtimeClosure),
    native: stable(native.runtimeClosure), explanation: 'observed runtime closure differs; this stage is not inferred from derivation inputs' });
  if (outcome.status !== native.status) divergences.push({ kind: 'outcome', identity: 'resolution-status',
    rezics: outcome.status, native: native.status, explanation: 'native Nix runs reached different evaluation/build/closure stages' });
  return { ecosystem: 'nix', profile: 'nix-flake-native-v1', rezicsStatus: outcome.status,
    nativeStatus: native.status,
    correspondence: divergences.length ? 'divergent' : 'identical',
    logicalInstances: { rezics: outcome.inputGraph.nodes.length, native: native.inputGraph.nodes.length,
      shared: inputsSame ? outcome.inputGraph.nodes.length : 0 }, divergences };
}

export interface ModNativeObservation {
  requestDigest: string;
  ecosystem: ModEcosystem;
  status: 'valid' | 'unsatisfiable' | 'incomplete-source-data' | 'unsupported-semantics' | 'budget-exhausted';
  relations: ModOutcome['relations'];
  independentDownloads: string[];
  coverage: ModOutcome['coverage'];
}

/** Compare loader/provider-native identities and relation grain without merging profile vocabularies.
 * Work is O(C log C + R log R) over at most 32 captures and 256 relations.
 */
export function explainModDivergence(receipt: Pick<ModResolution, 'requestDigest' | 'request' | 'outcome'>,
  native: ModNativeObservation): ProfileDivergenceReport {
  const { request, outcome } = receipt;
  const ecosystem = request.ecosystem;
  const profile = `${request.profile}:${ecosystem}`;
  const status = (value: ModOutcome['selection'] | ModNativeObservation['status']) => value === 'valid' ? 'solved' : value;
  const snapshotMismatch = differentSnapshots(ecosystem, profile,
    status(outcome.selection), status(native.status), receipt.requestDigest, native.requestDigest);
  if (snapshotMismatch) return snapshotMismatch;
  if (native.ecosystem !== ecosystem) return { ecosystem, profile,
    rezicsStatus: status(outcome.selection), nativeStatus: status(native.status), correspondence: 'divergent',
    logicalInstances: { rezics: 0, native: 0, shared: 0 }, divergences: [{ kind: 'source', identity: null,
      rezics: ecosystem, native: native.ecosystem,
      explanation: 'native observation uses a different mod ecosystem profile' }] };
  const identity = (item: ModOutcome['coverage'][number]) => `${item.identity}|${item.surface}|${item.sha256 ?? '-'}|${item.status}`;
  const coverage = compareSets(ecosystem, profile, status(outcome.selection),
    status(native.status), outcome.coverage.map(identity), native.coverage.map(identity),
    (item, side) => side === 'native' ? `native ${ecosystem} evidence is absent from the REZICS receipt: ${item}`
      : `REZICS retained ${ecosystem} evidence absent from the native observation: ${item}`);
  if (outcome.selection === 'valid' && native.status === 'valid') {
    const relationText = (relation: ModOutcome['relations'][number]) =>
      `${relation.from}->${relation.to}|${relation.kind}|${relation.strength}|${relation.range ?? ''}|${relation.side ?? ''}`;
    const relations = compareSets(ecosystem, profile, 'solved', 'solved',
      outcome.relations.map(relationText), native.relations.map(relationText),
      (item, side) => side === 'native' ? `native ${ecosystem} relation is missing from REZICS: ${item}`
        : `REZICS has a ${ecosystem} relation absent from native evidence: ${item}`, 'edge');
    const downloads = compareSets(ecosystem, profile, 'solved', 'solved',
      outcome.independentDownloads, native.independentDownloads,
      item => `independent-download grain differs for ${item}`, 'scope');
    const divergences = [...coverage.divergences, ...relations.divergences, ...downloads.divergences];
    return { ...coverage, correspondence: divergences.length ? 'divergent' : 'identical', divergences };
  }
  if (outcome.selection !== 'valid' && native.status !== 'valid') {
    const sameFailure = outcome.selection === native.status;
    return { ...coverage, correspondence: coverage.divergences.length || !sameFailure ? 'divergent' : 'both-failed',
      divergences: !sameFailure ? [...coverage.divergences, { kind: 'outcome', identity: null,
        rezics: outcome.selection, native: native.status,
        explanation: `REZICS ${ecosystem} and native ${ecosystem} report different failure classes` }]
        : coverage.divergences };
  }
  return { ...coverage, correspondence: 'divergent', divergences: [...coverage.divergences, {
    kind: 'outcome', identity: null, rezics: outcome.selection, native: native.status,
    explanation: `REZICS ${ecosystem} profile reports ${outcome.selection}; native evidence reports ${native.status}` }] };
}
