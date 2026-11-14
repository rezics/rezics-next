import { Type } from 'typebox';

const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const changed = Type.Object({ catalogueId: uuid, revisionId: uuid }, { additionalProperties: false });
const preparationChanged = Type.Object({ catalogueId: uuid, stageId: uuid }, { additionalProperties: false });

/** Payloads name immutable snapshots; private chapter selections never enter the outbox. */
export const HOSTED_CHAPTER_EVENTS = {
  'com.rezics.content.hosted-catalogue.create.v1': changed,
  'com.rezics.content.hosted-catalogue.revise.v1': changed,
  'com.rezics.content.hosted-catalogue.publish.v1': changed,
  'com.rezics.content.hosted-catalogue.preparation.changed.v1': preparationChanged,
  'com.rezics.content.hosted-catalogue.activation.changed.v1': preparationChanged,
  'com.rezics.content.hosted-catalogue.publication.activated.v1': preparationChanged,
} as const;
