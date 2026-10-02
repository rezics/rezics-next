import { t } from 'elysia';
import type { TProperties } from 'typebox';
import type { DocumentSnapshot } from '@rezics/document';

/** Wire shape; the document package performs the full node/mark/profile validation. */
export const documentSnapshotSchema = t.Unsafe<DocumentSnapshot>(t.Object({ version: t.Literal('rezics-document-v1'),
  profile: t.Union([t.Literal('text'), t.Literal('blocks')]),
  doc: t.Record(t.String(), t.Unknown()) }, { additionalProperties: false }));

export function authoredBodySchema<T extends TProperties>(fields: T, maxLength = 65_536, minLength = 0) {
  return t.Union([
    t.Object({ ...fields, body: t.String({ minLength, maxLength }) }, { additionalProperties: false }),
    t.Object({ ...fields, document: documentSnapshotSchema }, { additionalProperties: false }),
  ]);
}
