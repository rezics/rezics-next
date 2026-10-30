import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

type HostOptions = Parameters<typeof createAuthHost>[0];
export type KernelPorts = { trustedAccess: HostOptions['trustedAccess']; access: HostOptions['access'] };
export type OwnedSemanticResource = { kind: 'kernel_database' | 'auth_database'; name: string };
export type OwnedResourceObserver = (resource: OwnedSemanticResource) => void | Promise<void>;
export type SharedAuth = {
  issuer: string;
  audience: string;
  service: AuthService;
  host: Awaited<ReturnType<typeof createAuthHost>>;
  database: Pool;
  /** Points the shared host's kernel ports at one driver's kernel; the release clears them again. */
  bind(ports: KernelPorts): () => void;
  /** Registers the sign-in client once; every driver passes the same action scopes. */
  registerClient(clientId: string, scopes: string[]): Promise<void>;
};

const kernelRoot = resolve(import.meta.dir, '../..');

function databaseUrl(source: URL, name: string): string {
  const value = new URL(source);
  value.pathname = `/${name}`;
  return value.href;
}

/** A port the host holds for its whole life that forwards every access to the object currently bound. */
function delegating<T extends object>(name: string) {
  let target: T | undefined;
  const current = (): T => {
    if (!target) throw new Error(`No semantic driver is bound to the shared Auth ${name} port`);
    return target;
  };
  const port = new Proxy({} as T, {
    get(_, key) {
      if (!target) {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        return () => current();
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (_, key) => key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor(_, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
  return {
    port,
    bind(next: T) {
      target = next;
      return () => {
        if (target === next) target = undefined;
      };
    },
  };
}

type Built = {
  auth: SharedAuth;
  resource: OwnedSemanticResource;
  dispose(strict?: boolean): Promise<void>;
};
let shared: Promise<Built> | undefined;
let terminal = false;
let closing: Promise<void> | undefined;
const configuredNativeAuthClockOffset = process.env.NATIVE_AUTH_TEST_CLOCK_OFFSET_SECONDS;
const nativeAuthClockInstalled = configuredNativeAuthClockOffset !== undefined;
let nativeClockOffsetSeconds = Number(configuredNativeAuthClockOffset ?? 0);
const configuredNativeAuthIssuer = process.env.NATIVE_AUTH_TEST_ISSUER;

if (configuredNativeAuthIssuer !== undefined) {
  let issuer: URL;
  try {
    issuer = new URL(configuredNativeAuthIssuer);
  } catch {
    throw new Error('NATIVE_AUTH_TEST_ISSUER must be the reserved HTTPS Auth origin with an explicit port');
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.hostname !== 'auth.native.rezics.com' ||
    !issuer.port ||
    issuer.origin !== configuredNativeAuthIssuer
  )
    throw new Error('NATIVE_AUTH_TEST_ISSUER must be the reserved HTTPS Auth origin with an explicit port');
}

if (!Number.isSafeInteger(nativeClockOffsetSeconds))
  throw new Error('NATIVE_AUTH_TEST_CLOCK_OFFSET_SECONDS must be a safe integer');

/** Advance only the trusted Auth clock owned by the native test process. */
export function advanceNativeAuthClock(seconds: number): void {
  if (terminal || closing) throw new Error('Owned semantic Auth is terminally closed in this process');
  if (!nativeAuthClockInstalled) throw new Error('Native Auth trusted clock is not installed in this process');
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new Error('Native Auth clock advance must be a nonnegative safe integer');
  const nextOffset = nativeClockOffsetSeconds + seconds;
  if (!Number.isSafeInteger(nextOffset)) throw new Error('Native Auth clock offset exceeded safe range');
  const nextMilliseconds = Date.now() + nextOffset * 1000;
  if (!Number.isFinite(nextMilliseconds) || !Number.isFinite(new Date(nextMilliseconds).getTime()))
    throw new Error('Native Auth clock time is outside the valid Date range');
  nativeClockOffsetSeconds = nextOffset;
}

// bun test runs no exit handler, so nothing in this process can drop the database when it ends. A detached
// watcher holds the read end of a pipe the process owns; the pipe closes when the process ends for any reason,
// and the watcher then drops the database.
const watcher = `
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.argv[1] });
  for await (const _ of Bun.stdin.stream());
  await client.connect();
  await client.query('DROP DATABASE IF EXISTS "' + process.argv[2] + '" WITH (FORCE)');
  process.exit(0);
`;

async function build(
  source: URL,
  onOwnedResource: OwnedResourceObserver | undefined,
  strictCleanup: boolean,
): Promise<Built> {
  const name = `semantic_auth_${randomUUID().replaceAll('-', '')}`;
  const ownerUrl = databaseUrl(source, 'postgres');
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  let database: Pool | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let dropper: ReturnType<typeof Bun.spawn> | undefined;
  let watcherOutput: Promise<string> | undefined;
  let watcherErrors: Promise<string> | undefined;
  let databaseClaimed = false;
  let cleanup: Promise<unknown[]> | undefined;
  const collectCleanup = () =>
    (cleanup ??= (async () => {
      const errors: unknown[] = [];
      const attempt = async (step: () => unknown | Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };

      if (host) await attempt(() => host!.stop());
      // Until host construction succeeds, this helper still owns any pool Auth has not already closed.
      else if (database && !database.ended && !database.ending) await attempt(() => database!.end());
      if (server) await attempt(() => server!.stop(true));
      if (dropper) {
        await attempt(async () => {
          const stdin = dropper!.stdin;
          if (!stdin || typeof stdin === 'number') {
            dropper!.kill();
            throw new Error('Semantic Auth database watcher has no controllable stdin');
          }
          await stdin.end();
        });
        await attempt(async () => {
          const exitCode = await dropper!.exited;
          await watcherOutput;
          await watcherErrors;
          if (exitCode !== 0) throw new Error(`Semantic Auth database watcher exited ${exitCode}`);
        });
      }
      if (databaseClaimed) await attempt(() => dropTestDatabase(owner, name));
      await attempt(() => owner.end());
      return errors;
    })());
  const dispose = async (strict = true) => {
    const errors = await collectCleanup();
    if (strict && errors.length) throw new AggregateError(errors, 'Semantic Auth cleanup failed');
  };
  try {
    const existing = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount) throw new Error(`Semantic Auth database name is already in use: ${name}`);
    await onOwnedResource?.({ kind: 'auth_database', name });
    databaseClaimed = true;
    const authUrl = await createAuthDatabase(source.toString(), name);
    dropper = Bun.spawn([process.execPath, '-e', watcher, ownerUrl, name], {
      cwd: kernelRoot,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    dropper.unref();
    const watcherStdout = dropper.stdout;
    const watcherStderr = dropper.stderr;
    if (!watcherStdout || typeof watcherStdout === 'number' || !watcherStderr || typeof watcherStderr === 'number')
      throw new Error('Semantic Auth database watcher has no readable output pipes');
    watcherOutput = new Response(watcherStdout).text();
    watcherErrors = new Response(watcherStderr).text();
    const authDatabase = new Pool({ connectionString: authUrl, max: 10 });
    database = authDatabase;
    authDatabase.on('error', () => {});
    authDatabase.on('connect', (client) => client.on('error', () => {}));

    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: `semantic-${name}`,
      alg: 'ES256',
    };
    let service!: AuthService;
    const authServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => service.handler(request) });
    server = authServer;
    const issuer = configuredNativeAuthIssuer ?? `http://127.0.0.1:${authServer.port}`;
    const audience = 'https://semantic.api.rezics.test';

    const trusted = delegating<KernelPorts['trustedAccess']>('trusted Access');
    const access = delegating<KernelPorts['access']>('registration');
    const authHost = await createAuthHost({
      database: authDatabase,
      systemDatabasePool: authDatabase,
      issuer,
      audience,
      secret: 'semantic-outcome-auth-secret-with-at-least-32-bytes',
      ...(nativeAuthClockInstalled ? { clock: () => new Date(Date.now() + nativeClockOffsetSeconds * 1000) } : {}),
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: trusted.port,
      access: access.port,
      stagingKey: randomBytes(32),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: `semantic-${name}`,
    });
    host = authHost;
    service = authHost.service;
    await authHost.start();

    let client: Promise<void> | undefined;
    const auth: SharedAuth = {
      issuer,
      audience,
      service,
      host,
      database,
      bind(ports) {
        const releaseTrusted = trusted.bind(ports.trustedAccess);
        const releaseAccess = access.bind(ports.access);
        return () => {
          releaseTrusted();
          releaseAccess();
        };
      },
      registerClient(clientId, scopes) {
        const registering = (client ??= service.internal.registerClient({ clientId, firstParty: true, scopes }));
        return registering.catch((error) => {
          if (client === registering) client = undefined;
          throw error;
        });
      },
    };
    return { auth, resource: { kind: 'auth_database', name }, dispose };
  } catch (error) {
    const errors = await collectCleanup();
    if (strictCleanup && errors.length)
      throw new AggregateError([error, ...errors], 'Semantic Auth setup and cleanup failed', { cause: error });
    throw error;
  }
}

/** The one Auth database, host and server of this process; the first caller builds it. A failed build is
 * disposed and retried by the next caller. Its database is dropped when the process ends. */
export function sharedAuth(
  source: URL,
  onOwnedResource?: OwnedResourceObserver,
  strictCleanup = false,
): Promise<SharedAuth> {
  if (terminal) return Promise.reject(new Error('Owned semantic Auth is terminally closed in this process'));
  if (!shared) {
    const pending = build(source, onOwnedResource, strictCleanup);
    shared = pending;
    return pending.then(
      (built) => built.auth,
      (error) => {
        if (shared === pending) shared = undefined;
        throw error;
      },
    );
  }
  const pending = shared;
  return pending.then(
    async (built) => {
      // A cached process-local host still owns this exact database. Replay the identity to
      // callers that need to track the existing resource before returning the host.
      await onOwnedResource?.(built.resource);
      return built.auth;
    },
    (error) => {
      if (shared === pending) shared = undefined;
      throw error;
    },
  );
}

/** Terminal disposal for one isolated semantic supervisor process. Existing sharedAuth callers do not call this. */
export function closeOwnedSemanticAuth(): Promise<void> {
  if (closing) return closing;
  terminal = true;
  const pending = shared;
  closing = (async () => {
    if (!pending) return;
    let built: Built;
    try {
      built = await pending;
    } catch {
      // A failed build already attempts all cleanup stages before rejecting.
      return;
    }
    await built.dispose(true);
  })();
  return closing;
}
