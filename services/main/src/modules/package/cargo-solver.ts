import { cargoPlatformMatches, CargoCfgSyntax, checkCargoPlatform, type CargoTriple }
  from './cargo-cfg.ts';
import { cargoCompatibility, cargoRequirementMatches, CargoSemverSyntax, compareCargoVersions,
  parseCargoRequirement, parseCargoVersion, type CargoRequirement, type CargoVersion }
  from './cargo-semver.ts';

// General Cargo registry resolution for one root manifest over a lazily loaded
// sparse-index universe. Phase 1 follows Cargo's dependency resolver (all root
// features, all platforms, root dev-dependencies, highest version first, one
// activation per semver-compatible bucket, unique native `links`, fresh-yank
// exclusion, feature existence) with complete chronological backtracking.
// Phase 2 computes resolver 2 decoupled host/target feature instances, or
// resolver 1 unified features, over the phase 1 graph.

export type CargoSolveStatus = 'solved' | 'unsatisfiable' | 'incomplete-source-data'
  | 'unsupported-semantics' | 'budget-exhausted' | 'cancelled';
export type CargoSolveRole = 'host' | 'target';
export type CargoBudgetKind = 'steps' | 'packages' | 'index-files' | 'index-bytes' | 'time';
export interface CargoSolveLimits { maxSteps: number; maxIndexFiles: number;
  maxIndexBytes: number; maxFileBytes: number; maxSelected: number }
export const CARGO_SOLVE_LIMITS: CargoSolveLimits = { maxSteps: 50_000,
  maxIndexFiles: 512, maxIndexBytes: 32 * 1024 * 1024, maxFileBytes: 4 * 1024 * 1024,
  maxSelected: 1024 };

export interface CargoSolveInput {
  registryIndexUrl: string;
  manifest: string;
  host: CargoTriple;
  target: CargoTriple;
  features: string[];
  defaultFeatures: boolean;
  includeDev: boolean;
  /** Exact `name@version` identities whose captured crate manifest declares `proc-macro`. */
  procMacros: string[];
  loadIndex: (name: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
  limits?: Partial<CargoSolveLimits>;
  signal?: AbortSignal;
  /** Wall-clock deadline in `now()` milliseconds; a transient outcome, never stored. */
  deadline?: number;
  now?: () => number;
}
export interface CargoSolvedPackage { id: string; name: string; version: string;
  checksum: string; yanked: false }
export interface CargoSolvedInstance { id: string; package: string; name: string;
  version: string; role: CargoSolveRole; features: string[] }
export interface CargoSolvedEdge { from: string; to: string; dependency: string;
  kind: 'normal' | 'build' | 'dev'; target: string | null }
export interface CargoLockEdge { from: string; to: string; dependency: string;
  kind: 'normal' | 'build' | 'dev' }
export interface CargoConflict { requiredBy: string; dependency: string; package: string;
  requirement: string; reason: 'no-matching-release' | 'activated-incompatible'
    | 'native-links' | 'missing-feature'; matching: number; detail: string }
export interface CargoSolveCost { indexFilesLoaded: number; indexBytesLoaded: number;
  releasesParsed: number; steps: number; backtracks: number; maxChoiceDepth: number;
  featurePasses: number }
export interface CargoSolveOutcome {
  status: CargoSolveStatus;
  resolver: '1' | '2' | '3';
  root: string;
  selected: CargoSolvedPackage[];
  lockEdges: CargoLockEdge[];
  instances: CargoSolvedInstance[];
  edges: CargoSolvedEdge[];
  procMacros: string[];
  conflicts: CargoConflict[];
  missing: string[];
  unsupportedClauses: string[];
  skippedIndexRecords: number;
  budget: { kind: CargoBudgetKind; limit: number; used: number } | null;
  cost: CargoSolveCost;
}

export class CargoSolveInvalid extends Error {}
class Unsupported extends Error {}
class BudgetStop extends Error {
  constructor(readonly kind: CargoBudgetKind, readonly limit: number, readonly used: number) {
    super(`Cargo ${kind} budget exhausted`);
  }
}
class Cancelled extends Error {}

type Kind = 'normal' | 'build' | 'dev';
interface Dep { name: string; package: string; req: CargoRequirement; features: string[];
  optional: boolean; defaultFeatures: boolean; kind: Kind; target: string | null }
interface Release { id: string; name: string; version: CargoVersion; deps: Dep[];
  features: Map<string, string[]>; links: string | null; checksum: string;
  rustVersion: string | null }
interface IndexRecord { version: CargoVersion; yanked: boolean; rustVersion: string | null;
  line: Record<string, unknown>; parsed?: Release | Error }
interface IndexFile { name: string; records: IndexRecord[] }
interface Task { parent: string; depIndex: number; dep: Dep; features: string[];
  defaultFeatures: boolean; candidates: string[]; matching: number }
interface Frame { tasks: Task[]; next: number; time: number }
interface State { active: Map<string, string>; requested: Map<string, ReadonlySet<string>>;
  links: Map<string, string>; edges: Map<string, ReadonlyMap<number, string>>;
  frames: Frame[]; time: number }
interface Choice { state: State; task: Task; remaining: string[] }

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const FEATURE = /^[A-Za-z0-9_][A-Za-z0-9_+.-]{0,127}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const LINKS = /^[A-Za-z0-9_.+-]{1,128}$/;
const DEFAULT = '(default)';

function unsupported(message: string): never { throw new Unsupported(message); }
function invalid(message: string): never { throw new CargoSolveInvalid(message); }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function strings(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    unsupported(`${what} is not a string array`);
  }
  return value as string[];
}

function featureMap(declared: Record<string, string[]>, deps: Dep[]): Map<string, string[]> {
  const map = new Map<string, string[]>(Object.entries(declared));
  const explicitDep = new Set<string>();
  for (const values of map.values()) {
    for (const value of values) {
      if (value.startsWith('dep:')) explicitDep.add(value.slice(4));
      else if (!value.includes('/') && !FEATURE.test(value)) unsupported(`feature value ${value}`);
    }
  }
  for (const dep of deps) {
    if (dep.optional && !explicitDep.has(dep.name) && !map.has(dep.name)) {
      map.set(dep.name, [`dep:${dep.name}`]);
    }
  }
  return map;
}

function parseDep(raw: unknown, owner: string): Dep {
  const item = record(raw);
  if (!item || typeof item.name !== 'string' || typeof item.req !== 'string') {
    unsupported(`${owner}: malformed dependency`);
  }
  if (item.registry !== undefined && item.registry !== null) {
    unsupported(`${owner}: cross-registry dependency ${item.name}`);
  }
  const kind = item.kind ?? 'normal';
  if (kind !== 'normal' && kind !== 'build' && kind !== 'dev') unsupported(`${owner}: dependency kind`);
  const target = item.target ?? null;
  if (target !== null && typeof target !== 'string') unsupported(`${owner}: target`);
  if (target !== null) checkCargoPlatform(target);
  const pkg = item.package ?? item.name;
  if (typeof pkg !== 'string' || !NAME.test(pkg) || !NAME.test(item.name)) {
    unsupported(`${owner}: dependency name`);
  }
  if (typeof (item.optional ?? false) !== 'boolean'
    || typeof (item.default_features ?? true) !== 'boolean') unsupported(`${owner}: dependency flags`);
  return { name: item.name, package: pkg, req: parseCargoRequirement(item.req),
    features: strings(item.features, `${owner}: features`),
    optional: (item.optional ?? false) as boolean,
    defaultFeatures: (item.default_features ?? true) as boolean, kind, target };
}

function parseRelease(file: IndexFile, record_: IndexRecord, source: string): Release {
  const line = record_.line;
  const owner = `${file.name}@${record_.version.text}`;
  if (typeof line.cksum !== 'string' || !CHECKSUM.test(line.cksum)) unsupported(`${owner}: checksum`);
  if (!Array.isArray(line.deps)) unsupported(`${owner}: deps`);
  const deps = line.deps.map(dep => parseDep(dep, owner));
  const declared: Record<string, string[]> = {};
  for (const table of [line.features, line.features2]) {
    if (table === undefined || table === null) continue;
    const features = record(table) ?? unsupported(`${owner}: features`);
    for (const [name, values] of Object.entries(features)) {
      if (!FEATURE.test(name)) unsupported(`${owner}: feature name ${name}`);
      declared[name] = [...(declared[name] ?? []), ...strings(values, `${owner}: feature ${name}`)];
    }
  }
  const links = line.links ?? null;
  if (links !== null && (typeof links !== 'string' || !LINKS.test(links))) unsupported(`${owner}: links`);
  return { id: `${source}#${file.name}@${record_.version.text}`, name: file.name,
    version: record_.version, deps, features: featureMap(declared, deps), links,
    checksum: line.cksum, rustVersion: record_.rustVersion };
}

function parseIndexFile(name: string, bytes: Uint8Array): { file: IndexFile; skipped: number } {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { unsupported(`${name}: index file is not UTF-8`); }
  const records: IndexRecord[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: Record<string, unknown> | null;
    try { line = record(JSON.parse(raw)); } catch { line = null; }
    if (!line || typeof line.vers !== 'string' || typeof line.name !== 'string') {
      unsupported(`${name}: malformed index record`);
    }
    if (line.name !== name) unsupported(`${name}: index record names ${line.name}`);
    const schema = line.v ?? 1;
    if (schema !== 1 && schema !== 2) { skipped++; continue; }
    let version: CargoVersion;
    try { version = parseCargoVersion(line.vers); }
    catch { skipped++; continue; }
    const key = `${version.major}.${version.minor}.${version.patch}-${version.pre.join('.')}`;
    if (seen.has(key)) unsupported(`${name}: duplicate index version ${line.vers}`);
    seen.add(key);
    if (typeof (line.yanked ?? false) !== 'boolean') unsupported(`${name}: yanked flag`);
    const rust = line.rust_version ?? null;
    if (rust !== null && (typeof rust !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(rust))) {
      unsupported(`${name}: rust_version`);
    }
    records.push({ version, yanked: (line.yanked ?? false) as boolean,
      rustVersion: rust as string | null, line });
  }
  return { file: { name, records }, skipped };
}

function parseFeatureValue(value: string): { kind: 'feature'; name: string }
  | { kind: 'dep'; name: string } | { kind: 'dep-feature'; name: string; feature: string; weak: boolean } {
  if (value.startsWith('dep:')) return { kind: 'dep', name: value.slice(4) };
  const slash = value.indexOf('/');
  if (slash < 0) return { kind: 'feature', name: value };
  const weak = value[slash - 1] === '?';
  return { kind: 'dep-feature', name: value.slice(0, weak ? slash - 1 : slash),
    feature: value.slice(slash + 1), weak };
}

class MissingFeature extends Error {}

/** Cargo dependency-resolver requirements: enabled features and dependency feature requests. */
function requirements(release: Release, requested: Iterable<string>): {
  features: Set<string>; deps: Map<string, Set<string>> } {
  const features = new Set<string>();
  const deps = new Map<string, Set<string>>();
  const requireDep = (name: string) => { if (!deps.has(name)) deps.set(name, new Set()); };
  const requireFeature = (name: string) => {
    if (features.has(name)) return;
    const values = release.features.get(name);
    if (!values) throw new MissingFeature(`${release.name}@${release.version.text} has no feature ${name}`);
    features.add(name);
    for (const raw of values) {
      const value = parseFeatureValue(raw);
      if (value.kind === 'feature') requireFeature(value.name);
      else if (value.kind === 'dep') requireDep(value.name);
      else {
        if (!value.weak && release.deps.some(dep => dep.name === value.name && dep.optional)
          && release.features.has(value.name)) requireFeature(value.name);
        requireDep(value.name);
        deps.get(value.name)!.add(value.feature);
      }
    }
  };
  for (const name of requested) {
    if (name === DEFAULT) { if (release.features.has('default')) requireFeature('default'); }
    else if (name.includes('/')) {
      const value = parseFeatureValue(name);
      if (value.kind !== 'dep-feature') throw new MissingFeature(`invalid feature ${name}`);
      requireDep(value.name);
      deps.get(value.name)!.add(value.feature);
    } else requireFeature(name);
  }
  return { features, deps };
}

function rootRelease(manifest: string): { release: Release; resolver: '1' | '2' | '3';
  rustVersion: string | null } {
  let parsed: Record<string, unknown>;
  try { parsed = record(Bun.TOML.parse(manifest)) ?? invalid('malformed root manifest'); }
  catch (error) { if (error instanceof CargoSolveInvalid) throw error; invalid('malformed root manifest'); }
  const allowedTop = new Set(['package', 'dependencies', 'dev-dependencies',
    'build-dependencies', 'target', 'features', 'lib']);
  for (const key of Object.keys(parsed)) {
    if (!allowedTop.has(key)) unsupported(`root manifest table ${key}`);
  }
  const pkg = record(parsed.package) ?? invalid('root manifest has no package');
  const allowedPackage = new Set(['name', 'version', 'edition', 'resolver', 'rust-version',
    'publish', 'description', 'license', 'authors', 'repository', 'homepage',
    'documentation', 'readme', 'keywords', 'categories']);
  for (const key of Object.keys(pkg)) {
    if (!allowedPackage.has(key)) unsupported(`root package field ${key}`);
  }
  if (typeof pkg.name !== 'string' || !NAME.test(pkg.name)) invalid('root package name');
  if (typeof pkg.version !== 'string') invalid('root package version');
  let version: CargoVersion;
  try { version = parseCargoVersion(pkg.version); } catch { invalid('root package version'); }
  const edition = pkg.edition ?? '2015';
  if (!['2015', '2018', '2021', '2024'].includes(edition as string)) unsupported(`edition ${String(edition)}`);
  const resolver = pkg.resolver ?? (edition === '2024' ? '3' : edition === '2021' ? '2' : '1');
  if (resolver !== '1' && resolver !== '2' && resolver !== '3') unsupported(`resolver ${String(resolver)}`);
  const rustVersion = pkg['rust-version'] ?? null;
  if (rustVersion !== null && (typeof rustVersion !== 'string'
    || !/^\d+\.\d+(?:\.\d+)?$/.test(rustVersion))) invalid('root rust-version');
  const deps: Dep[] = [];
  const table = (value: unknown, kind: Kind, target: string | null) => {
    if (value === undefined) return;
    const entries = record(value) ?? invalid('root dependency table');
    for (const [name, spec] of Object.entries(entries)) {
      if (!NAME.test(name)) invalid(`root dependency name ${name}`);
      const item = typeof spec === 'string' ? { version: spec } : record(spec)
        ?? invalid(`root dependency ${name}`);
      for (const key of Object.keys(item)) {
        if (!['version', 'features', 'optional', 'default-features', 'package'].includes(key)) {
          unsupported(`root dependency ${name} field ${key}`);
        }
      }
      if (typeof item.version !== 'string') unsupported(`root dependency ${name} without registry version`);
      const pkgName = item.package ?? name;
      if (typeof pkgName !== 'string' || !NAME.test(pkgName)) invalid(`root dependency ${name} package`);
      if (typeof (item.optional ?? false) !== 'boolean'
        || typeof (item['default-features'] ?? true) !== 'boolean') invalid(`root dependency ${name} flags`);
      if (kind === 'dev' && item.optional) invalid(`optional dev-dependency ${name}`);
      let req: CargoRequirement;
      try { req = parseCargoRequirement(item.version); } catch { invalid(`root dependency ${name} requirement`); }
      const features = item.features ?? [];
      if (!Array.isArray(features) || features.some(feature => typeof feature !== 'string')) {
        invalid(`root dependency ${name} features`);
      }
      deps.push({ name, package: pkgName, req, features: features as string[],
        optional: (item.optional ?? false) as boolean,
        defaultFeatures: (item['default-features'] ?? true) as boolean, kind, target });
    }
  };
  table(parsed.dependencies, 'normal', null);
  table(parsed['build-dependencies'], 'build', null);
  table(parsed['dev-dependencies'], 'dev', null);
  if (parsed.target !== undefined) {
    const targets = record(parsed.target) ?? invalid('root target table');
    for (const [platform, value] of Object.entries(targets)) {
      try { checkCargoPlatform(platform); } catch { invalid(`root platform ${platform}`); }
      const tables = record(value) ?? invalid('root target dependencies');
      for (const key of Object.keys(tables)) {
        if (!['dependencies', 'build-dependencies', 'dev-dependencies'].includes(key)) {
          unsupported(`root target table ${key}`);
        }
      }
      table(tables.dependencies, 'normal', platform);
      table(tables['build-dependencies'], 'build', platform);
      table(tables['dev-dependencies'], 'dev', platform);
    }
  }
  const declared: Record<string, string[]> = {};
  if (parsed.features !== undefined) {
    const features = record(parsed.features) ?? invalid('root features');
    for (const [name, values] of Object.entries(features)) {
      if (!FEATURE.test(name) || !Array.isArray(values)
        || values.some(value => typeof value !== 'string')) invalid(`root feature ${name}`);
      declared[name] = values as string[];
    }
  }
  return { release: { id: `root#${pkg.name}@${version.text}`, name: pkg.name, version, deps,
    features: featureMap(declared, deps), links: null, checksum: '', rustVersion },
  resolver, rustVersion };
}

function rustCompatible(release: string | null, msrv: string): boolean {
  if (release === null) return true;
  const [a, b, c] = release.split('.').map(Number);
  const [x, y, z] = msrv.split('.').map(Number);
  return a! !== x! ? a! < x! : b! !== y! ? b! < y! : (c ?? 0) <= (z ?? 0);
}

function sortedUnique(values: Iterable<string>): string[] { return [...new Set(values)].sort(); }

/** Cargo 1.98.1 resolution of one captured registry snapshot; never throws for data outcomes. */
export async function solveCargoRegistry(input: CargoSolveInput): Promise<CargoSolveOutcome> {
  const limits = { ...CARGO_SOLVE_LIMITS, ...input.limits };
  const source = input.registryIndexUrl;
  const now = input.now ?? (() => performance.now());
  const cost: CargoSolveCost = { indexFilesLoaded: 0, indexBytesLoaded: 0, releasesParsed: 0,
    steps: 0, backtracks: 0, maxChoiceDepth: 0, featurePasses: 0 };
  const missing = new Set<string>();
  const unsupportedClauses = new Set<string>();
  const conflicts = new Map<string, CargoConflict>();
  const procMacros = new Set(input.procMacros);
  let skippedIndexRecords = 0;
  let resolver: '1' | '2' | '3' = '2';
  let rootId = '';
  const base = (status: CargoSolveStatus): CargoSolveOutcome => ({ status, resolver, root: rootId,
    selected: [], lockEdges: [], instances: [], edges: [], procMacros: [],
    conflicts: [], missing: sortedUnique(missing), unsupportedClauses: sortedUnique(unsupportedClauses),
    skippedIndexRecords, budget: null, cost });

  const files = new Map<string, IndexFile | null>();
  const releases = new Map<string, Release>();
  const recordsById = new Map<string, { file: IndexFile; record: IndexRecord }>();
  const check = () => {
    if (input.signal?.aborted) throw new Cancelled('Cargo resolution cancelled');
    if (input.deadline !== undefined && now() >= input.deadline) {
      throw new BudgetStop('time', input.deadline, Math.ceil(now()));
    }
  };
  const load = async (name: string): Promise<IndexFile | null> => {
    if (files.has(name)) return files.get(name)!;
    check();
    if (cost.indexFilesLoaded >= limits.maxIndexFiles) {
      throw new BudgetStop('index-files', limits.maxIndexFiles, cost.indexFilesLoaded + 1);
    }
    const bytes = await input.loadIndex(name, input.signal);
    check();
    cost.indexFilesLoaded++;
    if (!bytes) { missing.add(name); files.set(name, null); return null; }
    cost.indexBytesLoaded += bytes.length;
    if (bytes.length > limits.maxFileBytes || cost.indexBytesLoaded > limits.maxIndexBytes) {
      throw new BudgetStop('index-bytes', limits.maxIndexBytes, cost.indexBytesLoaded);
    }
    try {
      const parsed = parseIndexFile(name, bytes);
      skippedIndexRecords += parsed.skipped;
      files.set(name, parsed.file);
      for (const item of parsed.file.records) {
        recordsById.set(`${source}#${name}@${item.version.text}`, { file: parsed.file, record: item });
      }
      return parsed.file;
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      unsupportedClauses.add(error.message);
      files.set(name, null);
      return null;
    }
  };
  const release = (id: string): Release | null => {
    const known = releases.get(id);
    if (known) return known;
    const entry = recordsById.get(id)!;
    if (entry.record.parsed instanceof Error) return null;
    try {
      const parsed = parseRelease(entry.file, entry.record, source);
      cost.releasesParsed++;
      releases.set(id, parsed);
      return parsed;
    } catch (error) {
      if (!(error instanceof Unsupported || error instanceof CargoSemverSyntax
        || error instanceof CargoCfgSyntax)) throw error;
      entry.record.parsed = error;
      unsupportedClauses.add(error.message);
      return null;
    }
  };

  try {
    const root = rootRelease(input.manifest);
    resolver = root.resolver;
    rootId = root.release.id;
    releases.set(rootId, root.release);
    const msrv = resolver === '3' ? root.rustVersion ?? '1.98.1' : null;
    for (const feature of input.features) {
      if (!root.release.features.has(feature)) invalid(`root has no feature ${feature}`);
    }

    // ---- Phase 1: dependency resolution with backtracking -----------------
    const candidatesFor = async (dep: Dep): Promise<{ ids: string[]; matching: number }> => {
      const file = await load(dep.package);
      if (!file) return { ids: [], matching: 0 };
      const matching = file.records.filter(item => cargoRequirementMatches(dep.req, item.version));
      const eligible = matching.filter(item => !item.yanked).sort((a, b) => {
        if (msrv !== null) {
          const left = rustCompatible(a.rustVersion, msrv);
          const right = rustCompatible(b.rustVersion, msrv);
          if (left !== right) return left ? -1 : 1;
        }
        return compareCargoVersions(b.version, a.version);
      });
      return { ids: eligible.map(item => `${source}#${file.name}@${item.version.text}`),
        matching: matching.length };
    };
    const tasksFor = async (parent: Release, request: Iterable<string>, isRoot: boolean):
      Promise<Task[]> => {
      const reqs = requirements(parent, request);
      const tasks: Task[] = [];
      for (const [depIndex, dep] of parent.deps.entries()) {
        if (dep.kind === 'dev' && !isRoot) continue;
        if (dep.optional && !reqs.deps.has(dep.name)) continue;
        const found = await candidatesFor(dep);
        tasks.push({ parent: parent.id, depIndex, dep,
          features: sortedUnique([...dep.features, ...reqs.deps.get(dep.name) ?? []]),
          defaultFeatures: dep.defaultFeatures, candidates: found.ids, matching: found.matching });
      }
      return tasks.map((task, order) => ({ task, order }))
        .sort((a, b) => a.task.candidates.length - b.task.candidates.length || a.order - b.order)
        .map(item => item.task);
    };
    const conflict = (task: Task, reason: CargoConflict['reason'], detail: string) => {
      const item: CargoConflict = { requiredBy: task.parent, dependency: task.dep.name,
        package: task.dep.package, requirement: task.dep.req.text, reason,
        matching: task.matching, detail };
      const key = JSON.stringify(item);
      if (!conflicts.has(key) && conflicts.size < 256) conflicts.set(key, item);
    };
    const rootRequest = [...root.release.features.keys()];
    let state: State = { active: new Map(), requested: new Map([[rootId, new Set(rootRequest)]]),
      links: new Map(), edges: new Map(), frames: [], time: 0 };
    state.frames = [{ tasks: await tasksFor(root.release, rootRequest, true), next: 0, time: 0 }];

    const activate = async (from: State, task: Task, id: string): Promise<State | null> => {
      cost.steps++;
      if (cost.steps > limits.maxSteps) throw new BudgetStop('steps', limits.maxSteps, cost.steps);
      check();
      const candidate = release(id);
      if (!candidate) return null;
      const bucket = `${candidate.name}#${cargoCompatibility(candidate.version)}`;
      const active = from.active.get(bucket);
      if (active !== undefined && active !== id) {
        conflict(task, 'activated-incompatible', active);
        return null;
      }
      if (candidate.links !== null) {
        const owner = from.links.get(candidate.links);
        if (owner !== undefined && owner !== id) {
          conflict(task, 'native-links', `${candidate.links}:${owner}`);
          return null;
        }
      }
      const request = [...task.features, ...task.defaultFeatures ? [DEFAULT] : []];
      const previous = from.requested.get(id);
      const added = request.filter(item => !previous?.has(item));
      let tasks: Task[] = [];
      if (added.length || !previous) {
        try { tasks = await tasksFor(candidate, added.length ? added : request, false); }
        catch (error) {
          if (!(error instanceof MissingFeature)) throw error;
          conflict(task, 'missing-feature', error.message);
          return null;
        }
      }
      const next: State = { active: new Map(from.active), requested: new Map(from.requested),
        links: new Map(from.links), edges: new Map(from.edges), frames: from.frames,
        time: from.time };
      next.active.set(bucket, id);
      if (candidate.links !== null) next.links.set(candidate.links, id);
      next.requested.set(id, new Set([...previous ?? [], ...request]));
      next.edges.set(task.parent, new Map(next.edges.get(task.parent) ?? []).set(task.depIndex, id));
      if (next.active.size > limits.maxSelected) {
        throw new BudgetStop('packages', limits.maxSelected, next.active.size);
      }
      if (tasks.length) {
        next.time++;
        next.frames = [...next.frames, { tasks, next: 0, time: next.time }];
      }
      return next;
    };
    const attempt = async (from: State, task: Task, candidates: string[]):
      Promise<{ state: State; remaining: string[] } | null> => {
      for (const [index, id] of candidates.entries()) {
        const next = await activate(from, task, id);
        if (next) return { state: next, remaining: candidates.slice(index + 1) };
      }
      if (!task.candidates.length) {
        conflict(task, 'no-matching-release', missing.has(task.dep.package)
          ? 'index file absent' : 'no eligible release');
      }
      return null;
    };

    const choices: Choice[] = [];
    let solved = false;
    for (;;) {
      check();
      let pick = -1;
      for (const [index, frame] of state.frames.entries()) {
        if (frame.next >= frame.tasks.length) continue;
        if (pick < 0) { pick = index; continue; }
        const best = state.frames[pick]!;
        const size = frame.tasks[frame.next]!.candidates.length;
        const bestSize = best.tasks[best.next]!.candidates.length;
        if (size < bestSize || (size === bestSize && frame.time < best.time)) pick = index;
      }
      if (pick < 0) { solved = true; break; }
      const frame = state.frames[pick]!;
      const task = frame.tasks[frame.next]!;
      const advanced: State = { ...state, frames: state.frames.map((item, index) =>
        index === pick ? { ...item, next: item.next + 1 } : item) };
      let result = await attempt(advanced, task, task.candidates);
      if (result?.remaining.length) choices.push({ state: advanced, task, remaining: result.remaining });
      while (!result) {
        const choice = choices.pop();
        if (!choice) break;
        cost.backtracks++;
        result = await attempt(choice.state, choice.task, choice.remaining);
        if (result?.remaining.length) {
          choices.push({ state: choice.state, task: choice.task, remaining: result.remaining });
        }
      }
      if (!result) break;
      cost.maxChoiceDepth = Math.max(cost.maxChoiceDepth, choices.length);
      state = result.state;
    }

    if (unsupportedClauses.size) return base('unsupported-semantics');
    if (missing.size) return base('incomplete-source-data');
    if (!solved) {
      return { ...base('unsatisfiable'), conflicts: [...conflicts.values()].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    }

    // ---- Phase 2: feature resolution over the selected graph --------------
    const selectedIds = [...state.active.values()].sort();
    const lockEdges: CargoLockEdge[] = [];
    for (const [parent, edges] of state.edges) {
      const parentRelease = releases.get(parent)!;
      for (const [depIndex, child] of edges) {
        const dep = parentRelease.deps[depIndex]!;
        lockEdges.push({ from: parent, to: child, dependency: dep.name, kind: dep.kind });
      }
    }
    const pass = (mode: FeatureMode, legacy?: Map<string, FeatureNode>) => propagate({ mode, state,
      releases, rootId, features: input.features, defaultFeatures: input.defaultFeatures,
      includeDev: input.includeDev, host: input.host, target: input.target, procMacros, legacy,
      tick: () => { cost.featurePasses++; check(); } });
    const legacy = resolver === '1' ? pass('unified').nodes : undefined;
    const { nodes: instances, edges: edgeSet } = pass(legacy ? 'unified-instances' : 'decoupled', legacy);
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    return { ...base('solved'),
      selected: selectedIds.map(id => { const rel = releases.get(id)!;
        return { id, name: rel.name, version: rel.version.text, checksum: rel.checksum,
          yanked: false as const }; }),
      lockEdges: lockEdges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      instances: [...instances.values()].map(inst => {
        const rel = releases.get(inst.pkg)!;
        const features = legacy ? legacy.get(inst.pkg)?.features ?? new Set<string>() : inst.features;
        return { id: `${inst.pkg}#${inst.role}`, package: inst.pkg, name: rel.name,
          version: rel.version.text, role: inst.role, features: [...features].sort() };
      }).sort(byId),
      edges: [...edgeSet.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      procMacros: selectedIds.filter(id => { const rel = releases.get(id)!;
        return procMacros.has(`${rel.name}@${rel.version.text}`); }) };
  } catch (error) {
    if (error instanceof BudgetStop) return { ...base('budget-exhausted'),
      budget: { kind: error.kind, limit: error.limit, used: error.used } };
    if (error instanceof Cancelled) return base('cancelled');
    if (error instanceof Unsupported || error instanceof CargoCfgSyntax) {
      unsupportedClauses.add(error.message);
      return base('unsupported-semantics');
    }
    throw error;
  }
}

interface FeatureNode { pkg: string; role: CargoSolveRole; features: Set<string>;
  optional: Set<string>; depFeatures: Map<string, Set<string>> }
/**
 * `decoupled`: resolver 2 instances keyed by package and host/target role, with
 * platform filtering. `unified`: resolver 1 features, one node per package over
 * every platform. `unified-instances`: resolver 1 active instances, reusing the
 * unified features and enabled optional dependencies.
 */
type FeatureMode = 'decoupled' | 'unified' | 'unified-instances';

function addFeature(releases: Map<string, Release>, node: FeatureNode, name: string): boolean {
  const rel = releases.get(node.pkg)!;
  if (name === DEFAULT) return rel.features.has('default') ? addFeature(releases, node, 'default') : false;
  if (node.features.has(name)) return false;
  const values = rel.features.get(name);
  if (!values) throw new MissingFeature(`${rel.name} has no feature ${name}`);
  node.features.add(name);
  for (const raw of values) {
    const value = parseFeatureValue(raw);
    if (value.kind === 'feature') addFeature(releases, node, value.name);
    else if (value.kind === 'dep') node.optional.add(value.name);
    else {
      if (!value.weak && rel.deps.some(dep => dep.name === value.name && dep.optional)) {
        node.optional.add(value.name);
        if (rel.features.has(value.name)) addFeature(releases, node, value.name);
      }
      const set = node.depFeatures.get(value.name) ?? new Set<string>();
      set.add(value.feature);
      node.depFeatures.set(value.name, set);
    }
  }
  return true;
}

function propagate(input: { mode: FeatureMode; state: State; releases: Map<string, Release>;
  rootId: string; features: string[]; defaultFeatures: boolean; includeDev: boolean;
  host: CargoTriple; target: CargoTriple; procMacros: Set<string>;
  legacy?: Map<string, FeatureNode>; tick: () => void }): {
  nodes: Map<string, FeatureNode>; edges: Map<string, CargoSolvedEdge> } {
  const { mode, releases } = input;
  const nodes = new Map<string, FeatureNode>();
  const edges = new Map<string, CargoSolvedEdge>();
  const ensure = (pkg: string, role: CargoSolveRole) => {
    const key = mode === 'unified' ? pkg : `${pkg}#${role}`;
    let node = nodes.get(key);
    if (!node) {
      node = { pkg, role, features: new Set(), optional: new Set(), depFeatures: new Map() };
      nodes.set(key, node);
    }
    return node;
  };
  const root = ensure(input.rootId, 'target');
  if (mode !== 'unified-instances') {
    for (const feature of input.features) addFeature(releases, root, feature);
    if (input.defaultFeatures) addFeature(releases, root, DEFAULT);
  }
  let changed = true;
  while (changed) {
    changed = false;
    input.tick();
    for (const node of [...nodes.values()]) {
      const rel = releases.get(node.pkg)!;
      const children = input.state.edges.get(node.pkg) ?? new Map<number, string>();
      const optional = mode === 'unified-instances' ? input.legacy!.get(node.pkg)?.optional
        : node.optional;
      for (const [depIndex, dep] of rel.deps.entries()) {
        const child = children.get(depIndex);
        if (child === undefined) continue;
        if (dep.kind === 'dev' && !(node.pkg === input.rootId && input.includeDev)) continue;
        if (dep.optional && !optional?.has(dep.name)) continue;
        let role: CargoSolveRole = node.role;
        if (mode !== 'unified') {
          const triple = node.role === 'host' || dep.kind === 'build' ? input.host : input.target;
          if (!cargoPlatformMatches(dep.target, triple)) continue;
          const childRelease = releases.get(child)!;
          if (dep.kind === 'build'
            || input.procMacros.has(`${childRelease.name}@${childRelease.version.text}`)) role = 'host';
        }
        const before = nodes.size;
        const target = ensure(child, role);
        if (nodes.size !== before) changed = true;
        if (mode !== 'unified') {
          const key = `${node.pkg}#${node.role}|${depIndex}|${child}#${role}`;
          if (!edges.has(key)) {
            edges.set(key, { from: `${node.pkg}#${node.role}`, to: `${child}#${role}`,
              dependency: dep.name, kind: dep.kind, target: dep.target });
            changed = true;
          }
        }
        if (mode === 'unified-instances') continue;
        for (const feature of dep.features) changed = addFeature(releases, target, feature) || changed;
        if (dep.defaultFeatures) changed = addFeature(releases, target, DEFAULT) || changed;
        for (const feature of node.depFeatures.get(dep.name) ?? []) {
          changed = addFeature(releases, target, feature) || changed;
        }
      }
    }
  }
  return { nodes, edges };
}
