import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

type HostOptions = Parameters<typeof createAuthHost>[0];
export type KernelPorts = { trustedAccess: HostOptions['trustedAccess']; access: HostOptions['access'] };
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

type Built = { auth: SharedAuth; dispose(): Promise<void> };
let shared: Promise<Built> | undefined;

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

async function build(source: URL): Promise<Built> {
  const name = `semantic_auth_${randomUUID().replaceAll('-', '')}`;
  const ownerUrl = databaseUrl(source, 'postgres');
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  const cleanup: (() => Promise<unknown>)[] = [];
  const dispose = async () => {
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
  };
  try {
    cleanup.push(() => owner.end());
    cleanup.push(() => dropTestDatabase(owner, name));
    const authUrl = await createAuthDatabase(source.toString(), name);
    const dropper = Bun.spawn([process.execPath, '-e', watcher, ownerUrl, name], {
      cwd: kernelRoot,
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    dropper.unref();
    // Run in reverse: stop the watcher before dropping the database, then close the owner pool.
    cleanup.push(async () => dropper.kill());
    const database = new Pool({ connectionString: authUrl, max: 10 });
    database.on('error', () => {});
    database.on('connect', (client) => client.on('error', () => {}));
    cleanup.push(() => database.end());

    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: `semantic-${name}`,
      alg: 'ES256',
    };
    let service!: AuthService;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => service.handler(request) });
    cleanup.push(() => server.stop(true));
    const issuer = `http://127.0.0.1:${server.port}`;
    const audience = 'https://semantic.api.rezics.test';

    const trusted = delegating<KernelPorts['trustedAccess']>('trusted Access');
    const access = delegating<KernelPorts['access']>('registration');
    const host = await createAuthHost({
      database,
      systemDatabasePool: database,
      issuer,
      audience,
      secret: 'semantic-outcome-auth-secret-with-at-least-32-bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: trusted.port,
      access: access.port,
      stagingKey: randomBytes(32),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: `semantic-${name}`,
    });
    cleanup.push(() => host.stop());
    service = host.service;
    await host.start();

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
    return { auth, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** The one Auth database, host and server of this process; the first caller builds it. A failed build is
 * disposed and retried by the next caller. Its database is dropped when the process ends. */
export function sharedAuth(source: URL): Promise<SharedAuth> {
  const pending = (shared ??= build(source));
  return pending.then(
    (built) => built.auth,
    (error) => {
      if (shared === pending) shared = undefined;
      throw error;
    },
  );
}
