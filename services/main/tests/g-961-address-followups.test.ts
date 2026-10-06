// sql-relations-allow: access.agent_handle -- G961 asserts the migration text that removes the historical bridge.
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Pool } from 'pg';
import { uuidToSid } from '@rezics/model/address/sid';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { addressRoutes } from '../src/routes/addresses.ts';
import { resourceRoutes } from '../src/routes/resources.ts';
import { canonicalAddresses } from '../src/modules/address/canonical.ts';
import { AliasInvalid } from '../src/modules/address/registry.ts';
import { resolveAddresses } from '../src/modules/address/resolution.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../src/modules/media/store.ts';
import { rateLimitFamily } from '../src/modules/rate-limit/routes.ts';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';
import { RV, prepareComponent } from '../src/modules/work/activate.ts';
import { listOfficialZones, readZonePublication } from '../src/modules/zone/publication.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';

const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const unknown = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const foreign = 'https://example.org/catalogue/日本語';
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']) => ({
  results: { bindings },
});

function fixture(spacePublic = false, zonePublic = false) {
  const queries: string[] = [],
    checks: string[] = [];
  const grants = new Set<string>();
  const current = {
    scope: 'space',
    holder: space,
    key: 'a-site',
    state: 'current',
    revision: '00000000-0000-4000-8000-000000000005',
  };
  const resources = (query: string) =>
    [...(query.match(/VALUES \?resource \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(
      (match) => match[1]!,
    );
  const graph = {
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('ASK')) return { boolean: true };
      if (query.includes('SELECT ?epoch ?sequence WHERE'))
        return rows([{ epoch: literal('epoch'), sequence: literal('7') }]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
        const wanted = query.match(/VALUES \?r \{([^}]*)\}/)?.[1] ?? '';
        const found = [space, zone]
          .filter((ref) => wanted.includes(`<${ref}>`))
          .map((ref) => ({
            epoch: literal('epoch'),
            sequence: literal('7'),
            r: uri(ref),
            type: literal(ref === space ? 'space' : 'zone'),
            public: literal(String(ref === space ? spacePublic : zonePublic)),
            label: { ...literal(ref === space ? 'A community' : 'A site'), 'xml:lang': 'en' },
          }));
        return rows(found.length ? found : [{ epoch: literal('epoch'), sequence: literal('7') }]);
      }
      if (query.includes('SELECT DISTINCT ?resource ?space ?disclosure'))
        return rows(
          resources(query).map((ref) => ({
            resource: uri(ref),
            space: uri(space),
            disclosure: uri(RV + (spacePublic ? 'Public' : 'Private')),
            ...(ref === zone
              ? { zoneDisclosure: uri(RV + (zonePublic ? 'Public' : 'Private')) }
              : {}),
          })),
        );
      if (query.includes('SELECT ?resource ?space ?site'))
        return rows(
          resources(query).map((ref) => ({
            resource: uri(ref),
            space: uri(space),
            site: literal(String(zonePublic)),
          })),
        );
      if (query.includes('SELECT DISTINCT ?resource ?space ?realm ?zone'))
        return rows(
          resources(query)
            .filter((ref) => ref === space || ref === zone)
            .map((ref) => ({ resource: uri(ref), space: uri(space), zone: uri(zone) })),
        );
      if (query.includes('SELECT DISTINCT ?space ?zone'))
        return rows([{ space: uri(space), zone: uri(zone) }]);
      throw new Error(`Unexpected graph query: ${query}`);
    },
  };
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    fuseki: graph,
    addresses: {
      withRead: async <T>(operation: () => Promise<T>) => operation(),
      identify: async (_scope: string, key: string) => ({
        holder:
          key === 'a-site'
            ? space
            : key === zone.slice(-36)
              ? zone
              : key === space.slice(-36)
                ? space
                : null,
        name: key === 'a-site' ? current : null,
      }),
      currents: async () => new Map([[`space\0${space}`, current]]),
      heads: async () => new Map([[`space\0${space}`, current]]),
    },
  } as unknown as WorkActivationEnvironment;
  const canReadSemantic = async (ref: string) => {
    checks.push(ref);
    return grants.has(ref);
  };
  const work = {
    environment: env,
    account: {
      verify: async (_request: Request, scopes: readonly string[]) => {
        expect(scopes.every((scope) => ['semantic:read', 'work:read'].includes(scope))).toBe(true);
        return { issuer: 'account', subject: 'reader' };
      },
    },
    access: {
      canReadSemanticResource: async (_principal: unknown, subject: string, ref: string) =>
        subject === actor && canReadSemantic(ref),
      canReadWork: async () => false,
    },
  } as unknown as MainWorkDependencies;
  const request = (authenticated = false) =>
    new Request('http://main.local/v1/addresses/resolve', {
      headers: authenticated ? { authorization: 'Bearer reader' } : {},
    });
  const read = (reader = {}) =>
    readResourceSummaries(env, undefined, reader, {
      resources: [space, zone],
      context: DEFAULT_MEDIA_CONTEXT,
      language: null,
    });
  return { env, work, grants, queries, checks, read, request, canReadSemantic };
}

test('G961: private Space and Zone summaries require both Access grants and omit private slugs', async () => {
  const f = fixture();
  expect((await f.read()).summaries).toEqual(
    [space, zone].map((reference) => ({ reference, status: 'unavailable' })),
  );
  f.grants.add(zone);
  expect(
    (await f.read({ canReadSemantic: f.canReadSemantic })).summaries.every(
      (summary) => summary.status === 'unavailable',
    ),
  ).toBe(true);
  f.grants.add(space);
  const batch = await f.read({ canReadSemantic: f.canReadSemantic });
  expect(batch.summaries).toMatchObject(
    [space, zone].map((reference) => ({
      reference,
      status: 'available',
      disclosure: 'restricted',
      address: { prefix: '/z/', key: 'a-site', suffixSource: '' },
    })),
  );
  expect(batch.cost).toMatchObject({ graphQueries: 4, accessChecks: 6, accessQueries: 6 });
});

test('G961: a public Zone in a private Space remains unavailable to a denied reader', async () => {
  const f = fixture(false, true);
  expect((await f.read()).summaries.every((summary) => summary.status === 'unavailable')).toBe(
    true,
  );
  f.grants.add(space);
  expect((await f.read({ canReadSemantic: f.canReadSemantic })).summaries).toMatchObject([
    { status: 'available', disclosure: 'restricted' },
    { status: 'available', disclosure: 'restricted' },
  ]);
});

test('G961: Realm admission reads its private Space but never supplies a private Zone grant', async () => {
  const f = fixture();
  const query = f.env.fuseki.query.bind(f.env.fuseki);
  f.env.fuseki.query = async (text, ...args) => {
    const result = await query(text, ...args);
    if (text.includes('SELECT DISTINCT ?resource ?space ?disclosure')) {
      for (const row of result.results?.bindings ?? []) row.realm = uri(actor);
    }
    return result;
  };
  const reader = {
    canReadSemantic: f.canReadSemantic,
    realmReadProof: async (realm: string) => (realm === actor ? 'live-membership' : null),
  };
  expect((await f.read(reader)).summaries).toMatchObject([
    { status: 'available', disclosure: 'restricted' },
    { status: 'unavailable' },
  ]);
  f.grants.add(zone);
  expect((await f.read(reader)).summaries.every((summary) => summary.status === 'available')).toBe(
    true,
  );
});

test('G961: a private Zone does not appear in the capabilities of a readable public Space', async () => {
  const f = fixture(true, false);
  const lookup = { scope: 'space' as const, key: 'a-site' };
  expect((await resolveAddresses(f.work, f.request(), [lookup]))[0]).toMatchObject({
    status: 'resolved',
    canonical: { prefix: '/r/', key: 'a-site' },
    capabilities: {},
  });
  expect(
    (await resolveAddresses(f.work, f.request(), [{ scope: 'space', key: zone.slice(-36) }]))[0],
  ).toEqual({ scope: 'space', key: zone.slice(-36), status: 'unavailable' });
  f.grants.add(zone);
  expect((await resolveAddresses(f.work, f.request(true), [lookup], actor))[0]).toMatchObject({
    status: 'resolved',
    canonical: { prefix: '/z/', key: 'a-site', suffixSource: '' },
    capabilities: { zone },
  });
});

test('G961: viewer-aware single and batch resolution returns the same canonical private Site', async () => {
  const f = fixture();
  f.grants.add(space);
  f.grants.add(zone);
  const app = new Elysia().use(addressRoutes(f.work));
  const lookup = { scope: 'space', key: 'a-site' };
  const path = `http://main.local/v1/addresses/resolve?${new URLSearchParams({ ...lookup, actingSubject: actor })}`;
  const denied = await app.handle(new Request(path));
  expect(denied.status).toBe(404);
  expect(await denied.json()).toMatchObject({ code: 'address_not_found' });
  const headers = { authorization: 'Bearer reader', 'content-type': 'application/json' };
  const resolved = await app.handle(new Request(path, { headers }));
  expect(resolved.status).toBe(200);
  const result = await resolved.json();
  expect(result).toMatchObject({
    holder: space,
    canonical: { prefix: '/z/', key: 'a-site', suffixSource: '' },
    capabilities: { zone },
  });
  const batch = await app.handle(
    new Request('http://main.local/v1/addresses/resolutions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ lookups: [lookup], actingSubject: actor }),
    }),
  );
  expect(batch.status).toBe(200);
  expect(await batch.json()).toEqual({ results: [result] });
  f.grants.clear();
  expect((await app.handle(new Request(path, { headers }))).status).toBe(404);
});

test('G961: authenticated resolutions cannot omit their acting subject', async () => {
  const f = fixture();
  await expect(
    resolveAddresses(f.work, f.request(true), [{ scope: 'space', key: 'a-site' }]),
  ).rejects.toBeInstanceOf(AliasInvalid);
});

test('G961: grants revoked during media hydration cannot disclose page names or canonical addresses', async () => {
  const f = fixture();
  f.grants.add(space);
  f.grants.add(zone);
  const media = {
    avatarRows: async () => {
      f.grants.clear();
      return { rows: new Map(), generation: { dataEpoch: 'media', sequence: '1' } };
    },
  } as unknown as MediaStore;
  const batch = await readResourceSummaries(
    f.env,
    media,
    { canReadSemantic: f.canReadSemantic },
    { resources: [space, zone], context: DEFAULT_MEDIA_CONTEXT, language: null },
  );
  expect(batch.summaries).toEqual(
    [space, zone].map((reference) => ({ reference, status: 'unavailable' })),
  );
});

test('G961: mixed summary references preserve order and duplicates without querying foreign IRIs', async () => {
  const f = fixture(true, true);
  const resources = [foreign, space, unknown, foreign, 'urn:example:missing'];
  const batch = await readResourceSummaries(
    f.env,
    undefined,
    {},
    { resources, context: DEFAULT_MEDIA_CONTEXT, language: null },
  );
  expect(batch.summaries.map((summary) => summary.reference)).toEqual(resources);
  expect(batch.summaries.map((summary) => summary.status)).toEqual([
    'unavailable',
    'available',
    'unavailable',
    'unavailable',
    'unavailable',
  ]);
  expect(batch.summaries[0]).toEqual({ reference: foreign, status: 'unavailable' });
  expect(
    f.queries.some((query) => query.includes(foreign) || query.includes('urn:example:missing')),
  ).toBe(false);
  const onlyForeign = await readResourceSummaries(
    f.env,
    undefined,
    {},
    { resources: [foreign], context: DEFAULT_MEDIA_CONTEXT, language: null },
  );
  expect(onlyForeign.summaries).toEqual([{ reference: foreign, status: 'unavailable' }]);
  expect(onlyForeign.cost).toMatchObject({ graphQueries: 1, accessChecks: 0 });
});

test('G961: summary batch HTTP accepts non-native IRIs but keeps the batch and reference bounds', async () => {
  const f = fixture(true, true);
  const app = new Elysia().use(resourceRoutes(f.env.fuseki, f.work));
  const send = (resources: string[]) =>
    app.handle(
      new Request('http://main.local/v1/resources/summaries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'resource-summary-batch-v1', resources }),
      }),
    );
  const response = await send([foreign, unknown]);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    complete: true,
    summaries: [foreign, unknown].map((reference) => ({ reference, status: 'unavailable' })),
  });
  expect((await send(Array(65).fill(foreign))).status).toBe(422);
  expect((await send(['https://example.org/' + 'x'.repeat(2048)])).status).toBe(422);
  expect((await send(['<https://example.org/>'])).status).toBe(422);
});

test('G961: Zone summary addresses use the owning Space identity without a public-site flag', async () => {
  const f = fixture();
  const addresses = await canonicalAddresses(f.env, [
    { reference: zone, type: 'zone', disclosure: 'restricted', name: { value: 'A private site' } },
  ]);
  expect(addresses.get(zone)).toEqual({ prefix: '/z/', key: 'a-site', suffixSource: '' });
  f.env.addresses!.currents = async () => new Map();
  expect(
    (
      await canonicalAddresses(f.env, [
        { reference: zone, type: 'zone', name: { value: 'A site' } },
      ])
    ).get(zone),
  ).toEqual({ prefix: '/z/', key: uuidToSid(space.slice(-36)), suffixSource: 'A site' });
});

test('G961: standalone and official Zone reads share canonical Space addresses and rename generations', async () => {
  const f = fixture(true, true);
  const directory = mkdtempSync('.temp/g-961-publication-');
  const configuration = {
    format: ZONE_CONFIG_FORMAT,
    zone,
    space,
    navigation: unknown,
    state: 'active',
    disclosure: 'public',
    budget: { timeMs: 2000, rows: 1000 },
    queryBlocks: [],
    model: ZONE_PROFILE,
    official: {},
    defaultRealm: actor,
  };
  const manifest = prepareComponent(
    directory,
    zone,
    { configuration, name: 'A site', language: 'en' },
    ZONE_PROFILE,
  );
  const env = {
    ...f.env,
    objectDirectory: directory,
    fuseki: {
      query: async (query: string) => {
        if (query.includes('ASK')) return { boolean: true };
        if (query.includes('SELECT ?space ?navigation ?head'))
          return rows([
            {
              space: uri(space),
              navigation: uri(unknown),
              head: uri(actor),
              manifest: uri(`urn:rezics:sha256:${manifest}`),
              state: uri(RV + 'Active'),
              disclosure: uri(RV + 'Public'),
              spaceDisclosure: uri(RV + 'Public'),
              listing: literal('listed'),
              official: literal('true'),
              realm: uri(actor),
            },
          ]);
        if (query.includes('SELECT ?zone ?realm ?space ?name'))
          return rows([
            {
              zone: uri(zone),
              realm: uri(actor),
              space: uri(space),
              name: literal('A site'),
            },
          ]);
        throw new Error(`Unexpected publication query: ${query}`);
      },
    },
  } as unknown as WorkActivationEnvironment;
  try {
    const publication = await readZonePublication(env, zone);
    expect(publication).toMatchObject({
      address: { prefix: '/z/', key: 'a-site', suffixSource: 'A site' },
      official: 'a-site',
    });
    expect((await listOfficialZones(env, { limit: 50 })).items[0]).toMatchObject({
      address: publication.address,
      routeSegment: 'a-site',
    });
    env.addresses!.currents = async () =>
      new Map([[`space\0${space}`, { key: 'renamed-site' }]]) as never;
    const renamed = await readZonePublication(env, zone);
    expect(renamed.address.key).toBe('renamed-site');
    expect(renamed.etag).not.toBe(publication.etag);
    env.addresses!.currents = async () => new Map();
    expect((await readZonePublication(env, zone)).address).toEqual({
      prefix: '/z/',
      key: uuidToSid(space.slice(-36)),
      suffixSource: 'A site',
    });
    expect((await listOfficialZones(env, { limit: 50 })).items[0]?.address.key).toBe(
      uuidToSid(space.slice(-36)),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G961: the ten G956 live operations retain explicit policies and whole-path boundaries', () => {
  const reads = [
    '/v1/agents/{id}/listing',
    '/v1/spaces/{space}/settings',
    '/v1/realms/{realm}/join-page',
    '/v1/realms/{realm}/join-requests',
    '/v1/realms/{realm}/join-requests/basis',
  ];
  const writes = [
    ['PUT', reads[0]!],
    ['PUT', reads[1]!],
    ['POST', reads[3]!],
    ['POST', '/v1/realms/{realm}/join-requests/{request}/decisions'],
    ['POST', '/v1/realms/{realm}/join-requests/{request}/withdraw'],
  ];
  for (const path of reads) {
    expect(rateLimitFamily('GET', path)).toBeNull();
    expect(rateLimitFamily('HEAD', path)).toBeNull();
  }
  for (const [method, path] of writes) {
    expect(rateLimitFamily(method!, path!)).toBe('write');
    expect(rateLimitFamily(method!, path! + '-lookalike')).toBeUndefined();
  }
});

test('G961: reply mentions read only current Agent names from the registry', async () => {
  const recipient = '00000000-0000-4000-8000-000000000006';
  const principal = '00000000-0000-4000-8000-000000000007';
  const revision = '00000000-0000-4000-8000-000000000008';
  let registryQuery = '';
  const access = {
    query: async (sql: string, args: unknown[]) => {
      expect(sql).not.toContain('agent_handle');
      if (sql.includes('FROM access.admission')) return { rows: [{ principal_id: principal }] };
      if (sql.includes('FROM access.alias_registry')) {
        registryQuery = sql;
        expect(args).toEqual([['current-name', 'current_name', 'old_name']]);
        return { rows: [{ agent_id: space }] };
      }
      if (sql.includes('FROM access.representation'))
        return { rows: args[0] === space ? [{ id: recipient }] : [] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const content = {
    query: async (sql: string) => ({
      rows: sql.includes('FROM content.reply p')
        ? [
            {
              reply: zone,
              author: actor,
              revisionId: revision,
              body: `Hello @CURRENT-NAME, @CURRENT_NAME and @old_name. Invalid @_bad, @bad_ and @${'x'.repeat(31)}; email@example.org and @current_name日本語`,
              document: null,
            },
          ]
        : [],
    }),
  } as unknown as Pool;
  const relayClient = {
    query: async (sql: string) => {
      if (sql.includes('FROM relay.notification_producer_cursor'))
        return { rows: [{ data_epoch: 'epoch', sequence: '0' }] };
      if (sql.includes('FROM relay.delivered_batch'))
        return { rows: [{ sequence: '1', event_count: 1 }] };
      if (sql.includes('FROM relay.delivered_event'))
        return {
          rows: [
            {
              envelope: {
                id: 'event',
                type: 'com.rezics.realm.reply-placed.v1',
                data: {
                  receipt: {
                    realm: space,
                    reply: zone,
                    rootTarget: space,
                    rootRevision: space,
                    contentRevision: `urn:rezics:content:revision:${revision}`,
                    author: actor,
                    parentReply: null,
                    admissionId: principal,
                  },
                },
              },
            },
          ],
        };
      return { rows: [] };
    },
    release: () => {},
  };
  const relay = { connect: async () => relayClient } as unknown as Pool;
  const checkpoint = {
    query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '1' }] }),
  } as unknown as Pool;
  const emitted: NotificationEvent[] = [];
  const producer = new NotificationProducer(
    access,
    relay,
    content,
    { query: async () => rows([]) },
    {
      enqueue: async (event) => {
        if (event.relationshipPlan) return [];
        emitted.push(event);
        return undefined as never;
      },
    },
    'graph',
    checkpoint,
  );
  expect(await producer.runRelayOnce()).toBe(1);
  expect(registryQuery).toContain("scope = 'agent'");
  expect(registryQuery).toContain("state = 'current'");
  expect(registryQuery).toContain('LIMIT 21');
  expect(emitted).toMatchObject([{ topic: 'mention', recipients: [recipient] }]);
  expect(
    readFileSync('services/main/migrations/access/1024_drop_agent_handle_bridge.sql', 'utf8'),
  ).toContain('DROP VIEW IF EXISTS access.agent_handle');
});
