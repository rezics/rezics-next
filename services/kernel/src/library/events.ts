import { Type } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Closed library events. Private updates identify the changed item without exposing its state. Collection events carry the collection id; a member fact also carries its member and subject ids. */
export const LIBRARY_EVENTS = {
  'com.rezics.library.bangumi.changed.v1': Type.Object(
    { operation: Type.String({ maxLength: 16 }) },
    { additionalProperties: false },
  ),
  'com.rezics.library.bulk.confirmed.v1': Type.Object({ operationId: id }, { additionalProperties: false }),
  'com.rezics.library.bulk.changed.v1': Type.Object({ operationId: id }, { additionalProperties: false }),
  'com.rezics.library.collection.order-repair.advanced.v1': Type.Object(
    { collectionId: id, repairId: id, step: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false },
  ),
  'com.rezics.library.follow-count.applied.v1': Type.Object({ targetId: id }, { additionalProperties: false }),
  'com.rezics.library.follow-count.withdrawn.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.library.shelf-maintenance.advanced.v1': Type.Object({ accountId: id }, { additionalProperties: false }),
  'com.rezics.library.collection.retention-purged.v1': Type.Object(
    { collectionId: id, deletionId: id, removed: Type.Integer({ minimum: 1, maximum: 64 }) },
    { additionalProperties: false },
  ),
  'com.rezics.library.type-preparation.changed.v1': Type.Object({ preparationId: id }, { additionalProperties: false }),
  'com.rezics.library.account-graph.purged.v1': Type.Object(
    {
      accountId: id,
      kind: Type.String({ minLength: 1, maxLength: 64 }),
      removed: Type.Integer({ minimum: 0, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.library.pin.updated.v1': Type.Object({ collectionId: id }, { additionalProperties: false }),
  'com.rezics.library.account-facts.purged.v1': Type.Object(
    {
      accountId: id,
      kind: Type.Union([
        Type.Literal('entry'),
        Type.Literal('copy'),
        Type.Literal('follow'),
        Type.Literal('published_log'),
      ]),
      examined: Type.Integer({ minimum: 0, maximum: 100 }),
      removed: Type.Integer({ minimum: 0, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.library.subject.listed.v1': Type.Object({ subjectId: id }, { additionalProperties: false }),
  'com.rezics.library.follow.updated.v1': Type.Object({ targetId: id }, { additionalProperties: false }),
  'com.rezics.library.entry.updated.v1': Type.Object({ subjectId: id }, { additionalProperties: false }),
  'com.rezics.library.entry.purged.v1': Type.Object({ deletionId: id }, { additionalProperties: false }),
  'com.rezics.library.entry.deleted.v1': Type.Object({ subjectId: id }, { additionalProperties: false }),
  'com.rezics.library.label.retention-purged.v1': Type.Object({ labelId: id }, { additionalProperties: false }),
  'com.rezics.library.label.changed.v1': Type.Object({ labelId: id }, { additionalProperties: false }),
  'com.rezics.library.progress_session.updated.v1': Type.Object({ sessionId: id }, { additionalProperties: false }),
  'com.rezics.library.copy.updated.v1': Type.Object({ copyId: id }, { additionalProperties: false }),
  'com.rezics.library.copy.deleted.v1': Type.Object({ copyId: id }, { additionalProperties: false }),
  'com.rezics.library.published_log.updated.v1': Type.Object({ logId: id }, { additionalProperties: false }),
  'com.rezics.library.published_log.purged.v1': Type.Object({ logId: id }, { additionalProperties: false }),
  'com.rezics.library.published_log.deleted.v1': Type.Object({ logId: id }, { additionalProperties: false }),
  'com.rezics.library.collection.updated.v1': Type.Object({ collectionId: id }, { additionalProperties: false }),
  'com.rezics.library.collection.deleted.v1': Type.Object({ collectionId: id }, { additionalProperties: false }),
  'com.rezics.library.collection.member.changed.v1': Type.Object(
    { collectionId: id, memberId: id, subjectId: id },
    { additionalProperties: false },
  ),
  'com.rezics.library.collection.member.purged.v1': Type.Object(
    { memberId: id, deletionId: id },
    { additionalProperties: false },
  ),
  'com.rezics.library.collection.listing.changed.v1': Type.Object(
    { collectionId: id },
    { additionalProperties: false },
  ),
} as const;
