import { readFileSync, readlinkSync } from 'node:fs';
import { connect as connectUnix, createServer, type Socket } from 'node:net';
import { join } from 'node:path';

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

export async function listenOwnedPostgresSocketProxy(socketDirectory: string): Promise<OwnedPostgresSocketProxy> {
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('PostgreSQL socket proxy did not bind a TCP port');
  }
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function networkInterfaceNames(source = '/proc/net/dev'): string[] {
  try {
    return [...readFileSync(source, 'utf8').matchAll(/^\s*([A-Za-z][A-Za-z0-9._-]*)\s*:/gm)].map(
      (match) => match[1]!,
    );
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
