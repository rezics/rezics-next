import { workerTestEnv } from '../support/worker-env.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createThread } from '../../src/content/commands.ts';
import { reserveMedia } from '../../src/content/media.ts';
import {
  createContentOperationClient,
  createContentWork,
  CONTENT_COLLECTION_SCHEDULE,
  CONTENT_OPERATION_PROGRESS,
} from '../../src/content/work.ts';
import { contentWorkDependencies, createContentWorkAccess, registerContent } from '../../src/content/register.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { readMembershipRouteKey } from '../../src/access/membership-work-config.ts';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  contentWorkSource,
  contentWorkWorkflowId,
} from '../../src/content/work-contract.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { collectPartition } from '../../src/content/collection-job.ts';
import { eraseStandaloneMedia } from '../../src/content/moderation.ts';
import { decideDownload } from '../../src/content/media.ts';
import { runCommand, type CommandOutcome } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import type { WorkModule } from '../../src/work/registry.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { startWorker } from '../../src/worker.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createNativeContentSystem } from './support/native-system.ts';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { beginAuthorErasure } from '../../src/content/operations.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { readPartition } from '../../src/partition/partition.ts';

const databaseUrl = process.env.DATABASE_URL!;
const route = 0x4920;
const partition = partitionOf(route);
// A failed durable step retries after this delay in the child process; production waits one second.
const STEP_RETRY_DELAY_SECONDS = 0.05;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The production content registration with a shorter delay between attempts of a failed durable step. */
function contentWithStepRetryDelay(stepRetryDelaySeconds: number): WorkModule {
  return {
    name: registerContent.name,
    async register(context) {
      const dependencies = contentWorkDependencies(context.env, fetch);
      await createContentWork({
        storage: dependencies.storage,
        access: createContentWorkAccess(context.clock),
        readConsent: dependencies.readConsent,
        routeKey: readMembershipRouteKey(context.env),
        fetchConfig: dependencies.fetchConfig,
        collectionPartitions: [partition],
        stepRetryDelaySeconds,
      }).register(context);
      context.addEffects(contentEffects(context.pool, context.client));
    },
  };
}

if (process.argv.includes('--content-worker')) {
  const nativeFetch = globalThis.fetch;
  const storageEndpoint = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
  const consentEndpoint = 'https://consent.example.test';
  const storage = process.env.CONTENT_TEST_STORAGE;
  const consent = process.env.CONTENT_TEST_CONSENT;
  if (storage || consent) {
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const localOrigin =
        url.origin === storageEndpoint ? storage : url.origin === consentEndpoint ? consent : undefined;
      if (!localOrigin) return nativeFetch(request);
      const target = new URL(localOrigin);
      target.pathname = `${target.pathname.replace(/\/$/, '')}${url.pathname}`;
      target.search = url.search;
      const response = await nativeFetch(new Request(target, request));
      return url.origin === consentEndpoint
        ? new Response(response.body, { status: response.status, headers: response.headers })
        : response;
    }) as typeof globalThis.fetch;
  }
  const worker = await startWorker(
    {
      databaseUrl,
      executorId: `content-test-${new URL(databaseUrl).pathname.slice(1)}`,
      poolSize: 10,
      ...(process.env.CONTENT_TEST_NOW ? { clock: () => new Date(process.env.CONTENT_TEST_NOW!) } : {}),
    },
    KERNEL_WORK_MODULES.map((module) =>
      module === registerContent ? contentWithStepRetryDelay(STEP_RETRY_DELAY_SECONDS) : module,
    ),
    workerTestEnv({
      CONTENT_R2_ENDPOINT: storageEndpoint,
      CONTENT_R2_BUCKET: 'media-test',
      CONTENT_R2_ACCESS_KEY_ID: 'fixture',
      CONTENT_R2_SECRET_ACCESS_KEY: 'fixture-secret',
      CONTENT_SOURCE_HOSTS: 'images.example.org',
      KERNEL_AUTH_CONSENT_URL: `${consentEndpoint}/internal/v1/consents:read`,
      CF_ACCESS_CLIENT_ID: 'fixture.access',
      CF_ACCESS_CLIENT_SECRET: 'fixture-secret',
      KERNEL_RATING_COUNTER_SECRET: Buffer.alloc(32, 43).toString('base64url'),
      AUTH_ISSUER: 'https://auth.example.test',
      AUTH_AUDIENCE: 'https://api.example.test',
      AUTH_JWKS_URL: 'https://auth.example.test/.well-known/jwks.json',
      KERNEL_ROUTE_KEY: process.env.CONTENT_TEST_ROUTE_KEY ?? Buffer.alloc(32, 7).toString('base64url'),
      KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 8).toString('base64url')}`,
      CONTENT_TEST_COLLECTION_PARTITIONS: String(partition),
    }),
  );
  console.log('ready');
  for await (const line of console) {
    if (line === 'stop') {
      await worker.stop();
      console.log('stopped');
      break;
    }
  }
} else {
  const { test, expect } = await import('bun:test');

  function storageFixture() {
    const objects = new Map<string, Uint8Array>();
    const puts: string[] = [];
    const deletes: string[] = [];
    let failDelete = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        assert.match(request.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256.*\/auto\/s3\/aws4_request/);
        const url = new URL(request.url);
        const key = url.pathname.slice('/media-test/'.length).split('/').map(decodeURIComponent).join('/');
        if (url.searchParams.has('list-type')) {
          const prefix = url.searchParams.get('prefix')!;
          const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
          return new Response(
            `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('')}</ListBucketResult>`,
          );
        }
        if (request.method === 'PUT') {
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
          puts.push(key);
          return new Response(null, { status: 200 });
        }
        if (request.method === 'DELETE') {
          deletes.push(key);
          if (failDelete) return new Response(null, { status: 503 });
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        const bytes = objects.get(key);
        return bytes
          ? new Response(Uint8Array.from(bytes).buffer)
          : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      },
    });
    return {
      objects,
      puts,
      deletes,
      endpoint: server.url.origin,
      fail(value: boolean) {
        failDelete = value;
      },
      close() {
        server.stop(true);
      },
    };
  }
  type Store = ReturnType<typeof storageFixture>;

  async function until(check: () => boolean | Promise<boolean>, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for durable content work');
      await Bun.sleep(20);
    }
  }

  async function worker(store: Store, workerDatabaseUrl = databaseUrl, extra: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, import.meta.path, '--content-worker'], {
      env: { ...process.env, DATABASE_URL: workerDatabaseUrl, CONTENT_TEST_STORAGE: store.endpoint, ...extra },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let output = '';
    const read = (async () => {
      for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
    })();
    const errors = new Response(child.stderr).text();
    try {
      // The child imports the whole kernel before it prints anything, which takes seconds of CPU on a busy host.
      await until(() => {
        if (child.exitCode !== null) throw new Error(`Worker startup failed: ${output}`);
        return output.includes('ready');
      }, 120_000);
    } catch (error) {
      child.kill('SIGKILL');
      await child.exited;
      throw new Error(`${String(error)}\nstdout:\n${output}\nstderr:\n${await errors}`);
    }
    return {
      async kill() {
        child.kill('SIGKILL');
        await child.exited;
        await read;
      },
      async stop() {
        child.stdin.write('stop\n');
        child.stdin.end();
        try {
          await until(() => child.exitCode !== null);
        } catch (error) {
          child.kill('SIGKILL');
          await child.exited;
          throw new Error(`${String(error)}\nstdout:\n${output}\nstderr:\n${await errors}`);
        }
        expect(await child.exited).toBe(0);
        await read;
        expect(output).toContain('stopped');
        expect(await errors).not.toContain('AssertionError');
      },
    };
  }

  async function uploaded(
    pool: pg.Pool,
    store: Store,
    bytes: Uint8Array,
    targetRoute?: number,
    reservation?: { mediaId: string; containerId: string; uploaderId: string },
    options?: { events?: true },
  ): Promise<UploadedFixture>;
  async function uploaded(
    pool: pg.Pool,
    store: Store,
    bytes: Uint8Array,
    targetRoute: number,
    reservation: { mediaId: string; containerId: string; uploaderId: string } | undefined,
    options: { events: false },
  ): Promise<UploadedFixtureWithoutEvents>;
  async function uploaded(
    pool: pg.Pool,
    store: Store,
    bytes: Uint8Array,
    targetRoute = route,
    reservation?: { mediaId: string; containerId: string; uploaderId: string },
    options: { events?: boolean } = {},
  ): Promise<UploadedFixture | UploadedFixtureWithoutEvents> {
    const mediaId = reservation?.mediaId ?? newId(targetRoute);
    const containerId = reservation?.containerId ?? newId(targetRoute);
    const key = `m/${mediaId}/original`;
    const uploaderId = reservation?.uploaderId ?? newId(targetRoute + 1);
    store.objects.set(key, bytes);
    const insert = `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id)
        VALUES ($1,$2,$3,$4,$5,'post-image','image/png',$6,$6,$7,'uploaded',$8,$9)
ON CONFLICT (route,media_id) DO UPDATE SET state='uploaded',actual_byte_count=EXCLUDED.actual_byte_count,sha256=EXCLUDED.sha256,transaction_id=EXCLUDED.transaction_id`;
    const values = (transactionId: string) => [
      targetRoute,
      mediaId,
      containerId,
      uploaderId,
      randomUUID(),
      bytes.byteLength,
      sha(bytes),
      key,
      transactionId,
    ];
    if (options.events === false) {
      // runCommand requires at least one event, so eventless collection fixtures are inserted directly.
      await pool.query(insert, values(randomUUID()));
      return { mediaId, key, targetRoute };
    }
    const command = await runCommand(
      pool,
      { partition: partitionOf(targetRoute), deadline: Date.now() + 10_000 },
      async (tx, context) => {
        await tx.query(insert, values(context.transactionId));
        return {
          value: mediaId,
          events: [
            {
              type: 'com.rezics.content.media.uploaded.v1',
              subject: mediaId,
              data: { mediaId, containerId, actorId: uploaderId },
            },
          ],
        };
      },
    );
    return { mediaId, key, command, targetRoute };
  }

  type UploadedFixture = {
    mediaId: string;
    key: string;
    command: CommandOutcome<string>;
    targetRoute: number;
  };
  type UploadedFixtureWithoutEvents = Omit<UploadedFixture, 'command'>;

  async function enqueue(
    client: Awaited<ReturnType<typeof createWorkClient>>,
    fixture: UploadedFixture,
    kind: 'image' | 'purge',
  ) {
    const source = contentWorkSource(
      {
        epoch: fixture.command.epoch,
        partition: partitionOf(fixture.targetRoute),
        position: fixture.command.position,
      },
      0,
    );
    const workflowID = contentWorkWorkflowId(
      { ...source, position: BigInt(source.position) },
      0,
      kind,
      kind === 'purge' ? fixture.mediaId : undefined,
    );
    return client.enqueue(
      {
        workflowName: CONTENT_WORKFLOWS[kind],
        queueName: CONTENT_QUEUES[kind],
        workflowID,
        ...(kind === 'image' ? { queuePartitionKey: String(source.partition) } : {}),
      },
      { mediaId: fixture.mediaId, source },
    );
  }
  async function result<T>(handle: { getResult(): Promise<T> }) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handle.getResult(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for native workflow result')), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  test('shared kernel registers content once and effects are source-partitioned', () => {
    expect(KERNEL_WORK_MODULES.filter((module) => module.name === registerContent.name)).toEqual([registerContent]);
    expect(WORK_QUEUES.effects).toMatchObject({ partitionConcurrency: 1 });
    expect(WORK_QUEUES.governance.workerConcurrency).toBeGreaterThan(0);
  });

  test('checkGrowth proves bounded real collection SQL with same-partition distractors at three scales', async () => {
    const db = await openGrowthDatabase();
    const store = storageFixture();
    const storage = new R2Storage({
      endpoint: store.endpoint,
      bucket: 'media-test',
      accessKeyId: 'fixture',
      secretAccessKey: 'secret',
      maxObjectBytes: 20 * 1024 * 1024,
      fetch,
    });
    try {
      const report = await checkGrowth(db, {
        name: 'Content partition collection fixed K and Delta',
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(db, scale, previous) {
          // Setup is excluded from capture. Each measured relation gets at least
          // 256 rows at the first scale (core.partition already has 4096).
          // Half the unrelated rows share the target partition; none are aged.
          for (let start = previous; start < scale; start += 1024) {
            const rows = Array.from({ length: Math.min(1024, scale - start) }, (_, offset) => {
              const targetRoute = (start + offset) % 2 ? route : route + 32;
              const mediaId = newId(targetRoute);
              return {
                route: targetRoute,
                media_id: mediaId,
                container_id: newId(targetRoute),
                uploader_id: newId(targetRoute + 1),
                reservation_request_id: randomUUID(),
                key: `m/${mediaId}/original`,
                transaction_id: randomUUID(),
                position: (start + offset + 1) * 1000,
              };
            });
            await db.admin.query(
              `WITH population AS (
                SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(route integer,media_id uuid,container_id uuid,uploader_id uuid,reservation_request_id uuid,key text,transaction_id uuid,position bigint)
              ), media AS (INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id)
              SELECT route,media_id,container_id,uploader_id,reservation_request_id,'post-image','image/png',1,1,$2,'uploaded',key,transaction_id
              FROM population RETURNING route,media_id,transaction_id
              ), variants AS (
                INSERT INTO content.media_variant (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
                SELECT route,media_id,'webp',1,1,'image/webp',1,$2,'m/'||media_id||'/webp-1',transaction_id FROM media
              ), receipts AS (
                INSERT INTO core.receipt (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
                SELECT route>>4,'account',uploader_id,'content.media.collection.fence',media_id::text,decode($2,'hex'),1,position,transaction_id,'{}'::jsonb FROM population
              ), events AS (
                INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
                SELECT route>>4,position,0,1,1,media_id,'com.rezics.content.media.uploaded.v1',media_id::text,
                  jsonb_build_object('mediaId',media_id,'containerId',container_id,'actorId',uploader_id) FROM population
              )
              INSERT INTO editorial.write_basis (partition_no,transaction_id,epoch,position,principal_kind,principal_id,client_id)
              SELECT route>>4,transaction_id,1,position,'account',uploader_id,'content-growth-fixture' FROM population`,
              [JSON.stringify(rows), sha(new Uint8Array([1]))],
            );
          }
          await db.admin.query(
            'UPDATE core.partition SET position=GREATEST(position,$1::bigint) WHERE partition_no=ANY($2::integer[])',
            [scale * 1000, [partition, partition + 2]],
          );
          for (const relation of [
            'content.media',
            'content.media_variant',
            'core.receipt',
            'core.outbox',
            'editorial.write_basis',
          ])
            await db.admin.query(`ANALYZE ${relation}`);
        },
        async operation(db, _scale, repetition) {
          const fixture = await uploaded(db.admin, store, new Uint8Array([repetition % 256]));
          await db.admin.query(
            "UPDATE content.media SET created_at=clock_timestamp()-interval '25 hours' WHERE route=$1 AND media_id=$2",
            [route, fixture.mediaId],
          );
          const outcome = await collectPartition(db.pool, storage, partition, 100);
          expect(outcome.collected).toBe(1);
          expect(outcome.partition).toBe(partition);
        },
      });
      expect(report.samples).toHaveLength(3);
      for (const sample of report.samples) {
        if (!('plans' in sample.cost) || typeof sample.cost.plans !== 'number')
          throw new Error('Growth report must retain actual plan count');
        expect(sample.cost.plans).toBeGreaterThan(0);
        expect(sample.cost.rows).toBeGreaterThan(0);
      }
      console.log(JSON.stringify(report));
      // Separately increase actual changed rows, never unrelated cardinality.
      const changed = await checkGrowth(db, {
        name: 'Content collection actual Delta',
        scales: [1, 8, 64],
        bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
        async grow() {},
        async operation(db, scale, repetition) {
          const ids: string[] = [];
          for (let index = 0; index < scale; index++)
            ids.push((await uploaded(db.admin, store, new Uint8Array([repetition % 256]))).mediaId);
          await db.admin.query(
            "UPDATE content.media SET created_at=clock_timestamp()-interval '25 hours' WHERE route=$1 AND media_id=ANY($2::uuid[])",
            [route, ids],
          );
          const outcome = await collectPartition(db.pool, storage, partition, 100);
          expect(outcome.collected).toBe(scale);
          expect(outcome.partition).toBe(partition);
        },
      });
      expect(changed.samples).toHaveLength(3);
      console.log(JSON.stringify(changed));
    } finally {
      await db.close();
      store.close();
    }
  });

  test('actual DBOS worker consumes prelaunch image work, recovers and deduplicates real Sharp effects', async () => {
    const store = storageFixture();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await createWorkClient(databaseUrl);
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#4477cc' } })
        .png()
        .toBuffer();
      const fixture = await uploaded(pool, store, bytes);
      const handle = await enqueue(client, fixture, 'image');
      expect(
        (await pool.query('SELECT state FROM content.media WHERE route=$1 AND media_id=$2', [route, fixture.mediaId]))
          .rows[0].state,
      ).toBe('uploaded');
      running = await worker(store);
      expect(await result(handle)).toMatchObject({ mediaId: fixture.mediaId, state: 'available' });
      const variants = (
        await pool.query('SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2', [route, fixture.mediaId])
      ).rows;
      expect(variants).toHaveLength(2);
      for (const variant of variants) {
        const bytes = store.objects.get(variant.key)!;
        expect(sha(bytes)).toBe(variant.sha256);
        expect((await sharp(bytes).metadata()).width).toBe(48);
      }
      const puts = [...store.puts];
      await running.kill();
      running = undefined;
      running = await worker(store);
      expect(await result(await enqueue(client, fixture, 'image'))).toMatchObject({ state: 'available' });
      expect(store.puts).toEqual(puts);
      expect(
        (
          await pool.query(
            "SELECT id FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.media.available.v1'",
            [partition, fixture.mediaId],
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await running?.stop();
      // Keep the persistent schedule through kill/restart; remove only our fixture at final teardown.
      await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
      await client.close();
      await pool.end();
      store.close();
    }
  });

  test('permanent image rejection keeps cleanup retryable through failure and restart', async () => {
    const store = storageFixture();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await createWorkClient(databaseUrl);
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const fixture = await uploaded(pool, store, new TextEncoder().encode('corrupt image'));
      store.objects.set(`m/${fixture.mediaId}/webp-48`, new Uint8Array([1]));
      store.fail(true);
      const handle = await enqueue(client, fixture, 'image');
      running = await worker(store);
      await until(() => store.deletes.length > 0);
      expect(
        (await pool.query('SELECT state FROM content.media WHERE route=$1 AND media_id=$2', [route, fixture.mediaId]))
          .rows[0].state,
      ).toBe('rejected');
      await running.kill();
      running = undefined;
      store.fail(false);
      running = await worker(store);
      await result(handle);
      expect([...store.objects.keys()].filter((key) => key.startsWith(`m/${fixture.mediaId}/`))).toEqual([]);
      expect(store.puts).toEqual([]);
    } finally {
      await running?.stop();
      // Keep the persistent schedule through kill/restart; remove only our fixture at final teardown.
      await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
      await client.close();
      await pool.end();
      store.close();
    }
  });

  test('erase immediately denies download while governance purge retries across restart without resurrection', async () => {
    const system = await createNativeContentSystem({ databaseUrl });
    const systemUrl = new URL(databaseUrl);
    systemUrl.pathname = (await system.database.pool.query('SELECT current_database() AS name')).rows[0].name;
    const store = storageFixture();
    const client = await createWorkClient(systemUrl.href);
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const native = await nativeThread(system, system.actors.moderator);
      const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
        .png()
        .toBuffer();
      const reserved = await reserveMedia(
        { pool: system.database.pool, access: system.access },
        system.actors.moderator.actor,
        { containerId: native.threadId, purpose: 'post-image', mediaType: 'image/png', byteCount: bytes.byteLength },
        { deadline: Date.now() + 10000, idempotencyKey: randomUUID(), requestId: randomUUID() },
      );
      const fixture = await uploaded(system.database.pool, store, bytes, routeOf(reserved.value.mediaId)!, {
        mediaId: reserved.value.mediaId,
        containerId: native.threadId,
        uploaderId: system.actors.moderator.actor.accountId,
      });
      const image = await enqueue(client, fixture, 'image');
      running = await worker(store, systemUrl.href);
      await result(image);
      store.fail(true);
      // Durable image work outlives the fixture's ten-second authentication admission.
      const moderator = await system.auth.issue({
        accountId: system.actors.moderator.actor.accountId,
        clientId: system.actors.moderator.actor.clientId,
        scopes: system.actors.moderator.actor.scopes,
      });
      const erased = await eraseStandaloneMedia(
        { pool: system.database.pool, access: system.access, routeKey: system.routeKey },
        moderator.actor,
        { mediaId: fixture.mediaId, reason: 'Remove bytes' },
        { requestId: randomUUID(), idempotencyKey: randomUUID(), deadline: Date.now() + 10_000 },
      );
      expect(
        await decideDownload(
          { pool: system.database.pool, access: system.access },
          fixture.mediaId,
          system.actors.author.actor,
          'webp-16',
        ),
      ).toEqual({ allowed: false });
      const purge = await enqueue(
        client,
        { ...fixture, command: { ...fixture.command, epoch: erased.epoch, position: erased.position } },
        'purge',
      );
      await until(() => store.deletes.length > 0);
      await running.kill();
      running = undefined;
      store.fail(false);
      running = await worker(store, systemUrl.href);
      await result(purge);
      await result(await enqueue(client, fixture, 'image'));
      expect([...store.objects.keys()].filter((key) => key.startsWith(`m/${fixture.mediaId}/`))).toEqual([]);
      expect(
        (
          await system.database.pool.query('SELECT erased FROM content.media WHERE route=$1 AND media_id=$2', [
            fixture.targetRoute,
            fixture.mediaId,
          ])
        ).rows[0].erased,
      ).toBe(true);
    } finally {
      await running?.stop();
      // Keep the persistent schedule through kill/restart; remove only our fixture at final teardown.
      await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
      await client.close();
      await system.close();
      store.close();
    }
  });

  test('native persistent hourly collection respects exact24h, claims, partition and pending fences after restart', async () => {
    const store = storageFixture();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await createWorkClient(databaseUrl);
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const now = new Date().toISOString();
      running = await worker(store, databaseUrl, { CONTENT_TEST_NOW: now });
      const bytes = new Uint8Array([1]);
      const old = await uploaded(pool, store, bytes, route, undefined, { events: false });
      const young = await uploaded(pool, store, bytes, route, undefined, { events: false });
      const claimed = await uploaded(pool, store, bytes, route, undefined, { events: false });
      const other = await uploaded(pool, store, bytes, route + 16, undefined, { events: false });
      await pool.query(
        `UPDATE content.media SET created_at=$2::timestamptz-interval '24 hours' WHERE media_id=ANY($1)`,
        [[old.mediaId, claimed.mediaId, other.mediaId], now],
      );
      await pool.query(
        "UPDATE content.media SET state='available',claimed_at=clock_timestamp() WHERE route=$1 AND media_id=$2",
        [route, claimed.mediaId],
      );
      await pool.query(
        "UPDATE content.media SET created_at=$3::timestamptz-interval '23 hours 59 minutes 59 seconds' WHERE route=$1 AND media_id=$2",
        [route, young.mediaId, now],
      );
      await result(await client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE));
      expect(store.deletes).not.toHaveLength(0);
      expect(store.deletes.filter((key) => !key.startsWith(`m/${old.mediaId}/`))).toEqual([]);
      const deletesAfterFirstSweep = store.deletes.length;
      expect(store.objects.has(old.key)).toBe(false);
      for (const fixture of [young, claimed, other]) expect(store.objects.has(fixture.key)).toBe(true);
      const pending = await uploaded(pool, store, bytes, route, undefined, { events: false });
      await pool.query(
        "UPDATE content.media SET created_at=clock_timestamp()-interval '25 hours' WHERE route=$1 AND media_id=$2",
        [route, pending.mediaId],
      );
      store.fail(true);
      const schedule = await client.triggerSchedule(CONTENT_COLLECTION_SCHEDULE);
      await until(() => store.deletes.includes(pending.key));
      expect(
        (
          await pool.query('SELECT collection_pending FROM content.media WHERE route=$1 AND media_id=$2', [
            route,
            pending.mediaId,
          ])
        ).rows[0].collection_pending,
      ).toBe(true);
      await running.kill();
      running = undefined;
      store.fail(false);
      running = await worker(store, databaseUrl, { CONTENT_TEST_NOW: now });
      await result(schedule);
      expect(
        store.deletes.slice(deletesAfterFirstSweep).filter((key) => !key.startsWith(`m/${pending.mediaId}/`)),
      ).toEqual([]);
      expect(store.objects.has(pending.key)).toBe(false);
      expect(await client.listSchedules({ scheduleNamePrefix: CONTENT_COLLECTION_SCHEDULE })).toHaveLength(1);
      expect(await client.getSchedule(CONTENT_COLLECTION_SCHEDULE)).toMatchObject({
        schedule: '0 * * * *',
        queueName: 'maintenance',
      });
      expect(
        store.deletes.filter((key) =>
          [young, claimed, other].some((fixture) => key.startsWith(`m/${fixture.mediaId}/`)),
        ),
      ).toEqual([]);
    } finally {
      await running?.stop();
      // Keep the persistent schedule through kill/restart; remove only our fixture at final teardown.
      await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
      await client.close();
      await pool.end();
      store.close();
    }
  });

  async function grant(
    system: Awaited<ReturnType<typeof createNativeContentSystem>>,
    accountId: string,
    id: string,
    actions: string[],
    grantor?: string,
  ) {
    const { rows } = await system.database.pool.query(
      'SELECT account_id FROM access.governance_bootstrap WHERE route=0',
    );
    const governance = await system.auth.issue({
      accountId: rows[0].account_id,
      clientId: system.auth.ordinaryClient.id,
      scopes: [...system.actions.keys()].filter((action) => action !== 'media:complete'),
    });
    const response = await system.kernel.handle(
      new Request('https://content.test/v1/grants', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${grantor ?? governance.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(randomUUID()),
        },
        body: JSON.stringify({
          resource: { route: Number.parseInt(id.slice(24, 28), 16), id },
          subject: { kind: 'account', id: accountId },
          actions,
          valid: '(,)',
        }),
      }),
    );
    expect(response.status).toBe(201);
  }

  async function nativeThread(
    system: Awaited<ReturnType<typeof createNativeContentSystem>>,
    person: typeof system.actors.author,
  ) {
    await bootstrapRelease(system.database.pool, bundledRelease);
    const call = async (
      path: string,
      body: unknown,
      bearer = person.bearer,
      method = 'POST',
      headers: Record<string, string> = {},
    ) => {
      const response = await system.kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
      if (!response.ok) throw new Error(`Native fixture ${path}: ${response.status} ${await response.text()}`);
      return (await response.json()) as Record<string, any>;
    };
    const owner = system.actors.other;
    const { space } = await call('/v1/spaces', { title: 'Work host', summary: '' }, owner.bearer);
    const { realm } = await call(
      '/v1/realms',
      { spaceId: space.spaceId, title: 'Work Realm', summary: '', visibility: 'public', contextId: GLOBAL_CONTEXT },
      owner.bearer,
    );
    await grant(system, person.actor.accountId, realm.realmId, ['board:create'], owner.bearer);
    const { subject: scheme } = await call('/v1/subjects', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Work scheme' },
    });
    const { subject: concept } = await call('/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: 'Work concept' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    });
    await call(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, owner.bearer, 'PUT', {
      'if-match': JSON.stringify(realm.headRevisionId),
    });
    const { board } = await call(`/v1/realms/${realm.realmId}/boards`, {
      conceptId: concept.id,
      title: 'Work board',
      visibility: 'published',
    });
    const command = await createThread(
      { pool: system.database.pool, access: system.access, routeKey: system.routeKey },
      person.actor,
      {
        boardId: board.id,
        subjectIds: [concept.id],
        title: 'Work thread',
        licence: 'CC-BY-SA-4.0',
        visibility: 'published',
        body: fromPlainText('Private historical text'),
      },
      { deadline: Date.now() + 10000, idempotencyKey: randomUUID(), requestId: randomUUID() },
    );
    return { threadId: command.value.threadId, postId: command.value.itemId };
  }

  test('enqueue-only native operation client binds committed identity and reports bounded native progress and terminal errors', async () => {
    const system = await createNativeContentSystem({ databaseUrl });
    const pool = system.database.pool;
    const url = new URL(databaseUrl);
    url.pathname = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    const client = await createWorkClient(url.href);
    const workflows = createContentOperationClient({ pool, client, clock: () => new Date() });
    const { readCurrentConsent } = createCurrentConsentReader({ database: system.database.authPool });
    const consent = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        return Response.json(await readCurrentConsent(await request.json()));
      },
    });
    const store = storageFixture();
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      expect(await workflows.status('missing-native-workflow', { deadline: Date.now() + 10000 })).toBeNull();
      const actor = system.actors.author.actor;
      const { threadId, postId } = await nativeThread(system, system.actors.author);
      const operationRoute = routeOf(threadId)!;
      const operationPartition = partitionOf(operationRoute);
      const context = () => ({ deadline: Date.now() + 10000, idempotencyKey: randomUUID(), requestId: randomUUID() });
      const operation = await beginAuthorErasure(
        { pool, access: system.access, clock: () => new Date(), workflows },
        actor,
        { threadId, authorId: actor.accountId },
        context(),
      );
      const input = { operationId: operation.value.operationId, threadId, authorId: actor.accountId, actor };
      await expect(workflows.enqueue(input, context())).rejects.toThrow();
      let envelope: Envelope | undefined;
      await readBatch(pool, {
        partition: operationPartition,
        consumer: `content_work_test_${randomUUID().replaceAll('-', '')}`,
        apply: async (batch) => {
          envelope = batch.find((item) => item.position === operation.position);
        },
      });
      const tx = await pool.connect();
      let workflowID: string;
      try {
        await tx.query('BEGIN');
        await readPartition(tx, operationPartition);
        workflowID = await bindAuthorErasureWorkflow(tx, input.operationId, envelope!, 0);
        await tx.query('COMMIT');
      } finally {
        tx.release();
      }
      await expect(
        workflows.enqueue({ ...input, authorId: system.actors.other.actor.accountId }, context()),
      ).rejects.toThrow();
      await workflows.enqueue(input, context());
      await workflows.enqueue(input, context());
      expect((await client.getWorkflow(workflowID!))?.status).toBe('ENQUEUED');
      expect(await workflows.status(workflowID!, context())).toEqual({
        done: false,
        progress: { processedPosts: 0, erasedRevisions: 0, steps: 0 },
      });
      running = await worker(store, url.href, {
        CONTENT_TEST_CONSENT: consent.url.origin,
        CONTENT_TEST_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
      });
      expect(await result(client.retrieveWorkflow(workflowID!))).toEqual({ processedPosts: 1, erasedRevisions: 1 });
      const status = await workflows.status(workflowID!, context());
      expect(status).toMatchObject({
        done: true,
        response: { processedPosts: 1, erasedRevisions: 1 },
        progress: { processedPosts: 1, erasedRevisions: 1 },
      });
      expect(status!.progress.steps).toBeGreaterThan(0);
      expect(await client.getEvent(workflowID!, CONTENT_OPERATION_PROGRESS, 0)).toEqual(status!.progress);
      expect(
        (
          await pool.query('SELECT availability FROM content.post WHERE route=$1 AND post_id=$2', [
            operationRoute,
            postId,
          ])
        ).rows[0].availability,
      ).toBe('erased');
      // Run the actual source guard through native DBOS; missing operation fails with RPC permission status.
      const missing = newId(operationRoute);
      const source = {
        epoch: operation.epoch,
        partition: operationPartition,
        position: operation.position.toString(),
        eventIndex: 0,
      };
      const deniedID = contentWorkWorkflowId({ ...source, position: operation.position }, 0, 'authorErase', missing);
      const denied = await client.enqueue(
        { workflowName: CONTENT_WORKFLOWS.authorErase, queueName: CONTENT_QUEUES.authorErase, workflowID: deniedID },
        { operationId: missing, source },
      );
      await expect(result(denied)).rejects.toThrow();
      expect(await workflows.status(deniedID, context())).toEqual({
        done: true,
        progress: { processedPosts: 0, erasedRevisions: 0, steps: 0 },
        error: { code: 7, message: 'Permission denied' },
      });
    } finally {
      await running?.stop();
      // Keep the persistent schedule through kill/restart; remove only our fixture at final teardown.
      await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
      await client.close();
      consent.stop(true);
      store.close();
      await system.close();
    }
  });

  test('native URL workflow invokes the production import rejection and governance cleanup with ID-only source', async () => {
    const store = storageFixture();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await createWorkClient(databaseUrl);
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const fixture = await uploaded(pool, store, new Uint8Array([1]));
      // Invalid persisted evidence is a permanent production rejection, never a remote fetch.
      await pool.query(
        `UPDATE content.media SET purpose='cover',state='reserved',source_url='https://images.example.org/image.png',credit='{"rightsHolder":"Fixture","via":{"name":"Fixture","url":"https://images.example.org/"},"license":"MIT","obligations":[],"unexpected":true}'::jsonb,provenance='{"source":"fixture","external_id":"fixture","record_revision":"1","digest":"0000000000000000000000000000000000000000000000000000000000000000","converter_revision":"1","field_group":"cover","references":["https://images.example.org/"]}'::jsonb,actual_byte_count=NULL,byte_count=NULL,sha256=NULL,media_type=NULL WHERE route=$1 AND media_id=$2`,
        [route, fixture.mediaId],
      );
      const source = contentWorkSource(
        { epoch: fixture.command.epoch, partition, position: fixture.command.position },
        0,
      );
      const workflowID = contentWorkWorkflowId(
        { ...source, position: fixture.command.position },
        0,
        'importFromUrl',
        fixture.mediaId,
      );
      const handle = await client.enqueue(
        {
          workflowName: CONTENT_WORKFLOWS.importFromUrl,
          queueName: CONTENT_QUEUES.importFromUrl,
          workflowID,
          queuePartitionKey: String(partition),
        },
        { mediaId: fixture.mediaId, source },
      );
      running = await worker(store);
      expect(await result(handle)).toMatchObject({ state: 'rejected', rejection: { code: 'source-evidence' } });
      expect(store.objects.has(fixture.key)).toBe(false);
      expect(
        (
          await pool.query('SELECT state,collection_pending FROM content.media WHERE route=$1 AND media_id=$2', [
            route,
            fixture.mediaId,
          ])
        ).rows[0],
      ).toEqual({ state: 'rejected', collection_pending: true });
    } finally {
      await running?.stop();
      // Keep the persistent schedule through kill/restart; remove only our fixture at final teardown.
      await client.deleteSchedule(CONTENT_COLLECTION_SCHEDULE);
      await client.close();
      await pool.end();
      store.close();
    }
  });
}
