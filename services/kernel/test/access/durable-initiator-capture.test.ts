import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  AccessUnavailableError,
  captureDurableInitiator,
  createAccess,
  durableInitiatorCommitment,
  DurableInitiatorCaptureUnavailableError,
} from '../../src/access/index.ts';
import { commandAccessContext } from '../../src/access/command-admission.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { authoritativeTimeValue, runCommand, type CommandAttempt } from '../../src/command/command.ts';
import type { AccessContext, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { nativeModule } from './durable-initiator.test.ts';

/** Component issuer exercises real authentication/admission; nativeModule below
 * separately proves the committed writer/receipt/restorer lifecycle.
 */
export async function captureFixture(db: GrowthDatabase, delegated: boolean, scopes = ['subject:write']) {
  const action = scopes[0]!;
  const id = newId(0x1234);
  const principal = newId(0x2345);
  const request = newId(0x2345);
  const transactionId = newId(0x2345);
  const target = { route: 0x5678, id: newId(0x5678) };
  const requestedBy = delegated ? `urn:rezics:request:${principal}:${request}` : null;
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2),($3,$4,'actor','active',$4)`,
    [routeOf(id), id, routeOf(principal), principal],
  );
  if (delegated)
    await db.admin.query(
      `INSERT INTO access.principal_assignment
      (route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id)
      VALUES ($1,$2,$2,$3,$4,'[2000-01-01,2100-01-01)',$5)`,
      [routeOf(principal), principal, request, id, transactionId],
    );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,$2,id,$5,'(,)',$3 FROM unnest($4::uuid[]) id`,
    [target.route, target.id, id, [id, principal], action],
  );
  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'capture', alg: 'ES256' }] };
  const issuer = 'https://capture.test';
  const access = createAccess({
    actions: new Map([[action, { anonymous: false }]]),
    auth: { issuer, audience: issuer, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json(jwks) },
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sub: id,
    client_id: 'capture',
    scope: scopes.join(' '),
    authn_epoch: 10,
    auth_time: now,
    amr: ['pwd'],
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'capture' })
    .sign(keys.privateKey);
  const context = { pool: db.pool, deadline: Date.now() + 180_000 };
  const actor = await access.authenticate(token, context);
  return { db, access, actor, context, target, principal, request, transactionId, action };
}

type Fixture = Awaited<ReturnType<typeof captureFixture>>;
export async function captureAttempt(
  f: Fixture,
  observe: (context: AccessContext, attempt: CommandAttempt) => Promise<unknown>,
  admit = true,
) {
  const authorization = resourceAuthorization({
    access: f.access,
    actor: f.actor,
    action: f.action,
    anchor: { resource: f.target, validate: async () => true },
    context: { ...f.context, partition: partitionOf(f.target.route) },
  });
  let writes = 0;
  const outcome = await runCommand(
    f.db.pool,
    {
      partition: partitionOf(f.target.route),
      deadline: f.context.deadline,
      basis: { actorAccountId: f.actor.accountId, clientId: f.actor.clientId, requestedBy: f.actor.requestedBy },
      authorization: {
        ...authorization,
        async prepare(attempt) {
          const proof = admit ? await authorization.prepare!(attempt) : undefined;
          await observe(commandAccessContext(f.context, attempt), attempt);
          return proof;
        },
      },
    },
    async (tx) => {
      writes++;
      await tx.query('INSERT INTO capture_effect VALUES ($1)', [f.target.id]);
      return { value: 'captured', events: [{ type: 'capture.created', data: {} }] };
    },
  );
  return { outcome, writes };
}

if (Bun.main === import.meta.path) {
  let db: GrowthDatabase;
  beforeAll(async () => {
    db = await openGrowthDatabase();
    db.pool.options.max = 1;
    await db.admin.query('CREATE TABLE capture_effect(id uuid PRIMARY KEY)');
  });
  afterAll(async () => db?.close());

  test('a native admitted writer captures and commits the exact record accepted by the restorer', async () => {
    const h = await nativeModule();
    try {
      for (const delegated of [false, true]) {
        const f = await h.fixture(delegated);
        const record = (
          await h.db.pool.query('SELECT record FROM durable_test.operation WHERE route=$1 AND id=$2', [
            f.operation.route,
            f.operation.id,
          ])
        ).rows[0].record;
        expect(record).not.toBeNull();
        expect(f.created.value.durableInitiator).toBe(durableInitiatorCommitment(record!));
        expect(durableInitiatorCommitment(record!)).toBe(
          createHash('sha256').update(canonicalize(record)!).digest('hex'),
        );
        expect((await h.step(f)).effects).toBe(1);
        await h.db.admin.query(
          `UPDATE access.account SET ${delegated ? 'operator_account_id=$3' : 'minimum_authn_epoch=2'} WHERE route=$1 AND account_id=$2`,
          delegated ? [routeOf(f.id), f.id, f.principal!.id] : [routeOf(f.id), f.id],
        );
        await expect(h.step(f)).rejects.toThrow();
      }
    } finally {
      await h.close();
    }
  });

  for (const delegated of [false, true]) {
    test(`capture reuses admission and adds ${delegated ? 'one delegation read' : 'zero reads'}`, async () => {
      const f = await captureFixture(db, delegated);
      const observed = await capture(db, () =>
        captureAttempt(f, async (context, attempt) => {
          const cost = await captureDurableInitiator(context, f.actor);
          expect(cost.originalAccount).toEqual({ minimumAuthnEpoch: '1', operatorAccountId: null });
          expect(Object.keys(cost).sort()).toEqual(['originalAccount', 'originalDelegation']);
          if (delegated) {
            const row = (
              await db.admin.query(
                'SELECT issued_valid::text AS valid FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
                [routeOf(f.principal), f.principal, f.request],
              )
            ).rows[0];
            expect(cost.originalDelegation).toEqual({ transactionId: f.transactionId, issuedValid: row.valid });
          } else expect(cost.originalDelegation).toBeNull();
          expect(authoritativeTimeValue(attempt.time)).toBeString();
        }),
      );
      const reads = observed.capture.statements.filter((sql) => sql.includes('issued_valid::text'));
      expect(reads).toHaveLength(delegated ? 1 : 0);
      expect(
        observed.capture.statements.filter(
          (sql) =>
            sql.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"') && sql.includes('FROM access.account'),
        ),
      ).toHaveLength(1);
      expect(observed.value.writes).toBe(1);
    });
  }

  for (const changed of ['floor', 'operator']) {
    test(`capture retains the admission observation when ${changed} changes after T`, async () => {
      const f = await captureFixture(db, false);
      await captureAttempt(f, async (context) => {
        await db.admin.query(
          `UPDATE access.account SET ${changed === 'floor' ? 'minimum_authn_epoch=2' : 'operator_account_id=$3'} WHERE route=$1 AND account_id=$2`,
          changed === 'floor'
            ? [routeOf(f.actor.accountId), f.actor.accountId]
            : [routeOf(f.actor.accountId), f.actor.accountId, f.principal],
        );
        expect(await captureDurableInitiator(context, f.actor)).toEqual({
          originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null },
          originalDelegation: null,
        });
      });
    });
  }

  for (const failure of [
    'no admission',
    'refused floor',
    'refused operator',
    'anonymous',
    'copied actor',
    'wrong pool',
    'expired',
    'missing',
    'revoked',
    'out of range',
    'non-native',
    'wrong assignee',
  ] as const) {
    test(`capture fails before any write: ${failure}`, async () => {
      const delegated = ['missing', 'revoked', 'out of range', 'non-native', 'wrong assignee'].includes(failure);
      const f = await captureFixture(db, delegated);
      if (failure === 'refused floor' || failure === 'refused operator')
        await db.admin.query(
          `UPDATE access.account SET ${failure === 'refused floor' ? 'minimum_authn_epoch=2' : 'operator_account_id=$3'} WHERE route=$1 AND account_id=$2`,
          failure === 'refused floor'
            ? [routeOf(f.actor.accountId), f.actor.accountId]
            : [routeOf(f.actor.accountId), f.actor.accountId, f.principal],
        );
      let reached = false;
      const observed = await capture(db, async () => {
        await expect(
          captureAttempt(
            f,
            async (context, attempt) => {
              reached = true;
              if (failure === 'refused floor' || failure === 'refused operator')
                expect(await f.access.prepare!(f.actor, 'subject:write', f.target, context)).toBeNull();
              if (delegated) {
                const locator = [routeOf(f.principal), f.principal, f.request];
                if (failure === 'missing')
                  await db.admin.query(
                    'DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
                    locator,
                  );
                else if (failure === 'revoked')
                  await db.admin.query(
                    "UPDATE access.principal_assignment SET revoked_at=transaction_timestamp(),valid=valid * tstzrange(NULL,transaction_timestamp(),'[)') WHERE route=$1 AND principal_id=$2 AND request_id=$3",
                    locator,
                  );
                else {
                  await db.admin.query(
                    'DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
                    locator,
                  );
                  await db.admin.query(
                    `INSERT INTO access.principal_assignment(route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id) VALUES ($1,$2,$4,$3,$5,$6,$7)`,
                    [
                      ...locator,
                      failure === 'non-native' ? null : f.principal,
                      failure === 'wrong assignee' ? f.principal : f.actor.accountId,
                      failure === 'out of range' ? '[1900-01-01,1901-01-01)' : '(,)',
                      f.transactionId,
                    ],
                  );
                }
              }
              const actor: Actor =
                failure === 'anonymous' ? { kind: 'anonymous' } : failure === 'copied actor' ? { ...f.actor } : f.actor;
              const ctx =
                failure === 'wrong pool'
                  ? commandAccessContext({ ...context, pool: db.admin }, attempt)
                  : failure === 'expired'
                    ? commandAccessContext({ ...context, deadline: Date.now() - 1 }, attempt)
                    : context;
              await expect(captureDurableInitiator(ctx, actor)).rejects.toBeInstanceOf(
                failure === 'expired' ? AccessUnavailableError : DurableInitiatorCaptureUnavailableError,
              );
              throw new DurableInitiatorCaptureUnavailableError();
            },
            !['no admission', 'refused floor', 'refused operator'].includes(failure),
          ),
        ).rejects.toBeInstanceOf(DurableInitiatorCaptureUnavailableError);
      });
      expect(reached).toBe(true);
      expect(observed.capture.statements.some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql.trim()))).toBe(false);
      expect((await db.admin.query('SELECT * FROM capture_effect WHERE id=$1', [f.target.id])).rowCount).toBe(0);
    });
  }

  test('unbound, copied and completed attempt contexts fail with a typed error without SQL', async () => {
    const f = await captureFixture(db, false);
    let retained: AccessContext;
    await captureAttempt(f, async (context) => {
      retained = context;
      await expect(captureDurableInitiator({ ...context }, f.actor)).rejects.toBeInstanceOf(
        DurableInitiatorCaptureUnavailableError,
      );
    });
    const observed = await capture(db, async () => {
      for (const context of [f.context, retained!])
        await expect(captureDurableInitiator(context, f.actor)).rejects.toBeInstanceOf(
          DurableInitiatorCaptureUnavailableError,
        );
    });
    expect(observed.capture.statements).toHaveLength(0);
  });
}
