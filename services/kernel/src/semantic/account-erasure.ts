import type { Pool } from 'pg';
import { noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import { SEMANTIC_ERASURE_STORES } from './account-erasure-stores.ts';
import { SEMANTIC_EVENTS } from './events.ts';
import type { Effect } from '../events/effects.ts';

export const SEMANTIC_ERASURE_SCHEDULED = 'com.rezics.semantic.erasure.scheduled.v1';
export const SEMANTIC_LOCATOR_SCHEDULED = 'com.rezics.semantic.erasure.locator-scheduled.v1';
export const SEMANTIC_LOCATOR_ADVANCED = 'com.rezics.semantic.erasure.locator-advanced.v1';
export const SEMANTIC_ERASURE_PROGRESS = 'com.rezics.semantic.erasure.progress.v1';
const platform = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-semantic-erasure',
  requestedBy: null,
};
const allowedStores = new Set<string>([...SEMANTIC_ERASURE_STORES, 'zone', 'write_basis']);
export const SEMANTIC_ERASURE_LIMITS = Object.freeze({
  rawKeys: 100,
  bytes: 65536,
  locatorBytes: 1024,
});
export type SemanticErasureProgress = {
  at: string;
  state: 'local' | 'pending-shared-custody';
  partition: number;
  applied: boolean;
};
export type SemanticErasureStep = {
  changed: boolean;
  localComplete: boolean;
  rawKeys: number;
  bytes: number;
};
type Locator = {
  store: string;
  record_key: string;
  role: string;
  source_transaction_id: string | null;
  source_position: string | null;
  delivery_position: string;
};

/** One indexed read transaction, released before any other authoritative home. */
async function indexedRead<T>(pool: Pool, read: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query('SET LOCAL enable_seqscan=off');
      const value = await read(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** Keep ordered discovery on the role-first partial index, including fresh producer batches. */
async function inspectHome(pool: Pool, partition: number, accountId: string) {
  return indexedRead(pool, async (client) => {
    await client.query('SET LOCAL enable_bitmapscan=off');
    await client.query('SET LOCAL enable_sort=off');
    const result = await client.query<Locator & { home_applied: boolean }>(
      `SELECT l.store,l.record_key::text,l.role,l.source_transaction_id::text,l.source_position::text,
        l.delivery_position::text,coalesce(h.applied,false) AS home_applied
      FROM (VALUES(1)) seed(n)
      LEFT JOIN semantic.erasure_home h ON h.partition_no=$1 AND h.account_id=$2
      LEFT JOIN LATERAL (
        SELECT store,record_key,role,source_transaction_id,source_position,delivery_position
        FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND state='pending'
        ORDER BY priority,store,semantic.erasure_locator.record_key,role LIMIT 1
      ) l ON true`,
      [partition, accountId],
    );
    const { home_applied, ...locator } = result.rows[0]!;
    return { applied: home_applied, locator: locator.store ? locator : undefined };
  });
}

async function nextLocator(pool: Pool, partition: number, accountId: string) {
  return (await inspectHome(pool, partition, accountId)).locator;
}

/** Recover a payload commit whose account-home receipt was interrupted, without scanning resolved receipts. */
async function unsettledLocator(pool: Pool, partition: number, accountId: string) {
  const { route } = home(accountId);
  const inbox = (
    await indexedRead(pool, (client) =>
      client.query<Pick<Locator, 'store' | 'record_key' | 'role' | 'delivery_position'>>(
        `SELECT store,record_key::text,role,delivery_position::text FROM semantic.erasure_inbox
    WHERE route=$1 AND account_id=$2 AND source_partition=$3 AND late AND state<>'resolved'
    ORDER BY store,semantic.erasure_inbox.record_key,role,semantic.erasure_inbox.delivery_position LIMIT 1`,
        [route, accountId, partition],
      ),
    )
  ).rows[0];
  if (!inbox) return;
  const native = (
    await indexedRead(pool, (client) =>
      client.query<Locator & { state: string }>(
        `SELECT store,record_key::text,role,source_transaction_id::text,source_position::text,delivery_position::text,state
    FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND role=$3 AND store=$4 AND record_key=$5`,
        [partition, accountId, inbox.role, inbox.store, inbox.record_key],
      ),
    )
  ).rows[0];
  if (!native) throw new TypeError('Missing unsettled native Semantic locator');
  return { ...native, delivery_position: inbox.delivery_position };
}

function home(accountId: string) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Erasure requires a routed account id');
  return { route, partition: partitionOf(route) };
}
const wake = (accountId: string) => [{ type: SEMANTIC_ERASURE_SCHEDULED, subject: accountId, data: { accountId } }];
const event = (accountId: string) => [{ type: SEMANTIC_ERASURE_PROGRESS, subject: accountId, data: { accountId } }];

export async function readSemanticErasure(pool: Pool, accountId: string): Promise<SemanticErasureProgress | null> {
  const { route } = home(accountId);
  const result = await indexedRead(pool, (client) =>
    client.query(
      `SELECT at::text,state,partition_no,applied FROM semantic.erasure_progress WHERE route=$1 AND account_id=$2`,
      [route, accountId],
    ),
  );
  const row = result.rows[0];
  return row
    ? {
        at: row.at,
        state: row.state,
        partition: row.partition_no,
        applied: row.applied,
      }
    : null;
}

/** Close the actual account-home participant fence before any local paging or effect inbox discovery. */
export async function beginSemanticErasure(pool: Pool, accountId: string): Promise<void> {
  const { route, partition } = home(accountId);
  await runCommand(pool, { partition, basis: platform }, async (tx) => {
    const obligation = await tx.query(
      'SELECT at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE',
      [route, accountId],
    );
    if (!obligation.rowCount) throw new TypeError('No committed account erasure obligation');
    const prior = await tx.query('SELECT at FROM semantic.erasure_progress WHERE route=$1 AND account_id=$2', [
      route,
      accountId,
    ]);
    if (prior.rowCount) return noEffect(null);
    await tx.query(
      `INSERT INTO semantic.erasure_fence(route,account_id,at) VALUES($1,$2,$3)
      ON CONFLICT(route,account_id) DO UPDATE SET at=EXCLUDED.at`,
      [route, accountId, obligation.rows[0].at],
    );
    await tx.query('INSERT INTO semantic.erasure_progress(route,account_id,at) VALUES($1,$2,$3)', [
      route,
      accountId,
      obligation.rows[0].at,
    ]);
    return { value: null, events: wake(accountId) };
  });
}

/** Published eligibility is checked on original local source keys, never on stale projection presence. */
const publicCandidate = `EXISTS (SELECT 1 FROM semantic.subject s WHERE s.route=c.route AND s.subject_id=c.subject_id AND s.visibility='visible')
 AND NOT EXISTS (SELECT 1 FROM semantic.hidden_candidate h WHERE h.route=c.route AND h.subject_id=c.subject_id AND h.candidate_id=c.candidate_id)
 AND NOT EXISTS (SELECT 1 FROM semantic.retraction r WHERE r.route=c.route AND r.subject_id=c.subject_id AND r.candidate_id=c.candidate_id)
 AND NOT EXISTS (SELECT 1 FROM semantic.statement_disclosure d WHERE d.route=c.route AND d.subject_id=c.subject_id AND d.candidate_id=c.candidate_id AND NOT d.disclosed)
 AND EXISTS (SELECT 1 FROM semantic.acceptance_current a WHERE a.route=c.route AND a.subject_id=c.subject_id AND a.candidate_id=c.candidate_id
   AND a.context_id='00000000-0000-8000-8000-000000000000' AND a.verdict='accept')
 AND EXISTS (SELECT 1 FROM semantic.adoption a WHERE a.route=c.route AND a.subject_id=c.subject_id AND a.slot_id=c.slot_id
   AND a.context_id='00000000-0000-8000-8000-000000000000'
   AND NOT EXISTS (SELECT 1 FROM semantic.adoption newer WHERE newer.route=a.route AND newer.subject_id=a.subject_id AND newer.slot_id=a.slot_id AND newer.context_id=a.context_id AND newer.head>a.head)
   AND a.selection @> jsonb_build_array(jsonb_build_object('candidate',c.candidate_id::text)))`;

/** Two exact source points, each released before the receiving native command. No payload leaves either point. */
async function retainProjection(pool: Pool, partition: number, locator: Locator | undefined): Promise<boolean> {
  if (!locator || !['inbound_link', 'outbound_link'].includes(locator.store)) return false;
  const source = locator.store === 'inbound_link' ? 'source_subject_id' : 'subject_id';
  const row = (
    await pool.query(
      `SELECT ${source}::text AS subject,statement_id::text AS candidate
    FROM semantic.${locator.store} WHERE route BETWEEN $1 AND $2 AND erasure_key=$3
    AND present AND context_id='00000000-0000-8000-8000-000000000000'`,
      [partition * 16, partition * 16 + 15, locator.record_key],
    )
  ).rows[0];
  if (!row) return false;
  const result = await pool.query(
    `SELECT 1 FROM semantic.candidate c WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3 AND NOT c.erasure_private AND (${publicCandidate})`,
    [routeOf(row.subject), row.subject, row.candidate],
  );
  return !!result.rowCount;
}

/** The local sparse contribution is removed before its Global base. No Context fanout is hidden here. */
async function minimizeProjection(tx: CommandTransaction, partition: number, locator: Locator): Promise<void> {
  const outbound = locator.store === 'outbound_link';
  const table = locator.store;
  const identity = outbound
    ? 'base.statement_id=r.statement_id'
    : 'base.statement_id=r.statement_id AND base.source_subject_id=r.source_subject_id';
  const order = outbound
    ? 'ORDER BY base.source_revision DESC,base.source_security_revision DESC,base.target_revision DESC'
    : '';
  const relation = outbound ? 'AND r.relation' : '';
  await tx.query(
    `WITH removed AS (
    DELETE FROM semantic.${table} WHERE route BETWEEN $1 AND $2 AND erasure_key=$3 RETURNING route,subject_id,context_id,property,filter_value,statement_id,present,suppressed${outbound ? ',relation' : ',source_subject_id'}
  ), delta AS MATERIALIZED (
    SELECT r.*,CASE WHEN r.present THEN (NOT r.suppressed)::integer-coalesce(base.present,false)::integer ELSE 0 END AS contribution
    FROM removed r LEFT JOIN LATERAL (
      SELECT base.present FROM semantic.${table} base WHERE base.route=r.route AND base.subject_id=r.subject_id
      AND base.context_id='00000000-0000-8000-8000-000000000000' AND base.property=r.property AND base.filter_value=r.filter_value
      AND ${identity} ${order} LIMIT 1
    ) base ON r.context_id<>'00000000-0000-8000-8000-000000000000'
  ), local_count AS (
    UPDATE semantic.${table}_context_count c SET value=c.value-r.contribution FROM delta r
    WHERE c.route=r.route AND c.subject_id=r.subject_id AND c.context_id=r.context_id
      AND c.property=r.property AND c.filter_value=r.filter_value AND r.context_id<>'00000000-0000-8000-8000-000000000000' ${relation}
    RETURNING c.route
  )
  UPDATE semantic.${table}_count c SET value=c.value-1 FROM removed r WHERE c.route=r.route
    AND c.subject_id=r.subject_id AND c.property=r.property AND c.filter_value=r.filter_value
    AND r.context_id='00000000-0000-8000-8000-000000000000' AND r.present ${relation}`,
    [partition * 16, partition * 16 + 15, locator.record_key],
  );
}

/** One physical record only. No account graph, payload search, cascade or implicit child page. */
async function minimize(
  tx: CommandTransaction,
  partition: number,
  accountId: string,
  locator: Locator,
  retain = false,
): Promise<{ defer: true; rawKeys: number; bytes: number } | undefined> {
  const { store, record_key: key, role } = locator;
  if (!allowedStores.has(store)) throw new TypeError('Unknown Semantic erasure store');
  const low = partition * 16;
  const high = low + 15;
  const values = [low, high, key];
  // Acting humans retain no delegation provenance, but do not acquire ownership of an organization's data.
  if (locator.source_transaction_id) {
    await tx.query(
      `INSERT INTO semantic.erasure_shared_custody(partition_no,account_id,role,transaction_id,outbox_position)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [partition, accountId, role, locator.source_transaction_id, locator.source_position],
    );
  }
  if (role === 'acting-human' && store !== 'write_basis') return;
  if (store === 'write_basis') {
    const original = await tx.query(
      'SELECT transaction_id FROM semantic.erasure_provenance WHERE partition_no=$1 AND record_key=$2',
      [partition, key],
    );
    if (!original.rowCount) return;
    const transactionId = original.rows[0].transaction_id;
    if (role === 'acting-human') {
      await tx.query(
        "UPDATE editorial.write_basis SET requested_by=NULL WHERE partition_no=$1 AND transaction_id=$2 AND split_part(requested_by,':',4)=$3",
        [partition, transactionId, accountId],
      );
    } else {
      // No false anonymous principal is written. Source IDs survive in the owned provenance tombstone.
      await tx.query(
        'UPDATE semantic.erasure_provenance SET minimized=true WHERE partition_no=$1 AND transaction_id=$2',
        [partition, transactionId],
      );
      await tx.query(
        "DELETE FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2 AND principal_kind='account' AND principal_id=$3",
        [partition, transactionId, accountId],
      );
    }
    return;
  }
  if (store === 'zone') {
    await tx.query(
      `UPDATE zones.zone SET
      configuration=CASE WHEN visibility='public' AND state='active' AND public_ever THEN configuration ELSE NULL END,
      mounts=CASE WHEN visibility='public' AND state='active' AND public_ever THEN mounts ELSE '{}'::uuid[] END,
      owner_id=CASE WHEN owner_id=$4::uuid THEN NULL ELSE owner_id END,
      state=CASE WHEN visibility='public' AND state='active' AND public_ever THEN state ELSE 'purged' END,
      withholding='{}',write_fenced=true,deleted_at=NULL,restore_until=NULL
      WHERE route BETWEEN $1 AND $2 AND erasure_key=$3 AND (transaction_id=$5 OR owner_id=$4)`,
      [...values, accountId, locator.source_transaction_id],
    );
    return;
  }
  const where = 'route BETWEEN $1 AND $2 AND erasure_key=$3';
  if (store === 'candidate') {
    const candidate = (
      await tx.query(`SELECT route,subject_id,candidate_id,slot_id FROM semantic.candidate WHERE ${where}`, values)
    ).rows[0];
    if (!candidate) return;
    const nativeKey = [candidate.route, candidate.subject_id, candidate.candidate_id, candidate.slot_id];
    // Resolve the native candidate and slot prefix before reading current publication eligibility.
    const eligible = await tx.query(
      `SELECT 1 FROM semantic.candidate c WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3
        AND c.slot_id=$4 AND (${publicCandidate})`,
      nativeKey,
    );
    if (eligible.rowCount) return;
    await tx.query(
      `UPDATE semantic.candidate SET statement='{}',erasure_private=true
        WHERE route=$1 AND subject_id=$2 AND candidate_id=$3 AND slot_id=$4`,
      nativeKey,
    );
  } else if (store === 'fact') {
    // Historical values are removed; a private latest slot keeps an empty retract marker so older values cannot reappear.
    await tx.query(
      `DELETE FROM semantic.fact f WHERE ${where} AND EXISTS
      (SELECT 1 FROM semantic.fact newer WHERE newer.route=f.route AND newer.subject_id=f.subject_id AND newer.slot_id=f.slot_id AND newer.log_seq>f.log_seq)`,
      values,
    );
    await tx.query(
      `WITH changed AS (
      UPDATE semantic.fact f SET body='{}',operation='retract',release=NULL WHERE ${where} AND f.operation='assert' AND (
       NOT EXISTS(SELECT 1 FROM semantic.subject s WHERE s.route=f.route AND s.subject_id=f.subject_id AND s.visibility='visible')
       OR EXISTS(SELECT 1 FROM semantic.statement_disclosure d WHERE d.route=f.route AND d.subject_id=f.subject_id AND d.candidate_id=f.statement_id AND NOT d.disclosed)
       OR EXISTS(SELECT 1 FROM semantic.retraction r WHERE r.route=f.route AND r.subject_id=f.subject_id AND r.candidate_id=f.statement_id)
       OR EXISTS(SELECT 1 FROM semantic.account_agent_subject a WHERE a.account_route=f.route AND a.agent_id=f.subject_id AND a.account_id=$4))
      RETURNING route,subject_id)
      UPDATE semantic.subject s SET current_facts=greatest(0,current_facts-1) FROM changed c WHERE s.route=c.route AND s.subject_id=c.subject_id`,
      [...values, accountId],
    );
  } else if (store === 'revision') {
    await tx.query(
      `UPDATE semantic.revision SET source=NULL,verification_receipt_id=NULL,revocation_receipt_id=NULL WHERE ${where}`,
      values,
    );
  } else if (store === 'moderation') {
    await tx.query(`UPDATE semantic.moderation SET body='{}',actor=NULL WHERE ${where}`, values);
  } else if (store === 'context') {
    const context = (
      await tx.query(
        `SELECT route,context_id FROM semantic.context WHERE ${where} AND kind='community'
      AND NOT EXISTS(SELECT 1 FROM access.resource_role_grant g JOIN access.account account
        ON account.route=((get_byte(uuid_send(g.subject_id),10)*256)+get_byte(uuid_send(g.subject_id),11))
        AND account.account_id=g.subject_id AND account.state='active' AND NOT account.authn_fenced
        WHERE g.route=context.route AND g.resource_id=context.context_id AND g.grant_role='semantic.context.owner'
        AND g.subject_kind='identity' AND g.subject_id<>$4 AND g.valid @> statement_timestamp())`,
        [...values, accountId],
      )
    ).rows[0];
    if (!context) return;
    // Ownership transfer need not rewrite immutable bodies. The exact resource locator leads to one indexed
    // physical child per step, so inherited private bodies are not mistaken for another author's archive.
    // The parent remains pending until every child prefix is empty; deletion itself is the durable child cursor.
    for (const childStore of ['context_extension_activation', 'release_composite', 'context_extension']) {
      const composite = childStore === 'release_composite';
      const route = composite ? 'extension_route' : 'route';
      const id = composite ? 'extension_context_id' : 'context_id';
      const source = composite
        ? `(SELECT e.recorded_transaction_id FROM semantic.context_extension e
        WHERE e.route=r.extension_route AND e.context_id=r.extension_context_id AND e.digest=r.extension_digest)`
        : 'recorded_transaction_id';
      const child = (
        await tx.query(
          `SELECT erasure_key::text,${source} AS transaction_id FROM semantic.${childStore} r
        WHERE ${route}=$1 AND ${id}=$2 ORDER BY ${composite ? 'extension_digest,digest' : childStore === 'context_extension' ? 'digest' : 'head'} LIMIT 1`,
          [context.route, context.context_id],
        )
      ).rows[0];
      if (!child) continue;
      const bytes = Buffer.byteLength(JSON.stringify(child));
      if (bytes > SEMANTIC_ERASURE_LIMITS.locatorBytes)
        throw new TypeError('Semantic child locator byte bound exceeded');
      if (child.transaction_id)
        await tx.query(
          `INSERT INTO semantic.erasure_shared_custody(partition_no,account_id,role,transaction_id,outbox_position)
        SELECT $1,$2,$3,$4,position FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$4 ON CONFLICT DO NOTHING`,
          [partition, accountId, role, child.transaction_id],
        );
      await tx.query(
        `DELETE FROM semantic.${childStore} WHERE ${route}=$1 AND erasure_key=$2
        AND semantic.erasure_mutation_allowed('context',$1,$3)`,
        [context.route, child.erasure_key, key],
      );
      return { defer: true, rawKeys: 1, bytes };
    }
    await tx.query(
      `UPDATE semantic.context SET labels='{}',settings_id=NULL,settings_release=NULL,defaults='{}' WHERE ${where} AND kind='community'`,
      values,
    );
  } else if (store === 'retraction') {
    await tx.query(`UPDATE semantic.retraction SET "references"='[]' WHERE ${where}`, values);
  } else if (store === 'statement_disclosure') {
    // Consent state cannot be retained as a new, publishable assertion after the account's T.
    await tx.query(
      `UPDATE semantic.statement_disclosure SET account_id=NULL,disclosed=false,target_order_key='',source_order_key='' WHERE ${where}`,
      values,
    );
  } else if (store === 'source_candidate' || store === 'external_claim') {
    await tx.query(`DELETE FROM semantic.${store} WHERE ${where}`, values);
  } else if (['context_extension_activation', 'release_composite', 'context_extension'].includes(store)) {
    const composite = store === 'release_composite';
    const contextRoute = composite ? 'r.extension_route' : 'r.route';
    const contextId = composite ? 'r.extension_context_id' : 'r.context_id';
    const digest = composite ? 'r.extension_digest' : 'r.digest';
    // Only the current published extension of Global or a surviving community is eligible. Older bodies
    // and their composed copies are children of the local erasure obligation, even beneath a public Context.
    const eligible = await tx.query(
      `SELECT 1 FROM semantic.${store} r WHERE ${contextRoute} BETWEEN $1 AND $2 AND r.erasure_key=$3
      AND EXISTS (SELECT 1 FROM semantic.context_extension_activation a WHERE a.route=${contextRoute}
        AND a.context_id=${contextId} AND a.digest=${digest}
        AND NOT EXISTS (SELECT 1 FROM semantic.context_extension_activation newer
          WHERE newer.route=a.route AND newer.context_id=a.context_id AND newer.head>a.head))
      AND (${contextId}='00000000-0000-8000-8000-000000000000' OR EXISTS (
        SELECT 1 FROM access.resource_role_grant g JOIN access.account account
          ON account.route=((get_byte(uuid_send(g.subject_id),10)*256)+get_byte(uuid_send(g.subject_id),11))
          AND account.account_id=g.subject_id AND account.state='active' AND NOT account.authn_fenced
        WHERE g.route=${contextRoute} AND g.resource_id=${contextId} AND g.subject_kind='identity'
          AND g.grant_role='semantic.context.owner' AND g.subject_id<>$4 AND g.valid @> statement_timestamp()))`,
      [...values, accountId],
    );
    if (eligible.rowCount) return;
    if (store === 'context_extension') {
      // Children are sought through their owning native prefix, independently of unrelated extensions.
      const child = await tx.query(
        `SELECT 1 FROM semantic.context_extension e WHERE ${where} AND (
        EXISTS(SELECT 1 FROM semantic.context_extension_activation a WHERE a.route=e.route AND a.context_id=e.context_id AND a.digest=e.digest)
        OR EXISTS(SELECT 1 FROM semantic.release_composite c WHERE c.extension_route=e.route AND c.extension_context_id=e.context_id AND c.extension_digest=e.digest))`,
        values,
      );
      if (child.rowCount) throw new TypeError('Context extension erasure still has a native child');
    }
    await tx.query(
      `DELETE FROM semantic.${store} WHERE ${composite ? 'extension_route BETWEEN $1 AND $2 AND erasure_key=$3' : where}`,
      values,
    );
  } else if (store === 'account_agent_moved_link') {
    await tx.query(`DELETE FROM semantic.account_agent_moved_link WHERE ${where}`, values);
  } else if (store === 'account_agent_subject') {
    await tx.query(`UPDATE semantic.account_agent_subject SET verified=false,receipt_id=NULL WHERE ${where}`, values);
  } else if (store === 'acceptance' || store === 'acceptance_current') {
    if (store === 'acceptance') {
      const child = (
        await tx.query(
          `SELECT pointer.erasure_key::text FROM semantic.acceptance a
          JOIN semantic.acceptance_current pointer USING(route,subject_id,context_id,candidate_id,head)
          WHERE a.route BETWEEN $1 AND $2 AND a.erasure_key=$3 AND EXISTS
          (SELECT 1 FROM semantic.candidate c WHERE c.route=a.route AND c.subject_id=a.subject_id
            AND c.candidate_id=a.candidate_id AND NOT (${publicCandidate}))`,
          values,
        )
      ).rows[0];
      if (child) return { defer: true, rawKeys: 1, bytes: Buffer.byteLength(JSON.stringify(child)) };
    }
    await tx.query(
      `DELETE FROM semantic.${store} a WHERE ${where} AND EXISTS
      (SELECT 1 FROM semantic.candidate c WHERE c.route=a.route AND c.subject_id=a.subject_id AND c.candidate_id=a.candidate_id AND NOT (${publicCandidate}))`,
      values,
    );
  } else if (store === 'adoption') {
    await tx.query(
      `UPDATE semantic.adoption a SET selection='[]',mode='suppress' WHERE ${where}
      AND (a.context_id<>'00000000-0000-8000-8000-000000000000' OR NOT EXISTS
      (SELECT 1 FROM semantic.subject s WHERE s.route=a.route AND s.subject_id=a.subject_id AND s.visibility='visible'))`,
      values,
    );
  } else if (store === 'identity_epoch_job') {
    await tx.query(
      `UPDATE semantic.identity_epoch_job SET receipt='{"kind":"erased"}',receipt_key='erased:'||job_id::text,
      intent=intent-'verificationReceipt' WHERE partition_no=$1 AND erasure_key=$2`,
      [partition, key],
    );
  } else if (store === 'outbound_link' || store === 'inbound_link') {
    if (!retain) await minimizeProjection(tx, partition, locator);
  }

  // Communal subjects/releases, selected verdicts and native identity proof skeletons retain their IDs.
  // Their personal source and attribution are separate child locators and are minimized first.
}

/** One owning home, at most two locator keys and one inherited child, including rejected/absent native records.
 * The owning mutation and local checkpoint commit together. No connection crosses a home or service call.
 */
export async function stepSemanticErasure(
  pool: Pool,
  accountId: string,
  continuation: 'event' | 'workflow' = 'event',
): Promise<SemanticErasureStep> {
  if (continuation !== 'event' && continuation !== 'workflow') throw new TypeError('Invalid Semantic continuation');
  const progress = await readSemanticErasure(pool, accountId);
  if (!progress) throw new TypeError('Semantic erasure has not begun');
  if (progress.state === 'pending-shared-custody') return { changed: false, localComplete: true, rawKeys: 0, bytes: 0 };
  const partition = progress.partition;
  const unsettled = await unsettledLocator(pool, partition, accountId);
  const recoveredBytes = unsettled ? Buffer.byteLength(JSON.stringify(unsettled)) : 0;
  if (recoveredBytes > SEMANTIC_ERASURE_LIMITS.locatorBytes)
    throw new TypeError('Semantic locator byte bound exceeded');
  if (unsettled?.state === 'minimized') {
    await settleLocatorObligation(pool, partition, accountId, unsettled, continuation === 'event');
    return { changed: true, localComplete: false, rawKeys: 1, bytes: recoveredBytes };
  }
  const inspected = await inspectHome(pool, partition, accountId);
  const probe = inspected.locator;
  if (!probe && !unsettled) return advanceEmptyHome(pool, accountId, progress, inspected.applied, continuation);
  // Local discovery can outrun the source relay. Commit this exact child's late obligation before its payload.
  if (probe) await recordLocatorObligation(pool, partition, accountId, probe);
  const retain = await retainProjection(pool, partition, probe);
  const result = await runCommand(pool, { partition, basis: platform }, async (tx) => {
    await tx.query('SET LOCAL enable_seqscan=off');
    await tx.query('SET LOCAL enable_bitmapscan=off');
    await tx.query('SET LOCAL enable_sort=off');
    await tx.query(
      "SELECT set_config('semantic.erasure_cleanup','on',true),set_config('semantic.erasure_account',$1,true)",
      [accountId],
    );
    await tx.query(
      `INSERT INTO semantic.erasure_home(partition_no,account_id,at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [partition, accountId, progress.at],
    );
    const gate = await tx.query(
      `SELECT state,applied FROM semantic.erasure_home WHERE partition_no=$1 AND account_id=$2 FOR UPDATE`,
      [partition, accountId],
    );
    if (gate.rows[0].state === 'complete')
      return noEffect({
        empty: true,
        applied: gate.rows[0].applied as boolean,
        rawKeys: 0,
        bytes: 0,
      });
    const page = await tx.query<Locator>(
      `SELECT store,record_key::text,role,source_transaction_id::text,source_position::text,delivery_position::text
      FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND state='pending'
      ORDER BY priority,store,semantic.erasure_locator.record_key,role LIMIT 1 FOR UPDATE`,
      [partition, accountId],
    );
    const locator = page.rows[0];
    if (!locator) {
      await tx.query("UPDATE semantic.erasure_home SET state='complete' WHERE partition_no=$1 AND account_id=$2", [
        partition,
        accountId,
      ]);
      return {
        value: {
          empty: true,
          applied: gate.rows[0].applied as boolean,
          rawKeys: 0,
          bytes: 0,
        },
        events: event(accountId),
      };
    }
    const bytes = Buffer.byteLength(JSON.stringify(locator));
    if (bytes > SEMANTIC_ERASURE_LIMITS.locatorBytes) throw new TypeError('Semantic locator byte bound exceeded');
    if (
      !probe ||
      probe.store !== locator.store ||
      probe.record_key !== locator.record_key ||
      probe.role !== locator.role ||
      probe.delivery_position !== locator.delivery_position
    )
      return noEffect({
        empty: false,
        applied: gate.rows[0].applied as boolean,
        rawKeys: 1,
        bytes,
      });
    const child = await minimize(tx, partition, accountId, locator, retain);
    if (!child?.defer)
      await tx.query(
        `UPDATE semantic.erasure_locator SET state='minimized'
      WHERE partition_no=$1 AND account_id=$2 AND role=$3 AND store=$4 AND record_key=$5`,
        [partition, accountId, locator.role, locator.store, locator.record_key],
      );
    await tx.query('UPDATE semantic.erasure_home SET applied=true WHERE partition_no=$1 AND account_id=$2', [
      partition,
      accountId,
    ]);
    return {
      value: {
        empty: false,
        applied: true,
        settle: !child?.defer,
        rawKeys: 1 + (child?.rawKeys ?? 0),
        bytes: bytes + (child?.bytes ?? 0),
      },
      events: event(accountId),
    };
  });
  if ('settle' in result.value && result.value.settle && probe)
    await settleLocatorObligation(pool, partition, accountId, probe);
  await advanceLocalProgress(
    pool,
    accountId,
    partition,
    partition + (result.value.empty ? 1 : 0),
    result.value.applied,
    continuation,
  );
  return {
    changed: true,
    localComplete: result.value.empty && partition === 4095,
    rawKeys: result.value.rawKeys + (unsettled ? 1 : 0),
    bytes: result.value.bytes + recoveredBytes,
  };
}

async function advanceLocalProgress(
  pool: Pool,
  accountId: string,
  from: number,
  to: number,
  applied: boolean,
  continuation: 'event' | 'workflow',
) {
  const { route, partition: accountHome } = home(accountId);
  await runCommand(pool, { partition: accountHome, basis: platform }, async (tx) => {
    await tx.query('SET LOCAL enable_seqscan=off');
    await tx.query('SET LOCAL enable_bitmapscan=off');
    const current = await tx.query(
      'SELECT partition_no,applied FROM semantic.erasure_progress WHERE route=$1 AND account_id=$2 FOR UPDATE',
      [route, accountId],
    );
    if (current.rows[0].partition_no !== from) return noEffect(null);

    await tx.query(
      `UPDATE semantic.erasure_progress SET applied=applied OR $3,
      partition_no=partition_no+$4,state=CASE WHEN partition_no+$4=4096 THEN 'pending-shared-custody' ELSE state END
      WHERE route=$1 AND account_id=$2`,
      [route, accountId, applied, to - from],
    );
    return {
      value: null,
      events: to === 4096 || continuation === 'workflow' ? event(accountId) : wake(accountId),
    };
  });
}

/** One fixed routing home. Empty homes have no changed payload keys.
 * The indexed absence read releases its home before the account cursor commits the examined home.
 */
async function advanceEmptyHome(
  pool: Pool,
  accountId: string,
  progress: SemanticErasureProgress,
  applied: boolean,
  continuation: 'event' | 'workflow',
): Promise<SemanticErasureStep> {
  const partition = progress.partition;
  if (partition === 4095) {
    // The terminal home has a native committed receipt before the separate account-home checkpoint.
    await runCommand(pool, { partition, basis: platform }, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan=off');
      await tx.query(
        `INSERT INTO semantic.erasure_home(partition_no,account_id,at,state,applied)
          VALUES($1,$2,$3,'complete',$4) ON CONFLICT(partition_no,account_id)
          DO UPDATE SET state='complete',applied=semantic.erasure_home.applied OR EXCLUDED.applied`,
        [partition, accountId, progress.at, applied],
      );
      return { value: null, events: event(accountId) };
    });
  }
  await advanceLocalProgress(pool, accountId, partition, partition + 1, applied, continuation);
  return { changed: true, localComplete: partition === 4095, rawKeys: 1, bytes: 0 };
}

function lateKey(partition: number, locator: Locator) {
  return `semantic:${partition}:${locator.store}:${locator.record_key}:${locator.role}:${locator.delivery_position}`;
}

/** Copy an exact source locator to the account home while holding the genuine participant fence. */
async function recordLocatorObligation(pool: Pool, partition: number, accountId: string, locator: Locator) {
  const { route, partition: accountHome } = home(accountId);
  return (
    await runCommand(pool, { partition: accountHome, basis: platform }, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan=off');
      await tx.query('SET LOCAL enable_bitmapscan=off');
      await tx.query(`INSERT INTO semantic.erasure_fence(route,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [
        route,
        accountId,
      ]);
      const fence = await tx.query(
        'SELECT at FROM semantic.erasure_fence WHERE route=$1 AND account_id=$2 FOR UPDATE',
        [route, accountId],
      );
      const closed = fence.rows[0].at !== null;
      await tx.query(
        `INSERT INTO semantic.erasure_inbox(route,account_id,source_partition,store,record_key,role,delivery_position,late)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(route,account_id,source_partition,store,record_key,role,delivery_position) DO UPDATE SET late=semantic.erasure_inbox.late OR EXCLUDED.late`,
        [
          route,
          accountId,
          partition,
          locator.store,
          locator.record_key,
          locator.role,
          locator.delivery_position,
          closed,
        ],
      );
      if (closed)
        await recordLateErasureItem(tx, {
          accountId,
          participant: 'semantic',
          locator: lateKey(partition, locator),
        });
      return { value: closed, events: event(accountId) };
    })
  ).value;
}

async function deliverLocator(pool: Pool, partition: number, accountId: string, locator: Locator) {
  const late = await recordLocatorObligation(pool, partition, accountId, locator);
  if (!late) return true;
  const unsettled = await unsettledLocator(pool, partition, accountId);
  if (unsettled?.state === 'minimized') {
    await settleLocatorObligation(pool, partition, accountId, unsettled);
    return false;
  }
  // Owning payload commit precedes both the inbox minimization receipt and coordinator late resolution.
  const progress = await readSemanticErasure(pool, accountId);
  if (!progress) throw new TypeError('Closed Semantic fence without native progress');
  const probe = await nextLocator(pool, partition, accountId);
  // A parent's relay may minimize an earlier child. That child's real account-home obligation must commit first;
  // its own source cursor later resumes the minimized payload and resolves this exact late item after any crash.
  if (
    probe &&
    (probe.store !== locator.store || probe.record_key !== locator.record_key || probe.role !== locator.role)
  )
    await recordLocatorObligation(pool, partition, accountId, probe);
  const retain = await retainProjection(pool, partition, probe);
  const minimized = (
    await runCommand(pool, { partition, basis: platform }, async (tx) => {
      await tx.query('SET LOCAL enable_seqscan=off');
      await tx.query('SET LOCAL enable_bitmapscan=off');
      await tx.query('SET LOCAL enable_sort=off');
      await tx.query(
        "SELECT set_config('semantic.erasure_cleanup','on',true),set_config('semantic.erasure_account',$1,true)",
        [accountId],
      );
      const exact = await tx.query(
        `SELECT state FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND role=$3 AND store=$4 AND record_key=$5`,
        [partition, accountId, locator.role, locator.store, locator.record_key],
      );
      if (!exact.rowCount) throw new TypeError('Missing native Semantic locator');
      if (exact.rows[0].state === 'minimized' && !probe) return noEffect(true);
      await tx.query(
        `INSERT INTO semantic.erasure_home(partition_no,account_id,at) VALUES($1,$2,$3)
      ON CONFLICT(partition_no,account_id) DO UPDATE SET state='local'`,
        [partition, accountId, progress.at],
      );
      await tx.query('SELECT state FROM semantic.erasure_home WHERE partition_no=$1 AND account_id=$2 FOR UPDATE', [
        partition,
        accountId,
      ]);
      const page = await tx.query<Locator>(
        `SELECT store,record_key::text,role,source_transaction_id::text,source_position::text,delivery_position::text
      FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND state='pending'
      ORDER BY priority,store,semantic.erasure_locator.record_key,role LIMIT 1 FOR UPDATE`,
        [partition, accountId],
      );
      const child = page.rows[0]!;
      if (Buffer.byteLength(JSON.stringify(child)) > SEMANTIC_ERASURE_LIMITS.locatorBytes)
        throw new TypeError('Semantic locator byte bound exceeded');
      if (
        !probe ||
        probe.store !== child.store ||
        probe.record_key !== child.record_key ||
        probe.role !== child.role ||
        probe.delivery_position !== child.delivery_position
      )
        return noEffect(false);
      const deferred = await minimize(tx, partition, accountId, child, retain);
      if (!deferred?.defer)
        await tx.query(
          `UPDATE semantic.erasure_locator SET state='minimized' WHERE partition_no=$1 AND account_id=$2 AND role=$3 AND store=$4 AND record_key=$5`,
          [partition, accountId, child.role, child.store, child.record_key],
        );
      await tx.query('UPDATE semantic.erasure_home SET applied=true WHERE partition_no=$1 AND account_id=$2', [
        partition,
        accountId,
      ]);
      return {
        value:
          !deferred?.defer &&
          child.role === locator.role &&
          child.store === locator.store &&
          child.record_key === locator.record_key,
        events: event(accountId),
      };
    })
  ).value;
  if (!minimized) return false;
  await settleLocatorObligation(pool, partition, accountId, locator);
  // Keep this source cursor alive until a child payload commit interrupted before receipt settlement is resumed.
  return !(await unsettledLocator(pool, partition, accountId));
}

async function settleLocatorObligation(
  pool: Pool,
  partition: number,
  accountId: string,
  locator: Locator,
  resumeLocal = false,
) {
  const { route, partition: accountHome } = home(accountId);
  await runCommand(pool, { partition: accountHome, basis: platform }, async (tx) => {
    await tx.query('SET LOCAL enable_seqscan=off');
    await tx.query('SET LOCAL enable_bitmapscan=off');
    await tx.query(
      `UPDATE semantic.erasure_inbox SET state='minimized' WHERE route=$1 AND account_id=$2 AND source_partition=$3 AND store=$4 AND record_key=$5 AND role=$6 AND delivery_position=$7 AND state='pending'`,
      [route, accountId, partition, locator.store, locator.record_key, locator.role, locator.delivery_position],
    );
    return { value: null, events: event(accountId) };
  });
  await resolveLateErasureItem(
    { pool },
    {
      accountId,
      participant: 'semantic',
      locator: lateKey(partition, locator),
    },
  );
  await runCommand(pool, { partition: accountHome, basis: platform }, async (tx) => {
    await tx.query('SET LOCAL enable_seqscan=off');
    await tx.query('SET LOCAL enable_bitmapscan=off');
    await tx.query(
      `UPDATE semantic.erasure_inbox SET state='resolved' WHERE route=$1 AND account_id=$2 AND source_partition=$3 AND store=$4 AND record_key=$5 AND role=$6 AND delivery_position=$7`,
      [route, accountId, partition, locator.store, locator.record_key, locator.role, locator.delivery_position],
    );
    await tx.query('UPDATE semantic.erasure_progress SET applied=true WHERE route=$1 AND account_id=$2', [
      route,
      accountId,
    ]);
    return { value: null, events: resumeLocal ? wake(accountId) : event(accountId) };
  });
}

/** One source page per registered effect. Continuation and checkpoint share a native commit.
 * A replay sees the permanent source cursor, even when DBOS has lost its step result.
 */
export function createSemanticLocatorEffect(pool: Pool): Effect {
  return {
    name: 'semantic_erasure_locator',
    types: [
      ...Object.keys(SEMANTIC_EVENTS).filter((type) => !type.startsWith('com.rezics.semantic.erasure.')),
      SEMANTIC_LOCATOR_SCHEDULED,
      'com.rezics.access.role-grant.create.v1',
      'com.rezics.access.role-grant.change.v1',
      'com.rezics.access.role-grant.revoke.v1',
      'com.rezics.subject.created.v1',
      'com.rezics.semantic.context.created.v1',
      'com.rezics.definitions.published.v1',
      'com.rezics.definitions.activated.v1',
      'com.rezics.subject.visibility_changed.v1',
      'com.rezics.subject.statement_visibility_changed.v1',
      'com.rezics.zone.created.v1',
      'com.rezics.zone.configured.v1',
      'com.rezics.zone.published.v1',
      'com.rezics.zone.deleted.v1',
      'com.rezics.zone.restored.v1',
    ],
    async run(envelope) {
      const match = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(envelope.source);
      if (!match) throw new TypeError('Invalid native Semantic envelope source');
      const partition = Number(match[1]);
      const position =
        envelope.type === SEMANTIC_LOCATOR_SCHEDULED
          ? (envelope.data as { position: string }).position
          : envelope.sequence;
      const checkpoint = await withConnection(pool, (tx) =>
        tx.query(
          `SELECT after_store,after_key::text,after_account::text,after_role,complete
        FROM semantic.erasure_delivery WHERE partition_no=$1 AND source_position=$2`,
          [partition, position],
        ),
      );
      const cursor = checkpoint.rows[0];
      if (cursor?.complete) return;
      const after = cursor
        ? [cursor.after_store, cursor.after_key, cursor.after_account, cursor.after_role]
        : ['', '0', '00000000-0000-0000-0000-000000000000', ''];
      const page = await withConnection(pool, (tx) =>
        tx.query<Locator & { account_id: string }>(
          `SELECT store,record_key::text,role,account_id::text,source_transaction_id::text,source_position::text,delivery_position::text
        FROM semantic.erasure_locator WHERE partition_no=$1 AND delivery_position=$2::bigint
        AND (store,record_key,account_id,role)>($3,$4::bigint,$5::uuid,$6)
        ORDER BY store,semantic.erasure_locator.record_key,semantic.erasure_locator.account_id,role LIMIT 1`,
          [partition, position, ...after],
        ),
      );
      const locator = page.rows[0];
      const delivered = locator ? await deliverLocator(pool, partition, locator.account_id, locator) : true;
      const next = locator && delivered ? [locator.store, locator.record_key, locator.account_id, locator.role] : after;
      await runCommand(pool, { partition, basis: platform }, async (tx) => {
        const locked = await tx.query(
          `SELECT after_store,after_key::text,after_account::text,after_role,complete
          FROM semantic.erasure_delivery WHERE partition_no=$1 AND source_position=$2 FOR UPDATE`,
          [partition, position],
        );
        const previous = locked.rows[0];
        if (
          previous?.complete ||
          (previous &&
            [previous.after_store, previous.after_key, previous.after_account, previous.after_role].join(':') !==
              after.join(':'))
        )
          return noEffect(null);
        await tx.query(
          `INSERT INTO semantic.erasure_delivery(partition_no,source_position,after_store,after_key,after_account,after_role,complete)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(partition_no,source_position) DO UPDATE
          SET after_store=EXCLUDED.after_store,after_key=EXCLUDED.after_key,after_account=EXCLUDED.after_account,after_role=EXCLUDED.after_role,complete=EXCLUDED.complete`,
          [partition, position, ...next, !locator],
        );
        return {
          value: null,
          events: [
            {
              type: locator ? SEMANTIC_LOCATOR_SCHEDULED : SEMANTIC_LOCATOR_ADVANCED,
              data: { position },
            },
          ],
        };
      });
    },
  };
}
