import { t } from 'elysia';

const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const native = t.String({ pattern: '^https://rezics.com/id/[0-9a-f-]{36}$' });
const identity = t.Object({ key: t.String(), provider: t.String(), namespace: t.String(), externalId: t.String() }, { additionalProperties: false });
const snapshot = t.Object({ id: t.String(), digest, fileSha256: digest }, { additionalProperties: false });
const intakes = t.Array(t.Object({ index: t.Integer({ minimum: 0, maximum: 511 }), record: native,
  observation: native, byteDigest: digest }, { additionalProperties: false }), { minItems: 1, maxItems: 512 });
const payload = t.Object({ format: t.Union([t.Literal('json'), t.Literal('rezics-dataset-chunk-v1')]),
  byteDigest: digest, byteLength: t.Integer({ minimum: 1, maximum: 16777216 }) }, { additionalProperties: false });
export const retainedConversionRequest = t.Object({ profile: t.Literal('source-retained-record-conversion-v1'),
  mappingRevision: t.String(), retained: t.Object({ identity, snapshot, recordDigest: digest, intakes, payload,
    record: t.Object({ key: t.String(), provider: t.Union([t.Literal('vndb'), t.Literal('bangumi'), t.Literal('musicbrainz')]),
      kind: t.String(), externalId: t.String(), title: t.String(), language: t.String(), sourceUrl: t.String(),
      native: t.Union((['work', 'release', 'person', 'organization', 'character', 'concept', 'source-only', 'episode'] as const)
        .map(value => t.Literal(value))), data: t.Record(t.String(), t.Unknown()),
      semanticTypes: t.Optional(t.Array(t.String())) }, { additionalProperties: false }) }, { additionalProperties: false }) },
{ additionalProperties: false });
export const retainedRecordBinding = t.Object({ profile: t.Literal('source-retained-record-binding-v1'),
  identity, snapshot, recordDigest: digest, intakes, payload, binding: native, sourceRecord: native,
  conversion: native, mappingRevision: t.String(), normalizationRevision: t.String() });
export const retainedConversionResult = t.Object({ profile: t.Literal('source-retained-record-conversion-v1'),
  state: t.Literal('staged'), conversion: native, observation: native, mappingRevision: t.String(), sourceDigest: digest,
  retainedRecord: retainedRecordBinding, fieldInventory: t.Array(t.Object({ grain: t.String(), field: t.String(),
    pointer: t.String(), disposition: t.String(), reason: t.String(), role: t.String(),
    ordinal: t.Optional(t.Integer()), language: t.Optional(t.Nullable(t.String())) })), createdAt: t.String() });
