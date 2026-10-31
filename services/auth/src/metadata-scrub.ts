import type { Pool, PoolClient } from 'pg';

export const metadataConfigurationStores = ['auth_client', 'oauthResource', 'oauthClientResource'] as const;
export type MetadataConfigurationStore = (typeof metadataConfigurationStores)[number];
export const METADATA_CONFIGURATION_WRITER = 1;
// Reserve room for the checkpoint and the existing old/new erasure-admission
// probes (client, owner, erased-client and obligation), plus native role-version
// guards on each mutation. Two outer keys keep the client branch below 48
// examined native keys, including an unknown-role counter and the checkpoint.
export const METADATA_CONFIGURATION_BATCH = 2;
export type MetadataScrubPending = {
  key: string | null;
  code:
    | 'locator-too-large'
    | 'website-authorization-metadata'
    | 'resource-claims'
    | 'provider-reference'
    | 'native-fence'
    | 'native-writer-version';
};
export type MetadataScrubPage = {
  store: MetadataConfigurationStore;
  examined: number;
  changed: number;
  pending: MetadataScrubPending[];
};

const stores = {
  auth_client: {
    table: 'auth_client',
    key: 'client_id',
    inspect: `SELECT (contacts IS NOT NULL OR name IS NOT NULL OR uri IS NOT NULL OR icon IS NOT NULL
      OR tos IS NOT NULL OR policy IS NOT NULL OR "softwareId" IS NOT NULL OR "softwareVersion" IS NOT NULL
      OR "softwareStatement" IS NOT NULL OR (metadata IS NOT NULL AND client_id<>'rezics-website')
      OR (display_name IS NOT NULL AND display_name_writer IS DISTINCT FROM 1)) AS dirty,
      (metadata IS NOT NULL AND client_id='rezics-website') AS authorization_metadata,
      ("referenceId" IS NOT NULL) AS reference FROM auth_client WHERE client_id=$1`,
    update: `UPDATE auth_client SET contacts=NULL,name=NULL,uri=NULL,icon=NULL,tos=NULL,policy=NULL,
      "softwareId"=NULL,"softwareVersion"=NULL,"softwareStatement"=NULL,
      metadata=CASE WHEN client_id='rezics-website' THEN metadata ELSE NULL END,
      display_name=CASE WHEN display_name_writer=1 THEN display_name ELSE NULL END
      WHERE client_id=$1`,
  },
  oauthResource: {
    table: '"oauthResource"',
    key: 'id',
    inspect: `SELECT (metadata IS NOT NULL OR name_writer IS NULL) AS dirty,
      ("customClaims" IS NOT NULL) AS claims FROM "oauthResource" WHERE id=$1`,
    update: `UPDATE "oauthResource" SET metadata=NULL,
      name=CASE WHEN name_writer=1 THEN name ELSE '' END WHERE id=$1`,
  },
  oauthClientResource: {
    table: '"oauthClientResource"',
    key: 'id',
    inspect: 'SELECT (metadata IS NOT NULL) AS dirty FROM "oauthClientResource" WHERE id=$1',
    update: 'UPDATE "oauthClientResource" SET metadata=NULL WHERE id=$1',
  },
} as const;

async function mutate(connection: PoolClient, store: MetadataConfigurationStore, key: string) {
  const row = (
    await connection.query<{
      dirty: boolean;
      authorization_metadata?: boolean;
      reference?: boolean;
      claims?: boolean;
    }>(stores[store].inspect, [key])
  ).rows[0];
  // No payload enters the process, and clean rows do not generate native writes.
  const changed = row?.dirty ? ((await connection.query(stores[store].update, [key])).rowCount ?? 0) : 0;
  return { row, changed };
}

/** One native store, one raw-PK page, no historical payload selected or parsed.
 * This resumable deployment cursor is neither coverage nor an erasure result.
 * Empty tails wrap so pending consumers are revisited after source replacement.
 */
export async function scrubMetadataConfigurationPage(
  database: Pool,
  store: MetadataConfigurationStore,
): Promise<MetadataScrubPage> {
  if (!metadataConfigurationStores.includes(store)) throw new Error('Unknown Auth configuration store');
  const selected = stores[store];
  const page: MetadataScrubPage = { store, examined: 0, changed: 0, pending: [] };
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      'INSERT INTO auth_metadata_scrub (store,writer_version) VALUES ($1,$2) ON CONFLICT (store) DO NOTHING',
      [store, METADATA_CONFIGURATION_WRITER],
    );
    const cursor = (
      await connection.query<{ after_key: string | null; writer_version: number }>(
        'SELECT after_key,writer_version FROM auth_metadata_scrub WHERE store=$1 FOR UPDATE',
        [store],
      )
    ).rows[0]!;
    if (cursor.writer_version !== METADATA_CONFIGURATION_WRITER) throw new Error('Auth configuration writer mismatch');
    // Separate first/continuation statements preserve a direct PK range scan.
    // Oversize locators return only NULL; never ship their bytes to the worker.
    const { rows } = await connection.query<{ key: string | null }>(
      `SELECT CASE WHEN octet_length(${selected.key})<=1024 THEN ${selected.key} END AS key
       FROM ${selected.table} ${cursor.after_key === null ? '' : `WHERE ${selected.key}>$1`}
       ORDER BY ${selected.key} LIMIT ${METADATA_CONFIGURATION_BATCH}`,
      cursor.after_key === null ? [] : [cursor.after_key],
    );
    let after = rows.length ? cursor.after_key : null;
    for (const { key } of rows) {
      page.examined++;
      if (key === null) {
        page.pending.push({ key: null, code: 'locator-too-large' });
        break;
      }
      await connection.query('SAVEPOINT configuration_key');
      try {
        const result = await mutate(connection, store, key);
        const row = result.row;
        page.changed += result.changed;
        if (row?.authorization_metadata) page.pending.push({ key, code: 'website-authorization-metadata' });
        if (row?.reference) page.pending.push({ key, code: 'provider-reference' });
        if (row?.claims) page.pending.push({ key, code: 'resource-claims' });
      } catch (error) {
        // Keep the original erasure guard, including old/new owner admission.
        // A fenced row belongs to its actual native erasure continuation.
        const refusal = error as { code?: string; message?: string };
        if (refusal.code !== '55000') throw error;
        const writer = refusal.message === 'Auth native role producer version refused';
        if (
          !writer &&
          !['Auth erasure fence', 'Auth erased client fence', 'Auth client erasure fence'].includes(
            refusal.message ?? '',
          )
        )
          throw error;
        await connection.query('ROLLBACK TO SAVEPOINT configuration_key');
        page.pending.push({ key, code: writer ? 'native-writer-version' : 'native-fence' });
      }
      await connection.query('RELEASE SAVEPOINT configuration_key');
      after = key;
    }
    await connection.query('UPDATE auth_metadata_scrub SET after_key=$2 WHERE store=$1', [store, after]);
    if (Buffer.byteLength(JSON.stringify(page)) > 64 * 1024) throw new Error('Auth configuration control bound');
    await connection.query('COMMIT');
    return page;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

/** Trusted deployment command context, scoped to its existing transaction.
 * Only a real registerClient invocation supplies this exact label value. */
export async function configureClientLabel(connection: PoolClient, clientId: string, label: string | null) {
  await connection.query(
    "SELECT set_config('auth.configuration_client',$1,true),set_config('auth.configuration_label',$2,true)",
    [clientId, label ?? ''],
  );
}
