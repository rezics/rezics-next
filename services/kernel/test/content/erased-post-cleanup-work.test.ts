import { fromPlainText, serializeDocument } from '@rezics/document';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

if (process.argv.includes('--erased-post-worker')) {
  const { readWorkerConfig, startWorker } = await import('../../src/worker.ts');
  await startWorker(readWorkerConfig(process.env));
  console.log('erased-post-worker-ready');
} else {
  const { afterAll, beforeAll, expect, test } = await import('bun:test');
  const { randomUUID } = await import('node:crypto');
  const { createAuthService } = await import('@rezics/auth');
  const { exportJWK, generateKeyPair } = await import('jose');
  const { Pool } = await import('pg');
  const { readAccount } = await import('../../src/access/account-data.ts');
  const { createAccess } = await import('../../src/access/index.ts');
  const { createWriteRateLimiter } = await import('../../src/access/write-rate.ts');
  const { EFFECTS_CONSUMER } = await import('../../src/events/effects.ts');
  const { createKernel } = await import('../../src/http/kernel.ts');
  const { newId, partitionOf, routeOf } = await import('../../src/route/route.ts');

  const actions = ['post:erase', 'post:read', 'thread:read', 'board:read'];
  const clearAuthor = newId(0x51a1);
  const resumeAuthor = newId(0x52a1);
  const issuer = 'https://erased-post-cleanup.auth.test';
  const audience = 'https://api.rezics.test';
  const authDatabase = `erased_post_cleanup_auth_${process.pid}`;
  const bearers = new Map<string, string>();
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let authPool: InstanceType<typeof Pool> | undefined;
  let app: ReturnType<typeof createKernel>;
  const workers: Array<{ kill: () => void; exited: Promise<number> }> = [];

  function document(text: string): Buffer {
    return Buffer.from(serializeDocument(fromPlainText(text)));
  }

  beforeAll(async () => {
    const authUrl = new URL(databaseUrl);
    authUrl.pathname = `/${authDatabase}`;
    const maintenance = new Pool({ connectionString: new URL('/postgres', databaseUrl).href });
    try {
      await maintenance.query(`CREATE DATABASE ${authDatabase}`);
    } finally {
      await maintenance.end();
    }
    const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
    migrate(authUrl.href);
    authPool = new Pool({ connectionString: authUrl.href });
    const signing = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'erased-post-cleanup',
      alg: 'ES256',
    };
    const authors = [clearAuthor, resumeAuthor];
    const approvals = new Set(authors);
    const auth = await createAuthService({
      database: authPool,
      issuer,
      audience,
      secret: 'erased-post-cleanup-test-only-secret-at-least-32',
      signing: { activeKid: signing.kid, privateKeys: [signing] },
      trustedAccess: trustedAccessPorts({
        async readAccount(id) {
          const account = await readAccount(pool, routeOf(id)!, id);
          return (
            account && {
              accountId: id,
              kind: account.kind,
              state: account.state,
              authnEpoch: Number(account.minimumAuthnEpoch),
              automated: false,
            }
          );
        },
        async authorizeProvisioning(reference) {
          if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
          return { accountId: reference };
        },
      }),
    });
    await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: actions });
    for (const id of authors) {
      await pool.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
         VALUES ($1,$2,'actor','pending',$2)`,
        [routeOf(id), id],
      );
      await auth.internal.provisionPassword({
        authorization: id,
        email: `${id}@example.test`,
        password: `${id}-password`,
      });
      await pool.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [routeOf(id), id]);
      const signed = await auth.handler(
        new Request(`${issuer}/signin`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: `${id}@example.test`,
            password: `${id}-password`,
            client_id: 'web',
            scope: actions,
          }),
        }),
      );
      expect(signed.status).toBe(200);
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await auth.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: '{}',
        }),
      );
      expect(issued.status).toBe(200);
      bearers.set(id, ((await issued.json()) as { access_token: string }).access_token);
    }
    app = createKernel({
      pool,
      routeKey: Buffer.alloc(32, 4),
      writeRate: createWriteRateLimiter({ secret: 'erased-post-cleanup-rate-secret-at-least-32' }),
      access: (config) =>
        createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            fetch: (url, init) => auth.handler(new Request(url, init)),
          },
        }),
    });
  });

  afterAll(async () => {
    const running = workers.splice(0);
    for (const worker of running) worker.kill();
    await Promise.all(running.map((worker) => worker.exited));
    await authPool?.end();
    await pool.end();
    const maintenance = new Pool({ connectionString: new URL('/postgres', databaseUrl).href });
    try {
      await dropTestDatabase(maintenance, authDatabase);
    } finally {
      await maintenance.end();
    }
  });

  async function until(label: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
      await Bun.sleep(20);
    }
  }

  function spawnWorker(executorId: string) {
    const routeKey = Buffer.alloc(32, 8).toString('base64url');
    const sessionKey = Buffer.alloc(32, 9).toString('base64url');
    const env = workerTestEnv({
      ...process.env,
      DATABASE_URL: databaseUrl,
      KERNEL_EXECUTOR_ID: executorId,
      KERNEL_ROUTE_KEY: routeKey,
      KERNEL_SESSION_KEYS: `1:${sessionKey}`,
      AUTH_ISSUER: 'https://erased-post-worker.auth.test',
      AUTH_AUDIENCE: 'https://api.rezics.test',
      AUTH_JWKS_URL: 'https://erased-post-worker.auth.test/.well-known/jwks.json',
      CONTENT_R2_ENDPOINT: `https://${'ab'.repeat(16)}.r2.cloudflarestorage.com`,
      CONTENT_R2_BUCKET: 'content-media',
      CONTENT_R2_ACCESS_KEY_ID: 'fixture-access',
      CONTENT_R2_SECRET_ACCESS_KEY: 'fixture-secret',
      CONTENT_SOURCE_HOSTS: 'images.example.org',
      KERNEL_AUTH_CONSENT_URL: 'https://consent.example.test/internal/v1/consents:read',
      CF_ACCESS_CLIENT_ID: 'fixture.access',
      CF_ACCESS_CLIENT_SECRET: 'fixture-secret-token',
    });
    for (const name of [
      'OPENSEARCH_URL',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRETS',
      'STRIPE_MANAGED_PAYMENTS',
      'STRIPE_API_HOST',
      'CHECKOUT_SUCCESS_URL',
      'CHECKOUT_CANCEL_URL',
      'KERNEL_WRITE_RATE_EXPIRY_PARTITION',
      'KERNEL_WRITE_RATE_EXPIRY_NODE',
    ])
      delete env[name];
    const child = Bun.spawn([process.execPath, import.meta.path, '--erased-post-worker'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    let output = '';
    let errors = '';
    const readOut = (async () => {
      for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
    })();
    const readErr = (async () => {
      for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk);
    })();
    const handle = {
      kill() {
        child.kill('SIGKILL');
      },
      exited: child.exited.then((code) => code ?? 1),
      async stop() {
        child.kill('SIGTERM');
        const deadline = Date.now() + 15_000;
        while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        if (child.exitCode === null) child.kill('SIGKILL');
        expect(await child.exited).toBe(0);
        await Promise.all([readOut, readErr]);
      },
      output: () => output,
      errors: () => errors,
    };
    workers.push(handle);
    return { child, handle, readOut, readErr };
  }

  async function startWorker(executorId: string) {
    const running = spawnWorker(executorId);
    try {
      await until('kernel worker', async () => {
        if (running.child.exitCode !== null) {
          await Promise.all([running.readOut, running.readErr]);
          throw new Error(`Worker exited early\n${running.handle.output()}\n${running.handle.errors()}`);
        }
        return running.handle.output().includes('erased-post-worker-ready');
      });
    } catch (error) {
      running.handle.kill();
      await running.child.exited;
      throw error;
    }
    return running;
  }

  async function fixture(owner: string, contentRoute: number, count: number) {
    const board = newId(contentRoute + 16);
    const thread = newId(contentRoute);
    const post = newId(contentRoute);
    const neighbour = newId(contentRoute);
    const revisions = Array.from({ length: count }, () => newId(contentRoute));
    const neighbourRevision = newId(contentRoute);
    const head = revisions[0]!;
    const locked = revisions[100];
    const body = document(`Authored sentinel ${post}`);
    const otherBody = document(`Neighbour sentinel ${neighbour}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,'Board','published',1,$2)`,
        [routeOf(board), board, newId(contentRoute)],
      );
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
         VALUES ($1,$2,$3,$4,'Opening title','published',1,$2,$5)`,
        [contentRoute, thread, owner, board, post],
      );
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,'published',1,$5)`,
        [contentRoute, thread, post, owner, head],
      );
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,'published',1,$5)`,
        [contentRoute, thread, neighbour, owner, neighbourRevision],
      );
      for (let index = 0; index < revisions.length; index++) {
        await client.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id,recorded_at)
           VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'CC-BY-4.0','{}',$7,'available',$4,timestamptz '2020-01-01 00:00:00+00' + ($8::int * interval '1 second'))`,
          [contentRoute, thread, post, revisions[index], body, `Authored sentinel ${post}`, board, index],
        );
      }
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
         VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'CC-BY-4.0','{}',$7,'available',$4)`,
        [contentRoute, thread, neighbour, neighbourRevision, otherBody, `Neighbour sentinel ${neighbour}`, board],
      );
      await client.query(
        `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
         VALUES ($1,$2,$3,'content.post.owner','(,)',$2),($1,$4,$3,'content.post.owner','(,)',$4)`,
        [contentRoute, post, owner, neighbour],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { board, thread, post, neighbour, revisions, head, locked, count };
  }

  async function erase(post: string, account: string) {
    const key = JSON.stringify(randomUUID());
    return app.handle(
      new Request(`http://kernel.test/v1/posts/${post}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${bearers.get(account)!}`,
          'Idempotency-Key': key,
        },
      }),
    );
  }

  async function uncleared(route: number, post: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM content.revision
       WHERE route=$1 AND post_id=$2
         AND (body IS NOT NULL OR search_text IS NOT NULL OR availability <> 'erased')`,
      [route, post],
    );
    return rows[0]!.n;
  }

  async function revisionCount(route: number, post: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM content.revision WHERE route=$1 AND post_id=$2',
      [route, post],
    );
    return rows[0]!.n;
  }

  async function fingerprint(route: number, post: string) {
    const { rows } = await pool.query(
      `SELECT revision_id, availability, (body IS NULL) AS body_null, search_text,
              encode(body_sha256,'hex') AS digest, xmin::text AS xmin, ctid::text AS ctid
       FROM content.revision
       WHERE route=$1 AND post_id=$2
       ORDER BY recorded_at, revision_id`,
      [route, post],
    );
    return rows;
  }

  async function governanceSucceeded(post: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM dbos.workflow_status ws
       JOIN dbos.workflow_input wi ON wi.workflow_uuid = ws.workflow_uuid
       WHERE ws.queue_name = 'governance' AND ws.status = 'SUCCESS' AND wi.inputs LIKE $1`,
      [`%${post}%`],
    );
    return rows[0]!.n;
  }

  async function eraseEvent(partition: number, post: string) {
    const { rows } = await pool.query<{ position: string; id: string }>(
      `SELECT position::text, id::text
       FROM core.outbox
       WHERE partition_no=$1 AND type='com.rezics.content.post.erased.v1' AND data->>'postId'=$2
       ORDER BY position`,
      [partition, post],
    );
    return rows;
  }

  test("an author's post delete, with the actual kernel worker running, clears every revision body of that post", async () => {
    const contentRoute = 0x51b1;
    const created = await fixture(clearAuthor, contentRoute, 101);
    const running = await startWorker(`erased-post-clear-${process.pid}`);
    try {
      const deleted = await erase(created.post, clearAuthor);
      const body = await deleted.text();
      expect(deleted.status).toBe(204);
      expect(body).toBe('');
      await until(
        'erased post event',
        async () => (await eraseEvent(partitionOf(contentRoute), created.post)).length === 1,
      );
      await until('revision cleanup', async () => (await uncleared(contentRoute, created.post)) === 0);
      expect(await revisionCount(contentRoute, created.post)).toBe(101);
      expect(await uncleared(contentRoute, created.post)).toBe(0);
      expect(await uncleared(contentRoute, created.neighbour)).toBe(1);
      await until('governance workflow completion', async () => (await governanceSucceeded(created.post)) > 0);
      expect(await governanceSucceeded(created.post)).toBeGreaterThan(0);
    } finally {
      await running.handle.stop().catch(() => running.handle.kill());
    }
  });

  test('duplicate or replayed content.post.erased events change nothing, and a worker restart mid-cleanup resumes to completion', async () => {
    const contentRoute = 0x52b1;
    const created = await fixture(resumeAuthor, contentRoute, 150);
    const locked = created.locked!;
    const holder = await pool.connect();
    const executorId = `erased-post-resume-${process.pid}`;
    let running: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT revision_id FROM content.revision WHERE route=$1 AND revision_id=$2 FOR UPDATE', [
        contentRoute,
        locked,
      ]);
      running = await startWorker(executorId);
      const deleted = await erase(created.post, resumeAuthor);
      const body = await deleted.text();
      expect(deleted.status).toBe(204);
      expect(body).toBe('');
      await until('cleanup blocked on the second page', async () => {
        const { rows } = await pool.query<{ cleared: number; held: boolean }>(
          `SELECT count(*) FILTER (WHERE body IS NULL)::int AS cleared,
                  bool_or(revision_id=$3 AND body IS NOT NULL) AS held
           FROM content.revision WHERE route=$1 AND post_id=$2`,
          [contentRoute, created.post, locked],
        );
        return rows[0]!.cleared >= 100 && rows[0]!.held === true;
      });
      running.handle.kill();
      expect(await running.child.exited).not.toBeNull();
      running = undefined;
      await holder.query('ROLLBACK');
      running = await startWorker(executorId);
      await until('cleanup resumed', async () => (await uncleared(contentRoute, created.post)) === 0);
      expect(await revisionCount(contentRoute, created.post)).toBe(150);
      expect(await uncleared(contentRoute, created.post)).toBe(0);
      expect(await uncleared(contentRoute, created.neighbour)).toBe(1);
      const stored = await fingerprint(contentRoute, created.post);
      await running.handle.stop();
      running = undefined;
      const original = (await eraseEvent(partitionOf(contentRoute), created.post))[0]!;
      const duplicateId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const advanced = await client.query<{ epoch: number; position: string }>(
          'UPDATE core.partition SET position = position + 1 WHERE partition_no=$1 RETURNING epoch, position::text',
          [partitionOf(contentRoute)],
        );
        const position = advanced.rows[0]!.position;
        const epoch = advanced.rows[0]!.epoch;
        await client.query(
          `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
           SELECT partition_no, $2::bigint, 0, 1, $3::integer, $4::uuid, type, subject, data
           FROM core.outbox WHERE partition_no=$1 AND id=$5`,
          [partitionOf(contentRoute), position, epoch, duplicateId, original.id],
        );
        const rewind = BigInt(original.position) - 1n;
        await client.query(
          `UPDATE core.consumer_checkpoint
           SET position=$3::bigint, epoch=CASE WHEN $3::bigint = 0 THEN NULL ELSE epoch END
           WHERE partition_no=$1 AND consumer=$2`,
          [partitionOf(contentRoute), EFFECTS_CONSUMER, rewind.toString()],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      running = await startWorker(executorId);
      await until('replayed erase events', async () => {
        const checkpoint = await pool.query<{ position: string }>(
          'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
          [partitionOf(contentRoute), EFFECTS_CONSUMER],
        );
        const head = await pool.query<{ position: string }>(
          'SELECT position::text FROM core.partition WHERE partition_no=$1',
          [partitionOf(contentRoute)],
        );
        if (checkpoint.rows[0]?.position !== head.rows[0]?.position) return false;
        const inflight = await pool.query(
          `SELECT 1
           FROM dbos.workflow_status ws
           LEFT JOIN dbos.workflow_input wi ON wi.workflow_uuid = ws.workflow_uuid
           WHERE ws.status IN ('PENDING','ENQUEUED')
             AND (COALESCE(wi.inputs,'') LIKE $1 OR COALESCE(ws.inputs::text,'') LIKE $1)
           LIMIT 1`,
          [`%${created.post}%`],
        );
        return inflight.rows.length === 0 && (await governanceSucceeded(created.post)) > 0;
      });
      expect(await fingerprint(contentRoute, created.post)).toEqual(stored);
      expect(await uncleared(contentRoute, created.neighbour)).toBe(1);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        /* The stall transaction is already closed after the restart. */
      }
      holder.release();
      if (running) await running.handle.stop().catch(() => running?.handle.kill());
    }
  });
}
