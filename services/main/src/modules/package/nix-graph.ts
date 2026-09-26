import { createHash } from 'node:crypto';

export class NixResolutionInvalid extends Error {}
export class NixResolutionConflict extends Error {}
export class NixResolutionUnavailable extends Error {}

export const NIX_IMAGE = 'docker.io/nixos/nix:2.35.2@sha256:617d914dba5384bf75adf17081583b69371031ec7defce36c34c5fa14fc819b0';
export const NIX_VERSION = '2.35.2';
export const NIX_MAX_NODES = 32;
export const NIX_MAX_EDGES = 64;
export const NIX_MAX_DRVS = 64;
export const NIX_MAX_CLOSURE = 256;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,160}$/;
const idPattern = /^[A-Za-z0-9._-]{1,80}$/;
const hashPattern = /^sha256-[A-Za-z0-9+/]{43}=$/;

export interface NixRequest {
  profile: 'nix-flake-native-v1';
  system: 'x86_64-linux';
  package: string;
  flakeNix: string;
  flakeLock: string;
  files: Array<{ path: string; text: string }>;
  runtime: 'observe' | 'unobserved';
}
export interface NixInputNode {
  id: string;
  original: Record<string, unknown> | null;
  locked: Record<string, unknown> | null;
  sourceHash: string | null;
}
export interface NixInputEdge { from: string; name: string; to: string | string[] }
export interface NixInputGraph { root: string; nodes: NixInputNode[]; edges: NixInputEdge[] }
export interface NixDerivationNode {
  drvPath: string; system: string;
  outputs: Array<{ name: string; path: string }>;
  sourcePaths: string[];
}
export interface NixDerivationEdge { from: string; to: string; outputs: string[] }
export interface NixDerivationGraph {
  selectedDrvPath: string;
  nodes: NixDerivationNode[];
  edges: NixDerivationEdge[];
}
export interface NixRuntimeClosure {
  status: 'observed' | 'unobserved';
  outputPath: string | null;
  paths: Array<{ path: string; narHash: string; references: string[] }>;
}
export interface NixOutcome {
  status: 'observed' | 'derivation-only' | 'evaluation-failed' | 'build-failed'
    | 'closure-unavailable' | 'source-hash-unobserved'
    | 'budget-exhausted';
  failure: 'stale-lock' | 'native-error' | 'timeout' | null;
  evaluator: { version: typeof NIX_VERSION; image: typeof NIX_IMAGE;
    system: 'x86_64-linux'; network: 'none'; };
  inputGraph: NixInputGraph;
  derivationGraph: NixDerivationGraph | null;
  runtimeClosure: NixRuntimeClosure;
  work: { inputNodes: number; inputEdges: number; derivations: number;
    buildEdges: number; closurePaths: number; nativeRuns: number };
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function invalid(message: string): never { throw new NixResolutionInvalid(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected object');
  return value as Record<string, unknown>;
}
export function admitNixRequest(request: NixRequest): void {
  if (request.profile !== 'nix-flake-native-v1' || request.system !== 'x86_64-linux'
    || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.package)
    || (request.runtime !== 'observe' && request.runtime !== 'unobserved')
    || typeof request.flakeNix !== 'string' || Buffer.byteLength(request.flakeNix) > 65_536
    || typeof request.flakeLock !== 'string' || Buffer.byteLength(request.flakeLock) > 65_536
    || !Array.isArray(request.files) || request.files.length > 16) invalid('Nix request exceeds profile');
  let bytes = Buffer.byteLength(request.flakeNix) + Buffer.byteLength(request.flakeLock);
  const seen = new Set<string>();
  for (const file of request.files) {
    if (!pathPattern.test(file.path) || file.path === 'flake.nix' || file.path === 'flake.lock'
      || file.path.startsWith('.oracle/') || seen.has(file.path)
      || typeof file.text !== 'string' || Buffer.byteLength(file.text) > 65_536) {
      invalid('invalid Nix source file');
    }
    seen.add(file.path);
    bytes += Buffer.byteLength(file.text);
  }
  if (bytes > 262_144) invalid('Nix source byte budget exhausted');
  parseNixLock(request.flakeLock);
}

export function parseNixLock(text: string, localHashes: Record<string, string> = {},
  rootHash: string | null = null): NixInputGraph {
  let lock: Record<string, unknown>;
  try { lock = object(JSON.parse(text)); } catch { return invalid('invalid Nix lock JSON'); }
  if (lock.version !== 7 || typeof lock.root !== 'string' || !idPattern.test(lock.root)) {
    invalid('unsupported Nix lock version or root');
  }
  const raw = object(lock.nodes);
  const ids = Object.keys(raw).sort();
  if (!ids.includes(lock.root) || ids.length > NIX_MAX_NODES) invalid('Nix input node budget exceeded');
  const nodes: NixInputNode[] = [];
  const edges: NixInputEdge[] = [];
  for (const id of ids) {
    if (!idPattern.test(id)) invalid('invalid Nix input node');
    const node = object(raw[id]);
    const original = node.original === undefined ? null : object(node.original);
    const locked = node.locked === undefined ? null : object(node.locked);
    const rawHash = locked?.narHash;
    if (rawHash !== undefined && (typeof rawHash !== 'string' || !hashPattern.test(rawHash))) {
      invalid('invalid locked source hash');
    }
    const sourceHash = id === lock.root ? rootHash : (rawHash as string | undefined)
      ?? localHashes[id] ?? null;
    if (sourceHash !== null && !hashPattern.test(sourceHash)) invalid('invalid source hash');
    nodes.push({ id, original, locked, sourceHash });
    if (node.inputs === undefined) continue;
    for (const [name, target] of Object.entries(object(node.inputs))) {
      if (!idPattern.test(name)) invalid('invalid Nix input edge');
      if (typeof target === 'string') {
        if (!ids.includes(target)) invalid('missing Nix input target');
        edges.push({ from: id, name, to: target });
      } else if (Array.isArray(target) && target.length > 0 && target.length <= 16
        && target.every(part => typeof part === 'string' && idPattern.test(part))) {
        edges.push({ from: id, name, to: [...target] });
      } else invalid('invalid Nix follows reference');
      if (edges.length > NIX_MAX_EDGES) invalid('Nix input edge budget exceeded');
    }
  }
  return { root: lock.root, nodes, edges: edges.sort((a, b) =>
    `${a.from}/${a.name}`.localeCompare(`${b.from}/${b.name}`)) };
}

export function localNixPaths(graph: NixInputGraph): Array<{ id: string; path: string }> {
  return graph.nodes.flatMap(node => {
    const locked = node.locked;
    if (locked?.type !== 'path') return [];
    const path = locked.path;
    if (typeof path !== 'string' || !path.startsWith('./') || !pathPattern.test(path)) {
      invalid('unsupported local Nix input path');
    }
    return [{ id: node.id, path: path.slice(2) }];
  });
}

export function parseNixDerivations(text: string, selectedDrvPath: string): NixDerivationGraph {
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(text)); } catch { return invalid('invalid Nix derivation JSON'); }
  const raw = object(value.derivations);
  const names = Object.keys(raw).sort();
  if (names.length === 0 || names.length > NIX_MAX_DRVS) invalid('Nix derivation budget exceeded');
  const short = selectedDrvPath.replace('/nix/store/', '');
  if (!names.includes(short)) invalid('selected Nix derivation missing');
  const nodes: NixDerivationNode[] = [];
  const edges: NixDerivationEdge[] = [];
  for (const name of names) {
    if (!/^[a-z0-9]{32}-[A-Za-z0-9+._-]+\.drv$/.test(name)) invalid('invalid Nix derivation path');
    const drv = object(raw[name]);
    const inputs = object(drv.inputs);
    const srcs = inputs.srcs;
    if (!Array.isArray(srcs) || !srcs.every(item => typeof item === 'string')) {
      invalid('invalid Nix derivation sources');
    }
    const outputs = Object.entries(object(drv.outputs)).map(([output, value]) => {
      const path = object(value).path;
      if (typeof path !== 'string' || !path) invalid('invalid Nix derivation output');
      return { name: output, path: `/nix/store/${path}` };
    }).sort((a, b) => a.name.localeCompare(b.name));
    nodes.push({ drvPath: `/nix/store/${name}`, system: String(drv.system),
      outputs, sourcePaths: [...srcs].map(source => `/nix/store/${source}`).sort() });
    for (const [dependency, details] of Object.entries(object(inputs.drvs))) {
      if (!names.includes(dependency)) invalid('Nix derivation graph is incomplete');
      const wanted = object(details).outputs;
      if (!Array.isArray(wanted) || !wanted.every(item => typeof item === 'string')) {
        invalid('invalid Nix build input outputs');
      }
      edges.push({ from: `/nix/store/${name}`, to: `/nix/store/${dependency}`,
        outputs: [...wanted].sort() });
      if (edges.length > NIX_MAX_EDGES) invalid('Nix build edge budget exceeded');
    }
  }
  return { selectedDrvPath, nodes, edges: edges.sort((a, b) =>
    `${a.from}/${a.to}`.localeCompare(`${b.from}/${b.to}`)) };
}

export function parseNixClosure(text: string, outputPath: string): NixRuntimeClosure {
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(text)); } catch { return invalid('invalid Nix closure JSON'); }
  const names = Object.keys(raw).sort();
  if (!names.includes(outputPath) || names.length > NIX_MAX_CLOSURE) {
    invalid('Nix runtime closure is incomplete or exceeds budget');
  }
  const paths = names.map(path => {
    const item = object(raw[path]);
    const hash = item.narHash;
    const references = item.references;
    if (!path.startsWith('/nix/store/') || typeof hash !== 'string' || !hashPattern.test(hash)
      || !Array.isArray(references) || !references.every(ref => typeof ref === 'string'
        && names.includes(ref))) invalid('invalid Nix runtime closure entry');
    return { path, narHash: hash, references: [...references].sort() };
  });
  return { status: 'observed', outputPath, paths };
}
