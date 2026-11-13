import { Type } from 'typebox';

const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const changed = Type.Object({ disclosureId: uuid, catalogueId: uuid }, { additionalProperties: false });

/** Identity-only payloads. Exact private targets never enter the outbox. */
export const REVISION_DISCLOSURE_EVENTS = {
  'com.rezics.content.revision-disclosure.issued.v1': changed,
  'com.rezics.content.revision-disclosure.revoked.v1': changed,
} as const;
