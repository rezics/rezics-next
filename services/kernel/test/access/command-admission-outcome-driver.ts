import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type {
  Account,
  Actor,
  Attempt,
  CommandAdmissionDriver,
  Fixture,
  Snapshot,
} from '../../../../specs/command-admission-outcomes-driver.ts';

const issuer = 'https://command-admission.example.test';
const audience = 'https://api.command-admission.example.test';
const clientId = 'command-admission-fixture';
const action = 'subject:read';
const managementAction = 'access:grant';
const suspensionAction = 'account:suspend';
const delegationAction = 'account:delegate';
const createdAction = 'subject:read';
const grantEventType = 'com.rezics.access.grant.create.v1';

type SeedData = { recipientId: string };
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseName(url: string): string {
  const value = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!value) throw new Error('DATABASE_URL must select the migrated kernel database');
  return value;
}

function transactionId(): string {
  return randomUUID();
}

export async function createCommandAdmissionDriver(): Promise<CommandAdmissionDriver> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL must name the migrated kernel database');

  const sourceName = databaseName(sourceUrl);
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
  const name = `admission_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.pathname = `/${name}`;

  let pool: ReturnType<typeof createPool> | undefined;
  let fixturePool: Pool | undefined;
  let observationPool: Pool | undefined;
  let kernel: ReturnType<typeof createKernel> | undefined;
  let access!: ReturnType<typeof createAccess>;
  let closed = false;
  let nativeAt: string | null = null;
  const otherPools: ReturnType<typeof createPool>[] = [];
  const fixtureData = new WeakMap<Fixture, SeedData>();
  const createdDatabase = { value: false };

  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(sourceName)}`);
    createdDatabase.value = true;
    const runtimePool = createPool(isolatedUrl.toString());
    pool = runtimePool;
    runtimePool.options.max = 4;
    fixturePool = new Pool({ connectionString: isolatedUrl.toString(), max: 2 });
    observationPool = new Pool({ connectionString: isolatedUrl.toString(), max: 4 });
    fixturePool.on('error', () => {});
    observationPool.on('error', () => {});

    runtimePool.on('connect', (client) => {
      const query = client.query.bind(client);
      client.query = ((...args: Parameters<PoolClient['query']>) => {
        const config = args[0] as unknown as string | { text: string; values?: unknown[] };
        const text = typeof config === 'string' ? config : config.text;
        if (!text.includes('transaction_timestamp()')) return query(...args);
        const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
        if (callbackIndex >= 0) {
          const forwarded = [...args] as unknown[];
          const callback = forwarded[callbackIndex] as (...values: unknown[]) => void;
          forwarded[callbackIndex] = (...values: unknown[]) => {
            const result = values[1] as { rows?: { at?: string }[] } | undefined;
            const at = result?.rows?.[0]?.at;
            if (typeof at === 'string') nativeAt = at;
            callback(...values);
          };
          return query(...(forwarded as Parameters<PoolClient['query']>));
        }
        const result = query(...args);
        void (result as unknown as Promise<{ rows?: { at?: string }[] }>).then((value) => {
          const at = value.rows?.[0]?.at;
          if (typeof at === 'string') nativeAt = at;
        });
        return result;
      }) as PoolClient['query'];
    });

    const signing = await generateKeyPair('ES256', { extractable: true });
    const jwks = {
      keys: [
        {
          ...(await exportJWK(signing.publicKey)),
          kid: 'command-admission-fixture',
          alg: 'ES256',
          use: 'sig',
        },
      ],
    };

    const runtimeKernel = createKernel({
      pool: runtimePool,
      routeKey: new Uint8Array(32).fill(43),
      access: () => access,
    });
    kernel = runtimeKernel;
    const actions = new Map(actionCatalogue(runtimeKernel));
    actions.set(delegationAction, { anonymous: false });
    access = createAccess({
      actions,
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        async fetch() {
          return Response.json(jwks);
        },
      },
    });

    const grants = createGrantCommands({ pool: runtimePool, access, managementAction });
    const delegations = createDelegationCommands({ pool: runtimePool, access, action: delegationAction });
    const suspensions = createSuspensionCommands({ pool: runtimePool, access, clock: () => new Date() });
    const lifecycle = createLifecycleInternals({
      pool: runtimePool,
      routeKey: new Uint8Array(32).fill(44),
      provisioningEvidence: async () => null,
      recoveryEvidence: async () => null,
    });

    async function sign(
      accountId: string,
      scopes: readonly string[],
      requestedBy?: string,
    ): Promise<{ token: string; expiresAt: number }> {
      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresAt = (issuedAt + 300) * 1000;
      const payload = {
        client_id: clientId,
        scope: [...scopes].join(' '),
        authn_epoch: 1,
        auth_time: issuedAt,
        amr: ['pwd'],
        ...(requestedBy === undefined ? {} : { requested_by: requestedBy }),
      };
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'command-admission-fixture' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(accountId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .sign(signing.privateKey);
      return { token, expiresAt };
    }

    async function insertAccount(id: string): Promise<void> {
      const route = routeOf(id);
      if (route === null) throw new Error(`Fixture account ID is not routable: ${id}`);
      await fixturePool!.query(
        `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
         VALUES ($1, $2, 'actor', 'active', $3)`,
        [route, id, transactionId()],
      );
    }

    async function insertGrant(
      resource: { route: number; id: string },
      subjectId: string,
      grantAction: string,
    ): Promise<void> {
      await fixturePool!.query(
        `INSERT INTO access.resource_grant
          (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
         VALUES ($1, $2, 'identity', $3, '', $4, '(,)', $5)`,
        [resource.route, resource.id, subjectId, grantAction, transactionId()],
      );
    }

    function nativeGrantKey(f: Fixture, key: string): string {
      const prefix = `${f.resource.route}:`;
      if (!key.startsWith(prefix)) throw new TypeError('Command key does not match its resource route');
      return key.slice(prefix.length);
    }

    async function seed(mode?: 'missing-scope'): Promise<Fixture> {
      const actorId = newId(0x1234);
      const principalId = newId(0x2345);
      const recipientId = newId(0x3456);
      const resourceRoute = 0x8000 + otherPools.length * 16 + seedCounter++ * 16;
      const resource = { route: resourceRoute, id: newId(resourceRoute) };
      const requestId = newId(routeOf(principalId)!);
      for (const id of [actorId, principalId, recipientId]) await insertAccount(id);

      for (const grantAction of [managementAction, action]) {
        await insertGrant(resource, actorId, grantAction);
        await insertGrant(resource, principalId, grantAction);
      }
      const global = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
      await insertGrant(global, actorId, suspensionAction);
      await insertGrant(global, principalId, suspensionAction);
      await insertGrant({ route: routeOf(principalId)!, id: principalId }, principalId, delegationAction);

      const principalScopes = [delegationAction];
      const principalToken = await sign(principalId, principalScopes);
      const principalStartedAt = Date.now();
      const principalDeadline = principalStartedAt + 180_000;
      const principalActor = await access.authenticate(principalToken.token, {
        pool: runtimePool,
        deadline: principalDeadline,
      });
      await delegations.create(
        { pool: runtimePool, actor: principalActor, deadline: principalDeadline },
        { principalId, assignedActorId: actorId, requestId, valid: '(,)', key: `assignment-${randomUUID()}` },
      );
      const requestedBy = `urn:rezics:request:${principalId}:${requestId}`;
      const actorScopes = [managementAction, suspensionAction, ...(mode === 'missing-scope' ? [] : [action])];
      const bearer = await sign(actorId, actorScopes, requestedBy);
      const authenticationStartedAt = Date.now();
      const deadline = authenticationStartedAt + 180_000;
      const actor = await access.authenticate(bearer.token, { pool: runtimePool, deadline });
      const keyPrefix = `${resource.route}:`;
      const fixture: Fixture = {
        actor,
        access,
        pool: runtimePool,
        deadline,
        authenticationStartedAt,
        tokenExpiresAt: bearer.expiresAt,
        bearer: bearer.token,
        action,
        resource,
        keys: [`${keyPrefix}${randomUUID()}`, `${keyPrefix}${randomUUID()}`],
      };
      fixtureData.set(fixture, { recipientId });
      return fixture;
    }

    let seedCounter = 0;

    async function execute(
      fixture: Fixture,
      key: string,
      override?: { actor?: Actor; pool?: object },
    ): Promise<Attempt> {
      const startedAt = Date.now();
      const actor = override?.actor ?? fixture.actor;
      const commandPool = override?.pool ?? fixture.pool;
      nativeAt = null;
      try {
        const data = fixtureData.get(fixture);
        if (!data) throw new TypeError('Unknown command admission fixture');
        const outcome = await grants.create(
          { pool: commandPool as ReturnType<typeof createPool>, actor, deadline: fixture.deadline },
          {
            resource: fixture.resource,
            subject: { kind: 'account', id: data.recipientId },
            actions: [createdAction],
            valid: '(,)',
            key: nativeGrantKey(fixture, key),
          },
        );
        return {
          actor,
          access: fixture.access,
          pool: commandPool,
          startedAt,
          at: nativeAt,
          result: {
            outcome: 'permitted',
            receiptId: outcome.transactionId,
            replayed: outcome.replayed,
            value: outcome.value,
          },
        };
      } catch (error) {
        if (!(error instanceof GrantDeniedError)) throw error;
        return {
          actor,
          access: fixture.access,
          pool: commandPool,
          startedAt,
          at: nativeAt,
          result: { outcome: 'denied' },
        };
      }
    }

    async function otherPool(): Promise<object> {
      const candidate = createPool(isolatedUrl.toString());
      candidate.options.max = 1;
      otherPools.push(candidate);
      await candidate.query('SELECT current_database()');
      return candidate;
    }

    async function account(fixture: Fixture): Promise<Account> {
      const route = routeOf(fixture.actor.accountId);
      if (route === null) throw new TypeError('Fixture actor has no route');
      const result = await observationPool!.query(
        `SELECT state, authn_fenced AS fenced, minimum_authn_epoch::text AS "minimumAuthnEpoch"
         FROM access.account WHERE route = $1 AND account_id = $2`,
        [route, fixture.actor.accountId],
      );
      const row = result.rows[0] as Account | undefined;
      if (!row) throw new Error('Fixture actor account disappeared');
      return row;
    }

    async function transition(
      fixture: Fixture,
      fact: 'suspended' | 'floor' | 'fence' | 'actor-grant' | 'principal-grant',
    ): Promise<void> {
      const deadline = fixture.deadline;
      if (fact === 'suspended') {
        await suspensions.suspend(
          { pool: runtimePool, actor: fixture.actor, deadline },
          { accountId: fixture.actor.accountId, key: `suspend-${randomUUID()}` },
        );
        return;
      }
      if (fact === 'floor') {
        await lifecycle.advanceAuthenticationFloor(
          {
            accountId: fixture.actor.accountId,
            key: `floor-${randomUUID()}`,
            purpose: 'consent-reduction',
            expectedMinimumAuthnEpoch: fixture.actor.authnEpoch,
            proofReference: 'a'.repeat(64),
            proofDigest: 'b'.repeat(64),
            proofExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          async () => true,
        );
        return;
      }
      if (fact === 'fence') {
        await lifecycle.raiseFence({ accountId: fixture.actor.accountId, key: `fence-${randomUUID()}` });
        return;
      }

      const subjectId = fact === 'actor-grant' ? fixture.actor.accountId : principalIdOf(fixture.actor.requestedBy);
      await grants.revoke(
        { pool: runtimePool, actor: fixture.actor, deadline },
        {
          resource: fixture.resource,
          subject: { kind: 'account', id: subjectId },
          actions: [action],
          valid: '(,)',
          key: `${fact}-${randomUUID()}`,
        },
      );
    }

    async function inspect(fixture: Fixture): Promise<Snapshot> {
      const data = fixtureData.get(fixture);
      if (!data) throw new TypeError('Unknown command admission fixture');
      const partition = partitionOf(fixture.resource.route);
      const [grantsResult, rolesResult, denialsResult, initializedResult, effectsResult, outboxResult, receiptsResult] =
        await Promise.all([
          observationPool!.query(
            `SELECT route, resource_id::text AS "resourceId", subject_kind AS "subjectKind", subject_id::text AS "subjectId",
                    subject_role AS "subjectRole", action, valid::text AS valid, transaction_id::text AS "transactionId"
             FROM access.resource_grant WHERE route = $1 AND resource_id = $2 ORDER BY subject_kind, subject_id, subject_role, action, valid, transaction_id`,
            [fixture.resource.route, fixture.resource.id],
          ),
          observationPool!.query(
            `SELECT route, resource_id::text AS "resourceId", subject_kind AS "subjectKind", subject_id::text AS "subjectId",
                    subject_role AS "subjectRole", grant_role AS "grantRole", valid::text AS valid, transaction_id::text AS "transactionId"
             FROM access.resource_role_grant WHERE route = $1 AND resource_id = $2 ORDER BY subject_kind, subject_id, subject_role, grant_role, valid, transaction_id`,
            [fixture.resource.route, fixture.resource.id],
          ),
          observationPool!.query(
            `SELECT route, resource_id::text AS "resourceId", subject_id::text AS "subjectId", subject_role AS "subjectRole",
                    action, reason, valid::text AS valid, transaction_id::text AS "transactionId"
             FROM access.resource_denial WHERE route = $1 AND resource_id = $2 ORDER BY subject_id, subject_role, action, reason, valid, transaction_id`,
            [fixture.resource.route, fixture.resource.id],
          ),
          observationPool!.query(
            `SELECT route, resource_id::text AS "resourceId", resource_type AS "resourceType", creator_id::text AS "creatorId",
                    initialized_at::text AS "initializedAt"
             FROM access.resource_initialization WHERE route = $1 AND resource_id = $2 ORDER BY resource_type, creator_id, initialized_at`,
            [fixture.resource.route, fixture.resource.id],
          ),
          observationPool!.query(
            `SELECT route, resource_id::text AS "resourceId", subject_kind AS "subjectKind", subject_id::text AS "subjectId",
                    action, valid::text AS valid, transaction_id::text AS "transactionId"
             FROM access.resource_grant
             WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND action = $4
             ORDER BY subject_kind, subject_role, valid, transaction_id`,
            [fixture.resource.route, fixture.resource.id, data.recipientId, createdAction],
          ),
          observationPool!.query(
            `SELECT partition_no AS partition, "position"::text AS position, event_seq AS "eventSeq", event_count AS "eventCount",
                    epoch, id::text, type, subject, data, recorded_at::text AS "recordedAt"
             FROM core.outbox WHERE partition_no = $1 AND type = $2 AND subject = $3
             ORDER BY epoch, "position", event_seq`,
            [partition, grantEventType, fixture.resource.id],
          ),
          observationPool!.query(
            `SELECT transaction_id::text AS id, idempotency_key AS key, response
             FROM core.receipt
             WHERE partition_no = $1 AND principal_kind = 'account' AND principal_id = $2 AND command_kind = 'access.grant.create'
             ORDER BY epoch, "position"`,
            [partition, fixture.actor.accountId],
          ),
        ]);
      return {
        state: {
          resourceGrants: grantsResult.rows,
          roleGrants: rolesResult.rows,
          denials: denialsResult.rows,
          initialization: initializedResult.rows,
        },
        effects: effectsResult.rows,
        outbox: outboxResult.rows,
        receipts: receiptsResult.rows,
      };
    }

    async function http(fixture: Fixture, key: string): Promise<Response> {
      const data = fixtureData.get(fixture);
      if (!data) throw new TypeError('Unknown command admission fixture');
      return kernel!.handle(
        new Request('http://kernel.test/v1/grants', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fixture.bearer}`,
            'content-type': 'application/json',
            [IDEMPOTENCY_HEADER]: JSON.stringify(key),
          },
          body: JSON.stringify({
            resource: fixture.resource,
            subject: { kind: 'account', id: data.recipientId },
            actions: [createdAction],
            valid: '(,)',
          }),
        }),
      );
    }

    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        ...(pool ? [pool.end()] : []),
        ...(fixturePool ? [fixturePool.end()] : []),
        ...(observationPool ? [observationPool.end()] : []),
        ...otherPools.map((candidate) => candidate.end()),
      ]);
      if (createdDatabase.value) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
      }
      await admin.end();
    }

    return { seed, execute, otherPool, transition, account, inspect, http, close };
  } catch (error) {
    await Promise.allSettled([
      ...(pool ? [pool.end()] : []),
      ...(fixturePool ? [fixturePool.end()] : []),
      ...(observationPool ? [observationPool.end()] : []),
      ...otherPools.map((candidate) => candidate.end()),
    ]);
    if (createdDatabase.value) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw error;
  }
}

function principalIdOf(requestedBy: string | null): string {
  const match = /^urn:rezics:request:([0-9a-f-]{36}):[0-9a-f-]{36}$/.exec(requestedBy ?? '');
  if (!match?.[1]) throw new TypeError('Fixture actor has no principal-created request assignment');
  return match[1];
}
