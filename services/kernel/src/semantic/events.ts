import { Type } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const revision = Type.Integer({ minimum: 1 });
const verification = Type.Object(
  { account: UUID, receipt: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);
const linkChange = Type.Object(
  {
    context_id: Type.Optional(UUID),
    suppressed: Type.Optional(Type.Boolean()),
    property: Type.String({ minLength: 1 }),
    statement: UUID,
    target: Type.Union([UUID, Type.Null()]),
    present: Type.Boolean(),
    project_outbound: Type.Optional(Type.Boolean()),
    relation: Type.Optional(Type.Boolean()),
    slot_id: Type.Optional(UUID),
    external: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    value: Type.Optional(Type.Union([Type.Literal('value'), Type.Literal('somevalue'), Type.Literal('novalue')])),
    outbound_order: Type.Optional(
      Type.Union([Type.Literal('position'), Type.Literal('date'), Type.Literal('name'), Type.Null()]),
    ),
    outbound_order_key: Type.Optional(Type.String()),
    source_type: Type.Optional(Type.String()),
    order_key: Type.Optional(Type.String()),
    filter_value: Type.Optional(UUID),
  },
  { additionalProperties: false },
);

export const SUBJECT_MERGED = 'com.rezics.subject.merged.v1' as const;
export const SUBJECT_REVISED = 'com.rezics.subject.revised.v1' as const;
export const LINKS_MOVING = 'com.rezics.semantic.links.moving.v1' as const;

export const LINKS_CHANGED = 'com.rezics.semantic.links.changed.v1' as const;
export const LINK_KEYS_CHANGED = 'com.rezics.semantic.links.keys-changed.v1' as const;
export const LINKS_VISIBILITY_CHANGED = 'com.rezics.semantic.links.visibility-changed.v1' as const;
export const LINKS_PROJECTED = 'com.rezics.semantic.links.projected.v1' as const;
export const IDENTITY_EPOCH_BOOTSTRAP = 'com.rezics.semantic.identity-epoch.bootstrap.v1' as const;

/** Closed semantic event catalogue. Envelope identity and ordering belong to the kernel. */
export const SEMANTIC_EVENTS = {
  [IDENTITY_EPOCH_BOOTSTRAP]: Type.Object(
    { partition: Type.Integer({ minimum: 0, maximum: 4095 }), generation: Type.String({ pattern: '^[1-9][0-9]*$' }) },
    { additionalProperties: false },
  ),
  [SUBJECT_MERGED]: Type.Object({ id: UUID, survivor: UUID }, { additionalProperties: false }),
  [SUBJECT_REVISED]: Type.Object(
    {
      id: UUID,
      revision,
      kind: Type.Union([
        Type.Literal('create'),
        Type.Literal('propose'),
        Type.Literal('accept'),
        Type.Literal('reject'),
        Type.Literal('adopt'),
        Type.Literal('merge'),
        Type.Literal('retract'),
        Type.Literal('identity'),
      ]),
    },
    { additionalProperties: false },
  ),
  [LINKS_MOVING]: Type.Object(
    {
      id: UUID,
      survivor: UUID,
      cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])),
      verification: Type.Optional(verification),
    },
    { additionalProperties: false },
  ),
  [LINK_KEYS_CHANGED]: Type.Object(
    {
      subject: UUID,
      direction: Type.Union([Type.Literal('holder'), Type.Literal('target')]),
      revision,
      security_revision: Type.Integer({ minimum: 0 }),
      cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])),
    },
    { additionalProperties: false },
  ),
  [LINKS_VISIBILITY_CHANGED]: Type.Object(
    {
      subject: UUID,
      revision,
      security_revision: Type.Integer({ minimum: 0 }),
      release: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
      visible: Type.Boolean(),
      cursor: Type.Array(Type.Union([Type.String(), Type.Integer()])),
    },
    { additionalProperties: false },
  ),
  'com.rezics.subject.statement_disclosed.v1': Type.Object(
    { id: UUID, candidate: UUID },
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
      changes: Type.Array(linkChange, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.links.projected.v1': Type.Object(
    { subjects: Type.Array(UUID, { minItems: 1 }) },
    { additionalProperties: false },
  ),
} as const;
