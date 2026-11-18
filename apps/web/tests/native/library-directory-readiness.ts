import { Pool } from 'pg';
import type { OwnerIndexFrontier } from '../../../../services/kernel/src/library/owner-index.ts';
import { routeOf } from '../../../../services/kernel/src/route/route.ts';
import { createWorkClient } from '../../../../services/kernel/src/work/client.ts';
import { settledWithin } from './lifecycle.ts';
import type { NativeWebStack } from './stack.ts';

/** Bring the isolated owner's real index and accepted profile metadata to directory readiness. */
export async function prepareLibraryDirectory(stack: NativeWebStack, accountId: string, signal: AbortSignal) {
  const pool = new Pool({
    connectionString: stack.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1_500,
    query_timeout: 5_000,
  });
  const deadline = Date.now() + 60_000;
  // Use the same registered owner-index work as the periodic sweep and released-discovery fixture.
  const workflowName = 'library.ownerIndex';
  try {
    const work = await createWorkClient(stack.databaseUrl);
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const { rows } = await pool.query<{ frontier: OwnerIndexFrontier | null; pendingPin: boolean }>(
          `SELECT (
             SELECT jsonb_build_object('phase', phase, 'subject', after_subject, 'fact', after_fact)
             FROM library.owner_index_control WHERE route=$1 AND account_id=$2
           ) AS frontier, EXISTS (
             SELECT 1 FROM library.owner_index_pin WHERE route=$1 AND account_id=$2 AND NOT meaning_ready
           ) AS "pendingPin"`,
          [routeOf(accountId), accountId],
        );
        const { frontier: observed, pendingPin } = rows[0]!;
        // The installed workflow compares the serialized frontier against its own ordered projection.
        const frontier = observed && { phase: observed.phase, subject: observed.subject, fact: observed.fact };
        const metadata = frontier?.phase === 'ready';
        if (metadata && !pendingPin) return;

        // A racing sweep can advance the observed frontier. The worker fences the exact owner and frontier.
        const stage = metadata ? 'accepted profile metadata' : `owner index ${frontier?.phase ?? 'start'}`;
        // This setup waits for each page. Dispatch it on the worker's general queue so scheduled
        // partition sweeps on maintenance cannot hold its turn. The owner workflow still enqueues its own successors.
        const handle = await work.enqueue(
          { workflowName, queueName: 'workflows', workflowID: `${workflowName}:native-web:${crypto.randomUUID()}` },
          { accounts: [accountId], frontier, metadata },
        );
        const completed = await settledWithin(handle.getResult().then(() => true), Math.max(0, deadline - Date.now()));
        if (!completed) throw new Error(`Collections setup timed out in ${workflowName} at ${stage}`);
      }
      throw new Error(`Collections setup timed out checking ${workflowName} readiness`);
    } finally {
      await work.close();
    }
  } finally {
    await pool.end();
  }
}
