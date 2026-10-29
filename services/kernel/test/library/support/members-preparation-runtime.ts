import { expect } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import type { Pool } from 'pg';
import { actionCatalogue } from '../../../src/http/request.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { runOperationalTransaction } from '../../../src/command/operational.ts';
import {
  createMembersPreparation,
  type PreparationDefinition,
  type PreparationLocator,
} from '../../../src/library/members-preparation.ts';
import { actorOf } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import { cookies, nativeFixture, password } from '../../access/native-account-bindings-fixture.ts';
import { capture, openGrowthDatabase } from '../../support/growth.ts';
import { createPersonas, type Persona } from '../../support/personas.ts';
import { registerTestClient, testKernel } from '../../support/test-kernel.ts';

/** Auth owns the only process-global executor. This fixture launches no kernel work runtime. */
export async function membersPreparationRuntime() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const auth = await nativeFixture(db.pool);
  const workClient = await createWorkClient(db.url, db.pool);
  await workClient.registerQueue('workflows', WORK_QUEUES.workflows);
  let now = Date.now();
  const clock = () => new Date(now);
  const service = auth.host.service;
  const kernel = testKernel({
    pool: db.pool,
    workClient,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'members-preparation-native-rate-secret-32-bytes' }),
  });
  const personas = await createPersonas(kernel, { version: 1, pool: db.pool, auth });
  const send = (persona: Persona | null, method: string, path: string, body?: unknown) =>
    kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(persona ? { authorization: `Bearer ${persona.bearer}` } : {}),
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  expect((await send(personas.staff, 'POST', '/v1/platform/exposure/collections:open', {})).status).toBe(200);
  const clientId = `members_${crypto.randomUUID()}`;
  const scopes = [...actionCatalogue(kernel).keys()].sort();
  await registerTestClient(service, { clientId, firstParty: true, scopes });
  const context = () => ({ pool: db.pool, deadline: Date.now() + 5000 });
  const actor = (persona: Persona | null, pool: Pool = db.pool) =>
    actorOf(
      kernel.testAccess,
      new Request('http://kernel.test', {
        headers: persona ? { authorization: `Bearer ${persona.bearer}` } : {},
      }),
      { ...context(), pool },
    );
  const store = (pool: Pool = db.pool) =>
    createMembersPreparation({ pool, workClient, access: kernel.testAccess, clock });
  async function person(): Promise<Persona> {
    const row = await auth.person(`m_${crypto.randomUUID().replaceAll('-', '')}`);
    const signed = await auth.request('/signin', {
      account_id: row.accountId,
      password,
      client_id: clientId,
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const token = await auth.request('/token', {}, cookies(signed));
    expect(token.status).toBe(200);
    return { accountId: row.accountId, bearer: ((await token.json()) as { access_token: string }).access_token };
  }
  async function fixture(selectedOwner?: Persona) {
    const owner = selectedOwner ?? (await person());
    const created = await send(owner, 'POST', '/v1/collections', {
      title: 'Private native preparation source',
      visibility: 'private',
    });
    expect(created.status).toBe(201);
    const { collection } = (await created.json()) as { collection: { id: string; curatorAccountId: string } };
    expect(collection.curatorAccountId).toBe(owner.accountId);
    expect(routeOf(collection.id)).toBe(routeOf(owner.accountId));
    const read = await capture(
      db,
      async () => {
        const response = await send(owner, 'GET', `/v1/collections/${collection.id}/members`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ members: [], next: null });
      },
      { includeBackends: true },
    );
    expect(db.pool.idleCount).toBe(db.pool.totalCount);
    expect(new Set(read.capture.statementBackends).size).toBe(1);
    console.log(
      `native preparation fixture reached: ${collection.id}; mounted Collection read admitted; snapshot released`,
    );
    return { owner, actor: await actor(owner), collectionId: collection.id, store: store(), read: read.capture };
  }
  async function step(locator: PreparationLocator) {
    return runOperationalTransaction(
      db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(locator.route),
        kind: 'library.membersPreparation.step',
        accounts: [locator.ownerAccountId],
        workClient,
        clock,
      },
      (tx) => store().admitStep(tx, locator),
    );
  }
  async function rows(owner: Persona) {
    return (
      await db.admin.query(
        `SELECT * FROM library.members_preparation
      WHERE route=$1 AND owner_account_id=$2 ORDER BY episode_id`,
        [routeOf(owner.accountId), owner.accountId],
      )
    ).rows;
  }
  async function workflow(id: string) {
    const status = await workClient.retrieveWorkflow(id).getStatus();
    const inputs = await db.admin.query<{ inputs: string }>(
      'SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1',
      [id],
    );
    expect(inputs.rows).toHaveLength(1);
    const encoded = JSON.parse(inputs.rows[0]!.inputs);
    return { status, input: (Array.isArray(encoded) ? encoded : encoded.json)[0] };
  }
  async function domain() {
    return (
      await db.admin.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY partition_no) FROM core.partition p) AS partitions,
      (SELECT count(*) FROM core.receipt) AS receipts,
      (SELECT count(*) FROM core.outbox) AS outbox,
      (SELECT count(*) FROM editorial.write_basis) AS basis,
      (SELECT count(*) FROM library.collection) AS headers,
      (SELECT count(*) FROM access.resource_grant) AS grants`)
    ).rows;
  }
  async function deletePersona(owner: Persona) {
    const key = crypto.randomUUID();
    const operation = { kind: 'delete' as const, accountId: owner.accountId, authorization: 'request' };
    // The actual Auth API is deleteAccount; fresh native sign-in and approval precede T.
    const signed = await auth.request('/signin', {
      account_id: owner.accountId,
      password,
      client_id: clientId,
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const token = await auth.request('/token', {}, cookies(signed));
    expect(token.status).toBe(200);
    const bearer = ((await token.json()) as { access_token: string }).access_token;
    const approval = await auth
      .approval()
      .approve(bearer, { operationKey: key, operation }, { pool: db.pool, deadline: Date.now() + 10000 });
    return auth.host.workflows.deleteAccount({ key, accountId: owner.accountId, authorization: approval.reference });
  }
  return {
    db,
    auth,
    kernel,
    workClient,
    personas,
    actor,
    store,
    send,
    person,
    fixture,
    step,
    rows,
    workflow,
    domain,
    deletePersona,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    locator(owner: Persona, collectionId: string): PreparationLocator {
      const route = routeOf(owner.accountId)!;
      return { route, ownerAccountId: owner.accountId, collectionId, episodeId: newId(route) };
    },
    async close() {
      try {
        await auth.close();
      } finally {
        await workClient.close();
        await db.close();
      }
    },
  };
}

/** Uses actual released type declarations and the shared expansion/admission, without query execution. */
export function definition(ordinal = 0): PreparationDefinition {
  const types = Object.keys(bundledRelease.types).sort();
  if (types.length < 6) throw new Error('Native reservation fixture requires six actual released types');
  const selected = types.slice(0, 6).filter((_, bit) => ((ordinal + 1) & (1 << bit)) !== 0);
  return {
    filter: admitFilter(parseFilter({ type: { in: selected } }), bundledRelease),
    sort: 'id',
    release: { digest: bundledDigest, value: bundledRelease },
  };
}

/** Observation barrier on real clients, before the indexed owner lock; it never supplies a query result. */
export function uniquenessRace(pools: readonly Pool[]) {
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  const listeners = pools.map((pool) => {
    const observe = (client: import('pg').PoolClient) => {
      const query = client.query.bind(client);
      client.query = (async (...args: unknown[]) => {
        if (
          typeof args[0] === 'string' &&
          /FROM library\.members_preparation_owner[\s\S]*FOR UPDATE/i.test(args[0]) &&
          arrivals < 2
        ) {
          if (++arrivals === 2) ready.resolve();
          await ready.promise;
        }
        return Reflect.apply(query, client, args);
      }) as typeof client.query;
    };
    pool.on('connect', observe);
    // Existing idle clients need the same observation; acquire/release before starting the race.
    return { pool, observe };
  });
  return {
    arrivals: () => arrivals,
    async arm() {
      for (const { pool, observe } of listeners) {
        pool.off('connect', observe);
        const client = await pool.connect();
        observe(client);
        client.release();
        pool.on('connect', observe);
      }
    },
  };
}
