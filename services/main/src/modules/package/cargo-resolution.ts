import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class CargoResolutionInvalid extends Error {}
export class CargoResolutionConflict extends Error {}
export class CargoResolutionUnavailable extends Error {}

export interface CargoRequest {
  profile: 'cargo-index-exact-resolver2-v1' | 'cargo-index-exact-resolver2-v2';
  registryIndexUrl: string;
  manifestBase64: string;
  manifestSha256: string;
  indexFiles: Array<{ name: string; bytesBase64: string; sha256: string }>;
  host: 'x86_64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc';
  target: 'x86_64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc';
  features: string[];
  defaultFeatures: boolean;
}
type Status = 'solved' | 'unsupported-semantics' | 'incomplete-source-data'
  | 'budget-exhausted' | 'unsatisfiable';
type Role = 'host' | 'target';
interface Dependency { name: string; version: string; features: string[];
  optional: boolean; defaultFeatures: boolean; kind: 'normal' | 'build';
  target: string | null }
interface Release { name: string; version: string; dependencies: Dependency[];
  features: Record<string, string[]>; links: string | null }
export interface CargoInstance { id: string; source: string; name: string;
  version: string; role: Role; features: string[] }
export interface CargoEdge { from: string; to: string; kind: 'normal' | 'build';
  target: string | null; requestedFeatures: string[]; defaultFeatures: boolean }
export interface CargoLinksConflict { kind: 'native-links'; links: string;
  packages: Array<{ id: string; source: string; name: string; version: string;
    roles: Role[] }> }
export interface CargoOutcome { status: Status; selected: Array<{ id: string;
  source: string; name: string; version: string }>;
  instances: CargoInstance[]; edges: CargoEdge[]; missing: string[];
  unsupportedClauses: string[]; releaseCount: number; edgeCount: number;
  featureActivationCount: number; linksConflicts?: CargoLinksConflict[] }
export interface CargoResolution { profile: 'cargo-index-exact-resolution-v1'
  | 'cargo-index-exact-resolution-v2';
  resolution: string; requestDigest: string; request: CargoRequest;
  outcome: CargoOutcome; createdAt: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{64}$/;
const FEATURES = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_FILES = 32;
const MAX_RELEASES = 128;
const MAX_EDGES = 256;
const MAX_ACTIVATIONS = 512;
const MAX_BYTES = 65_536;
const TARGETS = new Set(['cfg(target_os = "linux")', 'cfg(target_os = "windows")']);

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function empty(status: Status, releaseCount = 0, edgeCount = 0,
  featureActivationCount = 0): CargoOutcome {
  return { status, selected: [], instances: [], edges: [], missing: [],
    unsupportedClauses: [], releaseCount, edgeCount, featureActivationCount };
}
function invalid(message: string): never { throw new CargoResolutionInvalid(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Unsupported(`unsupported fields: ${unknown.join(', ')}`);
}
class Unsupported extends Error {}
function decode(value: string, digest: string): string {
  if (typeof value !== 'string' || value.length > 87_384 || !SHA.test(digest)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalid('malformed Cargo snapshot bytes or digest');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== value || sha(bytes) !== digest) {
    invalid('Cargo snapshot digest or canonical base64 mismatch');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid('Cargo snapshot is not UTF-8'); }
  if (text.includes('\0')) invalid('Cargo snapshot contains NUL');
  return text;
}
function sourceId(url: string, name: string, version: string): string {
  return `${url}#${name}@${version}`;
}
function dep(value: unknown, name: string, fromIndex: boolean): Dependency {
  if (!NAME.test(name)) throw new Unsupported(`unsupported dependency name ${name}`);
  const item = object(value);
  if (fromIndex) {
    keys(item, ['name', 'req', 'features', 'optional', 'default_features', 'target',
      'kind', 'registry', 'package']);
    if (item.name !== name || item.registry != null || item.package != null) {
      throw new Unsupported(`dependency ${name} has unsupported source or rename`);
    }
  } else {
    keys(item, ['version', 'registry', 'features', 'optional', 'default-features']);
    if (item.registry !== 'snapshot') {
      throw new Unsupported(`dependency ${name} must use snapshot registry`);
    }
  }
  const requirement = fromIndex ? item.req : item.version;
  if (typeof requirement !== 'string' || !/^=\d+\.\d+\.\d+$/.test(requirement)
    || !VERSION.test(requirement.slice(1))) {
    throw new Unsupported(`dependency ${name} requires a non-exact version`);
  }
  const rawFeatures = item.features ?? [];
  if (!Array.isArray(rawFeatures) || rawFeatures.some(f => typeof f !== 'string'
    || !FEATURES.test(f))) throw new Unsupported(`dependency ${name} has unsupported features`);
  const optional = item.optional ?? false;
  const defaultFeatures = fromIndex ? item.default_features ?? true
    : item['default-features'] ?? true;
  if (typeof optional !== 'boolean' || typeof defaultFeatures !== 'boolean') {
    invalid(`dependency ${name} has malformed feature flags`);
  }
  const target = fromIndex ? item.target ?? null : null;
  if (target !== null && (typeof target !== 'string' || !TARGETS.has(target))) {
    throw new Unsupported(`dependency ${name} has unsupported target`);
  }
  const kind = fromIndex ? item.kind ?? 'normal' : 'normal';
  if (kind !== 'normal' && kind !== 'build') {
    throw new Unsupported(`dependency ${name} has unsupported kind`);
  }
  return { name, version: requirement.slice(1), features: rawFeatures,
    optional, defaultFeatures, kind, target };
}
function featureMap(raw: unknown): Record<string, string[]> {
  const input = object(raw ?? {});
  const output: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(input)) {
    if (!FEATURES.test(name) || !Array.isArray(list)
      || list.some(value => typeof value !== 'string'
        || !/^(?:dep:)?[A-Za-z_][A-Za-z0-9_-]*(?:\/[A-Za-z_][A-Za-z0-9_-]*)?$/.test(value))) {
      throw new Unsupported(`unsupported feature ${name}`);
    }
    output[name] = list as string[];
  }
  return output;
}
function parseManifest(text: string): Release {
  let parsed: Record<string, unknown>;
  try { parsed = object(Bun.TOML.parse(text)); }
  catch { invalid('malformed Cargo.toml'); }
  keys(parsed, ['package', 'dependencies', 'build-dependencies', 'features', 'target']);
  const pkg = object(parsed.package);
  keys(pkg, ['name', 'version', 'edition', 'resolver']);
  if (!NAME.test(String(pkg.name)) || !VERSION.test(String(pkg.version))) {
    invalid('invalid root Cargo package identity');
  }
  if (pkg.edition !== '2021' || pkg.resolver !== '2') {
    throw new Unsupported('root requires edition 2021 and resolver 2');
  }
  const dependencies: Dependency[] = [];
  for (const [tableName, kind] of [['dependencies', 'normal'],
    ['build-dependencies', 'build']] as const) {
    for (const [name, value] of Object.entries(object(parsed[tableName] ?? {}))) {
      dependencies.push({ ...dep(value, name, false), kind });
    }
  }
  for (const [predicate, tables] of Object.entries(object(parsed.target ?? {}))) {
    if (!TARGETS.has(predicate)) throw new Unsupported(`unsupported target ${predicate}`);
    const item = object(tables);
    keys(item, ['dependencies', 'build-dependencies']);
    for (const [tableName, kind] of [['dependencies', 'normal'],
      ['build-dependencies', 'build']] as const) {
      for (const [name, value] of Object.entries(object(item[tableName] ?? {}))) {
        dependencies.push({ ...dep(value, name, false), kind, target: predicate });
      }
    }
  }
  return { name: pkg.name as string, version: pkg.version as string,
    dependencies, features: featureMap(parsed.features), links: null };
}
function parseIndex(files: CargoRequest['indexFiles'], admitLinks: boolean): Map<string, Release> {
  if (!Array.isArray(files) || files.length > MAX_FILES) invalid('invalid Cargo index file count');
  const releases = new Map<string, Release>();
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || !NAME.test(file.name)) invalid('invalid Cargo index file identity');
    const normalized = file.name.toLowerCase().replaceAll('-', '_');
    if (seen.has(normalized)) invalid('duplicate Cargo index file identity');
    seen.add(normalized);
    const text = decode(file.bytesBase64, file.sha256);
    if (!text.endsWith('\n')) invalid('Cargo index file requires final newline');
    for (const line of text.trimEnd().split('\n')) {
      let raw: Record<string, unknown>;
      try { raw = object(JSON.parse(line)); }
      catch { invalid('malformed Cargo index line'); }
      keys(raw, ['name', 'vers', 'deps', 'cksum', 'features', 'yanked', 'links', 'v']);
      if (raw.name !== file.name || !VERSION.test(String(raw.vers))
        || !SHA.test(String(raw.cksum)) || !Array.isArray(raw.deps)) {
        invalid('Cargo index identity or entry is malformed');
      }
      if (raw.v != null && raw.v !== 1) throw new Unsupported('Cargo index schema v2');
      if (raw.yanked !== false) throw new Unsupported('yanked Cargo release');
      if (raw.links != null) {
        if (!admitLinks) throw new Unsupported('Cargo native links');
        if (typeof raw.links !== 'string') invalid('Cargo native links must be a string or null');
        if (!FEATURES.test(raw.links)) throw new Unsupported('unsupported Cargo native links name');
      }
      const dependencies = raw.deps.map(value => dep(value,
        String(object(value).name), true));
      const key = `${file.name}@${raw.vers}`;
      if (releases.has(key)) invalid('duplicate Cargo release identity');
      releases.set(key, { name: file.name, version: raw.vers as string,
        dependencies, features: featureMap(raw.features), links: raw.links as string | null ?? null });
      if (releases.size > MAX_RELEASES) throw new Budget('Cargo release limit');
    }
  }
  return releases;
}
class Budget extends Error {}
function targetMatches(predicate: string | null, triple: string): boolean {
  return predicate === null || predicate === `cfg(target_os = "${triple.includes('windows')
    ? 'windows' : 'linux'}")`;
}
function compatibilityClass(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return major! > 0 ? `${major}` : minor! > 0 ? `0.${minor}` : `0.0.${patch}`;
}
function expandFeatures(release: Release, requested: Set<string>): {
  active: Set<string>; optional: Set<string>; dependencyFeatures: Map<string, Set<string>> } {
  const active = new Set<string>();
  const optional = new Set<string>();
  const dependencyFeatures = new Map<string, Set<string>>();
  const queue = [...requested];
  let count = 0;
  while (queue.length) {
    const name = queue.shift()!;
    if (active.has(name)) continue;
    if (++count > MAX_ACTIVATIONS) throw new Budget('Cargo feature activation limit');
    if (name.startsWith('dep:')) {
      const depName = name.slice(4);
      if (!release.dependencies.some(dep => dep.name === depName && dep.optional)) {
        throw new Unsupported(`unknown optional dependency ${depName}`);
      }
      optional.add(depName);
      continue;
    }
    const feature = release.features[name];
    if (!feature) {
      if (release.dependencies.some(dep => dep.name === name && dep.optional)
        && !Object.values(release.features).flat().includes(`dep:${name}`)) {
        optional.add(name);
        active.add(name);
        continue;
      }
      throw new Unsupported(`unknown feature ${name} on ${release.name}`);
    }
    active.add(name);
    for (const clause of feature) {
      if (clause.includes('/')) {
        const [depName, depFeature] = clause.split('/');
        if (!release.dependencies.some(dep => dep.name === depName)) {
          throw new Unsupported(`unknown feature dependency ${depName}`);
        }
        optional.add(depName!);
        const set = dependencyFeatures.get(depName!) ?? new Set<string>();
        set.add(depFeature!);
        dependencyFeatures.set(depName!, set);
      } else queue.push(clause);
    }
  }
  return { active, optional, dependencyFeatures };
}

export function solveCargoSnapshot(input: CargoRequest): CargoOutcome {
  const outcome = solveSnapshot(input);
  return input.profile === 'cargo-index-exact-resolver2-v2'
    ? { ...outcome, linksConflicts: outcome.linksConflicts ?? [] } : outcome;
}

function solveSnapshot(input: CargoRequest): CargoOutcome {
  if (!input || !['cargo-index-exact-resolver2-v1', 'cargo-index-exact-resolver2-v2'].includes(input.profile)
    || !/^https:\/\/[^?#@]+\/$/.test(input.registryIndexUrl)
    || !Array.isArray(input.features) || input.features.length > 32
    || input.features.some(feature => typeof feature !== 'string' || !FEATURES.test(feature))
    || typeof input.defaultFeatures !== 'boolean'
    || !['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'].includes(input.host)
    || !['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'].includes(input.target)) {
    invalid('invalid bounded Cargo request');
  }
  let root: Release;
  let releases: Map<string, Release>;
  const linksProfile = input.profile === 'cargo-index-exact-resolver2-v2';
  try {
    root = parseManifest(decode(input.manifestBase64, input.manifestSha256));
    releases = parseIndex(input.indexFiles, linksProfile);
  } catch (error) {
    if (error instanceof Unsupported) return { ...empty('unsupported-semantics'),
      unsupportedClauses: [error.message] };
    if (error instanceof Budget) return empty('budget-exhausted');
    throw error;
  }
  const rootId = `root#${root.name}@${root.version}`;
  const selected = new Map<string, Release>();
  const missing = new Set<string>();
  const visit = [root];
  let edgeCount = 0;
  let activationCount = 0;
  // V1 traversal is frozen for durable replay. V2 must not lock-select inactive
  // transitive optional dependencies: doing so could invent a links conflict.
  if (linksProfile) {
    const states = new Map<Release, { requested: Set<string>; processed?: string }>();
    const enqueue = (release: Release, features: string[], defaults: boolean) => {
      let state = states.get(release);
      const created = !state;
      if (!state) { state = { requested: new Set() }; states.set(release, state); }
      const previousSize = state.requested.size;
      for (const feature of features) state.requested.add(feature);
      if (defaults && release.features.default) state.requested.add('default');
      if (created || previousSize !== state.requested.size) visit.push(release);
    };
    visit.length = 0;
    const hiddenOptional = new Set(Object.values(root.features).flat());
    enqueue(root, [...input.features, ...Object.keys(root.features),
      ...root.dependencies.filter(dependency => dependency.optional
        && !hiddenOptional.has(`dep:${dependency.name}`)).map(dependency => dependency.name)], true);
    try {
      while (visit.length) {
        const current = visit.shift()!;
        const state = states.get(current)!;
        const signature = [...state.requested].sort().join('\0');
        if (state.processed === signature) continue;
        state.processed = signature;
        const expanded = expandFeatures(current, state.requested);
        activationCount += expanded.active.size;
        if (activationCount > MAX_ACTIVATIONS) throw new Budget('Cargo lock feature activation limit');
        for (const dependency of current.dependencies) {
          if (dependency.optional && !expanded.optional.has(dependency.name)) continue;
          if (++edgeCount > MAX_EDGES) throw new Budget('Cargo lock edge limit');
          const key = `${dependency.name}@${dependency.version}`;
          const release = releases.get(key);
          if (!release) { missing.add(key); continue; }
          selected.set(key, release);
          enqueue(release, [...dependency.features,
            ...(expanded.dependencyFeatures.get(dependency.name) ?? [])], dependency.defaultFeatures);
        }
      }
    } catch (error) {
      if (error instanceof Unsupported) return { ...empty('unsupported-semantics',
        selected.size, edgeCount, activationCount), unsupportedClauses: [error.message] };
      if (error instanceof Budget) return empty('budget-exhausted', selected.size, edgeCount, activationCount);
      throw error;
    }
  } else while (visit.length) {
    const current = visit.shift()!;
    for (const dependency of current.dependencies) {
      if (++edgeCount > MAX_EDGES) return empty('budget-exhausted', selected.size, edgeCount);
      const key = `${dependency.name}@${dependency.version}`;
      const release = releases.get(key);
      if (!release) missing.add(key);
      else if (!selected.has(key)) { selected.set(key, release); visit.push(release); }
    }
  }
  if (missing.size) return { ...empty('incomplete-source-data', selected.size, edgeCount, activationCount),
    missing: [...missing].sort() };
  const compatibility = new Map<string, string>();
  for (const release of selected.values()) {
    const key = `${release.name}:${compatibilityClass(release.version)}`;
    const prior = compatibility.get(key);
    if (prior && prior !== release.version) return {
      ...empty('unsupported-semantics', selected.size, edgeCount, activationCount),
      unsupportedClauses: [`compatible exact version collision: ${release.name}`] };
    compatibility.set(key, release.version);
  }
  const lock = [...selected.values()].map(release => ({
    id: sourceId(input.registryIndexUrl, release.name, release.version),
    source: input.registryIndexUrl, name: release.name, version: release.version,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const states = new Map<string, { release: Release; role: Role; requested: Set<string>;
    active: Set<string>; processed?: string }>();
  const graphEdges = new Map<string, CargoEdge>();
  const queue: string[] = [];
  const ensure = (release: Release, role: Role, features: string[], defaults: boolean): string => {
    const packageId = release === root ? rootId
      : sourceId(input.registryIndexUrl, release.name, release.version);
    const id = `${packageId}#${role}`;
    let state = states.get(id);
    const created = !state;
    if (!state) {
      state = { release, role, requested: new Set(), active: new Set() };
      states.set(id, state);
    }
    let changed = false;
    for (const feature of [...features, ...(defaults && release.features.default ? ['default'] : [])]) {
      if (!state.requested.has(feature)) { state.requested.add(feature); changed = true; }
    }
    if (changed || created) queue.push(id);
    return id;
  };
  ensure(root, 'target', input.features, input.defaultFeatures);
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const state = states.get(id)!;
      const signature = [...state.requested].sort().join('\0');
      if (state.processed === signature) continue;
      state.processed = signature;
      const expanded = expandFeatures(state.release, state.requested);
      state.active = expanded.active;
      activationCount += expanded.active.size;
      if (activationCount > MAX_ACTIVATIONS) throw new Budget('Cargo feature activation limit');
      for (const dependency of state.release.dependencies) {
        if (dependency.optional && !expanded.optional.has(dependency.name)) continue;
        const role = dependency.kind === 'build' ? 'host' : state.role;
        if (!targetMatches(dependency.target, role === 'host' ? input.host : input.target)) continue;
        const release = selected.get(`${dependency.name}@${dependency.version}`)!;
        const features = [...new Set([...dependency.features,
          ...(expanded.dependencyFeatures.get(dependency.name) ?? [])])].sort();
        const to = ensure(release, role, features, dependency.defaultFeatures);
        const edge: CargoEdge = { from: id, to, kind: dependency.kind,
          target: dependency.target, requestedFeatures: features,
          defaultFeatures: dependency.defaultFeatures };
        graphEdges.set(stable(edge), edge);
        if (graphEdges.size > MAX_EDGES || states.size > MAX_RELEASES * 2) {
          throw new Budget('Cargo graph limit');
        }
      }
    }
  } catch (error) {
    if (error instanceof Unsupported) return { ...empty('unsupported-semantics',
      selected.size, edgeCount, activationCount), unsupportedClauses: [error.message] };
    if (error instanceof Budget) return empty('budget-exhausted',
      selected.size, edgeCount, activationCount);
    throw error;
  }
  if (linksProfile) {
    const owners = new Map<string, CargoLinksConflict['packages']>();
    const roles = new Map<string, Role[]>();
    for (const state of states.values()) {
      if (state.release === root) continue;
      const id = sourceId(input.registryIndexUrl, state.release.name, state.release.version);
      const active = roles.get(id) ?? [];
      active.push(state.role);
      roles.set(id, active);
    }
    for (const identity of lock) {
      const release = selected.get(`${identity.name}@${identity.version}`)!;
      if (release.links === null) continue;
      const packages = owners.get(release.links) ?? [];
      packages.push({ ...identity, roles: (roles.get(identity.id) ?? []).sort() });
      owners.set(release.links, packages);
    }
    const linksConflicts: CargoLinksConflict[] = [...owners]
      .filter(([, packages]) => packages.length > 1)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([links, packages]) => ({ kind: 'native-links', links, packages }));
    if (linksConflicts.length) return { ...empty('unsatisfiable', selected.size,
      edgeCount, activationCount), linksConflicts };
  }
  return { status: 'solved', selected: lock,
    instances: [...states].map(([id, state]) => ({ id,
      source: state.release === root ? 'root' : input.registryIndexUrl,
      name: state.release.name, version: state.release.version, role: state.role,
      features: [...state.active].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graphEdges.values()].sort((a, b) => stable(a).localeCompare(stable(b))),
    missing: [], unsupportedClauses: [], releaseCount: selected.size,
    edgeCount, featureActivationCount: activationCount };
}

interface Row { id: string; principal_id: string; idempotency_key: string;
  request_digest: string; request: CargoRequest; outcome: CargoOutcome; created_at: Date }
export class CargoResolutionStore {
  constructor(private readonly pool: Pool) {}
  private verified(row: Row): CargoResolution {
    if (row.request_digest !== sha(Buffer.from(stable(row.request)))
      || stable(row.outcome) !== stable(solveCargoSnapshot(row.request))) {
      throw new CargoResolutionUnavailable('stored Cargo resolution differs from its snapshot');
    }
    return { profile: row.request.profile === 'cargo-index-exact-resolver2-v2'
      ? 'cargo-index-exact-resolution-v2' : 'cargo-index-exact-resolution-v1',
      resolution: `https://rezics.com/id/${row.id}`, requestDigest: row.request_digest,
      request: row.request, outcome: row.outcome, createdAt: row.created_at.toISOString() };
  }
  async resolve(principalId: string, key: string, request: CargoRequest):
    Promise<{ resolution: CargoResolution; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) invalid('invalid Cargo resolution key');
    const outcome = solveCargoSnapshot(request);
    const digest = sha(Buffer.from(stable(request)));
    const inserted = await this.pool.query(`INSERT INTO pkg.cargo_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, digest,
      JSON.stringify(request), JSON.stringify(outcome)]);
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.cargo_resolution
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.request_digest !== digest) {
      throw new CargoResolutionConflict('Cargo resolution key binds another snapshot');
    }
    return { resolution: this.verified(row), replayed: inserted.rowCount === 0 };
  }
  async read(principalId: string, id: string): Promise<CargoResolution | null> {
    if (!UUID.test(principalId) || !UUID.test(id)) invalid('invalid Cargo resolution identity');
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.cargo_resolution
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
