import { AsyncLocalStorage } from 'node:async_hooks';
import type { Access, AccessConfig } from '../../../../services/kernel/src/request/access.ts';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { resolveBunCommand } from '../../../../scripts/gate.ts';
import type { SemanticOutcomeDriver } from '../../../../services/kernel/test/semantic/outcome-driver.ts';
import {
  currentNativeLifecycle,
  inspectNativeProcess,
  nativeProcessIsSame,
  settledWithin,
  NativeTestLifecycle,
  type NativeProcessIdentity,
  type NativeProcessOwnership,
} from './lifecycle.ts';
import { createCommerceWork } from '../../../../services/kernel/src/commerce/enqueue.ts';
import { readCommerceConfig } from '../../../../services/kernel/src/commerce/config.ts';
import { createStripePort } from '../../../../services/kernel/src/commerce/stripe.ts';
import { createWorkClient, type WorkClient } from '../../../../services/kernel/src/work/client.ts';
import type { OpenSearch } from '../../../../services/kernel/src/search/opensearch.ts';

export type NativeCredentials = { authorization: string; cookie?: string };
export type NativeKernelRequest = {
  method: string;
  url: string;
  authorization: string | null;
  idempotencyKey: string | null;
  ifMatch: string | null;
  session: string | null;
  body?: string;
  responseStatus?: number;
  /** Direct fixture API traffic is excluded from browser/BFF transport observations. */
  fixtureRequest?: boolean;
  failure?: { status: number; body: string };
  authorizationDecision?: { status: number; body: string };
  /** Observed at the installed production Access methods, never inferred from HTTP success. */
  access?: { actorId: string | null; authenticated: boolean; authorized: boolean };
};
export type NativeKernelFailureInjection = {
  method: string;
  path: string;
  status: number;
  body: string;
};
export type NativeAccountOperationActor = {
  accountId: string;
  scopes: readonly string[];
};
export type NativeWebStackOptions = {
  /** Observe actual Access results for the frozen personal boundary contract. */
  observePersonalAccess?: boolean;
  /** Restrict test-only native write-rate changes to an explicitly configured fixture stack. */
  writeRateOverrides?: string;
  /** Enable the production Commerce composition against an owned Stripe API fixture. */
  commerce?: {
    apiHost: string;
    webhookSecret: string;
    successUrl: string;
    cancelUrl: string;
  };
  /** Browser-visible HTTPS Auth origin for native WebAuthn ceremonies. */
  issuerOrigin?: string;
  /** Test-only certificate for the reserved HTTPS website origin. */
  webTls?: { certificate: string; key: string };
  /** Initial offset for the isolated native Auth trusted clock. */
  authClockOffsetSeconds?: number;
};
export type NativeWebStack = {
  /** Read-only observation clients must use these owned database addresses. */
  databaseUrl: string;
  authDatabaseUrl: string;
  kernelOrigin: string;
  authIssuer: string;
  /** The canonical issuer advertised by discovery, before the optional proxy listener. */
  issuerOrigin: string;
  web: string;
  /** Read fixture identity for form entry, without creating a website session. */
  authPersona(persona: string): Promise<{ accountId: string; email: string; authorization: string }>;
  /** Confirm the production Auth host has its native operation boundary configured. */
  enableAccountOperations(): Promise<void>;
  /** Read real Auth /session proofs observed on account-operation requests. */
  accountOperationActors(): Promise<readonly NativeAccountOperationActor[]>;
  /** This fixture's separate automated workflow needs a native approval fixture port. */
  createAutomatedActor(operator: string, handle: string, authCookie: string): Promise<{ accountId: string }>;
  /** Flushes browser/Auth request observations into this receipt. */
  flushObservations(): Promise<void>;
  /** Install the Auth page app on the issuer; undefined removes the page routing. */
  routeAuthPages(handler?: (request: Request) => Response | Promise<Response>): Promise<string>;
  kernel(path: string, init?: RequestInit, persona?: string): Promise<Response>;
  request(url: string, persona?: string, headers?: Record<string, string>): Promise<Response>;
  credentials(persona: string): Promise<NativeCredentials>;
  advanceAuthClock(seconds: number): Promise<void>;
  /** Flushes kernel requests made by the production Worker into this observer. */
  refreshKernelRequests(): Promise<void>;
  kernelRequests(): readonly NativeKernelRequest[];
  /** Flush requests made by a browser page into the parent test process. */
  syncKernelRequests(): Promise<void>;
  /** Inject a single native HTTP failure at the owned Worker-to-kernel boundary. */
  injectKernelFailureOnce(failure: NativeKernelFailureInjection): Promise<void>;
  /** Fail the first ordinary read of the next successfully created subject. */
  injectCreatedSubjectReadFailureOnce(failure: { status: number; body: string }): Promise<void>;
  webOutput(): string;
  flushKernelRequests(): Promise<void>;
  workerLogs(): Promise<string>;
  peakMemoryBytes(): number;
  restartWeb(options: { publicOrigin: string; authIssuer?: string }): Promise<void>;
  stop(): Promise<void>;
};

type WebProcess = {
  child: ChildProcess;
  identity: NativeProcessIdentity;
  stateDirectory: string;
  exited: Promise<void>;
  output(): string;
};

const webRoot = resolve(import.meta.dir, '../..');
const repositoryRoot = resolve(webRoot, '../..');
const nativeWebsiteHost = 'web.native.rezics.com';
const nativeAuthTestIssuer = process.env.NATIVE_AUTH_TEST_ISSUER;

function fetchNativeWebsite(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== nativeWebsiteHost) return fetch(input, init);
  if (init?.body !== undefined)
    return Promise.reject(new Error('Native website TLS fetch only accepts bodyless requests'));
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    headers.host = url.host;
    const target = new URL(url);
    target.hostname = '127.0.0.1';
    const request = httpsRequest(
      target,
      { method: init?.method ?? 'GET', headers, rejectUnauthorized: false, servername: nativeWebsiteHost },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (name === 'set-cookie' && Array.isArray(value)) {
              for (const cookie of value) responseHeaders.append(name, cookie);
            } else responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 502,
              statusText: response.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    if (init?.signal) {
      if (init.signal.aborted) request.destroy(init.signal.reason);
      else init.signal.addEventListener('abort', () => request.destroy(init.signal!.reason), { once: true });
    }
    request.end();
  });
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port;
  server.stop(true);
  return port;
}

async function startWeb(
  origin: string,
  kernelOrigin: string,
  publicOrigin: string,
  authEnvironment: NodeJS.ProcessEnv,
  stateDirectory: string,
  onOwnedGroup: (child: ChildProcess, stateDirectory: string) => void,
): Promise<WebProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...authEnvironment,
    KERNEL_ORIGIN: kernelOrigin,
    PUBLIC_ORIGIN: publicOrigin,
    REZICS_TEST_RUNTIME: '1',
    WEB_TEST_STATE_DIR: stateDirectory,
    WEB_TEST_STATE_INSTANCE_DIR: stateDirectory,
    WEB_DEV_ALLOW_ANY_HOST: '1',
    WRANGLER_SEND_METRICS: 'false',
  };
  const child = spawn(
    process.execPath,
    ['run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'],
    {
      cwd: webRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  onOwnedGroup(child, stateDirectory);
  const identity = child.pid ? inspectNativeProcess(child.pid) : undefined;
  if (!identity || identity.pgid !== identity.pid)
    throw new Error('Native web Worker did not start in an owned process group');
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
    });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  let ended = false;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()).once('error', () => resolve()));
  const failIfExited = () => {
    if (spawnError)
      throw new Error(`web Worker could not start: ${spawnError.message}\n${output}`, { cause: spawnError });
    if (ended || child.exitCode !== null || child.signalCode !== null)
      throw new Error(`web Worker exited during startup: ${output}`);
  };
  child.once('close', () => {
    ended = true;
  });
  const deadline = Date.now() + 150_000;
  try {
    while (Date.now() < deadline) {
      failIfExited();
      try {
        const response = await fetchNativeWebsite(`${origin}/en/subjects/00000000-0000-4000-8000-000000000000`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        await response.arrayBuffer();
        failIfExited();
        if (response.status === 404)
          return {
            child,
            identity,
            stateDirectory,
            exited,
            output: () => output,
          };
      } catch {
        if (spawnError || ended || child.exitCode !== null || child.signalCode !== null) failIfExited();
      }
      await Bun.sleep(250);
    }
    throw new Error(`web Worker startup timed out: ${output}`);
  } catch (error) {
    await stopWeb({
      child,
      identity,
      stateDirectory,
      exited,
      output: () => output,
    }).catch(() => {});
    throw error;
  }
}

async function stopWeb(web: WebProcess | undefined): Promise<void> {
  if (!web) return;
  const { child, identity, exited } = web;
  const processGroup = child.pid;
  const groupExists = () => {
    if (!processGroup) return false;
    try {
      process.kill(-processGroup, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const leaderAlive = () => nativeProcessIsSame(identity);
  const waitForGroup = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (groupExists()) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(50);
    }
    return (
      (await settledWithin(
        exited.then(() => true),
        1_000,
      )) === true
    );
  };
  if (groupExists() && leaderAlive()) {
    try {
      process.kill(-processGroup!, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (!(await waitForGroup(10_000))) {
      if (leaderAlive()) {
        try {
          process.kill(-processGroup!, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForGroup(2_000);
      }
      throw new Error('web Worker did not stop gracefully');
    }
  }
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = [error.stack ?? error.message];
  if (error.cause) details.push(errorDetails(error.cause));
  if (error instanceof AggregateError) details.push(...error.errors.map(errorDetails));
  return details.join('\n');
}

async function startDurableWorker(
  environment: NodeJS.ProcessEnv,
): Promise<{ pid?: number; logs(): string; stop(): Promise<void> }> {
  const child = spawn(
    process.execPath,
    [
      '--preload',
      'reylo/register',
      '--preload',
      resolve(webRoot, 'tests/native/native-media-storage-fetch.ts'),
      '--preload',
      './test/support/fixture-event-types.ts',
      'src/worker.ts',
    ],
    {
      cwd: resolve(repositoryRoot, 'services/kernel'),
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let started!: () => void;
  let failed!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    started = resolve;
    failed = reject;
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
      if (output.includes('Worker ready')) started();
    });
  child.once('error', failed);
  child.once('exit', (code, signal) => failed(new Error(`Durable worker exited ${code ?? signal}: ${output}`)));
  const timer = setTimeout(() => failed(new Error(`Durable worker startup timed out: ${output}`)), 120_000);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      // Durable workflows can remain asleep beyond the lifetime of a fixture.
      // Give production shutdown a grace period, then terminate only our worker
      // before dropping its database; never wait for scheduled work to wake up.
      try {
        const graceful = await settledWithin(
          exited.then(() => true),
          10_000,
        );
        if (graceful) return;
        child.kill('SIGKILL');
        const killed = await settledWithin(
          exited.then(() => true),
          2_000,
        );
        if (!killed) throw new Error('Native durable Worker did not exit after SIGKILL');
      } finally {
        // The exit event is the ownership boundary; inherited diagnostic pipes
        // may close later if a child forgot to release them.
      }
    })());
  try {
    await ready;
    return { pid: child.pid, logs: () => output, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function startStack(): Promise<
  Omit<NativeWebStack, 'kernel' | 'request' | 'routeAuthPages'> & {
    routeAuthPages(origin?: string): Promise<string>;
  }
> {
  let kernelServer: ReturnType<typeof Bun.serve> | undefined;
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  const activeKernelRequests = new Set<Promise<Response>>();
  const injectedKernelFailures: NativeKernelFailureInjection[] = [];
  const createdSubjectReadFailures = new Map<string, { status: number; body: string }>();
  let pendingCreatedSubjectReadFailure: { status: number; body: string } | undefined;
  let durableWorker: { pid?: number; logs(): string; stop(): Promise<void> } | undefined;
  let webProcess: WebProcess | undefined;
  let driver: SemanticOutcomeDriver | undefined;
  let postgresContainer: string | undefined;
  let runtimeDirectory: string | undefined;
  let consentServer: { env: Record<string, string>; close(): Promise<void> } | undefined;
  let closeAuth: (() => Promise<void>) | undefined;
  let closePageWorkflows: (() => Promise<void>) | undefined;
  let commerceWorkClient: Promise<WorkClient> | undefined;
  let search: OpenSearch | undefined;
  const searchPrefix = `native-web-${randomBytes(12).toString('hex')}-`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let stopped: Promise<void> | undefined;
  let peakMemory = process.memoryUsage().rss;
  const testIssuer = nativeAuthTestIssuer;
  const testWebsiteHost = process.env.NATIVE_WEB_TEST_HOST || undefined;
  const testWebsiteCertificate = process.env.NATIVE_WEB_TEST_TLS_CERT || undefined;
  const testWebsiteKey = process.env.NATIVE_WEB_TEST_TLS_KEY || undefined;
  const testWebsiteTls = Boolean(testWebsiteHost || testWebsiteCertificate || testWebsiteKey);
  if (
    testWebsiteTls &&
    (!testIssuer || testWebsiteHost !== nativeWebsiteHost || !testWebsiteCertificate || !testWebsiteKey)
  )
    throw new Error('Native website TLS requires the reserved host and the Auth test issuer');
  const sampleMemory = () => {
    let bytes = process.memoryUsage().rss;
    if (webProcess?.child.pid) {
      const result = Bun.spawnSync(['ps', '-o', 'rss=', '-g', String(webProcess.child.pid)]);
      if (result.exitCode === 0) {
        const residentKilobytes = result.stdout.toString().trim().split(/\s+/).map(Number).filter(Number.isFinite);
        bytes += residentKilobytes.reduce((sum, value) => sum + value, 0) * 1024;
      }
    }
    if (durableWorker?.pid) {
      const result = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(durableWorker.pid)]);
      if (result.exitCode === 0) bytes += Number(result.stdout.toString().trim()) * 1024;
    }
    peakMemory = Math.max(peakMemory, bytes);
  };
  const memorySampler = setInterval(sampleMemory, 250);
  const accounts = new Map<string, Promise<{ accountId: string; bearer: string }>>();
  let governorScopes: readonly string[] | undefined;
  const requests: NativeKernelRequest[] = [];
  const accountOperationActors: NativeAccountOperationActor[] = [];
  const getAccount = (persona: string) => {
    let account = accounts.get(persona);
    if (!account) {
      account =
        persona === 'governor'
          ? governorScopes
            ? driver!.fixtures.person(persona, { scopes: governorScopes })
            : Promise.reject(new Error('Native governance credentials are not initialized'))
          : driver!.fixtures.person(persona);
      accounts.set(persona, account);
    }
    return account;
  };
  const stop = () =>
    (stopped ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (close: () => unknown | Promise<unknown>) => {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      };
      clearInterval(memorySampler);
      console.info('Native web stack cleanup: stopping listeners and durable worker');
      await Promise.all([
        attempt(() => stopWeb(webProcess)),
        attempt(() => authServer?.stop(true)),
        attempt(async () => {
          // Match the production HTTP host: drain handlers before closing the
          // pools they use, including requests whose clients disconnected.
          await kernelServer?.stop(false);
          await Promise.allSettled([...activeKernelRequests]);
          console.info('Native web stack cleanup: kernel HTTP handlers drained');
        }),
        attempt(() => durableWorker?.stop()),
      ]);
      await attempt(() => consentServer?.close());
      consentServer = undefined;
      if (commerceWorkClient)
        await attempt(async () => {
          await (await commerceWorkClient!).close();
        });
      webProcess = undefined;
      kernelServer = undefined;
      durableWorker = undefined;
      if (search) {
        // Both the HTTP service and the default worker are now drained. Resolve
        // only this stack's namespace, and delete explicit physical index names.
        await attempt(async () => {
          const { body } = await search!.request<{ indices: { name: string }[] }>(
            'GET',
            `/_resolve/index/${searchPrefix}*`,
            undefined,
            { query: { expand_wildcards: 'all' } },
          );
          for (const { name } of body.indices) {
            await attempt(async () => {
              if (!name.startsWith(searchPrefix)) throw new Error('Index escaped native stack prefix');
              await search!.request('DELETE', `/${encodeURIComponent(name)}`);
            });
          }
        });
        const { OpenSearchError } = await import('../../../../services/kernel/src/search/opensearch.ts');
        const { SEARCH_TEMPLATE, HIT_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } =
          await import('../../../../services/kernel/src/search/query.ts');
        for (const name of [SEARCH_TEMPLATE, HIT_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
          await attempt(async () => {
            try {
              await search!.request('DELETE', `/_scripts/${searchPrefix}${name}`);
            } catch (error) {
              if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
            }
          });
        }
      }
      // Auth holds the harness's kernel Access and registration ports. Drain it
      // while those ports and their pool still exist, then release the kernel.
      console.info('Native web stack cleanup: closing Auth fixture');
      await attempt(() => closePageWorkflows?.());
      await attempt(() => closeAuth?.());
      console.info('Native web stack cleanup: closing kernel fixture');
      await attempt(() => driver?.close());
      console.info('Native web stack cleanup: kernel fixture closed');
      if (runtimeDirectory) await attempt(() => rm(runtimeDirectory!, { recursive: true, force: true }));
      if (postgresContainer) {
        console.info('Native web stack cleanup: removing owned PostgreSQL container');
        const removed = Bun.spawnSync(['docker', 'rm', '-fv', postgresContainer]);
        if (removed.exitCode !== 0)
          errors.push(new Error(`Could not remove owned PostgreSQL container: ${removed.stderr.toString()}`));
        postgresContainer = undefined;
      }
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (errors.length) throw new AggregateError(errors, 'Native web stack cleanup failed');
      console.info('Native web stack cleanup: complete');
    })());
  try {
    reportStackProgress('Native web stack startup: registering kernel SQL modules');
    // Match the kernel test preload before evaluating anything that imports SQL.
    await import(new URL('../../../../services/kernel/node_modules/reylo/src/register.js', import.meta.url).href);
    reportStackProgress('Native web stack startup: kernel SQL modules registered');
    if (!process.env.DATABASE_URL) {
      reportStackProgress('Native web stack startup: starting PostgreSQL');
      const { startPostgresContainer } = await import('../../../../services/kernel/scripts/check.ts');
      const { migrate } = await import('../../../../services/kernel/scripts/database.ts');
      postgresContainer = startPostgresContainer();
      if (process.env.NATIVE_WEB_STACK_HOST === '1') process.send?.({ postgresContainer } satisfies HostReply);
      const portResult = Bun.spawnSync(['docker', 'port', postgresContainer, '5432/tcp']);
      if (portResult.exitCode !== 0)
        throw new Error(`Could not get owned PostgreSQL port: ${portResult.stderr.toString()}`);
      const port = Number(portResult.stdout.toString().match(/127\.0\.0\.1:(\d+)/)?.[1]);
      if (!Number.isInteger(port) || port <= 0)
        throw new Error(`Could not parse owned PostgreSQL port: ${portResult.stdout.toString()}`);
      const databaseUrl = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
      const deadline = Date.now() + 60_000;
      while (true) {
        const probe = new Pool({
          connectionString: databaseUrl,
          connectionTimeoutMillis: 1500,
          max: 1,
        });
        try {
          await probe.query('SELECT 1');
          break;
        } catch (error) {
          if (Date.now() >= deadline)
            throw new Error('Disposable PostgreSQL did not become ready.', {
              cause: error,
            });
          await Bun.sleep(500);
        } finally {
          await probe.end();
        }
      }
      process.env.DATABASE_URL = databaseUrl;
      reportStackProgress('Native web stack startup: PostgreSQL ready; migrating database');
      migrate(databaseUrl);
      reportStackProgress('Native web stack startup: PostgreSQL migration complete');
    }
    reportStackProgress('Native web stack startup: preparing SQL analysis');
    // Give Reylo an owned cache and the migrated template for SQL analysis.
    runtimeDirectory = await mkdtemp(join(tmpdir(), 'native-kernel-runtime-'));
    const { writeReyloProject } = await import('../../../../services/kernel/scripts/check.ts');
    // PostgreSQL cannot clone a template while Reylo is connected to it. The
    // kernel runner also gives SQL analysis its own copy, separate from fixtures.
    const source = new URL(process.env.DATABASE_URL!);
    const template = decodeURIComponent(source.pathname.slice(1));
    const analysisDatabase = `native_web_analysis_${randomBytes(16).toString('hex')}`;
    const adminUrl = new URL(source);
    adminUrl.pathname = '/postgres';
    const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
    try {
      // Inform the supervisor before allocation, so even failed setup is cleaned.
      process.send?.({ analysisDatabase } satisfies HostReply);
      await admin.query(`CREATE DATABASE "${analysisDatabase}" TEMPLATE "${template.replaceAll('"', '""')}"`);
    } finally {
      await admin.end();
    }
    reportStackProgress('Native web stack startup: SQL analysis database cloned');
    source.pathname = `/${analysisDatabase}`;
    process.env.REYLO_CONFIG = writeReyloProject(runtimeDirectory, source.href);
    process.env.KERNEL_POOL_ACQUIRE_TIMEOUT_MS ??= '2000';
    await import('../../../../services/kernel/test/support/fixture-event-types.ts');
    const { workerTestEnv } = await import('../../../../services/kernel/test/support/worker-env.ts');
    const { sharedAuth, closeOwnedSemanticAuth, advanceNativeAuthClock } =
      await import('../../../../services/kernel/test/semantic/outcome-auth.ts');
    closeAuth = closeOwnedSemanticAuth;
    const auth = await sharedAuth(new URL(process.env.DATABASE_URL!), undefined, true);
    reportStackProgress('Native web stack startup: semantic Auth initialized');
    // Observe the harness's actual issuance, retaining its Auth cookie for the
    // website code flow. Never copy fixture passwords or manufacture sessions.
    const authCookies = new Map<string, string>();
    // Keep the actual production host transport in this listener. In particular,
    // its account-operation routes must use the host's own configured native port.
    const authHandler = auth.host.handler.bind(auth.host);
    let pageOrigin: string | undefined;
    let signupHandler: ((request: Request) => Promise<Response>) | undefined;
    const pagePaths = new Set([
      '/login',
      '/signup',
      '/consent',
      '/recovery',
      '/security',
      '/step-up',
      '/account/delete',
      '/organizations/new',
    ]);
    auth.service.handler = async (request) => {
      const serviceRequest = testIssuer
        ? new Request(new URL(new URL(request.url).pathname + new URL(request.url).search, testIssuer), request)
        : request;
      const url = new URL(serviceRequest.url);
      if (testIssuer && serviceRequest.method === 'GET' && url.pathname === '/__native-turnstile.js')
        return new Response(
          `window.turnstile={ready:function(callback){callback()},render:function(node,options){queueMicrotask(function(){options.callback('native-test-token')});return 'native-widget'},reset:function(){},remove:function(){}};`,
          { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } },
        );
      // The development app serves its source modules at Vite's standard paths.
      // Production bundles instead use only /auth-assets/.
      const asset =
        ['/auth-assets/', '/@vite/', '/@id/', '/@fs/', '/src/', '/node_modules/', '/_serverFn/'].some((prefix) =>
          url.pathname.startsWith(prefix),
        ) || url.pathname === '/@react-refresh';
      if (pageOrigin && ((['GET', 'HEAD'].includes(serviceRequest.method) && pagePaths.has(url.pathname)) || asset)) {
        const target = new URL(url.pathname + url.search, pageOrigin);
        const forwarded = new Request(target, serviceRequest);
        forwarded.headers.set('x-native-auth-url', serviceRequest.url);
        return fetch(forwarded, { redirect: 'manual' });
      }
      if (pageOrigin && serviceRequest.method === 'POST' && url.pathname === '/signup')
        return signupHandler!(serviceRequest);
      if (
        serviceRequest.method === 'POST' &&
        ['/account-operations/approve', '/account-operations/execute'].includes(url.pathname)
      ) {
        const cookie = serviceRequest.headers.get('cookie');
        if (cookie) {
          const session = await authHandler(
            new Request(`${auth.issuer}/session`, {
              headers: { cookie },
              redirect: 'manual',
            }),
          );
          if (session.ok) {
            const proof = (await session.json()) as {
              account_id?: unknown;
              scope?: unknown;
            };
            if (typeof proof.account_id === 'string' && Array.isArray(proof.scope)) {
              accountOperationActors.push({
                accountId: proof.account_id,
                scopes: proof.scope.filter((scope): scope is string => typeof scope === 'string').sort(),
              });
            }
          }
        }
      }
      const response = await authHandler(serviceRequest);
      if (
        new URL(serviceRequest.url).pathname === '/token' &&
        serviceRequest.headers.get('content-type') === 'application/json' &&
        response.ok
      ) {
        const token = (await response.clone().json()) as { access_token: string };
        const cookie = serviceRequest.headers.get('cookie');
        if (cookie) authCookies.set(token.access_token, cookie);
      }
      return response;
    };
    // The semantic harness reads DATABASE_URL during module evaluation.
    const { createSemanticDriver } = await import('../../../../services/kernel/test/semantic/outcome-driver.ts');
    const { createKernel } = await import('../../../../services/kernel/src/http/kernel.ts');
    const commerce = process.env.NATIVE_WEB_COMMERCE === '1' ? readCommerceConfig(process.env) : null;
    const { readSearchConfig } = await import('../../../../services/kernel/src/search/work.ts');
    const searchConfig = readSearchConfig({ ...process.env, KERNEL_SEARCH_PREFIX: searchPrefix });
    const { createOpenSearch } = await import('../../../../services/kernel/src/search/opensearch.ts');
    const { createSearchService } = await import('../../../../services/kernel/src/search/service.ts');
    const { subjectSource } = await import('../../../../services/kernel/src/semantic/search-source.ts');
    if (searchConfig) search = createOpenSearch(searchConfig.url);
    const accessRequest = new AsyncLocalStorage<NativeKernelRequest>();
    const observeAccess = (base: Access): Access => {
      if (process.env.NATIVE_WEB_OBSERVE_PERSONAL_ACCESS !== '1') return base;
      const overrides: Partial<Access> = {};
      // Decorate the installed object, keeping all root registrations and ports.
      // A derived adapter would bypass observation of root-only read decisions.
      // No authority input, decision, clock or registration changes here.
      for (const name of [
        'authenticate',
        'prepare',
        'preparePage',
        'authorize',
        'authorizePage',
        'authorizeExplicit',
        'prepareReadDecisions',
        'replayAuthorization',
      ] as const) {
        const operation = base[name];
        if (!operation) continue;
        Object.assign(overrides, {
          [name]: (...args: unknown[]) => {
            const observed = accessRequest.getStore();
            const record = (value: unknown): unknown => {
              if (!observed) return value;
              const proof = (observed.access ??= { actorId: null, authenticated: false, authorized: false });
              if (name === 'authenticate') {
                const actor = value as { accountId: string };
                proof.actorId = actor.accountId;
                proof.authenticated = true;
              }
              if (name === 'authorize' || name === 'authorizePage') proof.authorized ||= value === true;
              if (name === 'authorizeExplicit') proof.authorized ||= (value as { allowed: boolean }).allowed;
              if (name === 'prepareReadDecisions') {
                const decisions = value as {
                  decide: (...input: unknown[]) => Promise<Record<string, { allowed: boolean }>>;
                };
                return {
                  ...decisions,
                  async decide(...input: unknown[]) {
                    const result = await decisions.decide(...input);
                    proof.authorized ||= Object.values(result).some((decision) => decision.allowed);
                    return result;
                  },
                };
              }
              return value;
            };
            const result = Reflect.apply(operation, base, args);
            return result instanceof Promise ? result.then(record) : record(result);
          },
        });
      }
      return Object.assign(base, overrides);
    };
    let kernel: ReturnType<typeof createKernel> | undefined;
    reportStackProgress('Native web stack startup: creating native kernel and Auth fixtures');
    driver = await createSemanticDriver(
      (dependencies) => {
        if (search && !dependencies.tokens) throw new Error('Native kernel did not supply session keys');
        if (commerce) {
          const databaseUrl = dependencies.pool.options.connectionString;
          if (typeof databaseUrl !== 'string') throw new Error('Native Commerce needs the owned kernel database URL');
          commerceWorkClient = createWorkClient(databaseUrl);
          void commerceWorkClient.catch(() => {});
        }
        const factory = dependencies.access;
        const observedDependencies = factory
          ? {
              ...dependencies,
              access:
                typeof factory === 'function'
                  ? (config: AccessConfig) => observeAccess(factory(config))
                  : observeAccess(factory),
            }
          : dependencies;
        kernel = createKernel({
          ...observedDependencies,
          ...(commerce
            ? {
                commerce: {
                  ...commerce,
                  stripe: createStripePort({ ...commerce.stripe, clock: () => new Date() }),
                  work: {
                    async enqueueStripeEvent(ref) {
                      await createCommerceWork(await commerceWorkClient!).enqueueStripeEvent(ref);
                    },
                  },
                },
              }
            : {}),
          ...(search === undefined || searchConfig === undefined
            ? {}
            : {
                search: createSearchService({
                  pool: dependencies.pool,
                  client: search,
                  prefix: searchConfig.prefix,
                  source: subjectSource(dependencies.pool, dependencies.routeKey),
                  cursors: dependencies.tokens!,
                }),
              }),
        });
        return kernel;
      },
      {
        linkProjection: 'external',
        strictCleanup: true,
      },
    );
    reportStackProgress('Native web stack startup: native kernel and Auth fixtures ready');

    await driver.fixtures.openFeatures(['search']);
    authServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => auth.service.handler(request),
    });
    const { createCurrentConsentReader } = await import('../../../../services/auth/src/current-consent.ts');
    const { startConsentServer } = await import('../../../../services/kernel/test/community/membership-fixture.ts');
    const consentReader = createCurrentConsentReader({
      database: auth.database,
    });
    consentServer = await startConsentServer(
      async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null,
      join(repositoryRoot, '.temp'),
    );

    const webPort = await freePort();
    const webOrigin = testWebsiteTls ? `https://${nativeWebsiteHost}:${webPort}` : `http://127.0.0.1:${webPort}`;
    const nativeMediaStorageToken = randomBytes(32).toString('base64url');
    const testWriteRateOverrides = process.env.NATIVE_WEB_STACK_WRITE_RATE_OVERRIDES;
    const workerEnv = {
      ...workerTestEnv({
        ...consentServer.env,
        AUTH_ISSUER: driver.fixtures.runtime.authIssuer,
        AUTH_AUDIENCE: driver.fixtures.runtime.authAudience,
        AUTH_JWKS_URL: driver.fixtures.runtime.authJwksUrl,
        KERNEL_ROUTE_KEY: driver.fixtures.runtime.routeKey,
        KERNEL_SESSION_KEYS: driver.fixtures.runtime.sessionKeys,
        NATIVE_MEDIA_STORAGE_ORIGIN: webOrigin,
        NATIVE_MEDIA_STORAGE_TOKEN: nativeMediaStorageToken,
        ...(testWriteRateOverrides ? { KERNEL_WRITE_RATE_OVERRIDES: testWriteRateOverrides } : {}),
        OPENSEARCH_URL: searchConfig?.url,
        KERNEL_SEARCH_PREFIX: searchPrefix,
      }),
      DATABASE_URL: driver.fixtures.runtime.databaseUrl,
      KERNEL_EXECUTOR_ID: `native-web-${randomBytes(8).toString('hex')}`,
    };
    reportStackProgress('Native web stack startup: starting durable-work worker');
    durableWorker = await startDurableWorker(workerEnv);
    reportStackProgress('Native web stack startup: durable-work worker ready');

    const sourceApp = kernel!;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const observed: NativeKernelRequest = {
          method: request.method,
          url: `${url.pathname}${url.search}`,
          authorization: request.headers.get('authorization'),
          idempotencyKey: request.headers.get('idempotency-key'),
          ifMatch: request.headers.get('if-match'),
          session: request.headers.get('rezics-session-token'),
          fixtureRequest: request.headers.get('x-native-fixture-request') === '1',
          ...(request.method === 'POST' &&
          (['/v1/copies', '/v1/subjects'].includes(url.pathname) ||
            /^\/v1\/subjects\/[^/]+\/candidates$/u.test(url.pathname))
            ? { body: await request.clone().text() }
            : request.method === 'PATCH'
              ? { body: await request.clone().text() }
              : {}),
        };
        requests.push(observed);
        const createdReadFailure = request.method === 'GET' ? createdSubjectReadFailures.get(url.pathname) : undefined;
        if (createdReadFailure) {
          createdSubjectReadFailures.delete(url.pathname);
          observed.responseStatus = createdReadFailure.status;
          observed.failure = createdReadFailure;
          return new Response(createdReadFailure.body, {
            status: createdReadFailure.status,
            headers: { 'content-type': 'application/problem+json' },
          });
        }
        const failureIndex = injectedKernelFailures.findIndex(
          (failure) =>
            failure.method === request.method &&
            (failure.path.endsWith('*')
              ? url.pathname.startsWith(failure.path.slice(0, -1))
              : failure.path === url.pathname),
        );
        if (failureIndex >= 0) {
          const [failure] = injectedKernelFailures.splice(failureIndex, 1);
          observed.responseStatus = failure!.status;
          observed.failure = { status: failure!.status, body: failure!.body };
          return new Response(failure!.body, {
            status: failure!.status,
            headers: { 'content-type': 'application/problem+json' },
          });
        }
        const handling = (async () => {
          const response = await accessRequest.run(observed, () => sourceApp.handle(request));
          observed.responseStatus = response.status;
          if (
            request.method === 'POST' &&
            url.pathname === '/v1/subjects' &&
            !observed.fixtureRequest &&
            response.status === 201 &&
            pendingCreatedSubjectReadFailure
          ) {
            const failure = pendingCreatedSubjectReadFailure;
            pendingCreatedSubjectReadFailure = undefined;
            const created = (await response.clone().json()) as { subject?: { id?: unknown } };
            if (typeof created.subject?.id === 'string')
              createdSubjectReadFailures.set(`/v1/subjects/${created.subject.id}`, failure);
          }
          if (!response.ok)
            observed.failure = {
              status: response.status,
              body: await response.clone().text(),
            };
          if (url.pathname.includes(':authorizeDownload'))
            observed.authorizationDecision = { status: response.status, body: await response.clone().text() };
          return response;
        })();
        activeKernelRequests.add(handling);
        try {
          return await handling;
        } finally {
          activeKernelRequests.delete(handling);
        }
      },
    });
    kernelServer = server;
    const kernelOrigin = server.url.origin;
    const { actionCatalogue } = await import('../../../../services/kernel/src/http/request.ts');
    const actionScopes = [...actionCatalogue(sourceApp).keys()];
    governorScopes = [...actionScopes.filter((scope) => scope !== 'media:complete'), 'gate:any'];
    const { websiteRegistrationScopes } = await import('../../src/session/website-scopes');
    const scopes = websiteRegistrationScopes(actionScopes);
    const key = await generateKeyPair('ES256', { extractable: true });
    const kid = `native-web-${randomBytes(8).toString('hex')}`;
    await auth.service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [
          {
            ...(await exportJWK(key.publicKey)),
            kid,
            alg: 'ES256',
            use: 'sig',
          },
        ],
      } as Parameters<typeof auth.service.internal.registerWebsiteClient>[0]['publicJwks'],
      redirectUris: [`${webOrigin}/auth/callback`],
      postLogoutRedirectUris: [`${webOrigin}/`],
      scopes,
    });
    const authEnvironment = {
      AUTH_ISSUER: auth.issuer,
      API_RESOURCE: auth.audience,
      WEBSITE_CLIENT_ID: 'rezics-website',
      WEBSITE_CLIENT_KEY: JSON.stringify({
        ...(await exportJWK(key.privateKey)),
        kid,
        alg: 'ES256',
        use: 'sig',
      }),
      WEBSITE_SCOPES: scopes.join(' '),
      ...(testIssuer ? { AUTH_TEST_LOOPBACK_ORIGIN: authServer.url.origin } : {}),
      NATIVE_MEDIA_STORAGE_TOKEN: nativeMediaStorageToken,
    };
    const webCookies = new Map<string, Promise<string | undefined>>();
    let webStateDirectory: string | undefined;
    const responseCookie = (response: Response, name: string) => {
      const value = response.headers
        .getSetCookie()
        .find((line) => line.startsWith(`${name}=`))
        ?.split(';')[0];
      if (!value) throw new Error(`Native web sign-in did not issue ${name}: ${response.status}`);
      return value;
    };
    const websiteCookie = async (bearer: string) => {
      const cookie = authCookies.get(bearer);
      if (!cookie) throw new Error('The semantic harness did not issue an Auth session for this persona');
      const login = await fetchNativeWebsite(`${webOrigin}/auth/sign-in`, { redirect: 'manual' });
      const authorize = new URL(login.headers.get('location')!, webOrigin);
      if (authorize.origin !== auth.issuer)
        throw new Error(`Native web sign-in left its Auth listener: ${login.status}`);
      const authorizeTransport = testIssuer
        ? new URL(authorize.pathname + authorize.search, authServer!.url.origin)
        : authorize;
      const authorized = await fetch(authorizeTransport, { headers: { cookie }, redirect: 'manual' });
      // A revoked persona still carries its original bearer to the Worker. Auth
      // can refuse a new browser session; that must not replace the served read.
      if (authorized.status === 400 || authorized.status === 401 || authorized.status === 403) return undefined;
      const callback = new URL(authorized.headers.get('location')!, auth.issuer);
      if (callback.origin !== webOrigin || callback.pathname !== '/auth/callback')
        throw new Error(`Native Auth did not return to the owned web callback: ${authorized.status}`);
      const completed = await fetchNativeWebsite(callback, {
        headers: { cookie: responseCookie(login, '__Host-rezics_login') },
        redirect: 'manual',
      });
      return responseCookie(completed, '__Host-rezics_session');
    };
    let publicOrigin = 'https://rezics.example.test';
    let authPageOrigin: string | undefined;
    const launch = async () => {
      webStateDirectory ??= await mkdtemp(join(tmpdir(), 'native-web-state-'));
      return startWeb(
        webOrigin,
        kernelOrigin,
        publicOrigin,
        {
          ...authEnvironment,
          SITE_ORIGINS: [...new Set([webOrigin, publicOrigin])].join(','),
          ...(authPageOrigin ? { AUTH_ISSUER: authPageOrigin } : {}),
        },
        webStateDirectory,
        (child, stateDirectory) => reportOwnedProcessGroup('web Worker', child, stateDirectory),
      );
    };
    reportStackProgress('Native web stack startup: starting production web Worker');
    webProcess = await launch();
    reportStackProgress('Native web stack startup: production web Worker ready');

    return {
      databaseUrl: driver.fixtures.runtime.databaseUrl,
      authDatabaseUrl: auth.database.options.connectionString!,
      kernelOrigin,
      authIssuer: authServer.url.origin,
      issuerOrigin: auth.issuer,
      web: webOrigin,
      async authPersona(persona) {
        const { accountId, bearer } = await getAccount(persona);
        const result = await auth.database.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [
          accountId,
        ]);
        if (!result.rows[0]?.email) throw new Error(`Native ${persona} has no sign-in email`);
        return {
          accountId,
          email: result.rows[0].email,
          authorization: `Bearer ${bearer}`,
        };
      },
      async advanceAuthClock(seconds) {
        advanceNativeAuthClock(seconds);
      },
      async enableAccountOperations() {
        const probe = await authHandler(
          new Request(`${auth.issuer}/account-operations/approve`, {
            method: 'GET',
            headers: {
              origin: auth.issuer,
              'content-type': 'application/json',
            },
          }),
        );
        if (probe.status === 503)
          throw new Error(
            'Native Auth account operations returned 503 account_operation_denied: the shared Auth host has no accountOperations bind after createAuthHost construction',
          );
        if (probe.status !== 400)
          throw new Error(`Native Auth account-operation configuration probe returned ${probe.status}, expected 400`);
      },
      accountOperationActors() {
        return accountOperationActors.slice();
      },
      async createAutomatedActor() {
        throw new Error(
          'SemanticOutcomeDriver.fixtures has no native workflow-approval port for automated account creation; expose the existing createWorkflowApprovals boundary instead of using the account-operation client',
        );
      },
      async flushObservations() {
        await this.syncKernelRequests();
      },
      async routeAuthPages(origin) {
        if (origin && !signupHandler) {
          // Replace the fixture's workflow executor once, on the same database and
          // native registration ports, adding only public signup's Siteverify port.
          // Two Auth workflow executors cannot coexist in one process.
          const { createAccountWorkflows } = await import('../../../../services/auth/src/index.ts');
          const { registerAuthMaintenance } = await import('../../../../services/auth/src/maintenance.ts');
          const { createRegistrationPorts } =
            await import('../../../../services/kernel/test/support/registration-ports.ts');
          const runtime = driver!.fixtures.runtime;
          const keys = new Map(
            runtime.sessionKeys.split(',').map((entry) => {
              const [id, key] = entry.split(':');
              return [Number(id), Buffer.from(key!, 'base64url')] as const;
            }),
          );
          const { ports } = createRegistrationPorts({
            pool: driver!.fixtures.pool,
            authPool: auth.database,
            routeKey: Buffer.from(runtime.routeKey, 'base64url'),
            referenceKeys: { current: Math.max(...keys.keys()), keys },
          });
          await auth.host.workflows.close();
          let maintenance: ReturnType<typeof registerAuthMaintenance> | undefined;
          const workflows = createAccountWorkflows({
            database: auth.database,
            systemDatabaseUrl: auth.database.options.connectionString!,
            systemDatabasePool: auth.database,
            stagingKey: randomBytes(32),
            auth: auth.service,
            access: ports,
            executorId: auth.host.config.executorId,
            handleSignals: false,
            registerWorkflows: () => {
              maintenance = registerAuthMaintenance(auth.service);
            },
            turnstile: {
              secret: '1x0000000000000000000000000000000AA',
              // An explicit test provider boundary, as in Auth's own signup tests.
              fetch: (async (_url, init) => {
                const form = new URLSearchParams(String(init?.body));
                return Response.json({
                  success: form.get('response') === 'native-test-token',
                  action: 'signup',
                  hostname: new URL(auth.issuer).hostname,
                });
              }) as typeof fetch,
            },
          });
          closePageWorkflows = () => workflows.close();
          await workflows.start();
          await maintenance!.start(auth.host.config.maintenanceSchedule);
          auth.host.workflows = workflows;
          signupHandler = workflows.handler;
        }
        pageOrigin = origin;
        return auth.issuer;
      },
      async credentials(persona) {
        const { bearer } = await getAccount(persona);
        let cookie = webCookies.get(persona);
        if (!cookie) {
          cookie = websiteCookie(bearer);
          webCookies.set(persona, cookie);
        }
        const session = await cookie;
        return {
          authorization: `Bearer ${bearer}`,
          ...(session ? { cookie: session } : {}),
        };
      },
      kernelRequests() {
        return requests.slice();
      },
      async syncKernelRequests() {
        await Promise.allSettled(activeKernelRequests);
      },
      async refreshKernelRequests() {
        await this.syncKernelRequests();
      },
      async flushKernelRequests() {
        await this.syncKernelRequests();
      },
      async injectKernelFailureOnce(failure) {
        if (
          !failure.method ||
          !failure.path.startsWith('/v1/') ||
          !Number.isInteger(failure.status) ||
          failure.status < 400 ||
          failure.status > 599
        )
          throw new Error('Native failure injection requires a kernel path and non-success status');
        injectedKernelFailures.push({ ...failure });
      },
      async injectCreatedSubjectReadFailureOnce(failure) {
        if (!Number.isInteger(failure.status) || failure.status < 400 || failure.status > 599 || !failure.body)
          throw new Error('Created-subject read failure requires a non-success status and body');
        if (pendingCreatedSubjectReadFailure) throw new Error('A created-subject read failure is already armed');
        pendingCreatedSubjectReadFailure = { ...failure };
      },
      webOutput() {
        return webProcess?.output() ?? '';
      },
      workerLogs() {
        return Promise.resolve(durableWorker?.logs() ?? '');
      },
      peakMemoryBytes() {
        sampleMemory();
        return peakMemory;
      },
      async restartWeb(options) {
        await stopWeb(webProcess);
        webProcess = undefined;
        webCookies.clear();
        publicOrigin = options.publicOrigin;
        authPageOrigin = options.authIssuer;
        webProcess = await launch();
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native web stack startup and cleanup failed', { cause: error });
    }
    throw error;
  }
}
// The semantic harness owns process-local Auth and can only dispose it terminally.
// Give every stack its own process so stop can close Auth as well as the kernel,
// and a second (or failed) stack never reuses an earlier stack's database or sessions.
type Observation = {
  requests: NativeKernelRequest[];
  peakMemory: number;
  webOutput: string;
};
type HostReply =
  | {
      ready: {
        kernelOrigin: string;
        authIssuer: string;
        issuerOrigin: string;
        web: string;
        databaseUrl: string;
        authDatabaseUrl: string;
      };
      observation: Observation;
    }
  | { id: number; value?: unknown; error?: string; observation: Observation }
  | { startupError: string }
  | { progress: string }
  | { ownedGroup: { label: string; pid: number; stateDirectory?: string } }
  | { postgresContainer: string }
  | { analysisDatabase: string };
type HostCall = {
  id: number;
  method:
    | 'credentials'
    | 'authPersona'
    | 'enableAccountOperations'
    | 'accountOperationActors'
    | 'createAutomatedActor'
    | 'routeAuthPages'
    | 'advanceAuthClock'
    | 'restartWeb'
    | 'injectKernelFailureOnce'
    | 'injectCreatedSubjectReadFailureOnce'
    | 'observe'
    | 'workerLogs'
    | 'stop';
  argument?: string;
  options?: { publicOrigin: string; authIssuer?: string };
};

function reportStackProgress(message: string): void {
  console.info(message);
  if (process.env.NATIVE_WEB_STACK_HOST === '1') process.send?.({ progress: message } satisfies HostReply);
}

function reportOwnedProcessGroup(label: string, child: ChildProcess, stateDirectory?: string): void {
  if (process.env.NATIVE_WEB_STACK_HOST !== '1' || !child.pid) return;
  process.send?.({
    ownedGroup: {
      label,
      pid: child.pid,
      ...(stateDirectory ? { stateDirectory } : {}),
    },
  } satisfies HostReply);
}

export async function startNativeWebStack(options: NativeWebStackOptions = {}): Promise<NativeWebStack> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) {
    const standalone = new NativeTestLifecycle('standalone native web stack');
    const stack = await standalone.run('start native web stack', 360_000, () => startNativeWebStack(options), false);
    return {
      ...stack,
      async stop() {
        try {
          await stack.stop();
        } finally {
          await standalone.close();
        }
      },
    };
  }
  lifecycle.assertOpen('start native web stack');
  if (options.issuerOrigin !== undefined) {
    const issuer = new URL(options.issuerOrigin);
    if (
      issuer.protocol !== 'https:' ||
      issuer.hostname !== 'auth.native.rezics.com' ||
      !issuer.port ||
      issuer.origin !== options.issuerOrigin
    )
      throw new Error('Native Auth test issuer must be the reserved HTTPS auth.native.rezics.com origin');
  }
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let analysisDatabase: string | undefined;
  let postgresContainer: string | undefined;
  const stateDirectories = new Set<string>();
  let nativeStack: NativeWebStack | undefined;
  const ownedGroups = new Map<number, NativeProcessOwnership>();
  const hostEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    NATIVE_WEB_STACK_HOST: '1',
    NATIVE_WEB_COMMERCE: options.commerce ? '1' : '0',
    NATIVE_WEB_OBSERVE_PERSONAL_ACCESS: options.observePersonalAccess ? '1' : '0',
    ...(options.commerce
      ? {
          STRIPE_SECRET_KEY: 'sk_test_native_purchases',
          STRIPE_MANAGED_PAYMENTS: 'false',
          STRIPE_API_HOST: options.commerce.apiHost,
          STRIPE_WEBHOOK_SECRETS: options.commerce.webhookSecret,
          CHECKOUT_SUCCESS_URL: options.commerce.successUrl,
          CHECKOUT_CANCEL_URL: options.commerce.cancelUrl,
        }
      : {}),
  };
  // Rate changes apply only to this explicitly configured native fixture stack.
  if (options.writeRateOverrides) hostEnvironment.NATIVE_WEB_STACK_WRITE_RATE_OVERRIDES = options.writeRateOverrides;
  else delete hostEnvironment.NATIVE_WEB_STACK_WRITE_RATE_OVERRIDES;
  hostEnvironment.NATIVE_AUTH_TEST_ISSUER = options.issuerOrigin;
  hostEnvironment.NATIVE_WEB_TEST_HOST = options.webTls ? nativeWebsiteHost : undefined;
  hostEnvironment.NATIVE_WEB_TEST_TLS_CERT = options.webTls?.certificate;
  hostEnvironment.NATIVE_WEB_TEST_TLS_KEY = options.webTls?.key;
  hostEnvironment.NATIVE_AUTH_TEST_CLOCK_OFFSET_SECONDS =
    options.authClockOffsetSeconds === undefined ? undefined : String(options.authClockOffsetSeconds);
  const host = fork(import.meta.filename, [], {
    execPath: resolveBunCommand(['bun'], repositoryRoot)[0]!,
    execArgv: [],
    cwd: repositoryRoot,
    env: hostEnvironment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: true,
  });
  let pageBridge: ReturnType<typeof Bun.serve> | undefined;
  let output = '';
  for (const stream of [host.stdout, host.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk).slice(-12_000);
    });
  // Process exit is the ownership boundary. The stdio `close` event can wait
  // for inherited pipes even after the host itself has ended.
  const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()).once('error', () => resolve()));
  const hostOwnership = lifecycle.ownProcessGroup('native web stack host', host);
  let terminating: Promise<void> | undefined;
  const cleanupExternalState = async () => {
    const errors: unknown[] = [];
    if (analysisDatabase && originalDatabaseUrl) {
      const adminUrl = new URL(originalDatabaseUrl);
      adminUrl.pathname = '/postgres';
      const admin = new Pool({
        connectionString: adminUrl.href,
        max: 1,
        connectionTimeoutMillis: 1500,
        statement_timeout: 5000,
      });
      let dropped = false;
      try {
        const result = await settledWithin(
          admin.query(`DROP DATABASE IF EXISTS "${analysisDatabase}" WITH (FORCE)`).then(() => true),
          7_000,
        );
        if (!result) throw new Error('Owned native analysis database cleanup exceeded 7000ms');
        dropped = true;
      } catch (error) {
        errors.push(error);
      }
      try {
        const ended = await settledWithin(
          admin.end().then(() => true),
          1_000,
        );
        if (!ended) throw new Error('Owned native analysis connection cleanup exceeded 1000ms');
      } catch (error) {
        errors.push(error);
      }
      if (dropped) analysisDatabase = undefined;
    }
    if (postgresContainer) {
      const child = Bun.spawn(['docker', 'rm', '-fv', postgresContainer], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const done = await Promise.race([
        child.exited.then(async (code) => ({
          code,
          stderr: await new Response(child.stderr).text(),
        })),
        Bun.sleep(8_000).then(() => undefined),
      ]);
      if (!done) {
        child.kill('SIGKILL');
        const killed = await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
        if (!killed) errors.push(new Error('Owned PostgreSQL container cleanup process survived SIGKILL'));
        else errors.push(new Error('Owned PostgreSQL container cleanup timed out'));
      }
      if (done && done.code !== 0 && !/No such container|is not running/iu.test(done.stderr))
        errors.push(new Error(`Could not remove owned PostgreSQL container: ${done.stderr}`));
      if (done?.code === 0 || (done && /No such container|is not running/iu.test(done.stderr)))
        postgresContainer = undefined;
    }
    for (const directory of stateDirectories) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    stateDirectories.clear();
    if (errors.length) throw new AggregateError(errors, 'Native external state cleanup failed');
  };
  const terminate = () =>
    (terminating ??= (async () => {
      const owners = [hostOwnership, ...ownedGroups.values()];
      const graceful = await Promise.allSettled(owners.map((owner) => owner.close()));
      if (graceful.some((result) => result.status === 'rejected'))
        await Promise.allSettled(owners.map((owner) => owner.force()));
      const stopped = await Promise.race([exited.then(() => true), Bun.sleep(4_000).then(() => false)]);
      if (!stopped) {
        await Promise.allSettled(owners.map((owner) => owner.force()));
        const killed = await Promise.race([exited.then(() => true), Bun.sleep(4_000).then(() => false)]);
        if (!killed) throw new Error('Owned native web stack host survived bounded shutdown');
      }
      await cleanupExternalState();
    })());

  let releaseStackResource = lifecycle.register({
    label: 'native web stack fixture',
    close: async () => {
      if (nativeStack) await nativeStack.stop();
      else await terminate();
    },
    force: terminate,
  });
  let serial = 0;
  let observation: Observation = { requests: [], peakMemory: 0, webOutput: '' };
  let closed: Promise<void> | undefined;
  let pageBridgeRelease: (() => void) | undefined;
  let dead: Error | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ready!: (value: {
    kernelOrigin: string;
    authIssuer: string;
    issuerOrigin: string;
    web: string;
    databaseUrl: string;
    authDatabaseUrl: string;
  }) => void;
  let failed!: (error: Error) => void;
  const startup = new Promise<{
    kernelOrigin: string;
    authIssuer: string;
    issuerOrigin: string;
    web: string;
    databaseUrl: string;
    authDatabaseUrl: string;
  }>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const fail = (error: Error) => {
    dead = error;
    failed(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  host.on('message', (reply: HostReply) => {
    if ('ownedGroup' in reply) {
      const { label, pid } = reply.ownedGroup;
      const stateDirectory = reply.ownedGroup.stateDirectory;
      if (stateDirectory) stateDirectories.add(stateDirectory);
      if (!ownedGroups.has(pid)) {
        try {
          ownedGroups.set(pid, lifecycle.ownProcessId(label, pid));
        } catch (error) {
          try {
            process.kill(pid, 0);
            fail(error instanceof Error ? error : new Error(String(error)));
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH')
              fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
      return;
    }
    if ('postgresContainer' in reply) {
      postgresContainer = reply.postgresContainer;
      return;
    }
    if ('progress' in reply) {
      console.info(reply.progress);
      return;
    }
    if ('analysisDatabase' in reply) {
      analysisDatabase = reply.analysisDatabase;
      return;
    }
    if ('startupError' in reply) return fail(new Error(reply.startupError));
    observation.requests.push(...reply.observation.requests);
    observation.peakMemory = reply.observation.peakMemory;
    observation.webOutput = reply.observation.webOutput;
    if ('ready' in reply) return ready(reply.ready);
    const call = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) call?.reject(new Error(reply.error));
    else call?.resolve(reply.value);
  });
  host.on('error', fail);
  host.on('exit', (code) => fail(new Error(`Native stack host exited ${code}\n${output}`)));
  const call = (method: HostCall['method'], argument?: string): Promise<unknown> => {
    if (method !== 'stop' && !(method === 'routeAuthPages' && argument === undefined && lifecycle.signal.aborted))
      lifecycle.assertOpen(`call native web stack ${method}`);
    if (dead) return Promise.reject(dead);
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      host.send({ id, method, argument } satisfies HostCall);
    });
  };
  try {
    const { kernelOrigin, authIssuer, issuerOrigin, web, databaseUrl, authDatabaseUrl } = await startup;
    lifecycle.assertOpen('finish native web stack startup');
    // Retain the existing fixture's observable setup environment. The host has
    // its own environment, including Reylo config and pool timeout overrides.
    let releaseEnvironment = () => {};
    if (originalDatabaseUrl === undefined) {
      process.env.DATABASE_URL = databaseUrl;
      const restoreEnvironment = () => {
        if (process.env.DATABASE_URL === databaseUrl) delete process.env.DATABASE_URL;
        releaseEnvironment();
      };
      releaseEnvironment = lifecycle.register({
        label: 'native web stack parent environment',
        close: restoreEnvironment,
        force: restoreEnvironment,
      });
    }
    const credentials = (persona: string) => call('credentials', persona) as Promise<NativeCredentials>;
    const authenticatedHeaders = async (input: HeadersInit | undefined, persona?: string) => {
      const headers = new Headers(input);
      if (persona && persona !== 'anonymous') {
        const issued = await credentials(persona);
        headers.set('authorization', issued.authorization);
        if (issued.cookie) headers.set('cookie', [headers.get('cookie'), issued.cookie].filter(Boolean).join('; '));
      }
      return headers;
    };
    const observe = async (response: Response) => {
      await call('observe');
      return response;
    };
    const api: NativeWebStack = {
      databaseUrl,
      authDatabaseUrl,
      kernelOrigin,
      authIssuer,
      issuerOrigin,
      web,
      async credentials(persona) {
        lifecycle.assertOpen('read native account credentials');
        return credentials(persona);
      },
      async authPersona(persona) {
        lifecycle.assertOpen('read native account identity');
        return (await call('authPersona', persona)) as {
          accountId: string;
          email: string;
          authorization: string;
        };
      },
      advanceAuthClock(seconds) {
        lifecycle.assertOpen('advance native Auth clock');
        return call('advanceAuthClock', String(seconds)).then(() => undefined);
      },
      async enableAccountOperations() {
        lifecycle.assertOpen('check native account-operation boundary');
        await call('enableAccountOperations');
      },
      async accountOperationActors() {
        return (await call('accountOperationActors')) as readonly NativeAccountOperationActor[];
      },
      async createAutomatedActor(operator, handle, authCookie) {
        return (await call('createAutomatedActor', JSON.stringify({ operator, handle, authCookie }))) as {
          accountId: string;
        };
      },
      async flushObservations() {
        await api.syncKernelRequests();
      },
      async routeAuthPages(handler) {
        if (handler !== undefined) lifecycle.assertOpen('route native Auth pages');
        pageBridgeRelease?.();
        pageBridgeRelease = undefined;
        await pageBridge?.stop(true);
        pageBridge = handler
          ? Bun.serve({
              hostname: '127.0.0.1',
              port: 0,
              fetch(request) {
                const url = request.headers.get('x-native-auth-url');
                if (!url) return new Response('Missing issuer URL', { status: 400 });
                const forwarded = new Request(url, request);
                forwarded.headers.delete('x-native-auth-url');
                return handler(forwarded);
              },
            })
          : undefined;
        if (pageBridge) {
          const bridge = pageBridge;
          pageBridgeRelease = lifecycle.register({
            label: 'native Auth page bridge',
            close: () => bridge.stop(true),
            force: () => bridge.stop(true),
          });
        }
        return (await call('routeAuthPages', pageBridge?.url.origin)) as string;
      },
      kernelRequests: () => observation.requests.slice(),
      async syncKernelRequests() {
        await call('observe');
      },
      async injectKernelFailureOnce(failure) {
        await call('injectKernelFailureOnce', JSON.stringify(failure));
      },
      async injectCreatedSubjectReadFailureOnce(failure) {
        await call('injectCreatedSubjectReadFailureOnce', JSON.stringify(failure));
      },
      webOutput: () => observation.webOutput,
      async flushKernelRequests() {
        await call('observe');
      },
      peakMemoryBytes: () => observation.peakMemory,
      async kernel(path, init = {}, persona) {
        lifecycle.assertOpen('send native kernel request');
        const url = new URL(path, kernelOrigin);
        if (url.origin !== kernelOrigin) throw new Error('Kernel request must use the owned listener');
        const headers = await authenticatedHeaders(init.headers, persona);
        headers.set('x-native-fixture-request', '1');
        return observe(await fetch(url, { ...init, headers, redirect: 'manual' }));
      },
      async request(url, persona, suppliedHeaders) {
        lifecycle.assertOpen('send native Worker request');
        const requested = new URL(url, web);
        const target = new URL(web);
        // Assign the path rather than resolving it: a leading // is still a
        // document path, never authority to contact a different listener.
        target.pathname = requested.pathname;
        target.search = requested.search;
        const headers = await authenticatedHeaders(suppliedHeaders, persona);
        // Keep the HTTP Response itself: observing never reads its body, replaces
        // its headers, changes its status, or follows a Worker redirect.
        return observe(await fetchNativeWebsite(target, { headers, redirect: 'manual' }));
      },
      async refreshKernelRequests() {
        await call('observe');
      },
      async restartWeb(options) {
        lifecycle.assertOpen('restart native web Worker');
        const id = ++serial;
        await new Promise<void>((resolve, reject) => {
          pending.set(id, { resolve: () => resolve(), reject });
          host.send({ id, method: 'restartWeb', options } satisfies HostCall);
        });
      },
      workerLogs() {
        return call('workerLogs') as Promise<string>;
      },
      stop() {
        return (closed ??= (async () => {
          for (const owner of [hostOwnership, ...ownedGroups.values()]) owner.capture();
          const shutdown = (async () => {
            try {
              await call('stop');
            } finally {
              pageBridgeRelease?.();
              pageBridgeRelease = undefined;
              await pageBridge?.stop(true);
              await terminate();
            }
          })();
          try {
            const finished = await settledWithin(
              shutdown.then(() => true),
              25_000,
            );
            if (!finished) {
              pageBridge?.stop(true);
              await terminate();
              throw new Error('Native web stack shutdown exceeded 25000ms');
            }
          } catch (error) {
            try {
              pageBridgeRelease?.();
              pageBridgeRelease = undefined;
              pageBridge?.stop(true);
              await terminate();
            } catch (cleanup) {
              throw new AggregateError([error, cleanup], 'Native web stack shutdown and cleanup failed');
            }
            throw new Error(
              `Native web stack cleanup failed (exit=${host.exitCode}, signal=${host.signalCode}): ${output}`,
              { cause: error },
            );
          } finally {
            if (originalDatabaseUrl === undefined) {
              if (process.env.DATABASE_URL === databaseUrl) delete process.env.DATABASE_URL;
              releaseEnvironment();
            }
          }
        })());
      },
    };
    nativeStack = api;
    releaseStackResource();
    releaseStackResource = lifecycle.register({
      label: 'native web stack fixture',
      close: () => api.stop(),
      force: terminate,
    });
    return api;
  } catch (error) {
    await terminate();
    throw error;
  }
}

if (process.env.NATIVE_WEB_STACK_HOST === '1' && process.send) {
  const send = (reply: HostReply, exitCode?: number) => {
    process.send!(reply, (error) => {
      // The process owns Reylo's analysis connection as well as the IPC channel.
      // Terminal cleanup ends both, after its result has reached the supervisor.
      if (exitCode !== undefined) process.exit(error ? 1 : exitCode);
    });
  };
  try {
    const stack = await startStack();
    let observedRequests = 0;
    const observation = (): Observation => {
      const requests = stack.kernelRequests();
      const next = {
        requests: requests.slice(observedRequests),
        peakMemory: stack.peakMemoryBytes(),
        webOutput: stack.webOutput(),
      };
      observedRequests = requests.length;
      return next;
    };
    process.on('message', async ({ id, method, argument, options }: HostCall) => {
      try {
        let value: unknown;
        if (method === 'credentials') value = await stack.credentials(argument!);
        else if (method === 'authPersona') value = await stack.authPersona(argument!);
        else if (method === 'enableAccountOperations') await stack.enableAccountOperations();
        else if (method === 'accountOperationActors') value = stack.accountOperationActors();
        else if (method === 'createAutomatedActor') {
          const input = JSON.parse(argument!) as {
            operator: string;
            handle: string;
            authCookie: string;
          };
          value = await stack.createAutomatedActor(input.operator, input.handle, input.authCookie);
        } else if (method === 'routeAuthPages') value = await stack.routeAuthPages(argument);
        else if (method === 'advanceAuthClock') await stack.advanceAuthClock(Number(argument));
        else if (method === 'injectKernelFailureOnce')
          stack.injectKernelFailureOnce(JSON.parse(argument!) as NativeKernelFailureInjection);
        else if (method === 'injectCreatedSubjectReadFailureOnce')
          stack.injectCreatedSubjectReadFailureOnce(JSON.parse(argument!) as { status: number; body: string });
        else if (method === 'observe') await stack.syncKernelRequests();
        else if (method === 'restartWeb') await stack.restartWeb(options!);
        else if (method === 'workerLogs') value = await stack.workerLogs();
        else if (method === 'stop') await stack.stop();
        send({ id, value, observation: observation() } satisfies HostReply, method === 'stop' ? 0 : undefined);
      } catch (error) {
        send(
          {
            id,
            error: errorDetails(error),
            observation: observation(),
          } satisfies HostReply,
          method === 'stop' ? 1 : undefined,
        );
      }
    });
    send({
      ready: {
        kernelOrigin: stack.kernelOrigin,
        authIssuer: stack.authIssuer,
        issuerOrigin: stack.issuerOrigin,
        web: stack.web,
        databaseUrl: stack.databaseUrl,
        authDatabaseUrl: stack.authDatabaseUrl,
      },
      observation: observation(),
    } satisfies HostReply);
  } catch (error) {
    send(
      {
        startupError: errorDetails(error),
      } satisfies HostReply,
      1,
    );
  }
}
