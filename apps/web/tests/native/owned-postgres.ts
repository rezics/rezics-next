import { readFileSync, readlinkSync } from 'node:fs';

export type NativeOwnedPostgresIsolation = {
  pid: number;
  interfaceNames: readonly string[];
  ownNamespace: string;
  pid1Namespace?: string;
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
