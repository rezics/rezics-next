import { expect, test } from 'bun:test';
import { SeedApi, type SeedEndpoints } from '../../../scripts/dev/seed/api.ts';
import { seedAccounts } from '../../../scripts/dev/seed/accounts-step.ts';
import { people } from '../../../scripts/dev/seed/plan.ts';
import { communityPeople } from '../../../scripts/dev/seed/community-plan.ts';
import type { SeedState } from '../../../scripts/dev/seed/state.ts';
import { parseOptions, steps } from '../../../scripts/dev/seed/cli.ts';
import {
  officialBuildBundle,
  officialSourceDigest,
} from '../../../scripts/dev/seed/official-theme-step.ts';
import { officialTheme } from '../../../scripts/dev/seed/official-plan.ts';
import {
  applyOfficialWiki,
  seedOfficialWiki,
  wikiChapterLabels,
  wikiZone,
} from '../../../scripts/dev/seed/official-wiki-step.ts';
import { checkFirstPartyBundle } from '../../../services/main/src/modules/theme/first-party-bundle.ts';

function fixture() {
  let sequence = 0;
  const iri = () =>
    `https://rezics.com/id/00000000-0000-4000-a000-${String(++sequence).padStart(12, '0')}`;
  const actor = iri(),
    space = iri(),
    realm = iri();
  let zoneHead = iri();
  let configuration: Record<string, unknown> = { budget: { timeMs: 1000 }, queryBlocks: [] };
  const compositions = new Map<
    string,
    { structure: string; revision: string; occurrences: Record<string, unknown>[] }
  >();
  const collections = new Map<
    string,
    { structure: string; revision: string; occurrences: Record<string, unknown>[] }
  >();
  const mounts: Record<string, unknown>[] = [];
  const receipts = new Map<string, { body: string; result: unknown }>();
  const calls: { method: string; path: string; body?: Record<string, unknown>; key?: string }[] =
    [];
  let chapterBatches = 0;
  let deniedBatch: number | undefined;
  let loseResponse = false;
  let writes = 0;
  const api = new SeedApi({ main: 'http://wiki.test' } as SeedEndpoints, async (url, init) => {
    const parsed = new URL(url),
      path = parsed.pathname;
    const method = init?.method ?? 'GET';
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path, body, key });
    if (method === 'GET') {
      if (path.endsWith('/configuration'))
        return Response.json({ revision: zoneHead, configuration });
      if (path.includes('/zones/')) return Response.json({ revision: zoneHead, mounts });
      const value = compositions.get(path.slice(-36)) ?? collections.get(path.slice(-36));
      if (!value) throw new Error(`Unexpected read: ${path}`);
      const offset = Number(parsed.searchParams.get('after') ?? 0),
        limit = Number(parsed.searchParams.get('limit'));
      const next = offset + limit < value.occurrences.length ? String(offset + limit) : null;
      return Response.json({
        ...value,
        occurrences: value.occurrences.slice(offset, offset + limit),
        next,
      });
    }
    const previous = receipts.get(key!);
    if (previous) {
      if (previous.body !== JSON.stringify(body))
        return Response.json({ code: 'idempotency_conflict' }, { status: 409 });
      return Response.json({ ...(previous.result as object), replayed: true });
    }
    let result: unknown = { replayed: false };
    if (path === '/v1/spaces') result = { space, realm };
    else if (path === '/v1/zones') result = { zone: wikiZone, revision: zoneHead };
    else if (path === '/v1/works') result = { work: iri(), mainVersion: iri() };
    else if (path === '/v1/contributions') result = { contribution: iri(), draftRevision: iri() };
    else if (path === '/v1/contribution-publications') result = { publicationDecision: iri() };
    else if (path === '/v1/publication-selections') result = {};
    else if (path === '/v1/compositions' || path === '/v1/collections') {
      const structure = path.endsWith('/collections') ? (body!.collection as string) : iri();
      const value = { structure, revision: iri(), occurrences: [] as Record<string, unknown>[] };
      (path.endsWith('/collections') ? collections : compositions).set(structure.slice(-36), value);
      result = { structure, revision: value.revision };
    } else if (path.endsWith('/changes')) {
      const structure = path.split('/')[3]!;
      const current = compositions.get(structure) ?? collections.get(structure)!;
      if (body!.expectedHead !== current.revision)
        return Response.json({ code: 'stale_head' }, { status: 409 });
      if (path.includes('/compositions/') && ++chapterBatches === deniedBatch)
        return Response.json({ code: 'fixture_denied' }, { status: 403 });
      const operations = body!.operations as Record<string, unknown>[];
      for (const operation of operations)
        current.occurrences.push({ ...operation, occurrence: iri() });
      current.revision = iri();
      result = { revision: current.revision };
    } else if (path.endsWith('/mounts')) {
      expect(body!.expectedHead).toBe(zoneHead);
      mounts.push({
        target: body!.target,
        state: 'active',
        qualifier: { routeSegment: body!.routeSegment },
      });
      zoneHead = iri();
      result = { revision: zoneHead };
    } else if (path.endsWith('/configuration')) {
      expect(body!.expectedHead).toBe(zoneHead);
      const { expectedHead: _head, actingSubject: _actor, ...patch } = body!;
      configuration = { ...configuration, ...patch };
      zoneHead = iri();
      result = { revision: zoneHead };
    } else throw new Error(`Unexpected write: ${method} ${path}`);
    writes++;
    receipts.set(key!, { body: JSON.stringify(body), result });
    if (loseResponse && path.includes('/compositions/') && path.endsWith('/changes')) {
      loseResponse = false;
      throw new TypeError('Response lost after commit');
    }
    return Response.json(result);
  });
  const port = {
    api,
    official: api,
    actor,
    token: 'writer-token',
    officialToken: 'operator-token',
    prepareWork: async () => {},
  };
  return {
    port,
    calls,
    mounts,
    compositions,
    collections,
    writeCount: () => writes,
    interrupt: (batch?: number) => {
      deniedBatch = batch;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

test('G-999 official wiki is seeded through schema-checked public commands and replays with no new data writes', async () => {
  const h = fixture();
  const result = await applyOfficialWiki(h.port);
  expect(result).toMatchObject({ zone: wikiZone, chapters: 51 });
  expect(
    h.mounts.map((mount) => (mount.qualifier as { routeSegment: string }).routeSegment),
  ).toEqual(['franchise', 'characters', 'places', 'events', 'chapters']);
  const chapterCalls = h.calls.filter(
    (call) => call.path.includes('/compositions/') && call.method === 'POST',
  );
  expect(chapterCalls.map((call) => (call.body!.operations as unknown[]).length)).toEqual([
    16, 16, 16, 3,
  ]);
  expect(h.calls.filter((call) => call.path === '/v1/contribution-publications')).toHaveLength(2);
  const before = h.writeCount();
  expect(await applyOfficialWiki(h.port)).toEqual(result);
  expect(h.writeCount()).toBe(before);
});

test('G-999 a denied interrupted seed resumes its exact chapter inventory without duplicates', async () => {
  const h = fixture();
  h.interrupt(2);
  await expect(applyOfficialWiki(h.port)).rejects.toThrow('HTTP 403');
  const composition = [...h.compositions.values()][0]!;
  expect(composition.occurrences).toHaveLength(16);
  const original = composition.occurrences.map((item) => item.occurrence);
  h.interrupt();
  await applyOfficialWiki(h.port);
  expect(composition.occurrences).toHaveLength(51);
  expect(composition.occurrences.slice(0, 16).map((item) => item.occurrence)).toEqual(original);
  expect(new Set(composition.occurrences.map((item) => item.sourceKey)).size).toBe(51);
});

test('G-999 a lost chapter response replays the same body and key instead of inserting twice', async () => {
  const h = fixture();
  h.loseResponse();
  await applyOfficialWiki(h.port);
  const calls = h.calls.filter(
    (call) => call.path.includes('/compositions/') && call.method === 'POST',
  );
  expect(calls[0]).toEqual(calls[1]);
  expect([...h.compositions.values()][0]!.occurrences).toHaveLength(51);
});

test('G-999 replay traverses later inventory pages and preserves unrelated chapters and members', async () => {
  const h = fixture();
  await applyOfficialWiki(h.port);
  const composition = [...h.compositions.values()][0]!;
  composition.occurrences.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({
      occurrence: `unrelated-${index}`,
      role: 'chapter',
      sourceKey: `reader-${index}`,
    })),
  );
  const franchise = [...h.collections.values()][0]!;
  franchise.occurrences.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({ role: 'member', target: `other-${index}` })),
  );
  const before = h.writeCount();
  await applyOfficialWiki(h.port);
  expect(h.writeCount()).toBe(before);
  expect(composition.occurrences).toHaveLength(151);
  expect(franchise.occurrences).toHaveLength(101);
  expect(
    h.calls.some((call) => call.path.includes('/compositions/') && call.method === 'GET'),
  ).toBe(true);
});

test('G-999 wiki seed belongs to the normal workflow and has a mutually exclusive focused mode', () => {
  expect(steps).toContain(seedOfficialWiki);
  expect(parseOptions(['--wiki-only']).wikiOnly).toBe(true);
  for (const mode of ['--themes-only', '--zones-only'])
    expect(() => parseOptions(['--wiki-only', mode])).toThrow('Usage:');
  expect(wikiChapterLabels).toHaveLength(51);
  expect(new Set(wikiChapterLabels).size).toBe(51);
  expect(wikiChapterLabels.at(-1)).toContain('遠方');
});

test('G-999 franchise wiki approval binds its own host, source digest and three installed slots', async () => {
  const digest = await officialSourceDigest('franchise-wiki');
  const bundle = await officialBuildBundle(
    'franchise-wiki',
    digest,
    wikiZone,
    {
      entry: { src: 'zones/official/franchise-wiki/index.tsx', file: '_next/static/wiki.js' },
      style: {
        src: 'zones/official/franchise-wiki/franchise-wiki.css?raw',
        file: '_next/static/wiki-css.js',
      },
    },
    async (path) => new TextEncoder().encode(path),
  );
  expect(checkFirstPartyBundle(bundle).bundle).toMatchObject({
    hostZone: wikiZone,
    packageDigest: digest,
    slots: ['entity', 'home', 'memberIndex'],
  });
  expect(officialTheme('franchise-wiki')).not.toBe(officialTheme('fiction'));
});

test('G-999 account replay leaves matching demo handles intact when an older claim receipt is absent', async () => {
  const persons = [...people, ...communityPeople];
  let selected = persons[0]!;
  const api = {
    signInOrUp: async (person: typeof selected) => {
      selected = person;
      return { id: person.id, cookie: 'cookie' };
    },
    token: async () => 'token',
    post: async (path: string) => {
      expect(path).toBe('/v1/agents');
      return { agent: `https://rezics.com/id/${selected.id}`, state: 'active' };
    },
    getPublic: async () => ({
      revision: 'head',
      displayName: selected.name,
      handle: selected.handle,
      avatarSelection: null,
      bio: null,
    }),
  } as unknown as SeedApi;
  const state = {
    api,
    endpoints: {},
    fixture: {},
    sessions: [],
    agentCount: 0,
    findings: new Set(),
    penAgents: new Map(),
    optional: async () => null,
  } as unknown as SeedState;
  await seedAccounts(state);
  expect(state.sessions.map((session) => session.id)).toEqual(persons.map((person) => person.id));
  expect(state.agentCount).toBe(persons.length);
});
