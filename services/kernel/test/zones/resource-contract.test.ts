import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { UI_LOCALES } from '@rezics/composition';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capture, checkGrowth } from '../support/growth.ts';
import { costOf } from '../support/growth-cost.ts';
import { createBody, day, page, problem, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const key = () => ({ 'idempotency-key': JSON.stringify(randomUUID()) });
const path = (id: string) => `/v1/zones/${id}`;
async function publish(id: string, revision: string, visibility = 'public') {
  const result = await f.call('owner', 'POST', `${path(id)}:publish`, { visibility }, f.conditional(revision));
  expect(result.status).toBe(200);
  return result.body.zone.revision as string;
}
async function save(id: string, revision: string, body: unknown, who: 'owner' | 'editor' = 'owner') {
  const result = await f.call(who, 'PUT', `${path(id)}/configuration`, body, f.conditional(revision));
  expect(result.status).toBe(200);
  return result.body.zone.revision as string;
}
async function remove(id: string, revision: string) {
  const result = await f.call('owner', 'DELETE', path(id), undefined, f.conditional(revision));
  expect(result.status).toBe(200);
  expect(result.body.zone.deletedAt).toBe(f.clock().toISOString());
  return result.body.zone.revision as string;
}
async function finishPurge(id: string, limit = 2) {
  let cursor: string | null = null;
  for (let steps = 0; steps < 100; steps++) {
    const result = await f.purge(id, cursor, limit);
    if (result.next === null) return;
    expect(result.next).not.toBe(cursor);
    cursor = result.next;
  }
  throw new Error('Bounded Zone purge did not finish');
}

test('a Zone is an owner-controlled routed site copied from inert starter data', async () => {
  await f.available();
  const input = createBody();
  for (const who of ['editor', 'other', 'suspended'] as const) {
    const denied = await f.call(who, 'POST', '/v1/zones', input);
    expect(denied.status).toBe(403);
  }
  const headers = key();
  const before = await f.receipts();
  const created = await f.call('owner', 'POST', '/v1/zones', input, headers);
  expect(created.status).toBe(201);
  const zone = created.body.zone;
  expect(zone).toMatchObject({
    revision: '1',
    visibility: 'private',
    deletedAt: null,
    labels: input.configuration.labels,
  });
  const id = zone.id as string;
  expect(created.headers.get('etag')).toBe('"1"');
  const replay = await f.call('owner', 'POST', '/v1/zones', input, headers);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(created.body);
  expect(await f.receipts()).toBe(before + 1);
  expect((await f.events(id)).map((e) => e.type)).toEqual(['com.rezics.zone.created.v1']);
  const grants = await f.db.admin.query(
    'SELECT subject_id,grant_role FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
    [routeOf(id), id],
  );
  expect(grants.rows).toContainEqual({ subject_id: f.accounts.owner, grant_role: 'semantic.zone.owner' });
  const config = await f.configuration(id);
  expect(config.body).toMatchObject({ configuration: input.configuration, mounts: [] });
  input.configuration.labels.en = 'Changed local input';
  expect((await f.configuration(id)).body.configuration.labels.en).toBe('Books');
  const unknown = await f.call('anonymous', 'GET', path(randomUUID()));
  for (const who of ['anonymous', 'other'] as const) {
    const privateRead = await f.call(who, 'GET', path(id));
    expect(privateRead.status).toBe(404);
    expect(problem(privateRead.body)).toEqual(problem(unknown.body));
  }
  const body = (await f.configuration(id)).body;
  const update = { configuration: body.configuration, mounts: [] };
  update.configuration.labels.en = 'Edited';
  const forbidden = await f.call('other', 'PUT', `${path(id)}/configuration`, update, f.conditional('1'));
  expect(forbidden.status).toBe(403);
  await f.grant(id, 'editor', 'zone:configure');
  await f.grant(id, 'editor', 'zone:read');
  const editKey = { ...key(), ...f.conditional('1') };
  const edit = await f.call('editor', 'PUT', `${path(id)}/configuration`, update, editKey);
  expect(edit.status).toBe(200);
  expect(edit.body.zone.revision).toBe('2');
  expect((await f.call('editor', 'PUT', `${path(id)}/configuration`, update, editKey)).body).toEqual(edit.body);
  const stale = await f.call('owner', 'PUT', `${path(id)}/configuration`, update, f.conditional('1'));
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('precondition_failed');
  const changedKey = await f.call(
    'editor',
    'PUT',
    `${path(id)}/configuration`,
    { ...update, mounts: [randomUUID()] },
    editKey,
  );
  expect(changedKey.status).toBe(422);
  expect(changedKey.body.code).toBe('idempotency_conflict');
  await f.revoke(id, 'editor', 'zone:configure');
  expect((await f.call('editor', 'PUT', `${path(id)}/configuration`, update, editKey)).status).toBe(403);
  expect((await f.configuration(id)).body.zone.revision).toBe('2');
  expect(
    (await f.call('editor', 'POST', `${path(id)}:publish`, { visibility: 'public' }, f.conditional('2'))).status,
  ).toBe(403);
  const revision = await publish(id, '2', 'unlisted');
  expect((await f.call('anonymous', 'GET', path(id))).body.zone.visibility).toBe('unlisted');
  const listed = await f.call('owner', 'GET', '/v1/zones?limit=1');
  expect(listed.status).toBe(200);
  expect(listed.body.zones.map((z: { id: string }) => z.id)).toContain(id);
  expect((await f.call('anonymous', 'GET', '/v1/zones?limit=1')).status).toBe(401);
  const publicRevision = await publish(id, revision);
  expect((await f.call('anonymous', 'GET', path(id))).body.zone.revision).toBe(publicRevision);
  expect((await f.events(id)).filter((e) => e.type === 'com.rezics.zone.configured.v1')).toHaveLength(1);
  const withoutCondition = await f.call('owner', 'PUT', `${path(id)}/configuration`, update);
  expect(withoutCondition.status).toBe(400);
  const races = await Promise.all([
    f.call('owner', 'PUT', `${path(id)}/configuration`, update, f.conditional(publicRevision)),
    f.call('owner', 'PUT', `${path(id)}/configuration`, update, f.conditional(publicRevision)),
  ]);
  expect(races.map((r) => r.status).sort()).toEqual([200, 412]);
  await f.create();
  const firstPage = await f.call('owner', 'GET', '/v1/zones?limit=1');
  expect(typeof firstPage.body.next).toBe('string');
  const cursor = encodeURIComponent(firstPage.body.next);
  const secondPage = await f.call('owner', 'GET', `/v1/zones?limit=1&cursor=${cursor}`);
  expect(secondPage.status).toBe(200);
  expect(secondPage.body.zones[0].id).not.toBe(firstPage.body.zones[0].id);
  expect((await f.call('owner', 'GET', `/v1/zones?limit=1&cursor=${cursor}x`)).body.code).toBe('invalid_cursor');
  expect((await f.call('other', 'GET', `/v1/zones?limit=1&cursor=${cursor}`)).body.code).toBe('invalid_cursor');
  const createCheck = f.access.checks.find((c) => c.action === 'zone:create' && c.persona === 'owner');
  expect(createCheck?.resource).toEqual({ route: 0, id: GLOBAL_CONTEXT });
  await f.access.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'zone:create');
  expect((await f.call('owner', 'POST', '/v1/zones', createBody(), headers)).status).toBe(403);
}, 120_000);

test('Zone pages use closed shared appearance and current viewer access', async () => {
  await f.available();
  const body = createBody();
  body.configuration.pages = [
    { route: '', document: page('Home', { density: 'compact', radius: 'lg', surface: 'cards' }) },
    { route: 'about', document: page('About', { density: 'comfortable' }) },
  ];
  const zone = await f.create(body);
  let revision = zone.revision;
  const unavailable = await f.read(randomUUID());
  expect(unavailable.status).toBe(404);
  const privateRead = await f.read(zone.id);
  expect(privateRead.status).toBe(404);
  expect(problem(privateRead.body)).toEqual(problem(unavailable.body));
  await f.grant(zone.id, 'editor', 'zone:read');
  expect((await f.read(zone.id, 'editor')).status).toBe(200);
  const hidden = await f.call('owner', 'POST', '/v1/collections', {
    title: 'Secret mounted name',
    visibility: 'private',
  });
  expect(hidden.status).toBe(201);
  const mount = hidden.body.collection.id as string;
  revision = await save(zone.id, revision, { configuration: body.configuration, mounts: [mount] });
  revision = await publish(zone.id, revision);
  for (const language of UI_LOCALES) {
    const response = await f.read(zone.id, 'anonymous', { route: 'about' }, [language]);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Object.keys(response.body).sort()).toEqual(['document', 'profile', 'reads', 'template', 'zone']);
    expect(response.body.document).toEqual(body.configuration.pages[1]!.document);
    expect(response.body.template).toEqual({ scope: 'route', key: 'about' });
    expect(response.body.reads).toEqual({});
    expect(response.body.zone).toEqual({
      id: zone.id,
      revision,
      visibility: 'public',
      labels: body.configuration.labels,
      appearance: { density: 'comfortable', radius: 'lg', surface: 'cards' },
      navigation: [{ route: '' }, { route: 'about' }],
    });
    expect(JSON.stringify(response.body)).not.toContain(mount);
    expect(JSON.stringify(response.body)).not.toContain('Secret mounted name');
  }
  expect((await f.call('anonymous', 'GET', `${path(zone.id)}/collections`)).body).toMatchObject({
    collections: [],
    next: null,
  });
  const metadata = await f.call('anonymous', 'GET', path(zone.id));
  expect(Object.keys(metadata.body.zone).sort()).toEqual([
    'appearance',
    'id',
    'labels',
    'navigation',
    'revision',
    'visibility',
  ]);
  expect((await f.configuration(zone.id)).body.mounts).toEqual([mount]);
  expect((await f.call('other', 'GET', `${path(zone.id)}/configuration`)).status).toBe(403);
  expect((await f.read(zone.id, 'anonymous', { route: 'missing' })).status).toBe(404);
  for (const target of [
    { route: '../about' },
    { route: '/about' },
    { route: 'subjects' },
    { route: '', view: 'overview' },
    { route: '', subject: randomUUID() },
  ]) {
    expect((await f.read(zone.id, 'anonymous', target)).status).toBe(400);
  }
  for (const mutate of [
    (c: typeof body.configuration) => {
      c.labels.en = '<script>alert(1)</script>';
    },
    (c: typeof body.configuration) => {
      delete (c.labels as Partial<typeof c.labels>).ja;
    },
    (c: typeof body.configuration) => {
      c.pages[1]!.route = 'subjects/custom';
    },
    (c: typeof body.configuration) => {
      c.pages[1]!.route = 'https://outside.test';
    },
    (c: typeof body.configuration) => {
      c.pages = Array.from({ length: 17 }, (_, i) => ({
        route: i ? `p${i.toString().padStart(2, '0')}` : '',
        document: page('x'),
      }));
    },
    (c: typeof body.configuration) => {
      c.scope = Array.from({ length: 17 }, (_, i) => `book/f${i}`);
    },
    (c: typeof body.configuration) => {
      c.pages[0]!.document = { root: { props: { appearance: { css: 'body{}' } } }, content: [] };
    },
  ]) {
    const invalid = structuredClone(body.configuration);
    mutate(invalid);
    expect(
      (
        await f.call(
          'owner',
          'PUT',
          `${path(zone.id)}/configuration`,
          { configuration: invalid, mounts: [mount] },
          f.conditional(revision),
        )
      ).status,
    ).toBe(400);
  }
  const subject = await f.call('owner', 'POST', '/v1/subjects', {
    type: 'schema:Book',
    labels: { en: 'Mounted book' },
  });
  expect(subject.status).toBe(201);
  const subjectId = subject.body.subject.id as string;
  expect((await f.call('owner', 'POST', `/v1/collections/${mount}/members`, { subjectId })).status).toBe(201);
  // Empty saved scopes make the mounted Collection the sole eligibility source.
  const config = structuredClone(body.configuration);
  config.scope = [];
  revision = await save(zone.id, revision, { configuration: config, mounts: [mount] });
  expect((await f.read(zone.id, 'anonymous', { subject: subjectId })).status).toBe(404);
  const ownerPage = await f.read(zone.id, 'owner', { subject: subjectId });
  expect(ownerPage.status).toBe(200);
  expect(ownerPage.body.subject).toBe(subjectId);
  expect(ownerPage.body.reads.r0.body).toEqual((await f.call('owner', 'GET', `/v1/subjects/${subjectId}`)).body);
  await f.grant(mount, 'editor', 'collection:read');
  expect((await f.read(zone.id, 'editor', { subject: subjectId })).status).toBe(200);
  await f.revoke(mount, 'editor', 'collection:read');
  expect((await f.read(zone.id, 'editor', { subject: subjectId })).status).toBe(404);
  expect(f.access.readChecks.some((c) => c.action === 'collection:read' && c.resource.id === mount)).toBe(true);
  expect((await f.read(zone.id, 'suspended', { route: '' })).status).toBe(403);

  // Real unrelated resource/page/history growth; no manufactured Zone rows or modified accounting.
  await checkGrowth(f.db, {
    name: 'fixed Zone page reads at unrelated resource and history scales',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      for (let i = previous; i < scale; i++) {
        const unrelated = await f.create({ ...createBody(), configuration: config });
        await save(unrelated.id, unrelated.revision, { configuration: config, mounts: [] });
      }
    },
    async operation() {
      expect((await f.read(zone.id, 'anonymous', { route: 'about' })).status).toBe(200);
    },
  });
}, 600_000);

test('Zone deletion restoration and least-data purge obey the owner window while takedown retains data', async () => {
  await f.available();
  const body = createBody();
  body.configuration.pages = [
    { route: '', document: page('Personal payload to erase') },
    { route: 'about', document: page('Unaffected text') },
  ];
  const zone = await f.create(body);
  let revision = await publish(zone.id, zone.revision);
  revision = await remove(zone.id, revision);
  expect((await f.read(zone.id, 'owner')).status).toBe(404);
  expect((await f.raw(zone.id))!.configuration).toEqual(body.configuration);
  expect((await f.call('other', 'POST', `${path(zone.id)}:restore`, {}, f.conditional(revision))).status).toBe(403);
  f.advance(30 * day - 1);
  const restored = await f.call('owner', 'POST', `${path(zone.id)}:restore`, {}, f.conditional(revision));
  expect(restored.status).toBe(200);
  revision = restored.body.zone.revision;
  expect((await f.read(zone.id)).status).toBe(200);
  revision = await remove(zone.id, revision);
  f.advance(30 * day);
  const tooLate = await f.call('owner', 'POST', `${path(zone.id)}:restore`, {}, f.conditional(revision));
  expect(tooLate.status).toBe(409);
  expect(tooLate.body.code).toBe('conflict');
  const measured = await capture(f.db, () => f.purge(zone.id));
  expect(costOf(measured.capture).rows).toBeLessThan(256);
  await finishPurge(zone.id);
  const skeleton = (await f.raw(zone.id))!;
  expect(skeleton).toMatchObject({
    zone_id: zone.id,
    state: 'purged',
    owner_id: null,
    configuration: null,
    mounts: null,
  });
  expect(skeleton.deleted_at).not.toBeNull();
  const purgedEvents = await f.events(zone.id);
  await finishPurge(zone.id);
  expect(await f.events(zone.id)).toEqual(purgedEvents);
  const rolePayload = await f.db.admin.query(
    'SELECT * FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2',
    [routeOf(zone.id), zone.id],
  );
  expect(rolePayload.rows).toEqual([]);
  const serialized = JSON.stringify(await f.events(zone.id));
  expect(serialized).not.toContain('Personal payload to erase');
  expect(serialized).not.toContain(f.accounts.owner);
  const receipts = await f.db.admin.query('SELECT response FROM core.receipt WHERE principal_id=$1', [
    f.accounts.owner,
  ]);
  expect(JSON.stringify(receipts.rows)).not.toContain('Personal payload to erase');
  expect((await f.call('owner', 'POST', `${path(zone.id)}:restore`, {}, f.conditional(skeleton.revision))).status).toBe(
    404,
  );

  const privateZone = await f.create(body);
  await remove(privateZone.id, privateZone.revision);
  f.advance(30 * day);
  await finishPurge(privateZone.id);
  expect(await f.raw(privateZone.id)).toBeUndefined();

  const held = await f.create(body);
  await remove(held.id, held.revision);
  await f.access.grant(PLATFORM_RESOURCE, 'operator', 'zone:purge');
  expect(
    (await f.call('operator', 'POST', `/v1/platform/zones/${held.id}:hold`, { reason: 'Legal preservation' })).status,
  ).toBe(200);
  f.advance(31 * day);
  await finishPurge(held.id);
  expect((await f.raw(held.id))!.configuration).toEqual(body.configuration);
  expect((await f.call('operator', 'POST', `/v1/platform/zones/${held.id}:releaseHold`, {})).status).toBe(200);
  await finishPurge(held.id);
  expect(await f.raw(held.id)).toBeUndefined();

  const early = await f.create(body);
  await remove(early.id, early.revision);
  expect((await f.call('owner', 'POST', `/v1/platform/zones/${early.id}:purge`, { reason: 'early' })).status).toBe(403);
  const purge = await f.call('operator', 'POST', `/v1/platform/zones/${early.id}:purge`, {
    reason: 'Legal order',
    order: 'court-order-reference',
  });
  expect(purge.status).toBe(200);
  await finishPurge(early.id);
  expect(await f.raw(early.id)).toBeUndefined();

  const taken = await f.create(body);
  const takenRevision = await publish(taken.id, taken.revision);
  await f.grant(taken.id, 'operator', 'moderation:takedown');
  const notice = { complaint: 'Covered passage', received_at: f.clock().toISOString() };
  const fields = ['/pages/0/document/content/0/props/text'];
  const withheld = await f.call(
    'operator',
    'POST',
    `${path(taken.id)}:takedown`,
    { notice, fields },
    f.conditional(takenRevision),
  );
  expect(withheld.status).toBe(200);
  expect((await f.read(taken.id)).body.document.content[0].props.text).toBe('');
  expect((await f.read(taken.id, 'anonymous', { route: 'about' })).body.document).toEqual(
    body.configuration.pages[1]!.document,
  );
  f.advance(31 * day);
  await finishPurge(taken.id);
  expect((await f.raw(taken.id))!).toMatchObject({
    state: 'active',
    deleted_at: null,
    configuration: body.configuration,
  });
  const released = await f.call(
    'operator',
    'POST',
    `${path(taken.id)}:releaseTakedown`,
    { fields },
    f.conditional(withheld.body.zone.revision),
  );
  expect(released.status).toBe(200);
  expect((await f.read(taken.id)).body.document).toEqual(body.configuration.pages[0]!.document);
  const types = (await f.events(taken.id)).map((e) => e.type);
  expect(types).toContain('com.rezics.zone.withheld.v1');
  expect(types).not.toContain('com.rezics.zone.deleted.v1');
  expect(types).not.toContain('com.rezics.zone.purged.v1');
}, 180_000);
