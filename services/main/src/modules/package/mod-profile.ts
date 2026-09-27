import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

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
  /** Location of a Fabric child archive, verified against the captured parent JAR. */
  nestedOf?: string;
  nestedPath?: string;
}
export interface ModRequest {
  profile: 'mod-native-capture-v1';
  ecosystem: ModEcosystem;
  side: 'CLIENT' | 'SERVER';
  runtime?: { loaderVersion: string; gameVersion: string;
    features?: { openGLVersion?: string; javaVersion?: string } };
  root: string;
  captures: ModCapture[];
}
export interface ModRelation {
  from: string; to: string; kind: string;
  strength: 'hard' | 'advisory' | 'metadata' | 'embedded' | 'collection';
  range: string | string[] | null; side: string | null;
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
const NESTED_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9_./-]{1,160}\.jar$/;
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
function decodeBytes(capture: ModCapture): Buffer {
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
  return bytes;
}
function decode(capture: ModCapture): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(decodeBytes(capture)); }
  catch { return invalid('native capture is not UTF-8'); }
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Reads one bounded ZIP member by central-directory offset; rejected archives never confer provenance. */
function zipEntry(archive: Uint8Array, name: string): Buffer | null {
  const bytes = Buffer.from(archive);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
    || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) {
    invalid('invalid Fabric JAR central directory');
  }
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const centralEnd = offset + bytes.readUInt32LE(end + 12);
  if (count > MAX_RELATIONS || centralEnd !== end) invalid('invalid Fabric JAR entry budget');
  let found: Buffer | null = null;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) {
      invalid('invalid Fabric JAR entry');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || local + 30 > bytes.length) invalid('invalid Fabric JAR offsets');
    const entryName = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (entryName === name) {
      if (found || flags & 1 || ![0, 8].includes(method) || expanded > MAX_BYTES
        || compressed > MAX_BYTES || bytes.readUInt32LE(local) !== 0x04034b50
        || bytes.readUInt16LE(local + 6) !== flags
        || bytes.readUInt16LE(local + 8) !== method
        || bytes.toString('utf8', local + 30, local + 30 + bytes.readUInt16LE(local + 26))
          !== entryName) {
        invalid('invalid or duplicate Fabric JAR member');
      }
      const start = local + 30 + bytes.readUInt16LE(local + 26)
        + bytes.readUInt16LE(local + 28);
      if (start + compressed > offset) invalid('invalid Fabric JAR member bounds');
      const data = bytes.subarray(start, start + compressed);
      try { found = method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_BYTES }); }
      catch { invalid('invalid Fabric JAR compression'); }
      if (found!.length !== expanded || crc32(found!) !== checksum) {
        invalid('invalid Fabric JAR member checksum');
      }
    }
    offset = next;
  }
  if (offset !== end) invalid('invalid Fabric JAR central size');
  return found;
}
function parse(capture: ModCapture, ecosystem: ModEcosystem): Record<string, unknown> {
  const text = decode(capture);
  try { return obj(ecosystem === 'forge' || ecosystem === 'neoforge'
    ? Bun.TOML.parse(text) : JSON.parse(text)); }
  catch { return invalid('invalid native capture document'); }
}
function compareVersion(actual: string, range: string | string[], ecosystem: ModEcosystem): boolean | null {
  if (Array.isArray(range)) {
    const results = range.map(item => compareVersion(actual, item, ecosystem));
    return results.includes(true) ? true : results.includes(null) ? null : false;
  }
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
  if (ecosystem === 'fabric' && range.includes(' ')) {
    if (!range.trim()) return null;
    const results = range.trim().split(/\s+/).map(item => compareVersion(actual, item, ecosystem));
    return results.includes(false) ? false : results.includes(null) ? null : true;
  }
  if (ecosystem === 'fabric' && /^[~^]\d+(?:\.\d+){0,3}$/.test(range)) {
    const parts = range.slice(1).split('.').map(Number);
    if (range[0] === '^' && parts[0] === 0) return null;
    const upper = [...parts];
    const index = range[0] === '^' ? 0 : Math.min(1, parts.length - 1);
    upper[index] = upper[index]! + 1;
    for (let i = index + 1; i < upper.length; i++) upper[i] = 0;
    const lower = compareVersion(actual, `>=${parts.join('.')}`, ecosystem);
    const upperMatch = compareVersion(actual, `<${upper.join('.')}`, ecosystem);
    return lower === null || upperMatch === null ? null : lower && upperMatch;
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
interface NativeNode { id: string; project: string; version: string | null;
  relations: ModRelation[]; activeSide?: 'CLIENT' | 'SERVER'; nestedPaths?: string[];
  provides?: string[] }
function relation(from: string, to: string, kind: string, strength: ModRelation['strength'],
  range: string | string[] | null = null, side: string | null = null): ModRelation {
  if (!ID.test(to)) invalid('invalid native dependency identity');
  return { from, to, kind, strength, range, side };
}
function fabric(doc: Record<string, unknown>, source: string): NativeNode {
  if (doc.schemaVersion !== 1) throw new Unsupported('Fabric schemaVersion');
  const id = string(doc.id, 'Fabric id');
  const version = string(doc.version, 'Fabric version');
  if (!FABRIC_ID.test(id)) invalid('invalid Fabric id');
  const provides = array(doc.provides ?? [], 'Fabric provides').map(value => {
    const alias = string(value, 'Fabric provided ID');
    if (!FABRIC_ID.test(alias) || alias === id) invalid('invalid Fabric provided ID');
    return alias;
  });
  if (new Set(provides).size !== provides.length) invalid('duplicate Fabric provided ID');
  const environment = doc.environment === undefined ? '*' : string(doc.environment, 'environment');
  if (!['*', 'client', 'server'].includes(environment)) throw new Unsupported('Fabric environment');
  const nestedPaths = array(doc.jars ?? [], 'Fabric jars').map(entry => {
    const path = string(obj(entry).file, 'Fabric nested JAR path');
    if (!NESTED_PATH.test(path)) throw new Unsupported('Fabric nested JAR path');
    return path;
  });
  if (new Set(nestedPaths).size !== nestedPaths.length) invalid('duplicate Fabric nested JAR path');
  const relations: ModRelation[] = [];
  for (const [kind, strength] of [
    ['depends', 'hard'], ['breaks', 'hard'], ['recommends', 'advisory'],
    ['conflicts', 'advisory'], ['suggests', 'metadata'],
  ] as const) {
    const map = doc[kind] ?? {};
    for (const [target, value] of Object.entries(obj(map))) {
      if (!FABRIC_ID.test(target)) invalid('invalid Fabric dependency ID');
      if (typeof value !== 'string'
        && !(Array.isArray(value) && value.length > 0 && value.length <= 16
          && value.every(item => typeof item === 'string' && item.length <= 128))) {
        throw new Unsupported('Fabric range alternatives');
      }
      relations.push(relation(id, target, kind, strength, value,
        environment === '*' ? null : environment.toUpperCase()));
    }
  }
  if (source !== id) invalid('Fabric capture identity differs from mod ID');
  return { id, project: id, version, relations,
    ...(environment === '*' ? {} : { activeSide: environment.toUpperCase() as 'CLIENT' | 'SERVER' }),
    nestedPaths, provides };
}
function forge(doc: Record<string, unknown>, source: string, ecosystem: 'forge' | 'neoforge'): NativeNode {
  const modLoader = string(doc.modLoader, 'modLoader');
  if (!['javafml', 'lowcodefml'].includes(modLoader)) throw new Unsupported('loader language');
  const loaderVersion = string(doc.loaderVersion, 'loaderVersion');
  string(doc.license, 'license');
  if (doc.clientSideOnly !== undefined && typeof doc.clientSideOnly !== 'boolean') {
    throw new Unsupported('clientSideOnly value');
  }
  if (doc.mixins !== undefined && ecosystem === 'forge') throw new Unsupported('Forge mixin metadata');
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
  const featureMap = obj(obj(doc.features ?? {})[id] ?? {});
  for (const [name, bound] of Object.entries(featureMap)) {
    if (!['openGLVersion', 'javaVersion'].includes(name) || typeof bound !== 'string') {
      throw new Unsupported('loader feature');
    }
    relations.push(relation(id, `feature:${name}`, 'required-feature', 'hard', bound,
      name === 'openGLVersion' ? 'CLIENT' : 'BOTH'));
  }
  if (ecosystem === 'neoforge') {
    for (const entry of array(doc.mixins ?? [], 'NeoForge mixins')) {
      const mixin = obj(entry);
      const config = string(mixin.config, 'NeoForge mixin config');
      if (!/^[A-Za-z0-9_./-]{1,160}\.json$/.test(config) || config.includes('..')) {
        throw new Unsupported('NeoForge mixin config path');
      }
      if (mixin.behaviorVersion !== undefined) {
        throw new Unsupported('NeoForge mixin behaviorVersion');
      }
      for (const target of array(mixin.requiredMods ?? [], 'NeoForge mixin requiredMods')) {
        const targetId = string(target, 'NeoForge required mod ID');
        if (!FORGE_ID.test(targetId)) invalid('invalid NeoForge mixin required mod ID');
        relations.push(relation(id, targetId, `mixin-conditional:${config}`, 'metadata'));
      }
    }
  }
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
      // An installed optional mod outside versionRange still fails native FML validation.
      strength = 'hard';
    } else {
      if (dep.mandatory !== undefined) throw new Unsupported('NeoForge mandatory field');
      kind = dep.type === undefined ? 'required' : string(dep.type, 'type');
      if (!['required', 'optional', 'incompatible', 'discouraged'].includes(kind)) {
        throw new Unsupported('NeoForge dependency type');
      }
      strength = kind === 'discouraged' ? 'advisory' : 'hard';
    }
    const range = dep.versionRange === undefined ? '' : string(dep.versionRange, 'versionRange');
    relations.push(relation(id, target, `${kind}:${ordering}`, strength, range, side));
  }
  return { id, project: id, version, relations,
    ...(ecosystem === 'forge' && doc.clientSideOnly === true ? { activeSide: 'CLIENT' as const } : {}) };
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
  // The single-file REST endpoint encloses the exact file record in `data`.
  if (doc.data !== undefined) doc = obj(doc.data);
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
  if (surface === 'collection-details') {
    const response = obj(doc.response);
    const details = array(response.collectiondetails, 'Steam collection details');
    if (details.length !== 1) throw new Unsupported('Steam collection detail count');
    const item = obj(details[0]);
    if (item.result !== 1 || item.publishedfileid !== source) {
      throw new Unsupported('Steam collection detail unavailable');
    }
    const children = array(item.children, 'Steam collection children');
    const ids = children.map(value => {
      const child = string(obj(value).publishedfileid, 'Steam collection child ID');
      if (!/^\d{1,20}$/.test(child)) invalid('invalid Steam collection child ID');
      return child;
    });
    if (new Set(ids).size !== ids.length) invalid('duplicate Steam collection child');
    return { id: source, project: source, version: null,
      relations: ids.map(child => relation(source, child, 'collection-member', 'collection')) };
  }
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
    if (order !== 'BEFORE' && order !== 'AFTER') continue;
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
/** Work: O(C·B + C² + R), with B <= 2 MiB, C <= 32 and R <= 256;
 * each ZIP member expansion is capped at 65,536 bytes. */
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
  const nestedCaptures = new Map<string, string>();
  const fabricArchives = new Map<string, Buffer>();
  const fabricManifests = new Map<string, Buffer>();
  let inaccessible = false;
  try {
    for (const capture of request.captures) {
      if (!ID.test(capture.identity) || !ID.test(capture.surface)
        || seen.has(`${capture.identity}:${capture.surface}`)) invalid('invalid or duplicate capture identity');
      if (capture.httpStatus !== undefined
        && (!Number.isInteger(capture.httpStatus) || capture.httpStatus < 100
          || capture.httpStatus > 599)) invalid('invalid provider HTTP status');
      if (capture.nestedOf !== undefined || capture.nestedPath !== undefined) {
        if (request.ecosystem !== 'fabric' || capture.surface !== 'manifest'
          || typeof capture.nestedOf !== 'string' || !FABRIC_ID.test(capture.nestedOf)
          || typeof capture.nestedPath !== 'string' || !NESTED_PATH.test(capture.nestedPath)
          || capture.identity === capture.nestedOf) invalid('invalid Fabric nested capture');
        const key = `${capture.nestedOf}\u0000${capture.nestedPath}`;
        if (nestedCaptures.has(key)) invalid('duplicate Fabric nested capture');
        nestedCaptures.set(key, capture.identity);
      }
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
      if (request.ecosystem === 'fabric' && capture.surface === 'archive') {
        const archive = decodeBytes(capture);
        cost.inputBytes += archive.length;
        fabricArchives.set(capture.identity, archive);
        continue;
      }
      if (capture.surface !== (request.ecosystem === 'nexus' ? 'file-version-range' :
        request.ecosystem === 'steam' ? 'ugc-children' :
        request.ecosystem === 'modrinth' ? 'version' :
        request.ecosystem === 'curseforge' ? 'file' : 'manifest')
        && !(request.ecosystem === 'steam'
          && ['details-public', 'collection-details'].includes(capture.surface))
        && !(request.ecosystem === 'nexus' && capture.surface === 'graphql-public')) {
        throw new Unsupported('unknown native surface');
      }
      if (typeof capture.bytesBase64 === 'string') {
        cost.inputBytes += Buffer.byteLength(capture.bytesBase64, 'base64');
      }
      const doc = parse(capture, request.ecosystem);
      if (request.ecosystem === 'fabric') fabricManifests.set(capture.identity, decodeBytes(capture));
      if (request.ecosystem === 'nexus' && capture.surface === 'graphql-public') {
        const data = obj(doc.data);
        const games = array(obj(data.games).nodes, 'Nexus public games');
        if (data.__typename !== 'Query' || games.length === 0
          || games.some(game => !Number.isSafeInteger(obj(game).id))) {
          throw new Unsupported('Nexus public GraphQL response');
        }
        continue;
      }
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
  if (request.ecosystem === 'steam' && !seen.has(`${request.root}:ugc-children`)
    && !seen.has(`${request.root}:collection-details`)) {
    return failed('incomplete-source-data',
      [{ source: request.root, target: null, kind: 'Steam-children-unobserved' }]);
  }
  if (request.ecosystem === 'fabric') {
    for (const [id, archive] of fabricArchives) {
      const manifest = zipEntry(archive, 'fabric.mod.json');
      const capturedManifest = fabricManifests.get(id);
      if (!manifest || !capturedManifest || !manifest.equals(capturedManifest)) {
        invalid('Fabric archive manifest mismatch');
      }
    }
    for (const [key] of nestedCaptures) {
      const [parent, path] = key.split('\u0000');
      const node = nodes.get(parent!);
      if (!node) return failed('incomplete-source-data',
        [{ source: parent!, target: path!, kind: 'nested-parent-unobserved' }]);
      if (!node.nestedPaths?.includes(path!)) invalid('undeclared Fabric nested capture');
    }
    const parentByChild = new Map<string, string>();
    for (const [key, child] of nestedCaptures) parentByChild.set(child, key.split('\u0000')[0]!);
    for (const child of parentByChild.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = child;
      while (current && parentByChild.has(current)) {
        if (visited.has(current)) invalid('cyclic Fabric nested capture');
        visited.add(current);
        current = parentByChild.get(current);
      }
    }
    const depth = (id: string): number => {
      let level = 0;
      let parent = parentByChild.get(id);
      while (parent) { level++; parent = parentByChild.get(parent); }
      return level;
    };
    for (const node of [...nodes.values()].sort((a, b) => depth(a.id) - depth(b.id))) {
      if (node.activeSide && node.activeSide !== request.side) continue;
      for (const path of node.nestedPaths ?? []) {
        const child = nestedCaptures.get(`${node.id}\u0000${path}`);
        if (!child || !nodes.has(child)) return failed('incomplete-source-data',
          [{ source: node.id, target: path, kind: 'nested-jar-unobserved' }]);
        const parentArchive = fabricArchives.get(node.id);
        if (!parentArchive) return failed('incomplete-source-data',
          [{ source: node.id, target: path, kind: 'nested-parent-archive-unobserved' }]);
        const childArchive = zipEntry(parentArchive, path);
        if (!childArchive) return failed('incomplete-source-data',
          [{ source: node.id, target: path, kind: 'nested-jar-missing-from-archive' }]);
        const childManifest = zipEntry(childArchive, 'fabric.mod.json');
        const capturedChildManifest = fabricManifests.get(child);
        if (!childManifest || !capturedChildManifest
          || !childManifest.equals(capturedChildManifest)) {
          invalid('Fabric nested archive manifest mismatch');
        }
        if (fabricArchives.has(child) && !fabricArchives.get(child)!.equals(childArchive)) {
          invalid('Fabric nested archive bytes mismatch');
        }
        fabricArchives.set(child, childArchive);
        node.relations.push(relation(node.id, child, 'nested-jar', 'embedded'));
      }
    }
  }
  const activeNodes = new Map([...nodes].filter(([, node]) =>
    !node.activeSide || node.activeSide === request.side));
  // A nested candidate is discovered only through a parent active on this side.
  if (request.ecosystem === 'fabric') {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [key, child] of nestedCaptures) {
        const parent = key.split('\u0000')[0]!;
        if (!activeNodes.has(parent) && activeNodes.delete(child)) changed = true;
      }
    }
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
  for (const node of activeNodes.values()) projects.set(node.project,
    projects.has(node.project) ? null : node);
  const provided = new Map<string, NativeNode | null>();
  if (request.ecosystem === 'fabric') {
    for (const node of activeNodes.values()) for (const alias of node.provides ?? []) {
      provided.set(alias, activeNodes.has(alias) || provided.has(alias) ? null : node);
    }
  }
  for (const edge of relations) {
    if (!activeNodes.has(edge.from)) continue;
    if (edge.strength === 'embedded' && !nodes.has(edge.to)
      && projects.get(edge.to) === null) {
      unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'ambiguous-embedded-project' });
    }
  }
  for (const edge of relations) {
    if (!activeNodes.has(edge.from)) continue;
    if (edge.side && edge.side !== 'BOTH' && edge.side !== request.side) continue;
    if (edge.strength === 'embedded' || edge.strength === 'collection'
      || edge.strength === 'metadata') continue;
    const runtimeVersion = request.runtime && (edge.to === request.ecosystem
      || (request.ecosystem === 'fabric' && edge.to === 'fabricloader')
      ? request.runtime.loaderVersion : edge.to === 'minecraft'
        ? request.runtime.gameVersion : edge.to.startsWith('feature:')
          ? request.runtime.features?.[edge.to.slice(8) as 'openGLVersion' | 'javaVersion'] : null);
    const aliasTarget = provided.get(edge.to);
    if (provided.has(edge.to) && aliasTarget === null) { unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'ambiguous-provided-ID' });
      continue;
    }
    if (aliasTarget && edge.range !== '*' && edge.range !== null) { unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'provided-version-unqualified' });
      continue;
    }
    const target = runtimeVersion ? { id: edge.to, project: edge.to,
      version: runtimeVersion, relations: [] }
      : activeNodes.get(edge.to) ?? aliasTarget ?? projects.get(edge.to);
    cost.comparisons++;
    const kind = edge.kind.split(':')[0]!;
    if (target === null) { unsupported = true;
      issues.push({ source: edge.from, target: edge.to, kind: 'ambiguous-project-release' });
      continue;
    }
    if (!target) {
      if (nodes.has(edge.to) && !activeNodes.has(edge.to)
        && (kind === 'depends' || kind === 'required')) { unsatisfiable = true;
        issues.push({ source: edge.from, target: edge.to, kind: 'target-skipped-on-side' });
        continue;
      }
      if (kind === 'required-feature') { unsupported = true;
        issues.push({ source: edge.from, target: edge.to, kind: 'feature-runtime-unbound' });
        continue;
      }
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
      || kind === 'required-feature'
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
  const activeRelations = relations.filter(edge => activeNodes.has(edge.from)
    && (!edge.side || edge.side === 'BOTH' || edge.side === request.side));
  // FML checks dependency versions by side, then its sorter adds ordering edges on both sides.
  const orderingRelations = request.ecosystem === 'forge' || request.ecosystem === 'neoforge'
    ? relations.filter(edge => activeNodes.has(edge.from)) : activeRelations;
  const ordering = selection === 'valid' || selection === 'unsatisfiable'
    ? hasCycle(orderingRelations) ? 'cycle' : 'valid' : 'not-evaluated';
  const embedded = new Set(relations.filter(edge => edge.strength === 'embedded'
    && projects.get(edge.to) !== null).map(edge => edge.to));
  const independentDownloads = [...activeNodes.values()].filter(node =>
    !embedded.has(node.id) && !embedded.has(node.project)).map(node => node.id).sort();
  return { provenance: 'caller-supplied-captures', selection, ordering,
    relations, issues, independentDownloads, coverage, cost };
}
