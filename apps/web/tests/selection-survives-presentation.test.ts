import { afterEach, expect, spyOn, test } from 'bun:test';
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js';
import { workUnitAsyncStorage, type RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import { SERVER_DEADLINE_HEADER } from '../features/api/server-fetch.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readingSelection } from '../features/wiki/selection.ts';
import { type PackageSource, resolvePackage } from '../features/zones/package-source.ts';
import { declaredData } from '../zones/official/declared.ts';
import { declaringSlug, decideExecution } from '../features/zones/execution.ts';
import type { ZonePackage } from '@rezics/zone-sdk';

const nativeFetch = globalThis.fetch;
const mainOrigin = process.env.MAIN_ORIGIN;
afterEach(() => {
  globalThis.fetch = nativeFetch;
  if (mainOrigin === undefined) delete process.env.MAIN_ORIGIN;
  else process.env.MAIN_ORIGIN = mainOrigin;
});

const person = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa';
const franchise = 'https://rezics.com/id/019a5c00-0000-7000-8000-000000000001';
const chapter = '019a5c00-0000-7000-8000-0000000000c3';
const zone = '019a5c00-0000-7000-8000-0000000000e1';

const approved = { approved: { digest: 'sha256:abc' }, reason: 'none-approved' as const };
const approval = { main: approved, slug: 'franchise-wiki', installedDigest: 'sha256:abc' };

test('selection: safe mode and the standard look turn presentation off but keep the package that declares positions', () => {
  expect(decideExecution({ ...approval, safeMode: true, lookEnabled: true })).toEqual({ mode: 'fallback', reason: 'safe-mode' });
  expect(decideExecution({ ...approval, safeMode: false, lookEnabled: false }))
    .toEqual({ mode: 'fallback', reason: 'viewer-opt-out' });
  expect(declaringSlug(approval)).toBe('franchise-wiki');
});

test('selection: a package Main has not approved, or this build does not carry, declares nothing to follow', () => {
  expect(declaringSlug({ ...approval, installedDigest: 'sha256:other' })).toBeNull();
  expect(declaringSlug({ ...approval, installedDigest: null })).toBeNull();
  expect(declaringSlug({ ...approval, main: { approved: null, reason: 'revoked' } })).toBeNull();
  expect(declaringSlug({ ...approval, main: null })).toBeNull();
  expect(declaringSlug({ ...approval, slug: null })).toBeNull();
});

/** A render of a signed-in reader whose reads Main answers from `answer`; returns every Main URL asked. */
async function signedInRender<T>(answer: (url: URL) => unknown, run: () => Promise<T>) {
  process.env.MAIN_ORIGIN = 'http://main.test';
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push(url);
    const body = answer(url);
    return body === undefined ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;
  const headers = new Headers({ [SERVER_DEADLINE_HEADER]: String(Date.now() + 5000),
    'x-rezics-page-url': 'https://web.test/en' });
  const cookies = { get: (name: string) => name === 'rezics_access' ? { value: 'reader-token' }
    : name === 'rezics_session_key' ? { value: '10280000-0000-4000-8000-000000000001' } : undefined };
  const work = spyOn(workAsyncStorage, 'getStore').mockReturnValue({ route: '/en' } as WorkStore);
  const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue(
    { type: 'request', phase: 'render', headers, cookies } as RequestStore);
  try { return { result: await run(), asked }; } finally { work.mockRestore(); request.mockRestore(); }
}

const running = { slug: 'franchise-wiki', positions: { mount: 'franchise' }, continuity: {} } as unknown as ZonePackage;

/** The real declarations of the official packages; importing a package's code is a failure when the view runs none. */
function source(options: { code?: boolean } = {}) {
  const asked: string[] = [];
  const result: PackageSource = {
    async load(slug) {
      asked.push(`load ${slug}`);
      if (!options.code) throw new Error('package code imported for a view that does not run it');
      return running;
    },
    async declarations(slug) { asked.push(`declarations ${slug}`); return declaredData(slug); },
  };
  return { asked, source: result };
}

test('selection: safe mode and the standard look read the approved declarations without importing package code', async () => {
  for (const view of [{ safeMode: true, lookEnabled: true }, { safeMode: false, lookEnabled: false }]) {
    const { asked, source: read } = source();
    const decided = decideExecution({ ...approval, ...view });
    const resolved = await resolvePackage({ decided, approval, surface: 'site', source: read });
    expect(resolved.execution).toEqual(decided);
    expect(resolved.pkg).toBeNull();
    expect(resolved.data).toEqual({ positions: { mount: 'franchise' }, continuity: {} });
    expect(asked).toEqual(['declarations franchise-wiki']);
  }
});

test('selection: a view that runs the package follows the package itself, and an unapproved one follows nothing', async () => {
  const live = source({ code: true });
  const decided = decideExecution({ ...approval, safeMode: false, lookEnabled: true });
  expect(await resolvePackage({ decided, approval, surface: 'site', source: live.source }))
    .toEqual({ execution: decided, pkg: running, data: running });
  for (const other of [{ ...approval, installedDigest: 'sha256:other' }, { ...approval, main: null }]) {
    const none = source();
    const resolved = await resolvePackage({ decided: decideExecution({ ...other, safeMode: true, lookEnabled: true }),
      approval: other, surface: 'site', source: none.source });
    expect(resolved).toMatchObject({ pkg: null, data: null });
    expect(none.asked).toEqual([]);
  }
  const community = source();
  expect(await resolvePackage({ decided: decideExecution({ ...approval, safeMode: false, lookEnabled: true }), approval,
    surface: 'community', source: community.source })).toMatchObject({ pkg: null, data: null });
  expect(community.asked).toEqual([]);
});

test('selection: package mode checks approval and digest again before running or following a package', async () => {
  const decided = decideExecution({ ...approval, safeMode: false, lookEnabled: true });
  expect(decided).toEqual({ mode: 'package', slug: 'franchise-wiki' });
  for (const [other, reason] of [[{ ...approval, installedDigest: 'sha256:other' }, 'digest-mismatch'],
    [{ ...approval, main: { approved: null, reason: 'revoked' as const } }, 'revoked'], [{ ...approval, slug: 'books' }, 'none-approved']] as const) {
    const none = source({ code: true });
    const resolved = await resolvePackage({ decided, approval: other, surface: 'site', source: none.source });
    expect(resolved).toEqual({ execution: { mode: 'fallback', reason }, pkg: null, data: null });
    expect(none.asked).toEqual([]);
  }
});

test('selection: the declarations of the official franchise wiki are real data the production loader returns', async () => {
  expect(await declaredData('franchise-wiki')).toEqual({ positions: { mount: 'franchise' }, continuity: {} });
  expect(await declaredData('fiction')).toBeNull();
  expect(await declaredData('constructor')).toBeNull();
});

test('selection: declarations that cannot be read leave the page without a position, not failing', async () => {
  const quiet = spyOn(console, 'error').mockImplementation(() => {});
  const broken: PackageSource = { load: async () => null, declarations: async () => { throw new Error('missing'); } };
  const resolved = await resolvePackage({ decided: decideExecution({ ...approval, safeMode: true, lookEnabled: true }),
    approval, surface: 'site', source: broken });
  quiet.mockRestore();
  expect(resolved).toMatchObject({ pkg: null, data: null });
});

test('selection: with safe mode on, the reader\'s chosen position still reaches every read the Zone page makes', async () => {
  const { source: read } = source();
  const resolved = await resolvePackage({ decided: decideExecution({ ...approval, safeMode: true, lookEnabled: true }),
    approval, surface: 'site', source: read });
  expect(resolved.execution).toEqual({ mode: 'fallback', reason: 'safe-mode' });
  // The helper the realm frame and the Zone site route both call for the reader's selection.
  const { result, asked } = await signedInRender(url => {
    if (url.pathname === '/v1/me/session-agent') return { sessionAgent: { eligible: true, actingSubject: person } };
    if (url.pathname === `/v1/zones/${zone}/routes`) return { kind: 'index', items: [{ id: franchise, title: { value: 'Franchise' } }] };
    if (url.pathname.startsWith('/v1/reading-positions/'))
      return { resolved: `https://rezics.com/id/${chapter}`, items: [], complete: true, nextCursor: null };
    return undefined;
  }, () => readingSelection(resolved.data, zone, { position: chapter }));
  expect(result.choice).toEqual({ kind: 'at', occurrence: chapter });
  expect(result.state).toMatchObject({ mode: 'chosen', main: `https://rezics.com/id/${chapter}` });
  const chooser = asked.find(url => url.pathname.startsWith('/v1/reading-positions/'))!;
  expect(chooser.searchParams.get('position')).toBe(`https://rezics.com/id/${chapter}`);
  expect(chooser.searchParams.get('actingSubject')).toBe(person);
});

test('selection: a Zone page given no data has no position to keep', async () => {
  const { result, asked } = await signedInRender(() => undefined, () => readingSelection(null, zone, { position: chapter }));
  expect(result.state).toBeNull();
  expect(asked).toEqual([]);
});

const web = join(import.meta.dir, '..');
const text = (path: string) => readFileSync(join(web, path), 'utf8');

test('selection: the realm frame and the Zone site route follow the resolved data, never the running package', () => {
  for (const file of ['features/realm/realm-page.tsx', 'features/zones/site-route.tsx']) {
    const source = text(file);
    expect(source).toMatch(/readingSelection\((view\.)?data,/);
    expect(source).not.toMatch(/positionOf\(|zoneContinuity\(/);
    expect(source).not.toMatch(/\bloadPackage\(/);
  }
});

test('selection: an official package declares its positions as JSON data, never in code', async () => {
  const official = join(web, 'zones/official');
  const declared: string[] = [];
  for (const slug of readdirSync(official, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const index = readFileSync(join(official, slug, 'index.tsx'), 'utf8');
    if (/\b(positions|continuity)\s*:/.test(index)) throw new Error(`${slug} declares positions or continuity in code; use declarations.json`);
    if (existsSync(join(official, slug, 'declarations.ts'))) throw new Error(`${slug}: declarations are JSON, not a module`);
    const file = join(official, slug, 'declarations.json');
    if (!existsSync(file)) continue;
    declared.push(slug);
    expect(index).toContain("from './declarations.json'");
    // The loader serves exactly the file the package spreads, so the two cannot differ.
    expect(await declaredData(slug)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  }
  expect(declared).toContain('franchise-wiki');
  // Reading declarations imports no package code.
  const imports = text('zones/official/declared.ts').split('\n').filter(line => /^import\b/.test(line));
  expect(imports.length).toBeGreaterThan(0);
  for (const line of imports) expect(line).toMatch(/^import type |\.json';$/);
  expect(text('zones/official/declared.ts')).not.toMatch(/import\.meta\.glob|\bimport\(/);
});
