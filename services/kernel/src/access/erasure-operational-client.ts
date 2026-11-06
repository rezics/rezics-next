import { bindExecutionContract } from '../command/execution-contract.ts';
import { historyExecutionPort } from '../history/application/index.ts';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { workExecutionPort } from '../work/selected-runtime.ts';
import type { Pool } from 'pg';

export type ErasureOperationalClient = WorkClient & { readonly executionContract: object };

/** History must already be installed by the process composition root.
 * This binds the actual Pool to Work and History before any operational evaluation.
 */
export async function openErasureOperationalClient(pool: Pool): Promise<ErasureOperationalClient> {
  const url = pool.options.connectionString;
  if (!url) throw new TypeError('Erasure operational work requires the pool connection string');
  const client = await createWorkClient(url, pool);
  try {
    return bindExecutionContract(client, workExecutionPort(), historyExecutionPort);
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** Always release the client this attempt opened, including after a failed body. */
export async function withErasureOperationalClient<T>(
  pool: Pool,
  body: (client: ErasureOperationalClient) => Promise<T>,
) {
  const client = await openErasureOperationalClient(pool);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}
