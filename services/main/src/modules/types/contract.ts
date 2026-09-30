import { t } from 'elysia';
import type { Static } from 'typebox';
import {
  typeBases,
  typeCovers,
  typeCreationPolicies,
  typeInterests,
  typeLocales,
  typePresentations,
  typePrimaryActions,
} from '../../../../../packages/model/src/generated/types.ts';

const closed = { additionalProperties: false } as const;
const label = t.String({ minLength: 1, maxLength: 64 });
const forms = t.Object({ one: label, other: label }, closed);

/** Registry metadata never grants a capability or replaces Access authorization. */
export const typeDefinition = t.Object(
  {
    type: t.String({ minLength: 1, maxLength: 2048 }),
    base: t.String({ enum: typeBases }),
    /** One fallback entry per base; it does not widen any write operation's admission. */
    default: t.Boolean(),
    /** Whether native type edits admit this descriptive type. */
    creatable: t.Boolean(),
    creation: t.String({ enum: typeCreationPolicies }),
    interest: t.Nullable(t.String({ enum: typeInterests })),
    primaryAction: t.String({ enum: typePrimaryActions }),
    presentation: t.String({ enum: typePresentations }),
    cover: t.String({ enum: typeCovers }),
    /** Lower values win when choosing one presentation for a multiply typed Work. */
    priority: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    labels: t.Object(
      Object.fromEntries(typeLocales.map((locale) => [locale, forms])) as Record<
        (typeof typeLocales)[number],
        typeof forms
      >,
      closed,
    ),
  },
  closed,
);

/** One bounded owner read per TTL per process; warm reads reuse the serialized body. */
export const TYPES_READ_COST = {
  graphReads: 0,
  ownerReads: 1,
  ttlMs: 5_000,
  maxTypes: 128,
  maxBytes: 256 * 1024,
} as const;
export const typeList = t.Object(
  {
    profile: t.Literal('types-v1'),
    digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
    types: t.Array(typeDefinition, { maxItems: TYPES_READ_COST.maxTypes }),
  },
  closed,
);

export type TypeDefinition = Static<typeof typeDefinition>;
export const typeIri = t.String({
  minLength: 1,
  maxLength: 2048,
  pattern: '^(https?://|urn:)[^\\s<>"{}|\\\\^`]+$',
});
/** Runtime membership, rather than an enum frozen when an HTTP validator compiles. */
export const registryWorkType = t.String({ ...typeIri, format: 'rezics-work-type' });
const requestKey = t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' });
const actingSubject = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const {
  type: _type,
  base: _base,
  default: _default,
  creatable: _creatable,
  ...metadata
} = typeDefinition.properties;
/** Descriptive types cannot specify properties, shape closure or executable behavior. */
export const typeAdmission = t.Object(
  {
    profile: t.Literal('type-admission-v1'),
    type: typeIri,
    base: t.Union([t.Literal('work'), t.Literal('resource')]),
    ...metadata,
    actingSubject,
    idempotencyKey: requestKey,
  },
  closed,
);
export const typeRetirement = t.Object(
  {
    profile: t.Literal('type-retirement-v1'),
    type: typeIri,
    expectedRevision: t.String({ maxLength: 18, pattern: '^[1-9][0-9]{0,17}$' }),
    actingSubject,
    idempotencyKey: requestKey,
  },
  closed,
);
export const typeAdmissionResult = t.Object(
  {
    profile: t.Literal('type-admission-result-v1'),
    definition: typeDefinition,
    revision: t.String({ pattern: '^[1-9][0-9]*$' }),
    lifecycle: t.Union([t.Literal('active'), t.Literal('retired')]),
    replayed: t.Boolean(),
  },
  closed,
);
export type TypeAdmission = Static<typeof typeAdmission>;
export type TypeRetirement = Static<typeof typeRetirement>;
export type TypeAdmissionResult = Static<typeof typeAdmissionResult>;
export const TYPE_ADMISSION_COST = {
  graphCalls: 0,
  ownerStatements: 24,
  maxRows: TYPES_READ_COST.maxTypes + 1,
  deadlineMs: 10_000,
} as const;
