import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';

export const DBOS_SCHEMA = 'dbos';
export const WORK_APPLICATION = 'rezics-kernel';
export type WorkClient = DBOSClient & { close(): Promise<void> };

/** Enqueue without launching an executor. A supplied pool remains the caller's responsibility. */
export async function createWorkClient(databaseUrl: string, pool?: Pool): Promise<WorkClient> {
  const client = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    applicationName: WORK_APPLICATION,
    systemDatabasePoolSize: 10,
    ...(pool === undefined ? {} : { systemDatabasePool: pool }),
    logger: { info() {}, debug() {}, warn: console.warn, error: console.error },
  });
  let closing: Promise<void> | undefined;
  return Object.assign(client, {
    close: () => (closing ??= client.destroy()),
  });
}
