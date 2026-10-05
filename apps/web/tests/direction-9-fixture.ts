import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSessionKey, SESSION_KEY_COOKIE } from '../features/auth/cookies.ts';

export interface PublicResponse {
  status(): number;
  json(): Promise<unknown>;
  headers?(): Record<string, string>;
}
export interface PublicRequest {
  get(path: string, options?: { headers: Record<string, string> }): Promise<PublicResponse>;
  fetch(
    path: string,
    options: { method: string; data: unknown; headers: Record<string, string> },
  ): Promise<PublicResponse>;
}

/** Main owns the web session's selected Agent; the legacy subject cookie is
 * cleared on sign-in and the Account's default Agent can differ from selection. */
export async function selectedSessionAgent(
  request: Pick<PublicRequest, 'get'>,
  cookies: readonly { name: string; value: string }[],
): Promise<string> {
  const sessionKey = cookies.find((cookie) => cookie.name === SESSION_KEY_COOKIE)?.value;
  if (!isSessionKey(sessionKey)) throw new Error('Authenticated address read needs a web session key');
  const response = await request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey },
  });
  if (response.status() !== 200)
    throw new Error(`Session Agent read: HTTP ${response.status()}`);
  const { sessionAgent } = await response.json() as {
    sessionAgent: { actingSubject: string | null; eligible: boolean };
  };
  if (!sessionAgent.eligible || !sessionAgent.actingSubject)
    throw new Error('Authenticated address read needs an eligible selected Agent');
  return sessionAgent.actingSubject;
}

/** Every setup write goes through the browser's authenticated public BFF. */
export class PublicCommands {
  constructor(
    private readonly request: PublicRequest,
    private readonly delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    private readonly namespace?: string,
    readonly timings: { method: string; path: string; status: number; elapsedMs: number }[] = [],
  ) {}

  reusable(namespace: string): PublicCommands {
    return new PublicCommands(this.request, this.delay, namespace, this.timings);
  }

  private async response(path: string, method = 'GET', data?: unknown, headers = {}) {
    const start = performance.now();
    const response =
      method === 'GET'
        ? await this.request.get(`/api/main/v1${path}`)
        : await this.request.fetch(`/api/main/v1${path}`, { method, data, headers });
    const elapsedMs = Math.round(performance.now() - start);
    this.timings.push({ method, path, status: response.status(), elapsedMs });
    if (elapsedMs >= 3000)
      console.log(`[direction-9 API] ${method} ${path}: ${response.status()} in ${elapsedMs} ms`);
    return response;
  }

  async read<T>(path: string): Promise<T> {
    const response = await this.response(path);
    if (response.status() !== 200) throw await this.problem(path, response);
    return (await response.json()) as T;
  }

  private async problem(path: string, response: PublicResponse): Promise<Error> {
    const body = await response.json();
    const code = body && typeof body === 'object' && 'code' in body ? body.code : 'unknown';
    return new Error(`Fixture GET ${path}: HTTP ${response.status()} (${String(code)})`);
  }

  async find<T>(path: string): Promise<T | null> {
    const response = await this.response(path);
    if (response.status() === 404) return null;
    if (response.status() !== 200) throw await this.problem(path, response);
    return (await response.json()) as T;
  }

  /** A probe that keeps denied and missing outcomes, unlike read and find. */
  async inspect(path: string): Promise<{ status: number; body: unknown }> {
    const response = await this.response(path);
    const status = response.status();
    if (status === 204 || status === 304) return { status, body: null };
    try {
      return { status, body: await response.json() };
    } catch {
      return { status, body: null };
    }
  }

  /** Probe the exact served projection; no sleep after an already-ready receipt. */
  async until<T>(path: string, ready: (value: T) => boolean, data?: unknown): Promise<T> {
    const deadline = Date.now() + 30_000;
    do {
      const response = await this.response(path, data === undefined ? 'GET' : 'POST', data);
      if (response.status() === 200) {
        const value = (await response.json()) as T;
        if (ready(value)) return value;
      } else {
        const error = await this.problem(path, response);
        if (
          ![409, 503].includes(response.status()) ||
          error.message.includes('(rate_limit_unclassified)')
        )
          throw error;
      }
      await this.delay(250);
    } while (Date.now() < deadline);
    throw new Error(`Fixture projection ${path} was not ready within 30 seconds`);
  }

  async write<T>(
    path: string,
    data: unknown,
    method = 'POST',
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const key = this.namespace
      ? createHash('sha256')
          .update(JSON.stringify([this.namespace, method, path, data]))
          .digest('hex')
      : randomUUID();
    // An unknown outcome is retried with exactly the same intent and key. Denied,
    // stale and validation failures are setup failures, never feature skips.
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await this.response(path, method, data, {
        ...extraHeaders,
        'idempotency-key': key,
      });
      const status = response.status();
      if (status === 200 || status === 201) return (await response.json()) as T;
      if (![202, 429, 503].includes(status) || attempt === 39) {
        const body = await response.json();
        const code = body && typeof body === 'object' && 'code' in body ? body.code : 'unknown';
        throw new Error(`Fixture ${method} ${path}: HTTP ${status} (${String(code)})`);
      }
      const retry = Number(response.headers?.()['retry-after']);
      await this.delay(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 500);
    }
    throw new Error(`Fixture ${path} did not settle`);
  }
}

export interface Credentials {
  member: { email: string; password: string };
  operator: { email: string; password: string };
}
export function credentials(): Credentials {
  // The manager can explicitly supply read-only credentials from the shared stack.
  const path =
    process.env.REZICS_WEB_AUTH_PRIVATE_PATH ??
    resolve('.temp/stack/rezics-dev/web-auth/private.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Credentials;
}

/** Privilege is restricted to setup; every reader/requester still uses member. */
export function setupCredentials(): Credentials['member'] | null {
  const path = process.env.REZICS_DIRECTION_9_ADMIN_PRIVATE_PATH;
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as Credentials['member']) : null;
}

export interface SetupPrincipal {
  api: PublicCommands;
  actor: string;
}

export interface SpaceRecord {
  space: string;
  realm: string;
  name: string;
  handle?: string;
}
export interface WorkRecord {
  work: string;
  mainVersion: string;
  contribution: string;
  publicationDecision: string;
}
export interface DirectionFixture {
  actor: string;
  owner: string;
  manager: string;
  namedPerson: string;
  unnamedPerson: string;
  personHandle: string;
  spaces: SpaceRecord[];
  named: SpaceRecord;
  unnamed: SpaceRecord;
  private: SpaceRecord;
  privateSpaces: SpaceRecord[];
  unlisted: SpaceRecord;
  work: WorkRecord;
  story: WorkRecord;
  chapterText: WorkRecord;
  zone: string;
  topic: { concept: string; name: string; names: Record<'en' | 'zh-Hant', string> };
  laterChapter: { occurrence: string; name: string };
}

export const short = (iri: string) => iri.slice(-36);
export const fixtureName = 'direction-9-v4';
export const populationCount = 21;
export const chapterCount = 51;
const spaceCount = populationCount + 5; // Four private journeys and one unlisted Space.

export interface WikiPositionFixture {
  space: string;
  zone: string;
  work: string;
  mount: string;
  laterChapter: DirectionFixture['laterChapter'];
}

interface PositionPage {
  items: {
    occurrence: string;
    structure: string;
    labels?: { value: string; language: string }[];
  }[];
  complete: boolean;
  nextCursor: string | null;
}

/** Approvals are host-bound, and the web loads packages by official Space key.
 * Use the seeded franchise wiki rather than copying its approval to our Zone.
 * `task dev:seed -- --wiki-only` owns its public story and chapter inventory;
 * journey setup only reads it, so running another locale never extends shared content. */
export async function seedWikiPosition(
  api: PublicCommands,
  fixture: DirectionFixture,
): Promise<WikiPositionFixture> {
  const query = new URLSearchParams({ actingSubject: fixture.owner });
  const address = await api.find<{ holder: string; capabilities?: { zone?: string } }>(
    `/addresses/resolve?${new URLSearchParams({
      scope: 'space', key: 'franchise-wiki', actingSubject: fixture.owner,
    })}`,
  );
  if (!address?.capabilities?.zone)
    throw new Error('Direction 9 wiki needs the seeded official franchise-wiki Space and Zone');
  const zone = address.capabilities.zone;
  const presentation = await api.read<{ official: string | null; execution: { state: string } }>(
    `/zones/${short(zone)}/presentation?${query}`,
  );
  if (presentation.official !== 'franchise-wiki' || presentation.execution.state !== 'package')
    throw new Error('Direction 9 wiki needs an active franchise-wiki package approval on its seeded Zone');
  const mount = 'franchise'; // The official package declares positions: { mount: 'franchise' }.
  const route = await api.read<{ kind: string; items?: { id: string; title?: unknown }[] }>(
    `/zones/${short(zone)}/routes?${new URLSearchParams({
      path: `/${mount}`, actingSubject: fixture.owner,
    })}`,
  );
  const story = route.kind === 'index' ? route.items?.find((item) => 'title' in item) : null;
  if (!story) throw new Error('Direction 9 wiki needs a story in the franchise mount');
  const work = story.id;
  const positions = `/reading-positions/${short(work)}`;
  const first = await api.read<PositionPage>(`${positions}?${query}&limit=50`);
  if (!first.items[0]?.structure) throw new Error('Direction 9 wiki needs a composed story in the franchise mount');
  if (first.complete || !first.nextCursor)
    throw new Error('Direction 9 wiki chapter must be beyond the chooser first page; run task dev:seed -- --wiki-only');
  const later = await api.read<PositionPage>(
    `${positions}?${query}&${new URLSearchParams({ limit: '50', cursor: first.nextCursor })}`,
  );
  const chapter = later.items.find(item => item.labels?.some(label => label.value.trim()));
  const name = chapter?.labels?.find(label => label.value.trim())?.value;
  if (!chapter || !name || first.items.some(item => item.occurrence === chapter.occurrence))
    throw new Error('Direction 9 wiki chapter must be beyond the chooser first page');
  const found = await api.until<PositionPage>(
    `${positions}?${query}&${new URLSearchParams({ q: name })}`,
    (page) => page.items.some((item) => item.occurrence === chapter.occurrence),
  );
  const occurrence = found.items.find((item) => item.occurrence === chapter.occurrence)!.occurrence;
  return { space: address.holder, zone, work, mount, laterChapter: { occurrence, name } };
}

export async function phase<T>(name: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  console.log(`[direction-9 setup] ${name}: start`);
  try {
    return await action();
  } finally {
    console.log(`[direction-9 setup] ${name}: ${Math.round(performance.now() - start)} ms`);
  }
}

/** Four requests at most per Account, with fewer than 120 first-attempt writes. */
export async function parallel<T, R>(
  items: readonly T[],
  action: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (let index = next++; index < items.length && !failed; index = next++) {
        try {
          results[index] = await action(items[index]!, index);
        } catch (error) {
          failed = true;
          failure ??= error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}

const asciiHandle = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,28})[A-Za-z0-9]$/;

interface AddressView {
  status?: string;
  holder?: string;
  state?: string;
  capabilities?: { realm?: string; zone?: string };
}

interface ControlledAgent {
  actingSubject?: string;
  displayName?: { value?: string } | null;
}

interface StudioWorkItem {
  id?: string;
  mainVersion?: string;
  title?: { value?: string };
  texts?: { contribution?: string; publicationHead?: string | null }[];
}

/** A persistent stack keeps an address after the idempotency record that created
 * its holder expires. Resolve before claiming: reuse a holder this principal
 * controls, and otherwise derive a handle from the holder that already has it. */
async function allocateAddress(
  commands: PublicCommands,
  scope: 'agent' | 'space',
  requested: string,
  actingSubject: string,
): Promise<{ key: string; holder: string | null; capabilities?: AddressView['capabilities'] }> {
  let fact = '';
  for (let step = 0; step < 4; step++) {
    const key = fact ? distinctHandle(requested, fact) : requested;
    const resolved = await readAddress(commands, scope, key, actingSubject);
    if (resolved?.holder && resolved.state !== 'retired' && resolved.status !== 'unavailable') {
      if (await controlsHolder(commands, scope, resolved.holder, actingSubject)) {
        console.log(`[direction-9 setup] reuse ${scope} ${key}`);
        return { key, holder: resolved.holder, capabilities: resolved.capabilities };
      }
      fact = `${resolved.holder}:${step}`;
      continue;
    }
    const available = await addressAvailable(commands, scope, key, actingSubject);
    if (available !== false) return { key, holder: null };
    fact = `taken:${key}:${step}`;
  }
  throw new Error(`Fixture ${scope} address ${requested} stayed held by another principal`);
}

function distinctHandle(requested: string, fact: string): string {
  const mark = createHash('sha256').update(`${requested}\0${fact}`).digest('hex').slice(0, 8);
  const stem = requested.slice(0, 21).replace(/[_-]+$/g, '');
  const key = `${stem}-${mark}`;
  if (!asciiHandle.test(key))
    throw new Error(`Fixture address ${requested} cannot yield a distinct handle`);
  return key;
}

function zoneIri(seed: string): string {
  const zoneHash = createHash('sha256').update(seed).digest('hex');
  return `https://rezics.com/id/${zoneHash.slice(0, 8)}-${zoneHash.slice(8, 12)}-4${zoneHash.slice(13, 16)}-a${zoneHash.slice(17, 20)}-${zoneHash.slice(20, 32)}`;
}

async function readAddress(
  commands: PublicCommands,
  scope: string,
  key: string,
  actingSubject: string,
): Promise<AddressView | null> {
  const page = await commands.inspect(
    `/addresses/resolve?${new URLSearchParams({ scope, key, actingSubject })}`,
  );
  if (page.status === 404 || page.status === 410) return null;
  if (page.status !== 200)
    throw new Error(`Fixture GET /addresses/resolve: HTTP ${page.status}`);
  const body = page.body;
  if (!body || typeof body !== 'object' || typeof (body as AddressView).holder !== 'string')
    return null;
  return body as AddressView;
}

async function addressAvailable(
  commands: PublicCommands,
  scope: string,
  key: string,
  actingSubject: string,
): Promise<boolean | null> {
  const page = await commands.inspect(
    `/addresses/availability?${new URLSearchParams({ scope, alias: key, actingSubject })}`,
  );
  if (page.status !== 200 || !page.body || typeof page.body !== 'object' || !('available' in page.body))
    return null;
  const available = (page.body as { available: unknown }).available;
  return typeof available === 'boolean' ? available : null;
}

async function controlsHolder(
  commands: PublicCommands,
  scope: 'agent' | 'space',
  holder: string,
  actingSubject: string,
): Promise<boolean> {
  const subject = scope === 'agent' ? holder : actingSubject;
  const page = await commands.inspect(
    `/addresses/current?${new URLSearchParams({ scope, holder, actingSubject: subject })}`,
  );
  if (page.status === 200) return true;
  if (page.status === 403 || page.status === 404) return false;
  throw new Error(`Fixture ${scope} control: HTTP ${page.status}`);
}

async function controlledAgent(
  commands: PublicCommands,
  displayName: string,
): Promise<string | null> {
  const page = await commands.inspect('/me/agents');
  if (page.status !== 200 || !page.body || typeof page.body !== 'object') return null;
  const items = (page.body as { items?: ControlledAgent[] }).items;
  if (!Array.isArray(items)) return null;
  return (
    items.find((item) => item.displayName?.value === displayName && item.actingSubject)
      ?.actingSubject ?? null
  );
}

async function publishedWorks(
  api: PublicCommands,
  actor: string,
): Promise<Map<string, WorkRecord>> {
  const found = new Map<string, WorkRecord>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const body = await api.find<{ items?: StudioWorkItem[]; nextCursor?: string | null }>(
      `/me/agents/${short(actor)}/works?${query}`,
    );
    if (!Array.isArray(body?.items)) return found;
    for (const item of body.items) {
      const text = item.texts?.find((entry) => entry.publicationHead && entry.contribution);
      if (!item.title?.value || !item.id || !item.mainVersion || !text?.contribution || !text.publicationHead)
        continue;
      if (!found.has(item.title.value))
        found.set(item.title.value, {
          work: item.id,
          mainVersion: item.mainVersion,
          contribution: text.contribution,
          publicationDecision: text.publicationHead,
        });
    }
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  return found;
}

async function existingChapter(
  api: PublicCommands,
  actor: string,
  work: string,
  name: string,
): Promise<DirectionFixture['laterChapter'] | null> {
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    const body = await api.find<{
      page?: { nextCursor?: string | null };
      facts?: { occurrence?: string; label?: { value?: string } | null }[];
    }>(`/me/agents/${short(actor)}/works/${short(work)}/chapters?${query}`);
    const match = body?.facts?.find((fact) => fact.label?.value === name && fact.occurrence);
    if (match?.occurrence) return { occurrence: match.occurrence, name };
    cursor = body?.page?.nextCursor ?? null;
    if (!body || !cursor) return null;
  }
  return null;
}

async function reuseNamedSpace(
  commands: PublicCommands,
  owner: string,
  name: string,
): Promise<SpaceRecord | null> {
  const listed = await commands.write<{
    result?: { items?: { id?: string; kind?: string; name?: { value?: string } }[] };
  }>('/query', {
    profile: 'resource-list-v1',
    context: 'global',
    scope: { kind: 'all' },
    sort: 'newest',
    limit: 20,
    q: name,
    filter: { all: [{ facet: 'type', any: ['https://rezics.com/vocab/Realm'] }] },
  });
  for (const item of listed.result?.items ?? []) {
    if (item.kind !== 'realm' || item.name?.value !== name || !item.id) continue;
    const header = await commands.find<{ profile?: string; space?: string; id?: string }>(
      `/realms/${short(item.id)}?${new URLSearchParams({ actingSubject: owner })}`,
    );
    if (header?.profile !== 'realm-read-v1' || !header.space || !header.id) continue;
    if (!(await controlsHolder(commands, 'space', header.space, owner))) continue;
    console.log(`[direction-9 setup] reuse space name ${name}`);
    return { space: header.space, realm: header.id, name };
  }
  return null;
}

export async function seedDirection(
  api: PublicCommands,
  actor: string,
  managerApi: PublicCommands,
  name = fixtureName,
  setup?: SetupPrincipal,
): Promise<DirectionFixture> {
  const suffix = createHash('sha256').update(`${name}:${actor}`).digest('hex').slice(0, 10);
  api = api.reusable(`${name}:${actor}:member`);
  managerApi = managerApi.reusable(`${name}:${actor}:operator`);
  const person = async (displayName: string, commands = api) =>
    (
      await commands.write<{ agent: string }>('/agents', {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName,
      })
    ).agent;
  const readerHandle = `d9-reader-${suffix}`;
  const [managerName, readerAddress, unnamedName] = await phase('people', () =>
    Promise.all([
      controlledAgent(managerApi, `Direction 9 manager ${suffix}`),
      allocateAddress(api, 'agent', readerHandle, actor),
      controlledAgent(api, `Direction 9 unnamed reader ${suffix}`),
    ]),
  );
  const manager = managerName ?? (await person(`Direction 9 manager ${suffix}`, managerApi));
  const unnamedPerson = unnamedName ?? (await person(`Direction 9 unnamed reader ${suffix}`));
  const namedPerson = readerAddress.holder ?? (await person(`Direction 9 reader ${suffix}`));
  const personHandle = readerAddress.key;
  const owner = setup?.actor ?? manager;
  const ownerApi = setup?.api.reusable(`${name}:${actor}:administrator`) ?? managerApi;
  const claim = (scope: string, holder: string, alias: string, actingSubject = manager) =>
    (actingSubject === manager ? managerApi : api).write('/addresses/claims', {
      profile: 'alias-write-v1',
      scope,
      holder,
      actingSubject,
      operation: 'claim', alias,
      expectedRevision: null,
    });
  if (!readerAddress.holder) await claim('agent', namedPerson, personHandle, namedPerson);

  // These journeys choose a published Concept; creating global vocabulary would
  // need an unrelated curator grant that a newly provisioned Person does not own.
  const topic = await phase('existing public topic', async () => {
    const page = await api.read<{ items: { concept: string; label: string }[] }>(
      `/concepts?${new URLSearchParams({ q: process.env.REZICS_DIRECTION_9_TOPIC ?? 'Fantasy', language: 'en', limit: '1' })}`,
    );
    const first = page.items[0];
    if (!first) throw new Error('Direction 9 needs one published Concept in the shared dataset');
    const names = await Promise.all(
      ['en', 'zh-Hant'].map((language) =>
        api.read<{ name: { value: string } }>(
          // ast-grep-ignore: web-links-use-address -- Main's Concept API takes a UUID; this is not a web entity link.
          `/concepts/${short(first.concept)}?language=${language}`,
        ),
      ),
    );
    return {
      concept: first.concept,
      name: names[0]!.name.value,
      names: { en: names[0]!.name.value, 'zh-Hant': names[1]!.name.value },
    };
  });
  const reusedZones = new Map<string, string>();
  const [spaceResult, workResult] = await Promise.allSettled([
    phase('spaces', () =>
      parallel(Array.from({ length: spaceCount }), async (_, index): Promise<SpaceRecord> => {
        const baseName = `Direction 9 ${suffix} community ${String(index + 1).padStart(2, '0')}`;
        const requested = index === 1 ? undefined : `d9-${suffix}-${index + 1}`;
        if (!requested) {
          const reused = await reuseNamedSpace(ownerApi, owner, baseName);
          if (reused) return reused;
          const record = await ownerApi.write<{ space: string; realm: string }>('/spaces', {
            profile: 'space-realm-v2',
            name: baseName,
            language: 'en',
            capabilities: ['realm'],
            topics: [topic.concept],
            actingSubject: owner,
          });
          return { ...record, name: baseName };
        }
        const allocated = await allocateAddress(ownerApi, 'space', requested, owner);
        if (allocated.holder) {
          const realm =
            allocated.capabilities?.realm ??
            (
              await ownerApi.read<{ realm: string }>(`/spaces/${short(allocated.holder)}`)
            ).realm;
          if (allocated.capabilities?.zone)
            reusedZones.set(allocated.holder, allocated.capabilities.zone);
          return {
            space: allocated.holder,
            realm,
            name: baseName,
            handle: allocated.key,
          };
        }
        const name =
          allocated.key === requested ? baseName : `${baseName} ${allocated.key.slice(-8)}`;
        const record = await ownerApi.write<{ space: string; realm: string }>('/spaces', {
          profile: 'space-realm-v2',
          name,
          language: 'en',
          capabilities: ['realm'],
          handle: allocated.key,
          topics: [topic.concept],
          actingSubject: owner,
        });
        return { ...record, name, handle: allocated.key };
      }),
    ),
    phase('published Works', async () => {
      const titles = [
        `Direction 9 rating Work ${suffix}`,
        `Direction 9 submitted story ${suffix}`,
        `Direction 9 chapter publication ${suffix}`,
      ];
      const known = await publishedWorks(api, actor);
      const works: WorkRecord[] = [];
      // Provisioning establishes the writer's grants. Finish one publication
      // before the next Work changes that writer's authority basis.
      for (const title of titles) {
        const existing = known.get(title);
        if (existing) {
          console.log(`[direction-9 setup] reuse work ${title}`);
          works.push(existing);
        } else works.push(await createWork(title, 'https://schema.org/Book'));
      }
      return works;
    }),
  ] as const);
  if (spaceResult.status === 'rejected') throw spaceResult.reason;
  if (workResult.status === 'rejected') throw workResult.reason;
  const spaces = spaceResult.value;
  const [work, story, chapterText] = workResult.value;
  await phase('Realm owner enrollment', () =>
    parallel(spaces, (space) =>
      ownerApi.write(`/realms/${short(space.realm)}/management`, { actingSubject: owner }),
    ),
  );
  const named = spaces[0]!,
    unnamed = spaces[1]!,
    unlisted = spaces[6]!;
  const privateSpaces = spaces.slice(2, 6);
  await phase('visibility', () =>
    parallel([...privateSpaces, unlisted], async (space) => {
      const isUnlisted = space === unlisted;
      const settings = {
        visibility: isUnlisted ? 'public' : 'private',
        listing: isUnlisted ? 'unlisted' : 'listed',
        admission: isUnlisted ? 'open' : 'request',
        history: 'everything',
      };
      const current = await ownerApi.read<{ generation: string; settings: typeof settings }>(
        `/spaces/${short(space.space)}/settings?actingSubject=${encodeURIComponent(owner)}`,
      );
      if (
        Object.entries(settings).every(
          ([key, value]) => current.settings?.[key as keyof typeof settings] === value,
        )
      )
        return;
      await ownerApi.write(
        `/spaces/${short(space.space)}/settings`,
        {
          actingSubject: owner,
          expectedGeneration: current.generation,
          reason: 'Direction 9 acceptance fixture',
          settings,
        },
        'PUT',
      );
    }),
  );
  if (setup)
    await phase('private admission managers', () =>
      parallel(privateSpaces, async (space) => {
        const hash = createHash('sha256')
          .update(`${name}:${space.realm}:admission-role`)
          .digest('hex');
        const roleId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const roles = await ownerApi.read<{ generation: string; roles: { id: string }[] }>(
          `/realms/${short(space.realm)}/roles?actingSubject=${encodeURIComponent(owner)}`,
        );
        const change = async (expectedGeneration: string, value: unknown) => {
          const impact = await ownerApi.write<{ digest: string }>(
            `/realms/${short(space.realm)}/role-impact`,
            {
              actingSubject: owner,
              expectedGeneration,
              reason: 'Direction 9 admission fixture',
              change: value,
            },
          );
          return ownerApi.write<{ generation: string }>(
            `/realms/${short(space.realm)}/role-changes`,
            {
              actingSubject: owner,
              expectedGeneration,
              reason: 'Direction 9 admission fixture',
              change: value,
              impactDigest: impact.digest,
            },
          );
        };
        let generation = roles.generation;
        if (!roles.roles.some((role) => role.id === roleId)) {
          generation = (
            await change(generation, {
              kind: 'role',
              roleId,
              name: 'Direction 9 admissions',
              permissions: ['realm.members.manage'],
            })
          ).generation;
        }
        await change(generation, {
          kind: 'assignment',
          roleId,
          member: manager,
          assigned: true,
          validUntil: '2026-12-31T00:00:00.000Z',
        });
      }),
    );
  async function createWork(title: string, type: string): Promise<WorkRecord> {
    const work = await api.write<{ work: string; mainVersion: string }>('/works', {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title,
      language: 'en',
      semanticTypes: [type],
      actingSubject: actor,
    });
    const contribution = await api.write<{ contribution: string; draftRevision: string }>(
      '/contributions',
      {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `Synthetic public acceptance text for ${title}.`,
        actingSubject: actor,
      },
    );
    const published = await api.write<{ publicationDecision: string }>(
      '/contribution-publications',
      {
        profile: 'text-publication-v1',
        contribution: contribution.contribution,
        expectedDraftHead: contribution.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: actor,
      },
    );
    await api.write('/publication-selections', {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work,
      contribution: contribution.contribution,
      publicationDecision: published.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: actor,
    });
    return {
      ...work,
      contribution: contribution.contribution,
      publicationDecision: published.publicationDecision,
    };
  }
  const laterName = `Direction 9 遠方 chapter ${chapterCount} ${suffix}`;
  const reusedChapter = await existingChapter(api, actor, story.work, laterName);
  if (reusedChapter) console.log(`[direction-9 setup] reuse chapter ${reusedChapter.name}`);
  const later =
    reusedChapter ??
    (await phase('chapters', async () => {
      const composition = await api.write<{ structure: string; revision: string }>('/compositions', {
        profile: 'book-composition',
        work: story.work,
        mainVersion: story.mainVersion,
        actingSubject: actor,
      });
      let head = composition.revision;
      let laterChapter!: DirectionFixture['laterChapter'];
      for (let offset = 0; offset < chapterCount; offset += 16) {
        const changed = await api.write<{ revision: string; occurrences: string[] }>(
          `/compositions/${short(composition.structure)}/changes`,
          {
            profile: 'book-composition',
            expectedHead: head,
            actingSubject: actor,
            operations: Array.from({ length: Math.min(16, chapterCount - offset) }, (_, index) => ({
              op: 'insert',
              parent: composition.structure,
              role: 'chapter',
              position: 'last',
              // A chapter Work opens at its containing story. Keep the Work whose
              // Overview supplies the rating picker independent of composition.
              target: chapterText.work,
              label: {
                value: offset + index + 1 === chapterCount ? laterName : `Chapter ${offset + index + 1}`,
                language: 'en',
              },
            })),
          },
        );
        head = changed.revision;
        if (offset + 16 >= chapterCount)
          laterChapter = { occurrence: changed.occurrences.at(-1)!, name: laterName };
      }
      return laterChapter;
    }));
  const mountStory = (zone: string, expectedHead: string) =>
    ownerApi.write(`/zones/${short(zone)}/mounts`, {
      expectedHead,
      target: story.work,
      routeSegment: 'story',
      disclosure: 'public',
      actingSubject: owner,
    });
  const zone = await phase('site mount', async () => {
    const onSpace = reusedZones.get(named.space);
    if (onSpace) {
      console.log(`[direction-9 setup] reuse zone ${short(onSpace)}`);
      const route = await ownerApi.find<{ kind?: string }>(
        `/zones/${short(onSpace)}/routes?${new URLSearchParams({ path: '/story', actingSubject: owner })}`,
      );
      if (route?.kind !== 'document' && route?.kind !== 'index') {
        const page = await ownerApi.read<{ revision: string }>(
          `/zones/${short(onSpace)}?${new URLSearchParams({ actingSubject: owner })}`,
        );
        await mountStory(onSpace, page.revision);
      }
      return onSpace;
    }
    const requested = zoneIri(`${name}:${actor}:zone`);
    const existing = await ownerApi.find<{ zone?: string }>(
      `/zones/${short(requested)}?${new URLSearchParams({ actingSubject: owner })}`,
    );
    const created = existing?.zone === requested ? zoneIri(`${name}:${actor}:zone:${requested}`) : requested;
    const site = await ownerApi.write<{ revision: string }>('/zones', {
      zone: created,
      space: named.space,
      name: named.name,
      language: 'en',
      disclosure: 'public',
      actingSubject: owner,
    });
    await mountStory(created, site.revision);
    return created;
  });
  return {
    actor,
    owner,
    manager,
    namedPerson,
    unnamedPerson,
    personHandle,
    spaces,
    named,
    unnamed,
    private: privateSpaces[0]!,
    privateSpaces,
    unlisted,
    work,
    story,
    chapterText,
    zone,
    topic,
    laterChapter: later,
  };
}

/** A rating setup failure belongs to the rating journey, not the other seven. */
export async function seedRatingPopulations(api: PublicCommands, fixture: DirectionFixture) {
  api = api.reusable(`${fixtureName}:${fixture.actor}:administrator`);
  await phase('21 rating populations', () =>
    parallel(
      fixture.spaces.filter(
        (space) =>
          !fixture.privateSpaces.some((privateSpace) => privateSpace.space === space.space) &&
          space.space !== fixture.unlisted.space,
      ),
      async (space) => {
        const context = await api.write<{ context: string }>('/rating-contexts', {
          profile: 'realm-standing-rating-context-v1',
          realm: space.realm,
          question: 'How much did you enjoy this Work?',
          actingSubject: fixture.owner,
        });
        await api.write('/rating-observations', {
          profile: 'realm-standing-rating-observation-v1',
          context: context.context,
          work: fixture.work.work,
          mainVersion: fixture.work.mainVersion,
          expectedRevisionHead: null,
          value: 8,
          actingSubject: fixture.owner,
        });
      },
    ),
  );
}

export interface FixtureStore {
  load(): DirectionFixture | null;
  save(fixture: DirectionFixture): void;
}

/** The manifest is disposable; stable public command keys also survive its loss. */
export function fixtureStore(origin: string, actor: string): FixtureStore {
  const key = createHash('sha256').update(`${fixtureName}:${origin}:${actor}`).digest('hex');
  const directory = resolve('.temp/direction-9/fixtures');
  const path = resolve(directory, `${key}.json`);
  return {
    load: () =>
      existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DirectionFixture) : null,
    save: (fixture) => {
      mkdirSync(directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(fixture), { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

export async function directionFixture(
  api: PublicCommands,
  actor: string,
  managerApi: PublicCommands,
  store: FixtureStore,
  setup?: SetupPrincipal,
): Promise<DirectionFixture> {
  const cached = store.load();
  if (cached?.actor === actor) {
    const existing = await api.find<unknown>(
      `/works/${short(cached.work.work)}?${new URLSearchParams({ actingSubject: cached.actor })}`,
    );
    if (existing !== null) {
      console.log(`[direction-9 setup] reuse ${fixtureName}: ${short(cached.work.work)}`);
      return cached;
    }
  }
  const fixture = await seedDirection(api, actor, managerApi, fixtureName, setup);
  // Save before readiness checks so a delayed projection never recreates records.
  store.save(fixture);
  console.log(`[direction-9 setup] created ${fixtureName}: ${short(fixture.work.work)}`);
  return fixture;
}

export async function readyDirection(
  api: PublicCommands,
  fixture: DirectionFixture,
  projection: 'ratings' | 'chapters' | 'communities',
) {
  await phase(`${projection} projection`, async () => {
    if (projection === 'ratings') {
      await api.until<{ items: { ratingCount: number }[] }>(
        `/rating-populations?${new URLSearchParams({ target: fixture.work.work, limit: '64' })}`,
        (page) => page.items.filter((item) => item.ratingCount >= 1).length >= populationCount,
      );
    } else if (projection === 'chapters') {
      await api.until<{ items: { occurrence: string }[] }>(
        `/reading-positions/${short(fixture.story.work)}?${new URLSearchParams({ q: fixture.laterChapter.name, actingSubject: fixture.actor })}`,
        (page) => page.items.some((item) => item.occurrence === fixture.laterChapter.occurrence),
      );
    } else {
      await api.until<{ result: { items: { id: string }[] } }>(
        '/query',
        (page) =>
          page.result.items.some(
            (item) => item.id === fixture.named.space || item.id === fixture.named.realm,
          ),
        {
          profile: 'resource-list-v1',
          context: 'global',
          scope: { kind: 'all' },
          sort: 'newest',
          limit: 20,
          q: fixture.named.name,
          filter: { all: [{ facet: 'type', any: ['https://rezics.com/vocab/Realm'] }] },
        },
      );
    }
  });
}

interface OwnRequest {
  id: string;
  state: string;
  requestGeneration: string;
}
interface OwnRequests {
  items: OwnRequest[];
  nextCursor: string | null;
}

export async function ownRequests(
  api: PublicCommands,
  fixture: DirectionFixture,
  space: SpaceRecord,
): Promise<OwnRequest[]> {
  const items: OwnRequest[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ actingSubject: fixture.actor, limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const page: OwnRequests | null = await api.find<OwnRequests>(
      `/realms/${short(space.realm)}/join-requests/mine?${query}`,
    );
    // The private owner deliberately returns 404 until this requester has an
    // intent. A fresh journey has no pending request or history to reset.
    if (page === null) return items;
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Append-only decisions stay intact; only the requester's current episode resets. */
export async function resetAdmission(
  api: PublicCommands,
  fixture: DirectionFixture,
  space: SpaceRecord,
) {
  const requests = await ownRequests(api, fixture, space);
  for (const request of requests.filter((item) => item.state === 'pending')) {
    await api.write(`/realms/${short(space.realm)}/join-requests/${request.id}/withdraw`, {
      actingSubject: fixture.actor,
      expectedRequestGeneration: request.requestGeneration,
      reason: 'Reset interrupted Direction 9 journey',
    });
  }
  const basis = await api.read<{
    state: string;
    membershipGeneration: string;
    policyRevision: string;
  }>(
    `/realms/${short(space.realm)}/join-requests/basis?${new URLSearchParams({ actingSubject: fixture.actor })}`,
  );
  if (basis.state === 'joined')
    await api.write('/access/membership-changes', {
      profile: 'access-membership-change-v1',
      kind: 'realm',
      action: 'leave',
      ownerSubject: space.realm,
      memberSubject: fixture.actor,
      expectedGeneration: basis.membershipGeneration,
      expectedPolicyRevision: basis.policyRevision,
    });
  return new Set(requests.map((item) => item.id));
}

export async function resetSubmission(
  api: PublicCommands,
  fixture: DirectionFixture,
  space: SpaceRecord,
) {
  const pending: { id: string; revision: string }[] = [];
  let cursor: string | null = null;
  do {
    const page: {
      items: { id: string; realm: string; work: string; revision: string }[];
      nextCursor: string | null;
    } = await api.read(
      `/my/submissions?${new URLSearchParams({
        actingSubject: fixture.actor,
        state: 'pending',
        limit: '20',
        ...(cursor ? { cursor } : {}),
      })}`,
    );
    pending.push(
      ...page.items.filter((item) => item.realm === space.realm && item.work === fixture.work.work),
    );
    cursor = page.nextCursor;
  } while (cursor);
  // Finish traversal before withdrawals change the cursor's inventory generation.
  for (const submission of pending) {
    await api.write(`/realms/${short(space.realm)}/submissions/${submission.id}/withdrawals`, {
      actingSubject: fixture.actor,
      expectedRevision: submission.revision,
    });
  }
}

/** Pending review is the reversible submission state; accepted custody persists. */
export async function prepareSubmissionReview(
  api: PublicCommands,
  fixture: DirectionFixture,
  space: SpaceRecord,
) {
  const current = await api.read<{
    generation: string;
    settings: Record<string, unknown> & { reviewMode?: string; reviewRequired: boolean };
    ruleBasis: { revision: string | null };
  }>(
    `/realms/${short(space.realm)}/settings?${new URLSearchParams({ actingSubject: fixture.owner })}`,
  );
  if (current.settings.reviewRequired && current.settings.reviewMode === 'mandatory') return;
  await api.write(
    `/realms/${short(space.realm)}/settings`,
    {
      actingSubject: fixture.owner,
      expectedGeneration: current.generation,
      expectedRulesRevision: current.ruleBasis.revision,
      reason: 'Direction 9 repeatable submission review',
      settings: { ...current.settings, reviewRequired: true, reviewMode: 'mandatory' },
    },
    'PUT',
  );
}
