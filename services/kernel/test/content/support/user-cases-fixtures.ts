import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import type { Persona } from '../../../../../specs/content-user-cases-driver.ts';
import { accountDeletionRuntime } from '../../support/account-deletion.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './native-system.ts';

export const audience = 'https://content.test';
export const highRates = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});

export async function openUserCasesSystem(): Promise<NativeContentSystem> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  return createNativeContentSystemWithWriteRateOverrides({ databaseUrl }, highRates);
}

export async function governance(system: NativeContentSystem): Promise<Persona> {
  const found = await system.database.pool.query<{ id: string }>(
    'SELECT account_id::text AS id FROM access.governance_bootstrap',
  );
  const id = found.rows[0]?.id;
  if (!id) throw new Error('Native governance account is missing');
  const credential = await system.auth.issue({
    accountId: id,
    clientId: system.auth.ordinaryClient.id,
    scopes: [...system.actions.keys()].filter((action) => action !== 'media:complete').sort(),
  });
  return { id, bearer: credential.bearer };
}

/** Reuse the native fixture's registration port; every voter has a separate controller. */
export async function person(system: NativeContentSystem): Promise<Persona> {
  const { accountId, bearer } = await accountDeletionRuntime(system).person();
  return { id: accountId, bearer };
}

/** The ordinary production executor runs in a separate process from Auth's DBOS runtime. */
export async function startUserCasesWorker(system: NativeContentSystem, prefix: string) {
  const temporaryRoot = resolve(import.meta.dir, '../../../../../.temp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(`${temporaryRoot}/content-user-cases-`);
  const key = `${directory}/key.pem`;
  const certificate = `${directory}/certificate.pem`;
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { encoding: 'utf8' },
  );
  if (generated.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Could not generate consent certificate: ${generated.stderr}`);
  }
  const consentReader = createCurrentConsentReader({ database: system.database.authPool });
  const tokenId = 'content-user-cases';
  const tokenSecret = crypto.randomUUID();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        new URL(request.url).pathname !== '/internal/v1/consents:read' ||
        request.headers.get('CF-Access-Client-Id') !== tokenId ||
        request.headers.get('CF-Access-Client-Secret') !== tokenSecret
      )
        return new Response(null, { status: 403 });
      const input = (await request.json()) as { actorAccountId: string; clientId: string };
      const consent = await consentReader.readCurrentConsent(input);
      return consent === null
        ? new Response(null, { status: 403 })
        : Response.json({ ...input, scopes: consent.scopes });
    },
  });
  const child = Bun.spawn(['bun', 'src/worker.ts'], {
    cwd: resolve(import.meta.dir, '../../..'),
    env: workerTestEnv({
      ...process.env,
      DATABASE_URL: system.database.pool.options.connectionString,
      KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
      KERNEL_SESSION_KEYS: [...system.tokenKeys.keys]
        .map(([id, value]) => `${id}:${Buffer.from(value).toString('base64url')}`)
        .join(','),
      KERNEL_EXECUTOR_ID: `content-user-cases-${crypto.randomUUID()}`,
      KERNEL_WORKER_POOL_SIZE: '10',
      KERNEL_SEARCH_PREFIX: prefix,
      KERNEL_AUTH_CONSENT_URL: `https://localhost:${server.port}/internal/v1/consents:read`,
      CF_ACCESS_CLIENT_ID: tokenId,
      CF_ACCESS_CLIENT_SECRET: tokenSecret,
      NODE_EXTRA_CA_CERTS: certificate,
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      if (output.includes('Worker ready')) readyResolve();
    }
  };
  const diagnostics = Promise.all([pump(child.stdout), pump(child.stderr)]);
  void child.exited.then((code) => readyReject(new Error(`Worker exited ${code}: ${output}`)));
  const timeout = setTimeout(() => readyReject(new Error(`Worker readiness timed out: ${output}`)), 60_000);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await child.exited;
      await diagnostics;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    })());
  try {
    await ready;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return { stop, diagnostics: () => output, child };
}

/** Observe executor/checkpoint quiescence, without constructing or inspecting any product result. */
export async function settleUserCasesWorker(
  system: NativeContentSystem,
  worker: Awaited<ReturnType<typeof startUserCasesWorker>>,
  prefix: string,
): Promise<void> {
  const work = await createWorkClient(system.database.pool.options.connectionString!, system.database.pool);
  const deadline = Date.now() + 90_000;
  try {
    for (;;) {
      if (worker.child.exitCode !== null || /Relay .* (?:stopped|failed)/.test(worker.diagnostics()))
        throw new Error(`Production worker failed: ${worker.diagnostics()}`);
      const workflows = (await work.listWorkflows({ limit: 10_000 })).filter(
        (row) => row.status !== 'SUCCESS' && row.status !== 'DELAYED',
      );
      const failed = workflows.filter((row) =>
        ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row.status),
      );
      if (failed.length)
        throw new Error(`Production workflows failed: ${JSON.stringify(failed)}\n${worker.diagnostics()}`);
      const behind = await system.database.pool.query(
        `
        SELECT 1 FROM core.partition p
        CROSS JOIN unnest($1::text[]) AS consumer(name)
        LEFT JOIN core.consumer_checkpoint c ON c.partition_no=p.partition_no AND c.consumer=consumer.name
        WHERE p.position > COALESCE(c.position, 0) LIMIT 1`,
        [['effects', 'semantic_links', `search_${prefix.replaceAll('-', '_')}subjects_g1`]],
      );
      if (!behind.rowCount && workflows.length === 0) return;
      if (Date.now() >= deadline)
        throw new Error(`Worker did not settle: ${JSON.stringify(workflows)}\n${worker.diagnostics()}`);
    }
  } finally {
    await work.close();
  }
}
