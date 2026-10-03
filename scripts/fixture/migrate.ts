import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { NameRegistry } from '../../services/main/src/modules/address/registry.ts';
import { migrateGraphNames } from '../../services/main/src/modules/address/migrate.ts';
import { migrateOwners } from '../ops/migrate.ts';
import { S3ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';

/** Dev, fixture restore and release share the same locked, idempotent SQL runner.
 * A release artifact supplies its own root to this runner through installRelease. */
export async function migrateFixtureOwners(apps: Record<string, string>): Promise<string[]> {
  return migrateOwners({
    ...apps,
    MAIN_RELAY_DATABASE_URL: apps.MAIN_RELAY_DATABASE_URL ?? apps.ACCOUNT_RELAY_DATABASE_URL,
  });
}

export interface OwnerMigrationEvidence {
  owner: 'graph-names';
  status: 'complete' | 'deferred';
  reason?: string;
}

/** Data migrations run after SQL and graph initialization in both entrypoints.
 * A returned deferral is evidence, never an implicitly successful installation. */
export async function migrateOwnerData(
  apps: Record<string, string>,
): Promise<OwnerMigrationEvidence[]> {
  const pool = new Pool({
    connectionString: apps.ACCESS_DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const workObjects = apps.MAIN_S3_ENDPOINT
      ? new S3ImmutableObjects({
          endpoint: apps.MAIN_S3_ENDPOINT,
          bucket: apps.MAIN_S3_BUCKET!,
          region: apps.MAIN_S3_REGION,
          accessKeyId: apps.MAIN_S3_ACCESS_KEY!,
          secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
          prefix: 'semantic/work/',
        })
      : undefined;
    if (workObjects) await workObjects.initialize();
    const result = await migrateGraphNames({
      fuseki: new FusekiClient(
        apps.FUSEKI_URL!,
        apps.FUSEKI_MAINTENANCE_TOKEN,
        apps.FUSEKI_COMMAND_TOKEN,
      ),
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      addresses: new NameRegistry(pool),
      objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      ...(workObjects ? { workObjects } : {}),
    });
    return [
      {
        owner: 'graph-names',
        status: result.status,
        ...(result.status === 'deferred'
          ? {
              reason:
                'Graph-name import is incomplete; resolve the reported import error and rerun owner migrations',
            }
          : {}),
      },
    ];
  } finally {
    await pool.end();
  }
}

export function assertOwnerMigrationsComplete(evidence: readonly OwnerMigrationEvidence[]): void {
  const deferred = evidence.filter((migration) => migration.status === 'deferred');
  if (deferred.length)
    throw new Error(
      `Owner migrations deferred: ${deferred
        .map((migration) => `${migration.owner}: ${migration.reason}`)
        .join('; ')}`,
    );
}
