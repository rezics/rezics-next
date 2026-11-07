import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import pg from 'pg';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { publicFilterCoverageKey } from '../../src/semantic/public-filter-coverage-pending.ts';
import { readConfig, startServer } from '../../src/server.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { startOutcomeWorkerProcess } from './support/outcome-rpc.ts';
import { createOpenSearch, type OpenSearch, type SearchRequestOptions } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import type { SubjectSource } from '../../src/search/source.ts';
import { allocateDiscovery, discoveryConsumer, discoveryGenerations } from '../../src/search/generations.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { readFreshness } from '../../src/search/freshness.ts';
import type { DiscoveryPage, DiscoveryUnionHit } from '../../src/search/discovery.ts';

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('Default discovery did not complete native preparation');
    await Bun.sleep(100);
  }
}

test('default Search returns its owner before initial inventory settles and cancels that request on stop', async () => {
  let reached!: (signal: AbortSignal) => void;
  const requestStarted = new Promise<AbortSignal>((resolve) => (reached = resolve));
  let aborted = false;
  const search: OpenSearch = {
    request<_T>(
      _method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
      _path: string,
      _body?: unknown,
      options?: SearchRequestOptions,
    ): Promise<{ status: number; body: _T }> {
      const signal = options?.signal;
      if (!signal) return Promise.reject(new Error('Startup inventory has no runner lifetime'));
      reached(signal);
      return new Promise<{ status: number; body: _T }>((_resolve, reject) => {
        const cancel = () => {
          aborted = true;
          reject(new Error('Startup inventory was cancelled'));
        };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    },
    bulk<_T>(): Promise<_T> {
      throw new Error('Startup inventory must not bulk');
    },
  };
  const runner = await startSearchIndexing({
    pool: {} as unknown as Pool,
    search,
    source: {} as unknown as SubjectSource,
    listing: {
      async read() {
        return new Map();
      },
    },
    prefix: 'startup-',
  });
  const signal = await requestStarted;
  expect(signal.aborted).toBe(false);
  await runner.stop();
  expect(signal.aborted).toBe(true);
  expect(aborted).toBe(true);
}, 10_000);

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
    const all: DiscoveryUnionHit[] = [...first.hits];
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
      } else if (hit.summary.kind === 'account') {
        const account = hit as Extract<DiscoveryUnionHit, { summary: { kind: 'account' } }>;
        expect(hit.key.owner).toBe('accounts');
        expect(hit.key.kind).toBe('account');
        expect(account.summary.value.handle).toBe(profile.handle);
        expect(account.summary.value.displayName).toBe(profile.displayName);
      } else {
        throw new Error('Unexpected owner in the Account and Subject fixture');
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
  // The shared Realm input names its native authority even when no Subject or
  // positive support exists. Delimiters and non-native identities cannot alias it.
  const realmIdentity = newId(31000);
  expect(publicFilterCoverageKey({ kind: 'realm', realm: realmIdentity })).toBe(
    JSON.stringify(['authority', 'realm', 31000, realmIdentity]),
  );
  expect(() => publicFilterCoverageKey({ kind: 'realm', realm: `realm:${realmIdentity}` })).toThrow();
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
        delete current.afterStart;
        await change();
      }
      if (/statement_timestamp\(\)/.test(text) && /core\.consumer_checkpoint/.test(text) && current.afterProjection) {
        const change = current.afterProjection;
        delete current.afterProjection;
        await change();
      }
    };
    pg.Client.prototype.query = new Proxy(originalQuery, {
      apply(target, receiver, argumentsList) {
        const args = [...argumentsList];
        const text = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
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
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { response, body: await response.json(), trace: current };
        } finally {
          trace = undefined;
        }
      }
      const assertEnvelope = (current: Trace) => {
        expect(current.events.filter((event) => event === 'privacy-start')).toHaveLength(1);
        expect(current.events.filter((event) => event === 'privacy-final')).toHaveLength(1);
        expect(current.events.indexOf('as_of')).toBeGreaterThan(current.events.indexOf('privacy-start'));
        expect(current.events.lastIndexOf('as_of')).toBeLessThan(current.events.indexOf('privacy-final'));
      };
      let rejectedAckGap = false;
      const rejectAckGap = async () => {
        if (rejectedAckGap) return;
        const native = await pool.connect();
        try {
          await native.query('BEGIN');
          // Lock the actual independently verified terminal while its funded
          // settlement frontier is still partial. The attempted jump remains
          // inside 0..4096, so only the contiguous-prefix guard can reject it.
          const pending = await native.query<{ bootstrap: string; execution: string }>(
            `SELECT t.bootstrap::text,t.execution
             FROM semantic.public_filter_repair_step t
             JOIN semantic.public_filter_bootstrap b USING(partition_no,bootstrap)
             WHERE b.state='adopted' AND b.consumer LIKE $1
               AND t.complete AND t.verified_root IS NOT NULL AND t.ack_after BETWEEN 0 AND 4093
             LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
            [`%${prefix}%`],
          );
          const terminal = pending.rows[0];
          if (terminal) {
            await expect(
              native.query(
                `UPDATE semantic.public_filter_repair_step SET ack_after=ack_after+2
               WHERE (partition_no,bootstrap,execution)=(0,$1,$2) AND complete`,
                [terminal.bootstrap, terminal.execution],
              ),
            ).rejects.toMatchObject({ code: '23514' });
            rejectedAckGap = true;
          }
        } finally {
          try {
            await native.query('ROLLBACK');
          } finally {
            native.release();
          }
        }
      };
      const page = (body: Record<string, unknown>) =>
        eventually(async () => {
          await rejectAckGap();
          const result = await send(body);
          await rejectAckGap();
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
      expect(rejectedAckGap).toBe(true);
      expect(first.hits).toHaveLength(1);
      expect(typeof first.next).toBe('string');
      // Inspect native enrollment independently; the response must already have passed
      // its actual producer. These counts are assertions, never production coverage truth.
      const enrolled = await pool.query<{ homes: number; complete: boolean }>(
        `SELECT count(*)::integer AS homes,bool_and(h.complete) AS complete
         FROM semantic.public_filter_home_enrollment h
         JOIN semantic.public_filter_bootstrap b ON b.partition_no=0 AND b.bootstrap=h.bootstrap
         WHERE b.state='adopted' AND b.consumer LIKE $1 GROUP BY h.bootstrap`,
        [`%${prefix}%`],
      );
      expect(enrolled.rows.length).toBeGreaterThan(0);
      for (const row of enrolled.rows) {
        expect(row.homes).toBe(4096);
        expect(row.complete).toBe(true);
      }
      const baselines = await pool.query<{
        homes: number;
        sealed: boolean;
        original: boolean;
        summaries: number;
        pinned: boolean;
      }>(
        `SELECT count(*)::integer AS homes,
           bool_and(b.coverage_sealed AND b.coverage_after=4096 AND c.after_home=4096
             AND b.coverage_generation=c.generation AND b.coverage_root=c.root) AS sealed,
           bool_and(h.receipt IS NOT NULL AND h.receipt=n.receipt AND h.owner_epoch=n.source_epoch
             AND h.source_position=n.source_position AND h.creation_position=n.creation_position
             AND h.native_enqueue_revision=n.native_enqueue_revision
             AND h.native_revision IS NOT DISTINCT FROM n.native_revision
             AND h.native_claim_revision IS NOT DISTINCT FROM n.native_claim_revision) AS original,
           count(s.source_home)::integer AS summaries,
           bool_and(p.consumer IS NOT NULL AND h.creation_consumer IS NOT NULL
             AND h.creation_consumer='public_filter_' || replace(h.bootstrap::text,'-','')
             AND p.consumer=h.creation_consumer AND p.position<=h.creation_position
             AND (p.epoch IS NULL OR p.epoch=h.owner_epoch)) AS pinned
         FROM semantic.public_filter_home_enrollment h
         JOIN semantic.public_filter_bootstrap b ON b.partition_no=0 AND b.bootstrap=h.bootstrap
         JOIN search.public_filter_coverage_preparation c
           ON (c.partition_no,c.registration,c.bootstrap)=(0,h.registration,h.bootstrap)
         JOIN search.public_filter_coverage_baseline n
           ON (n.partition_no,n.registration,n.bootstrap,n.source_home)=(0,h.registration,h.bootstrap,h.partition_no)
         LEFT JOIN search.public_filter_coverage_home s
           ON (s.partition_no,s.registration,s.source_home)=(0,h.registration,h.partition_no)
         LEFT JOIN core.consumer_checkpoint p
           ON (p.partition_no,p.consumer)=(h.partition_no,h.creation_consumer)
         WHERE b.state='adopted' AND b.consumer LIKE $1 GROUP BY h.bootstrap`,
        [`%${prefix}%`],
      );
      expect(baselines.rows).toHaveLength(enrolled.rows.length);
      for (const row of baselines.rows) {
        expect(row.homes).toBe(4096);
        expect(row.summaries).toBe(4096);
        expect(row.sealed).toBe(true);
        expect(row.original).toBe(true);
        expect(row.pinned).toBe(true);
      }
      // Completion must resolve the original independently verified prefix. A
      // terminal boolean, a home count or a new equivalent page cannot supply it.
      const chains = await pool.query<{
        bootstrap: string;
        execution: string;
        pages: number;
        complete: number;
        tips: number;
        bound: boolean;
        contiguous: boolean;
        claimInputs: boolean;
        windows: number;
        acknowledged: number;
      }>(
        `WITH originals AS (
           SELECT s.*,lead(step) OVER w AS successor,
             row_number() OVER w AS ordinal
           FROM semantic.public_filter_repair_step s
           JOIN semantic.public_filter_bootstrap b USING(partition_no,bootstrap)
           WHERE b.state='adopted' AND b.consumer LIKE $1
             AND EXISTS (SELECT 1 FROM semantic.public_filter_repair_step terminal
               WHERE (terminal.partition_no,terminal.bootstrap,terminal.execution)=
                 (s.partition_no,s.bootstrap,s.execution) AND terminal.complete)
           WINDOW w AS (PARTITION BY s.bootstrap,s.execution ORDER BY s.verified_ordinal)
         ) SELECT bootstrap::text,execution,count(*)::integer AS pages,
           count(*) FILTER (WHERE complete)::integer AS complete,
           count(*) FILTER (WHERE verified_next IS NULL)::integer AS tips,
           count(*) FILTER (WHERE verified_home IS NOT NULL)::integer AS windows,
           max(ack_after)::integer AS acknowledged,
           bool_and(verified_root IS NOT NULL AND verified_binding IS NOT NULL) AS bound,
           bool_and(position('["claimInputs",["value",true]]' IN state)>0) AS "claimInputs",
           bool_and(verified_ordinal=ordinal AND verified_next IS NOT DISTINCT FROM successor
             AND (NOT complete OR successor IS NULL)) AS contiguous
         FROM originals GROUP BY bootstrap,execution`,
        [`%${prefix}%`],
      );
      expect(chains.rows.length).toBeGreaterThan(0);
      for (const chain of chains.rows) {
        expect(chain.pages).toBeGreaterThan(4096);
        expect(chain.complete).toBe(1);
        expect(chain.tips).toBe(1);
        expect(chain.bound).toBe(true);
        expect(chain.contiguous).toBe(true);
        expect(chain.claimInputs).toBe(true);
        expect(chain.windows).toBe(4096);
        expect(chain.acknowledged).toBe(4096);
      }
      const originalChain = chains.rows[0]!;
      const ackReceipts = await pool.query<{ homes: number; original: boolean; physical: boolean }>(
        `SELECT count(*)::integer AS homes,
           bool_and(h.acknowledged_baseline=b.bootstrap AND h.source_epoch=b.source_epoch
             AND h.acknowledged_position=b.source_position
             AND h.acknowledged_native_enqueue=b.native_enqueue_revision
             AND h.acknowledged_native_revision IS NOT DISTINCT FROM b.native_revision
             AND h.acknowledged_native_claim_revision IS NOT DISTINCT FROM b.native_claim_revision) AS original,
           bool_and(h.acknowledged_observation IS NOT NULL AND h.acknowledged_settlement IS NOT NULL
             AND e.repair_settlement IS NOT NULL AND t.ack_after=4096) AS physical
         FROM search.public_filter_coverage_baseline b
         JOIN search.public_filter_coverage_home h USING(partition_no,registration,source_home)
         LEFT JOIN search.public_filter_execution e ON
           (e.partition_no,e.observation,e.id)=(h.partition_no,h.acknowledged_observation,h.acknowledged_execution)
         LEFT JOIN semantic.public_filter_repair_step t ON
           (t.partition_no,t.bootstrap,t.execution,t.complete)=(0,b.bootstrap,h.acknowledged_execution,true)
         WHERE b.bootstrap=$1`,
        [originalChain.bootstrap],
      );
      expect(ackReceipts.rows).toEqual([{ homes: 4096, original: true, physical: true }]);
      const immutable = await pool.connect();
      try {
        await immutable.query('BEGIN');
        await expect(
          immutable.query(
            `UPDATE semantic.public_filter_repair_step SET state=state || ' '
           WHERE (partition_no,bootstrap,execution)=(0,$1,$2) AND complete`,
            [originalChain.bootstrap, originalChain.execution],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await immutable.query('ROLLBACK');
        // Missing original window evidence and a regressed native ACK
        // frontier cannot be supplied by a complete bit or a caller's counter.
        await immutable.query('BEGIN');
        await expect(
          immutable.query(
            `UPDATE semantic.public_filter_repair_step SET verified_home=NULL
           WHERE (partition_no,bootstrap,execution,verified_home)=(0,$1,$2,0)`,
            [originalChain.bootstrap, originalChain.execution],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await immutable.query('ROLLBACK');
        for (const delta of [-1]) {
          await immutable.query('BEGIN');
          await expect(
            immutable.query(
              `UPDATE semantic.public_filter_repair_step SET ack_after=ack_after+$3
             WHERE (partition_no,bootstrap,execution)=(0,$1,$2) AND complete`,
              [originalChain.bootstrap, originalChain.execution, delta],
            ),
          ).rejects.toMatchObject({ code: '23514' });
          await immutable.query('ROLLBACK');
        }
        await immutable.query('BEGIN');
        await expect(
          immutable.query(
            `UPDATE semantic.public_filter_repair_step SET verified_root=repeat('0',64)
           WHERE (partition_no,bootstrap,execution)=(0,$1,$2) AND complete`,
            [originalChain.bootstrap, originalChain.execution],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await immutable.query('ROLLBACK');
        // Native delivery cannot advance or remove the original pin after the
        // Source verifier has adopted its window. Failed writes remain rolled back.
        await immutable.query('BEGIN');
        await expect(
          immutable.query(
            `DELETE FROM core.consumer_checkpoint
           WHERE (partition_no,consumer)=(0,'public_filter_' || replace($1::text,'-',''))`,
            [originalChain.bootstrap],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await immutable.query('ROLLBACK');
        await immutable.query('BEGIN');
        await expect(
          immutable.query(
            `UPDATE core.consumer_checkpoint SET position=position+1,
             epoch=(SELECT epoch FROM core.partition WHERE partition_no=0)
           WHERE (partition_no,consumer)=(0,'public_filter_' || replace($1::text,'-',''))`,
            [originalChain.bootstrap],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await immutable.query('ROLLBACK');
      } finally {
        immutable.release();
      }
      // The default repair job must retain the native Account input alongside
      // actual writer effects. Neither a Subject projection nor an intent tick
      // can stand in for the independent Account and claim tuple.
      const accountRepairs = await pool.query<{
        id: string;
        owner: string;
        original: boolean;
        settled: boolean;
        revision: string;
        claim: string;
        currentRevision: string;
        currentClaim: string;
        claimEpoch: number;
        currentClaimEpoch: number;
        claimHead: string;
        currentClaimHead: string;
      }>(
        `SELECT w.repair_account::jsonb->>'id' AS id,w.repair_receipt::jsonb->>'owner' AS owner,
           w.repair_receipt::jsonb->'account'=w.repair_account::jsonb AS original,
           (w.dispatch_state='settled' AND w.writer_token IS NULL AND w.closed_job IS NULL
             AND w.visible_position=w.settled_position AND w.visible_transaction_id=w.settled_transaction_id) AS settled,
           w.repair_account::jsonb->'head'->'revision'->>'nativeBigint' AS revision,
           w.repair_account::jsonb->'head'->'claimRevision'->>'nativeBigint' AS claim,
           p.revision::text AS "currentRevision",p.claim_revision::text AS "currentClaim",
           (w.repair_account::jsonb->'claimHead'->>'epoch')::integer AS "claimEpoch",
           cp.epoch AS "currentClaimEpoch",
           w.repair_account::jsonb->'claimHead'->'claimRevision'->>'nativeBigint' AS "claimHead",
           c.claim_revision::text AS "currentClaimHead"
         FROM search.identity_writer w JOIN access.account_discovery_population p USING(partition_no)
         LEFT JOIN access.account_discovery_population c
           ON c.partition_no=(w.repair_account::jsonb->'claimHead'->>'partition')::integer
         LEFT JOIN core.partition cp ON cp.partition_no=c.partition_no
         WHERE w.original_id=$1 AND w.physical_target LIKE $2`,
        [account.accountId, `${prefix}%`],
      );
      expect(accountRepairs.rows.length).toBeGreaterThan(0);
      for (const row of accountRepairs.rows) {
        expect(row.id).toBe(account.accountId);
        expect(row.owner).toBe('accounts');
        expect(row.original).toBe(true);
        expect(row.settled).toBe(true);
        expect(row.revision).toBe(row.currentRevision);
        expect(row.claim).toBe(row.currentClaim);
        expect(row.claimEpoch).toBeGreaterThan(0);
        expect(row.claimEpoch).toBe(row.currentClaimEpoch);
        expect(row.claimHead).toBe(row.currentClaimHead);
      }
      const route = routeOf(account.accountId)!;
      const accountHome = partitionOf(route);
      const head = async () =>
        (
          await pool.query<{ revision: string; claim: string }>(
            `SELECT revision::text,claim_revision::text AS claim
         FROM access.account_discovery_population WHERE partition_no=$1`,
            [accountHome],
          )
        ).rows[0]!;
      const before = await head();
      const rolledBack = await pool.connect();
      try {
        await rolledBack.query('BEGIN');
        await rolledBack.query('UPDATE access.account SET display_name=$3 WHERE (route,account_id)=($1,$2)', [
          route,
          account.accountId,
          `${marker} rolled back`,
        ]);
        await rolledBack.query('ROLLBACK');
      } finally {
        rolledBack.release();
      }
      expect(await head()).toEqual(before);
      // Allocate the writer's XID before the page. Its native Account change remains
      // invisible at start and commits only after the real start-role statement returns.
      const lower = await pool.connect();
      let committed = false;
      try {
        await lower.query('BEGIN');
        await lower.query('SELECT pg_current_xact_id()');
        await lower.query('UPDATE access.account SET display_name=$3 WHERE (route,account_id)=($1,$2)', [
          route,
          account.accountId,
          `${marker} committed`,
        ]);
        const changed = await send(
          { ...request, cursor: first.next },
          {
            afterStart: async () => {
              await lower.query('COMMIT');
              committed = true;
            },
          },
        );
        expect(committed).toBe(true);
        expect(changed.response.status, JSON.stringify(changed.body)).toBe(503);
        expect(changed.body.code).toBe('index_not_ready');
      } finally {
        if (!committed) await lower.query('ROLLBACK');
        lower.release();
      }
      expect(BigInt((await head()).revision)).toBeGreaterThan(BigInt(before.revision));
      const later = await pool.query<{ newer: boolean; prefix: boolean; guarded: boolean }>(
        `SELECT q.enqueue_revision>b.native_enqueue_revision AS newer,
           (h.acknowledged_baseline IS DISTINCT FROM b.bootstrap OR
             h.acknowledged_native_enqueue<=b.native_enqueue_revision) AS prefix,
           (q.live OR h.behind OR h.last_change_generation>s.coverage_generation) AS guarded
         FROM search.public_filter_coverage_baseline b
         JOIN semantic.public_filter_bootstrap s ON (s.partition_no,s.bootstrap)=(0,b.bootstrap)
         JOIN search.public_filter_coverage_home h ON
           (h.partition_no,h.registration,h.source_home)=(b.partition_no,b.registration,b.source_home)
         JOIN semantic.public_filter_privacy_pending q
           ON q.partition_no=b.source_home AND q.input_key='["domain","accounts"]'
         WHERE b.bootstrap=$1 AND b.source_home=$2`,
        [originalChain.bootstrap, accountHome],
      );
      expect(later.rows).toEqual([{ newer: true, prefix: true, guarded: true }]);
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
      const reduced = await send(
        { ...request, cursor: fresh.next },
        {
          afterProjection: async () => {
            const hidden = await driver.request(
              'editor',
              'POST',
              `/v1/subjects/${subjects[0]}:hide`,
              { reason: 'Default mixed Source final closure' },
              { 'Idempotency-Key': `"${randomUUID()}"` },
            );
            expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
            projectedReduction = true;
          },
        },
      );
      expect(projectedReduction).toBe(true);
      expect(reduced.response.status, JSON.stringify(reduced.body)).toBe(503);
      expect(reduced.body.code).toBe('index_not_ready');
      assertEnvelope(reduced.trace);
      // The native claim tuple is independent of the Account revision and Source
      // privacy position. A real claim writer changes current handle disclosure.
      const claimed = await pool.query<{ route: number; revision: string }>(
        `UPDATE access.handle_claim SET state='reserved',reserved_until=clock_timestamp()+interval '1 day'
         WHERE normalized_handle=$1 AND account_id=$2 AND state='active'
         RETURNING route,discovery_revision::text AS revision`,
        [profile.handle, account.accountId],
      );
      expect(claimed.rows).toHaveLength(1);
      const claimHome = partitionOf(claimed.rows[0]!.route);
      const pending = await pool.query<{ native_revision: string; native_claim_revision: string }>(
        `SELECT native_revision::text,native_claim_revision::text
         FROM semantic.public_filter_privacy_pending
         WHERE partition_no=$1 AND input_key='["domain","accounts"]'`,
        [claimHome],
      );
      expect(pending.rows).toHaveLength(1);
      expect(BigInt(pending.rows[0]!.native_claim_revision)).toBeGreaterThanOrEqual(BigInt(claimed.rows[0]!.revision));
      const current = await page({ ...request, limit: 100 });
      expect(current.hits.map(({ key }) => key.id).sort()).toEqual([subjects[1]!, account.accountId].sort());
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
