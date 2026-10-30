import canonicalize from 'canonicalize';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { principalCommandIdentity } from '../../../src/command/command.ts';
import { encodeReceiptKey } from '../../../src/command/receipt-key.ts';
import type { Offer } from '../../../src/commerce/model.ts';
import { insertOrder } from '../../../src/commerce/store.ts';
import type { AccountActor } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';

/** Immutable pre-revision native DATA only. No old business engine, account,
 * permission, source authority, provider result or benefit grant is installed.
 * The caller supplies a genuinely published, currently authorized native offer.
 */
export async function retainPreRevisionOrder(
  pool: Pool,
  buyer: AccountActor,
  offer: Offer,
  requestKey = randomUUID(),
  captured = false,
) {
  const route = routeOf(buyer.accountId)!;
  const partition = partitionOf(route);
  const transactionId = randomUUID();
  // Some old receipts also predate benefit/money provenance. Today's offer
  // cannot retroactively supply that meaning to those original accepted orders.
  const order = await insertOrder(
    pool,
    route,
    {
      id: newId(route),
      buyerAccountId: buyer.accountId,
      offer: captured ? offer : { ...offer, contentEdition: null, moneyUnit: null, taxBehavior: null },
    },
    { transactionId, time: new Date().toISOString() },
  );
  const response = { ...order };
  if (!captured) {
    delete response.contentEdition;
    delete response.moneyUnit;
    delete response.taxBehavior;
  }
  const kind = 'commerce.order.create';
  const identity = principalCommandIdentity(buyer);
  const digest = createHash('sha256')
    .update(canonicalize([identity, kind, { offerId: offer.id }])!)
    .digest();
  const head = (await pool.query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [partition]))
    .rows[0];
  await pool.query(
    `INSERT INTO core.receipt
      (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,
       epoch,position,transaction_id,response)
     VALUES ($1,'account',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      partition,
      buyer.accountId,
      kind,
      encodeReceiptKey(testReceiptKeys(), kind, identity.principal, requestKey),
      digest,
      head.epoch,
      head.position,
      transactionId,
      response,
    ],
  );
  return {
    key: requestKey,
    order,
    replay: {
      value: response,
      partition,
      epoch: head.epoch,
      position: BigInt(head.position),
      transactionId,
      replayed: true,
    },
  };
}
