import { createHash } from 'node:crypto';
import { NpmResolutionInvalid, npmSha, npmStable, type NpmBytes } from './npm-lock.ts';
import { compareNpmVersions, formatNpmVersion, npmSatisfies, parseNpmRange, parseNpmVersion,
  type NpmSemver } from './npm-semver.ts';

// `npm-registry-range-v1`: fresh range solving over a lazily captured registry snapshot, following
// npm 11.19.1's manifest picker, dependency-type precedence, ideal-tree queue order and strict
// peer placement. Main never runs npm; the native oracle compares the same frozen snapshot.
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const npmRegistryStrategies = ['npm-hoisted', 'npm-nested', 'npm-shallow'] as const;
export type NpmRegistryStrategy = typeof npmRegistryStrategies[number];
export interface NpmRegistryRequest {
  profile: 'npm-registry-range-v1'; npmVersion: string; policy: string; strategy: string;
  registry: string; target: { os: string; cpu: string };
  engineTarget: { nodeVersion: string; npmVersion: string };
  artifacts: 'verify-sri' | 'metadata-only';
  manifest: NpmBytes; workspaces: Array<{ path: string; manifest: NpmBytes }>;
}
export interface NpmRegistryRecord {
  version: string; deprecated: boolean; engines: { node: string | null; npm: string | null };
  dependencies: Record<string, string>; optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>; peerOptional: string[];
  os: string[] | null; cpu: string[] | null; libc: string[] | null;
  tarball: string | null; integrity: string | null; hasInstallScript: boolean;
  bundled: boolean; hasShrinkwrap: boolean;
}
export interface NpmRegistryPackument {
  name: string; url: string; status: 'captured' | 'unavailable' | 'malformed' | 'budget-exhausted';
  reason: string | null; httpStatus: number | null; sha256: string | null; byteLength: number | null;
  versionCount: number; distTags: Record<string, string>; records: NpmRegistryRecord[];
}
export interface NpmRegistryArtifact {
  name: string; version: string; tarball: string; integrity: string;
  status: 'verified' | 'integrity-mismatch' | 'unavailable' | 'budget-exhausted';
  algorithm: string | null; observed: string | null; byteLength: number | null; httpStatus: number | null;
}
export interface NpmRegistrySnapshot {
  origin: typeof NPM_REGISTRY_ORIGIN; packuments: NpmRegistryPackument[];
  artifacts: NpmRegistryArtifact[]; deadlineExceeded: string | null;
}
export type NpmRegistryEdgeType = 'prod' | 'optional' | 'peer' | 'peerOptional' | 'dev' | 'workspace';
export interface NpmRegistryInstance {
  id: string; path: string; kind: 'root' | 'workspace' | 'link' | 'registry'; slotName: string | null;
  name: string; version: string; resolved: string | null; integrity: string | null;
  linkTarget: string | null; dev: boolean; optional: boolean; devOptional: boolean; peer: boolean; active: boolean;
  hasInstallScript: boolean; engineOk: boolean;
  selection: { spec: string; requestedBy: string; reason: NpmSelectionReason; higherSatisfying: string[] } | null;
  peerHosts: Array<{ name: string; spec: string; optional: boolean; hostPath: string | null }>;
}
export type NpmSelectionReason = 'latest-tag' | 'dist-tag' | 'exact-version' | 'highest-satisfying'
  | 'engine-or-deprecation-preference' | 'workspace-link';
export interface NpmRegistryEdge {
  from: string; to: string | null; type: NpmRegistryEdgeType; name: string; spec: string;
  effectiveSpec: string; requestedName: string; valid: boolean;
}
export interface NpmRegistryConflict {
  kind: 'peer-conflict' | 'no-matching-version' | 'platform' | 'missing-workspace';
  path: string; name: string; spec: string; foundPath: string | null; foundVersion: string | null;
  candidates: string[];
}
export interface NpmRegistryOutcome {
  status: 'solved' | 'unsatisfiable' | 'incomplete-source-data' | 'inconsistent-source-data'
    | 'unsupported-semantics' | 'budget-exhausted';
  resolutionId: string; snapshotDigest: string; strategy: string;
  target: NpmRegistryRequest['target']; engineTarget: NpmRegistryRequest['engineTarget'];
  instances: NpmRegistryInstance[]; edges: NpmRegistryEdge[];
  omitted: Array<{ id: string; path: string; reason: 'platform'; causePath: string }>;
  engineWarnings: Array<{ path: string; required: { node: string | null; npm: string | null } }>;
  conflict: NpmRegistryConflict | null;
  issues: Array<{ kind: 'unavailable-packument' | 'malformed-packument' | 'unavailable-artifact'
    | 'integrity-mismatch' | 'missing-workspace'; name: string; version: string | null; detail: string }>;
  unsupportedClauses: string[]; budgetReason: string | null;
  artifactVerification: 'verified' | 'not-requested' | 'failed' | 'not-reached';
  cost: { inputBytes: number; packuments: number; packumentBytes: number; retainedRecords: number;
    nodes: number; edges: number; placementChecks: number; lookups: number; artifacts: number; artifactBytes: number };
  sourceSnapshot: NpmRegistrySnapshot;
}

export const npmRegistryLimits = {
  manifestBytes: 65_536, workspaces: 16, packuments: 64, packumentBytes: 16 * 1024 * 1024,
  totalPacumentBytes: 64 * 1024 * 1024, versionsPerPackument: 8_192, retainedRecords: 4_096,
  nodes: 512, edges: 4_096, placementChecks: 16_384, lookups: 4_194_304, artifacts: 256,
  artifactBytes: 32 * 1024 * 1024, totalArtifactBytes: 256 * 1024 * 1024, deadlineMs: 60_000,
} as const;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,213}\/)?[a-z0-9._~-][a-z0-9._~-]{0,213}$/;
const SHA = /^[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORKSPACE = /^(?!.*(?:^|\/)(?:\.|\.\.|node_modules)(?:\/|$))[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+){0,7}$/;
const TARGETS = { os: ['linux', 'win32', 'darwin'], cpu: ['x64', 'arm64'] } as const;

class Unsupported extends Error {}
class Budget extends Error {}
class Unsatisfiable extends Error { constructor(readonly conflict: NpmRegistryConflict) { super(conflict.kind); } }
class Incomplete extends Error {
  constructor(readonly issue: NpmRegistryOutcome['issues'][number], readonly inconsistent = false) { super(issue.detail); }
}
function invalid(message: string): never { throw new NpmResolutionInvalid(message); }

export function npmRegistryPackumentUrl(name: string): string {
  return `${NPM_REGISTRY_ORIGIN}/${name.replace('/', '%2f')}`;
}
export function npmRegistryTarballAllowed(name: string, tarball: string): boolean {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return tarball.startsWith(`${NPM_REGISTRY_ORIGIN}/${name}/-/${base}-`) && tarball.endsWith('.tgz')
    && !tarball.includes('?') && !tarball.includes('#') && !tarball.slice(8).includes('//');
}

function decode(value: NpmBytes, label: string): { text: string; bytes: number } {
  if (!value || typeof value !== 'object' || typeof value.bytesBase64 !== 'string'
    || typeof value.sha256 !== 'string' || !SHA.test(value.sha256)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytesBase64)) {
    invalid(`malformed ${label} bytes or digest`);
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.toString('base64') !== value.bytesBase64) invalid(`${label} base64 is not canonical`);
  if (npmSha(bytes) !== value.sha256) invalid(`${label} digest mismatch`);
  if (bytes.length > npmRegistryLimits.manifestBytes) throw new Budget(`${label} exceeds ${npmRegistryLimits.manifestBytes} bytes`);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: bytes.length }; }
  catch { invalid(`${label} is not UTF-8`); }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
function specMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const map = record(value, label);
  for (const [name, spec] of Object.entries(map)) {
    if (!NAME.test(name) || typeof spec !== 'string' || spec.length > 256) invalid(`${label} has malformed entry ${name}`);
  }
  return map as Record<string, string>;
}
interface Manifest {
  name: string; version: string; dependencies: Record<string, string>; devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>; peerDependencies: Record<string, string>; peerOptional: string[];
  overrides: Record<string, string>; workspaces: string[]; unsupported: string[];
}
function manifest(text: string, label: string, root: boolean): Manifest {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid(`${label} is not JSON`); }
  const value = record(parsed, label);
  if (typeof value.name !== 'string' || !NAME.test(value.name)) invalid(`${label} name is malformed`);
  const version = value.version === undefined && root ? '0.0.0' : value.version;
  if (typeof version !== 'string' || !parseNpmVersion(version) || version !== version.trim()) {
    invalid(`${label} version is malformed`);
  }
  const unsupported: string[] = [];
  for (const field of ['acceptDependencies', 'bundleDependencies', 'bundledDependencies']) {
    if (value[field] !== undefined) unsupported.push(`manifest:${field}`);
  }
  const meta = value.peerDependenciesMeta === undefined ? {} : record(value.peerDependenciesMeta, `${label} peerDependenciesMeta`);
  const peerDependencies = specMap(value.peerDependencies, `${label} peerDependencies`);
  const peerOptional = Object.keys(peerDependencies).filter(name => {
    const entry = meta[name];
    return !!entry && typeof entry === 'object' && (entry as { optional?: unknown }).optional === true;
  }).sort();
  const overrides: Record<string, string> = {};
  if (value.overrides !== undefined) {
    if (!root) unsupported.push('manifest:workspace-overrides');
    for (const [name, spec] of Object.entries(record(value.overrides, `${label} overrides`))) {
      if (!NAME.test(name)) invalid(`${label} override name is malformed`);
      if (typeof spec !== 'string') { unsupported.push('override:nested'); continue; }
      if (spec.startsWith('$') || !parseNpmRange(spec)) { unsupported.push('override:reference-or-non-range'); continue; }
      overrides[name] = spec;
    }
  }
  let workspaces: string[] = [];
  if (value.workspaces !== undefined) {
    if (!root) unsupported.push('manifest:nested-workspaces');
    const list = Array.isArray(value.workspaces) ? value.workspaces
      : record(value.workspaces, `${label} workspaces`).packages;
    if (!Array.isArray(list) || list.length > npmRegistryLimits.workspaces
      || list.some(item => typeof item !== 'string')) invalid(`${label} workspaces are malformed`);
    workspaces = list as string[];
    for (const pattern of workspaces) {
      const glob = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
      if (!WORKSPACE.test(glob)) unsupported.push('workspace:pattern');
    }
  }
  return { name: value.name, version, dependencies: specMap(value.dependencies, `${label} dependencies`),
    devDependencies: specMap(value.devDependencies, `${label} devDependencies`),
    optionalDependencies: specMap(value.optionalDependencies, `${label} optionalDependencies`),
    peerDependencies, peerOptional, overrides, workspaces, unsupported };
}

type Spec = { type: 'range' | 'version' | 'tag'; packageName: string; value: string; alias: boolean };
function classify(name: string, raw: string): Spec {
  let packageName = name;
  let spec = raw.trim() === '' ? '*' : raw;
  let alias = false;
  if (spec.startsWith('npm:')) {
    const body = spec.slice(4);
    const at = body.indexOf('@', body.startsWith('@') ? 1 : 0);
    packageName = at < 0 ? body : body.slice(0, at);
    spec = at < 0 ? '*' : body.slice(at + 1) || '*';
    alias = true;
    if (!NAME.test(packageName) || spec.startsWith('npm:')) throw new Unsupported('spec:alias-grammar');
  }
  if (parseNpmVersion(spec)) return { type: 'version', packageName, value: formatNpmVersion(parseNpmVersion(spec)!), alias };
  if (parseNpmRange(spec)) return { type: 'range', packageName, value: spec, alias };
  if (TAG.test(spec) && encodeURIComponent(spec) === spec) return { type: 'tag', packageName, value: spec, alias };
  throw new Unsupported(/^(?:file|link|workspace|git\+?[a-z]*|https?|github|gitlab|bitbucket|gist):/.test(spec)
    ? `spec:${spec.slice(0, spec.indexOf(':'))}` : spec.includes('/') ? 'spec:hosted-shorthand' : 'spec:unknown');
}

interface Node {
  path: string; kind: NpmRegistryInstance['kind']; name: string; packageName: string; version: string;
  semver: NpmSemver; record: NpmRegistryRecord | null; parent: Node | null; top: boolean;
  children: Map<string, Node>; target: Node | null; edges: Map<string, EdgeDecl>;
  selection: NpmRegistryInstance['selection'];
}
interface EdgeDecl { name: string; type: NpmRegistryEdgeType; spec: string; effective: string }
export interface NpmRegistrySource {
  packument(name: string): Promise<NpmRegistryPackument>;
}

// Arborist sorts its queue by depth then path; tops (root and workspace targets) have depth 0.
function depth(node: Node): number { return node.path.split('node_modules/').length - 1; }
function resolveParent(node: Node, root: Node): Node | null {
  return node.kind === 'workspace' ? root : node.parent;
}
function childPath(parent: Node, name: string): string {
  return `${parent.path ? `${parent.path}/` : ''}node_modules/${name}`;
}
function real(node: Node): Node { return node.kind === 'link' ? node.target! : node; }

export async function solveNpmRegistry(request: NpmRegistryRequest, source: NpmRegistrySource): Promise<{ outcome: Omit<NpmRegistryOutcome, 'sourceSnapshot' | 'artifactVerification' | 'snapshotDigest' | 'resolutionId'>;
    names: Map<string, Set<string>>; selected: Map<string, Set<string>> }> {
  const cost = { inputBytes: 0, packuments: 0, packumentBytes: 0, retainedRecords: 0, nodes: 0, edges: 0,
    placementChecks: 0, lookups: 0, artifacts: 0, artifactBytes: 0 };
  const names = new Map<string, Set<string>>();
  const selected = new Map<string, Set<string>>();
  const base = { strategy: request?.strategy, target: request?.target, engineTarget: request?.engineTarget };
  const empty = (status: NpmRegistryOutcome['status'], extra: Partial<NpmRegistryOutcome>) => ({
    ...base, status, instances: [], edges: [], omitted: [], engineWarnings: [], conflict: null, issues: [],
    unsupportedClauses: [], budgetReason: null, cost, ...extra });
  try {
    const { root, supplied } = admit(request, cost);
    const packuments = new Map<string, NpmRegistryPackument>();
    const load = async (name: string): Promise<NpmRegistryPackument> => {
      const known = packuments.get(name);
      if (known) return known;
      if (packuments.size >= npmRegistryLimits.packuments) throw new Budget('packument count limit');
      const loaded = await source.packument(name);
      if (loaded.name !== name) throw new Error('registry source returned another packument');
      packuments.set(name, loaded);
      cost.packuments += 1;
      cost.packumentBytes += loaded.byteLength ?? 0;
      if (loaded.status === 'budget-exhausted') throw new Budget(loaded.reason ?? 'packument budget');
      if (loaded.status !== 'captured') {
        throw new Incomplete({ kind: loaded.status === 'malformed' ? 'malformed-packument' : 'unavailable-packument',
          name, version: null, detail: loaded.reason ?? 'packument unavailable' }, loaded.status === 'malformed');
      }
      return loaded;
    };
    const tree = await build(request, root, supplied, load, cost, names, selected);
    return { outcome: { ...base, ...tree, issues: [], unsupportedClauses: [], budgetReason: null, cost }, names, selected };
  } catch (error) {
    if (error instanceof NpmResolutionInvalid) throw error;
    if (error instanceof Unsupported) return { outcome: empty('unsupported-semantics', { unsupportedClauses: [error.message] }), names, selected };
    if (error instanceof Budget) return { outcome: empty('budget-exhausted', { budgetReason: error.message }), names, selected };
    if (error instanceof Unsatisfiable) return { outcome: empty('unsatisfiable', { conflict: error.conflict }), names, selected };
    if (error instanceof Incomplete) {
      return { outcome: empty(error.inconsistent ? 'inconsistent-source-data' : 'incomplete-source-data',
        { issues: [error.issue] }), names, selected };
    }
    throw error;
  }
}

function admit(request: NpmRegistryRequest, cost: { inputBytes: number }) {
  admitEnvelope(request);
  const rootFile = decode(request.manifest, 'root manifest');
  cost.inputBytes += rootFile.bytes;
  const root = manifest(rootFile.text, 'root manifest', true);
  const supplied = request.workspaces.map(workspace => {
    if (!workspace || typeof workspace.path !== 'string') invalid('workspace input is malformed');
    const file = decode(workspace.manifest, `workspace ${workspace.path}`);
    cost.inputBytes += file.bytes;
    return { path: workspace.path, manifest: manifest(file.text, `workspace ${workspace.path}`, false) };
  });
  admitWorkspaces(root, supplied);
  const unsupported = [...root.unsupported, ...supplied.flatMap(item => item.manifest.unsupported)];
  if (!npmRegistryStrategies.includes(request.strategy as NpmRegistryStrategy)) {
    unsupported.push(`strategy:${request.strategy}`);
  }
  if (unsupported.length) throw new Unsupported([...new Set(unsupported)].sort()[0]!);
  return { root, supplied };
}
/** Rejects malformed input (422) before any provider request; other outcomes are left to the solve. */
export function admitNpmRegistryRequest(request: NpmRegistryRequest): void {
  try { admit(request, { inputBytes: 0 }); } catch (error) {
    if (error instanceof NpmResolutionInvalid) throw error;
  }
}
function admitEnvelope(request: NpmRegistryRequest): void {
  if (!request || typeof request !== 'object') invalid('npm registry request must be an object');
  if (request.npmVersion !== '11.19.1') throw new Unsupported(`npm-version:${request.npmVersion}`);
  if (request.policy !== 'npm-strict-peers-advisory-engines-v1') throw new Unsupported(`policy:${request.policy}`);
  if (request.registry !== `${NPM_REGISTRY_ORIGIN}/`) throw new Unsupported('registry:origin');
  if (!request.target || !TARGETS.os.includes(request.target.os as never)
    || !TARGETS.cpu.includes(request.target.cpu as never)) throw new Unsupported('target:platform');
  const engine = request.engineTarget;
  if (!engine || !parseNpmVersion(engine.nodeVersion) || !parseNpmVersion(engine.npmVersion)
    || engine.nodeVersion.startsWith('v') || engine.npmVersion.startsWith('v')) invalid('engine target must be exact versions');
  if (request.artifacts !== 'verify-sri' && request.artifacts !== 'metadata-only') invalid('artifact policy is malformed');
  if (!Array.isArray(request.workspaces) || request.workspaces.length > npmRegistryLimits.workspaces) {
    invalid('workspace inputs are malformed');
  }
}
function admitWorkspaces(root: Manifest, supplied: Array<{ path: string; manifest: Manifest }>): void {
  const paths = new Set<string>();
  const names = new Set<string>([root.name]);
  for (const item of supplied) {
    if (!WORKSPACE.test(item.path) || paths.has(item.path)) invalid('workspace path is malformed or duplicated');
    if (names.has(item.manifest.name)) invalid('workspace package name is duplicated');
    paths.add(item.path);
    names.add(item.manifest.name);
    const matched = root.workspaces.some(pattern => pattern.endsWith('/*')
      ? item.path.startsWith(`${pattern.slice(0, -2)}/`) && !item.path.slice(pattern.length - 1).includes('/')
      : pattern === item.path);
    if (!matched) invalid(`workspace ${item.path} is not declared by the root manifest`);
    if (supplied.some(other => other !== item && other.path.startsWith(`${item.path}/`))) {
      throw new Unsupported('workspace:nested');
    }
  }
  for (const pattern of root.workspaces) {
    if (!pattern.endsWith('/*') && !paths.has(pattern)) {
      throw new Incomplete({ kind: 'missing-workspace', name: pattern, version: null,
        detail: 'declared workspace manifest was not supplied' });
    }
  }
}

function recordFor(packument: NpmRegistryPackument, version: string): NpmRegistryRecord | null {
  return packument.records.find(item => item.version === version) ?? null;
}
function engineOk(record: NpmRegistryRecord, engine: NpmRegistryRequest['engineTarget']): boolean {
  const node = parseNpmVersion(engine.nodeVersion)!;
  const npm = parseNpmVersion(engine.npmVersion)!;
  const check = (range: string | null, version: NpmSemver) => {
    if (range === null) return true;
    const parsed = parseNpmRange(range);
    return !!parsed && npmSatisfies(version, parsed, true);
  };
  return check(record.engines.node, node) && check(record.engines.npm, npm);
}
export function npmPlatformOk(list: string[] | null, value: string): boolean {
  if (!list) return true;
  if (list.length === 1 && list[0] === 'any') return true;
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (entry.startsWith('!')) { negated += 1; if (entry.slice(1) === value) return false; }
    else match ||= entry === value;
  }
  return match || negated === list.length;
}
/** npm-pick-manifest 11.x ordering over the retained candidate records. */
export function pickNpmManifest(packument: NpmRegistryPackument, spec: Spec,
  engine: NpmRegistryRequest['engineTarget']): { record: NpmRegistryRecord; reason: NpmSelectionReason;
    higherSatisfying: string[] } | null {
  if (spec.type === 'tag') {
    const version = packument.distTags[spec.value];
    const found = version ? recordFor(packument, version) : null;
    return found ? { record: found, reason: 'dist-tag', higherSatisfying: [] } : null;
  }
  if (spec.type === 'version') {
    const found = recordFor(packument, spec.value);
    return found ? { record: found, reason: 'exact-version', higherSatisfying: [] } : null;
  }
  const range = parseNpmRange(spec.value)!;
  const any = spec.value.trim() === '*' || spec.value.trim() === '';
  const latest = packument.distTags.latest;
  const latestRecord = latest ? recordFor(packument, latest) : null;
  const latestVersion = latest ? parseNpmVersion(latest) : null;
  const candidates = packument.records.map(item => ({ item, version: parseNpmVersion(item.version) }))
    .filter((entry): entry is { item: NpmRegistryRecord; version: NpmSemver } => !!entry.version
      && npmSatisfies(entry.version, range));
  const higher = (version: NpmSemver) => candidates.filter(entry => compareNpmVersions(entry.version, version) > 0)
    .map(entry => entry.item.version).sort();
  if (latestRecord && latestVersion && (any || npmSatisfies(latestVersion, range))
    && engineOk(latestRecord, engine) && !latestRecord.deprecated) {
    return { record: latestRecord, reason: 'latest-tag', higherSatisfying: higher(latestVersion) };
  }
  const score = (item: NpmRegistryRecord) => {
    const engine_ = engineOk(item, engine);
    return [Number(!item.deprecated && engine_), Number(engine_), Number(!item.deprecated)];
  };
  candidates.sort((a, b) => {
    const left = score(a.item);
    const right = score(b.item);
    return right[0]! - left[0]! || right[1]! - left[1]! || right[2]! - left[2]!
      || compareNpmVersions(b.version, a.version);
  });
  const winner = candidates[0];
  if (!winner) return null;
  const others = higher(winner.version);
  return { record: winner.item, reason: others.length ? 'engine-or-deprecation-preference' : 'highest-satisfying',
    higherSatisfying: others };
}
function satisfiesEdge(node: Node, decl: EdgeDecl): boolean {
  const target = real(node);
  if (decl.type === 'workspace') return node.kind === 'link' && target.path === decl.spec.slice(5);
  let spec: Spec;
  try { spec = classify(decl.name, decl.effective); } catch { return false; }
  if (spec.type === 'tag') return target.kind === 'registry';
  const trimmed = spec.value.trim();
  if (spec.type === 'range' && (trimmed === '*' || trimmed === '')) return true;
  const range = parseNpmRange(spec.value);
  return !!range && npmSatisfies(target.semver, range);
}

async function build(request: NpmRegistryRequest, rootManifest: Manifest,
  workspaces: Array<{ path: string; manifest: Manifest }>, load: (name: string) => Promise<NpmRegistryPackument>,
  cost: NpmRegistryOutcome['cost'], names: Map<string, Set<string>>, selectedVersions: Map<string, Set<string>>) {
  const strategy = request.strategy as NpmRegistryStrategy;
  const make = (fields: Partial<Node> & Pick<Node, 'path' | 'kind' | 'name' | 'packageName' | 'version'>): Node => {
    cost.nodes += 1;
    if (cost.nodes > npmRegistryLimits.nodes) throw new Budget('node limit');
    return { semver: parseNpmVersion(fields.version)!, record: null, parent: null, top: false,
      children: new Map(), target: null, edges: new Map(), selection: null, ...fields };
  };
  const declare = (node: Node, source: { peerDependencies: Record<string, string>; peerOptional: string[];
    dependencies: Record<string, string>; optionalDependencies: Record<string, string>;
    devDependencies?: Record<string, string> }) => {
    const add = (map: Record<string, string>, type: NpmRegistryEdgeType) => {
      for (const [name, spec] of Object.entries(map)) {
        if (node.edges.get(name)?.type === 'workspace') continue;
        const override = node.kind === 'registry' ? rootManifest.overrides[name] : undefined;
        if (override !== undefined && (type === 'peer' || type === 'peerOptional')) throw new Unsupported('override:peer');
        node.edges.set(name, { name, type, spec, effective: override ?? spec });
        cost.edges += 1;
        if (cost.edges > npmRegistryLimits.edges) throw new Budget('edge limit');
      }
    };
    const optional = new Set(source.peerOptional);
    add(Object.fromEntries(Object.entries(source.peerDependencies).filter(([name]) => !optional.has(name))), 'peer');
    add(Object.fromEntries(Object.entries(source.peerDependencies).filter(([name]) => optional.has(name))), 'peerOptional');
    add(source.dependencies, 'prod');
    add(source.optionalDependencies, 'optional');
    if (source.devDependencies) add(source.devDependencies, 'dev');
  };
  const root = make({ path: '', kind: 'root', name: rootManifest.name, packageName: rootManifest.name,
    version: rootManifest.version, top: true });
  for (const [name, spec] of Object.entries(rootManifest.dependencies)) {
    const override = rootManifest.overrides[name];
    if (override !== undefined && override !== spec) throw new Unsupported('override:direct-conflict-EOVERRIDE');
  }
  const links: Node[] = [];
  for (const workspace of [...workspaces].sort((a, b) => a.path < b.path ? -1 : 1)) {
    const target = make({ path: workspace.path, kind: 'workspace', name: workspace.manifest.name,
      packageName: workspace.manifest.name, version: workspace.manifest.version, top: true });
    const link = make({ path: childPath(root, workspace.manifest.name), kind: 'link', name: workspace.manifest.name,
      packageName: workspace.manifest.name, version: workspace.manifest.version, parent: root, target });
    root.children.set(link.name, link);
    root.edges.set(link.name, { name: link.name, type: 'workspace', spec: `file:${workspace.path}`,
      effective: `file:${workspace.path}` });
    cost.edges += 1;
    links.push(link);
    declare(target, workspace.manifest);
  }
  declare(root, rootManifest);
  const nodes = () => {
    const out: Node[] = [];
    const visit = (node: Node) => {
      out.push(node);
      for (const child of [...node.children.values()]) if (child.kind !== 'link') visit(child);
    };
    visit(root);
    for (const link of links) visit(link.target!);
    return out;
  };
  const lookup = (from: Node, name: string, peer: boolean): Node | null => {
    let scope: Node | null = peer && !from.top ? resolveParent(from, root) : from;
    while (scope) {
      cost.lookups += 1;
      if (cost.lookups > npmRegistryLimits.lookups) throw new Budget('lookup limit');
      const found = scope.children.get(name);
      if (found) return found;
      scope = resolveParent(scope, root);
    }
    return null;
  };
  const edgeTarget = (from: Node, decl: EdgeDecl) => lookup(from, decl.name, decl.type === 'peer' || decl.type === 'peerOptional');
  const valid = (from: Node, decl: EdgeDecl) => {
    const found = edgeTarget(from, decl);
    return !!found && satisfiesEdge(found, decl);
  };
  const descendantOf = (node: Node, ancestor: Node): boolean => {
    for (let scope: Node | null = node; scope; scope = resolveParent(scope, root)) if (scope === ancestor) return true;
    return false;
  };
  const skipped = new Set<string>();
  const edgesInto = (target: Node) => nodes().flatMap(from => [...from.edges.values()]
    .filter(decl => edgeTarget(from, decl) === target).map(decl => ({ from, decl })));

  interface Virtual { name: string; spec: Spec; record: NpmRegistryRecord; packument: NpmRegistryPackument;
    reason: NpmSelectionReason; higher: string[]; peers: Virtual[]; requestedBy: string; declared: string }
  const pick = async (name: string, declared: string, requestedBy: string): Promise<Virtual> => {
    const spec = classify(name, declared);
    const packument = await load(spec.packageName);
    const encountered = names.get(spec.packageName) ?? new Set<string>();
    encountered.add(`${spec.type}:${spec.value}`);
    names.set(spec.packageName, encountered);
    const picked = pickNpmManifest(packument, spec, request.engineTarget);
    if (!picked) {
      throw new Unsatisfiable({ kind: 'no-matching-version', path: requestedBy, name, spec: declared,
        foundPath: null, foundVersion: null, candidates: packument.distTags.latest ? [packument.distTags.latest] : [] });
    }
    if (picked.record.bundled) throw new Unsupported('registry:bundled-dependencies');
    if (picked.record.hasShrinkwrap) throw new Unsupported('registry:npm-shrinkwrap');
    if (picked.record.libc) throw new Unsupported('registry:libc-selector');
    return { name, spec, record: picked.record, packument, reason: picked.reason, higher: picked.higherSatisfying,
      peers: [], requestedBy, declared };
  };
  // A peer set is loaded against the requesting node's declarations (#loadPeerSet with a virtual root).
  const peerSet = async (dep: Virtual, source: Node, seen: Set<string>): Promise<void> => {
    const record = dep.record;
    const optional = new Set(record.peerOptional);
    for (const name of Object.keys(record.peerDependencies).sort()) {
      if (optional.has(name) || seen.has(name)) continue;
      seen.add(name);
      const peerSpec = record.peerDependencies[name]!;
      const sourceEdge = source.edges.get(name);
      const chosen = await pick(name, sourceEdge && sourceEdge.type !== 'workspace' ? sourceEdge.effective : peerSpec,
        `${source.path}`);
      const peerDecl: EdgeDecl = { name, type: 'peer', spec: peerSpec, effective: peerSpec };
      const probe = { semver: parseNpmVersion(chosen.record.version)!, kind: 'registry' } as Node;
      if (!satisfiesEdge(probe, peerDecl)) {
        throw new Unsatisfiable({ kind: 'peer-conflict', path: source.path, name, spec: peerSpec,
          foundPath: null, foundVersion: chosen.record.version, candidates: [] });
      }
      dep.peers.push(chosen);
      await peerSet(chosen, source, seen);
    }
  };
  const CONFLICT = 0; const OK = 1; const KEEP = 2; const REPLACE = 3;
  const canPlace = (dep: Virtual, target: Node, decl: EdgeDecl, entry: Node, depth_: number): number => {
    cost.placementChecks += 1;
    if (cost.placementChecks > npmRegistryLimits.placementChecks) throw new Budget('placement check limit');
    const current = target.children.get(dep.name);
    const targetEdge = target.edges.get(dep.name);
    const depNode = { semver: parseNpmVersion(dep.record.version)!, kind: 'registry', packageName: dep.spec.packageName } as Node;
    let state: number;
    if (!current && targetEdge && targetEdge !== decl && !satisfiesEdge(depNode, targetEdge)) return CONFLICT;
    if (current) {
      const same = real(current).packageName === dep.spec.packageName && current.version === dep.record.version
        && current.kind === 'registry';
      if (same && satisfiesEdge(current, decl)) return KEEP;
      const newer = current.kind === 'registry' && compareNpmVersions(depNode.semver, current.semver) >= 0;
      const replaceable = newer && edgesInto(current).every(({ decl: incoming }) => satisfiesEdge(depNode, incoming));
      if (replaceable) state = REPLACE;
      else if (satisfiesEdge(current, decl)) return KEEP;
      else return CONFLICT;
    } else {
      const visible = target === entry ? null : lookup(target, dep.name, false);
      if (visible) {
        for (const { from, decl: incoming } of edgesInto(visible)) {
          if (descendantOf(from, target) && satisfiesEdge(visible, incoming) && !satisfiesEdge(depNode, incoming)) return CONFLICT;
        }
      }
      state = OK;
    }
    if (depth_ > 64) throw new Budget('peer set depth limit');
    for (const peer of dep.peers) {
      const peerDecl: EdgeDecl = { name: peer.name, type: 'peer', spec: dep.record.peerDependencies[peer.name]!,
        effective: dep.record.peerDependencies[peer.name]! };
      if (canPlace(peer, target, peerDecl, entry, depth_ + 1) === CONFLICT) return CONFLICT;
    }
    return state;
  };
  const queue: Node[] = [];
  const seen = new Set<Node>();
  const push = (node: Node) => { if (!queue.includes(node)) queue.push(node); };
  const remove = (node: Node) => {
    node.parent?.children.delete(node.name);
    for (const child of node.children.values()) remove(child);
  };
  const place = (dep: Virtual, target: Node, state: number, placed: Node[]) => {
    if (state === KEEP) return;
    const current = target.children.get(dep.name);
    const dependents = current ? edgesInto(current).map(item => item.from) : [];
    if (current) remove(current);
    const node = make({ path: childPath(target, dep.name), kind: 'registry', name: dep.name,
      packageName: dep.spec.packageName, version: dep.record.version, record: dep.record, parent: target,
      selection: { spec: dep.declared, requestedBy: dep.requestedBy, reason: dep.reason, higherSatisfying: dep.higher } });
    const versions = selectedVersions.get(dep.spec.packageName) ?? new Set<string>();
    versions.add(dep.record.version);
    selectedVersions.set(dep.spec.packageName, versions);
    target.children.set(dep.name, node);
    declare(node, dep.record);
    placed.push(node);
    for (const from of dependents) { seen.delete(from); push(from); }
  };
  const placeWithPeers = (dep: Virtual, target: Node, decl: EdgeDecl, entry: Node, placed: Node[]) => {
    place(dep, target, canPlace(dep, target, decl, entry, 0), placed);
    const host = target.children.get(dep.name)!;
    for (const peer of dep.peers) {
      const peerDecl: EdgeDecl = { name: peer.name, type: 'peer', spec: dep.record.peerDependencies[peer.name]!,
        effective: dep.record.peerDependencies[peer.name]! };
      if (valid(host, peerDecl)) continue;
      placeWithPeers(peer, target, peerDecl, entry, placed);
    }
  };
  const problemEdges = (node: Node) => [...node.edges.values()].filter(decl => {
    if (decl.type === 'workspace') return false;
    const found = edgeTarget(node, decl);
    if (!found) return decl.type !== 'peerOptional';
    return !satisfiesEdge(found, decl);
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const step = async (node: Node) => {
    if (seen.has(node) || (node.kind === 'registry' && !node.parent?.children.has(node.name))) return;
    if (node.kind === 'registry' && node.parent!.children.get(node.name) !== node) return;
    seen.add(node);
    const tasks: Array<{ decl: EdgeDecl; dep: Virtual }> = [];
    for (const decl of problemEdges(node)) {
      if (skipped.has(`${node.path}\0${decl.name}`)) continue;
      let dep: Virtual;
      try { dep = await pick(decl.name, decl.effective, node.path); } catch (error) {
        // npm drops an optional dependency whose manifest cannot be picked; required edges fail.
        if (decl.type !== 'optional' || !(error instanceof Unsatisfiable)) throw error;
        skipped.add(`${node.path}\0${decl.name}`);
        continue;
      }
      const peerSource = decl.type === 'peer' && !node.top ? resolveParent(node, root)! : node;
      await peerSet(dep, peerSource, new Set([dep.name]));
      tasks.push({ decl, dep });
    }
    for (const { decl, dep } of tasks) {
      if (valid(node, decl)) continue;
      const start = (decl.type === 'peer' || decl.type === 'peerOptional') && !node.top ? resolveParent(node, root)! : node;
      let chosen: { target: Node; state: number } | null = null;
      for (let target: Node | null = start; target; target = resolveParent(target, root)) {
        const targetEdge = target.edges.get(dep.name);
        if (!target.top && targetEdge && (targetEdge.type === 'peer' || targetEdge.type === 'peerOptional')) continue;
        const state = canPlace(dep, target, decl, start, 0);
        if (state === CONFLICT) break;
        chosen = { target, state };
        if (strategy === 'npm-nested') break;
        if (strategy === 'npm-shallow' && resolveParent(target, root) === root) break;
      }
      if (!chosen) {
        const found = edgeTarget(node, decl);
        throw new Unsatisfiable({ kind: 'peer-conflict', path: node.path, name: decl.name, spec: decl.effective,
          foundPath: found?.path ?? null, foundVersion: found ? real(found).version : null, candidates: [dep.record.version] });
      }
      const placed: Node[] = [];
      placeWithPeers(dep, chosen.target, decl, start, placed);
      for (const item of placed) push(item);
    }
    for (const decl of node.edges.values()) {
      if (decl.type === 'peerOptional' || decl.type === 'workspace' || skipped.has(`${node.path}\0${decl.name}`)) continue;
      if (!valid(node, decl)) {
        const found = edgeTarget(node, decl);
        throw new Unsatisfiable({ kind: 'peer-conflict', path: node.path, name: decl.name, spec: decl.effective,
          foundPath: found?.path ?? null, foundVersion: found ? real(found).version : null, candidates: [] });
      }
    }
  };
  push(root);
  for (let round = 0; round < 2; round += 1) {
    while (queue.length) {
      queue.sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path, 'en'));
      await step(queue.shift()!);
    }
    if (round === 0) for (const link of links) push(link.target!);
  }
  for (const node of nodes()) {
    for (const decl of node.edges.values()) {
      const found = edgeTarget(node, decl);
      if (found && decl.type === 'peerOptional' && !satisfiesEdge(found, decl)) {
        throw new Unsatisfiable({ kind: 'peer-conflict', path: node.path, name: decl.name, spec: decl.effective,
          foundPath: found.path, foundVersion: real(found).version, candidates: [] });
      }
      if (found && found.kind === 'registry' && decl.type !== 'workspace'
        && classify(decl.name, decl.effective).packageName !== found.packageName) throw new Unsupported('alias:identity');
    }
  }
  return finish(request, root, links, nodes, edgeTarget, satisfiesEdge);
}

function finish(request: NpmRegistryRequest, root: Node, links: Node[], all: () => Node[],
  edgeTarget: (from: Node, decl: EdgeDecl) => Node | null, satisfies: (node: Node, decl: EdgeDecl) => boolean) {
  // Prune extraneous nodes (not reachable through resolved edges), then compute npm dependency flags.
  const reachable = new Set<Node>([root]);
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    for (const decl of node.edges.values()) {
      const found = edgeTarget(node, decl);
      if (!found) continue;
      for (const item of found.kind === 'link' ? [found, found.target!] : [found]) {
        if (!reachable.has(item)) { reachable.add(item); pending.push(item); }
      }
    }
  }
  const prune = (node: Node) => {
    for (const child of [...node.children.values()]) {
      if (!reachable.has(child)) node.children.delete(child.name);
      else if (child.kind !== 'link') prune(child);
    }
  };
  prune(root);
  for (const link of links) prune(link.target!);
  const nodes = all().filter(node => reachable.has(node));
  const everything = [...nodes, ...links.filter(link => reachable.has(link))].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const flags = new Map<Node, { dev: boolean; optional: boolean; devOptional: boolean; peer: boolean }>();
  for (const node of everything) {
    const dependent = node.kind === 'registry' || node.kind === 'link';
    flags.set(node, { dev: dependent, optional: dependent, devOptional: dependent, peer: node.kind === 'registry' });
  }
  const unset = (flag: 'dev' | 'optional' | 'devOptional' | 'peer', through: (decl: EdgeDecl) => boolean) => {
    const work = everything.filter(node => node.kind === 'root' || node.kind === 'workspace');
    while (work.length) {
      const node = work.pop()!;
      for (const decl of node.edges.values()) {
        if (!through(decl)) continue;
        const found = edgeTarget(node, decl);
        if (!found) continue;
        for (const item of found.kind === 'link' ? [found, found.target!] : [found]) {
          const state = flags.get(item);
          if (state?.[flag]) { state[flag] = false; work.push(item); }
        }
      }
    }
  };
  // Only nodes reachable from a top through non-dev edges lose `dev`, and so on for optional/peer.
  unset('dev', decl => decl.type !== 'dev');
  unset('optional', decl => decl.type !== 'optional' && decl.type !== 'peerOptional');
  unset('peer', decl => decl.type !== 'peer' && decl.type !== 'peerOptional');
  unset('devOptional', decl => decl.type !== 'dev' && decl.type !== 'optional' && decl.type !== 'peerOptional');
  const failed = new Map<Node, string>();
  for (const node of everything) {
    const record = node.record;
    if (!record) continue;
    if (!npmPlatformOk(record.os, request.target.os) || !npmPlatformOk(record.cpu, request.target.cpu)) {
      if (!flags.get(node)!.optional) {
        throw new Unsatisfiable({ kind: 'platform', path: node.path, name: node.name,
          spec: `${record.os?.join(',') ?? '*'}/${record.cpu?.join(',') ?? '*'}`, foundPath: node.path,
          foundVersion: node.version, candidates: [] });
      }
      failed.set(node, node.path);
    }
  }
  // Optional region: a node that requires a failed node also fails; then drop whatever loses all dependents.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of everything) {
      if (failed.has(node)) continue;
      for (const decl of node.edges.values()) {
        if (decl.type === 'optional' || decl.type === 'peerOptional') continue;
        const found = edgeTarget(node, decl);
        const cause = found ? failed.get(real(found)) ?? failed.get(found) : undefined;
        if (cause !== undefined && flags.get(node)?.optional) { failed.set(node, cause); changed = true; break; }
      }
    }
  }
  const active = new Set<Node>([root]);
  const walk = [root];
  while (walk.length) {
    const node = walk.pop()!;
    for (const decl of node.edges.values()) {
      const found = edgeTarget(node, decl);
      if (!found) continue;
      for (const item of found.kind === 'link' ? [found, found.target!] : [found]) {
        if (!failed.has(item) && !active.has(item)) { active.add(item); walk.push(item); }
      }
    }
  }
  // An inactive dependency inherits the platform cause of an inactive dependent (hoisted or nested).
  const causes = new Map(failed);
  for (let changed_ = true; changed_;) {
    changed_ = false;
    for (const node of everything) {
      const cause = causes.get(node);
      if (cause === undefined) continue;
      for (const decl of node.edges.values()) {
        const found = edgeTarget(node, decl);
        const item = found && found.kind === 'link' ? found.target! : found;
        if (item && !active.has(item) && !causes.has(item)) { causes.set(item, cause); changed_ = true; }
      }
    }
  }
  const causeOf = (node: Node): string => causes.get(node) ?? node.path;
  const idOf = (node: Node) => npmSha(npmStable([node.path, node.kind, node.packageName, node.version,
    node.record?.tarball ?? null, node.record?.integrity ?? null]));
  const edgeRows: NpmRegistryEdge[] = [];
  for (const node of everything) {
    for (const decl of [...node.edges.values()].sort((a, b) => a.name < b.name ? -1 : 1)) {
      const found = edgeTarget(node, decl);
      let requestedName = decl.name;
      try { requestedName = decl.type === 'workspace' ? decl.name : classify(decl.name, decl.effective).packageName; }
      catch { /* validated during solving */ }
      edgeRows.push({ from: node.path, to: found?.path ?? null, type: decl.type, name: decl.name, spec: decl.spec,
        effectiveSpec: decl.effective, requestedName, valid: !!found && satisfies(found, decl) });
    }
  }
  const instances: NpmRegistryInstance[] = everything.map(node => ({
    id: idOf(node), path: node.path, kind: node.kind, slotName: node.kind === 'registry' || node.kind === 'link' ? node.name : null,
    name: node.packageName, version: node.version, resolved: node.record?.tarball ?? null,
    integrity: node.record?.integrity ?? null, linkTarget: node.target?.path ?? null,
    ...(flags.get(node) ?? { dev: false, optional: false, devOptional: false, peer: false }),
    active: active.has(node), hasInstallScript: node.record?.hasInstallScript ?? false,
    engineOk: node.record ? engineOk(node.record, request.engineTarget) : true, selection: node.selection,
    peerHosts: node.record ? Object.keys(node.record.peerDependencies).sort().map(name => {
      const decl = node.edges.get(name);
      const found = decl ? edgeTarget(node, decl) : null;
      return { name, spec: node.record!.peerDependencies[name]!, optional: node.record!.peerOptional.includes(name),
        hostPath: found?.path ?? null };
    }) : [],
  }));
  return {
    status: 'solved' as const, instances, edges: edgeRows, conflict: null,
    omitted: everything.filter(node => failed.has(node) || !active.has(node) && node.kind === 'registry')
      .map(node => ({ id: idOf(node), path: node.path, reason: 'platform' as const, causePath: causeOf(node) })),
    engineWarnings: everything.filter(node => node.record && !engineOk(node.record, request.engineTarget))
      .map(node => ({ path: node.path, required: node.record!.engines })),
  };
}

/** Keeps only candidate records the solve can consult again: versions satisfying an encountered spec,
 * requested dist-tags and `latest`. Replaying the solve over the filtered snapshot is deterministic. */
export function retainNpmCandidates(packument: NpmRegistryPackument, encountered: Set<string> | undefined): NpmRegistryPackument {
  if (packument.status !== 'captured') return { ...packument, records: [], distTags: {} };
  const specs = [...encountered ?? []];
  const tags = new Set(['latest', ...specs.filter(spec => spec.startsWith('tag:')).map(spec => spec.slice(4))]);
  const ranges = specs.filter(spec => !spec.startsWith('tag:')).map(spec => {
    const value = spec.slice(spec.indexOf(':') + 1);
    return { exact: spec.startsWith('version:') ? value : null, range: parseNpmRange(value) };
  });
  const distTags = Object.fromEntries(Object.entries(packument.distTags).filter(([tag]) => tags.has(tag)).sort());
  const tagged = new Set(Object.values(distTags));
  const records = packument.records.filter(item => {
    if (tagged.has(item.version)) return true;
    const version = parseNpmVersion(item.version);
    return !!version && ranges.some(entry => entry.exact ? entry.exact === item.version
      : !!entry.range && npmSatisfies(version, entry.range));
  });
  return { ...packument, distTags, records };
}

/** Projects one raw abbreviated packument into admitted candidate records. */
export function projectNpmPackument(name: string, bytes: Uint8Array): NpmRegistryPackument {
  const base = { name, url: npmRegistryPackumentUrl(name), reason: null, httpStatus: 200,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  const malformed = (reason: string): NpmRegistryPackument => ({ ...base, status: 'malformed', reason,
    versionCount: 0, distTags: {}, records: [] });
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return malformed('packument is not UTF-8 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return malformed('packument is not an object');
  const value = parsed as Record<string, unknown>;
  if (value.name !== name) return malformed('packument name differs from the requested package');
  const versions = value.versions;
  const tags = value['dist-tags'];
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return malformed('packument versions are missing');
  const entries = Object.entries(versions as Record<string, unknown>);
  if (entries.length > npmRegistryLimits.versionsPerPackument) {
    return { ...base, status: 'budget-exhausted', reason: 'packument version limit', versionCount: entries.length,
      distTags: {}, records: [] };
  }
  const strings = (map: unknown): Record<string, string> => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    return Object.fromEntries(Object.entries(map as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  };
  const list = (field: unknown): string[] | null => typeof field === 'string' ? [field]
    : Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : null;
  const records: NpmRegistryRecord[] = [];
  for (const [version, raw] of entries) {
    if (!parseNpmVersion(version) || !raw || typeof raw !== 'object') continue;
    const manifest = raw as Record<string, unknown>;
    const dist = manifest.dist && typeof manifest.dist === 'object' ? manifest.dist as Record<string, unknown> : {};
    const engines = manifest.engines && typeof manifest.engines === 'object' && !Array.isArray(manifest.engines)
      ? manifest.engines as Record<string, unknown> : {};
    const peers = strings(manifest.peerDependencies);
    const meta = manifest.peerDependenciesMeta && typeof manifest.peerDependenciesMeta === 'object'
      ? manifest.peerDependenciesMeta as Record<string, { optional?: unknown }> : {};
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
    records.push({ version, deprecated: typeof manifest.deprecated === 'string' && manifest.deprecated.length > 0,
      engines: { node: typeof engines.node === 'string' ? engines.node : null,
        npm: typeof engines.npm === 'string' ? engines.npm : null },
      dependencies: strings(manifest.dependencies), optionalDependencies: strings(manifest.optionalDependencies),
      peerDependencies: peers, peerOptional: Object.keys(peers).filter(key => meta[key]?.optional === true).sort(),
      os: list(manifest.os), cpu: list(manifest.cpu), libc: list(manifest.libc),
      tarball: typeof dist.tarball === 'string' ? dist.tarball : null,
      integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
      hasInstallScript: manifest.hasInstallScript === true,
      bundled: Array.isArray(bundled) ? bundled.length > 0 : bundled === true,
      hasShrinkwrap: manifest._hasShrinkwrap === true });
  }
  records.sort((a, b) => compareNpmVersions(parseNpmVersion(b.version)!, parseNpmVersion(a.version)!));
  return { ...base, status: 'captured', versionCount: entries.length,
    distTags: strings(tags), records };
}
