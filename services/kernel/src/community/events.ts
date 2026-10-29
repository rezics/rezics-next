import { Type } from 'typebox';

const id = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const address = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' });
/** PostgreSQL `timestamptz::text` under ISO DateStyle: fractional seconds drop trailing zeros. */
const instant = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?[+-]\\d{2}$',
});
const spaceRevision = Type.Object({ spaceId: id, revisionId: id }, { additionalProperties: false });
const realmRevision = Type.Object({ realmId: id, revisionId: id }, { additionalProperties: false });
const addressOnly = Type.Object({ spaceId: id, address }, { additionalProperties: false });
const addressRevision = Type.Object({ spaceId: id, revisionId: id, address }, { additionalProperties: false });

function publication(verdict: 'adopt' | 'withdraw' | 'reject') {
  return Type.Object(
    {
      publicationId: id,
      realmId: id,
      subjectId: id,
      verdict: Type.Literal(verdict),
      predecessor: Type.Union([id, Type.Null()]),
      subjectRevisionId: Type.Null(),
      publishedAt: instant,
    },
    { additionalProperties: false },
  );
}

/** Closed community event catalogue. Envelope identity and ordering belong to the kernel. */
export const COMMUNITY_EVENTS = {
  'com.rezics.community.party-locator.projected.v1': Type.Object({ accountId: id }, { additionalProperties: false }),
  'com.rezics.community.account-records.erased.v1': Type.Object({ accountId: id }, { additionalProperties: false }),
  'com.rezics.community.space.created.v1': spaceRevision,
  'com.rezics.community.space.updated.v1': spaceRevision,
  'com.rezics.community.space.address-claim-pending.v1': addressOnly,
  'com.rezics.community.space.address-claim-accepted.v1': Type.Union([addressOnly, addressRevision]),
  'com.rezics.community.space.address-changed.v1': addressRevision,
  'com.rezics.community.space.address-activated.v1': addressOnly,
  'com.rezics.community.space.address-reservation-skipped.v1': addressOnly,
  'com.rezics.community.space.address-reserved.v1': addressOnly,
  'com.rezics.community.realm.created.v1': realmRevision,
  'com.rezics.community.realm.updated.v1': realmRevision,
  'com.rezics.community.realm.ban.v1': Type.Object(
    {
      realmId: id,
      accountId: id,
      reason: Type.String({ maxLength: 1024 }),
      actor: Type.Union([id, Type.Null()]),
      at: instant,
      transactionId: id,
    },
    { additionalProperties: false },
  ),
  'com.rezics.community.realm.unban.v1': Type.Object(
    { realmId: id, accountId: id, at: instant, transactionId: id },
    { additionalProperties: false },
  ),
  'com.rezics.community.realm.membership.v1': Type.Object(
    {
      realmId: id,
      accountId: id,
      reservationId: id,
      role: Type.Union([Type.Literal('member'), Type.Null()]),
      at: instant,
      transactionId: id,
    },
    { additionalProperties: false },
  ),
  'com.rezics.community.realm.membership.requested.v1': Type.Object(
    {
      realmId: id,
      accountId: id,
      operationId: id,
      kind: Type.Union([Type.Literal('join'), Type.Literal('leave'), Type.Literal('removal')]),
      at: instant,
      transactionId: id,
    },
    { additionalProperties: false },
  ),
  'com.rezics.community.realm.membership.terminalized.v1': Type.Object(
    { realmId: id, accountId: id, reservationId: id, transactionId: id, at: instant },
    { additionalProperties: false },
  ),
  'com.rezics.community.realm.board-scheme.v1': Type.Object(
    { realmId: id, revisionId: id, schemeId: id },
    { additionalProperties: false },
  ),
  'com.rezics.community.publication.adopted.v1': publication('adopt'),
  'com.rezics.community.publication.withdrawn.v1': publication('withdraw'),
  'com.rezics.community.publication.rejected.v1': publication('reject'),
} as const;
