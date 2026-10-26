import { createAuthService, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createOperatorSessionCapability } from '../../src/access/auth-session-capability.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const issuer = 'https://operator.auth.test';
const password = 'correct horse battery staple';
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
async function fixture(pool: Pool, authPool: Pool, url: string) {
  migrateAuth(url);
  let service: AuthService;
  let sequence = 0;
  const key = () => `session-${++sequence}`;
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const access = createAccess({
    actions,
    auth: {
      issuer,
      audience: 'https://operator.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const operators = createOperatorCommands({ pool, access, actions, managementAction: 'account:manage' });
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(83)]]) };
  const capability = createOperatorSessionCapability({
    pool,
    access,
    operators,
    referenceKeys,
    accessTokenForProof: (proof) => service.internal.accessTokenForProof(proof),
  });
  const registration = createRegistrationProofBindings({ pool, referenceKeys });
  const internal = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  service = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://operator.api.test',
    secret: 'operator-session-persistent-secret-at-least-32-bytes',
    signing: {
      activeKid: 'operator-key',
      privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid: 'operator-key' }],
    },
    trustedAccess: createAuthBindings({ pool, ...registration, ...capability }),
  });
  await service.internal.registerClient({
    clientId: 'operator-web',
    firstParty: true,
    scopes: ['account:manage', 'read'],
  });
  await service.internal.registerClient({
    clientId: 'other-web',
    firstParty: true,
    scopes: ['account:manage', 'read'],
  });
  const request = (path: string, body?: unknown, headers = new Headers()) =>
    service.handler(
      new Request(`${issuer}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  async function person() {
    const id = newId(0x9200);
    const handle = `session_person_${key().replaceAll('-', '_')}`;
    const held = await internal.reserveHandle({ accountId: id, handle, key: key() });
    const input = { accountId: id, handle, reservationId: held.value.reservationId, key: key() };
    const outcome = await internal.createPending(input);
    const authorization = (await registration.createProvisioningReference({ input, outcome }))!;
    await service.internal.provisionPassword({ authorization, email: `${id}@session.test`, password });
    // Trusted fixture activation only; all opening authorization and consumption is native.
    await authPool.query("UPDATE access.account SET state='active' WHERE account_id=$1", [id]);
    await operators.provisionManagementDefaults({ operatorAccountId: id, key: key() });
    return id;
  }
  const login = async (id: string, scope = ['account:manage'], client_id = 'operator-web') => {
    const response = await request('/signin', { email: `${id}@session.test`, password, client_id, scope });
    expect(response.status).toBe(200);
    return cookies(response);
  };
  async function context(headers: Headers) {
    const response = await request('/token', {}, headers);
    expect(response.status).toBe(200);
    const { access_token } = (await response.json()) as { access_token: string };
    const deadline = Date.now() + 3000;
    const actor = await access.authenticate(access_token, { pool, deadline });
    return { actor, account: await readAccount(pool, routeOf(actor.accountId)!, actor.accountId), deadline };
  }
  async function automate(operatorAccountId: string) {
    const subjectAccountId = await person();
    const hold = await operators.reserveResponsibility({ operatorAccountId, subjectAccountId, key: key() });
    await operators.recordOperatorRelation({
      ...hold.value,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      key: key(),
    });
    return subjectAccountId;
  }
  async function opening(
    headers: Headers,
    operatorAccountId: string,
    subjectAccountId: string,
    purpose: 'session' | 'credential-management' = 'session',
  ) {
    const outcome = await operators.authorizeOpening(await context(headers), {
      operatorAccountId,
      subjectAccountId,
      purpose,
      key: key(),
    });
    return { outcome, reference: capability.createOpeningReference(outcome.value) };
  }
  const open = (authorization: string, subjectAccountId: string, headers: Headers) =>
    service.internal.openAutomatedSession({ authorization, subjectAccountId, headers });
  return {
    service,
    access,
    operators,
    capability,
    referenceKeys,
    request,
    person,
    login,
    context,
    automate,
    opening,
    open,
    key,
  };
}

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof fixture>>;
let human: string;
let subject: string;
let headers: Headers;
// A hook or test that times out leaves its promise running; afterAll stops and awaits both so no command outlives the pool.
let seeding: Promise<unknown> = Promise.resolve();
let running: Promise<unknown> = Promise.resolve();
let closing = false;
const assertOpen = () => {
  if (closing) throw new Error('The fixture is closing');
};
async function seed() {
  db = await openGrowthDatabase();
  f = await fixture(db.pool, db.openPool(), db.url);
  human = await f.person();
  subject = await f.automate(human);
  headers = await f.login(human);
  const ids = Array.from({ length: 2048 }, () => newId(routeOf(human)!));
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
    [routeOf(human)!, ids],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,id,id,'account:manage','(,)',id FROM unnest($2::uuid[]) id`,
    [routeOf(human)!, ids],
  );
  // Stay beyond tiny-table planner crossovers at every measured scale.
  for (let index = 0; index < 512 && !closing; index++) {
    const opening = await f.opening(headers, human, subject);
    await f.operators.consumeOpening(await f.context(headers), {
      operatorAccountId: human,
      subjectAccountId: subject,
      receiptId: opening.outcome.value.receiptId,
      purpose: 'session',
      key: f.key(),
    });
  }
}
// The history is fixed work of 512 native openings; the budget covers a host under full check load.
beforeAll(() => (seeding = seed()), 180_000);
afterAll(async () => {
  closing = true;
  await Promise.allSettled([seeding, running]);
  await db?.close();
});

test('native adapter to command to Auth session remains bounded across opening history, invalid locators and replay', async () => {
  const report = await (running = checkGrowth(db, {
    name: 'operator session capability',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    grow: async (database, scale, previous) => {
      for (let index = previous * 4; index < scale * 4; index++) {
        assertOpen();
        const opening = await f.opening(headers, human, subject);
        await f.operators.consumeOpening(await f.context(headers), {
          operatorAccountId: human,
          subjectAccountId: subject,
          receiptId: opening.outcome.value.receiptId,
          purpose: 'session',
          key: f.key(),
        });
        // Trusted unrelated account/resource data, with a fixed authorization neighbourhood K.
        const id = newId(routeOf(human)!);
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
          VALUES ($1,$2,'actor','active',$3)`,
          [routeOf(id)!, id, newId(routeOf(id)!)],
        );
        await database.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
          VALUES ($1,$2,$2,'account:manage','(,)',$3)`,
          [routeOf(id)!, id, newId(routeOf(id)!)],
        );
      }
      for (const table of [
        'core.receipt',
        'access.operator_opening_receipt',
        'access.account',
        'access.resource_grant',
        'auth_effect_receipt',
        'auth_session_opening',
        'session',
      ])
        await database.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    operation: async () => {
      assertOpen();
      const opening = await f.opening(headers, human, subject);
      const absent = f.capability.createOpeningReference({
        operatorAccountId: human,
        subjectAccountId: subject,
        receiptId: newId(routeOf(human)!),
      });
      await expect(f.open(absent, subject, headers)).rejects.toThrow();
      const response = await f.open(opening.reference, subject, headers);
      expect(response.status).toBe(200);
      const robotHeaders = cookies(response);
      expect((await f.context(robotHeaders)).actor.accountId).toBe(subject);
      expect(
        (
          await db.admin.query('SELECT receipt_id,account_id,purpose FROM auth_effect_receipt WHERE receipt_id=$1', [
            opening.outcome.value.receiptId,
          ])
        ).rows,
      ).toEqual([{ receipt_id: opening.outcome.value.receiptId, account_id: subject, purpose: 'session' }]);
      await expect(f.open(opening.reference, subject, headers)).rejects.toThrow();
      expect((await f.request('/signout', {}, robotHeaders)).status).toBe(200);
    },
  }));
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.operator_opening_receipt']?.rows).toBeGreaterThan(0);
    expect(sample.cost.relations?.['public.auth_effect_receipt']).toBeDefined();
    expect(sample.cost.relations?.['public.session']?.rows).toBeGreaterThan(0);
  }
}, 60_000);
