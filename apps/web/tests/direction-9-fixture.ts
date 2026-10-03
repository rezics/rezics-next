import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PublicResponse {
  status(): number;
  json(): Promise<unknown>;
  headers?(): Record<string, string>;
}
export interface PublicRequest {
  get(path: string): Promise<PublicResponse>;
  fetch(
    path: string,
    options: { method: string; data: unknown; headers: Record<string, string> },
  ): Promise<PublicResponse>;
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
  // Never follow a brief's absolute path back into the main checkout.
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
  zone: string;
  topic: { concept: string; name: string; names: Record<'en' | 'zh-Hant', string> };
  laterChapter: { occurrence: string; name: string };
}

export const short = (iri: string) => iri.slice(-36);
export const fixtureName = 'direction-9-v3';
export const populationCount = 21;
export const chapterCount = 51;
const spaceCount = populationCount + 5; // Four private journeys and one unlisted Space.

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
  const person = async (name: string, commands = api) =>
    (
      await commands.write<{ agent: string }>('/agents', {
        profile: 'agent-provision-v1',
        kind: 'person',
        displayName: name,
      })
    ).agent;
  const [manager, namedPerson, unnamedPerson] = await phase('people', () =>
    Promise.all([
      person(`Direction 9 manager ${suffix}`, managerApi),
      person(`Direction 9 reader ${suffix}`),
      person(`Direction 9 unnamed reader ${suffix}`),
    ]),
  );
  const owner = setup?.actor ?? manager;
  const ownerApi = setup?.api.reusable(`${name}:${actor}:administrator`) ?? managerApi;
  const personHandle = `d9-reader-${suffix}`;
  const claim = (scope: string, holder: string, name: string, actingSubject = manager) =>
    (actingSubject === manager ? managerApi : api).write('/addresses/claims', {
      profile: 'name-write-v1',
      scope,
      holder,
      actingSubject,
      operation: 'claim',
      name,
      expectedRevision: null,
    });
  await claim('agent', namedPerson, personHandle, namedPerson);

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
  const [spaceResult, workResult] = await Promise.allSettled([
    phase('spaces', () =>
      parallel(Array.from({ length: spaceCount }), async (_, index): Promise<SpaceRecord> => {
        const name = `Direction 9 ${suffix} community ${String(index + 1).padStart(2, '0')}`;
        const handle = index === 1 ? undefined : `d9-${suffix}-${index + 1}`;
        const record = await ownerApi.write<{ space: string; realm: string }>('/spaces', {
          profile: 'space-realm-v2',
          name,
          language: 'en',
          capabilities: ['realm'],
          ...(handle ? { handle } : {}),
          topics: [topic.concept],
          actingSubject: owner,
        });
        return { ...record, name, ...(handle ? { handle } : {}) };
      }),
    ),
    phase('published Works', () =>
      parallel([`Direction 9 Work ${suffix}`, `Direction 9 story ${suffix}`], (title) =>
        createWork(title, 'https://schema.org/Book'),
      ),
    ),
  ] as const);
  if (spaceResult.status === 'rejected') throw spaceResult.reason;
  if (workResult.status === 'rejected') throw workResult.reason;
  const spaces = spaceResult.value;
  const [work, story] = workResult.value;
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
  const later = await phase('chapters', async () => {
    const composition = await api.write<{ structure: string; revision: string }>('/compositions', {
      profile: 'book-composition',
      work: story.work,
      mainVersion: story.mainVersion,
      actingSubject: actor,
    });
    let head = composition.revision;
    let laterChapter!: DirectionFixture['laterChapter'];
    for (let offset = 0; offset < chapterCount; offset += 16) {
      const name = `Direction 9 遠方 chapter ${chapterCount} ${suffix}`;
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
            target: work.work,
            label: {
              value: offset + index + 1 === chapterCount ? name : `Chapter ${offset + index + 1}`,
              language: 'en',
            },
          })),
        },
      );
      head = changed.revision;
      if (offset + 16 >= chapterCount)
        laterChapter = { occurrence: changed.occurrences.at(-1)!, name };
    }
    return laterChapter;
  });
  const zoneHash = createHash('sha256').update(`${name}:${actor}:zone`).digest('hex');
  const zone = `https://rezics.com/id/${zoneHash.slice(0, 8)}-${zoneHash.slice(8, 12)}-4${zoneHash.slice(13, 16)}-a${zoneHash.slice(17, 20)}-${zoneHash.slice(20, 32)}`;
  await phase('site mount', async () => {
    const site = await ownerApi.write<{ revision: string }>('/zones', {
      zone,
      space: named.space,
      name: named.name,
      language: 'en',
      disclosure: 'public',
      actingSubject: owner,
    });
    await ownerApi.write(`/zones/${short(zone)}/mounts`, {
      expectedHead: site.revision,
      target: story.work,
      routeSegment: 'story',
      disclosure: 'public',
      actingSubject: owner,
    });
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
