import { readFileSync, readlinkSync } from 'node:fs';

export const isolatedOwnedPostgresUrl = 'postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable';

export type NativeOwnedPostgresIsolation = {
  pid: number;
  interfaceNames: readonly string[];
  ownNamespace: string;
  pid1Namespace?: string;
};

/** Host-published ports never appear on an unshared loopback; join that netns and use 5432. */
export function nativeOwnedPostgresIsolation(input: NativeOwnedPostgresIsolation): string | undefined {
  const ownPath = `/proc/${input.pid}/ns/net`;
  if (input.interfaceNames.length > 0 && input.interfaceNames.every((name) => name === 'lo')) return ownPath;
  if (input.pid1Namespace === undefined || input.ownNamespace !== input.pid1Namespace) return ownPath;
  return undefined;
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

export function isolatedNetworkNamespacePath(): string | undefined {
  let pid1Namespace: string | undefined;
  try {
    pid1Namespace = readlinkSync('/proc/1/ns/net');
  } catch {
    pid1Namespace = undefined;
  }
  try {
    return nativeOwnedPostgresIsolation({
      pid: process.pid,
      interfaceNames: networkInterfaceNames(),
      ownNamespace: readlinkSync('/proc/self/ns/net'),
      pid1Namespace,
    });
  } catch {
    return undefined;
  }
}
