import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { fromPlainText } from '@rezics/document';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createCredentialCapability } from '../../src/access/auth-credential-capability.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import type { CredentialFloorBinding, SessionProof } from '@rezics/auth-contract';
import { createThread } from '../../src/content/commands.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { RequestContext, ThreadInput } from '../../src/content/model.ts';
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
const action = 'thread:create';
const boardReadAction = 'board:read';
const managementAction = 'access:grant';
const suspensionAction = 'account:suspend';
const delegationAction = 'account:delegate';
const credentialManagementAction = 'account:manage';
const threadCreatedEventType = 'com.rezics.content.thread.created.v1';
const threadCommandKind = 'content.thread.create';

type SeedData = { command: ThreadInput };
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
    actions.set(credentialManagementAction, { anonymous: false });
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
    ): Promise<{ token: string; expiresAt: number; issuedAt: number }> {
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
      return { token, expiresAt, issuedAt };
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

    async function insertBoard(resource: { route: number; id: string }, subjectId: string): Promise<void> {
      await fixturePool!.query(
        `INSERT INTO content.board
          (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, 'Command admission fixture', 'published', 1, $4)`,
        [resource.route, resource.id, subjectId, transactionId()],
      );
    }

    async function seed(mode?: 'missing-scope'): Promise<Fixture> {
      const actorId = newId(0x1234);
      const principalId = newId(0x2345);
      const resourceRoute = 0x8000 + otherPools.length * 16 + seedCounter++ * 16;
      const resource = { route: resourceRoute, id: newId(resourceRoute) };
      const requestId = newId(routeOf(principalId)!);
      const subjectId = newId(resourceRoute);
      const command: ThreadInput = {
        title: 'Command admission fixture thread',
        body: fromPlainText('Command admission fixture body'),
        licence: 'MIT',
        subjectIds: [subjectId],
        boardId: resource.id,
        visibility: 'published',
      };
      for (const id of [actorId, principalId]) await insertAccount(id);
      await insertGrant({ route: routeOf(actorId)!, id: actorId }, actorId, credentialManagementAction);
      await insertBoard(resource, subjectId);

      for (const grantAction of [managementAction, action, boardReadAction]) {
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
      const actorScopes = [
        managementAction,
        suspensionAction,
        boardReadAction,
        ...(mode === 'missing-scope' ? [] : [action]),
      ];
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
      fixtureData.set(fixture, { command });
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
        const context: RequestContext = {
          deadline: fixture.deadline,
          idempotencyKey: key,
          requestId: randomUUID(),
        };
        const outcome = await createThread(
          {
            pool: commandPool as ReturnType<typeof createPool>,
            access,
            routeKey: new Uint8Array(32).fill(43),
          },
          actor,
          data.command,
          context,
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
        const scopes = [credentialManagementAction];
        const bearer = await sign(fixture.actor.accountId, scopes);
        const human: SessionProof = {
          account_id: fixture.actor.accountId,
          client_id: clientId,
          scope: scopes,
          authn_epoch: fixture.actor.authnEpoch,
          auth_time: bearer.issuedAt,
          amr: ['pwd'],
        };
        const stage: CredentialFloorBinding = {
          operationKey: `floor-${randomUUID()}`,
          effectReference: randomUUID(),
          effectDigest: 'a'.repeat(64),
          subjectAccountId: fixture.actor.accountId,
          purpose: 'remove-key',
          credentialRowId: randomUUID(),
          credentialRowVersion: '1',
          actingHumanId: human.account_id,
          clientId,
          scopes,
        };
        const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(45)]]) };
        const credential = createCredentialCapability({
          pool: runtimePool,
          access,
          operators: createOperatorCommands({
            pool: runtimePool,
            access,
            actions,
            managementAction: credentialManagementAction,
          }),
          workflowApprovals: createWorkflowApprovals({ pool: runtimePool, access, actions, referenceKeys }),
          referenceKeys,
          // Fixture Auth evidence only; native Access approves, consumes and advances the floor.
          accessTokenForProof: async () => bearer.token,
          verifyCredentialEffect: async () => structuredClone(stage),
        });
        const opening = await credential.approveCredentialEffect({ stage, human, deadline });
        const { authorization } = await credential.consumeAuthAuthorization({
          authorization: opening.reference,
          subjectAccountId: stage.subjectAccountId,
          purpose: stage.purpose,
          operationKey: stage.operationKey,
          effectReference: stage.effectReference,
          human,
          deadline,
        });
        await credential.advanceCredentialFloor({
          stage,
          consumedOpening: authorization,
          expectedPreviousFloor: fixture.actor.authnEpoch,
          key: stage.operationKey,
          purpose: stage.purpose,
          deadline,
        });
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
      const [
        threadsResult,
        postsResult,
        revisionsResult,
        grantsResult,
        rolesResult,
        denialsResult,
        initializedResult,
        outboxResult,
        receiptsResult,
      ] = await Promise.all([
        observationPool!.query(
          `SELECT to_jsonb(t) AS row FROM content.thread t
           WHERE t.board_id = $1 ORDER BY t.route, t.thread_id`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT to_jsonb(p) AS row FROM content.post p
           JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
           WHERE t.board_id = $1 ORDER BY p.route, p.thread_id, p.post_id`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT to_jsonb(r) AS row FROM content.revision r
           JOIN content.thread t ON t.route = r.route AND t.thread_id = r.thread_id
           WHERE t.board_id = $1 ORDER BY r.route, r.thread_id, r.post_id, r.revision_id`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT to_jsonb(g) AS row FROM access.resource_grant g
           WHERE EXISTS (SELECT 1 FROM content.thread t WHERE t.route = g.route AND t.thread_id = g.resource_id AND t.board_id = $1)
              OR EXISTS (SELECT 1 FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
                         WHERE t.route = g.route AND p.post_id = g.resource_id AND t.board_id = $1)
           ORDER BY g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT to_jsonb(g) AS row FROM access.resource_role_grant g
           WHERE EXISTS (SELECT 1 FROM content.thread t WHERE t.route = g.route AND t.thread_id = g.resource_id AND t.board_id = $1)
              OR EXISTS (SELECT 1 FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
                         WHERE t.route = g.route AND p.post_id = g.resource_id AND t.board_id = $1)
           ORDER BY g.route, g.resource_id, g.subject_kind, g.subject_id, g.subject_role, g.grant_role, g.valid`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT to_jsonb(d) AS row FROM access.resource_denial d
           WHERE EXISTS (SELECT 1 FROM content.thread t WHERE t.route = d.route AND t.thread_id = d.resource_id AND t.board_id = $1)
              OR EXISTS (SELECT 1 FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
                         WHERE t.route = d.route AND p.post_id = d.resource_id AND t.board_id = $1)
           ORDER BY d.route, d.resource_id, d.subject_id, d.subject_role, d.action, d.reason, d.valid`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT to_jsonb(i) AS row FROM access.resource_initialization i
           WHERE EXISTS (SELECT 1 FROM content.thread t WHERE t.route = i.route AND t.thread_id = i.resource_id AND t.board_id = $1)
              OR EXISTS (SELECT 1 FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
                         WHERE t.route = i.route AND p.post_id = i.resource_id AND t.board_id = $1)
           ORDER BY i.route, i.resource_id`,
          [fixture.resource.id],
        ),
        observationPool!.query(
          `SELECT partition_no AS partition, "position"::text AS position, event_seq AS "eventSeq", event_count AS "eventCount",
                  epoch, id::text, type, subject, data, recorded_at::text AS "recordedAt"
           FROM core.outbox WHERE type = $1 AND data->>'actorId' = $2
           ORDER BY partition_no, epoch, "position", event_seq`,
          [threadCreatedEventType, fixture.actor.accountId],
        ),
        observationPool!.query(
          `SELECT transaction_id::text AS id, idempotency_key AS key, response
           FROM core.receipt
           WHERE principal_kind = 'account' AND principal_id = $1 AND command_kind = $2
           ORDER BY partition_no, epoch, "position"`,
          [fixture.actor.accountId, threadCommandKind],
        ),
      ]);
      return {
        state: {
          threads: threadsResult.rows,
          posts: postsResult.rows,
          revisions: revisionsResult.rows,
          resourceGrants: grantsResult.rows,
          roleGrants: rolesResult.rows,
          denials: denialsResult.rows,
          initialization: initializedResult.rows,
        },
        effects: threadsResult.rows,
        outbox: outboxResult.rows,
        receipts: receiptsResult.rows,
      };
    }

    async function http(fixture: Fixture, key: string): Promise<Response> {
      const data = fixtureData.get(fixture);
      if (!data) throw new TypeError('Unknown command admission fixture');
      return kernel!.handle(
        new Request('http://kernel.test/v1/threads', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fixture.bearer}`,
            'content-type': 'application/json',
            [IDEMPOTENCY_HEADER]: JSON.stringify(key),
          },
          body: JSON.stringify(data.command),
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
