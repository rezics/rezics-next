import type { Pool } from 'pg';

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type Backend = { pid: number; application_name: string; state: string | null; query: string };

/**
 * Drops test database `name` through `admin`, a pool or client connected to another database. `pool.end()` resolves
 * once its client list is empty, but each client's socket closes later, so a `FORCE` drop issued right after it
 * terminates a client that is still ending and that client raises an unhandled FATAL 57P01. This waits until no client
 * backend is connected to the database, then drops it. If one is still connected at the bound it throws, naming each
 * backend, and does not drop. Autovacuum and other non-client backends do not count: `FORCE` ends them.
 */
export async function dropTestDatabase(
  admin: Pick<Pool, 'query'>,
  name: string,
  options: { boundMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { boundMs = 10_000, pollMs = 50 } = options;
  const deadline = Date.now() + boundMs;
  for (;;) {
    const { rows } = await admin.query<Backend>(
      `SELECT pid, application_name, state, query FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND datname = $1 AND pid <> pg_backend_pid() ORDER BY pid`,
      [name],
    );
    if (rows.length === 0) break;
    if (Date.now() >= deadline) {
      const described = rows
        .map(
          (row) =>
            `pid ${row.pid} application_name ${JSON.stringify(row.application_name)} state ${row.state} query ${JSON.stringify(row.query)}`,
        )
        .join('; ');
      throw new Error(`Database ${name} still has ${rows.length} client backend(s) after ${boundMs} ms: ${described}`);
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
}
