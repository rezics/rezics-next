import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Committed classification of every GET/POST that accepts a resource id.
 * Unregistered rows are frozen debt: the writer refuses to add one. */
export const hiddenIdReadsPath = 'scripts/static/hidden-id-reads.json';

const openApiPath = 'generated/openapi/main/public.json';

/** Equality coverage. A row is `registered` only while it stays in this list. */
export const registeredHiddenIdReads = [
  'GET /v1/classification-vocabulary',
  'GET /v1/concepts/{id}',
  'GET /v1/exports/{export}',
  // Only the thread hidden/absent case is proved by realm-about-thread-read.test.ts;
  // resource and Realm read-count equality remain known limits.
  'GET /v1/realms/{realm}/about-thread',
  'GET /v1/realms/{realm}/members',
  'GET /v1/realms/{realm}/roles',
  'GET /v1/statements/{id}',
  'GET /v1/works/{id}',
  'GET /v1/works/{id}/classifications',
  'GET /v1/works/{id}/content-variants',
  'GET /v1/works/{id}/contents',
  'GET /v1/works/{id}/copies',
  'GET /v1/works/{id}/credits',
  'GET /v1/works/{id}/editions',
  'GET /v1/works/{id}/editorial-state',
  'GET /v1/works/{id}/maintainers',
  'GET /v1/works/{id}/metadata',
  'GET /v1/works/{id}/progress',
  'GET /v1/works/{id}/realizations',
  'GET /v1/works/{id}/releases',
  'GET /v1/works/{id}/source-support',
  'POST /v1/recipes/{id}/file-imports',
] as const;

/** Writes have their own outcome proofs; they do not run in the read-only equality fixture.
 * About-posts covers hidden/absent targets (404) and hidden/absent openers (ordinary posting).
 * source-mapped-adoption proves response equality for another editor's observation
 * and a missing observation; this does not claim equal owner query counts. */
export const registeredHiddenIdWrites = [
  'POST /v1/realms/{realm}/about-posts',
  // Retained collection resume compares another Person's file with an absent
  // file in native-exchange-disclosure.test.ts, without dispatching any row.
  'POST /v1/recipes/file-imports',
  'POST /v1/sources/observations/{observation}/conversions',
] as const;
/** Parent-output equality, proved at the owner tier in realm-reply-threads,
 * realm-reply-profile and realm-reply-parent-disclosure tests. These cases
 * compare the same child with a hidden parent and a parent that never existed;
 * they do not claim route-input or read-count equality. Keep them out of the
 * read-only integration fixture that substitutes the route's input ids. */
export const registeredHiddenParentOutputReads = [
  'GET /v1/agents/{id}/realm-contributions',
  'GET /v1/member-replies',
  'GET /v1/realms/{realm}/threads/{reply}',
] as const;
/** Content's owner stack proof compares hidden and absent revision responses and
 * conceals private input identities. It makes no equal-query-count claim. */
export const registeredHiddenContentRevisionReads = [
  'GET /v1/content-revisions/{revision}/derivations',
] as const;
/** Recipe export's owner API proof compares hidden/missing Structures and exact
 * draft/missing revisions, including anonymous refusal. It claims response
 * equality, not equal graph/SQL read counts (recipe-export-disclosure.test.ts). */
export const registeredHiddenRecipeExportReads = ['GET /v1/recipes/{id}/export'] as const;
/** Native exchange compares hidden and absent compositions/uploads through
 * composeMain in native-exchange-disclosure.test.ts; response equality only. */
export const registeredHiddenExchangeReads = [
  'GET /v1/compositions/{id}/export',
  'GET /v1/recipes/file-imports/{id}',
] as const;
/** Source's archive route owner test compares another principal's archive with
 * an absent archive. It proves response equality, not equal owner query counts,
 * and needs ordered retained bytes outside the read-only integration fixture. */
export const registeredHiddenArchiveReads = [
  'POST /v1/sources/archives/{archive}/image-witness',
] as const;
/** Work contribution/submission pages compare stranger responses for hidden and
 * absent Work/Realm inputs in work-contribution-pages.test.ts. This is response
 * equality coverage, without a claim of equal owner query counts. */
export const registeredHiddenWorkContributionReads = [
  'GET /v1/my/submissions',
  'GET /v1/realms/{realm}/submissions',
  'GET /v1/works/{id}/contributions',
] as const;
export const registeredHiddenIdOperations = [...registeredHiddenIdReads, ...registeredHiddenParentOutputReads,
  ...registeredHiddenContentRevisionReads,
  ...registeredHiddenRecipeExportReads,
  ...registeredHiddenExchangeReads,
  ...registeredHiddenArchiveReads,
  ...registeredHiddenWorkContributionReads,
  ...registeredHiddenIdWrites].sort((left, right) => left.localeCompare(right));

// The posting contract declares disclosure inputs, separately from its observed
// revision and route coordinates. Do not invent scalar-id debt for unrelated writes.
const writeDisclosureBodyIds: Readonly<Record<string, readonly string[]>> = {
  'POST /v1/realms/{realm}/about-posts': ['about', 'actingSubject'],
};

const BODY_ID_ARRAYS = new Set(['ids', 'resources', 'targets']);
const METHODS = ['get', 'post'] as const;

type Schema = {
  type?: string | string[];
  pattern?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
};

type Parameter = { in?: string; name?: string; schema?: Schema };

type Operation = {
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
};

type PathItem = Operation & { parameters?: Parameter[] } & Partial<
  Record<(typeof METHODS)[number], Operation>
>;

export interface OpenApiDocument {
  paths: Record<string, PathItem>;
}

export interface HiddenIdOperation {
  operation: string;
  ids: string[];
}

export interface HiddenIdClassification extends HiddenIdOperation {
  status: 'registered' | 'exempt' | 'unregistered';
  reason?: string;
}

function variants(schema: Schema | undefined): Schema[] {
  if (!schema) return [];
  const nested = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  return nested.length ? nested.flatMap(variants) : [schema];
}

function patternNamesResource(pattern: string): boolean {
  // `[0-9a-f-]` is a UUID class; the hyphen sits before the closing bracket.
  return /\[0-9a-f/.test(pattern) || /rezics\\?\.com\/id/.test(pattern) || pattern.startsWith('^OL');
}

/** A generation counter or a short vocabulary token is not a resource id. */
function patternIsNotResource(pattern: string): boolean {
  if (pattern === '^(0|[1-9][0-9]*)$') return true;
  return (
    /^\^\[a-z0-9\]\[a-z0-9-]\{0,\d+\}\$$/.test(pattern) ||
    /^\^\[a-z\]\[a-z0-9_.-]\{0,\d+\}\$$/.test(pattern) ||
    /^\^\[a-z\]\[a-z0-9-]\{0,\d+\}\$$/.test(pattern)
  );
}

function shapeNamesResource(shape: Schema): boolean {
  if (shape.enum || shape.type === 'integer' || shape.type === 'number' || shape.type === 'boolean')
    return false;
  if (typeof shape.pattern === 'string') {
    if (patternIsNotResource(shape.pattern)) return false;
    return patternNamesResource(shape.pattern);
  }
  if (shape.const !== undefined) return false;
  const type = shape.type;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}

function schemaNamesResource(schema: Schema | undefined): boolean {
  return variants(schema).some(shapeNamesResource);
}

/** Query strings name a resource only when the schema is an id, or the name is an id or alias. */
function queryNamesResource(path: string, name: string, schema: Schema | undefined): boolean {
  // Compare-and-swap heads are checked only after the addressed resource is disclosed.
  if (name === 'expectedHead') return false;
  if (name === 'id' || name === 'ids' || name === 'alias' || /Id$/.test(name) || /Ids$/.test(name)) return true;
  if (name === 'key' && path.startsWith('/v1/addresses/')) return true;
  return variants(schema).some(
    (shape) =>
      typeof shape.pattern === 'string' &&
      !patternIsNotResource(shape.pattern) &&
      patternNamesResource(shape.pattern),
  );
}

function collectBodyIds(schema: Schema | undefined, found: Set<string>, depth = 0): void {
  if (!schema || depth > 8) return;
  for (const shape of variants(schema)) {
    for (const [name, property] of Object.entries(shape.properties ?? {})) {
      if (
        BODY_ID_ARRAYS.has(name) &&
        variants(property).some((item) => item.type === 'array')
      ) {
        found.add(`body:${name}`);
      }
      collectBodyIds(property, found, depth + 1);
      for (const item of variants(property)) collectBodyIds(item.items, found, depth + 1);
    }
  }
}

function parameterSlots(path: string, parameters: readonly Parameter[]): string[] {
  const slots = new Set<string>();
  const byName = new Map<string, Parameter>();
  for (const parameter of parameters) {
    if (parameter.name) byName.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  for (const name of path.matchAll(/\{([^}]+)\}/g)) {
    const parameter = byName.get(`path:${name[1]}`);
    if (!parameter || schemaNamesResource(parameter.schema)) slots.add(`path:${name[1]}`);
  }
  for (const parameter of parameters) {
    if (parameter.in !== 'query' || !parameter.name) continue;
    if (queryNamesResource(path, parameter.name, parameter.schema)) slots.add(`query:${parameter.name}`);
  }
  return [...slots].sort();
}

/** GET and POST operations whose path, query or body accepts an id that names a resource. */
export function discoverHiddenIdReads(document: OpenApiDocument): HiddenIdOperation[] {
  const found: HiddenIdOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    const shared = item.parameters ?? [];
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const ids = new Set(
        parameterSlots(path, [...shared, ...(operation.parameters ?? [])]),
      );
      const body = operation.requestBody?.content?.['application/json']?.schema;
      collectBodyIds(body, ids);
      const name = `${method.toUpperCase()} ${path}`;
      for (const field of writeDisclosureBodyIds[name] ?? []) {
        if (!variants(body).some(shape => schemaNamesResource(shape.properties?.[field]))) {
          throw new Error(`${name} declares body:${field} disclosure but its contract has no resource id there`);
        }
        ids.add(`body:${field}`);
      }
      if (ids.size === 0) continue;
      found.push({ operation: name, ids: [...ids].sort() });
    }
  }
  return found.sort((left, right) => left.operation.localeCompare(right.operation));
}

/** The caller's own acting subject is not another resource's id. */
export function exemptionReason(operation: HiddenIdOperation): string | undefined {
  if (operation.ids.length > 0 && operation.ids.every((slot) => slot === 'query:actingSubject')) {
    return "The only id is the caller's own acting subject.";
  }
  return undefined;
}

export function classifyHiddenIdReads(
  discovered: readonly HiddenIdOperation[],
  registry: readonly string[] = registeredHiddenIdOperations,
): HiddenIdClassification[] {
  const registered = new Set(registry);
  return discovered.map((operation) => {
    if (registered.has(operation.operation)) return { ...operation, status: 'registered' };
    const reason = exemptionReason(operation);
    if (reason) return { ...operation, status: 'exempt', reason };
    return { ...operation, status: 'unregistered' };
  });
}

export function hiddenIdDebtGrowth(frozen: readonly string[], next: readonly string[]): string[] {
  const allowed = new Set(frozen);
  return next
    .filter((operation) => !allowed.has(operation))
    .sort()
    .map((operation) => `${operation} is new unregistered debt; register or exempt it`);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slot, index) => slot === right[index]);
}

/** The committed file must be the generated classification, and unregistered debt cannot grow. */
export function hiddenIdInventoryErrors(
  discovered: readonly HiddenIdOperation[],
  committed: readonly HiddenIdClassification[],
  registry: readonly string[] = registeredHiddenIdOperations,
): string[] {
  const errors: string[] = [];
  const committedByOperation = new Map(committed.map((entry) => [entry.operation, entry]));
  const discoveredByOperation = new Map(discovered.map((entry) => [entry.operation, entry]));
  for (const operation of discovered) {
    const entry = committedByOperation.get(operation.operation);
    if (!entry) {
      errors.push(`${operation.operation} accepts resource ids and is not classified`);
      continue;
    }
    if (!sameIds(entry.ids, operation.ids)) {
      errors.push(
        `${operation.operation} id slots are ${operation.ids.join(', ')}; the inventory says ${entry.ids.join(', ')}`,
      );
    }
  }
  for (const entry of committed) {
    if (!discoveredByOperation.has(entry.operation)) {
      errors.push(`${entry.operation} no longer accepts resource ids; remove it from the inventory`);
    }
  }
  const expected = classifyHiddenIdReads(discovered, registry);
  const expectedByOperation = new Map(expected.map((entry) => [entry.operation, entry]));
  for (const entry of committed) {
    const want = expectedByOperation.get(entry.operation);
    if (!want) continue;
    if (entry.status !== want.status || (entry.reason ?? '') !== (want.reason ?? '')) {
      errors.push(`${entry.operation} is ${entry.status}; classification is ${want.status}`);
    }
  }
  for (const operation of registry) {
    if (!discoveredByOperation.has(operation)) {
      errors.push(`${operation} is registered and is not an id-accepting read`);
    }
  }
  const frozen = committed.filter((entry) => entry.status === 'unregistered').map((entry) => entry.operation);
  const next = expected.filter((entry) => entry.status === 'unregistered').map((entry) => entry.operation);
  errors.push(...hiddenIdDebtGrowth(frozen, next));
  return [...new Set(errors)].sort();
}

export function canonicalHiddenIdReads(entries: readonly HiddenIdClassification[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function classificationShapeErrors(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return ['hidden-id inventory must be a list'];
  const errors: string[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`inventory[${index}] must classify one operation`);
      continue;
    }
    const row = entry as HiddenIdClassification;
    const keys = Object.keys(entry).sort().join();
    const statusOk = row.status === 'registered' || row.status === 'exempt' || row.status === 'unregistered';
    const reasonOk = row.status === 'exempt' ? typeof row.reason === 'string' && row.reason.length > 0 : row.reason === undefined;
    const idsOk = Array.isArray(row.ids) && row.ids.every((slot) => typeof slot === 'string');
    const keyOk = row.status === 'exempt' ? keys === 'ids,operation,reason,status' : keys === 'ids,operation,status';
    if (!keyOk || typeof row.operation !== 'string' || !statusOk || !reasonOk || !idsOk) {
      errors.push(`inventory[${index}] must be an operation, its id slots, and registered, exempt, or unregistered`);
    }
  }
  return errors;
}

export function loadHiddenIdReads(path: string): HiddenIdClassification[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const errors = classificationShapeErrors(parsed);
  if (errors.length) throw new Error(errors.join('\n'));
  return parsed as HiddenIdClassification[];
}

export function loadOpenApi(root: string): OpenApiDocument {
  return JSON.parse(readFileSync(join(root, openApiPath), 'utf8')) as OpenApiDocument;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const discovered = discoverHiddenIdReads(loadOpenApi(root));
  const next = classifyHiddenIdReads(discovered);
  const path = join(root, hiddenIdReadsPath);
  if (process.argv.includes('--write')) {
    const previous = existsSync(path) ? loadHiddenIdReads(path) : [];
    const growth = hiddenIdDebtGrowth(
      previous.filter((entry) => entry.status === 'unregistered').map((entry) => entry.operation),
      next.filter((entry) => entry.status === 'unregistered').map((entry) => entry.operation),
    );
    if (previous.length > 0 && growth.length) throw new Error(growth.join('\n'));
    writeFileSync(path, canonicalHiddenIdReads(next));
  } else {
    const errors = existsSync(path)
      ? hiddenIdInventoryErrors(discovered, loadHiddenIdReads(path))
      : ['hidden-id inventory is missing'];
    for (const error of errors) process.stdout.write(`${error}\n`);
    process.exitCode = errors.length ? 1 : 0;
  }
}
