import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { AccessAccount, AuthService, InvalidationReceipt, TrustedAccessPorts } from './index.ts';

/** Mirrors the kernel Access binding: a fenced account of either kind, with its fence flag and floor. */
type FencedAccountPort = { readFencedAccount(accountId: string): Promise<AccessAccount | null> };

type Progress = {
  operation_id: string;
  client_id: string;
  scopes: string[];
  first_party: boolean;
  after_account: string;
  terminal_account: string | null;
  completed: boolean;
};

type ReductionOwner = { clientId: string; operationId: string; accountId: string };

async function advanceReductionOwner(connection: PoolClient, row: Progress, input: ReductionOwner, deny: () => never) {
  const acknowledged = (
    await connection.query<{ done: boolean }>('SELECT $1::text <= $2::text AS done', [
      input.accountId,
      row.after_account,
    ])
  ).rows[0]!.done;
  if (acknowledged) return;
  const next = (
    await connection.query<{ account_id: string }>(
      'SELECT account_id FROM auth_consent WHERE client_id=$1 AND account_id>$2 ORDER BY account_id LIMIT 1',
      [input.clientId, row.after_account],
    )
  ).rows[0];
  if (next?.account_id !== input.accountId) deny();
  await connection.query('UPDATE auth_client_reduction_progress SET after_account=$2 WHERE operation_id=$1', [
    input.operationId,
    input.accountId,
  ]);
}

/** Deleted owners cannot use tokens, but their retained consent still occupies the cursor. */
export async function completeDeletedClientReductionOwner(
  pool: Pool,
  readAccount: (accountId: string) => Promise<{ accountId: string; state: string } | null>,
  input: ReductionOwner,
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
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`auth-client:${input.clientId}`]);
    const row = (
      await connection.query<Progress>(
        'SELECT * FROM auth_client_reduction_progress WHERE operation_id=$1 FOR UPDATE',
        [input.operationId],
      )
    ).rows[0];
    if (!row || row.client_id !== input.clientId || row.completed) deny();
    await advanceReductionOwner(connection, row, input, deny);
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
         WHERE c.client_id=$1 AND v.ready AND NOT EXISTS
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
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`auth-client:${clientId}`]);
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
          `INSERT INTO auth_client_reduction_progress (operation_id,client_id,scopes,first_party) VALUES ($1,$2,$3,$4)
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
        if (row.completed || row.after_account !== input.after) deny();
        // Keep the cursor as a one-row outer input so the page uses a parameterized
        // seek on auth_consent_client_owner even when a sequential scan looks cheaper.
        const rows = (
          await connection.query<{ account_id: string }>(
            `SELECT page.account_id
             FROM (SELECT $1::text AS client_id,$2::text AS after_account OFFSET 0) cursor
             CROSS JOIN LATERAL (
               SELECT consent.account_id FROM auth_consent consent
               WHERE consent.client_id=cursor.client_id AND consent.account_id>cursor.after_account
               ORDER BY consent.account_id LIMIT $3
             ) page`,
            [input.clientId, input.after, input.limit + 1],
          )
        ).rows;
        const items = rows.slice(0, input.limit).map((r) => r.account_id);
        await connection.query('UPDATE auth_client_reduction_progress SET page_after=$2 WHERE operation_id=$1', [
          input.operationId,
          input.after,
        ]);
        if (rows.length <= input.limit)
          await connection.query(
            'UPDATE auth_client_reduction_progress SET terminal_account=$2 WHERE operation_id=$1',
            [input.operationId, items.at(-1) ?? input.after],
          );
        return { items, next: rows.length > input.limit ? items.at(-1)! : null };
      });
    },
    async completeClientReductionOwner(input) {
      await transaction(input.clientId, async (connection) => {
        const row = await progress(connection, input.clientId, input.operationId);
        if (row.completed) deny();
        const receipt = input.barrier;
        const current = await readFenced(input.accountId);
        if (
          !current ||
          current.accountId !== input.accountId ||
          !current.fenced ||
          receipt.accountId !== input.accountId ||
          !receipt.receiptId ||
          !Number.isSafeInteger(receipt.minimumAuthnEpoch) ||
          receipt.minimumAuthnEpoch < 1 ||
          current.authnEpoch < receipt.minimumAuthnEpoch
        )
          deny();
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
        await advanceReductionOwner(connection, row, input, deny);
      });
    },
    async finishClientReduction(input) {
      await transaction(input.clientId, async (connection) => {
        const row = await progress(connection, input.clientId, input.operationId);
        same(row, input);
        if (row.completed) return;
        if (row.terminal_account === null || row.after_account !== row.terminal_account) deny();
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
        await connection.query('UPDATE auth_client_reduction_progress SET completed=true WHERE operation_id=$1', [
          input.operationId,
        ]);
        await connection.query('DELETE FROM auth_client_reduction WHERE client_id=$1 AND operation_id=$2', [
          input.clientId,
          input.operationId,
        ]);
      });
    },
    async backfillClientIssuance(input) {
      bounded(input.limit);
      return transaction(input.clientId, async (connection) => {
        const coverage = (
          await connection.query<{
            after_account: string;
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
          await connection.query<{ id: string }>('SELECT id FROM "user" WHERE id>$1 ORDER BY id LIMIT $2', [
            coverage.after_account,
            input.limit + 1,
          ])
        ).rows;
        const items = rows.slice(0, input.limit).map((r) => r.id);
        if (coverage.first_party && items.length)
          await connection.query(
            `INSERT INTO auth_consent (account_id,client_id,scopes)
            SELECT id,$2,$3 FROM unnest($1::text[]) id ON CONFLICT (account_id,client_id) DO NOTHING`,
            [items, input.clientId, coverage.scopes],
          );
        const next = rows.length > input.limit ? items.at(-1)! : null;
        const ready = next === null && coverage.drained;
        await connection.query('UPDATE auth_client_coverage SET after_account=$2,ready=$3 WHERE client_id=$1', [
          input.clientId,
          items.at(-1) ?? coverage.after_account,
          ready,
        ]);
        return { next, ready };
      });
    },
  };
  // A host that binds the fenced read gets one point read for an account of either kind; a host without it keeps
  // the ordinary and recovery reads.
  async function readFenced(accountId: string) {
    const fenced = (access as TrustedAccessPorts & Partial<FencedAccountPort>).readFencedAccount;
    if (fenced) return fenced.call(access, accountId);
    return (await access.readAccount(accountId)) ?? (await access.readRecoveryAccount?.(accountId));
  }
  async function cleanupFencedSessions(accountId: string, barrier: InvalidationReceipt) {
    const current = await readFenced(accountId);
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
