/** Portable, inert catalogue formats. No filesystem, compiler or native admission imports. */
import { parseFilter, walkFilter, type FilterDocument } from '@rezics/filter';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import canonicalize from 'canonicalize';
import { Compile } from 'typebox/schema';
import kindSchema from '../schema/kind.json';
import rootSchema from '../schema/catalogue.json';
import nodeSchema from '../schema/catalogue-node.json';

export const KIND_FORMAT = 'https://rezics.com/definitions/kind/1';
export const KIND_REDUCTION = 'https://rezics.com/definitions/kind-reduction/1';
export const CATALOGUE_FORMAT = 'https://rezics.com/definitions/catalogue/2';
export const CATALOGUE_NODE_FORMAT = 'https://rezics.com/definitions/catalogue-node/1';
export const CATALOGUE_LIMITS = Object.freeze({
  declarationBytes: 65536,
  vocabulary: 256,
  nodeBytes: 262144,
  entries: 256,
});
export type DefinitionTypePin = Readonly<{ releaseDigest: string; typeId: string }>;
export type DefinitionPropertyPin = Readonly<{ releaseDigest: string; propertyId: string }>;
export type KindConditionV1 =
  | Readonly<{ op: 'exact-type'; type: DefinitionTypePin }>
  | Readonly<{
      op: 'filter';
      language: 'https://rezics.com/filter/1';
      document: FilterDocument;
      vocabulary: Readonly<{ types: readonly DefinitionTypePin[]; properties: readonly DefinitionPropertyPin[] }>;
    }>;
export type KindDeclarationV1 = Readonly<{
  format: typeof KIND_FORMAT;
  id: string;
  labels: Readonly<Record<string, string>>;
  descriptions?: Readonly<Record<string, string>>;
  auto: Readonly<{ eligible: boolean; precedence: number }>;
  condition: KindConditionV1;
  presentation: Readonly<{ type: DefinitionTypePin }>;
}>;
export type KindCataloguePin = Readonly<{
  format: typeof CATALOGUE_FORMAT;
  rootDigest: string;
  kindSpec: typeof KIND_FORMAT;
  reduction: typeof KIND_REDUCTION;
}>;
export type PinnedKindDeclaration = Readonly<{
  catalogue: KindCataloguePin;
  declarationDigest: string;
  declaration: KindDeclarationV1;
}>;
export type CatalogueRootV2 = Readonly<{
  format: typeof CATALOGUE_FORMAT;
  kindSpec: typeof KIND_FORMAT;
  reduction: typeof KIND_REDUCTION;
  directoryDigest: string;
}>;
export type CatalogueEntry = Readonly<{ key: string; kind: 'release' | 'declaration'; digest: string }>;
export type CatalogueRange = Readonly<{ first: string; last: string; digest: string }>;
export type CatalogueNodeV1 =
  | Readonly<{ format: typeof CATALOGUE_NODE_FORMAT; node: 'leaf'; entries: readonly CatalogueEntry[] }>
  | Readonly<{ format: typeof CATALOGUE_NODE_FORMAT; node: 'branch'; children: readonly CatalogueRange[] }>;
/** A reader supplies addressed inert bytes, not authority, capabilities or a URI loader. */
export type CatalogueArtifactReader = Readonly<{ read(digest: string): Promise<Uint8Array | undefined> }>;
export type CatalogueArtifactStore = CatalogueArtifactReader &
  Readonly<{
    put(digest: string, bytes: Uint8Array): Promise<void>;
  }>;
export class CatalogueArtifactError extends Error {
  constructor(
    readonly code: 'invalid' | 'missing' | 'corrupt' | 'conflict' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'CatalogueArtifactError';
  }
}
export function catalogueFail(code: CatalogueArtifactError['code'], message: string): never {
  throw new CatalogueArtifactError(code, message);
}
export function assertCatalogueDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$(?![\s\S])/.test(value))
    catalogueFail('invalid', 'Expected canonical sha256 digest');
}
export function assertKindId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*:[^\s]+$(?![\s\S])/u.test(value))
    catalogueFail('invalid', 'Expected exact CURIE stable ID');
}
export const compareCatalogueKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const declarationKey = (id: string) => {
  assertKindId(id);
  return `declaration:${id}`;
};
export const releaseKey = (digest: string) => {
  assertCatalogueDigest(digest);
  return `release:${digest}`;
};

/** Reject accessors/toJSON, prototypes, holes and non-JSON values before any ordinary property read. */
function ownJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) catalogueFail('invalid', 'Expected inert JSON data');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
    catalogueFail('invalid', 'Expected own JSON data');
  if (ancestors.has(value)) catalogueFail('invalid', 'Cyclic JSON data');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) catalogueFail('invalid', 'Expected dense JSON array');
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') catalogueFail('invalid', 'Expected JSON key');
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable || !Object.hasOwn(field, 'value')) catalogueFail('invalid', 'Expected own inert data');
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
      catalogueFail('invalid', 'Expected JSON array index');
    ownJson(field.value, ancestors);
  }
  ancestors.delete(value);
}
export function catalogueBytes(value: unknown): Uint8Array {
  try {
    ownJson(value);
    return new TextEncoder().encode(canonicalize(value)!);
  } catch (error) {
    if (error instanceof CatalogueArtifactError) throw error;
    return catalogueFail('invalid', 'Invalid canonical JSON');
  }
}
export function catalogueDigest(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

/** Strict byte decoder: unlike JSON.parse, duplicate object names (including escaped aliases) reject. */
export function parseCatalogueJson(bytes: Uint8Array, maximum: number): unknown {
  if (bytes.length > maximum) catalogueFail('invalid', `Artifact exceeds ${maximum} bytes`);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return catalogueFail('invalid', 'Invalid UTF-8');
  }
  let offset = 0;
  const fail = (): never => catalogueFail('invalid', `Invalid or duplicate-key JSON at byte text offset ${offset}`);
  const space = () => {
    while (/[\x20\x09\x0a\x0d]/.test(source[offset] ?? '\0')) offset++;
  };
  function string(): string {
    const start = offset++;
    while (offset < source.length) {
      const ch = source[offset++];
      if (ch === '\\') offset++;
      else if (ch === '"') {
        try {
          return JSON.parse(source.slice(start, offset));
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  function value(): unknown {
    space();
    const ch = source[offset];
    if (ch === '"') return string();
    if (ch === '{' || ch === '[') {
      offset++;
      space();
      const end = ch === '{' ? '}' : ']';
      const result: Record<string, unknown> = Object.create(null);
      const items: unknown[] = [];
      if (source[offset] === end) {
        offset++;
        return ch === '{' ? result : items;
      }
      while (true) {
        space();
        if (ch === '{') {
          if (source[offset] !== '"') return fail();
          const key = string();
          space();
          if (Object.hasOwn(result, key) || source[offset++] !== ':') return fail();
          result[key] = value();
        } else items.push(value());
        space();
        const delimiter = source[offset++];
        if (delimiter === end) return ch === '{' ? result : items;
        if (delimiter !== ',') return fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      source.slice(offset),
    );
    if (!match) return fail();
    offset += match[0].length;
    return JSON.parse(match[0]);
  }
  const result = value();
  space();
  if (offset !== source.length) return fail();
  catalogueBytes(result); // Enforce finite numbers and Unicode scalar strings as well.
  return result;
}
const kindValidator = Compile(kindSchema);
const rootValidator = Compile(rootSchema);
const nodeValidator = Compile(nodeSchema);
function checked<T>(value: unknown, validator: { Check(value: unknown): boolean }, limit: number, name: string): T {
  const bytes = catalogueBytes(value);
  if (bytes.length > limit || !validator.Check(value)) catalogueFail('invalid', `Invalid closed ${name} or version`);
  // Own the returned snapshot: caller mutations cannot alter the admitted object.
  return parseCatalogueJson(bytes, limit) as T;
}
export function parseKindDeclaration(value: unknown): KindDeclarationV1 {
  const result = checked<KindDeclarationV1>(
    value,
    kindValidator,
    CATALOGUE_LIMITS.declarationBytes,
    'Kind declaration',
  );
  if (result.condition.op === 'filter') {
    parseFilter(result.condition.document); // Original parser and all its existing bounds, never a replacement grammar.
    for (const node of walkFilter(result.condition.document))
      if ('owner' in node || 'saved' in node)
        catalogueFail('unsupported', 'Catalogue filters require public immutable expanded meaning');
    const { types, properties } = result.condition.vocabulary;
    if (types.length + properties.length > CATALOGUE_LIMITS.vocabulary)
      catalogueFail('invalid', 'Vocabulary exceeds 256 references');
    for (const [pins, field] of [
      [types, 'typeId'],
      [properties, 'propertyId'],
    ] as const) {
      const seen = new Set<string>();
      for (const pin of pins) {
        const id = field === 'typeId' ? (pin as DefinitionTypePin).typeId : (pin as DefinitionPropertyPin).propertyId;
        if (seen.has(id)) catalogueFail('conflict', `Repeated vocabulary identity ${id}`);
        seen.add(id);
      }
    }
  }
  return result;
}
/** This inventory is derived from the sole implemented construction branch below. It grants no native readiness. */
export const CATALOGUE_CONDITION_OPERATORS = Object.freeze(['exact-type'] as const);
export function requireConstructibleKind(declaration: KindDeclarationV1): void {
  if (declaration.condition.op !== CATALOGUE_CONDITION_OPERATORS[0])
    catalogueFail(
      'unsupported',
      'Filter catalogue construction requires the actual native producer; offline activation-ready publication is unsupported',
    );
}
export function parseCatalogueRoot(value: unknown): CatalogueRootV2 {
  return checked<CatalogueRootV2>(value, rootValidator, CATALOGUE_LIMITS.nodeBytes, 'catalogue root');
}
export function parseCataloguePin(value: unknown): KindCataloguePin {
  const bytes = catalogueBytes(value);
  const pin = parseCatalogueJson(bytes, CATALOGUE_LIMITS.nodeBytes);
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) catalogueFail('invalid', 'Invalid catalogue pin');
  const fields = pin as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(',') !== 'format,kindSpec,reduction,rootDigest' ||
    fields.format !== CATALOGUE_FORMAT ||
    fields.kindSpec !== KIND_FORMAT ||
    fields.reduction !== KIND_REDUCTION
  )
    catalogueFail('invalid', 'Invalid closed catalogue pin or version');
  assertCatalogueDigest(fields.rootDigest);
  return fields as KindCataloguePin;
}
export function parseCatalogueNode(value: unknown): CatalogueNodeV1 {
  const result = checked<CatalogueNodeV1>(value, nodeValidator, CATALOGUE_LIMITS.nodeBytes, 'directory node');
  let previous: string | undefined;
  for (const range of result.node === 'leaf'
    ? result.entries.map((e) => ({ first: e.key, last: e.key }))
    : result.children) {
    if (range.first > range.last || (previous !== undefined && previous >= range.first))
      catalogueFail('conflict', 'Directory ranges must be sorted, disjoint and nonempty');
    previous = range.last;
  }
  if (result.node === 'leaf')
    for (const entry of result.entries) {
      if (entry.kind === 'release' ? entry.key !== releaseKey(entry.digest) : !entry.key.startsWith('declaration:'))
        catalogueFail('invalid', `Mismatched typed directory key ${entry.key}`);
    }
  return result;
}
export function catalogueNodeRange(node: CatalogueNodeV1): { first: string; last: string } {
  return node.node === 'leaf'
    ? { first: node.entries[0]!.key, last: node.entries.at(-1)!.key }
    : { first: node.children[0]!.first, last: node.children.at(-1)!.last };
}
