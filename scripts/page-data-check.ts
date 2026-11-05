#!/usr/bin/env bun
/**
 * Classify M1 page sections against the seeded running product: Playwright, the native
 * Kernel endpoint, and a read-only SQL count. Prints one line per section. Never prints
 * credentials.
 *
 * Decision: empty native lists with a seed SQL count of zero are SEED; surfaces that may
 * legitimately be empty omit SQL and classify EMPTY when the page shows empty, WEB when it
 * hides that empty reading. HTTP 400/5xx and an authenticated 403 are API (errors or
 * refuses). Unauthenticated 401/403 is UNAUTHORIZED. Native 200 that states preparing or
 * unavailable is UNAVAILABLE.
 */
import { readFileSync, existsSync } from 'node:fs';
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
const PAGE_WAIT_MS = 15_000;
const SECRET_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|password[=:][^\s&]+|authorization:\s*[^\r\n]+)/gi;

type QueryClient = {
  connect(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: { n?: unknown }[] }>;
  end(): Promise<void>;
};

export type NativeCall = {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  items: string;
};

export type SeedSql = {
  text: string;
  params: readonly ('subject' | 'property' | 'kind' | 'place' | 'question')[];
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

export function nativeKind(observation: NativeObservation, items: string): NativeKind {
  const { status, body, authorized } = observation;
  if (status === 401 || (status === 403 && !authorized)) return 'unauthorized';
  if (status >= 400) return 'error';
  if (nativeStatesUnavailable(body) || problemCode(body) === 'index_not_ready') return 'unavailable';
  return hasItems(pointer(body, items)) ? 'data' : 'empty';
}

const UNAUTHORIZED_TEXT = /\b(unauthorized|forbidden|sign in|not allowed)\b/i;
const UNAVAILABLE_TEXT =
  /\b(unavailable|could not be loaded|retired|not available|being prepared|try the current work again|no readable preview)\b/i;
const LOADING_TEXT = /\b(loading|preparing)\b/i;
const EMPTY_TEXT = /\b(no visible entries|no supplied|no admitted|no results|empty)\b/i;

export function pageKind(observation: PageObservation): PageKind {
  if (!observation.present) return 'missing';
  if (observation.itemCount > 0) return 'data';
  if (UNAUTHORIZED_TEXT.test(observation.text) || observation.dataState === 'unauthorized') return 'unauthorized';
  if (UNAVAILABLE_TEXT.test(observation.text) || observation.dataState === 'unavailable') return 'unavailable';
  if (observation.busy || LOADING_TEXT.test(observation.text) || observation.dataState === 'loading') return 'loading';
  if (EMPTY_TEXT.test(observation.text) || observation.dataState === 'empty' || observation.itemCount === 0)
    return 'empty';
  return 'missing';
}

export function classifySection(
  native: NativeObservation,
  page: PageObservation,
  items: string,
  seedCount: number | null,
): SectionClass {
  const nativeState = nativeKind(native, items);
  const pageState = pageKind(page);
  if (nativeState === 'error') return 'API';
  if (nativeState === 'unauthorized')
    return pageState === 'unauthorized' || pageState === 'missing' ? 'UNAUTHORIZED' : 'WEB';
  if (nativeState === 'unavailable') return pageState === 'unavailable' ? 'UNAVAILABLE' : 'WEB';
  if (nativeState === 'data') return pageState === 'data' ? 'DATA' : 'WEB';
  if (seedCount === 0) return 'SEED';
  if (seedCount !== null && seedCount > 0) return 'API';
  if (pageState === 'empty') return 'EMPTY';
  return 'WEB';
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

async function defaultQueryCount(databaseUrl: string, text: string, values: readonly string[]): Promise<number> {
  const pg = (await import('pg')) as { default: { Client: new (config: { connectionString: string }) => QueryClient } };
  const client = new pg.default.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(text, values);
    await client.query('COMMIT');
    const row = result.rows[0] as { n?: unknown } | undefined;
    const n = row?.n;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
    if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) return Number(n);
    throw new Error('Seed count did not return n');
  } finally {
    await client.end();
  }
}

function databaseUrlFromEnv(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (!line) return undefined;
  return line.slice('DATABASE_URL='.length);
}

async function nativeCall(
  kernel: URL,
  call: NativeCall,
  vars: Record<string, string>,
  token: string | undefined,
  send: typeof fetch,
): Promise<NativeObservation> {
  const url = new URL(expand(call.path, vars), kernel);
  if (call.query) {
    for (const [name, value] of Object.entries(call.query)) url.searchParams.set(name, expand(value, vars));
  }
  const headers: Record<string, string> = { accept: 'application/json', 'accept-language': 'en' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (call.method === 'POST') headers['content-type'] = 'application/json';
  const response = await send(
    new Request(url, {
      method: call.method,
      headers,
      body: call.method === 'POST' ? JSON.stringify(call.body ?? {}) : undefined,
    }),
  );
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
  } else body = null;
  return { status: response.status, body, authorized: Boolean(token) };
}

type SectionProbe = {
  present: boolean;
  itemCount: number;
  text: string;
  dataState: string | null;
  busy: boolean;
};

async function observeSection(page: Page, section: ManifestSection): Promise<PageObservation> {
  return page.evaluate(
    ({ selector, heading, itemSelector }) => {
      const matches = [...document.querySelectorAll<HTMLElement>(selector)];
      const node =
        heading === undefined
          ? matches[0]
          : matches.find((element) => {
              const label = element.getAttribute('aria-labelledby');
              const title = label ? document.getElementById(label)?.textContent : '';
              const headingNode = element.querySelector('h1,h2,h3');
              return (title ?? headingNode?.textContent ?? element.textContent ?? '').includes(heading);
            });
      if (!node) return { present: false, itemCount: 0, text: '', dataState: null, busy: false };
      const items = itemSelector ? node.querySelectorAll(itemSelector).length : 0;
      return {
        present: true,
        itemCount: items,
        text: (node.innerText ?? node.textContent ?? '').slice(0, 4000),
        dataState: node.getAttribute('data-state') ?? node.getAttribute('data-feed-result-state'),
        busy: node.getAttribute('aria-busy') === 'true',
      } satisfies SectionProbe;
    },
    {
      selector: section.selector,
      heading: section.heading,
      itemSelector:
        section.itemSelector ??
        '[data-slot="cover-card"], [data-feed-id], [data-slot="list-row"], [data-slot="rating-comparison"]',
    },
  );
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
      body: JSON.stringify({
        email: signIn.email,
        password: signIn.password,
        client_id: 'rezics-website',
        scope: ['openid', 'offline_access'],
      }),
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
): Promise<void> {
  await page.goto(new URL('/auth/sign-in', base).href, { waitUntil: 'domcontentloaded' });
  const email = page.getByLabel(/email/i);
  await email.waitFor({ state: 'visible', timeout: PAGE_WAIT_MS });
  await email.fill(signIn.email);
  await page.locator('input[name="password"]').fill(signIn.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin === base.origin, { timeout: PAGE_WAIT_MS });
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

export async function runPageDataCheck(options: RunOptions): Promise<{ results: SectionResult[]; defects: number }> {
  const base = publicOrigin(options.baseUrl, 'base URL');
  const kernel = publicOrigin(options.kernel, 'kernel URL');
  const send = options.fetch ?? fetch;
  const timeout = options.pageTimeoutMs ?? PAGE_WAIT_MS;
  const out = options.stdout ?? process.stdout;
  let token = options.memberToken;
  const signIn = options.signIn;
  if (!token && signIn) token = await memberTokenFromAuth(signIn, send);
  const queryCount =
    options.queryCount ??
    (options.databaseUrl
      ? (text: string, values: readonly string[]) => defaultQueryCount(options.databaseUrl!, text, values)
      : undefined);

  const ownedBrowser = options.browser === undefined;
  const browser = options.browser ?? (await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] }));
  const results: SectionResult[] = [];
  try {
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
          await signInBrowser(page, base, signIn);
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
            await page.goto(new URL(manifestPage.path, base).href, { waitUntil: 'load', timeout });
            const vars: Record<string, string> = {
              subject: manifestPage.subject ?? '',
              GLOBAL: options.manifest.context,
              QUESTION: options.manifest.question,
              context: options.manifest.context,
              question: options.manifest.question,
              place: options.manifest.context,
            };
            for (const section of sections) {
              if (section.property) vars.property = section.property;
              if (section.kind) vars.kind = section.kind;
              const native = await nativeCall(
                kernel,
                section.native,
                vars,
                persona === 'member' ? token : undefined,
                send,
              );
              let seedCount: number | null = null;
              if (section.sql) {
                if (!queryCount) throw new Error(`Section ${section.id} needs a database URL for its seed count`);
                const bound = bindSql(section.sql, vars);
                seedCount = await queryCount(bound.text, bound.values);
              }
              const observed = await observeSection(page, section);
              const classified = classifySection(native, observed, section.native.items, seedCount);
              const result: SectionResult = {
                page: manifestPage.id,
                persona,
                section: section.id,
                name: section.name,
                class: classified,
              };
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
    if (ownedBrowser) await browser.close();
  }
  return { results, defects: results.filter((result) => DEFECTS.has(result.class)).length };
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
    const signIn = memberToken ? undefined : localSignIn();
    if (signIn && args.authOrigin) signIn.origin = args.authOrigin;
    const { defects } = await runPageDataCheck({
      baseUrl: args.baseUrl,
      kernel: args.kernel,
      manifest: loadManifest(manifestPath),
      ...(databaseUrl ? { databaseUrl } : {}),
      ...(memberToken ? { memberToken } : {}),
      ...(args.memberStorageState ? { memberStorageState: args.memberStorageState } : {}),
      ...(signIn ? { signIn } : {}),
    });
    return defects > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
