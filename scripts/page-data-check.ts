#!/usr/bin/env bun
/**
 * Classify M1 page sections against the seeded running product: Playwright, the native
 * Kernel endpoint, and a read-only SQL count. Prints one line per section. Never prints
 * credentials.
 *
 * Decision: use the routed default for native/page/seed judgments; pair every page section
 * with that persona's native response, and classify SEED only for a declared expected SQL
 * relation whose count is zero after the reader settles.
 */
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign, type JsonWebKeyInput } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from '../packages/ui/node_modules/playwright/index.js';

type JsonWebKey = JsonWebKeyInput['key'] & { kid?: string };

export const CLASSES = ['DATA', 'EMPTY', 'UNAUTHORIZED', 'UNAVAILABLE', 'API', 'WEB', 'SEED'] as const;
export type SectionClass = (typeof CLASSES)[number];
export const DEFECTS: ReadonlySet<SectionClass> = new Set(['API', 'WEB', 'SEED']);
export const PERSONAS = ['anonymous', 'member'] as const;
export type Persona = (typeof PERSONAS)[number];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = resolve(ROOT, 'scripts/page-data-sections.json');
const DEFAULT_SEED_ARTIFACT = resolve(ROOT, '..', 'page-data-stack', '.temp/cross-media-seed/result.json');
const DEFAULT_AUTH_ORIGIN = 'http://127.0.0.1:4200';
const DEFAULT_KERNEL_ENV = resolve(ROOT, 'services/kernel/.env');
const LOCAL_KEYS = resolve(ROOT, '.temp/local-stack/keys.json');
const MEMBER_EMAIL = 'developer@rezics.test';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const PAGE_WAIT_MS = 5_000;
const READER_WAIT_MS = 2_500;
const REQUEST_WAIT_MS = 5_000;
const SECRET_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|password[=:][^\s&]+|authorization:\s*[^\r\n]+)/gi;

type QueryClient = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: { n?: unknown }[] }>;
  release(error?: Error | boolean): void;
};

type QueryPool = {
  connect(): Promise<QueryClient>;
  end(): Promise<void>;
};

export type NativeCall = {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  items: string;
  admission?: string;
  action?: { role: 'button'; name: string };
};

export type SeedSql = {
  text: string;
  params: readonly ('subject' | 'property' | 'kind' | 'place' | 'question' | 'filter')[];
};

export type ManifestSection = {
  id: string;
  name: string;
  personas?: readonly Persona[];
  selector: string;
  heading?: string;
  itemSelector?: string;
  native: NativeCall;
  sql?: SeedSql;
  property?: string;
  kind?: string;
};

export type ManifestPage = {
  id: string;
  path: string;
  seedIdentity?: SeedIdentityReference;
  personas?: readonly Persona[];
  sections: ManifestSection[];
};

export type SeedIdentityReference = {
  provider: 'bangumi' | 'vndb';
  sourceKey: string;
  nativeType: string;
  namespace?: string;
};

export type SeedIdentityFailure =
  | 'artifact-missing'
  | 'artifact-invalid'
  | 'source-key-missing'
  | 'identity-missing'
  | 'identity-invalid'
  | 'ambiguous'
  | 'native-type-mismatch';

export type MemberAuthorityUnrun = {
  version: 1;
  reason: 'member-authority-unavailable';
  scopes: readonly string[];
  probes: { native: 'unrun' };
};

export type UnrunProbeEvidence = MemberAuthorityUnrun | SeedUnrunProbeEvidence;
export type SeedUnrunProbeEvidence = {
  version: 1;
  provider: SeedIdentityReference['provider'];
  sourceKey: string;
  nativeType: string;
  namespace?: string;
  artifact: string;
  collection?: string;
  reason: SeedIdentityFailure;
  probes: { web: 'unrun'; native: 'unrun'; sql: 'unrun' | 'not-declared' };
};

export type Manifest = {
  version: 1;
  context: string;
  question: string;
  pages: ManifestPage[];
};

export type NativeObservation = {
  status: number;
  body: unknown;
  authorized: boolean;
  error?: string;
};

export type NativeProblemEvidence = {
  code?: string;
  pointer?: string;
};

export type PageObservation = {
  present: boolean;
  itemCount: number;
  text: string;
  dataState: string | null;
  busy: boolean;
  homeMounted: boolean | null;
  homeState: string | null;
  homeBusy: boolean | null;
  document?: ReaderDocumentIdentity;
};

export type BrowserServerFunctionObservation = {
  started: number;
  responses: number;
  settled: number;
  failed: number;
  pending: number;
  truncated: boolean;
};

export type ReaderDocumentIdentity = {
  url: string;
  timeOrigin: number;
};

export type NativeKind = 'error' | 'unauthorized' | 'unavailable' | 'data' | 'empty';
export type PageKind = 'data' | 'empty' | 'unauthorized' | 'unavailable' | 'loading' | 'missing';

export type SectionResult = {
  page: string;
  persona: Persona;
  section: string;
  name: string;
  class: SectionClass;
  evidence: {
    nativeStatus: number;
    nativeItems: number;
    pageItems: number;
    reader: PageKind;
    seedCount: number | null;
    seedExpected: boolean;
    nativeProbe: 'run' | 'unrun';
    browserProbe: 'run' | 'unrun';
    sqlProbe: 'run' | 'unrun' | 'not-declared';
    browserServerFunctions: BrowserServerFunctionObservation;
    action: 'not-required' | 'not-started' | 'started' | 'settled' | 'failed';
    homeMounted: boolean | null;
    homeState: string | null;
    homeBusy: boolean | null;
    readerDocument?: ReaderDocumentIdentity;
    nativeProblem?: NativeProblemEvidence;
    unrun?: UnrunProbeEvidence;
  };
};

export type RunOptions = {
  baseUrl: string;
  kernel: string;
  manifest: Manifest;
  invocation?: string;
  databaseUrl?: string;
  memberToken?: string;
  memberStorageState?: string;
  seedArtifact?: unknown;
  seedArtifactSource?: string;
  seedArtifactFailure?: 'artifact-missing' | 'artifact-invalid';
  signIn?: {
    origin: string;
    email: string;
    password: string;
    website?: { key: JsonWebKey; resource: string };
  };
  queryCount?: (text: string, values: readonly string[]) => Promise<number>;
  fetch?: typeof fetch;
  browser?: Browser;
  pageTimeoutMs?: number;
  readerTimeoutMs?: number;
  requestTimeoutMs?: number;
  stdout?: { write(chunk: string): void };
  stderr?: { write(chunk: string): void };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redact(value: string): string {
  return value.replace(SECRET_PATTERN, '[redacted]');
}

export function publicOrigin(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be http or https`);
  if (url.username || url.password) throw new Error(`${name} must not include credentials`);
  return url;
}

export function pointer(value: unknown, path: string): unknown {
  if (path === '' || path === '/') return value;
  if (!path.startsWith('/')) throw new Error(`items path must be a JSON pointer: ${path}`);
  const parts = path
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current = value;
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function hasItems(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value > 0;
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => hasItems(entry));
}

function countItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length > 0 ? 1 : 0;
  if (typeof value === 'number') return value > 0 ? value : 0;
  if (isRecord(value)) {
    const entries = Object.values(value);
    const nestedItems = entries.reduce<number>((total, entry) => total + (Array.isArray(entry) ? entry.length : 0), 0);
    return nestedItems || (entries.length > 0 ? 1 : 0);
  }
  return 0;
}

function problemCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.code === 'string') return body.code;
  const error = body.error;
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return undefined;
}

function safeProblemCode(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9_]*$/.test(value) ? value : undefined;
}

function safeValidationPointer(value: unknown): string | undefined {
  if (value === '') return '';
  return typeof value === 'string' &&
    value.length <= 128 &&
    /^\/(?:[A-Za-z0-9_-]|~[01])+(?:\/(?:[A-Za-z0-9_-]|~[01])+){0,15}$/.test(value)
    ? value
    : undefined;
}

/** Retain only compact, structured diagnostics from non-success HTTP responses. */
export function nativeProblemEvidence(status: number, body: unknown): NativeProblemEvidence | undefined {
  if (status < 300 || status > 599 || !isRecord(body)) return undefined;
  const nested = isRecord(body.error) ? body.error : undefined;
  const code = safeProblemCode(typeof body.code === 'string' ? body.code : nested?.code);
  const errors = Array.isArray(body.errors) ? body.errors : nested?.errors;
  let pointer: string | undefined;
  if (Array.isArray(errors)) {
    for (const error of errors.slice(0, 16)) {
      if (!isRecord(error)) continue;
      pointer = safeValidationPointer(error.pointer);
      if (pointer !== undefined) break;
    }
  }
  if (code === undefined && pointer === undefined) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(pointer === undefined ? {} : { pointer }) };
}

function nativeStatesUnavailable(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const sources = body.sources;
  if (isRecord(sources)) {
    for (const value of Object.values(sources)) {
      if (value === 'preparing' || value === 'unavailable') return true;
    }
  }
  const catalogue = body.catalogue;
  const directions = isRecord(catalogue) ? catalogue.directions : undefined;
  if (Array.isArray(directions)) {
    for (const direction of directions) {
      if (isRecord(direction) && direction.state === 'unavailable') return true;
    }
  }
  return false;
}

export function nativeKind(observation: NativeObservation, items: string, admission?: string): NativeKind {
  const { status, body, authorized, error } = observation;
  if (error) return 'error';
  if ((status === 401 || status === 403) && !authorized) return 'unauthorized';
  if ((status === 401 || status === 403) && authorized) return 'error';
  if (nativeStatesUnavailable(body) || problemCode(body) === 'index_not_ready') return 'unavailable';
  if (status >= 400 || status === 0) return 'error';
  const selected = pointer(body, items);
  if (admission !== undefined) {
    if (!Array.isArray(selected)) return 'error';
    return selected.includes(admission) ? 'data' : 'unavailable';
  }
  const hasData = hasItems(selected);
  return hasData ? 'data' : 'empty';
}

const UNAUTHORIZED_TEXT = /\b(unauthorized|forbidden|sign in|not allowed)\b/i;
const UNAVAILABLE_TEXT =
  /\b(unavailable|could not be loaded|retired|not available|being prepared|try the current work again|no readable preview)\b/i;
const LOADING_TEXT = /\b(loading|preparing)\b/i;
const EMPTY_TEXT = /\b(no visible entries|no supplied|no admitted|no results|empty)\b/i;

export function pageKind(observation: PageObservation): PageKind {
  if (!observation.present) return 'missing';
  if (UNAUTHORIZED_TEXT.test(observation.text) || observation.dataState === 'unauthorized') return 'unauthorized';
  if (UNAVAILABLE_TEXT.test(observation.text) || observation.dataState === 'unavailable') return 'unavailable';
  if (observation.busy || LOADING_TEXT.test(observation.text) || observation.dataState === 'loading') return 'loading';
  if (observation.itemCount > 0) return 'data';
  if (EMPTY_TEXT.test(observation.text) || observation.dataState === 'empty' || observation.itemCount === 0)
    return 'empty';
  return 'missing';
}

export function classifySection(
  native: NativeObservation,
  page: PageObservation,
  items: string,
  seedCount: number | null,
  seedExpected = seedCount !== null,
  admission?: string,
): SectionClass {
  const nativeState = nativeKind(native, items, admission);
  const pageState = pageKind(page);
  if (nativeState === 'error') return 'API';
  if (nativeState === 'unauthorized') return 'UNAUTHORIZED';
  if (nativeState === 'unavailable') return 'UNAVAILABLE';
  if (pageState === 'unauthorized') return 'UNAUTHORIZED';
  if (pageState === 'loading' || pageState === 'unavailable' || pageState === 'missing') return 'UNAVAILABLE';
  if (nativeState === 'data') return pageState === 'data' ? 'DATA' : pageState === 'empty' ? 'WEB' : 'UNAVAILABLE';
  if (pageState === 'data') return 'API';
  if (seedExpected) return seedCount === 0 ? 'SEED' : seedCount === null ? 'UNAVAILABLE' : 'EMPTY';
  return pageState === 'empty' ? 'EMPTY' : 'UNAVAILABLE';
}

export function formatLine(result: SectionResult): string {
  const provenance = result.evidence.unrun ? ` unrun=${encodeURIComponent(JSON.stringify(result.evidence.unrun))}` : '';
  const nativeProblem = result.evidence.nativeProblem
    ? ` nativeProblem=${encodeURIComponent(JSON.stringify(result.evidence.nativeProblem))}`
    : '';
  return `${result.page} ${result.persona} ${result.section} ${result.class}${nativeProblem}${provenance}`;
}

type SeedIdentityCandidate = { id: unknown; type: unknown; collection: string };
export type SeedIdentityResolution =
  | { status: 'resolved'; subjectId: string; collection: string }
  | { status: 'unrun'; reason: SeedIdentityFailure; collection?: string };

function identityCandidates(reference: SeedIdentityReference, artifact: unknown): SeedIdentityCandidate[] {
  if (!isRecord(artifact)) return [];
  const candidates: SeedIdentityCandidate[] = [];
  const readings = artifact.readings;
  if (Array.isArray(readings)) {
    for (const reading of readings) {
      if (!isRecord(reading) || reading.source !== reference.provider || reading.externalId !== reference.sourceKey)
        continue;
      const current =
        isRecord(reading.subject) && isRecord(reading.subject.subject) ? reading.subject.subject : reading.subject;
      candidates.push({
        id: isRecord(current) ? current.id : undefined,
        type: isRecord(current) ? current.type : undefined,
        collection: 'readings',
      });
    }
  }

  const publicTags = artifact.publicTags;
  const currentBindings = isRecord(publicTags) ? publicTags.currentBindings : undefined;
  const concepts = isRecord(currentBindings) ? currentBindings.concepts : undefined;
  if (reference.provider === 'vndb' && reference.namespace !== undefined && Array.isArray(concepts)) {
    for (const concept of concepts) {
      if (!isRecord(concept) || concept.taxonomy !== reference.namespace || concept.code !== reference.sourceKey)
        continue;
      candidates.push({ id: concept.id, type: concept.type, collection: 'publicTags.currentBindings.concepts' });
    }
  }
  return candidates;
}

export function resolveSeedIdentity(
  reference: SeedIdentityReference,
  artifact: unknown,
  artifactFailure?: 'artifact-missing' | 'artifact-invalid',
): SeedIdentityResolution {
  if (artifactFailure) return { status: 'unrun', reason: artifactFailure };
  const candidates = identityCandidates(reference, artifact);
  if (!candidates.length) return { status: 'unrun', reason: 'source-key-missing' };

  const identities = new Map<string, SeedIdentityCandidate>();
  for (const candidate of candidates) {
    if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string' || !candidate.id || !candidate.type)
      return { status: 'unrun', reason: 'identity-missing', collection: candidate.collection };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id))
      return { status: 'unrun', reason: 'identity-invalid', collection: candidate.collection };
    identities.set(`${candidate.id}\0${candidate.type}`, candidate);
  }
  if (identities.size > 1)
    return {
      status: 'unrun',
      reason: 'ambiguous',
      collection: [...new Set(candidates.map((candidate) => candidate.collection))].join(','),
    };
  const [candidate] = identities.values();
  if (!candidate) return { status: 'unrun', reason: 'identity-missing' };
  if (candidate.type !== reference.nativeType)
    return { status: 'unrun', reason: 'native-type-mismatch', collection: candidate.collection };
  return { status: 'resolved', subjectId: candidate.id as string, collection: candidate.collection };
}

function loadSeedArtifact(path: string): {
  artifact?: unknown;
  failure?: 'artifact-missing' | 'artifact-invalid';
} {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { failure: 'artifact-missing' };
    throw error;
  }
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return { failure: 'artifact-invalid' };
  try {
    return { artifact: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return { failure: 'artifact-invalid' };
    throw error;
  }
}

function personasOf(value: { personas?: readonly Persona[] } | undefined): readonly Persona[] {
  return value?.personas && value.personas.length > 0 ? value.personas : PERSONAS;
}

export function parseManifest(value: unknown): Manifest {
  if (!isRecord(value) || value.version !== 1) throw new Error('Manifest version must be 1');
  if (typeof value.context !== 'string' || typeof value.question !== 'string' || !Array.isArray(value.pages))
    throw new Error('Manifest is missing context, question or pages');
  for (const page of value.pages) {
    if (!isRecord(page) || typeof page.id !== 'string' || typeof page.path !== 'string')
      throw new Error('Manifest contains an invalid page');
    if ('subject' in page) throw new Error(`Manifest page ${page.id} must resolve its seeded identity`);
    const identity = page.seedIdentity;
    if (page.path.includes('{subject}') && !isRecord(identity))
      throw new Error(`Manifest page ${page.id} has a subject route without a seed identity`);
    if (identity !== undefined) {
      if (
        !isRecord(identity) ||
        (identity.provider !== 'bangumi' && identity.provider !== 'vndb') ||
        typeof identity.sourceKey !== 'string' ||
        !identity.sourceKey.trim() ||
        typeof identity.nativeType !== 'string' ||
        !identity.nativeType.trim() ||
        (identity.namespace !== undefined && (typeof identity.namespace !== 'string' || !identity.namespace.trim())) ||
        !page.path.includes('{subject}')
      )
        throw new Error(`Manifest page ${page.id} has an invalid seed identity`);
    }
  }
  return value as Manifest;
}

function loadManifest(path: string): Manifest {
  return parseManifest(JSON.parse(readFileSync(path, 'utf8')));
}

function expand(template: string, vars: Record<string, string>): string {
  return template.replaceAll(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Unknown path variable ${name}`);
    return value;
  });
}

function expandValue(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return expand(value, vars);
  if (Array.isArray(value)) return value.map((entry) => expandValue(entry, vars));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandValue(entry, vars)]));
  return value;
}

function bindSql(sql: SeedSql, vars: Record<string, string>): { text: string; values: string[] } {
  const values: string[] = [];
  for (const name of sql.params) {
    const value = vars[name];
    if (value === undefined) throw new Error(`SQL parameter ${name} is not bound`);
    values.push(value);
  }
  return { text: sql.text, values };
}

function createSeedCounter(databaseUrl: string): {
  queryCount(text: string, values: readonly string[]): Promise<number>;
  close(): Promise<void>;
} {
  const fromKernel = createRequire(resolve(ROOT, 'services/kernel/package.json'));
  const pg = fromKernel('pg') as { Pool: new (config: Record<string, unknown>) => QueryPool };
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: REQUEST_WAIT_MS,
    query_timeout: REQUEST_WAIT_MS,
    statement_timeout: REQUEST_WAIT_MS,
    application_name: 'rezics-page-data-check',
  });
  return {
    async queryCount(text, values) {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query(text, values);
        await client.query('COMMIT');
        const row = result.rows[0] as { n?: unknown } | undefined;
        const n = row?.n;
        if (typeof n === 'number' && Number.isFinite(n)) return n;
        if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) return Number(n);
        throw new Error('Seed count did not return n');
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        client.release(failure);
      }
    },
    close: () => pool.end(),
  };
}

function envFileValue(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(name.length + 1).replace(/^(['"])(.*)\1$/, '$2');
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || /timed out|timeout/i.test(error.message));
}

function displayError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

async function nativeCall(
  kernel: URL,
  call: NativeCall,
  vars: Record<string, string>,
  token: string | undefined,
  send: typeof fetch,
  timeoutMs: number,
): Promise<NativeObservation> {
  const url = new URL(expand(call.path, vars), kernel);
  if (call.query) {
    for (const [name, value] of Object.entries(call.query)) url.searchParams.set(name, expand(value, vars));
  }
  const headers: Record<string, string> = { accept: 'application/json', 'accept-language': 'en' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (call.method === 'POST') headers['content-type'] = 'application/json';
  try {
    const response = await send(
      new Request(url, {
        method: call.method,
        headers,
        ...(call.method === 'POST' ? { body: JSON.stringify(expandValue(call.body ?? {}, vars)) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return {
          status: response.status,
          body: null,
          authorized: Boolean(token),
          error: 'Native response was not valid JSON',
        };
      }
    }
    return { status: response.status, body, authorized: Boolean(token) };
  } catch (error) {
    return {
      status: 0,
      body: null,
      authorized: Boolean(token),
      error: `Native request failed: ${displayError(error)}`,
    };
  }
}

type SectionProbe = {
  present: boolean;
  itemCount: number;
  text: string;
  dataState: string | null;
  busy: boolean;
  homeMounted: boolean | null;
  homeState: string | null;
  homeBusy: boolean | null;
  document: ReaderDocumentIdentity;
};

type DocumentNavigation =
  | { responseReceived: true; status: number; error?: unknown }
  | { responseReceived: false; error: unknown };

async function navigateToDocument(page: Page, url: string, timeoutMs: number): Promise<DocumentNavigation> {
  let mainDocumentStatus: number | undefined;
  const observeResponse = (response: PlaywrightResponse) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainDocumentStatus = response.status();
    }
  };
  page.on('response', observeResponse);
  try {
    const response = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
    if (response) return { responseReceived: true, status: response.status() };
    if (mainDocumentStatus !== undefined) return { responseReceived: true, status: mainDocumentStatus };
    return {
      responseReceived: false,
      error: new Error('Navigation completed without a main document response'),
    };
  } catch (error) {
    if (mainDocumentStatus !== undefined) return { responseReceived: true, status: mainDocumentStatus, error };
    return { responseReceived: false, error };
  } finally {
    page.off('response', observeResponse);
  }
}

type MainDocumentSnapshot = { revision: number; url: string };
type AdmittedDocument = MainDocumentSnapshot & { identity: ReaderDocumentIdentity };

type PageDocumentTracker = {
  snapshot(): MainDocumentSnapshot;
  waitForChange(afterRevision: number, timeoutMs: number): Promise<MainDocumentSnapshot>;
  failure(): Error | undefined;
  dispose(): void;
};

type BrowserServerFunctionTracker = {
  reset(): void;
  snapshot(): BrowserServerFunctionObservation;
  dispose(): void;
};

/** Aggregate same-origin ServerFn transport only; opaque URLs and payloads stay private. */
function browserServerFunctionTracker(page: Page, origin: string): BrowserServerFunctionTracker {
  type RequestState = { generation: number; failed: boolean };
  let generation = 0;
  let counts: Omit<BrowserServerFunctionObservation, 'pending'> = {
    started: 0,
    responses: 0,
    settled: 0,
    failed: 0,
    truncated: false,
  };
  const requests = new Map<PlaywrightRequest, RequestState>();
  const observeRequest = (request: PlaywrightRequest) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== origin || !(url.pathname === '/_serverFn' || url.pathname.startsWith('/_serverFn/'))) return;
    if (counts.started >= 64) {
      counts.truncated = true;
      return;
    }
    counts.started++;
    requests.set(request, { generation, failed: false });
  };
  const observeResponse = (response: PlaywrightResponse) => {
    const state = requests.get(response.request());
    if (!state || state.generation !== generation) return;
    counts.responses++;
    if (response.status() >= 400) {
      counts.failed++;
      state.failed = true;
    }
  };
  const finishRequest = (request: PlaywrightRequest, transportFailed: boolean) => {
    const state = requests.get(request);
    if (!state) return;
    requests.delete(request);
    if (state.generation !== generation) return;
    counts.settled++;
    if (transportFailed && !state.failed) counts.failed++;
  };
  const observeFinished = (request: PlaywrightRequest) => finishRequest(request, false);
  const observeFailed = (request: PlaywrightRequest) => finishRequest(request, true);
  page.on('request', observeRequest);
  page.on('response', observeResponse);
  page.on('requestfinished', observeFinished);
  page.on('requestfailed', observeFailed);
  return {
    reset() {
      generation++;
      counts = { started: 0, responses: 0, settled: 0, failed: 0, truncated: false };
      requests.clear();
    },
    snapshot: () => ({ ...counts, pending: requests.size }),
    dispose() {
      page.off('request', observeRequest);
      page.off('response', observeResponse);
      page.off('requestfinished', observeFinished);
      page.off('requestfailed', observeFailed);
      requests.clear();
    },
  };
}

function pageDocumentTracker(page: Page): PageDocumentTracker {
  let revision = 0;
  let terminalError: Error | undefined;
  const waiters = new Set<{
    afterRevision: number;
    resolve(snapshot: MainDocumentSnapshot): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const snapshot = (): MainDocumentSnapshot => ({ revision, url: page.mainFrame().url() });
  const rejectWaiters = (error: Error) => {
    terminalError ??= error;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(terminalError);
    }
    waiters.clear();
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    revision++;
    const current = snapshot();
    for (const waiter of waiters) {
      if (revision <= waiter.afterRevision) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(current);
      waiters.delete(waiter);
    }
  };
  const onCrash = () => rejectWaiters(new Error('Target crashed'));
  const onClose = () => rejectWaiters(new Error('Target page, context or browser has been closed'));
  page.on('framenavigated', onFrameNavigated);
  page.on('crash', onCrash);
  page.on('close', onClose);

  return {
    snapshot,
    waitForChange(afterRevision, timeoutMs) {
      if (terminalError) return Promise.reject(terminalError);
      const current = snapshot();
      if (current.revision > afterRevision) return Promise.resolve(current);
      if (timeoutMs <= 0) {
        const error = new Error('Timed out waiting for a current document navigation');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          afterRevision,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            const error = new Error('Timed out waiting for a current document navigation');
            error.name = 'TimeoutError';
            reject(error);
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    failure: () => terminalError,
    dispose() {
      page.off('framenavigated', onFrameNavigated);
      page.off('crash', onCrash);
      page.off('close', onClose);
      const error = new Error('Page document tracking ended');
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiters.clear();
    },
  };
}

function isExecutionContextReplacement(error: unknown): boolean {
  return (
    error instanceof Error &&
    /execution context was destroyed|cannot find context with specified id|context.*destroyed/i.test(error.message)
  );
}

function readerFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/target crashed/i.test(message)) return 'target-crashed';
  if (/target page, context or browser has been closed|target.*closed|page.*closed/i.test(message))
    return 'target-lost';
  if (/execution context replacement did not settle/i.test(message)) return 'document-context-replaced';
  if (isExecutionContextReplacement(error)) return 'document-context-replaced';
  return redact(message);
}

async function captureAdmittedDocument(
  page: Page,
  tracker: PageDocumentTracker,
  afterRevision: number,
  requestedUrl: string | undefined,
  deadline: number,
): Promise<AdmittedDocument> {
  let current = tracker.snapshot();
  let contextReplaced = false;
  while (remainingUntil(deadline) > 0) {
    const terminal = tracker.failure();
    if (terminal) throw terminal;
    const redirectDestinationRequired = requestedUrl !== undefined;
    const ready =
      current.revision > afterRevision &&
      current.url !== 'about:blank' &&
      (!redirectDestinationRequired || current.url !== requestedUrl);
    if (!ready) {
      try {
        current = await tracker.waitForChange(current.revision, remainingUntil(deadline));
      } catch (error) {
        if (!contextReplaced || !isTimeout(error)) throw error;
        const recoveryError = new Error(
          'Execution context replacement did not settle before the shared reader deadline',
        );
        recoveryError.name = 'TimeoutError';
        throw recoveryError;
      }
      continue;
    }
    try {
      const raw = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin }));
      const after = tracker.snapshot();
      if (after.revision !== current.revision || after.url !== current.url || raw.url !== current.url) {
        current = after;
        continue;
      }
      const parsed = new URL(raw.url);
      return {
        ...after,
        identity: { url: `${parsed.origin}${parsed.pathname}`, timeOrigin: raw.timeOrigin },
      };
    } catch (error) {
      if (!isExecutionContextReplacement(error)) throw error;
      contextReplaced = true;
      const latest = tracker.snapshot();
      if (latest.revision > current.revision) {
        current = latest;
      } else {
        try {
          current = await tracker.waitForChange(current.revision, remainingUntil(deadline));
        } catch (waitError) {
          if (!isTimeout(waitError)) throw waitError;
          const recoveryError = new Error(
            'Execution context replacement did not settle before the shared reader deadline',
          );
          recoveryError.name = 'TimeoutError';
          throw recoveryError;
        }
      }
    }
  }
  const error = new Error(
    contextReplaced
      ? 'Execution context replacement did not settle before the shared reader deadline'
      : 'Current document did not settle before the shared reader deadline',
  );
  error.name = 'TimeoutError';
  throw error;
}

async function navigateToReaderDocument(
  page: Page,
  tracker: PageDocumentTracker,
  url: string,
  pageTimeoutMs: number,
  readerTimeoutMs: number,
): Promise<{
  responseReceived: boolean;
  status?: number;
  document?: AdmittedDocument;
  error?: unknown;
  reason?: string;
  readerDeadline: number;
}> {
  const before = tracker.snapshot();
  const navigation = await navigateToDocument(page, url, pageTimeoutMs);
  const readerDeadline = performance.now() + readerTimeoutMs;
  if (!navigation.responseReceived) return { ...navigation, readerDeadline };
  const redirect = navigation.status >= 300 && navigation.status < 400;
  try {
    const document = await captureAdmittedDocument(
      page,
      tracker,
      before.revision,
      redirect ? url : undefined,
      readerDeadline,
    );
    return {
      responseReceived: true,
      status: navigation.status,
      document,
      ...('error' in navigation ? { error: navigation.error } : {}),
      readerDeadline,
    };
  } catch (error) {
    const reason = readerFailureReason(error);
    return {
      responseReceived: true,
      status: navigation.status,
      error: 'error' in navigation ? navigation.error : error,
      reason:
        reason === 'target-crashed' || reason === 'target-lost' ? reason : redirect ? 'redirect-not-settled' : reason,
      readerDeadline,
    };
  }
}

function remainingUntil(deadline: number): number {
  return Math.max(0, Math.ceil(deadline - performance.now()));
}

async function observeSection(
  page: Page,
  tracker: PageDocumentTracker,
  section: ManifestSection,
  readerDeadline: number,
  admitted: AdmittedDocument,
): Promise<{ observation: PageObservation; timedOut: boolean; readinessReason?: string }> {
  let currentDocument = admitted;
  while (true) {
    const timeoutMs = remainingUntil(readerDeadline);
    if (timeoutMs === 0) {
      return {
        observation: {
          present: false,
          itemCount: 0,
          text: '',
          dataState: null,
          busy: true,
          homeMounted: null,
          homeState: null,
          homeBusy: null,
        },
        timedOut: true,
        readinessReason: 'shared-reader-deadline-elapsed',
      };
    }
    try {
      const current = tracker.snapshot();
      if (current.revision !== currentDocument.revision || current.url !== currentDocument.url) {
        currentDocument = await captureAdmittedDocument(
          page,
          tracker,
          currentDocument.revision,
          undefined,
          readerDeadline,
        );
      }
      let timedOut = false;
      try {
        await page.waitForFunction(
          ({ selector, heading }) => {
            const loading = (element: HTMLElement): boolean => {
              if (
                element.getAttribute('aria-busy') === 'true' ||
                element.getAttribute('data-state') === 'loading' ||
                element.getAttribute('data-feed-result-state') === 'loading' ||
                /\b(loading|preparing)\b/i.test(element.innerText ?? element.textContent ?? '')
              )
                return true;
              return [
                ...element.querySelectorAll<HTMLElement>(
                  '[aria-busy="true"],[data-state="loading"],[data-feed-result-state="loading"],[role="status"],[aria-live]',
                ),
              ].some(
                (child) =>
                  child.getAttribute('aria-busy') === 'true' ||
                  child.getAttribute('data-state') === 'loading' ||
                  child.getAttribute('data-feed-result-state') === 'loading' ||
                  /\b(loading|preparing)\b/i.test(child.innerText ?? child.textContent ?? ''),
              );
            };
            const titleOf = (element: HTMLElement): string => {
              const labelledBy = element
                .getAttribute('aria-labelledby')
                ?.split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
                .filter(Boolean)
                .join(' ')
                .trim();
              if (labelledBy) return labelledBy;
              const label = element.getAttribute('aria-label')?.trim();
              if (label) return label;
              const headingNode = element.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]');
              if (headingNode?.textContent?.trim()) return headingNode.textContent.trim();
              return element.matches('a[href],button,[role="link"],[role="button"]')
                ? (element.textContent?.trim() ?? '')
                : '';
            };
            const matches = [...document.querySelectorAll<HTMLElement>(selector)];
            const wanted = heading?.trim().toLocaleLowerCase();
            const node =
              wanted === undefined
                ? matches[0]
                : matches.find((element) => titleOf(element).toLocaleLowerCase().includes(wanted));
            return node !== undefined && !loading(node);
          },
          { selector: section.selector, heading: section.heading },
          { timeout: timeoutMs },
        );
      } catch (error) {
        if (!isTimeout(error)) throw error;
        timedOut = true;
      }
      const observation = await page.evaluate(
        ({ selector, heading, itemSelector, timedOut }) => {
          const loading = (element: HTMLElement): boolean => {
            if (
              element.getAttribute('aria-busy') === 'true' ||
              element.getAttribute('data-state') === 'loading' ||
              element.getAttribute('data-feed-result-state') === 'loading' ||
              /\b(loading|preparing)\b/i.test(element.innerText ?? element.textContent ?? '')
            )
              return true;
            return [
              ...element.querySelectorAll<HTMLElement>(
                '[aria-busy="true"],[data-state="loading"],[data-feed-result-state="loading"],[role="status"],[aria-live]',
              ),
            ].some(
              (child) =>
                child.getAttribute('aria-busy') === 'true' ||
                child.getAttribute('data-state') === 'loading' ||
                child.getAttribute('data-feed-result-state') === 'loading' ||
                /\b(loading|preparing)\b/i.test(child.innerText ?? child.textContent ?? ''),
            );
          };
          const titleOf = (element: HTMLElement): string => {
            const labelledBy = element
              .getAttribute('aria-labelledby')
              ?.split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
              .filter(Boolean)
              .join(' ')
              .trim();
            if (labelledBy) return labelledBy;
            const label = element.getAttribute('aria-label')?.trim();
            if (label) return label;
            const headingNode = element.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]');
            if (headingNode?.textContent?.trim()) return headingNode.textContent.trim();
            return element.matches('a[href],button,[role="link"],[role="button"]')
              ? (element.textContent?.trim() ?? '')
              : '';
          };
          const matches = [...document.querySelectorAll<HTMLElement>(selector)];
          const wanted = heading?.trim().toLocaleLowerCase();
          const node =
            wanted === undefined
              ? matches[0]
              : matches.find((element) => titleOf(element).toLocaleLowerCase().includes(wanted));
          const documentUrl = new URL(location.href);
          const documentIdentity = {
            url: `${documentUrl.origin}${documentUrl.pathname}`,
            timeOrigin: performance.timeOrigin,
          };
          const home = document.querySelector<HTMLElement>('[data-home-feed-mounted]');
          const homeMounted = home ? home.getAttribute('data-home-feed-mounted') === 'true' : null;
          const homeState = home?.getAttribute('data-home-feed-state') ?? null;
          const homeBusy = home ? home.getAttribute('aria-busy') === 'true' : null;
          if (!node)
            return {
              present: false,
              itemCount: 0,
              text: '',
              dataState: null,
              busy: true,
              homeMounted,
              homeState,
              homeBusy,
              documentIdentity,
              documentHref: location.href,
            };
          const items = itemSelector
            ? Number(node.matches(itemSelector)) + node.querySelectorAll(itemSelector).length
            : 0;
          const unsettled = loading(node);
          return {
            present: true,
            itemCount: items,
            text: (node.innerText ?? node.textContent ?? '').slice(0, 4000),
            dataState: node.getAttribute('data-state') ?? node.getAttribute('data-feed-result-state'),
            busy: timedOut || unsettled,
            homeMounted,
            homeState,
            homeBusy,
            documentIdentity,
            documentHref: location.href,
          };
        },
        { selector: section.selector, heading: section.heading, itemSelector: section.itemSelector, timedOut },
      );
      const after = tracker.snapshot();
      if (
        after.revision !== currentDocument.revision ||
        after.url !== currentDocument.url ||
        observation.documentHref !== after.url
      ) {
        currentDocument = await captureAdmittedDocument(
          page,
          tracker,
          currentDocument.revision,
          undefined,
          readerDeadline,
        );
        continue;
      }
      const finalObservation: SectionProbe = {
        present: observation.present,
        itemCount: observation.itemCount,
        text: observation.text,
        dataState: observation.dataState,
        busy: observation.busy,
        homeMounted: observation.homeMounted,
        homeState: observation.homeState,
        homeBusy: observation.homeBusy,
        document: observation.documentIdentity,
      };
      return {
        observation: finalObservation,
        timedOut,
        ...(timedOut
          ? {
              readinessReason: finalObservation.present
                ? 'reader-remained-loading'
                : finalObservation.homeMounted === true
                  ? 'reader-selector-not-found'
                  : finalObservation.homeMounted === false
                    ? 'home-mount-notification-unobserved'
                    : 'reader-mount-or-selector-unobserved',
            }
          : {}),
      };
    } catch (error) {
      if (!isExecutionContextReplacement(error)) throw error;
      currentDocument = await captureAdmittedDocument(
        page,
        tracker,
        currentDocument.revision,
        undefined,
        readerDeadline,
      );
    }
  }
}

async function clickSectionAction(
  page: Page,
  action: NonNullable<NativeCall['action']>,
  timeoutMs: number,
): Promise<void> {
  await page.getByRole(action.role, { name: action.name, exact: true }).click({ timeout: timeoutMs });
}

export function signInRequestBody(
  email: string,
  password: string,
): {
  email: string;
  password: string;
  client_id: 'login';
  scope: [];
} {
  return { email, password, client_id: 'login', scope: [] };
}

/** Read scopes of the four retained member probes, including the feed's personal inputs. */
export function memberReadScopes(call: NativeCall): readonly string[] {
  if (call.method !== 'GET') return [];
  if (call.path === '/v1/feedItems')
    return call.query?.stream === 'following'
      ? ['feed_item:list', 'follow:list']
      : ['feed_item:list', 'follow:list', 'library_entry:list', 'progress_session:list'];
  if (call.path === '/v1/follows') return ['follow:list'];
  if (call.path === '/v1/libraryEntries') return ['library_entry:list'];
  return [];
}

/** Scope preflight is diagnostic only; Kernel still verifies the bearer and current authority. */
function coversMemberRead(token: string | undefined, scopes: readonly string[]): boolean {
  if (!token) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    if (!isRecord(claims) || typeof claims.scope !== 'string') return false;
    const held = new Set(claims.scope.split(' '));
    return scopes.every((scope) => held.has(scope));
  } catch {
    return false;
  }
}

async function memberCookieFromAuth(signIn: NonNullable<RunOptions['signIn']>, send: typeof fetch): Promise<string> {
  const origin = publicOrigin(signIn.origin, 'auth origin');
  const response = await send(
    new Request(new URL('/signin', origin), {
      method: 'POST',
      headers: { origin: origin.origin, 'content-type': 'application/json' },
      body: JSON.stringify(signInRequestBody(signIn.email, signIn.password)),
      signal: AbortSignal.timeout(REQUEST_WAIT_MS),
    }),
  );
  if (!response.ok) throw new Error(`Member sign-in failed: ${response.status}`);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function readAccessToken(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Member token failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.access_token !== 'string' || body.access_token.length === 0)
    throw new Error('Member token response had no access token');
  return body.access_token;
}

async function memberTokenFromAuth(signIn: NonNullable<RunOptions['signIn']>, send: typeof fetch): Promise<string> {
  const origin = publicOrigin(signIn.origin, 'auth origin');
  const cookie = await memberCookieFromAuth(signIn, send);
  return readAccessToken(
    await send(
      new Request(new URL('/token', origin), {
        method: 'POST',
        headers: { origin: origin.origin, 'content-type': 'application/json', cookie },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_WAIT_MS),
      }),
    ),
  );
}

/** Consume the installed Website registration; never register a client or widen consent here. */
async function memberWebsiteToken(
  signIn: NonNullable<RunOptions['signIn']>,
  base: URL,
  scopes: readonly string[],
  send: typeof fetch,
): Promise<string> {
  const origin = publicOrigin(signIn.origin, 'auth origin');
  const website = signIn.website!;
  const client = 'rezics-website';
  const redirect = new URL('/auth/callback', base).href;
  const verifier = randomBytes(48).toString('base64url');
  const state = randomUUID();
  const authorize = new URL('/authorize', origin);
  authorize.search = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    response_type: 'code',
    // The Website owner requires its OIDC protocol scopes in addition to the selected API reads.
    scope: ['openid', 'offline_access', ...scopes].join(' '),
    state,
    nonce: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: website.resource,
  }).toString();
  const cookie = await memberCookieFromAuth(signIn, send);
  const response = await send(
    new Request(authorize, {
      headers: { origin: origin.origin, cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_WAIT_MS),
    }),
  );
  // Do not follow login, consent or registration redirects, or expose their parameters.
  let location: string | null;
  if ([302, 303].includes(response.status)) location = response.headers.get('location');
  else if (response.status === 200) {
    // The native Website owner can describe the redirect without navigating it.
    const redirect: unknown = await response.json();
    location =
      isRecord(redirect) && redirect.redirect === true && typeof redirect.url === 'string' ? redirect.url : null;
  } else throw new Error(`Member Website authorization failed: ${response.status}`);
  if (!location) throw new Error('Member Website authorization omitted callback');
  const callback = new URL(location, origin);
  if (
    callback.origin !== base.origin ||
    callback.pathname !== '/auth/callback' ||
    callback.searchParams.get('state') !== state ||
    !callback.searchParams.get('code')
  )
    throw new Error('Member Website authorization requires an approved callback and current consent');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: website.key.kid })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: client,
      sub: client,
      aud: origin.origin,
      iat: now,
      exp: now + 120,
      jti: randomUUID(),
    }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const key = createPrivateKey({ key: website.key, format: 'jwk' });
  const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  return readAccessToken(
    await send(
      new Request(new URL('/token', origin), {
        method: 'POST',
        headers: { origin: origin.origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
          resource: website.resource,
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code')!,
          redirect_uri: redirect,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(REQUEST_WAIT_MS),
      }),
    ),
  );
}

export type BrowserSignInPhase = 'response/redirect' | 'issuer-document' | 'interactive-form' | 'callback' | 'session';

/** A document lifecycle event is not proof that the form or the returned session is ready. */
export async function signInBrowser(
  page: Page,
  base: URL,
  signIn: { origin: string; email: string; password: string },
  timeoutMs: number,
  report: (message: string) => void = () => {},
): Promise<void> {
  const issuer = publicOrigin(signIn.origin, 'auth origin');
  let phase: BrowserSignInPhase = 'response/redirect';
  let lastDocument = 'none';
  let callbackStatus: number | undefined;
  let sessionStep: 'document' | 'cookie' | 'control' = 'document';
  type BootKind = 'script' | 'server-function';
  const boot = { script: { started: 0, failed: 0 }, 'server-function': { started: 0, failed: 0 } };
  const pending = new Map<PlaywrightRequest, { kind: BootKind; failed: boolean }>();
  let truncated = false;
  let clientErrors = 0;
  const observeBoot = () => phase === 'callback' || phase === 'session';
  const observeRequest = (request: PlaywrightRequest) => {
    if (!observeBoot()) return;
    const url = new URL(request.url());
    if (url.origin !== base.origin) return;
    const kind = url.pathname.startsWith('/_serverFn/')
      ? 'server-function'
      : request.resourceType() === 'script'
        ? 'script'
        : null;
    if (!kind) return;
    if (pending.size >= 64) {
      truncated = true;
      return;
    }
    boot[kind].started++;
    pending.set(request, { kind, failed: false });
  };
  const finishRequest = (request: PlaywrightRequest, transportFailed: boolean) => {
    const observed = pending.get(request);
    if (!observed) return;
    if (observed.failed || transportFailed) boot[observed.kind].failed++;
    pending.delete(request);
  };
  const observeFinished = (request: PlaywrightRequest) => finishRequest(request, false);
  const observeFailed = (request: PlaywrightRequest) => finishRequest(request, true);
  const observeClientError = () => {
    if (observeBoot()) clientErrors++;
  };
  const observeResponse = (response: PlaywrightResponse) => {
    const request = response.request();
    const observed = pending.get(request);
    if (observed && response.status() >= 400) observed.failed = true;
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    const url = new URL(response.url());
    // Omit query strings: authorization redirects contain state, codes and other private operands.
    lastDocument = `${response.status()} ${url.origin}${url.pathname}`;
    report(`Member browser sign-in phase=${phase} document=${lastDocument}`);
    if (url.origin === base.origin && url.pathname === '/auth/callback') callbackStatus = response.status();
    if (phase === 'response/redirect' && response.status() >= 300 && response.status() < 400) phase = 'issuer-document';
  };
  page.on('response', observeResponse);
  page.on('request', observeRequest);
  page.on('requestfinished', observeFinished);
  page.on('requestfailed', observeFailed);
  page.on('pageerror', observeClientError);
  try {
    const navigation = await navigateToDocument(page, new URL('/auth/sign-in', base).href, timeoutMs);
    if (!navigation.responseReceived) throw navigation.error;
    phase = new URL(page.url()).origin === issuer.origin ? 'issuer-document' : phase;
    if (navigation.status >= 400) throw new Error('Sign-in document refused');
    if ('error' in navigation)
      report(`Member browser sign-in navigation incomplete after document response status=${navigation.status}`);
    phase = 'issuer-document';
    await page.waitForURL((url) => url.origin === issuer.origin, { waitUntil: 'commit', timeout: timeoutMs });

    report('Member browser sign-in phase=issuer-document committed');
    phase = 'interactive-form';
    const readerDeadline = performance.now() + timeoutMs;
    const email = page.getByLabel(/email/i);
    const password = page.locator('input[name="password"]');
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    const remaining = () => {
      const ms = remainingUntil(readerDeadline);
      if (ms === 0) throw new Error('Sign-in form readiness timed out');
      return ms;
    };
    await email.waitFor({ state: 'visible', timeout: remaining() });
    await password.waitFor({ state: 'visible', timeout: remaining() });
    await submit.waitFor({ state: 'visible', timeout: remaining() });
    await email.fill(signIn.email, { timeout: remaining() });
    await password.fill(signIn.password, { timeout: remaining() });

    report('Member browser sign-in phase=interactive-form ready');
    phase = 'callback';
    // Click actionability still checks the visible control; the explicit URL wait owns navigation readiness.
    await submit.click({ timeout: remaining(), noWaitAfter: true });
    await page.waitForURL((url) => url.origin === base.origin, { waitUntil: 'commit', timeout: timeoutMs });
    if (callbackStatus === undefined || callbackStatus < 300 || callbackStatus >= 400)
      throw new Error('Successful Web callback redirect not observed');

    report('Member browser sign-in phase=callback accepted');
    phase = 'session';
    await page.waitForURL((url) => url.origin === base.origin && !url.pathname.startsWith('/auth/'), {
      waitUntil: 'commit',
      timeout: timeoutMs,
    });
    // The cookie alone does not prove that Web accepts the session. The account control reads actual session state.
    sessionStep = 'cookie';
    const cookies = await page.context().cookies(base.href);
    if (!cookies.some((cookie) => cookie.name === '__Host-rezics_session' && cookie.value))
      throw new Error('Web session cookie missing');
    sessionStep = 'control';
    await page.locator('#account-menu-button').waitFor({ state: 'visible', timeout: timeoutMs });
    report('Member browser sign-in phase=session verified');
  } catch (error) {
    if (phase === 'session') {
      const hydrated = await page
        .locator('html')
        .getAttribute('data-hydrated', { timeout: 250 })
        .then(
          (marker) => (marker === null ? 'no' : 'yes'),
          () => 'unknown',
        );
      const counts = (kind: BootKind) => {
        const outstanding = [...pending.values()].filter((request) => request.kind === kind).length;
        return `${kind}=${boot[kind].started} started/${boot[kind].failed} failed/${outstanding} pending`;
      };
      // Server functions are aggregate transport evidence; their opaque IDs do not identify the session read.
      report(
        `Member browser sign-in observation step=${sessionStep} hydrated=${hydrated}; ${counts('script')}; ${counts('server-function')}; client-errors=${clientErrors}; truncated=${truncated}`,
      );
    }
    // Playwright errors can embed redirect query strings; keep only the phase and observed public document address.
    throw new Error(
      `Member browser sign-in failed phase=${phase}; last document=${lastDocument}; cause=${isTimeout(error) ? 'timeout' : 'error'}`,
      { cause: error },
    );
  } finally {
    page.off('response', observeResponse);
    page.off('request', observeRequest);
    page.off('requestfinished', observeFinished);
    page.off('requestfailed', observeFailed);
    page.off('pageerror', observeClientError);
  }
}

function localSignIn(): RunOptions['signIn'] {
  if (!existsSync(LOCAL_KEYS)) return undefined;
  const keys: unknown = JSON.parse(readFileSync(LOCAL_KEYS, 'utf8'));
  if (!isRecord(keys) || typeof keys.password !== 'string' || keys.password.length === 0) return undefined;
  return {
    origin: process.env.AUTH_ORIGIN?.trim() || DEFAULT_AUTH_ORIGIN,
    email: MEMBER_EMAIL,
    password: keys.password,
    ...(isRecord(keys.website)
      ? {
          website: {
            key: keys.website as JsonWebKey,
            resource:
              process.env.AUTH_AUDIENCE ??
              envFileValue(DEFAULT_KERNEL_ENV, 'AUTH_AUDIENCE') ??
              'https://api.rezics.test',
          },
        }
      : {}),
  };
}

export async function runPageDataCheck(options: RunOptions): Promise<{
  results: SectionResult[];
  defects: number;
  incomplete: boolean;
  diagnostics: string[];
}> {
  const base = publicOrigin(options.baseUrl, 'base URL');
  const kernel = publicOrigin(options.kernel, 'kernel URL');
  const send = options.fetch ?? fetch;
  const pageTimeout = options.pageTimeoutMs ?? PAGE_WAIT_MS;
  const readerTimeout = options.readerTimeoutMs ?? READER_WAIT_MS;
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_WAIT_MS;
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const diagnostics: string[] = [];
  let incomplete = false;
  const report = (message: string) => {
    const line = redact(message);
    diagnostics.push(line);
    err.write(`${line}\n`);
  };
  const artifactSource = options.seedArtifactSource ?? '../page-data-stack/.temp/cross-media-seed/result.json';
  const artifactFailure =
    options.seedArtifactFailure ?? (options.seedArtifact === undefined ? 'artifact-missing' : undefined);
  const seedIdentities = new Map(
    options.manifest.pages.flatMap((page) =>
      page.seedIdentity
        ? [[page.id, resolveSeedIdentity(page.seedIdentity, options.seedArtifact, artifactFailure)] as const]
        : [],
    ),
  );
  const pagesFor = (persona: Persona) =>
    options.manifest.pages.filter(
      (entry) =>
        personasOf(entry).includes(persona) && entry.sections.some((section) => personasOf(section).includes(persona)),
    );
  let token = options.memberToken;
  const signIn = options.signIn;
  const memberCalls = pagesFor('member').flatMap((page) =>
    page.sections.filter((section) => personasOf(section).includes('member')).map((section) => section.native),
  );
  const readScopes = [...new Set(memberCalls.flatMap(memberReadScopes))].sort();
  let readToken = options.memberToken;
  if (!readToken && signIn?.website && readScopes.length) {
    try {
      readToken = await memberWebsiteToken(signIn, base, readScopes, send);
    } catch {
      // Issuer/transport/key failures may contain credentials. Keep this diagnostic fixed.
      report('Member read authority unavailable: existing Website registration, key or consent could not be used');
    }
  }
  if (!token && signIn && memberCalls.some((call) => memberReadScopes(call).length === 0)) {
    try {
      token = await memberTokenFromAuth(signIn, send);
    } catch (error) {
      incomplete = true;
      report(`Member native authentication unavailable: ${displayError(error)}`);
    }
  }

  const ownedBrowser = options.browser === undefined;
  let browser = options.browser;
  if (!browser) {
    try {
      browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    } catch (error) {
      incomplete = true;
      report(`Browser unavailable: ${displayError(error)}`);
    }
  }
  const close = async (label: string, resource: { close(): Promise<void> } | undefined) => {
    try {
      await resource?.close();
    } catch (error) {
      incomplete = true;
      report(`${label} cleanup failed: ${displayError(error)}`);
    }
  };
  const unread = (): PageObservation => ({
    present: false,
    itemCount: 0,
    text: '',
    dataState: null,
    busy: true,
    homeMounted: null,
    homeState: null,
    homeBusy: null,
  });
  const results: SectionResult[] = [];
  let seedCounter: ReturnType<typeof createSeedCounter> | undefined;
  try {
    try {
      seedCounter = !options.queryCount && options.databaseUrl ? createSeedCounter(options.databaseUrl) : undefined;
    } catch (error) {
      incomplete = true;
      report(`SQL counter unavailable: ${displayError(error)}`);
    }
    const queryCount = options.queryCount ?? seedCounter?.queryCount;
    let sqlInfrastructureFailure: string | undefined;
    for (const persona of PERSONAS) {
      const pages = pagesFor(persona);
      if (!pages.length) continue;
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let documentTracker: PageDocumentTracker | undefined;
      let serverFunctionTracker: BrowserServerFunctionTracker | undefined;
      try {
        // Native authorization and browser sign-in are independent prerequisites.
        if (browser && (persona === 'anonymous' || options.memberStorageState || signIn)) {
          try {
            context = await browser.newContext({
              locale: 'en-US',
              ...(persona === 'member' && options.memberStorageState
                ? { storageState: options.memberStorageState }
                : {}),
            });
            page = await context.newPage();
            if (persona === 'member' && signIn && !options.memberStorageState)
              await signInBrowser(page, base, signIn, pageTimeout, report);
            documentTracker = pageDocumentTracker(page);
            serverFunctionTracker = browserServerFunctionTracker(page, base.origin);
          } catch (error) {
            incomplete = true;
            report(`${persona} browser setup unavailable: ${displayError(error)}`);
            await close(`${persona} setup page`, page);
            page = undefined;
          }
        }
        if (!page) {
          incomplete = true;
          report(`${persona} browser probes unrun: authenticated browser or browser setup unavailable`);
        }
        if (persona === 'member' && !token && memberCalls.some((call) => memberReadScopes(call).length === 0)) {
          incomplete = true;
          report('Member native probes unrun: no member token');
        }
        for (const manifestPage of pages) {
          const sections = manifestPage.sections.filter((section) => personasOf(section).includes(persona));
          if (sections.length === 0) continue;
          serverFunctionTracker?.reset();
          const identity = seedIdentities.get(manifestPage.id);
          if (identity?.status === 'unrun') {
            incomplete = true;
            for (const section of sections) {
              const reference = manifestPage.seedIdentity!;
              const sqlProbe = section.sql ? 'unrun' : 'not-declared';
              const unrun: UnrunProbeEvidence = {
                version: 1,
                provider: reference.provider,
                sourceKey: reference.sourceKey,
                nativeType: reference.nativeType,
                ...(reference.namespace ? { namespace: reference.namespace } : {}),
                artifact: artifactSource,
                ...(identity.collection ? { collection: identity.collection } : {}),
                reason: identity.reason,
                probes: { web: 'unrun', native: 'unrun', sql: sqlProbe },
              };
              const result: SectionResult = {
                page: manifestPage.id,
                persona,
                section: section.id,
                name: section.name,
                class: 'UNAVAILABLE',
                evidence: {
                  nativeStatus: 0,
                  nativeItems: 0,
                  pageItems: 0,
                  reader: 'unavailable',
                  seedCount: null,
                  seedExpected: section.sql !== undefined,
                  nativeProbe: 'unrun',
                  browserProbe: 'unrun',
                  sqlProbe,
                  browserServerFunctions: {
                    started: 0,
                    responses: 0,
                    settled: 0,
                    failed: 0,
                    pending: 0,
                    truncated: false,
                  },
                  action: section.native.action ? 'not-started' : 'not-required',
                  homeMounted: null,
                  homeState: null,
                  homeBusy: null,
                  unrun,
                },
              };
              report(
                `Probes unrun ${manifestPage.id} ${persona} ${section.id}: provider=${reference.provider} sourceKey=${reference.sourceKey} expectedType=${reference.nativeType} artifact=${artifactSource} collection=${identity.collection ?? 'unavailable'} reason=${identity.reason}; web=unrun native=unrun sql=${sqlProbe}`,
              );
              results.push(result);
              out.write(`${formatLine(result)}\n`);
            }
            continue;
          }
          const subject = identity?.status === 'resolved' ? identity.subjectId : '';
          let readerDeadline = performance.now() + readerTimeout;
          let navigationFailed = !page || !documentTracker;
          let admittedDocument: AdmittedDocument | undefined;
          if (page && documentTracker) {
            const route = expand(manifestPage.path, { subject });
            const navigation = await navigateToReaderDocument(
              page,
              documentTracker,
              new URL(route, base).href,
              pageTimeout,
              readerTimeout,
            );
            readerDeadline = navigation.readerDeadline;
            admittedDocument = navigation.document;
            navigationFailed = !admittedDocument;
            if (navigationFailed && 'error' in navigation) {
              incomplete = true;
              const outcome = isTimeout(navigation.error) ? 'timed out' : 'failed';
              if (navigation.responseReceived) {
                report(
                  `Page navigation ${outcome} after document response status=${navigation.status} for ${manifestPage.id} ${persona}; reason=${navigation.reason ?? 'current-document-not-admitted'}; browser probes unrun: ${displayError(navigation.error)}`,
                );
              } else {
                report(
                  `Page navigation ${outcome} before document response for ${manifestPage.id} ${persona}; reason=${readerFailureReason(navigation.error)}; browser probes unrun: ${displayError(navigation.error)}`,
                );
              }
            } else if ('error' in navigation) {
              report(
                `Page navigation recovered after document response status=${navigation.status} for ${manifestPage.id} ${persona}; current document admitted`,
              );
            }
          }

          const evaluateSection = async (section: ManifestSection): Promise<SectionResult> => {
            const vars: Record<string, string> = {
              subject,
              GLOBAL: options.manifest.context,
              QUESTION: options.manifest.question,
              context: options.manifest.context,
              question: options.manifest.question,
              place: options.manifest.context,
              ...(section.property ? { property: section.property } : {}),
              ...(section.kind ? { kind: section.kind } : {}),
            };
            vars.filter = section.native.query?.filter ? expand(section.native.query.filter, vars) : NIL_UUID;
            let browserProbe: 'run' | 'unrun' = navigationFailed ? 'unrun' : 'run';
            let action: SectionResult['evidence']['action'] = section.native.action ? 'not-started' : 'not-required';
            let readFailure: string | undefined;
            const readSection = async (): Promise<{
              observation: PageObservation;
              timedOut: boolean;
              readinessReason?: string;
            }> => {
              if (!page || !documentTracker || navigationFailed || !admittedDocument)
                return { observation: unread(), timedOut: false };
              try {
                if (section.native.action) {
                  const actionTimeout = remainingUntil(readerDeadline);
                  if (actionTimeout === 0) throw new Error('Reader readiness deadline elapsed before section action');
                  action = 'started';
                  await clickSectionAction(page, section.native.action, actionTimeout);
                  action = 'settled';
                }
                return await observeSection(page, documentTracker, section, readerDeadline, admittedDocument);
              } catch (error) {
                incomplete = true;
                browserProbe = 'unrun';
                if (action === 'started') action = 'failed';
                readFailure = displayError(error);
                return { observation: unread(), timedOut: false };
              }
            };
            const requiredScopes = persona === 'member' ? memberReadScopes(section.native) : [];
            const scopedRead = requiredScopes.length > 0;
            const nativeToken = scopedRead ? readToken : token;
            const authorityMissing =
              persona === 'member' && (scopedRead ? !coversMemberRead(nativeToken, requiredScopes) : !nativeToken);
            if (authorityMissing) {
              incomplete = true;
              if (scopedRead)
                report(
                  `Member native read unrun ${manifestPage.id} ${section.id}: member-authority-unavailable; required scopes=${requiredScopes.join(',')}`,
                );
            }
            const [native, read] = await Promise.all([
              authorityMissing
                ? Promise.resolve(undefined)
                : nativeCall(
                    kernel,
                    section.native,
                    vars,
                    persona === 'member' ? nativeToken : undefined,
                    send,
                    requestTimeout,
                  ),
              readSection(),
            ]);
            const browserServerFunctions = serverFunctionTracker?.snapshot() ?? {
              started: 0,
              responses: 0,
              settled: 0,
              failed: 0,
              pending: 0,
              truncated: false,
            };
            let seedCount: number | null = null;
            let sqlProbe: 'run' | 'unrun' | 'not-declared' = section.sql ? 'unrun' : 'not-declared';
            if (section.sql) {
              const bound = bindSql(section.sql, vars);
              if (!queryCount) {
                incomplete = true;
                report(`SQL seed count unavailable for ${manifestPage.id} ${persona} ${section.id}: no database URL`);
              } else if (sqlInfrastructureFailure) {
                incomplete = true;
                report(
                  `SQL seed count not retried for ${manifestPage.id} ${persona} ${section.id}: ${sqlInfrastructureFailure}`,
                );
              } else {
                try {
                  seedCount = await queryCount(bound.text, bound.values);
                  sqlProbe = 'run';
                } catch (error) {
                  incomplete = true;
                  sqlInfrastructureFailure = displayError(error);
                  report(
                    `SQL seed count failed for ${manifestPage.id} ${persona} ${section.id}: ${sqlInfrastructureFailure}`,
                  );
                }
              }
            }
            if (native?.error) report(`${manifestPage.id} ${persona} ${section.id}: ${native.error}`);
            const observed = read.observation;
            const independentNative = !native
              ? 'unrun'
              : native.status === 0
                ? 'unsettled'
                : `settled:${native.status}`;
            const browserRequestStage = `browserServerFn=started:${browserServerFunctions.started},responses:${browserServerFunctions.responses},settled:${browserServerFunctions.settled},failed:${browserServerFunctions.failed},pending:${browserServerFunctions.pending}${browserServerFunctions.truncated ? ',truncated' : ''}`;
            const homeStage = `homeMountNotification=${observed.homeMounted === null ? 'unobserved' : observed.homeMounted ? 'received' : 'not-received'} homeState=${observed.homeState ?? 'none'} homeBusy=${observed.homeBusy === null ? 'unobserved' : observed.homeBusy}`;
            const readerStage =
              browserProbe === 'unrun'
                ? 'reader=unobserved state=unobserved busy=unobserved'
                : `reader=${observed.present ? 'present' : 'missing'} state=${observed.dataState ?? 'none'} busy=${observed.busy}`;
            if (read.timedOut) {
              incomplete = true;
              report(
                `Reader readiness timed out for ${manifestPage.id} ${persona} ${section.id}: reason=${read.readinessReason ?? 'reader-not-ready-before-shared-deadline'}; independentNative=${independentNative} ${browserRequestStage} action=${action} ${homeStage}; ${readerStage}`,
              );
            } else if (section.native.action && action === 'not-started' && readFailure) {
              incomplete = true;
              report(
                `Browser action not started for ${manifestPage.id} ${persona} ${section.id}: reason=${readFailure}; independentNative=${independentNative} ${browserRequestStage} action=${action} ${homeStage}; ${readerStage}`,
              );
            } else if (browserProbe === 'unrun') {
              incomplete = true;
              report(
                `Reader observation unrun for ${manifestPage.id} ${persona} ${section.id}: reason=${readFailure ?? (navigationFailed ? 'document-not-admitted' : 'reader-not-observed')}; independentNative=${independentNative} ${browserRequestStage} action=${action} ${homeStage}; ${readerStage}`,
              );
            }
            const classified = native
              ? classifySection(
                  native,
                  observed,
                  section.native.items,
                  seedCount,
                  section.sql !== undefined,
                  section.native.admission,
                )
              : 'UNAVAILABLE';
            const nativeProblem = native ? nativeProblemEvidence(native.status, native.body) : undefined;
            const result: SectionResult = {
              page: manifestPage.id,
              persona,
              section: section.id,
              name: section.name,
              class: classified,
              evidence: {
                nativeStatus: native?.status ?? 0,
                nativeItems: !native
                  ? 0
                  : section.native.admission === undefined
                    ? countItems(pointer(native.body, section.native.items))
                    : nativeKind(native, section.native.items, section.native.admission) === 'data'
                      ? 1
                      : 0,
                pageItems: observed.itemCount,
                reader: pageKind(observed),
                seedCount,
                seedExpected: section.sql !== undefined,
                nativeProbe: native ? 'run' : 'unrun',
                browserProbe,
                sqlProbe,
                browserServerFunctions,
                action,
                homeMounted: observed.homeMounted,
                homeState: observed.homeState,
                homeBusy: observed.homeBusy,
                ...(observed.document ? { readerDocument: observed.document } : {}),
                ...(nativeProblem ? { nativeProblem } : {}),
                ...(authorityMissing && scopedRead
                  ? {
                      unrun: {
                        version: 1 as const,
                        reason: 'member-authority-unavailable' as const,
                        scopes: requiredScopes,
                        probes: { native: 'unrun' as const },
                      },
                    }
                  : {}),
              },
            };
            if (native?.error) incomplete ||= native.status === 0;
            if (DEFECTS.has(classified) || !native || browserProbe === 'unrun') {
              report(
                `Evidence ${manifestPage.id} ${persona} ${section.id}: independentNative=${independentNative} browser=${browserProbe} selected=${result.evidence.nativeItems}; ${browserRequestStage} action=${action} ${homeStage}; ${readerStage} kind=${pageKind(observed)} items=${observed.itemCount}; ${section.sql ? `SQL=${seedCount ?? 'unavailable'}` : 'SQL=not-declared'}`,
              );
            }
            return result;
          };

          const independent = sections.filter((section) => !section.native.action);
          const activated = sections.filter((section) => section.native.action);
          const evaluated = await Promise.all(independent.map(evaluateSection));
          for (const section of activated) evaluated.push(await evaluateSection(section));
          const byId = new Map(evaluated.map((result) => [result.section, result]));
          for (const section of sections) {
            const result = byId.get(section.id)!;
            results.push(result);
            out.write(`${formatLine(result)}\n`);
          }
        }
      } finally {
        documentTracker?.dispose();
        serverFunctionTracker?.dispose();
        await close(`${persona} page`, page);
        await close(`${persona} context`, context);
      }
    }
  } finally {
    if (ownedBrowser) await close('Browser', browser);
    await close('SQL counter', seedCounter);
  }
  const defects = results.filter((result) => DEFECTS.has(result.class)).length;
  out.write(
    `Page-data completed ${JSON.stringify({
      version: 1,
      invocation: options.invocation ?? randomUUID(),
      sections: results.length,
      defects,
      incomplete,
    })}\n`,
  );
  return {
    results,
    defects,
    incomplete,
    diagnostics,
  };
}

export function parseArgs(argv: readonly string[]): {
  baseUrl: string;
  kernel: string;
  manifest: string;
  databaseUrl?: string;
  memberToken?: string;
  memberStorageState?: string;
  authOrigin?: string;
  invocation?: string;
} {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values[name] = value;
    index++;
  }
  if (!values['base-url'] || !values.kernel)
    throw new Error('Usage: bun scripts/page-data-check.ts --base-url <web> --kernel <kernel>');
  return {
    baseUrl: values['base-url'],
    kernel: values.kernel,
    manifest: values.manifest ?? DEFAULT_MANIFEST,
    ...(values['database-url'] ? { databaseUrl: values['database-url'] } : {}),
    ...(values['member-token'] ? { memberToken: values['member-token'] } : {}),
    ...(values['storage-state'] ? { memberStorageState: values['storage-state'] } : {}),
    ...(values['auth-origin'] ? { authOrigin: values['auth-origin'] } : {}),
    ...(values.invocation ? { invocation: values.invocation } : {}),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const manifestPath = isAbsolute(args.manifest) ? args.manifest : resolve(args.manifest);
    const seedArtifactPath = DEFAULT_SEED_ARTIFACT;
    const seedArtifact = loadSeedArtifact(seedArtifactPath);
    const databaseUrl =
      args.databaseUrl ?? process.env.DATABASE_URL ?? envFileValue(DEFAULT_KERNEL_ENV, 'DATABASE_URL');
    const memberToken = args.memberToken ?? process.env.PAGE_DATA_CHECK_MEMBER_TOKEN;
    const signIn = localSignIn();
    if (signIn && args.authOrigin) signIn.origin = args.authOrigin;
    const { defects, incomplete } = await runPageDataCheck({
      baseUrl: args.baseUrl,
      kernel: args.kernel,
      manifest: loadManifest(manifestPath),
      seedArtifact: seedArtifact.artifact,
      seedArtifactSource: relative(ROOT, seedArtifactPath),
      ...(seedArtifact.failure ? { seedArtifactFailure: seedArtifact.failure } : {}),
      ...(args.invocation ? { invocation: args.invocation } : {}),
      ...(databaseUrl ? { databaseUrl } : {}),
      ...(memberToken ? { memberToken } : {}),
      ...(args.memberStorageState ? { memberStorageState: args.memberStorageState } : {}),
      ...(signIn ? { signIn } : {}),
    });
    return defects > 0 ? 1 : incomplete ? 2 : 0;
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
