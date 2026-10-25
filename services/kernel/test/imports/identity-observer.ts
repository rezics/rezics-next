import type { BootstrapEvidence } from '../../../../specs/imports-identity-driver.ts';
import { GLOBAL } from '../../../../specs/imports-identity-driver.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { PLATFORM_GOVERNANCE_ROLE } from '../../src/access/bootstrap-governance.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { routeOf } from '../../src/route/route.ts';
import { identitySupport, type ImportIdentity } from './identity-fixture.ts';

/** Every observer uses an exact native anchor or a locator returned by setup.
 * No inventory, history enumeration or CLI output supplies identity evidence. */
export const observeAccount = (f: ImportIdentity, accountId: string) => {
  const route = routeOf(accountId);
  return route === null ? Promise.resolve(null) : readAccount(f.database.pool, route, accountId);
};
export const observeAuthAccount = (f: ImportIdentity, accountId: string) =>
  identitySupport(f).bindings.trustedAccess.readAccount(accountId);
export async function observeGrants(f: ImportIdentity, accountId: string) {
  const seen = new Set<string>();
  const result: { resource: { route: number; id: string }; actions: string[] }[] = [];
  for (const locator of identitySupport(f).grantLocators) {
    if (locator.subject?.kind !== 'account' || locator.subject.id !== accountId) continue;
    for (const action of locator.actions) {
      const key = JSON.stringify([locator.resource, action, locator.valid]);
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = await f.database.pool.query(
        `SELECT route,resource_id,action FROM access.resource_grant
         WHERE route=$1 AND resource_id=$2 AND subject_kind='identity'
           AND subject_id=$3 AND subject_role='' AND action=$4 AND valid=$5::tstzrange`,
        [locator.resource.route, locator.resource.id, accountId, action, locator.valid],
      );
      for (const row of rows.rows)
        result.push({ resource: { route: row.route, id: row.resource_id }, actions: [row.action] });
    }
  }
  return result.sort((a, b) => a.actions[0]!.localeCompare(b.actions[0]!));
}
export async function observeBootstrap(f: ImportIdentity): Promise<BootstrapEvidence> {
  const pool = f.database.pool;
  const marker = (
    await pool.query(
      'SELECT route,resource_id,account_id,transaction_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
      [GLOBAL.route, GLOBAL.id],
    )
  ).rows[0];
  if (!marker) throw new Error('Missing native bootstrap marker');
  const roles = (
    await pool.query(
      `SELECT route,resource_id,subject_id,grant_role,transaction_id FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
       AND subject_role='' AND grant_role=$4 AND valid='(,)'::tstzrange`,
      [marker.route, marker.resource_id, marker.account_id, PLATFORM_GOVERNANCE_ROLE],
    )
  ).rows;
  const events = (
    await pool.query(
      `SELECT partition_no,epoch,position,event_seq,id,type,subject,data,
       to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time FROM core.outbox
     WHERE partition_no=$1 AND position=$2 ORDER BY event_seq`,
      [GLOBAL.route >>> 4, identitySupport(f).bootstrapPosition],
    )
  ).rows;
  const audit = events.map((row) => {
    const event: CloudEvent = {
      specversion: '1.0',
      id: row.id,
      source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
      type: row.type,
      ...(row.subject === null ? {} : { subject: row.subject }),
      time: row.time,
      datacontenttype: 'application/json',
      sequence: String(row.position).padStart(19, '0'),
      data: row.data,
    };
    const grant = roles.find(
      (role) =>
        role.subject_id === row.data.accountId &&
        role.grant_role === row.data.role &&
        role.transaction_id === marker.transaction_id,
    );
    if (!grant || row.type !== 'com.rezics.access.governance.bootstrapped.v1')
      throw new Error('Unbound bootstrap audit');
    return {
      envelope: { partition: row.partition_no, epoch: row.epoch, position: BigInt(row.position), events: [event] },
      resource: row.data.resource,
      accountId: row.data.accountId,
      transactionId: grant.transaction_id,
    };
  });
  return {
    marker: {
      partition: marker.route >>> 4,
      resource: { route: marker.route, id: marker.resource_id },
      accountId: marker.account_id,
      transactionId: marker.transaction_id,
    },
    roles: roles.map((row) => ({
      resource: { route: row.route, id: row.resource_id },
      accountId: row.subject_id,
      role: row.grant_role,
    })),
    audit,
  };
}
export async function observeKey(f: ImportIdentity, accountId: string, kid: string): Promise<boolean> {
  return (
    (
      await identitySupport(f).authDatabase.pool.query(
        'SELECT kid FROM auth_public_key WHERE account_id=$1 AND kid=$2',
        [accountId, kid],
      )
    ).rowCount === 1
  );
}
