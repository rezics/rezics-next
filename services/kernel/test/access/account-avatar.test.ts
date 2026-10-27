import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { readPublicAccountByHandle } from '../../src/access/account-data.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const commands = createLifecycleCommands({ pool, access });
const routeKey = new Uint8Array(32).fill(23);
const internal = createLifecycleInternals({
  pool,
  routeKey,
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const kernel = createKernel({ pool, routeKey });
afterAll(() => pool.end());
const key = () => crypto.randomUUID();
async function account() {
  const id = newId(0x4567);
  const handle = `avatar_${key().replaceAll('-', '')}`;
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id) VALUES ($1,$2,'actor','active',$3,$2)",
    [routeOf(id), id, handle],
  );
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$2,'account:update','(,)',$2), ($1,$2,$2,'account:delete','(,)',$2)",
    [routeOf(id), id],
  );
  await pool.query(
    "INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id) VALUES ($1,$2,$3,'active',$3)",
    [createHash('sha256').update(handle).digest().readUInt16BE(0), handle, id],
  );
  return { id, handle };
}
async function context(id: string) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10000 },
    { accountId: id, clientId: 'avatar', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  return { actor, deadline: Date.now() + 10000 };
}
async function media(owner: string, purpose = 'avatar', state = 'available') {
  const id = newId(routeOf(owner)!);
  await pool.query(
    `INSERT INTO content.media(route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id,width,height,thumbhash,average_color)
    VALUES ($1,$2,$3,$3,$2::uuid::text,$4,'image/png',256,256,repeat('a',64),$5,'m/'||$2::uuid::text||'/original',$2,64,64,decode('010203','hex'),'#123456')`,
    [routeOf(owner), id, owner, purpose, state],
  );
  await pool.query(
    `INSERT INTO content.media_variant(route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
    VALUES ($1,$2,'webp',64,64,'image/webp',100,repeat('b',64),'m/'||$2::uuid::text||'/webp-64',$2)`,
    [routeOf(owner), id],
  );
  return id;
}

test('profile patch sets owned avatar media, handle returns the cover summary, and null clears it', async () => {
  const { id, handle } = await account();
  const avatar = await media(id);
  await commands.updateAccount(await context(id), { accountId: id, key: key(), patch: { avatar } });
  const response = await kernel.handle(new Request(`https://kernel.test/v1/accounts?handle=${handle}`));
  expect(response.status).toBe(200);
  expect((await response.json()).accounts[0].avatar).toEqual({
    media: avatar,
    width: 64,
    height: 64,
    placeholder: { thumbhash: 'AQID', color: '#123456' },
    variants: [{ format: 'webp', width: 64 }],
    focalPoint: null,
    credit: null,
  });
  const idsResponse = await kernel.handle(new Request(`https://kernel.test/v1/accounts?ids=${id}`));
  expect((await idsResponse.json()).accounts[0]).not.toHaveProperty('avatar');
  await commands.updateAccount(await context(id), { accountId: id, key: key(), patch: { avatar: null } });
  expect((await readPublicAccountByHandle(pool, handle))[0]).toHaveProperty('avatar', null);
});

test('invalid, missing, foreign, unavailable and non-avatar media refuse the whole patch', async () => {
  const { id, handle } = await account();
  const other = await account();
  const avatar = await media(id);
  await commands.updateAccount(await context(id), {
    accountId: id,
    key: key(),
    patch: { avatar, displayName: 'Keep' },
  });
  for (const invalid of [
    '',
    42,
    {},
    newId(0x4567),
    newId(0x4568),
    await media(other.id),
    await media(id, 'post-image'),
    await media(id, 'avatar', 'uploaded'),
  ]) {
    await expect(
      commands.updateAccount(await context(id), {
        accountId: id,
        key: key(),
        patch: { avatar: invalid, displayName: 'Wrong' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  }
  expect((await readPublicAccountByHandle(pool, handle))[0]).toMatchObject({
    displayName: 'Keep',
    avatar: { media: avatar },
  });
  await expect(
    commands.updateAccount(await context(other.id), { accountId: id, key: key(), patch: { avatar: null } }),
  ).rejects.toThrow();
});

test('operator managers can patch the presentation and lose that authority when the operator changes', async () => {
  const manager = await account();
  const subject = await account();
  const replacement = await account();
  await pool.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(subject.id),
    subject.id,
    manager.id,
  ]);
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$2,'account:manage','(,)',$2)",
    [routeOf(manager.id), manager.id],
  );
  const avatar = await media(subject.id);
  await commands.updateAccount(await context(manager.id), {
    accountId: subject.id,
    key: key(),
    patch: { avatar, publicViews: { posts: false } },
  });
  expect((await readPublicAccountByHandle(pool, subject.handle))[0]).toMatchObject({
    avatar: { media: avatar },
    publicViews: { posts: false },
  });
  await pool.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(subject.id),
    subject.id,
    replacement.id,
  ]);
  await expect(
    commands.updateAccount(await context(manager.id), { accountId: subject.id, key: key(), patch: { avatar: null } }),
  ).rejects.toThrow();
});

test('fencing and deletion clear avatar and all views without erasing the media', async () => {
  for (const deleted of [false, true]) {
    const { id, handle } = await account();
    const avatar = await media(id);
    await commands.updateAccount(await context(id), { accountId: id, key: key(), patch: { avatar } });
    if (deleted) await commands.tombstone(await context(id), { accountId: id, key: key() });
    else await internal.raiseFence({ accountId: id, key: key() });
    expect(
      (
        await pool.query('SELECT avatar, public_views FROM access.account WHERE route=$1 AND account_id=$2', [
          routeOf(id),
          id,
        ])
      ).rows,
    ).toEqual([{ avatar: null, public_views: { posts: false, reviews: false, collections: false, realms: false } }]);
    const profile = (await readPublicAccountByHandle(pool, handle))[0];
    if (deleted) expect(profile).not.toHaveProperty('avatar');
    else
      expect(profile).toMatchObject({
        avatar: null,
        publicViews: { posts: false, reviews: false, collections: false },
      });
    expect(
      (await pool.query('SELECT erased FROM content.media WHERE route=$1 AND media_id=$2', [routeOf(id), avatar])).rows,
    ).toEqual([{ erased: false }]);
  }
});
