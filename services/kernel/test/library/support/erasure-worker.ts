import type { WorkClient } from '../../../src/work/client.ts';
import { workerTestEnv } from '../../support/worker-env.ts';

/** The fixture owns this child and its two pipes, never the Auth executor. */
export async function startErasureWorker(url: string, client: WorkClient) {
  let output = '';
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const worker = Bun.spawn([process.execPath, new URL('../../../src/worker.ts', import.meta.url).pathname], {
    env: workerTestEnv({
      ...process.env,
      DATABASE_URL: url,
      STRIPE_SECRET_KEY: 'sk_test_library_erasure',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-4096);
      if (output.includes('Worker ready')) ready();
    }
  };
  const reading = Promise.all([read(worker.stdout), read(worker.stderr)]);
  try {
    await Promise.race([
      readiness,
      worker.exited.then(async (code) => {
        await reading;
        throw new Error(`Default worker exited ${code}: ${output}`);
      }),
    ]);
    for (const queue of await client.listQueues()) await queue.setMinPollingIntervalMs(5);
  } catch (error) {
    worker.kill('SIGKILL');
    await worker.exited;
    await reading;
    throw error;
  }
  return {
    get output() {
      return output;
    },
    async close() {
      // Pending erasure coordinators are deliberate long-running workflows. The
      // production graceful drain waits for them; fixture teardown owns no such
      // service lifetime. Reap only this spawned child after recording assertions.
      worker.kill('SIGKILL');
      await worker.exited;
      await reading;
    },
  };
}

// The same real Auth provisioning and governance path as the terminal participant
// fixture, shared by owned-graph and native command growth cases.
export async function createOwnedErasureFixture() {
  const { bundledRelease } = await import('@rezics/definitions/bundled');
  const { createWriteRateLimiter } = await import('../../../src/access/write-rate.ts');
  const { bootstrapRelease, GLOBAL_CONTEXT } = await import('../../../src/semantic/definitions.ts');
  const { createWorkClient } = await import('../../../src/work/client.ts');
  const { bindExecutionContract } = await import('../../../src/command/execution-contract.ts');
  const { historyExecutionPort } = await import('../../../src/history/operational-work.ts');
  const { workExecutionPort } = await import('../../../src/work/selected-runtime.ts');
  const { nativeFixture } = await import('../../access/native-account-bindings-fixture.ts');
  const { openGrowthDatabase } = await import('../../support/growth.ts');
  const { createPersonas } = await import('../../support/personas.ts');
  const { testKernel } = await import('../../support/test-kernel.ts');
  const db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const auth = await nativeFixture(db.pool);
  const service = auth.host.service;
  const kernel = testKernel({
    pool: db.pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'library-owned-native-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  const options = { version: 1 as const, pool: db.pool, auth };
  const people = await createPersonas(kernel, options);
  type Persona = typeof people.alice;
  async function request(as: Persona | null, method: string, path: string, body?: unknown) {
    return kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(as ? { authorization: `Bearer ${as.bearer}` } : {}),
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function json(as: Persona | null, method: string, path: string, status: number, body?: unknown) {
    const response = await request(as, method, path, body);
    const value = await response.json();
    if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  for (const group of ['collections', 'personal_library', 'reading_progress'])
    await json(people.staff, 'POST', `/v1/platform/exposure/${group}:open`, 200);
  await json(people.staff, 'POST', '/v1/grants', 201, {
    resource: { route: 0, id: GLOBAL_CONTEXT },
    subject: { kind: 'account', id: people.staff.accountId },
    actions: ['subject:create'],
    valid: '(,)',
  });
  async function subject() {
    return (
      await json(people.staff, 'POST', '/v1/subjects', 201, {
        type: 'schema:Book',
        labels: { en: 'Native owned erasure' },
      })
    ).subject.id as string;
  }
  const client = bindExecutionContract(await createWorkClient(db.url), workExecutionPort(), historyExecutionPort);
  let worker: Awaited<ReturnType<typeof startErasureWorker>> | undefined;
  return {
    db,
    auth,
    kernel,
    options,
    people,
    client,
    request,
    json,
    subject,
    async start() {
      worker = await startErasureWorker(db.url, client);
    },
    async close() {
      await worker?.close();
      await client.close();
      await auth.close();
      await db.close();
    },
  };
}
