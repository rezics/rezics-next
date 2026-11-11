import { Type } from 'typebox';

const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const changed = Type.Object({ catalogueId: uuid, revisionId: uuid }, { additionalProperties: false });

/** Payloads name immutable snapshots; private chapter selections never enter the outbox. */
export const HOSTED_CHAPTER_EVENTS = {
  'com.rezics.content.hosted-catalogue.create.v1': changed,
  'com.rezics.content.hosted-catalogue.revise.v1': changed,
  'com.rezics.content.hosted-catalogue.publish.v1': changed,
} as const;
