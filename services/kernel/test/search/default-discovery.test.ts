import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readConfig, startServer } from '../../src/server.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { startOutcomeWorkerProcess } from './support/outcome-rpc.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { allocateDiscovery, discoveryConsumer, discoveryGenerations } from '../../src/search/generations.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { readFreshness } from '../../src/search/freshness.ts';
import type { DiscoveryHit, DiscoveryPage } from '../../src/search/discovery.ts';

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('Default discovery did not complete native preparation');
    await Bun.sleep(100);
  }
}

test('ordinary configured server returns current mixed discovery through its default owner producers and retained continuation', async () => {
  const endpoint = process.env.OPENSEARCH_URL;
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the check node');
  // The fixture establishes actual owner resources only. Every search below goes to startServer.
  const driver = await createSemanticDriver(undefined, { isolatedAuth: true });
  const { pool, runtime } = driver.fixtures;
  const prefix = `default-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  const marker = `mixed${randomUUID().replaceAll('-', '')}`;
  const search = createOpenSearch(endpoint);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let worker: ReturnType<typeof startOutcomeWorkerProcess> | undefined;
  try {
    await driver.fixtures.openFeatures(['search', 'search_advanced']);
    const account = await driver.fixtures.person('discoverable');
    const identity = await driver.fixtures.send(null, 'GET', `/v1/accounts?ids=${account.accountId}`);
    expect(identity.status).toBe(200);
    const profile = (identity.body.accounts as { id: string; handle: string; displayName: string | null }[])[0]!;
    expect(profile.id).toBe(account.accountId);
    expect(typeof profile.handle).toBe('string');
    const subjects: string[] = [];
    for (let n = 0; n < 2; n++) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Person',
          labels: { en: `${marker} English ${n}`, fr: `${marker} Français ${n}` },
        },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      subjects.push((created.body.subject as { id: string }).id);
    }
    const env = workerTestEnv({
      DATABASE_URL: runtime.databaseUrl,
      KERNEL_ROUTE_KEY: runtime.routeKey,
      KERNEL_SESSION_KEYS: runtime.sessionKeys,
      AUTH_ISSUER: runtime.authIssuer,
      AUTH_AUDIENCE: runtime.authAudience,
      AUTH_JWKS_URL: runtime.authJwksUrl,
      OPENSEARCH_URL: endpoint,
      KERNEL_SEARCH_PREFIX: prefix,
      KERNEL_PORT: '0',
    });
    worker = startOutcomeWorkerProcess(env);
    await worker.ready; // Ordinary default module registration includes native Source work.
    server = await startServer(readConfig(env));
    const origin = server.url;
    const request = {
      representation: 'discovery-v1',
      text: `${marker} | ${profile.handle}`,
      filter: { kind: { in: ['schema:Person', 'account'] } },
      languages: ['fr', 'en'],
      sort: 'id',
      limit: 1,
    };
    async function send(body: Record<string, unknown>) {
      const response = await fetch(new URL('/v1/subjects:search', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { response, body: await response.json() };
    }
    async function page(body: Record<string, unknown>): Promise<DiscoveryPage> {
      return eventually(async () => {
        const result = await send(body);
        if (result.response.status === 200) return result.body as DiscoveryPage;
        expect(result.response.status, JSON.stringify(result.body)).toBe(503);
        expect(result.body.code).toBe('index_not_ready');
        expect(result.response.headers.get('retry-after')).toBeTruthy();
        return undefined; // Readiness is a prerequisite, never a passing alternative.
      });
    }
    const expected = [...subjects, account.accountId].sort();
    await eventually(async () => {
      const current = await page({ ...request, limit: 100 });
      return JSON.stringify(current.hits.map(({ key }) => key.id)) === JSON.stringify(expected) ? true : undefined;
    });
    const active = (await discoveryGenerations(pool, prefix)).find(({ state }) => state === 'active')!;
    const before = await readFreshness(pool, discoveryConsumer(prefix, active.generation));
    const first = await page(request);
    const after = await readFreshness(pool, discoveryConsumer(prefix, active.generation));
    expect(Date.parse(first.as_of)).toBeGreaterThanOrEqual(before.asOf.getTime());
    expect(Date.parse(first.as_of)).toBeLessThanOrEqual(after.asOf.getTime());
    expect(first.hits).toHaveLength(1);
    expect(typeof first.next).toBe('string');
    const all: DiscoveryHit[] = [...first.hits];
    let next = first.next;
    for (let n = 0; next !== null && n < 3; n++) {
      const continued = await page({ ...request, cursor: next });
      all.push(...continued.hits);
      next = continued.next;
    }
    expect(next).toBeNull();
    expect(all.map(({ key }) => key.id)).toEqual(expected);
    expect(new Set(all.map(({ key }) => `${key.owner}:${key.kind}:${key.id}`)).size).toBe(3);
    for (const hit of all) {
      expect(hit.summary.value.id).toBe(hit.key.id);
      if (hit.summary.kind === 'subject') {
        expect(hit.key.owner).toBe('semantic');
        expect(hit.key.kind).toBe('schema:Person');
        expect(hit.summary.value.label?.language).toBe('fr');
      } else {
        expect(hit.key.owner).toBe('accounts');
        expect(hit.key.kind).toBe('account');
        expect(hit.summary.value.handle).toBe(profile.handle);
        expect(hit.summary.value.displayName).toBe(profile.displayName);
      }
    }
    for (const [n, action] of ['hide', 'takedown'].entries()) {
      await driver.grant('editor', [`moderation:${action}`], subjects[n]!);
      const changed = await driver.request(
        'editor',
        'POST',
        `/v1/subjects/${subjects[n]}:${action}`,
        action === 'hide'
          ? { reason: 'Default discovery current disclosure' }
          : {
              notice: { complaint: 'Default discovery current disclosure', received_at: new Date().toISOString() },
            },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    }
    const current = await page({ ...request, limit: 100 });
    expect(current.hits.map(({ key }) => key.id)).toEqual([account.accountId]);
    expect(current.next).toBeNull();
    const routeKey = new Uint8Array(Buffer.from(runtime.routeKey, 'base64url'));
    const registry = await nativeDiscoveryRegistry(pool, routeKey, createRatedSubjectSource(pool, routeKey).source);
    await allocateDiscovery(pool, prefix, registry);
    await eventually(async () =>
      (await discoveryGenerations(pool, prefix)).some(
        ({ generation, state }) => generation > active.generation && state === 'active',
      )
        ? true
        : undefined,
    );
    const switched = await send({ ...request, cursor: first.next });
    expect(switched.response.status, JSON.stringify(switched.body)).toBe(409);
    expect(switched.body.code).toBe('search_restart_required');
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await worker?.close();
      } finally {
        try {
          const owned = await search.request<{ indices: { name: string }[] }>(
            'GET',
            `/_resolve/index/${prefix}*`,
            undefined,
            { query: { expand_wildcards: 'all' } },
          );
          for (const { name } of owned.body.indices) {
            if (!name.startsWith(prefix)) throw new Error('Discovery cleanup escaped its owned prefix');
            await search.request('DELETE', `/${name}`);
          }
        } finally {
          await driver.close();
        }
      }
    }
  }
}, 240_000);

test('default mixed discovery uses commit-visible Subject Account and claim writer maintenance with complete native baseline enrollment and one bounded page coverage root', async () => {
  const endpoint = process.env.OPENSEARCH_URL;
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the check node');
  // The fixture establishes actual owner resources only. Every search below goes to startServer.
  const driver = await createSemanticDriver(undefined, { isolatedAuth: true });
  const { pool, runtime } = driver.fixtures;
  const prefix = `default-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  const marker = `mixed${randomUUID().replaceAll('-', '')}`;
  const search = createOpenSearch(endpoint);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let worker: ReturnType<typeof startOutcomeWorkerProcess> | undefined;
  try {
    await driver.fixtures.openFeatures(['search', 'search_advanced']);
    const account = await driver.fixtures.person('discoverable');
    const identity = await driver.fixtures.send(null, 'GET', `/v1/accounts?ids=${account.accountId}`);
    expect(identity.status).toBe(200);
    const profile = (identity.body.accounts as { id: string; handle: string; displayName: string | null }[])[0]!;
    expect(profile.id).toBe(account.accountId);
    expect(typeof profile.handle).toBe('string');
    const subjects: string[] = [];
    for (let n = 0; n < 2; n++) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Person',
          labels: { en: `${marker} English ${n}`, fr: `${marker} Français ${n}` },
        },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      subjects.push((created.body.subject as { id: string }).id);
    }
    const env = workerTestEnv({
      DATABASE_URL: runtime.databaseUrl,
      KERNEL_ROUTE_KEY: runtime.routeKey,
      KERNEL_SESSION_KEYS: runtime.sessionKeys,
      AUTH_ISSUER: runtime.authIssuer,
      AUTH_AUDIENCE: runtime.authAudience,
      AUTH_JWKS_URL: runtime.authJwksUrl,
      OPENSEARCH_URL: endpoint,
      KERNEL_SEARCH_PREFIX: prefix,
      KERNEL_PORT: '0',
    });
    worker = startOutcomeWorkerProcess(env);
    await worker.ready; // Ordinary default module registration includes native Source work.
    server = await startServer(readConfig(env));
    const origin = server.url;

    type Trace = { events: string[]; afterStart?: () => Promise<void>; afterProjection?: () => Promise<void> };
    let trace: Trace | undefined;
    const originalQuery = pg.Client.prototype.query;
    const observe = async (text: string, current: Trace | undefined) => {
      if (!current) return;
      if (/\/\*\s*semantic\.privacy-start\s*\*\//.test(text) && current.afterStart) {
        const change = current.afterStart;
        current.afterStart = undefined;
        await change();
      }
      if (/statement_timestamp\(\)/.test(text) && /core\.consumer_checkpoint/.test(text) && current.afterProjection) {
        const change = current.afterProjection;
        current.afterProjection = undefined;
        await change();
      }
    };
    pg.Client.prototype.query = new Proxy(originalQuery, {
      apply(target, receiver, argumentsList) {
        const args = [...argumentsList];
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
        const current = trace;
        if (current) {
          const role = /\/\*\s*semantic\.(privacy-start|privacy-final)\s*\*\//.exec(text)?.[1];
          if (role) current.events.push(role);
          if (/statement_timestamp\(\)/.test(text) && /core\.consumer_checkpoint/.test(text))
            current.events.push('as_of');
        }
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          args[args.length - 1] = function (this: unknown, error: unknown, result: unknown) {
            if (error) return Reflect.apply(callback, this, [error, result]);
            void observe(text, current).then(
              () => Reflect.apply(callback, this, [error, result]),
              (failure) => Reflect.apply(callback, this, [failure]),
            );
          };
          return Reflect.apply(target, receiver, args);
        }
        const result = Reflect.apply(target, receiver, args);
        if (!result || typeof result.then !== 'function') return result;
        return result.then(async (value: unknown) => {
          await observe(text, current);
          return value;
        });
      },
    });
    try {
      const request = {
        representation: 'discovery-v1',
        text: `${marker} | ${profile.handle}`,
        filter: { kind: { in: ['schema:Person', 'account'] } },
        languages: ['fr', 'en'],
        sort: 'id',
        limit: 1,
      };
      async function send(body: Record<string, unknown>, control?: Omit<Trace, 'events'>) {
        const current: Trace = { events: [], ...control };
        trace = current;
        try {
          const response = await fetch(new URL('/v1/subjects:search', origin), {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          return { response, body: await response.json(), trace: current };
        } finally { trace = undefined; }
      }
      const assertEnvelope = (current: Trace) => {
        expect(current.events.filter((event) => event === 'privacy-start')).toHaveLength(1);
        expect(current.events.filter((event) => event === 'privacy-final')).toHaveLength(1);
        expect(current.events.indexOf('as_of')).toBeGreaterThan(current.events.indexOf('privacy-start'));
        expect(current.events.lastIndexOf('as_of')).toBeLessThan(current.events.indexOf('privacy-final'));
      };
      const page = (body: Record<string, unknown>) => eventually(async () => {
        const result = await send(body);
        if (result.response.status === 200) {
          assertEnvelope(result.trace);
          return result.body as DiscoveryPage;
        }
        expect(result.response.status, JSON.stringify(result.body)).toBe(503);
        expect(result.body.code).toBe('index_not_ready');
        expect(result.response.headers.get('retry-after')).toBeTruthy();
        return undefined;
      });
      const first = await page(request);
      expect(first.hits).toHaveLength(1);
      expect(typeof first.next).toBe('string');
      // Inspect native enrollment independently; the response must already have passed
      // its actual producer. These counts are assertions, never production coverage truth.
      const enrolled = await pool.query<{ homes: number; complete: boolean }>(
        `SELECT count(*)::integer AS homes,bool_and(h.complete) AS complete
         FROM semantic.public_filter_home_enrollment h
         JOIN semantic.public_filter_bootstrap b ON b.partition_no=0 AND b.bootstrap=h.bootstrap
         WHERE b.state='adopted' AND b.consumer LIKE $1 GROUP BY h.bootstrap`, [`%${prefix}%`],
      );
      expect(enrolled.rows.length).toBeGreaterThan(0);
      for (const row of enrolled.rows) {
        expect(row.homes).toBe(4096);
        expect(row.complete).toBe(true);
      }
      const route = routeOf(account.accountId)!;
      const accountHome = partitionOf(route);
      const head = async () => (await pool.query<{ revision: string; claim: string }>(
        `SELECT revision::text,claim_revision::text AS claim
         FROM access.account_discovery_population WHERE partition_no=$1`, [accountHome],
      )).rows[0]!;
      const before = await head();
      const rolledBack = await pool.connect();
      try {
        await rolledBack.query('BEGIN');
        await rolledBack.query('UPDATE access.account SET display_name=$3 WHERE (route,account_id)=($1,$2)',
          [route,account.accountId,`${marker} rolled back`]);
        await rolledBack.query('ROLLBACK');
      } finally { rolledBack.release(); }
      expect(await head()).toEqual(before);
      // Allocate the writer's XID before the page. Its native Account change remains
      // invisible at start and commits only after the real start-role statement returns.
      const lower = await pool.connect();
      let committed = false;
      try {
        await lower.query('BEGIN');
        await lower.query('SELECT pg_current_xact_id()');
        await lower.query('UPDATE access.account SET display_name=$3 WHERE (route,account_id)=($1,$2)',
          [route,account.accountId,`${marker} committed`]);
        const changed = await send({ ...request, cursor: first.next }, {
          afterStart: async () => { await lower.query('COMMIT'); committed = true; },
        });
        expect(committed).toBe(true);
        expect(changed.response.status, JSON.stringify(changed.body)).toBe(503);
        expect(changed.body.code).toBe('index_not_ready');
      } finally {
        if (!committed) await lower.query('ROLLBACK');
        lower.release();
      }
      expect(BigInt((await head()).revision)).toBeGreaterThan(BigInt(before.revision));
      // A repaired/acknowledged later state cannot restamp the retained old PIT.
      const fresh = await page(request);
      expect(fresh.hits).toHaveLength(1);
      const old = await send({ ...request, cursor: first.next });
      expect(old.response.status, JSON.stringify(old.body)).toBe(503);
      expect(old.body.code).toBe('index_not_ready');
      // Commit a genuine Subject reduction after the response's as_of query. Final
      // must encompass summaries, native count witnesses and cursor projection.
      await driver.grant('editor', ['moderation:hide'], subjects[0]!);
      let projectedReduction = false;
      const reduced = await send({ ...request, cursor: fresh.next }, {
        afterProjection: async () => {
          const hidden = await driver.request('editor','POST',`/v1/subjects/${subjects[0]}:hide`,
            { reason: 'Default mixed Source final closure' }, { 'Idempotency-Key': `"${randomUUID()}"` });
          expect(hidden.status,JSON.stringify(hidden.body)).toBe(200);
          projectedReduction = true;
        },
      });
      expect(projectedReduction).toBe(true);
      expect(reduced.response.status,JSON.stringify(reduced.body)).toBe(503);
      expect(reduced.body.code).toBe('index_not_ready');
      assertEnvelope(reduced.trace);
      // The native claim tuple is independent of the Account revision and Source
      // privacy position. A real claim writer changes current handle disclosure.
      const claimed = await pool.query<{ route: number; revision: string }>(
        `UPDATE access.handle_claim SET state='reserved',reserved_until=clock_timestamp()+interval '1 day'
         WHERE normalized_handle=$1 AND account_id=$2 AND state='active'
         RETURNING route,discovery_revision::text AS revision`, [profile.handle,account.accountId],
      );
      expect(claimed.rows).toHaveLength(1);
      const claimHome = partitionOf(claimed.rows[0]!.route);
      const pending = await pool.query<{ native_revision: string; native_claim_revision: string }>(
        `SELECT native_revision::text,native_claim_revision::text
         FROM semantic.public_filter_privacy_pending
         WHERE partition_no=$1 AND input_key='["domain","accounts"]'`, [claimHome],
      );
      expect(pending.rows).toHaveLength(1);
      expect(BigInt(pending.rows[0]!.native_claim_revision)).toBeGreaterThanOrEqual(BigInt(claimed.rows[0]!.revision));
      const current = await page({ ...request, limit: 100 });
      expect(current.hits.map(({ key }) => key.id).sort()).toEqual([subjects[1]!,account.accountId].sort());
      const accountHit = current.hits.find(({ key }) => key.id === account.accountId)!;
      expect(accountHit.summary.kind).toBe('account');
      if (accountHit.summary.kind === 'account') {
        expect(accountHit.summary.value.displayName).toBe(`${marker} committed`);
        expect(accountHit.summary.value.handle).toBeNull();
      }
    } finally {
      trace = undefined;
      pg.Client.prototype.query = originalQuery;
    }
  } finally {
    try {
      await server?.stop();
    } finally {
      try {
        await worker?.close();
      } finally {
        try {
          const owned = await search.request<{ indices: { name: string }[] }>(
            'GET',
            `/_resolve/index/${prefix}*`,
            undefined,
            { query: { expand_wildcards: 'all' } },
          );
          for (const { name } of owned.body.indices) {
            if (!name.startsWith(prefix)) throw new Error('Discovery cleanup escaped its owned prefix');
            await search.request('DELETE', `/${name}`);
          }
        } finally {
          await driver.close();
        }
      }
    }
  }

}, 240_000);
