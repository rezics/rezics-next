import { createHash } from 'node:crypto';

/** Bounded, caller-supplied native captures. No provider response is inferred from a missing capture. */
export type ModEcosystem = 'fabric' | 'forge' | 'neoforge' | 'modrinth'
  | 'curseforge' | 'nexus' | 'steam';
export interface ModCapture {
  identity: string;
  surface: string;
  status: 'observed' | 'inaccessible';
  bytesBase64: string | null;
  sha256: string | null;
  sourceUrl?: string;
  httpStatus?: number;
}
export interface ModRequest {
  profile: 'mod-native-capture-v1';
  ecosystem: ModEcosystem;
  side: 'CLIENT' | 'SERVER';
  runtime?: { loaderVersion: string; gameVersion: string };
  root: string;
  captures: ModCapture[];
}
export interface ModRelation {
  from: string; to: string; kind: string;
  strength: 'hard' | 'advisory' | 'metadata' | 'embedded' | 'collection';
  range: string | null; side: string | null;
}
export interface ModIssue { source: string; target: string | null; kind: string }
export interface ModOutcome {
  provenance: 'caller-supplied-captures';
  selection: 'valid' | 'unsatisfiable' | 'incomplete-source-data'
    | 'unsupported-semantics' | 'budget-exhausted';
  ordering: 'valid' | 'cycle' | 'not-evaluated';
  relations: ModRelation[];
  issues: ModIssue[];
  independentDownloads: string[];
  coverage: Array<{ identity: string; surface: string; status: 'observed' | 'inaccessible';
    sha256: string | null; sourceUrl?: string; httpStatus?: number }>;
  cost: { inputBytes: number; captures: number; relations: number; comparisons: number };
}
export class ModProfileInvalid extends Error {}
const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_./:-]{1,160}$/;
const FABRIC_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const FORGE_ID = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_CAPTURES = 32;
const MAX_BYTES = 65_536;
const MAX_RELATIONS = 256;
const invalid = (message: string): never => { throw new ModProfileInvalid(message); };
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected native object');
  return value as Record<string, unknown>;
};
const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value || value.length > 256) invalid(`invalid ${field}`);
  return value as string;
};
const array = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value) || value.length > MAX_RELATIONS) invalid(`invalid ${field}`);
  return value as unknown[];
};
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
function decode(capture: ModCapture): string {
  const { bytesBase64, sha256 } = capture;
  if (typeof bytesBase64 !== 'string' || typeof sha256 !== 'string' || !SHA.test(sha256)
    || bytesBase64.length > 87_384
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytesBase64)) {
    invalid('invalid native capture encoding');
  }
  const bytes = Buffer.from(bytesBase64 as string, 'base64');
  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== bytesBase64 || hash(bytes) !== sha256) {
    invalid('native capture digest mismatch');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return invalid('native capture is not UTF-8'); }
}
function parse(capture: ModCapture, ecosystem: ModEcosystem): Record<string, unknown> {
  const text = decode(capture);
  try { return obj(ecosystem === 'forge' || ecosystem === 'neoforge'
    ? Bun.TOML.parse(text) : JSON.parse(text)); }
  catch { return invalid('invalid native capture document'); }
}
function compareVersion(actual: string, range: string, ecosystem: ModEcosystem): boolean | null {
  if (range === '*' || range === '') return true;
  if (ecosystem === 'forge' || ecosystem === 'neoforge') {
    // Maven interval subset. Unknown syntax remains unsupported, never a satisfied edge.
    const match = /^([[(])([^,]*),([^,)\]]*)([)\]])$/.exec(range);
    if (!match) return range === actual ? true : null;
    const numeric = (value: string): number[] | null => /^\d+(?:\.\d+){0,3}$/.test(value)
      ? value.split('.').map(Number) : null;
    const lower = match[2] ? numeric(match[2]) : [];
    const upper = match[3] ? numeric(match[3]) : [];
    const version = numeric(actual);
    if (!lower || !upper || !version) return null;
    const cmp = (a: number[], b: number[]): number => {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (a[i] ?? 0) - (b[i] ?? 0);
        if (difference) return difference;
      }
      return 0;
    };
    return (!lower.length || (match[1] === '[' ? cmp(version, lower) >= 0 : cmp(version, lower) > 0))
      && (!upper.length || (match[4] === ']' ? cmp(version, upper) <= 0 : cmp(version, upper) < 0));
  }
  const match = /^(=|>=|>|<=|<)?(\d+(?:\.\d+){0,3})$/.exec(range);
  if (!match || !/^\d+(?:\.\d+){0,3}$/.test(actual)) return null;
  const left = actual.split('.').map(Number);
  const right = match[2]!.split('.').map(Number);
  let cmp = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    cmp = (left[i] ?? 0) - (right[i] ?? 0);
    if (cmp) break;
  }
  switch (match[1] ?? '=') {
    case '=': return cmp === 0;
    case '>=': return cmp >= 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '<': return cmp < 0;
    default: return null;
  }
}
interface NativeNode { id: string; project: string; version: string | null; relations: ModRelation[] }
function relation(from: string, to: string, kind: string, strength: ModRelation['strength'],
  range: string | null = null, side: string | null = null): ModRelation {
  if (!ID.test(to)) invalid('invalid native dependency identity');
  return { from, to, kind, strength, range, side };
}
function fabric(doc: Record<string, unknown>, source: string): NativeNode {
  if (doc.schemaVersion !== 1) throw new Unsupported('Fabric schemaVersion');
  const id = string(doc.id, 'Fabric id');
  const version = string(doc.version, 'Fabric version');
  if (!FABRIC_ID.test(id)) invalid('invalid Fabric id');
  if (doc.jars !== undefined || doc.provides !== undefined
    || (doc.environment !== undefined && doc.environment !== '*')) {
    throw new Unsupported('Fabric nested jars, provided IDs or side-specific manifest');
  }
  const relations: ModRelation[] = [];
  for (const [kind, strength] of [
    ['depends', 'hard'], ['breaks', 'hard'], ['recommends', 'advisory'],
    ['conflicts', 'advisory'], ['suggests', 'metadata'],
  ] as const) {
    const map = doc[kind] ?? {};
    for (const [target, value] of Object.entries(obj(map))) {
      if (!FABRIC_ID.test(target)) invalid('invalid Fabric dependency ID');
      if (typeof value !== 'string') throw new Unsupported('Fabric range alternatives');
      relations.push(relation(id, target, kind, strength, value));
    }
  }
  if (source !== id) invalid('Fabric capture identity differs from mod ID');
  return { id, project: id, version, relations };
}
function forge(doc: Record<string, unknown>, source: string, ecosystem: 'forge' | 'neoforge'): NativeNode {
  const modLoader = string(doc.modLoader, 'modLoader');
  if (!['javafml', 'lowcodefml'].includes(modLoader)) throw new Unsupported('loader language');
  const loaderVersion = string(doc.loaderVersion, 'loaderVersion');
  string(doc.license, 'license');
  if (doc.clientSideOnly === true || doc.features !== undefined || doc.mixins !== undefined) {
    throw new Unsupported('loader side, features or mixins');
  }
  const mods = array(doc.mods, 'mods');
  if (mods.length !== 1) throw new Unsupported('multiple mod IDs in one manifest');
  const mod = obj(mods[0]);
  const id = string(mod.modId, 'modId');
  const version = mod.version === undefined ? '1' : string(mod.version, 'mod version');
  if (version.includes('${') || mod.features !== undefined) {
    throw new Unsupported('loader version substitution or features');
  }
  if (!FORGE_ID.test(id)) invalid('invalid loader mod ID');
  if (id !== source) invalid('Forge capture identity differs from mod ID');
  const dependencies = obj(doc.dependencies ?? {});
  const relations: ModRelation[] = [relation(id, ecosystem, 'required-runtime', 'hard',
    loaderVersion, 'BOTH')];
  for (const entry of array(dependencies[id] ?? [], 'dependencies')) {
    const dep = obj(entry);
    const target = string(dep.modId, 'dependency modId');
    if (!FORGE_ID.test(target)) invalid('invalid loader dependency mod ID');
    const side = dep.side === undefined ? 'BOTH' : string(dep.side, 'side');
    const ordering = dep.ordering === undefined ? 'NONE' : string(dep.ordering, 'ordering');
    if (!['BOTH', 'CLIENT', 'SERVER'].includes(side)
      || !['NONE', 'BEFORE', 'AFTER'].includes(ordering)) throw new Unsupported('loader side or ordering');
    let kind: string;
    let strength: ModRelation['strength'];
    if (ecosystem === 'forge') {
      if (typeof dep.mandatory !== 'boolean' || dep.type !== undefined) {
        throw new Unsupported('Forge dependency field');
      }
      kind = dep.mandatory ? 'required' : 'optional';
      strength = dep.mandatory ? 'hard' : 'advisory';
    } else {
      if (dep.mandatory !== undefined) throw new Unsupported('NeoForge mandatory field');
      kind = dep.type === undefined ? 'required' : string(dep.type, 'type');
      if (!['required', 'optional', 'incompatible', 'discouraged'].includes(kind)) {
        throw new Unsupported('NeoForge dependency type');
      }
      strength = kind === 'required' || kind === 'incompatible' ? 'hard' : 'advisory';
    }
    const range = dep.versionRange === undefined ? '' : string(dep.versionRange, 'versionRange');
    relations.push(relation(id, target, `${kind}:${ordering}`, strength, range, side));
  }
  return { id, project: id, version, relations };
}
function modrinth(doc: Record<string, unknown>, source: string): NativeNode {
  const id = string(doc.id, 'Modrinth version id');
  const project = string(doc.project_id, 'Modrinth project id');
  if (source !== id) invalid('Modrinth capture identity differs from version ID');
  const relations: ModRelation[] = [];
  for (const entry of array(doc.dependencies ?? [], 'Modrinth dependencies')) {
    const dep = obj(entry);
    const type = string(dep.dependency_type, 'dependency_type');
    if (!['required', 'optional', 'incompatible', 'embedded'].includes(type)) {
      throw new Unsupported('Modrinth dependency type');
    }
    const version = dep.version_id === null || dep.version_id === undefined ? null
      : string(dep.version_id, 'dependency version');
    const projectId = dep.project_id === null || dep.project_id === undefined ? null
      : string(dep.project_id, 'dependency project');
    if (!version && !projectId) throw new Unsupported('Modrinth file-only dependency');
    relations.push(relation(id, version ?? projectId!, type,
      type === 'required' || type === 'incompatible' ? 'hard'
        : type === 'embedded' ? 'embedded' : 'advisory'));
  }
  return { id, project, version: typeof doc.version_number === 'string'
    ? doc.version_number : null, relations };
}
function curseforge(doc: Record<string, unknown>, source: string): NativeNode {
  if (typeof doc.id !== 'number' || !Number.isSafeInteger(doc.id)
    || doc.id < 1 || doc.id > 0xffffffff) invalid('invalid CurseForge file ID');
  const id = String(doc.id);
  if (!/^\d{1,16}$/.test(id) || source !== id) invalid('invalid CurseForge file identity');
  const relations: ModRelation[] = [];
  const names = ['embedded', 'optional', 'required', 'tool', 'incompatible', 'include'];
  for (const entry of array(doc.dependencies ?? [], 'CurseForge dependencies')) {
    const dep = obj(entry);
    if (typeof dep.modId !== 'number' || !Number.isSafeInteger(dep.modId)
      || dep.modId < 1 || dep.modId > 0xffffffff) invalid('invalid CurseForge project ID');
    const target = String(dep.modId);
    const type = dep.relationType;
    if (!/^\d{1,16}$/.test(target) || !Number.isInteger(type)
      || typeof type !== 'number' || type < 1 || type > 6) invalid('invalid CurseForge relation');
    const kind = names[(type as number) - 1]!;
    relations.push(relation(id, target, kind,
      kind === 'required' || kind === 'incompatible' ? 'hard'
        : kind === 'embedded' ? 'embedded'
        : kind === 'tool' || kind === 'include' ? 'metadata' : 'advisory'));
  }
  if (typeof doc.modId !== 'number' || !Number.isSafeInteger(doc.modId)
    || doc.modId < 1 || doc.modId > 0xffffffff) invalid('invalid CurseForge project ID');
  const project = String(doc.modId);
  if (!/^\d{1,16}$/.test(project)) invalid('invalid CurseForge project identity');
  return { id, project, version: null, relations };
}
function steam(doc: Record<string, unknown>, source: string, surface: string): NativeNode {
  if (surface === 'details-public') {
    const response = obj(doc.response);
    const details = array(response.publishedfiledetails, 'Steam public details');
    if (details.length !== 1) throw new Unsupported('Steam public detail count');
    const item = obj(details[0]);
    if (item.result !== 1 || item.publishedfileid !== source) {
      throw new Unsupported('Steam public detail unavailable');
    }
    return { id: source, project: source, version: null, relations: [] };
  }
  const id = string(doc.publishedfileid, 'publishedfileid');
  if (!/^\d{1,20}$/.test(id) || id !== source) invalid('invalid Steam published file ID');
  // GetPublishedFileDetails uses EWorkshopFileType, not query filter enum.
  const fileType = doc.file_type;
  if (fileType !== 0 && fileType !== 2) throw new Unsupported('Steam file type');
  const children = array(doc.children, 'Steam children');
  if (typeof doc.num_children !== 'number' || doc.num_children !== children.length) {
    throw new Unsupported('incomplete Steam children surface');
  }
  return { id, project: id, version: null, relations: children.map(value => {
    const child = typeof value === 'string' ? value : obj(value).publishedfileid;
    return relation(id, string(child, 'Steam child ID'),
      fileType === 2 ? 'collection-member' : 'soft-dependency',
      fileType === 2 ? 'collection' : 'advisory');
  }) };
}
class Unsupported extends Error {}
function hasCycle(relations: ModRelation[]): boolean {
  const graph = new Map<string, string[]>();
  for (const item of relations) {
    const [, order] = item.kind.split(':');
    if (order === 'NONE' || !order) continue;
    const before = order === 'BEFORE' ? item.from : item.to;
    const after = order === 'BEFORE' ? item.to : item.from;
    const outgoing = graph.get(before) ?? [];
    outgoing.push(after);
    graph.set(before, outgoing);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...graph.keys()].some(visit);
}
/** Work: O(B + C log C + R), with B <= 2 MiB, C <= 32 and R <= 256. */
export function solveModCaptures(request: ModRequest): ModOutcome {
  if (request.profile !== 'mod-native-capture-v1'
    || !['fabric', 'forge', 'neoforge', 'modrinth', 'curseforge', 'nexus', 'steam'].includes(request.ecosystem)
    || !['CLIENT', 'SERVER'].includes(request.side) || !ID.test(request.root)
    || !Array.isArray(request.captures)) invalid('invalid mod profile request');
  const coverage: ModOutcome['coverage'] = [];
  const cost = { inputBytes: 0, captures: request.captures.length, relations: 0, comparisons: 0 };
  const failed = (selection: ModOutcome['selection'], issues: ModIssue[]): ModOutcome => ({
    provenance: 'caller-supplied-captures', selection, ordering: 'not-evaluated',
    relations: [], issues, independentDownloads: [], coverage, cost,
  });
  if (request.captures.length > MAX_CAPTURES) return failed('budget-exhausted',
    [{ source: request.root, target: null, kind: 'capture-limit' }]);
  const seen = new Set<string>();
  const nodes = new Map<string, NativeNode>();
  let inaccessible = false;
  try {
    for (const capture of request.captures) {
      if (!ID.test(capture.identity) || !ID.test(capture.surface)
        || seen.has(`${capture.identity}:${capture.surface}`)) invalid('invalid or duplicate capture identity');
      if (capture.httpStatus !== undefined
        && (!Number.isInteger(capture.httpStatus) || capture.httpStatus < 100
          || capture.httpStatus > 599)) invalid('invalid provider HTTP status');
      if (capture.sourceUrl !== undefined) {
        try {
          const url = new URL(capture.sourceUrl);
          const host = { modrinth: 'api.modrinth.com', curseforge: 'api.curseforge.com',
            nexus: 'api.nexusmods.com', steam: 'api.steampowered.com' }
            [request.ecosystem as 'modrinth' | 'curseforge' | 'nexus' | 'steam'];
          if (url.protocol !== 'https:' || url.username || url.password || url.search
            || url.hash || (host && url.hostname !== host)) {
            invalid('invalid provider origin or credential-bearing URL');
          }
        }
        catch { invalid('invalid provider URL'); }
      }
      seen.add(`${capture.identity}:${capture.surface}`);
      coverage.push({ identity: capture.identity, surface: capture.surface,
        status: capture.status, sha256: capture.sha256,
        ...(capture.sourceUrl === undefined ? {} : { sourceUrl: capture.sourceUrl }),
        ...(capture.httpStatus === undefined ? {} : { httpStatus: capture.httpStatus }) });
      if (capture.status === 'inaccessible') {
        if (capture.bytesBase64 !== null || capture.sha256 !== null) invalid('inaccessible capture has bytes');
        inaccessible = true;
        continue;
      }
      if (capture.status !== 'observed') invalid('invalid capture status');
      if (capture.surface !== (request.ecosystem === 'nexus' ? 'file-version-range' :
        request.ecosystem === 'steam' ? 'ugc-children' :
        request.ecosystem === 'modrinth' ? 'version' :
        request.ecosystem === 'curseforge' ? 'file' : 'manifest')
        && !(request.ecosystem === 'steam' && capture.surface === 'details-public')) {
        throw new Unsupported('unknown native surface');
      }
      if (typeof capture.bytesBase64 === 'string') {
        cost.inputBytes += Buffer.byteLength(capture.bytesBase64, 'base64');
      }
      const doc = parse(capture, request.ecosystem);
      if (request.ecosystem === 'nexus') throw new Unsupported('experimental Nexus range payload');
      const node = request.ecosystem === 'fabric' ? fabric(doc, capture.identity)
        : request.ecosystem === 'forge' || request.ecosystem === 'neoforge'
          ? forge(doc, capture.identity, request.ecosystem)
          : request.ecosystem === 'modrinth' ? modrinth(doc, capture.identity)
          : request.ecosystem === 'curseforge' ? curseforge(doc, capture.identity)
          : steam(doc, capture.identity, capture.surface);
      const previous = nodes.get(node.id);
      if (previous && request.ecosystem !== 'steam') invalid('duplicate native node');
      nodes.set(node.id, previous ? { ...node,
        relations: [...previous.relations, ...node.relations] } : node);
    }
  } catch (error) {
    if (error instanceof Unsupported) return failed('unsupported-semantics',
      [{ source: request.root, target: null, kind: error.message }]);
    throw error;
  }
  if (!nodes.has(request.root)) return failed('incomplete-source-data',
    [{ source: request.root, target: null, kind: 'root-unobserved' }]);
  if (inaccessible) return failed('incomplete-source-data',
    [{ source: request.root, target: null, kind: 'provider-surface-inaccessible' }]);
  if ((request.ecosystem === 'forge' || request.ecosystem === 'neoforge')
    && (!request.runtime || !/^\d+(?:\.\d+){0,3}$/.test(request.runtime.loaderVersion)
      || !/^\d+(?:\.\d+){0,3}$/.test(request.runtime.gameVersion))) {
    return failed('unsupported-semantics',
      [{ source: request.root, target: null, kind: 'loader-runtime-unbound' }]);
  }
  if (request.ecosystem === 'steam' && !seen.has(`${request.root}:ugc-children`)) {
    return failed('incomplete-source-data',
      [{ source: request.root, target: null, kind: 'Steam-children-unobserved' }]);
  }
  const relations = [...nodes.values()].flatMap(node => node.relations);
  cost.relations = relations.length;
  if (relations.length > MAX_RELATIONS) return failed('budget-exhausted',
    [{ source: request.root, target: null, kind: 'relation-limit' }]);
  const issues: ModIssue[] = [];
  let incomplete = false;
  let unsupported = false;
  let unsatisfiable = false;
  const projects = new Map<string, NativeNode | null>();
  for (const node of nodes.values()) projects.set(node.project,
    projects.has(node.project) ? null : node);
  for (const edge of relations) {
    if (edge.strength === 'embedded' && !nodes.has(edge.to)
      && projects.get(edge.to) === null) {
      unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'ambiguous-embedded-project' });
    }
  }
  for (const edge of relations) {
    if (edge.side && edge.side !== 'BOTH' && edge.side !== request.side) continue;
    if (edge.strength === 'embedded' || edge.strength === 'collection'
      || edge.strength === 'metadata') continue;
    const runtimeVersion = request.runtime && (edge.to === request.ecosystem
      || (request.ecosystem === 'fabric' && edge.to === 'fabricloader')
      ? request.runtime.loaderVersion : edge.to === 'minecraft'
        ? request.runtime.gameVersion : null);
    const target = runtimeVersion ? { id: edge.to, project: edge.to,
      version: runtimeVersion, relations: [] } : nodes.get(edge.to) ?? projects.get(edge.to);
    cost.comparisons++;
    const kind = edge.kind.split(':')[0]!;
    if (target === null) { unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'ambiguous-project-release' });
      continue;
    }
    if (!target) {
      if (kind === 'depends' || kind === 'required' || kind === 'required-runtime') { incomplete = true;
        issues.push({ source: edge.from, target: edge.to, kind: 'required-target-unobserved' }); }
      else if (kind === 'recommends') issues.push({ source: edge.from, target: edge.to, kind: 'advisory-missing' });
      continue;
    }
    const match = edge.range === null || target.version === null ? true
      : compareVersion(target.version, edge.range, request.ecosystem);
    if (match === null) { unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'unsupported-range' });
      continue;
    }
    const bad = (kind === 'depends' || kind === 'required' || kind === 'required-runtime'
      || kind === 'optional')
      ? !match : (kind === 'breaks' || kind === 'incompatible' || kind === 'conflicts'
        || kind === 'discouraged') ? match : false;
    if (bad) {
      const hard = edge.strength === 'hard';
      if (hard) unsatisfiable = true;
      issues.push({ source: edge.from, target: edge.to,
        kind: hard ? 'hard-constraint' : 'advisory-conflict' });
    }
  }
  const selection = unsupported ? 'unsupported-semantics' : incomplete
    ? 'incomplete-source-data' : unsatisfiable ? 'unsatisfiable' : 'valid';
  const activeRelations = relations.filter(edge => !edge.side || edge.side === 'BOTH'
    || edge.side === request.side);
  const ordering = selection === 'valid' || selection === 'unsatisfiable'
    ? hasCycle(activeRelations) ? 'cycle' : 'valid' : 'not-evaluated';
  const embedded = new Set(relations.filter(edge => edge.strength === 'embedded'
    && projects.get(edge.to) !== null).map(edge => edge.to));
  const independentDownloads = [...nodes.values()].filter(node =>
    !embedded.has(node.id) && !embedded.has(node.project)).map(node => node.id).sort();
  return { provenance: 'caller-supplied-captures', selection, ordering,
    relations, issues, independentDownloads, coverage, cost };
}
