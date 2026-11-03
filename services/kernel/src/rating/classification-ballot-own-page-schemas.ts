import { t } from 'elysia';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { ClassificationBallotAggregateResponseSchema } from './schemas.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const cursor = t.String({ minLength: 1, maxLength: 4096 });
const path = t.Union([t.String({ minLength: 1, maxLength: 256 }), t.Null()]);
const digest = t.String({ pattern: '^[a-f0-9]{64}$' });

export const ClassificationBallotOwnPageQuerySchema = t.Object(
  {
    cursor: t.Optional(cursor),
    selectedSubjectId: t.Optional(id),
    selectedAssociationId: t.Optional(id),
  },
  closed,
);

const SummarySchema = t.Object(
  {
    id,
    type: t.String({ minLength: 1, maxLength: 256 }),
    label: t.Union([t.String({ minLength: 1, maxLength: 2000 }), t.Null()]),
    href: t.String({ minLength: 1, maxLength: 128 }),
  },
  closed,
);

const AssociationSchema = t.Object(
  {
    subjectId: id,
    associationId: id,
    slotId: id,
    property: t.String({ minLength: 1, maxLength: 256 }),
    targetId: id,
    contextId: t.Literal(GLOBAL_CONTEXT),
    origin: t.Literal('global'),
    release: t.String({ minLength: 1, maxLength: 128 }),
    revision: t.Integer({ minimum: 1 }),
    bindingHash: digest,
    statementDigest: digest,
    qualifiersDigest: digest,
  },
  closed,
);

const OwnSchema = t.Object(
  {
    assessment: t.Union([t.Literal('support'), t.Literal('oppose')]),
    falsePositive: t.Boolean(),
    revision: t.String({ pattern: '^[1-9][0-9]*$' }),
    pending: t.Union([t.Literal('current'), t.Literal('pending'), t.Literal('unknown')]),
  },
  closed,
);

const ActionsSchema = t.Object(
  {
    state: t.Union([t.Literal('editable'), t.Literal('read-only'), t.Literal('withdraw-only'), t.Literal('withheld')]),
    readback: path,
    set: path,
    clear: path,
  },
  closed,
);

const AvailableItemSchema = t.Object(
  {
    state: t.Literal('available'),
    subjectId: id,
    associationId: id,
    subject: SummarySchema,
    target: SummarySchema,
    association: AssociationSchema,
    own: OwnSchema,
    aggregate: t.Union([ClassificationBallotAggregateResponseSchema, t.Null()]),
    actions: ActionsSchema,
  },
  closed,
);

const WithheldItemSchema = t.Object(
  {
    state: t.Literal('withheld'),
    subjectId: id,
    associationId: id,
    subject: t.Null(),
    target: t.Null(),
    association: t.Null(),
    own: OwnSchema,
    aggregate: t.Null(),
    actions: ActionsSchema,
  },
  closed,
);

export const ClassificationBallotOwnPageSchema = t.Object(
  {
    viewer: t.Object({ accountId: id }, closed),
    inventory: t.Object(
      {
        kind: t.Literal('current-retained'),
        complete: t.Literal(false),
        generation: t.Union([t.String({ pattern: '^[1-9][0-9]*$' }), t.Null()]),
        cleanup: t.Union([t.Literal('not-started'), t.Literal('pending'), t.Literal('settled')]),
      },
      closed,
    ),
    items: t.Array(t.Union([AvailableItemSchema, WithheldItemSchema]), { maxItems: 21 }),
    traversal: t.Union([t.Literal('more'), t.Literal('complete')]),
    next: t.Union([cursor, t.Null()]),
  },
  closed,
);
