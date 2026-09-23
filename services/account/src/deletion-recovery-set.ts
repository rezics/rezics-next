import type { Pool } from 'pg';
import { capturePgRecoveryFrontier, assertPgRecoveryFrontier,
  type PgRecoveryFrontier } from '../../main/src/modules/work/pg-recovery-frontier.ts';
import { accessOutboxCoverage, accessStateCoverage } from
  '../../main/src/modules/work/access-recovery-coverage.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage,
  type AccountRecoveryCoverage } from './recovery-coverage.ts';

export class DeletionRecoveryConflict extends Error {}

export interface DeletionRecoverySet {
  version: 1;
  deletion: {
    issuer: string;
    accountSubject: string;
    accessPrincipalId: string;
    enforcementEpoch: string;
  };
  account: { pg: PgRecoveryFrontier; rows: AccountRecoveryCoverage };
  access: {
    pg: PgRecoveryFrontier;
    outbox: { count: string; digest: string };
    state: { count: string; digest: string };
  };
}

async function deletedBinding(account: Pool, access: Pool, issuer: string, subject: string) {
  if (!issuer || !subject) throw new DeletionRecoveryConflict('invalid deleted Account binding');
  const accountUser = await account.query('SELECT id FROM public."user" WHERE id = $1', [subject]);
  if (accountUser.rowCount !== 0) {
    throw new DeletionRecoveryConflict('Account subject remains present');
  }
  const principal = await access.query<{ id: string; active: boolean; enforcement_epoch: string }>(
    `SELECT id, active, enforcement_epoch FROM access.principal
     WHERE account_issuer = $1 AND account_subject = $2`, [issuer, subject]);
  const row = principal.rows[0];
  if (principal.rowCount !== 1 || !row || row.active || BigInt(row.enforcement_epoch) < 1n) {
    throw new DeletionRecoveryConflict('Access principal fence is absent');
  }
  const fact = await access.query<{ count: string }>(
    `SELECT count(*) AS count FROM access.outbox
     WHERE kind = 'principal.deactivated' AND principal_id = $1 AND authority_epoch = $2`,
    [row.id, row.enforcement_epoch]);
  if (fact.rows[0]?.count !== '1') {
    throw new DeletionRecoveryConflict('Access principal outbox fact is absent');
  }
  const deletionFact = await access.query<{ count: string }>(
    `SELECT count(*) AS count FROM access.outbox
     WHERE kind = 'account.deletion_fenced' AND principal_id = $1 AND authority_epoch = $2`,
    [row.id, row.enforcement_epoch]);
  if (deletionFact.rows[0]?.count !== '1') {
    throw new DeletionRecoveryConflict('Access Account deletion intent is absent');
  }
  const pending = await access.query<{ count: string }>(
    "SELECT count(*) AS count FROM access.admission WHERE principal_id = $1 AND state <> 'sealed'",
    [row.id]);
  if (pending.rows[0]?.count !== '0') {
    throw new DeletionRecoveryConflict('Access principal admissions remain unsealed');
  }
  return { issuer, accountSubject: subject, accessPrincipalId: row.id,
    enforcementEpoch: row.enforcement_epoch };
}

/** Capture only after both owners and their writers are quiesced. */
export async function captureDeletionRecoverySet(
  account: Pool, access: Pool, issuer: string, subject: string,
): Promise<DeletionRecoverySet> {
  const deletion = await deletedBinding(account, access, issuer, subject);
  return { version: 1, deletion,
    account: { pg: await capturePgRecoveryFrontier(account),
      rows: await accountRecoveryCoverage(account) },
    access: { pg: await capturePgRecoveryFrontier(access),
      outbox: await accessOutboxCoverage(access), state: await accessStateCoverage(access) } };
}

/** Check both isolated completed restores before routing either owner. */
export async function assertDeletionRecoverySet(
  account: Pool, access: Pool, expected: DeletionRecoverySet,
): Promise<void> {
  if (expected?.version !== 1 || !expected.account || !expected.access
    || !expected.deletion || !expected.deletion.issuer || !expected.deletion.accountSubject
    || !/^[0-9a-f-]{36}$/.test(expected.deletion.accessPrincipalId)
    || !/^[0-9]+$/.test(expected.deletion.enforcementEpoch)) {
    throw new DeletionRecoveryConflict('invalid deletion recovery set');
  }
  await assertPgRecoveryFrontier(account, expected.account.pg);
  await assertPgRecoveryFrontier(access, expected.access.pg);
  await assertAccountRecoveryCoverage(account, expected.account.rows);
  const outbox = await accessOutboxCoverage(access);
  const state = await accessStateCoverage(access);
  if (outbox.count !== expected.access.outbox?.count
    || outbox.digest !== expected.access.outbox?.digest
    || state.count !== expected.access.state?.count
    || state.digest !== expected.access.state?.digest) {
    throw new DeletionRecoveryConflict('Access rows differ from retained recovery set');
  }
  const actual = await deletedBinding(account, access,
    expected.deletion.issuer, expected.deletion.accountSubject);
  if (actual.accessPrincipalId !== expected.deletion.accessPrincipalId
    || actual.enforcementEpoch !== expected.deletion.enforcementEpoch) {
    throw new DeletionRecoveryConflict('deleted Account binding differs from retained fence');
  }
}
