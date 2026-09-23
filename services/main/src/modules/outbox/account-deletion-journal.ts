import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class AccountDeletionJournalConflict extends Error {}

interface Intent {
  outbox_id: string;
  principal_id: string;
  authority_epoch: string;
}

async function retain(relay: Pool, row: Intent): Promise<number> {
  const result = await relay.query(
    `INSERT INTO relay.account_deletion_intent (outbox_id, principal_id, authority_epoch)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [row.outbox_id, row.principal_id, row.authority_epoch]);
  const retained = await relay.query<Intent>(
    `SELECT outbox_id, principal_id, authority_epoch::text AS authority_epoch
     FROM relay.account_deletion_intent WHERE principal_id = $1`, [row.principal_id]);
  if (retained.rows.length !== 1
    || retained.rows[0]?.outbox_id !== row.outbox_id
    || retained.rows[0]?.authority_epoch !== row.authority_epoch) {
    throw new AccountDeletionJournalConflict('retained Account deletion intent conflicts with Access');
  }
  return result.rowCount ?? 0;
}

/** Account deletion cannot remove credentials until its exact Access intent is retained. */
export async function mirrorAccountDeletionIntent(
  access: Pool, relay: Pool, principalId: string, enforcementEpoch: string,
): Promise<void> {
  const source = await access.query<Intent>(
    `SELECT id AS outbox_id, principal_id, authority_epoch::text AS authority_epoch
     FROM access.outbox WHERE kind = 'account.deletion_fenced' AND principal_id = $1`,
    [principalId]);
  const row = source.rows[0];
  if (source.rows.length !== 1 || !row || row.authority_epoch !== enforcementEpoch) {
    throw new AccountDeletionJournalConflict('Account deletion intent differs from Access fence');
  }
  await retain(relay, row);
}

async function page(pool: Pool, owner: 'access' | 'relay', after: string | null): Promise<Intent[]> {
  const query = owner === 'access'
    ? `SELECT id AS outbox_id, principal_id, authority_epoch::text AS authority_epoch
       FROM access.outbox WHERE kind = 'account.deletion_fenced'
       AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 1000`
    : `SELECT outbox_id, principal_id, authority_epoch::text AS authority_epoch
       FROM relay.account_deletion_intent
       WHERE ($1::uuid IS NULL OR outbox_id > $1::uuid) ORDER BY outbox_id LIMIT 1000`;
  return (await pool.query<Intent>(query, [after])).rows;
}

/** Idempotent full scan avoids skipping transactions that commit out of UUID order. */
export async function mirrorAccountDeletionIntents(access: Pool, relay: Pool): Promise<number> {
  let after: string | null = null;
  let inserted = 0;
  while (true) {
    const rows = await page(access, 'access', after);
    for (const row of rows) {
      inserted += await retain(relay, row);
      after = row.outbox_id;
    }
    if (rows.length < 1000) break;
  }
  return inserted;
}

async function digest(pool: Pool, owner: 'access' | 'relay') {
  const hash = createHash('sha256');
  let after: string | null = null;
  let count = 0n;
  while (true) {
    const rows = await page(pool, owner, after);
    for (const row of rows) {
      hash.update(JSON.stringify([row.outbox_id, row.principal_id, row.authority_epoch]));
      hash.update('\n');
      after = row.outbox_id;
      count++;
    }
    if (rows.length < 1000) break;
  }
  return { count: count.toString(), digest: hash.digest('hex') };
}

/** Run under external writer quiescence or with Access's recovery fence held. */
export async function assertAccountDeletionJournalCoverage(
  access: Pool, relay: Pool,
): Promise<void> {
  const source = await digest(access, 'access');
  const retained = await digest(relay, 'relay');
  if (source.count !== retained.count || source.digest !== retained.digest) {
    throw new AccountDeletionJournalConflict('retained Account deletion journal differs from Access');
  }
}
