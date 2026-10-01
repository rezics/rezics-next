import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser, Page, TestInfo } from '@playwright/test';
import type { Hub } from './g-850-seed.ts';
import { credentials, signIn } from './g-855-library.ts';

// What the G-743 journey files share on the isolated QA stack: the records of the journeys they walk, written once
// per stack by those journeys' own seeds, and a signed-in device. Nothing here is a second implementation of a
// journey; the steps are the journeys' own.

export { credentials, signIn };
export const uuid = (iri: string) => iri.slice(-36);
export const main = (path: string) => `http://127.0.0.1:${process.env.MAIN_PORT}${path}`;

/** Run a seed script once per stack (a failed test restarts the worker and its hooks); later callers read the cache. */
function seeded<T>(name: string, script: string, args: string[] = []): T {
  const cache = `.temp/${name}-seed-${process.env.REZICS_QA_RUN_ID}.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as T;
  mkdirSync('.temp', { recursive: true });
  const result = spawnSync('bun', [script, ...args], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 360_000 });
  if (result.status !== 0 || result.error) throw new Error(`${name} seed failed: ${result.stderr || result.error?.message || result.status}`);
  const output = result.stdout.trim().split('\n').at(-1)!;
  writeFileSync(cache, output);
  return JSON.parse(output) as T;
}

/** Main keeps processing a seed's events for a while, moving the graph under every read (409); wait until it rests. */
async function settled(path: string, minutes = 2): Promise<void> {
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + minutes * 60_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main(path)).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error(`Main’s graph kept moving for ${minutes} minutes after the seed (${path})`);
}

/** G-850's records: Sword Art Online as a series of three volumes, with editions, and one review. Written by `g-850-seed.ts`. */
export async function hubRecords(): Promise<Hub> {
  const hub = seeded<Hub>('g850', 'apps/web/tests/g-850-seed.ts');
  await settled(`/v1/works/${uuid(hub.sao.series.work)}`);
  return hub;
}

/** G-855's Works to import against: three matched by title and two that share one (`g-855-seed.ts`), once searchable. */
export async function libraryRecords(): Promise<{ matched: string[]; ambiguous: string }> {
  const seed = seeded<{ matched: string[]; ambiguous: string }>('g855', 'apps/web/tests/g-855-seed.ts');
  const url = main(`/v1/search/typeahead?prefix=${encodeURIComponent(seed.ambiguous)}`);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
    const response = await fetch(url).catch(() => null);
    const body = response?.ok ? await response.json() as { items: unknown[] } : null;
    if (body && body.items.length >= 2) return seed;
    await new Promise(done => setTimeout(done, 1_000));
  }
  throw new Error('Search never indexed the seeded Works');
}

/** G-849's franchise wiki Zone for Pride and Prejudice: chapters, characters revealed at chapters 1 and 3, a reviewed bundle. */
export interface WikiRecords {
  realm: string; zone: string; work: string; structure: string; chapters: string[];
  entities: Record<'elizabeth' | 'jane' | 'darcy', string>; evidence: string[];
}
export async function wikiRecords(): Promise<WikiRecords> {
  const seed = seeded<WikiRecords>('g849', 'apps/web/tests/g-849-seed.ts');
  await settled(`/v1/works/${uuid(seed.work)}`);
  // The Zone is read through its route segment, and its package runs only once Main reports it approved.
  let state = '';
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && state !== 'package';) {
    const zone = await fetch(main('/v1/zones/by-segment/franchise-wiki')).catch(() => null);
    const id = zone?.ok ? (await zone.json() as { zone: string }).zone.slice(-36) : null;
    const presentation = id ? await fetch(main(`/v1/zones/${id}/presentation`)).catch(() => null) : null;
    state = presentation?.ok ? (await presentation.json() as { execution: { state: string } }).execution.state : '';
    if (state !== 'package') await new Promise(done => setTimeout(done, 1000));
  }
  if (state !== 'package') throw new Error('The franchise wiki Zone never reported its package approved');
  let found = false;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && !found;) {
    const header = await fetch(main(`/v1/realms/${uuid(seed.realm)}`)).catch(() => null);
    found = Boolean(header?.ok);
    if (!found) await new Promise(done => setTimeout(done, 1000));
  }
  if (!found) throw new Error('The Realm never became readable');
  return seed;
}

/** G-704's contribution loop: a Swedish Work the web member corrects, and a wiki bundle the member stewards. */
export interface LoopRecords {
  roles: Record<'holder' | 'steward' | 'second' | 'assistant', { actor: string; name: string }>;
  reader: { principalId: string; actingSubject: string };
  sagan: { work: string; id: string };
  wiki: { work: string; id: string; zone: string; chapters: string[]; property: string; relation: string; bundleProposal: string; head: string };
  statePath: string;
}
export async function loopRecords(): Promise<LoopRecords> {
  const statePath = `.temp/g704-seed-${process.env.REZICS_QA_RUN_ID}.json`;
  if (!existsSync(statePath)) {
    mkdirSync('.temp', { recursive: true });
    const result = spawnSync('bun', ['apps/web/tests/g-704-seed.ts', statePath], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 360_000 });
    if (result.status !== 0 || result.error) throw new Error(`G-704 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const seed = JSON.parse(readFileSync(statePath, 'utf8')) as Omit<LoopRecords, 'statePath'>;
  await settled(`/v1/works/${seed.wiki.id}`);
  return { ...seed, statePath };
}

/** One request as an API member of the G-704 seed (`g-704-act.ts`), sent through the stack's Main. */
export function act(statePath: string, request: object): { status: number; body: Record<string, unknown> } {
  const result = spawnSync('bun', ['apps/web/tests/g-704-act.ts', statePath, JSON.stringify(request)],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0 || result.error) throw new Error(`G-704 act failed: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { status: number; body: Record<string, unknown> };
}

/** A device: its own browser context under the running project's engine and emulation, signed in as the web member. */
export async function device(browser: Browser, info: TestInfo, first: string, options: { reducedMotion?: boolean } = {}): Promise<Page> {
  const { baseURL, userAgent, isMobile, hasTouch, deviceScaleFactor, viewport } = info.project.use;
  const context = await browser.newContext({ baseURL, userAgent, isMobile, hasTouch, deviceScaleFactor, viewport,
    ...(options.reducedMotion ? { reducedMotion: 'reduce' as const } : {}) });
  const page = await context.newPage();
  // Accounts shows its sign-in in the language of the page it returns to, and the tests find its fields by their
  // English names: sign in on the English page, then go to the page asked for.
  const english = first.replace(/^\/[\w-]+(?=\/)/, '/en');
  await signIn(page, english, credentials().member);
  if (english !== first) await page.goto(first);
  return page;
}

/** A visitor with no account, under the running project's engine and emulation. */
export async function visitor(browser: Browser, info: TestInfo, options: { reducedMotion?: boolean } = {}): Promise<Page> {
  const { baseURL, userAgent, isMobile, hasTouch, deviceScaleFactor, viewport } = info.project.use;
  const context = await browser.newContext({ baseURL, userAgent, isMobile, hasTouch, deviceScaleFactor, viewport,
    ...(options.reducedMotion ? { reducedMotion: 'reduce' as const } : {}) });
  return context.newPage();
}
