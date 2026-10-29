import { afterAll, beforeAll, expect, test } from 'bun:test';
import { UI_LOCALES } from '@rezics/composition';
import { Compile } from 'typebox/compile';
import { activeProfile } from '../../src/presentation/profiles.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { ZonePageResponseSchema } from '../../src/zones/contract.ts';
import { createBody, page, problem, resourceFixture, type Persona, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const path = (id: string) => `/v1/zones/${id}`;
const complete = (answer: Awaited<ReturnType<ResourceFixture['call']>>) => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(Compile(ZonePageResponseSchema).Check(answer.body)).toBe(true);
  expect(Object.keys(answer.body).sort()).toEqual(['document', 'profile', 'reads', 'template', 'zone']);
  expect(answer.headers.get('cache-control')).toBe('private, no-store');
  return answer.body;
};
const read = (id: string, who: Persona = 'anonymous', route = '', cursor?: string) =>
  f.call(who, 'POST', `${path(id)}:readPage${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, {
    target: { route },
  });
async function publish(id: string, revision: string, visibility: string) {
  const answer = await f.call('owner', 'POST', `${path(id)}:publish`, { visibility }, f.conditional(revision));
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.zone.revision as string;
}
async function grant(id: string, revoke = false) {
  const answer = await f.call('owner', 'POST', revoke ? '/v1/grants:revoke' : '/v1/grants', {
    resource: { route: routeOf(id)!, id },
    subject: { kind: 'account', id: f.accounts.editor },
    actions: ['zone:read'],
    valid: '(,)',
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(revoke ? 200 : 201);
}

test('a published configured static Zone route serves its exact common page and closed public shell through current viewer authority', async () => {
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.pages = [{ route: '', document: page('Draft') }];
  const zone = await f.create(input);
  const configured = structuredClone(input.configuration);
  configured.pages = [
    { route: '', document: page('Site home', { density: 'compact', radius: 'lg' }) },
    { route: 'about', document: page('About this site', { density: 'comfortable' }) },
    { route: 'empty', document: { root: { props: {} }, content: [] } },
  ];
  const saved = await f.call(
    'owner',
    'PUT',
    `${path(zone.id)}/configuration`,
    {
      configuration: configured,
      mounts: [],
    },
    f.conditional(zone.revision),
  );
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const revision = await publish(zone.id, saved.body.zone.revision, 'public');
  const receipts = await f.receipts();
  const events = await f.events(zone.id);
  const profile = await activeProfile(f.db.pool);
  expect(profile).not.toBeNull();
  const homeAnswer = await read(zone.id);
  const home = complete(homeAnswer);
  expect(home.profile).toBe(profile!.digest);
  expect(home.template).toEqual({ scope: 'route', key: '' });
  expect(home.document).toEqual(configured.pages[0]!.document);
  expect(home.reads).toEqual({});
  expect(home.zone).toEqual({
    id: zone.id,
    revision,
    visibility: 'public',
    labels: configured.labels,
    appearance: { density: 'compact', radius: 'lg' },
    navigation: configured.pages.map(({ route }) => ({ route })),
  });
  for (const locale of UI_LOCALES) {
    const about = complete(
      await f.call('anonymous', 'POST', `${path(zone.id)}:readPage`, {
        target: { route: 'about' },
        languages: [locale],
      }),
    );
    expect(about.profile).toBe(profile!.digest);
    expect(about.template).toEqual({ scope: 'route', key: 'about' });
    expect(about.document).toEqual(configured.pages[1]!.document);
    expect(about.zone).toEqual({ ...home.zone, appearance: { density: 'comfortable', radius: 'lg' } });
    expect(about.reads).toEqual({});
  }
  const empty = complete(await read(zone.id, 'anonymous', 'empty'));
  expect(empty.document).toEqual(configured.pages[2]!.document);
  expect(empty.reads).toEqual({});
  expect(complete(await read(zone.id, 'anonymous', 'about', 'unusable')).document).toEqual(
    configured.pages[1]!.document,
  );
  const missing = await read(zone.id, 'anonymous', 'missing');
  expect(missing.status).toBe(404);
  expect(problem((await read(newId(0x7111))).body)).toEqual(problem(missing.body));
  for (const cursor of ['', 'bad=', 'x'.repeat(4865)]) {
    expect((await read(zone.id, 'anonymous', '', cursor)).status).toBe(400);
  }
  for (const target of [
    { route: 'subjects' },
    { route: 'subjects/anything' },
    { route: '/about' },
    { route: '', view: 'overview' },
  ]) {
    expect((await f.call('anonymous', 'POST', `${path(zone.id)}:readPage`, { target })).status).toBe(400);
  }
  // The read is an ordinary public POST, with no command header or receipt.
  const bare = await f.app.handle(
    new Request(`http://kernel.test${path(zone.id)}:readPage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { route: '' } }),
    }),
  );
  expect(bare.status).toBe(200);
  expect(await f.receipts()).toBe(receipts);
  expect(await f.events(zone.id)).toEqual(events);
  const observed = decodeSession(
    { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) },
    'anonymous',
    homeAnswer.headers.get('rezics-session-token')!,
  );
  const partition = (
    await f.db.admin.query('SELECT epoch, position FROM core.partition WHERE partition_no=$1', [
      partitionOf(routeOf(zone.id)!),
    ])
  ).rows[0]!;
  expect(observed).toContainEqual({
    partition: partitionOf(routeOf(zone.id)!),
    epoch: partition.epoch,
    position: BigInt(partition.position),
  });
  // Source-dependent requests require explicit platform exposure before readiness.
  const unavailable = await f.call('anonymous', 'POST', `${path(zone.id)}:readPage`, {
    target: { subject: newId(0x7111) },
  });
  expect(unavailable.status).toBe(403);
  expect(unavailable.headers.get('retry-after')).toBeNull();
  expect(problem(unavailable.body)).toEqual({
    type: 'https://rezics.com/problems/platform_closed',
    title: 'Platform Closed',
    status: 403,
    code: 'platform_closed',
    retryable: false,
    effect_status: 'not_applicable',
  });
  expect(unavailable.body.request_id).toEqual(expect.any(String));
  expect(unavailable.body).not.toHaveProperty('document');
  expect(unavailable.body).not.toHaveProperty('next');
  const dynamic = createBody();
  dynamic.configuration.scope = [];
  const dynamicZone = await f.create(dynamic);
  const dataPage = await read(dynamicZone.id, 'owner');
  expect(dataPage.status).toBe(403);
  expect(dataPage.headers.get('retry-after')).toBeNull();
  expect(problem(dataPage.body)).toEqual({
    type: 'https://rezics.com/problems/platform_closed',
    title: 'Platform Closed',
    status: 403,
    code: 'platform_closed',
    retryable: false,
    effect_status: 'not_applicable',
  });
  expect(dataPage.body.request_id).toEqual(expect.any(String));
  expect(dataPage.body).not.toHaveProperty('document');
}, 180_000);

test('static Zone reads preserve withheld route concealment and fresh authorization with no source permission borrowing', async () => {
  for (const who of ['owner', 'editor'] as const)
    await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, who, 'gate:collections');
  const source = await f.call('owner', 'POST', '/v1/collections', {
    title: 'PRIVATE-STATIC-SOURCE',
    visibility: 'private',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(201);
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.pages = [
    { route: '', document: page('Covered home text', { density: 'compact', radius: 'lg' }) },
    { route: 'about', document: page('Hidden document') },
    { route: 'empty', document: { root: { props: {} }, content: [] } },
  ];
  input.mounts = [source.body.collection.id];
  const zone = await f.create(input);
  const unknown = await read(newId(0x7111));
  for (const who of ['anonymous', 'editor', 'other'] as const) {
    const denied = await read(zone.id, who, '', 'unusable');
    expect(denied.status).toBe(404);
    expect(problem(denied.body)).toEqual(problem(unknown.body));
  }
  expect(complete(await read(zone.id, 'owner')).document).toEqual(input.configuration.pages[0]!.document);
  await grant(zone.id);
  const readChecks = f.access.readChecks.length;
  const writeChecks = f.access.checks.length;
  expect(complete(await read(zone.id, 'editor')).document).toEqual(input.configuration.pages[0]!.document);
  expect(f.access.readChecks.slice(readChecks)).toEqual([
    { persona: 'editor', action: 'zone:read', resource: { route: routeOf(zone.id)!, id: zone.id } },
  ]);
  expect(f.access.checks.length).toBe(writeChecks);
  expect((await f.call('editor', 'GET', `${path(zone.id)}/configuration`)).status).toBe(403);
  expect((await f.call('editor', 'GET', `/v1/collections/${source.body.collection.id}`)).status).toBe(404);
  await grant(zone.id, true);
  expect((await read(zone.id, 'editor', '', 'unusable')).status).toBe(404);
  let revision = await publish(zone.id, zone.revision, 'unlisted');
  for (const who of ['anonymous', 'editor', 'other'] as const) {
    const result = complete(await read(zone.id, who));
    expect(result.zone.visibility).toBe('unlisted');
    expect(JSON.stringify(result)).not.toContain(source.body.collection.id);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-STATIC-SOURCE');
    expect(JSON.stringify(result)).not.toContain(f.accounts.owner);
  }
  revision = await publish(zone.id, revision, 'public');
  expect(complete(await read(zone.id)).zone.visibility).toBe('public');
  revision = await publish(zone.id, revision, 'private');
  expect((await read(zone.id, 'anonymous', '', 'unusable')).status).toBe(404);
  expect((await read(zone.id, 'editor', '', 'unusable')).status).toBe(404);
  revision = await publish(zone.id, revision, 'public');
  expect((await read(zone.id, 'suspended')).status).toBe(403);
  expect(
    (
      await f.call(
        'anonymous',
        'POST',
        `${path(zone.id)}:readPage`,
        { target: { route: '' } },
        { authorization: 'Bearer invalid' },
      )
    ).status,
  ).toBe(401);
  // Seed existing authoritative withholding decisions only; this proves read disclosure, not the unimplemented moderation command.
  const withholding = {
    '/labels/en': {},
    '/pages/0/document/content/0/props/text': {},
    '/pages/0/document/root/props/appearance/radius': {},
    '/pages/1/document': {},
  };
  await f.db.admin.query('UPDATE zones.zone SET withholding=$3::jsonb WHERE route=$1 AND zone_id=$2', [
    routeOf(zone.id),
    zone.id,
    JSON.stringify(withholding),
  ]);
  const safe = complete(await read(zone.id));
  expect(safe.document.content[0].props.text).toBe('');
  expect(safe.document.root.props.appearance).toEqual({ density: 'compact' });
  expect(safe.zone.appearance).toEqual({ density: 'compact' });
  expect(safe.zone.labels).not.toHaveProperty('en');
  expect(safe.zone.navigation).toEqual([{ route: '' }, { route: 'empty' }]);
  expect(JSON.stringify(safe)).not.toContain('Covered home text');
  expect(JSON.stringify(safe)).not.toContain('Hidden document');
  const hidden = await read(zone.id, 'anonymous', 'about', 'unusable');
  expect(hidden.status).toBe(404);
  expect(problem(hidden.body)).toEqual(problem(unknown.body));
  expect(complete(await read(zone.id, 'owner')).document.content[0].props.text).toBe('');
  expect((await f.configuration(zone.id)).body.configuration).toEqual(input.configuration);
  await f.db.admin.query('UPDATE zones.zone SET withholding=$3::jsonb WHERE route=$1 AND zone_id=$2', [
    routeOf(zone.id),
    zone.id,
    JSON.stringify({ '': {} }),
  ]);
  expect((await read(zone.id, 'owner')).status).toBe(404);
  await f.db.admin.query('UPDATE zones.zone SET withholding=$3::jsonb WHERE route=$1 AND zone_id=$2', [
    routeOf(zone.id),
    zone.id,
    '{}',
  ]);
  const deleted = await f.call('owner', 'DELETE', path(zone.id), undefined, f.conditional(revision));
  expect(deleted.status).toBe(200);
  for (const who of ['anonymous', 'owner', 'editor'] as const) expect((await read(zone.id, who)).status).toBe(404);
}, 180_000);
