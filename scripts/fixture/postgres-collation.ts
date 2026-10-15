import { Client, type ClientConfig } from 'pg';

export interface PostgresCollationRepair {
  database: string;
  recordedVersion: string | null;
  actualVersion: string | null;
  collations: { name: string; recordedVersion: string; actualVersion: string }[];
  reindexed: true;
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Only call against a disposable, recovered copy, before opening owner clients.
 * Refresh records metadata; it does not repair indexes. Rebuild first and fail
 * closed if rebuilding fails: https://www.postgresql.org/docs/18/sql-altercollation.html
 */
export async function repairCopiedPostgresCollations(connection: ClientConfig,
  report: (repair: PostgresCollationRepair) => void = repair =>
    console.info(`POSTGRES_COLLATION_REPAIR ${JSON.stringify(repair)}`),
): Promise<PostgresCollationRepair[]> {
  const config = (database: string): ClientConfig => {
    if (!connection.connectionString) return { ...connection, database, connectionTimeoutMillis: 5_000 };
    const url = new URL(connection.connectionString);
    url.pathname = `/${encodeURIComponent(database)}`;
    return { ...connection, connectionString: url.toString(), connectionTimeoutMillis: 5_000 };
  };
  const admin = new Client(config('postgres'));
  await admin.connect();
  const repairs: PostgresCollationRepair[] = [];
  try {
    // pg_ctl readiness can precede the end of physical recovery.
    for (let attempt = 0; ; attempt++) {
      if (!(await admin.query<{ recovering: boolean }>('SELECT pg_is_in_recovery() AS recovering')).rows[0]!.recovering) break;
      if (attempt >= 99) throw new Error('Copied PostgreSQL is still in recovery before collation repair');
      await Bun.sleep(100);
    }
    const databases = await admin.query<{
      database: string; allowed: boolean; recordedVersion: string | null; actualVersion: string | null;
    }>(`SELECT datname AS database, datallowconn AS allowed, datcollversion AS "recordedVersion",
        pg_database_collation_actual_version(oid) AS "actualVersion"
      FROM pg_database WHERE datname <> 'template0' ORDER BY datname`);
    for (const database of databases.rows) {
      const name = identifier(database.database);
      // Reusable templates can forbid ordinary connections. Restore their flag
      // after the temporary maintenance connection closes, including on failure.
      if (!database.allowed) await admin.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS true`);
      const client = new Client(config(database.database));
      try {
        await client.connect();
        // initdb imports hundreds of available ICU locales. Only collations
        // used by database objects need rebuilding after a library update.
        const collations = (await client.query<{
          schema: string; name: string; recordedVersion: string; actualVersion: string;
        }>(`SELECT n.nspname AS schema, c.collname AS name, c.collversion AS "recordedVersion",
            pg_collation_actual_version(c.oid) AS "actualVersion"
          FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
          WHERE c.collversion IS NOT NULL
            AND c.collversion IS DISTINCT FROM pg_collation_actual_version(c.oid)
            AND EXISTS (SELECT 1 FROM pg_depend d
              WHERE d.refclassid = 'pg_collation'::regclass AND d.refobjid = c.oid)
          ORDER BY n.nspname, c.collname`)).rows;
        if (database.recordedVersion === database.actualVersion && !collations.length) continue;
        await client.query(`REINDEX DATABASE ${name}`);
        for (const collation of collations) {
          await client.query(`ALTER COLLATION ${identifier(collation.schema)}.${identifier(collation.name)} REFRESH VERSION`);
        }
        await client.query(`ALTER DATABASE ${name} REFRESH COLLATION VERSION`);
        const repair: PostgresCollationRepair = {
          database: database.database, recordedVersion: database.recordedVersion, actualVersion: database.actualVersion,
          collations: collations.map(({ schema, name, recordedVersion, actualVersion }) =>
            ({ name: `${schema}.${name}`, recordedVersion, actualVersion })),
          reindexed: true,
        };
        repairs.push(repair);
        report(repair);
      } finally {
        await client.end();
        if (!database.allowed) await admin.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS false`);
      }
    }
    return repairs;
  } finally { await admin.end(); }
}
