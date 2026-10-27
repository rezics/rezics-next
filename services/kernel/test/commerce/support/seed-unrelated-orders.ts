import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  EXPIRY_SYNC_WORKFLOW,
  ORDER_RECONCILE_WORKFLOW,
  WORKFLOWS_QUEUE,
} from '../../../src/commerce/work-contract.ts';
import { derivedId, routeOf } from '../../../src/route/route.ts';
import { WORK_APPLICATION } from '../../../src/work/client.ts';

/** Native population only: no provider calls or runnable work, and no measured checkpoint moves. */
export async function seedUnrelatedOrders(
  pool: Pool,
  offerId: string,
  accounts: readonly { id: string; route: number }[],
  from: number,
  total: number,
  instant: string,
) {
  // Two completed workflows per order keep every INSERT at or below 1000 rows.
  for (let start = from; start < total; start += 500) {
    const rows = Array.from({ length: Math.min(500, total - start) }, (_, offset) => {
      const index = start + offset;
      const account = accounts[index % accounts.length]!;
      const id = derivedId(accounts[0]!.id, `unrelated-order:${index}`, account.route);
      return {
        id,
        route: account.route,
        buyer: account.id,
        session: `cs_test_fixture${id.replaceAll('-', '')}`,
        transaction: derivedId(id, 'settlement', account.route),
        event: derivedId(id, 'event', account.route),
        digest: createHash('sha256')
          .update(canonicalize({ orderId: id })!)
          .digest('hex'),
      };
    });
    // Same-buyer-partition orders exercise account filtering. Completed history grows only in
    // dedicated seed partitions: touching the buyer's checkpoint could skip measured events.
    // Failed unpaid orders have neither entitlements nor balance transactions. Native internal
    // apply receipts need no Access write_basis; requests only append new basis keys. Executor
    // operation_outputs are outside HTTP capture (enqueue uses status/input/output); final settle
    // still runs real measured steps. No provider observations or step results are invented here.
    const result = await pool.query<{ count: number }>(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           id uuid, route int, buyer uuid, session text, transaction uuid, event uuid, digest text)
       ), inserted AS (
         INSERT INTO commerce.purchase_order
           (route, order_id, buyer_account_id, offer_id, offer_revision, target_subject_id,
            creator_account_id, title, currency, unit_amount_minor, tax_code, royalty_basis_points,
            settlement, checkout_session_id, checkout_url, checkout_expires_at, observed_at,
            created_at, updated_at, revision, transaction_id)
         SELECT i.route, i.id, i.buyer, o.offer_id, o.revision, o.target_subject_id,
           o.creator_account_id, o.title, o.currency, o.unit_amount_minor, o.tax_code, o.royalty_basis_points,
           'failed', i.session, 'https://checkout.stripe.com/c/pay/' || i.session, $5::timestamptz,
           $6::timestamptz, $4::timestamptz, $6::timestamptz, 3, i.transaction
         FROM input i CROSS JOIN commerce.offer o WHERE o.route = $3 AND o.offer_id = $2
         RETURNING *
       ), projected AS (
         SELECT o.*, i.event, i.digest, jsonb_build_object(
           'id', order_id, 'buyerAccountId', buyer_account_id, 'offerId', offer_id,
           'offerRevision', offer_revision, 'targetSubjectId', target_subject_id,
           'creatorAccountId', creator_account_id, 'title', title, 'currency', currency,
           'unitAmountMinor', unit_amount_minor::int, 'amountTaxMinor', amount_tax_minor::int,
           'taxCode', tax_code, 'royaltyBasisPoints', royalty_basis_points, 'settlement', settlement,
           'checkoutSessionId', checkout_session_id, 'checkoutUrl', checkout_url,
           'checkoutExpiresAt', to_char(checkout_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'revision', revision) AS snapshot
         FROM inserted o JOIN input i ON i.id = o.order_id
       ), counts AS (
         SELECT route >> 4 AS partition_no, count(*) AS total FROM projected
         WHERE route <> $7 GROUP BY route >> 4
       ), heads AS (
         UPDATE core.partition p SET position = p.position + c.total FROM counts c
         WHERE p.partition_no = c.partition_no
         RETURNING p.partition_no, p.epoch, p.position - c.total AS start_position, p.position
       ), history AS (
         SELECT o.*, h.partition_no, h.epoch,
           h.start_position + row_number() OVER (PARTITION BY h.partition_no ORDER BY o.order_id) AS position
         FROM projected o JOIN heads h ON h.partition_no = o.route >> 4
       ), events AS (
         INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data, recorded_at)
         SELECT partition_no, position, 0, 1, epoch, event, 'com.rezics.commerce.order.updated.v1',
           order_id::text, jsonb_build_object('orderId', order_id, 'revision', revision), observed_at FROM history
       ), receipts AS (
         INSERT INTO core.receipt (partition_no, principal_kind, principal_id, command_kind,
           idempotency_key, request_digest, epoch, position, transaction_id, response, created_at)
         SELECT partition_no, 'account', buyer_account_id, 'commerce.checkout.apply',
           'wf:order:' || order_id || ':expiry:apply', decode(digest, 'hex'), epoch, position, transaction_id,
           jsonb_build_object('changed', true, 'order', snapshot, 'entitlement', NULL,
             'entitlementAction', jsonb_build_object('kind', 'none'), 'newTransactions', '[]'::jsonb), observed_at
         FROM history
       ), workflows AS (
         INSERT INTO dbos.workflow_status (workflow_uuid, status, name, queue_name, application_name,
           serialization, created_at, updated_at, completed_at)
         SELECT 'order:' || order_id || ':' || w.suffix, 'SUCCESS', w.name, '${WORKFLOWS_QUEUE}', '${WORK_APPLICATION}',
           'portable_json', (extract(epoch FROM created_at) * 1000)::bigint,
           (extract(epoch FROM observed_at) * 1000)::bigint, (extract(epoch FROM observed_at) * 1000)::bigint
         FROM inserted CROSS JOIN (VALUES ('${ORDER_RECONCILE_WORKFLOW}', 'reconcile'), ('${EXPIRY_SYNC_WORKFLOW}', 'expiry')) w(name, suffix)
         RETURNING workflow_uuid, completed_at
       ), inputs AS (
         INSERT INTO dbos.workflow_input (workflow_uuid, inputs, retention_timestamp)
         SELECT workflow_uuid, jsonb_build_object('positionalArgs', jsonb_build_array(o.order_id), 'namedArgs', '{}'::jsonb)::text,
           completed_at FROM workflows w JOIN inserted o ON w.workflow_uuid IN (
             'order:' || o.order_id || ':reconcile', 'order:' || o.order_id || ':expiry')
       ), outputs AS (
         INSERT INTO dbos.workflow_output (workflow_uuid, output, retention_timestamp)
         SELECT workflow_uuid, 'null', completed_at FROM workflows
       ), checkpoints AS (
         INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
         SELECT partition_no, consumer, epoch, position FROM heads CROSS JOIN (VALUES ('effects'), ('semantic_links')) c(consumer)
         ON CONFLICT (partition_no, consumer) DO UPDATE SET epoch = EXCLUDED.epoch, position = EXCLUDED.position, updated_at = now()
       ) SELECT count(*)::int AS count FROM inserted`,
      [
        JSON.stringify(rows),
        offerId,
        routeOf(offerId),
        new Date(Date.parse(instant) - 7_200_000).toISOString(),
        new Date(Date.parse(instant) - 3_600_000).toISOString(),
        instant,
        accounts[0]!.route,
      ],
    );
    if (result.rows[0]?.count !== rows.length) throw new Error('Unrelated orders require the real fixture offer');
  }
}
