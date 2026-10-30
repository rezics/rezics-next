import { Type } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const offer = Type.Object({ offerId: id }, { additionalProperties: false });
const entitlement = Type.Object({ entitlementId: id, orderId: id }, { additionalProperties: false });

/** Closed, identifier-only data; state is read from the owning commerce partition. */
export const COMMERCE_EVENTS = {
  'com.rezics.commerce.payout_statement.updated.v1': Type.Object({ statementId: id }, { additionalProperties: false }),
  'com.rezics.commerce.payout_statement.paid.v1': Type.Object({ statementId: id }, { additionalProperties: false }),
  'com.rezics.commerce.offer.created.v1': offer,
  'com.rezics.commerce.offer.revised.v1': offer,
  'com.rezics.commerce.offer.delisted.v1': offer,
  'com.rezics.commerce.order.created.v1': Type.Object({ orderId: id }, { additionalProperties: false }),
  'com.rezics.commerce.order.repair_requested.v1': Type.Object(
    { orderId: id, name: Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' }) },
    { additionalProperties: false },
  ),
  'com.rezics.commerce.order.updated.v1': Type.Object(
    { orderId: id, revision: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.commerce.money.observed.v1': Type.Object(
    {
      orderId: id,
      transactionIds: Type.Array(Type.String({ pattern: '^txn_.+$' }), { maxItems: 256, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.commerce.transactions.recorded.v1': Type.Object(
    {
      orderId: id,
      creatorAccountId: id,
      transactionIds: Type.Array(Type.String({ pattern: '^txn_.+$' }), { minItems: 1, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.commerce.entitlement.granted.v1': entitlement,
  'com.rezics.commerce.entitlement.revoked.v1': Type.Object(
    { entitlementId: id, orderId: id, reason: Type.Union([Type.Literal('refund'), Type.Literal('dispute')]) },
    { additionalProperties: false },
  ),
  'com.rezics.commerce.entitlement.restored.v1': entitlement,
} as const;
