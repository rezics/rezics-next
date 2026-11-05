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
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '../packages/ui/node_modules/playwright/index.mjs';

export const CLASSES = ['DATA', 'EMPTY', 'UNAUTHORIZED', 'UNAVAILABLE', 'API', 'WEB', 'SEED'] as const;
export type SectionClass = (typeof CLASSES)[number];
export const DEFECTS: ReadonlySet<SectionClass> = new Set(['API', 'WEB', 'SEED']);
export const PERSONAS = ['anonymous', 'member'] as const;
export type Persona = (typeof PERSONAS)[number];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = resolve(ROOT, 'scripts/page-data-sections.json');
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
  subject?: string;
  personas?: readonly Persona[];
  sections: ManifestSection[];
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

export type PageObservation = {
  present: boolean;
  itemCount: number;
  text: string;
  dataState: string | null;
  busy: boolean;
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
  };
};

export type RunOptions = {
  baseUrl: string;
  kernel: string;
  manifest: Manifest;
  databaseUrl?: string;
  memberToken?: string;
  memberStorageState?: string;
  signIn?: { origin: string; email: string; password: string };
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
  return `${result.page} ${result.persona} ${result.section} ${result.class}`;
}

function personasOf(value: { personas?: readonly Persona[] } | undefined): readonly Persona[] {
  return value?.personas && value.personas.length > 0 ? value.personas : PERSONAS;
}

export function parseManifest(value: unknown): Manifest {
  if (!isRecord(value) || value.version !== 1) throw new Error('Manifest version must be 1');
  if (typeof value.context !== 'string' || typeof value.question !== 'string' || !Array.isArray(value.pages))
    throw new Error('Manifest is missing context, question or pages');
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

function databaseUrlFromEnv(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (!line) return undefined;
  return line.slice('DATABASE_URL='.length).replace(/^(['"])(.*)\1$/, '$2');
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
        ...(call.method === 'POST' ? { body: JSON.stringify(call.body ?? {}) } : {}),
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
};

async function observeSection(
  page: Page,
  section: ManifestSection,
  timeoutMs: number,
): Promise<{ observation: PageObservation; timedOut: boolean }> {
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
      if (!node) return { present: false, itemCount: 0, text: '', dataState: null, busy: true };
      const items = itemSelector ? Number(node.matches(itemSelector)) + node.querySelectorAll(itemSelector).length : 0;
      const unsettled = loading(node);
      return {
        present: true,
        itemCount: items,
        text: (node.innerText ?? node.textContent ?? '').slice(0, 4000),
        dataState: node.getAttribute('data-state') ?? node.getAttribute('data-feed-result-state'),
        busy: timedOut || unsettled,
      } satisfies SectionProbe;
    },
    { selector: section.selector, heading: section.heading, itemSelector: section.itemSelector, timedOut },
  );
  return { observation, timedOut };
}

async function clickSectionAction(page: Page, section: ManifestSection, timeoutMs: number): Promise<void> {
  const action = section.native.action!;
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

async function memberTokenFromAuth(
  signIn: { origin: string; email: string; password: string },
  send: typeof fetch,
): Promise<string> {
  const origin = publicOrigin(signIn.origin, 'auth origin');
  const signin = await send(
    new Request(new URL('/signin', origin), {
      method: 'POST',
      headers: { origin: origin.origin, 'content-type': 'application/json' },
      body: JSON.stringify(signInRequestBody(signIn.email, signIn.password)),
      signal: AbortSignal.timeout(REQUEST_WAIT_MS),
    }),
  );
  if (!signin.ok) throw new Error(`Member sign-in failed: ${signin.status}`);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const token = await send(
    new Request(new URL('/token', origin), {
      method: 'POST',
      headers: { origin: origin.origin, 'content-type': 'application/json', cookie },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_WAIT_MS),
    }),
  );
  if (!token.ok) throw new Error(`Member token failed: ${token.status}`);
  const body: unknown = await token.json();
  if (!isRecord(body) || typeof body.access_token !== 'string' || body.access_token.length === 0)
    throw new Error('Member token response had no access token');
  return body.access_token;
}

async function signInBrowser(
  page: Page,
  base: URL,
  signIn: { origin: string; email: string; password: string },
  timeoutMs: number,
): Promise<void> {
  await page.goto(new URL('/auth/sign-in', base).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const email = page.getByLabel(/email/i);
  await email.waitFor({ state: 'visible', timeout: timeoutMs });
  await email.fill(signIn.email);
  await page.locator('input[name="password"]').fill(signIn.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: timeoutMs });
  await page.waitForURL((url) => url.origin === base.origin, { timeout: timeoutMs });
}

function localSignIn(): { origin: string; email: string; password: string } | undefined {
  if (!existsSync(LOCAL_KEYS)) return undefined;
  const keys: unknown = JSON.parse(readFileSync(LOCAL_KEYS, 'utf8'));
  if (!isRecord(keys) || typeof keys.password !== 'string' || keys.password.length === 0) return undefined;
  return {
    origin: process.env.AUTH_ORIGIN?.trim() || DEFAULT_AUTH_ORIGIN,
    email: MEMBER_EMAIL,
    password: keys.password,
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
  let token = options.memberToken;
  const signIn = options.signIn;
  if (!token && signIn) token = await memberTokenFromAuth(signIn, send);

  const ownedBrowser = options.browser === undefined;
  const browser = options.browser ?? (await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] }));
  const results: SectionResult[] = [];
  let seedCounter: ReturnType<typeof createSeedCounter> | undefined;
  try {
    seedCounter = !options.queryCount && options.databaseUrl ? createSeedCounter(options.databaseUrl) : undefined;
    const queryCount = options.queryCount ?? seedCounter?.queryCount;
    let sqlInfrastructureFailure: string | undefined;
    const contexts: Record<Persona, BrowserContext> = {
      anonymous: await browser.newContext({ locale: 'en-US' }),
      member: await browser.newContext({
        locale: 'en-US',
        ...(options.memberStorageState ? { storageState: options.memberStorageState } : {}),
      }),
    };
    try {
      if (signIn && !options.memberStorageState) {
        const page = await contexts.member.newPage();
        try {
          await signInBrowser(page, base, signIn, pageTimeout);
        } finally {
          await page.close();
        }
      }
      for (const persona of PERSONAS) {
        const page = await contexts[persona].newPage();
        try {
          for (const manifestPage of options.manifest.pages) {
            if (!personasOf(manifestPage).includes(persona)) continue;
            const sections = manifestPage.sections.filter((section) => personasOf(section).includes(persona));
            if (sections.length === 0) continue;
            let navigationTimedOut = false;
            try {
              await page.goto(new URL(manifestPage.path, base).href, { waitUntil: 'load', timeout: pageTimeout });
            } catch (error) {
              if (!isTimeout(error)) throw error;
              navigationTimedOut = true;
              incomplete = true;
              report(
                `Page navigation timed out for ${manifestPage.id} ${persona}; continuing bounded section coverage`,
              );
            }

            const evaluateSection = async (section: ManifestSection): Promise<SectionResult> => {
              const vars: Record<string, string> = {
                subject: manifestPage.subject ?? '',
                GLOBAL: options.manifest.context,
                QUESTION: options.manifest.question,
                context: options.manifest.context,
                question: options.manifest.question,
                place: options.manifest.context,
                ...(section.property ? { property: section.property } : {}),
                ...(section.kind ? { kind: section.kind } : {}),
              };
              vars.filter = section.native.query?.filter ? expand(section.native.query.filter, vars) : NIL_UUID;
              let actionFailed = false;
              if (section.native.action && navigationTimedOut) {
                actionFailed = true;
              } else if (section.native.action) {
                try {
                  await clickSectionAction(page, section, readerTimeout);
                } catch (error) {
                  if (!isTimeout(error)) throw error;
                  incomplete = true;
                  actionFailed = true;
                  report(`Reader action timed out for ${manifestPage.id} ${persona} ${section.id}`);
                }
              }
              const [native, read] = await Promise.all([
                nativeCall(
                  kernel,
                  section.native,
                  vars,
                  persona === 'member' ? token : undefined,
                  send,
                  requestTimeout,
                ),
                navigationTimedOut
                  ? Promise.resolve({
                      observation: { present: false, itemCount: 0, text: '', dataState: null, busy: true },
                      timedOut: false,
                    })
                  : observeSection(page, section, readerTimeout),
              ]);
              let seedCount: number | null = null;
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
                  } catch (error) {
                    incomplete = true;
                    sqlInfrastructureFailure = displayError(error);
                    report(
                      `SQL seed count failed for ${manifestPage.id} ${persona} ${section.id}: ${sqlInfrastructureFailure}`,
                    );
                  }
                }
              }
              if (native.error) report(`${manifestPage.id} ${persona} ${section.id}: ${native.error}`);
              if (read.timedOut) {
                incomplete = true;
                report(`Reader readiness timed out for ${manifestPage.id} ${persona} ${section.id}`);
              }
              const observed =
                actionFailed || navigationTimedOut ? { ...read.observation, busy: true } : read.observation;
              const classified = classifySection(
                native,
                observed,
                section.native.items,
                seedCount,
                section.sql !== undefined,
                section.native.admission,
              );
              const result: SectionResult = {
                page: manifestPage.id,
                persona,
                section: section.id,
                name: section.name,
                class: classified,
                evidence: {
                  nativeStatus: native.status,
                  nativeItems:
                    section.native.admission === undefined
                      ? countItems(pointer(native.body, section.native.items))
                      : nativeKind(native, section.native.items, section.native.admission) === 'data'
                        ? 1
                        : 0,
                  pageItems: observed.itemCount,
                  reader: pageKind(observed),
                  seedCount,
                  seedExpected: section.sql !== undefined,
                },
              };
              if (native.error) incomplete ||= native.status === 0;
              if (DEFECTS.has(classified)) {
                report(
                  `Evidence ${manifestPage.id} ${persona} ${section.id}: native=${native.status} selected=${result.evidence.nativeItems}; reader=${pageKind(observed)} items=${observed.itemCount} state=${observed.dataState ?? 'none'} busy=${observed.busy}; ${section.sql ? `SQL=${seedCount ?? 'unavailable'}` : 'SQL=not-declared'}`,
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
          await page.close();
        }
      }
    } finally {
      await Promise.all(Object.values(contexts).map((context) => context.close()));
    }
  } finally {
    try {
      if (ownedBrowser) await browser.close();
    } finally {
      await seedCounter?.close();
    }
  }
  return {
    results,
    defects: results.filter((result) => DEFECTS.has(result.class)).length,
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
  };
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const manifestPath = isAbsolute(args.manifest) ? args.manifest : resolve(args.manifest);
    const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL ?? databaseUrlFromEnv(DEFAULT_KERNEL_ENV);
    const memberToken = args.memberToken ?? process.env.PAGE_DATA_CHECK_MEMBER_TOKEN;
    const signIn = localSignIn();
    if (signIn && args.authOrigin) signIn.origin = args.authOrigin;
    const { defects, incomplete } = await runPageDataCheck({
      baseUrl: args.baseUrl,
      kernel: args.kernel,
      manifest: loadManifest(manifestPath),
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
