import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { AUTH_CURSOR_VERSION, requireErasureCursorVersion } from './erasure-cursor-cutover.ts';
import type { AuthService, InvalidationReceipt, TrustedAccessPorts } from './index.ts';
import { createHash } from 'node:crypto';

type Progress = {
  operation_id: string;
  client_id: string;
  scopes: string[];
  first_party: boolean;
  after_ordinal: string;
  page_end: string;
  terminal_ordinal: string | null;
  completed: boolean;
  page_after: string;
  consumer_version: number;
  page_count: number | null;
  completed_count: number;
};

type ReductionOwner = { clientId: string; operationId: string; accountId: string };

async function advanceReductionOwner(
  connection: PoolClient,
  row: Progress,
  input: ReductionOwner,
  deny: () => never,
  allowMissing = false,
) {
  const owner = (
    await connection.query<{ traversal_ordinal: string }>(
      // Keep the native binding stable through acknowledgement. Requiring the
      // heap tuple also prevents an index-only scan of every ordinal for a client.
      'SELECT traversal_ordinal FROM auth_consent WHERE client_id=$1 AND account_id=$2 FOR KEY SHARE',
      [input.clientId, input.accountId],
    )
  ).rows[0];
  // A removed native row has no surviving identity-to-ordinal binding. The next
  // page/finish verifies the empty ordinal interval before accepting its boundary.
  if (!owner) {
    if (!allowMissing) deny();
    return;
  }
  if (BigInt(owner.traversal_ordinal) <= BigInt(row.after_ordinal)) return;
  const next = (
    await connection.query<{ account_id: string }>(
      `SELECT account_id FROM auth_consent WHERE client_id=$1 AND traversal_ordinal>$2
       ORDER BY traversal_ordinal LIMIT 1`,
      [input.clientId, row.after_ordinal],
    )
  ).rows[0];
  if (next?.account_id !== input.accountId) deny();
  await connection.query(
    'UPDATE auth_client_reduction_progress SET after_ordinal=$2,completed_count=completed_count+1 WHERE operation_id=$1',
    [input.operationId, owner.traversal_ordinal],
  );
}

async function admitNativeReduction(
  connection: PoolClient,
  clientId: string,
  operationId: string,
  obligationId: string,
) {
  const admitted = await connection.query(
    `SELECT 1 FROM auth_erased_client c
    JOIN auth_erasure e ON e.id=c.obligation_id
    JOIN auth_client_reduction_progress p ON p.client_id=c.client_id
    JOIN auth_client_reduction g ON g.client_id=p.client_id AND g.operation_id=p.operation_id
    WHERE c.client_id=$1 AND p.operation_id=$2 AND e.id=$3 AND NOT p.completed`,
    [clientId, operationId, obligationId],
  );
  if (!admitted.rowCount) throw new Error('Native client reduction obligation refused');
  await connection.query("SELECT set_config('auth.erasure_obligation',$1,true)", [obligationId]);
}

/** Deleted owners cannot use tokens, but their retained consent still occupies the cursor. */
export async function completeDeletedClientReductionOwner(
  pool: Pool,
  readAccount: (accountId: string) => Promise<{ accountId: string; state: string } | null>,
  input: ReductionOwner,
  obligationId?: string,
): Promise<boolean> {
  const deny: () => never = () => {
    throw new Error('Client reduction owner denied');
  };
  const current = await readAccount(input.accountId);
  if (!current || current.accountId !== input.accountId) deny();
  if (current.state !== 'deleted') return false;
  // Deletion is terminal. Once observed, no new floor, receipt or Auth cleanup
  // is needed; retain the same client lock and next-owner check as barrier completion.
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await requireErasureCursorVersion(connection, AUTH_CURSOR_VERSION, input.clientId);
    if (obligationId) await admitNativeReduction(connection, input.clientId, input.operationId, obligationId);
    const row = (
      await connection.query<Progress>(
        'SELECT * FROM auth_client_reduction_progress WHERE operation_id=$1 FOR UPDATE',
        [input.operationId],
      )
    ).rows[0];
    if (!row || row.client_id !== input.clientId || row.completed) deny();
    await advanceReductionOwner(connection, row, input, deny, true);
    await connection.query('COMMIT');
    return true;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

/** Native client consent/issuance authority; no account/profile facts live here. */
export function clientAuthority(
  pool: Pool,
  access: TrustedAccessPorts,
  deny: () => never,
  normalize: (value: unknown) => string[],
) {
  const issuance = new AsyncLocalStorage<{ clientId: string; connection: PoolClient }>();
  const nativeReduction = new AsyncLocalStorage<{ operationId: string; obligationId: string }>();
  // Route both native Better Auth and our hooks through the held connection.
  // A request never holds one pool slot while waiting for a second slot.
  const database = new Proxy(pool, {
    get(target, property) {
      const held = issuance.getStore()?.connection;
      if (held && property === 'query') return held.query.bind(held);
      if (held && property === 'connect')
        return async () =>
          new Proxy(held, {
            get(client, key) {
              if (key === 'release') return () => {};
              const value = Reflect.get(client, key);
              return typeof value === 'function' ? value.bind(client) : value;
            },
          });
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  async function withIssuance<T>(clientId: string, action: () => Promise<T>): Promise<T> {
    if (issuance.getStore()) {
      if (issuance.getStore()!.clientId !== clientId) deny();
      return action();
    }
    const connection = await pool.connect();
    let locked = false;
    try {
      await connection.query('SELECT pg_advisory_lock_shared(hashtextextended($1, 0))', [`auth-client:${clientId}`]);
      locked = true;
      const admitted = await connection.query(
        `SELECT c.client_id FROM auth_client c JOIN auth_client_coverage v USING (client_id)
         WHERE c.client_id=$1 AND v.ready AND NOT c.erasure_fenced AND NOT EXISTS
         (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=c.client_id)`,
        [clientId],
      );
      if (!admitted.rowCount) deny();
      return await issuance.run({ clientId, connection }, action);
    } finally {
      try {
        if (locked)
          await connection.query('SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))', [
            `auth-client:${clientId}`,
          ]);
      } catch (error) {
        connection.release(true);
        throw error;
      }
      connection.release();
    }
  }
  async function materialize(accountId: string, clientId: string, scopes: string[], firstParty: boolean) {
    if (issuance.getStore()?.clientId !== clientId) deny();
    if (firstParty)
      await database.query(
        `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
         ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes
         WHERE auth_consent.pending_reference IS NULL`,
        [accountId, clientId, scopes],
      );
  }
  async function withConsent<T>(
    accountId: string,
    clientId: string,
    action: (connection: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (issuance.getStore()?.clientId !== clientId) deny();
    const connection = await database.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `auth-consent:${accountId}:${clientId}`,
      ]);
      const value = await action(connection);
      await connection.query('COMMIT');
      return value;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async function transaction<T>(clientId: string, action: (connection: PoolClient) => Promise<T>): Promise<T> {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        "SELECT set_config('auth.cursor_worker','2',true),pg_advisory_xact_lock(hashtextextended($1,0))",
        [`auth-client:${clientId}`],
      );
      const native = nativeReduction.getStore();
      if (native) await admitNativeReduction(connection, clientId, native.operationId, native.obligationId);
      const value = await action(connection);
      await connection.query('COMMIT');
      return value;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async function progress(connection: PoolClient, clientId: string, operationId: string): Promise<Progress> {
    const row = (
      await connection.query<Progress>(
        'SELECT * FROM auth_client_reduction_progress WHERE operation_id=$1 FOR UPDATE',
        [operationId],
      )
    ).rows[0];
    if (!row || row.client_id !== clientId) return deny();
    return row;
  }
  function same(row: Progress, input: { scopes: string[]; firstParty: boolean }) {
    if (row.first_party !== input.firstParty || JSON.stringify(row.scopes) !== JSON.stringify(normalize(input.scopes)))
      deny();
  }
  const bounded = (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) deny();
  };
  const internal: Pick<
    AuthService['internal'],
    | 'beginClientReduction'
    | 'clientReductionPage'
    | 'completeClientReductionOwner'
    | 'finishClientReduction'
    | 'backfillClientIssuance'
    | 'continueNativeClientReduction'
  > = {
    async beginClientReduction(input) {
      const granted = normalize(input.scopes);
      if (!input.operationId || typeof input.firstParty !== 'boolean') deny();
      await transaction(input.clientId, async (connection) => {
        const coverage = await connection.query(
          'SELECT client_id FROM auth_client_coverage WHERE client_id=$1 AND ready',
          [input.clientId],
        );
        if (!coverage.rowCount) deny();
        await connection.query(
          `INSERT INTO auth_client_reduction_progress (operation_id,client_id,scopes,first_party,consumer_version) VALUES ($1,$2,$3,$4,1)
           ON CONFLICT (operation_id) DO NOTHING`,
          [input.operationId, input.clientId, granted, input.firstParty],
        );
        const row = await progress(connection, input.clientId, input.operationId);
        same(row, input);
        if (row.completed) return;
        const client = (
          await connection.query<{ scopes: string[]; first_party: boolean }>(
            'SELECT scopes,first_party FROM auth_client WHERE client_id=$1 FOR UPDATE',
            [input.clientId],
          )
        ).rows[0];
        if (!client || granted.some((s) => !client.scopes.includes(s)) || (!client.first_party && input.firstParty))
          deny();
        const gate = (
          await connection.query<{ operation_id: string }>(
            `INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party) VALUES ($1,$2,$3,$4)
           ON CONFLICT (client_id) DO UPDATE SET client_id=EXCLUDED.client_id RETURNING operation_id`,
            [input.clientId, input.operationId, granted, input.firstParty],
          )
        ).rows[0]!;
        if (gate.operation_id !== input.operationId) deny();
      });
    },
    async clientReductionPage(input) {
      bounded(input.limit);
      return transaction(input.clientId, async (connection) => {
        const row = await progress(connection, input.clientId, input.operationId);
        const after = input.after === '' ? '0' : input.after;
        if (!/^(0|[1-9][0-9]*)$/.test(after) || row.completed) deny();
        if (row.after_ordinal !== after) {
          // Owners can disappear after a page was returned. Accept its boundary
          // only when no unacknowledged owner remains in the interval.
          if (after !== row.page_end || BigInt(after) < BigInt(row.after_ordinal)) deny();
          const pending = await connection.query(
            `SELECT 1 FROM auth_consent WHERE client_id=$1 AND traversal_ordinal>$2
             AND traversal_ordinal<=$3 LIMIT 1`,
            [input.clientId, row.after_ordinal, after],
          );
          if (pending.rowCount) deny();
        }
        if (
          row.consumer_version === 1 &&
          row.page_count !== null &&
          after === row.page_end &&
          row.completed_count !== row.page_count
        )
          deny();
        const rows = (
          await connection.query<{ account_id: string; traversal_ordinal: string }>(
            `WITH RECURSIVE batches(batch_no,boundary,items) AS (
               SELECT 1,COALESCE(batch.last_ordinal,$2::bigint),batch.items
               FROM LATERAL (
                 SELECT max(page.traversal_ordinal) AS last_ordinal,
                        COALESCE(jsonb_agg(jsonb_build_array(page.account_id,page.traversal_ordinal)
                          ORDER BY page.traversal_ordinal),'[]'::jsonb) AS items
                 FROM (
                   SELECT account_id,traversal_ordinal FROM auth_consent
                   WHERE client_id=$1 AND traversal_ordinal>$2
                   ORDER BY client_id,traversal_ordinal LIMIT 8
                 ) page
               ) batch
               UNION ALL
               SELECT batches.batch_no+1,COALESCE(batch.last_ordinal,batches.boundary),batch.items
               FROM batches
               CROSS JOIN LATERAL (
                 SELECT max(page.traversal_ordinal) AS last_ordinal,
                        COALESCE(jsonb_agg(jsonb_build_array(page.account_id,page.traversal_ordinal)
                          ORDER BY page.traversal_ordinal),'[]'::jsonb) AS items
                 FROM (
                   SELECT account_id,traversal_ordinal FROM auth_consent
                   WHERE client_id=$1 AND traversal_ordinal>batches.boundary
                   ORDER BY client_id,traversal_ordinal LIMIT 8
                 ) page
               ) batch
               WHERE batches.batch_no<(($3::integer+7)/8)
             )
             SELECT (item->>0) AS account_id,(item->>1) AS traversal_ordinal
             FROM batches CROSS JOIN LATERAL jsonb_array_elements(batches.items) item
             ORDER BY (item->>1)::bigint LIMIT $3`,
            [input.clientId, after, input.limit + 1],
          )
        ).rows;
        const page = rows.slice(0, input.limit);
        await connection.query(
          `UPDATE auth_client_reduction_progress SET after_ordinal=$2,page_after=$2,page_end=$4,
           terminal_ordinal=CASE WHEN $3 THEN $4::bigint ELSE terminal_ordinal END,page_count=$5,completed_count=0 WHERE operation_id=$1`,
          [input.operationId, after, rows.length <= input.limit, page.at(-1)?.traversal_ordinal ?? after, page.length],
        );
        return {
          items: page.map((r) => r.account_id),
          next: rows.length > input.limit ? page.at(-1)!.traversal_ordinal : null,
        };
      });
    },
    async completeClientReductionOwner(input) {
      const current = await access.readFencedAccount(input.accountId);
      await transaction(input.clientId, async (connection) => {
        const row = await progress(connection, input.clientId, input.operationId);
        if (row.completed) deny();
        const receipt = input.barrier;
        if (current && (current.accountId !== input.accountId || !current.fenced)) deny();
        const consent = await connection.query(
          'SELECT account_id FROM auth_consent WHERE account_id=$1 AND client_id=$2',
          [input.accountId, input.clientId],
        );
        let deletedOwner = current?.state === 'deleted';
        if (!current) {
          if (consent.rowCount) {
            const scheduled = await connection.query(
              'SELECT account_id FROM auth_consent_erasure WHERE account_id=$1',
              [input.accountId],
            );
            if (!scheduled.rowCount) deny();
          }
          // An erased owner's last consent may already have been removed, which
          // also clears the due marker before this owner step is replayed.
          deletedOwner = true;
        }
        if (
          !deletedOwner &&
          (receipt.accountId !== input.accountId ||
            !receipt.receiptId ||
            !Number.isSafeInteger(receipt.minimumAuthnEpoch) ||
            receipt.minimumAuthnEpoch < 1 ||
            current!.authnEpoch < receipt.minimumAuthnEpoch)
        )
          deny();
        if (!deletedOwner) {
          const saved = (
            await connection.query<{ account_id: string; purpose: string; minimum_authn_epoch: number }>(
              'SELECT account_id,purpose,minimum_authn_epoch FROM auth_effect_receipt WHERE receipt_id=$1',
              [receipt.receiptId],
            )
          ).rows[0]!;
          if (
            !saved ||
            saved.account_id !== input.accountId ||
            saved.purpose !== 'client-reduction' ||
            saved.minimum_authn_epoch !== receipt.minimumAuthnEpoch
          )
            deny();
        }
        await advanceReductionOwner(connection, row, input, deny, deletedOwner || !consent.rowCount);
      });
    },
    async finishClientReduction(input) {
      await transaction(input.clientId, async (connection) => {
        const row = await progress(connection, input.clientId, input.operationId);
        same(row, input);
        if (row.completed) return;
        if (row.terminal_ordinal === null || (row.consumer_version === 1 && row.page_count !== row.completed_count))
          deny();
        if (row.after_ordinal !== row.terminal_ordinal) {
          const pending = await connection.query(
            `SELECT 1 FROM auth_consent WHERE client_id=$1 AND traversal_ordinal>$2
             AND traversal_ordinal<=$3 LIMIT 1`,
            [input.clientId, row.after_ordinal, row.terminal_ordinal],
          );
          if (pending.rowCount) deny();
        }
        const gate = await connection.query(
          'SELECT client_id FROM auth_client_reduction WHERE client_id=$1 AND operation_id=$2',
          [input.clientId, input.operationId],
        );
        if (!gate.rowCount) deny();
        await connection.query('UPDATE auth_client SET scopes=$2,first_party=$3 WHERE client_id=$1', [
          input.clientId,
          row.scopes,
          row.first_party,
        ]);
        await connection.query(
          'UPDATE auth_client_reduction_progress SET completed=true,after_ordinal=terminal_ordinal WHERE operation_id=$1',
          [input.operationId],
        );
        await connection.query(
          'UPDATE auth_workflow_request SET terminal_at=COALESCE(terminal_at,clock_timestamp()) WHERE workflow_id=$1',
          [input.operationId],
        );
        await connection.query('DELETE FROM auth_client_reduction WHERE client_id=$1 AND operation_id=$2', [
          input.clientId,
          input.operationId,
        ]);
      });
    },
    async continueNativeClientReduction(input, ports) {
      const row = (
        await pool.query<Progress>('SELECT * FROM auth_client_reduction_progress WHERE operation_id=$1', [
          input.operationId,
        ])
      ).rows[0];
      if (!row || row.completed || row.consumer_version !== 1) return false;
      // The current original page determines every source command key. Never
      // reconstruct a page from history or start a different operation.
      const next = (
        await pool.query<{ account_id: string }>(
          `SELECT account_id FROM auth_consent
        WHERE client_id=$1 AND traversal_ordinal>$2 AND traversal_ordinal<=$3
        ORDER BY traversal_ordinal LIMIT 1`,
          [row.client_id, row.after_ordinal, row.page_end],
        )
      ).rows[0];
      if (next) {
        const owner = { clientId: row.client_id, operationId: row.operation_id, accountId: next.account_id };
        if (await completeDeletedClientReductionOwner(pool, ports.readAccount, owner, input.obligationId)) return true;
        const pageWorkflowId =
          row.page_after === '0'
            ? row.operation_id
            : `${row.operation_id}:page:${createHash('sha256').update(JSON.stringify(row.page_after)).digest('hex')}`;
        const barrier = (
          await ports.raiseFence({ accountId: next.account_id, key: `wf:${pageWorkflowId}:fence:${next.account_id}` })
        ).value;
        await cleanupFencedSessions(next.account_id, {
          ...barrier,
          minimumAuthnEpoch: Number(barrier.minimumAuthnEpoch),
        });
        await nativeReduction.run(input, () =>
          internal.completeClientReductionOwner({
            ...owner,
            barrier: { ...barrier, minimumAuthnEpoch: Number(barrier.minimumAuthnEpoch) },
          }),
        );
        return true;
      }
      // An original raw row that disappeared without acknowledgement stays
      // unknown, even if the remaining ordinal interval is empty.
      if (row.page_count !== null && row.page_count !== row.completed_count) return false;
      if (row.terminal_ordinal !== null) {
        await nativeReduction.run(input, () =>
          internal.finishClientReduction({
            clientId: row.client_id,
            operationId: row.operation_id,
            scopes: row.scopes,
            firstParty: row.first_party,
          }),
        );
      } else {
        // Only one additional raw owner is admitted on this erasure page. The
        // producer's persisted page boundary preserves replay keys for old pages.
        await nativeReduction.run(input, () =>
          internal.clientReductionPage({
            clientId: row.client_id,
            operationId: row.operation_id,
            after: row.page_end,
            limit: 1,
          }),
        );
      }
      return true;
    },
    async backfillClientIssuance(input) {
      bounded(input.limit);
      return transaction(input.clientId, async (connection) => {
        const coverage = (
          await connection.query<{
            after_ordinal: string;
            ready: boolean;
            drained: boolean;
            first_party: boolean;
            scopes: string[];
          }>(
            `SELECT v.*,v.ready_after<=statement_timestamp() AS drained,c.first_party,c.scopes
           FROM auth_client_coverage v JOIN auth_client c USING (client_id) WHERE client_id=$1 FOR UPDATE OF v`,
            [input.clientId],
          )
        ).rows[0];
        if (!coverage) return deny();
        if (coverage.ready) return { next: null, ready: true };
        const rows = (
          await connection.query<{ id: string; traversal_ordinal: string }>(
            `WITH RECURSIVE page(id,traversal_ordinal,depth) AS (
               (SELECT id,traversal_ordinal,1 FROM "user"
                WHERE traversal_ordinal>$1 ORDER BY traversal_ordinal LIMIT 1)
               UNION ALL
               SELECT next.id,next.traversal_ordinal,page.depth+1
               FROM page
               CROSS JOIN LATERAL (
                 SELECT id,traversal_ordinal FROM "user"
                 WHERE traversal_ordinal>page.traversal_ordinal
                 ORDER BY traversal_ordinal LIMIT 1
               ) next
               WHERE page.depth<$2
             )
             SELECT id,traversal_ordinal FROM page ORDER BY traversal_ordinal`,
            [coverage.after_ordinal, input.limit + 1],
          )
        ).rows;
        const page = rows.slice(0, input.limit);
        const items = page.map((r) => r.id);
        if (coverage.first_party && items.length)
          await connection.query(
            `INSERT INTO auth_consent (account_id,client_id,scopes)
            SELECT id,$2,$3 FROM unnest($1::text[]) id ON CONFLICT (account_id,client_id) DO NOTHING`,
            [items, input.clientId, coverage.scopes],
          );
        const next = rows.length > input.limit ? page.at(-1)!.traversal_ordinal : null;
        const ready = next === null && coverage.drained;
        await connection.query('UPDATE auth_client_coverage SET after_ordinal=$2,ready=$3 WHERE client_id=$1', [
          input.clientId,
          page.at(-1)?.traversal_ordinal ?? coverage.after_ordinal,
          ready,
        ]);
        return { next, ready };
      });
    },
  };
  async function cleanupFencedSessions(accountId: string, barrier: InvalidationReceipt) {
    const current = await access.readFencedAccount(accountId);
    if (
      !current ||
      current.accountId !== accountId ||
      !current.fenced ||
      barrier.accountId !== accountId ||
      !barrier.receiptId ||
      !Number.isSafeInteger(barrier.minimumAuthnEpoch) ||
      barrier.minimumAuthnEpoch < 1 ||
      current.authnEpoch < barrier.minimumAuthnEpoch
    )
      deny();
    // Proof checks Access before releasing authority. Bound eager cleanup;
    // retained native rows cannot turn reduction into a history sweep.
    await transaction(`cleanup:${accountId}`, async (connection) => {
      const prior = (
        await connection.query<{ account_id: string; purpose: string; minimum_authn_epoch: number }>(
          'SELECT account_id,purpose,minimum_authn_epoch FROM auth_effect_receipt WHERE receipt_id=$1',
          [barrier.receiptId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.account_id !== accountId ||
          prior.purpose !== 'client-reduction' ||
          prior.minimum_authn_epoch !== barrier.minimumAuthnEpoch
        )
          deny();
        return;
      }
      const sessions = (
        await connection.query<{ id: string }>('SELECT id FROM session WHERE "userId"=$1 LIMIT 100', [accountId])
      ).rows.map((row) => row.id);
      if (sessions.length) await connection.query('DELETE FROM session WHERE id=ANY($1::text[])', [sessions]);
      await connection.query(
        `INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch)
        VALUES ($1,$2,'client-reduction',$3)`,
        [barrier.receiptId, accountId, barrier.minimumAuthnEpoch],
      );
    });
  }
  return { database, withIssuance, withConsent, materialize, internal, cleanupFencedSessions };
}
