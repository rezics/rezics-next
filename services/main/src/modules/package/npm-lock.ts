import { createHash } from 'node:crypto';

export class NpmResolutionInvalid extends Error {}
class Unsupported extends Error {}
class Budget extends Error {}
export interface NpmBytes { bytesBase64: string; sha256: string }
export interface NpmRequest {
  profile: 'npm-lock-v3-topology-v1'; npmVersion: string; policy: string;
  manifest: NpmBytes; lock: NpmBytes;
}
export interface NpmPeerHost { name: string; specifier: string; host: string; path: string }
export interface NpmInstance { id: string; path: string; name: string; version: string;
  resolved: string | null; integrity: string | null; peerHosts: NpmPeerHost[] }
export interface NpmEdge { from: string; to: string; kind: 'dependency' | 'peer';
  name: string; specifier: string }
export interface NpmIssue { kind: 'missing-dependency' | 'missing-peer' | 'missing-parent'
  | 'missing-provenance' | 'version-mismatch' | 'peer-local' | 'unreachable';
  path: string; name: string; specifier: string | null; foundPath: string | null }
export interface NpmOutcome {
  status: 'validated' | 'unsupported-semantics' | 'incomplete-source-data'
    | 'invalid-topology' | 'budget-exhausted';
  lockId: string; provenance: 'caller-supplied'; lockfileVersion: number | null;
  instances: NpmInstance[]; edges: NpmEdge[]; issues: NpmIssue[];
  unsupportedClauses: string[]; budgetReason: string | null;
  cost: { inputBytes: number; nodeCount: number; edgeCount: number; ancestorLookups: number };
}
interface Requirement { kind: NpmEdge['kind']; name: string; specifier: string }
interface Node extends NpmInstance { parent: string | null; requirements: Requirement[] }
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_BYTES = 65_536;
const MAX_WIRE_BYTES = 262_144;
export function npmSha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function npmStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(npmStable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${npmStable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function invalid(message: string): never { throw new NpmResolutionInvalid(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected JSON object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unknown.length) throw new Unsupported(`unsupported fields: ${unknown.join(', ')}`);
}
function decode(value: NpmBytes): string {
  const input = object(value);
  if (Object.keys(input).sort().join(',') !== 'bytesBase64,sha256'
    || typeof value.bytesBase64 !== 'string' || typeof value.sha256 !== 'string'
    || value.bytesBase64.length > Math.ceil(MAX_WIRE_BYTES / 3) * 4 || !SHA.test(value.sha256)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytesBase64)) {
    invalid('malformed npm snapshot bytes or digest');
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.length > MAX_WIRE_BYTES || bytes.toString('base64') !== value.bytesBase64
    || npmSha(bytes) !== value.sha256) invalid('npm snapshot digest or canonical base64 mismatch');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invalid('npm snapshot is not UTF-8'); }
}

/** JSON.parse alone discards duplicate (including escaped) package paths. */
function parseJson(text: string): Record<string, unknown> {
  let at = 0;
  const whitespace = () => { while (at < text.length && /[\t\r\n ]/.test(text[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') at++;
      else if (char === '"') {
        try { return JSON.parse(text.slice(start, at)) as string; }
        catch { invalid('malformed JSON string'); }
      }
    }
    invalid('unterminated JSON string');
  };
  const value = (depth: number): unknown => {
    if (depth > 32) throw new Budget('JSON nesting limit');
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      at++;
      const end = char === '{' ? '}' : ']';
      const fields = Object.create(null) as Record<string, unknown>;
      const items: unknown[] = [];
      const seen = new Set<string>();
      whitespace();
      if (text[at] === end) { at++; return char === '{' ? fields : items; }
      for (;;) {
        whitespace();
        if (char === '{') {
          if (text[at] !== '"') invalid('malformed JSON object key');
          const key = string();
          if (seen.has(key)) invalid(`duplicate JSON key: ${key.slice(0, 160)}`);
          seen.add(key);
          whitespace();
          if (text[at++] !== ':') invalid('malformed JSON object');
          fields[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        whitespace();
        if (text[at] === end) { at++; return char === '{' ? fields : items; }
        if (text[at++] !== ',') invalid('malformed JSON collection');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) invalid('malformed JSON value');
    at += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) invalid('nonfinite JSON number');
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (at !== text.length) invalid('trailing JSON bytes');
  return object(parsed);
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || value.split('/').at(-1) === 'node_modules') {
    invalid('malformed npm package name');
  }
  return value;
}
function version(value: unknown): string {
  if (typeof value !== 'string') invalid('malformed npm version');
  if (value.length > 64 || !VERSION.test(value) || value.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Unsupported('only exact stable npm versions are admitted');
  }
  return value;
}
function location(path: string): { name: string; parent: string } {
  if (!path || path.length > 2048 || path.includes('\\')) invalid('malformed npm package path');
  const parts = path.split('/');
  let parent = '';
  let pkg = '';
  let depth = 0;
  for (let i = 0; i < parts.length;) {
    if (++depth > 16) throw new Budget('npm path nesting limit');
    parent = parts.slice(0, i).join('/');
    if (parts[i++] !== 'node_modules') invalid('noncanonical npm package path');
    pkg = parts[i++] ?? '';
    if (pkg.startsWith('@')) pkg += `/${parts[i++] ?? ''}`;
    name(pkg);
  }
  return { name: pkg, parent };
}
function provenance(raw: unknown, kind: 'resolved' | 'integrity'): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') invalid(`malformed npm ${kind}`);
  if (kind === 'resolved') {
    let url: URL;
    try { url = new URL(raw); } catch { invalid('malformed npm resolved URL'); }
    if (raw.length > 2048 || url.protocol !== 'https:' || url.username || url.password
      || url.hash || url.href !== raw) throw new Unsupported('only literal canonical HTTPS package sources are admitted');
  } else {
    const match = /^(sha512|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(raw);
    if (!match) invalid('malformed or unsupported npm integrity');
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.toString('base64') !== match[2] || bytes.length !== (match[1] === 'sha512' ? 64 : 20)) {
      invalid('noncanonical npm integrity');
    }
  }
  return raw;
}
function dependencyMap(raw: unknown): Record<string, unknown> {
  return raw === undefined ? Object.create(null) as Record<string, unknown> : object(raw);
}
function fields(raw: Record<string, unknown>, root: boolean): void {
  keys(raw, ['name', 'version', 'dependencies', 'peerDependencies', 'license',
    ...(root ? ['private'] : ['resolved', 'integrity', 'peer'])]);
  if (raw.license !== undefined && typeof raw.license !== 'string') invalid('malformed license metadata');
  if (raw.private !== undefined && typeof raw.private !== 'boolean') invalid('malformed private metadata');
  if (raw.peer !== undefined && typeof raw.peer !== 'boolean') invalid('malformed peer metadata');
}

export function validateNpmSnapshot(request: NpmRequest): NpmOutcome {
  const envelope = object(request);
  if (Object.keys(envelope).sort().join(',') !== 'lock,manifest,npmVersion,policy,profile'
    || request.profile !== 'npm-lock-v3-topology-v1'
    || typeof request.npmVersion !== 'string' || request.npmVersion.length > 32 || !request.npmVersion
    || typeof request.policy !== 'string' || request.policy.length > 64 || !request.policy) invalid('malformed npm request');
  const manifestText = decode(request.manifest);
  const lockText = decode(request.lock);
  const outcome: NpmOutcome = { status: 'validated',
    lockId: `urn:rezics:npm-lock:${npmSha(npmStable(request))}`, provenance: 'caller-supplied',
    lockfileVersion: null, instances: [], edges: [], issues: [], unsupportedClauses: [], budgetReason: null,
    cost: { inputBytes: Buffer.byteLength(manifestText) + Buffer.byteLength(lockText),
      nodeCount: 0, edgeCount: 0, ancestorLookups: 0 } };
  try {
    if (Buffer.byteLength(manifestText) > MAX_BYTES || Buffer.byteLength(lockText) > MAX_BYTES) {
      throw new Budget('npm raw file byte limit');
    }
    const manifest = parseJson(manifestText);
    const lock = parseJson(lockText);
    if (request.npmVersion !== '11.19.1' || request.policy !== 'literal-sources-required-peers-v1') {
      throw new Unsupported('unsupported npm version or topology policy');
    }
    fields(manifest, true);
    name(manifest.name); version(manifest.version);
    keys(lock, ['name', 'version', 'lockfileVersion', 'requires', 'packages']);
    if (!Number.isSafeInteger(lock.lockfileVersion)) invalid('malformed npm lockfile version');
    outcome.lockfileVersion = lock.lockfileVersion as number;
    if (lock.lockfileVersion !== 3) throw new Unsupported('only npm lockfile version 3 is admitted');
    if (lock.requires !== undefined && lock.requires !== true) throw new Unsupported('unsupported lock requires flag');
    const packages = object(lock.packages);
    const paths = Object.keys(packages).sort();
    outcome.cost.nodeCount = Math.min(paths.length, 130);
    if (paths.length > 129) throw new Budget('npm locked package limit');
    if (!Object.hasOwn(packages, '')) invalid('npm lock is missing its root');
    const root = object(packages['']);
    if (lock.name !== manifest.name || lock.version !== manifest.version
      || root.name !== manifest.name || root.version !== manifest.version
      || npmStable(dependencyMap(root.dependencies)) !== npmStable(dependencyMap(manifest.dependencies))
      || npmStable(dependencyMap(root.peerDependencies)) !== npmStable(dependencyMap(manifest.peerDependencies))) {
      invalid('npm manifest and lock root disagree');
    }
    const nodes = new Map<string, Node>();
    for (const path of paths) {
      const raw = object(packages[path]);
      fields(raw, path === '');
      const slot = path === '' ? { name: name(raw.name), parent: null } : location(path);
      if (raw.name !== undefined && name(raw.name) !== slot.name) throw new Unsupported('npm package alias');
      const pkgVersion = version(raw.version);
      const resolved = path ? provenance(raw.resolved, 'resolved') : null;
      const integrity = path ? provenance(raw.integrity, 'integrity') : null;
      if (path && (!resolved || !integrity)) outcome.issues.push({ kind: 'missing-provenance',
        path, name: slot.name, specifier: null, foundPath: null });
      const requirements: Requirement[] = [];
      const names = new Set<string>();
      for (const [field, kind] of [['dependencies', 'dependency'], ['peerDependencies', 'peer']] as const) {
        const map = dependencyMap(raw[field]);
        for (const depName of Object.keys(map).sort()) {
          if (++outcome.cost.edgeCount > 256) throw new Budget('npm dependency edge limit');
          name(depName);
          if (names.has(depName)) throw new Unsupported('overlapping dependency and peer declarations');
          names.add(depName);
          requirements.push({ kind, name: depName, specifier: version(map[depName]) });
        }
      }
      const id = `urn:rezics:npm-instance:${npmSha(npmStable([outcome.lockId, path,
        slot.name, pkgVersion, resolved, integrity]))}`;
      nodes.set(path, { id, path, name: slot.name, version: pkgVersion, resolved, integrity,
        parent: slot.parent, peerHosts: [], requirements });
    }
    const edges: NpmEdge[] = [];
    const neighbors = new Map<string, string[]>();
    for (const node of nodes.values()) {
      if (node.parent !== null && !nodes.has(node.parent)) outcome.issues.push({ kind: 'missing-parent',
        path: node.path, name: node.name, specifier: null, foundPath: node.parent });
      const targets: string[] = [];
      neighbors.set(node.path, targets);
      for (const requirement of node.requirements) {
        let cursor: string | null = node.path;
        let target: Node | undefined;
        while (cursor !== null) {
          if (++outcome.cost.ancestorLookups > 4096) throw new Budget('npm ancestor lookup limit');
          target = nodes.get(`${cursor ? `${cursor}/` : ''}node_modules/${requirement.name}`);
          if (target) break;
          cursor = nodes.get(cursor)?.parent ?? null;
        }
        const issue = { path: node.path, name: requirement.name, specifier: requirement.specifier,
          foundPath: target?.path ?? null };
        if (!target) outcome.issues.push({ ...issue,
          kind: requirement.kind === 'peer' ? 'missing-peer' : 'missing-dependency' });
        else {
          targets.push(target.path);
          if (requirement.kind === 'peer' && node.path !== '' && target.parent === node.path) {
            outcome.issues.push({ ...issue, kind: 'peer-local' });
          } else if (target.version !== requirement.specifier) outcome.issues.push({ ...issue, kind: 'version-mismatch' });
          edges.push({ from: node.id, to: target.id, ...requirement });
          if (requirement.kind === 'peer') node.peerHosts.push({ name: requirement.name,
            specifier: requirement.specifier, host: target.id, path: target.path });
        }
      }
    }
    const reached = new Set<string>();
    const queue = [''];
    for (let at = 0; at < queue.length; at++) {
      const path = queue[at]!;
      if (reached.has(path)) continue;
      reached.add(path);
      queue.push(...neighbors.get(path) ?? []);
    }
    for (const node of nodes.values()) if (!reached.has(node.path)) outcome.issues.push({
      kind: 'unreachable', path: node.path, name: node.name, specifier: null, foundPath: null });
    if (outcome.issues.length) {
      outcome.status = outcome.issues.some(issue => issue.kind.startsWith('missing-'))
        ? 'incomplete-source-data' : 'invalid-topology';
      return outcome;
    }
    outcome.instances = [...nodes.values()].map(({ parent: _parent, requirements: _requirements, ...instance }) => instance);
    outcome.edges = edges;
    return outcome;
  } catch (error) {
    if (!(error instanceof Unsupported) && !(error instanceof Budget)) throw error;
    outcome.status = error instanceof Budget ? 'budget-exhausted' : 'unsupported-semantics';
    if (error instanceof Budget) outcome.budgetReason = error.message;
    else outcome.unsupportedClauses = [error.message];
    outcome.issues = [];
    return outcome;
  }
}
