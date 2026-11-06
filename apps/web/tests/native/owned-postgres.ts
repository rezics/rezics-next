import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { connect as connectUnix, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeOwnedPostgresIsolation = {
  pid: number;
  interfaceNames: readonly string[];
  ownNamespace: string;
  pid1Namespace?: string;
};

export type OwnedPostgresSocketProxy = {
  port: number;
  close(): Promise<void>;
};

/** Host-published TCP ports never appear on an unshared loopback. */
export function nativeOwnedPostgresIsolated(input: NativeOwnedPostgresIsolation): boolean {
  if (input.interfaceNames.length > 0 && input.interfaceNames.every((name) => name === 'lo')) return true;
  return input.pid1Namespace === undefined || input.ownNamespace !== input.pid1Namespace;
}

/** libpq treats a slash-prefixed host as the directory that holds `.s.PGSQL.5432`. */
export function isolatedOwnedPostgresUrl(socketDirectory: string): string {
  return `postgres://rezics:rezics@localhost/rezics?host=${socketDirectory}&sslmode=disable`;
}

/**
 * Reylo's postgres.js client dials the URL hostname and ignores libpq `host=/socket`.
 * Isolated analysis therefore uses a loopback TCP proxy onto that same unix socket.
 */
export function isolatedReyloPostgresUrl(port: number, database: string): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535)
    throw new Error('Reylo PostgreSQL proxy port must be a TCP port');
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('Unsafe analysis database name');
  return `postgres://rezics:rezics@127.0.0.1:${port}/${database}?sslmode=disable`;
}

function listenOwnedPostgresSocketProxyInProcess(socketDirectory: string): Promise<OwnedPostgresSocketProxy> {
  if (!socketDirectory.startsWith('/') || /[,\s]/.test(socketDirectory))
    throw new Error('PostgreSQL socket proxy requires an absolute socket directory');
  const socketPath = join(socketDirectory, '.s.PGSQL.5432');
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    const upstream = connectUnix(socketPath);
    sockets.add(upstream);
    const drop = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('PostgreSQL socket proxy did not bind a TCP port'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

/**
 * Reylo analyses SQL on a worker while the stack host is blocked in `Atomics.wait`.
 * The proxy therefore runs in its own process so accept/pipe can complete.
 */
export async function listenOwnedPostgresSocketProxy(socketDirectory: string): Promise<OwnedPostgresSocketProxy> {
  if (!socketDirectory.startsWith('/') || /[,\s]/.test(socketDirectory))
    throw new Error('PostgreSQL socket proxy requires an absolute socket directory');
  const child: ChildProcess = fork(fileURLToPath(import.meta.url), [socketDirectory], {
    execPath: process.execPath,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  if (!child.pid) throw new Error('PostgreSQL socket proxy did not start');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const fail = (error: Error) => {
        child.off('message', onMessage);
        reject(error);
      };
      const onMessage = (message: { port?: unknown }) => {
        if (typeof message.port === 'number' && Number.isInteger(message.port) && message.port > 0) {
          child.off('message', onMessage);
          resolve(message.port);
        }
      };
      child.once('error', (error) => fail(error));
      child.once('exit', (code, signal) =>
        fail(new Error(`PostgreSQL socket proxy exited ${code ?? signal} before binding`)),
      );
      child.on('message', onMessage);
    });
    return {
      port,
      close: () =>
        (async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const stopped = await Promise.race([exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
          if (!stopped && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await Promise.race([exited, Bun.sleep(1_000)]);
          }
        })(),
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([exited, Bun.sleep(1_000)]);
    throw error;
  }
}

export function networkInterfaceNames(source = '/proc/net/dev'): string[] {
  try {
    return [...readFileSync(source, 'utf8').matchAll(/^\s*([A-Za-z][A-Za-z0-9._-]*)\s*:/gm)].map((match) => match[1]!);
  } catch {
    return [];
  }
}

export function ownedPostgresIsolated(): boolean {
  let pid1Namespace: string | undefined;
  try {
    pid1Namespace = readlinkSync('/proc/1/ns/net');
  } catch {
    pid1Namespace = undefined;
  }
  try {
    return nativeOwnedPostgresIsolated({
      pid: process.pid,
      interfaceNames: networkInterfaceNames(),
      ownNamespace: readlinkSync('/proc/self/ns/net'),
      pid1Namespace,
    });
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error('PostgreSQL socket proxy requires an absolute socket directory');
  const proxy = await listenOwnedPostgresSocketProxyInProcess(directory);
  process.send?.({ port: proxy.port });
  const stop = () => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
