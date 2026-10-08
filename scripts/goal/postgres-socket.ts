import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** Linux `sun_path` is 108 bytes including the terminating NUL.
 * https://man7.org/linux/man-pages/man7/unix.7.html */
export const POSTGRES_SOCKET_LIMIT = 107;
/** Longest socket file an owner gate binds. The port is five digits. */
export const postgresSocketSuffix = '/.temp/pg-sock/.s.PGSQL.65535';

/** The path PostgreSQL would bind, following the existing parent when `path` is not created yet. */
export function physicalPath(path: string): string {
  let parent = resolve(path);
  while (!existsSync(parent)) parent = dirname(parent);
  return resolve(realpathSync(parent), relative(parent, resolve(path)));
}

export function postgresSocketPath(checkout: string): string {
  return checkout + postgresSocketSuffix;
}

export function postgresSocketByteLength(checkout: string): number {
  return Buffer.byteLength(postgresSocketPath(checkout));
}

/** Names the socket path and its byte length when the checkout cannot bind one. */
export function postgresSocketRefusal(checkout: string): string | undefined {
  const path = postgresSocketPath(checkout);
  const bytes = Buffer.byteLength(path);
  if (bytes <= POSTGRES_SOCKET_LIMIT) return undefined;
  return `runner configuration: PostgreSQL socket path is ${bytes} bytes, above the ${POSTGRES_SOCKET_LIMIT}-byte limit: ${path}`;
}
