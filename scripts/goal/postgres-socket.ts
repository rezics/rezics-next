import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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

/** A short alias points into the worktree: removing the worktree also removes
 * the actual socket directory. Cluster shutdown removes the now-unused alias. */
function ownedSocketDirectory(checkout: string, port: number): string {
  const owned = join(physicalPath(checkout), '.temp', 'pg-sock');
  if (Buffer.byteLength(join(owned, '.s.PGSQL.65535')) <= POSTGRES_SOCKET_LIMIT) return owned;
  return join(owned, String(port));
}

export function postgresSocketDirectory(checkout: string, aliasRoot = '/tmp', port = 65535): string {
  const owned = ownedSocketDirectory(checkout, port);
  if (Buffer.byteLength(join(owned, '.s.PGSQL.65535')) <= POSTGRES_SOCKET_LIMIT) return owned;
  const key = createHash('sha256').update(physicalPath(checkout)).digest('hex').slice(0, 24);
  // Each cluster removes only its alias, even while another is starting.
  return join(physicalPath(aliasRoot), `rezics-pg-${key}-${port}`);
}

export function postgresSocketPath(checkout: string, aliasRoot = '/tmp'): string {
  return join(postgresSocketDirectory(checkout, aliasRoot), '.s.PGSQL.65535');
}

export function postgresSocketByteLength(checkout: string): number {
  return Buffer.byteLength(postgresSocketPath(checkout));
}

/** Names the socket path and its byte length when the checkout cannot bind one. */
export function postgresSocketRefusal(checkout: string, aliasRoot = '/tmp'): string | undefined {
  const path = postgresSocketPath(checkout, aliasRoot);
  const bytes = Buffer.byteLength(path);
  if (bytes <= POSTGRES_SOCKET_LIMIT) return undefined;
  return `runner configuration: PostgreSQL socket path is ${bytes} bytes, above the ${POSTGRES_SOCKET_LIMIT}-byte limit: ${path}`;
}

export function ensurePostgresSocketDirectory(checkout: string, aliasRoot = '/tmp', port = 65535): string {
  const refusal = postgresSocketRefusal(checkout, aliasRoot);
  if (refusal) throw new Error(refusal);
  const owned = ownedSocketDirectory(checkout, port);
  const directory = postgresSocketDirectory(checkout, aliasRoot, port);
  mkdirSync(owned, { recursive: true, mode: 0o700 });
  if (directory !== owned) {
    try { symlinkSync(owned, directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || !lstatSync(directory).isSymbolicLink() || readlinkSync(directory) !== owned) throw error;
    }
  }
  return directory;
}

export function releasePostgresSocketDirectory(checkout: string, aliasRoot = '/tmp', port = 65535): void {
  const owned = ownedSocketDirectory(checkout, port);
  const directory = postgresSocketDirectory(checkout, aliasRoot, port);
  if (directory === owned || (existsSync(owned) && readdirSync(owned).length)) return;
  try {
    if (lstatSync(directory).isSymbolicLink() && readlinkSync(directory) === owned) unlinkSync(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
