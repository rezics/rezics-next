import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PROFILE_FORMAT } from '@rezics/composition';
import { randomUUID } from 'node:crypto';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountErasureFixture, type AccountErasureFixture } from '../semantic/support/account-erasure-fixture.ts';
import { createBody, page } from './resource-fixture.ts';

let f: AccountErasureFixture;
beforeAll(async () => {
  f = await accountErasureFixture();
  await bootstrapProfile(f.db.pool, {
    format: PROFILE_FORMAT,
    generic: {
      views: { overview: { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'subject' } }] } },
    },
    types: [],
    bases: [],
    routes: [],
  });
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);
const conditional = (revision: string) => ({ 'if-match': JSON.stringify(revision) });
async function zone(visibility: 'private' | 'unlisted') {
  const owner = await f.author();
  await f.grant(GLOBAL_CONTEXT, owner, ['zone:create']);
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.labels.en = `Personal Zone ${randomUUID()}`;
  input.configuration.pages = [{ route: '', document: page(`Private Zone page ${randomUUID()}`) }];
  const created = await f.call(owner, 'POST', '/v1/zones', input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  let resource = created.body.zone as { id: string; revision: string };
  if (visibility === 'unlisted') {
    const published = await f.call(
      owner,
      'POST',
      `/v1/zones/${resource.id}:publish`,
      { visibility },
      conditional(resource.revision),
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    resource = published.body.zone;
  }
  const roles = await f.db.admin.query(
    `SELECT subject_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
     AND grant_role='semantic.zone.owner' AND upper_inf(valid)`,
    [routeOf(resource.id), resource.id],
  );
  expect(roles.rows).toEqual([{ subject_id: owner.accountId }]);
  return { owner, resource, input };
}

test('native T immediately fences unlisted anonymous Zone metadata while cleanup is paused', async () => {
  const { owner, resource, input } = await zone('unlisted');
  const path = `/v1/zones/${resource.id}`;
  const before = await f.call(undefined, 'GET', path);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body.zone.labels).toEqual(input.configuration.labels);
  await f.tombstone(owner);
  const after = await f.call(undefined, 'GET', path);
  expect(after.status, JSON.stringify(after.body)).toBe(404);
  expect(JSON.stringify(after.body)).not.toContain(input.configuration.labels.en);
}, 120_000);

test('native Zone editor erasure retains an actual nonowner editorial obligation in the single semantic participant', async () => {
  const { owner, resource, input } = await zone('private');
  const editor = await f.author();
  await f.grantAs(owner, resource.id, editor, ['zone:read', 'zone:configure']);
  const configuration = structuredClone(input.configuration);
  configuration.labels.en = `Editor contribution ${randomUUID()}`;
  const configured = await f.call(
    editor,
    'PUT',
    `/v1/zones/${resource.id}/configuration`,
    {
      configuration,
      mounts: [],
    },
    conditional(resource.revision),
  );
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  const payload = async () =>
    (
      await f.db.admin.query(
        `SELECT z.owner_id,z.configuration,z.transaction_id,b.principal_kind,b.principal_id,b.requested_by
     FROM zones.zone z JOIN editorial.write_basis b
       ON b.partition_no=($1::integer >> 4) AND b.transaction_id=z.transaction_id
     WHERE z.route=$1 AND z.zone_id=$2`,
        [routeOf(resource.id), resource.id],
      )
    ).rows;
  const before = await payload();
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    owner_id: owner.accountId,
    configuration,
    principal_kind: 'account',
    principal_id: editor.accountId,
  });
  const deletion = await f.tombstone(editor);
  // This account is not the Zone owner; owner-only discovery would miss its actual edit provenance.
  expect(await payload()).toEqual(before);
  const status = await f.status(editor.accountId);
  expect(status?.at).toBe(deletion.result.at);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.participants).not.toHaveProperty('zones');
  expect(status?.completedAt).toBeNull();
  expect(await f.status(owner.accountId)).toBeNull();
  const surviving = await f.call(owner, 'GET', `/v1/zones/${resource.id}/configuration`);
  expect(surviving.status, JSON.stringify(surviving.body)).toBe(200);
  expect(surviving.body.configuration).toEqual(configuration);
}, 120_000);

test('native T immediately fences unlisted anonymous Zone page rendering before projections or cleanup', async () => {
  const { owner, resource } = await zone('unlisted');
  const path = `/v1/zones/${resource.id}:readPage`;
  const before = await f.call(undefined, 'POST', path, { target: { route: '' } });
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  await f.tombstone(owner);
  const after = await f.call(undefined, 'POST', path, { target: { route: '' } });
  expect(after.status, JSON.stringify(after.body)).toBe(404);
}, 120_000);

test('native T fences another live editor reading private Zone configuration and producing a late copy', async () => {
  const { owner, resource, input } = await zone('private');
  const editor = await f.author();
  await f.grantAs(owner, resource.id, editor, ['zone:read', 'zone:configure']);
  const path = `/v1/zones/${resource.id}/configuration`;
  const before = await f.call(editor, 'GET', path);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body.configuration).toEqual(input.configuration);
  await f.tombstone(owner);
  const after = await f.call(editor, 'GET', path);
  expect(after.status, JSON.stringify(after.body)).toBe(404);
  expect(JSON.stringify(after.body)).not.toContain(input.configuration.labels.en);
}, 120_000);

test('native T refuses a live editor late Zone producer without changing the owner payload or ACK', async () => {
  const { owner, resource, input } = await zone('private');
  const editor = await f.author();
  await f.grantAs(owner, resource.id, editor, ['zone:read', 'zone:configure']);
  const changed = structuredClone(input.configuration);
  changed.labels.en = 'Late private copy';
  await f.tombstone(owner);
  const result = await f.call(
    editor,
    'PUT',
    `/v1/zones/${resource.id}/configuration`,
    {
      configuration: changed,
      mounts: [],
    },
    conditional(resource.revision),
  );
  expect([403, 404, 409]).toContain(result.status);
  const row = await f.db.admin.query('SELECT configuration FROM zones.zone WHERE route=$1 AND zone_id=$2', [
    routeOf(resource.id),
    resource.id,
  ]);
  expect(row.rows[0].configuration).toEqual(input.configuration);
  expect((await f.status(owner.accountId))?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
}, 120_000);

test('native record deletion does not defer account T or turn retained Zone payload into none', async () => {
  const { owner, resource, input } = await zone('unlisted');
  const deleted = await f.call(owner, 'DELETE', `/v1/zones/${resource.id}`, undefined, conditional(resource.revision));
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  const row = await f.db.admin.query(
    'SELECT configuration,restore_until FROM zones.zone WHERE route=$1 AND zone_id=$2',
    [routeOf(resource.id), resource.id],
  );
  expect(row.rows[0].configuration).toEqual(input.configuration);
  expect(row.rows[0].restore_until).not.toBeNull();
  await f.tombstone(owner);
  const result = await f.call(owner, 'GET', `/v1/zones/${resource.id}/configuration`);
  expect([401, 403]).toContain(result.status);
  expect((await f.call(undefined, 'GET', `/v1/zones/${resource.id}`)).status).toBe(404);
  expect((await f.status(owner.accountId))?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
}, 120_000);

test('native deleted Zone payload is an actual semantic obligation and record restore cannot undo account T', async () => {
  const { owner, resource, input } = await zone('private');
  const removed = await f.call(owner, 'DELETE', `/v1/zones/${resource.id}`, undefined, conditional(resource.revision));
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const revision = removed.body.zone.revision as string;
  const deletion = await f.tombstone(owner);
  const row = await f.db.admin.query(
    `SELECT zone_id,owner_id,state,configuration,restore_until FROM zones.zone
     WHERE route=$1 AND owner_id=$2 AND state='deleted' AND zone_id=$3`,
    [routeOf(owner.accountId), owner.accountId, resource.id],
  );
  expect(row.rows).toHaveLength(1);
  expect(row.rows[0]).toMatchObject({
    zone_id: resource.id,
    owner_id: owner.accountId,
    state: 'deleted',
    configuration: input.configuration,
  });
  expect(row.rows[0].restore_until).not.toBeNull();
  const status = await f.status(owner.accountId);
  expect(status?.at).toBe(deletion.result.at);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.participants).not.toHaveProperty('zones');
  expect(status?.completedAt).toBeNull();
  const restored = await f.call(owner, 'POST', `/v1/zones/${resource.id}:restore`, {}, conditional(revision));
  expect([401, 403]).toContain(restored.status);
  expect(await f.status(owner.accountId)).toEqual(status);
}, 120_000);

test('native unlisted Zone stored page bytes remain an actual pending obligation', async () => {
  const { owner, resource, input } = await zone('unlisted');
  const stored = () =>
    f.db.admin.query(
      `SELECT configuration,mounts,owner_id FROM zones.zone
     WHERE route=$1 AND owner_id=$2 AND state='active' AND zone_id=$3`,
      [routeOf(owner.accountId), owner.accountId, resource.id],
    );
  const before = await stored();
  expect(before.rows).toHaveLength(1);
  expect(before.rows[0].configuration).toEqual(input.configuration);
  await f.tombstone(owner);
  // No Semantic worker is registered: the native coordinator must keep the real payload obligation pending.
  expect((await stored()).rows).toEqual(before.rows);
  const status = await f.status(owner.accountId);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.completedAt).toBeNull();
  expect(status?.participants).not.toHaveProperty('zones');
}, 120_000);

test('one native T keeps active and deleted Zone owner payload obligations in the same semantic participant', async () => {
  const { owner, resource: active, input } = await zone('private');
  const created = await f.call(owner, 'POST', '/v1/zones', input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const deleted = created.body.zone as { id: string; revision: string };
  expect(deleted.id).not.toBe(active.id);
  const removed = await f.call(owner, 'DELETE', `/v1/zones/${deleted.id}`, undefined, conditional(deleted.revision));
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const payloads = async () =>
    (
      await f.db.admin.query(
        `SELECT zone_id,owner_id,state,configuration,mounts,restore_until FROM zones.zone
     WHERE route=$1 AND owner_id=$2 AND zone_id=ANY($3::uuid[]) ORDER BY zone_id`,
        [routeOf(owner.accountId), owner.accountId, [active.id, deleted.id]],
      )
    ).rows;
  const before = await payloads();
  expect(before).toHaveLength(2);
  expect(before.find((row) => row.zone_id === active.id).state).toBe('active');
  expect(before.find((row) => row.zone_id === deleted.id).state).toBe('deleted');
  for (const row of before) expect(row.configuration).toEqual(input.configuration);
  const deletion = await f.tombstone(owner);
  expect(await payloads()).toEqual(before);
  const status = await f.status(owner.accountId);
  expect(status?.at).toBe(deletion.result.at);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.participants).not.toHaveProperty('zones');
  expect(status?.completedAt).toBeNull();
  // The individual record's restore window cannot reopen the terminal account or discharge either payload.
  const restored = await f.call(
    owner,
    'POST',
    `/v1/zones/${deleted.id}:restore`,
    {},
    conditional(removed.body.zone.revision),
  );
  expect([401, 403]).toContain(restored.status);
  expect(await payloads()).toEqual(before);
  expect(await f.status(owner.accountId)).toEqual(status);
}, 120_000);
