import { Type } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const revision = Type.Integer({ minimum: 1 });
const linkChange = Type.Object(
  {
    property: Type.String({ minLength: 1 }),
    statement: UUID,
    target: UUID,
    present: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SUBJECT_MERGED = 'com.rezics.subject.merged.v1' as const;
export const LINKS_MOVING = 'com.rezics.semantic.links.moving.v1' as const;

export const LINKS_CHANGED = 'com.rezics.semantic.links.changed.v1' as const;
export const LINKS_PROJECTED = 'com.rezics.semantic.links.projected.v1' as const;

/** Closed semantic event catalogue. Envelope identity and ordering belong to the kernel. */
export const SEMANTIC_EVENTS = {
  [SUBJECT_MERGED]: Type.Object({ id: UUID, survivor: UUID }, { additionalProperties: false }),
  [LINKS_MOVING]: Type.Object(
    { id: UUID, survivor: UUID, cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])) },
    { additionalProperties: false },
  ),
  'com.rezics.statement.retracted.v1': Type.Object({ candidate: UUID, revision }, { additionalProperties: false }),
  'com.rezics.statement.proposed.v1': Type.Object({ candidate: UUID, revision }, { additionalProperties: false }),
  'com.rezics.statement.accepted.v1': Type.Object(
    { candidate: UUID, context: UUID, revision, head: revision },
    { additionalProperties: false },
  ),
  'com.rezics.statement.rejected.v1': Type.Object(
    { candidate: UUID, context: UUID, revision, head: revision },
    { additionalProperties: false },
  ),
  'com.rezics.subject.adopted.v1': Type.Object(
    {
      context: UUID,
      property: Type.String({ minLength: 1 }),
      mode: Type.Union([Type.Literal('inherit'), Type.Literal('replace'), Type.Literal('suppress')]),
      revision,
      head: revision,
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.links.changed.v1': Type.Object(
    {
      subject: UUID,
      revision,
      security_revision: Type.Integer({ minimum: 0 }),
      changes: Type.Array(linkChange, { minItems: 1, maxItems: 1024 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.links.projected.v1': Type.Object(
    { subjects: Type.Array(UUID, { minItems: 1 }) },
    { additionalProperties: false },
  ),
} as const;
