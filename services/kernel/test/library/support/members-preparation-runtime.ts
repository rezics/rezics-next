import { expect } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import type { Pool } from 'pg';
import { actionCatalogue } from '../../../src/http/request.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { LIFECYCLE_ACTIONS } from '../../../src/access/lifecycle.ts';
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
import { deletePersona as deleteNativePersona } from '../../support/account-deletion.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
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
  const scopes = [...new Set([...actionCatalogue(kernel).keys(), ...LIFECYCLE_ACTIONS.keys()])]
    .filter((scope) => scope !== 'media:complete')
    .sort();
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
  async function withoutScope(persona: Persona, omitted: string): Promise<Persona> {
    if (!scopes.includes(omitted)) throw new Error(`Native test client does not register ${omitted}`);
    const signed = await auth.request('/signin', {
      account_id: persona.accountId,
      password,
      client_id: clientId,
      scope: scopes.filter((scope) => scope !== omitted),
    });
    expect(signed.status).toBe(200);
    const issued = await auth.request('/token', {}, cookies(signed));
    expect(issued.status).toBe(200);
    return {
      accountId: persona.accountId,
      bearer: ((await issued.json()) as { access_token: string }).access_token,
    };
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
    return deleteNativePersona({ version: 1, pool: db.pool, auth }, owner);
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
    withoutScope,
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

/** Observation barrier before the first owner-control access, including concurrent first-row creation. */
export function uniquenessRace(pools: readonly Pool[]) {
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  const originals = new Map<import('pg').PoolClient, import('pg').PoolClient['query']>();
  const listeners = pools.map((pool) => {
    const observe = (client: import('pg').PoolClient) => {
      if (originals.has(client)) return;
      const query = client.query;
      originals.set(client, query);
      client.query = ((...args: unknown[]) => {
        const first = args[0];
        const text =
          typeof first === 'string'
            ? first
            : typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
              ? first.text
              : undefined;
        if (
          text !== undefined &&
          /\b(?:FROM|INTO|UPDATE) library\.members_preparation_owner\b/i.test(text) &&
          arrivals < 2
        ) {
          if (++arrivals === 2) ready.resolve();
          const callback =
            typeof args.at(-1) === 'function'
              ? args.at(-1)
              : typeof first === 'object' && first !== null && 'callback' in first
                ? first.callback
                : undefined;
          const resume = () => Reflect.apply(query, client, args);
          if (typeof callback === 'function') {
            // pg's callback overload returns void. Forward its original arguments/result unchanged.
            void ready.promise.then(resume).catch((error: unknown) => callback(error));
            return;
          }
          return ready.promise.then(resume);
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
    restore() {
      for (const { pool, observe } of listeners) pool.off('connect', observe);
      for (const [client, query] of originals) client.query = query;
      originals.clear();
      ready.resolve();
    },
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

/** Negative native scheduling only, after a real positive episode; never seeds a principal, grant or source. */
export async function retainEpisodes(
  db: GrowthDatabase,
  anchor: PreparationLocator,
  count: number,
  options: { headers: boolean; queued: boolean },
) {
  const ids = Array.from({ length: count }, () => newId(anchor.route));
  const workflowIds = ids.map((id) => `library:members-preparation:${anchor.route}:${anchor.ownerAccountId}:${id}`);
  if (options.headers)
    await db.admin.query(
      `INSERT INTO library.members_preparation(route,owner_account_id,collection_id,episode_id,canonical_basis,basis_digest,state,last_read_at,workflow_id,reserved_incarnation,reserved_generation)
    SELECT h.route,h.owner_account_id,h.collection_id,retained.id,h.canonical_basis,h.basis_digest,'retired',h.last_read_at,retained.workflow,h.reserved_incarnation,h.reserved_generation
    FROM library.members_preparation h CROSS JOIN unnest($4::uuid[],$5::text[]) AS retained(id,workflow)
    WHERE h.route=$1 AND h.owner_account_id=$2 AND h.collection_id=$3 AND h.episode_id=$6`,
      [anchor.route, anchor.ownerAccountId, anchor.collectionId, ids, workflowIds, anchor.episodeId],
    );
  await db.admin.query(
    `INSERT INTO dbos.workflow_status(workflow_uuid,name,status,queue_name,class_name,config_name,completed_at)
    SELECT id,'library.membersPreparation',$2,'workflows',NULL,NULL,$3 FROM unnest($1::text[]) id`,
    [workflowIds, options.queued ? 'ENQUEUED' : 'SUCCESS', options.queued ? null : 1],
  );
  await db.admin.query(
    `INSERT INTO dbos.workflow_input(workflow_uuid,inputs)
    SELECT * FROM unnest($1::text[],$2::text[])`,
    [
      workflowIds,
      ids.map((episodeId) =>
        JSON.stringify({
          json: [
            {
              accounts: [anchor.ownerAccountId],
              route: anchor.route,
              episodes: [{ collectionId: anchor.collectionId, episodeId }],
              cleanup: [],
            },
          ],
        }),
      ),
    ],
  );
}
