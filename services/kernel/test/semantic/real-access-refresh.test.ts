import { afterAll, beforeAll, expect, test } from 'bun:test';
import { importJWK, jwtVerify } from 'jose';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('refreshed fixture credentials preserve native identity and lifetime while account authority remains decisive', async () => {
  const account = newId(29000);
  const actions = ['subject:read', 'subject:merge'];
  let issuanceTime = new Date(Date.now() - 301_000);
  const real = await createRealAccess(db.admin, { importer: account }, actions, {
    credentialClock: () => issuanceTime,
  });
  const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  const context = { pool: db.pool, deadline: Date.now() + 10_000 };

  await expect(access.authenticate(real.bearer('importer'), context)).rejects.toMatchObject({ status: 401 });

  issuanceTime = new Date();
  const fresh = await real.refreshBearer('importer');
  const response = await real.auth.fetch!(real.auth.jwksUrl, {
    headers: new Headers(),
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(2000),
  });
  const { keys } = (await response.json()) as { keys: JsonWebKey[] };
  const key = await importJWK(keys[0]!, 'ES256');
  const { payload, protectedHeader } = await jwtVerify(fresh, key, {
    issuer: real.auth.issuer,
    audience: real.auth.audience,
    algorithms: ['ES256'],
    typ: 'at+jwt',
    currentDate: issuanceTime,
  });
  expect(protectedHeader.typ).toBe('at+jwt');
  expect(payload.sub).toBe(account);
  expect(payload.client_id).toBe('web');
  expect(payload.scope).toBe(actions.join(' '));
  expect(payload.authn_epoch).toBe(1);
  expect(payload.exp! - payload.iat!).toBe(300);
  expect(payload.auth_time).toBe(payload.iat);
  expect((await access.authenticate(fresh, context)).accountId).toBe(account);

  const route = routeOf(account)!;
  await db.admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    route,
    account,
  ]);
  const belowFloor = await real.refreshBearer('importer');
  await expect(access.authenticate(belowFloor, context)).rejects.toMatchObject({ status: 401 });

  await db.admin.query(
    "UPDATE access.account SET minimum_authn_epoch=1, state='suspended' WHERE route=$1 AND account_id=$2",
    [route, account],
  );
  const whileSuspended = await real.refreshBearer('importer');
  try {
    await expect(access.authenticate(whileSuspended, context)).rejects.toMatchObject({ status: 401 });
  } finally {
    await db.admin.query(
      "UPDATE access.account SET minimum_authn_epoch=1, state='active' WHERE route=$1 AND account_id=$2",
      [route, account],
    );
  }
});
