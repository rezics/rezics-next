import { t } from 'elysia';
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
    /** The reviewed Work type-edit set; creation retains the broader Work kind set. */
    creatable: t.Boolean(),
    creation: t.String({ enum: typeCreationPolicies }),
    interest: t.Nullable(t.String({ enum: typeInterests })),
    primaryAction: t.String({ enum: typePrimaryActions }),
    presentation: t.String({ enum: typePresentations }),
    cover: t.String({ enum: typeCovers }),
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

/** No owner/graph reads; startup builds one bounded body, each GET returns it or an empty 304. */
export const TYPES_READ_COST = { graphReads: 0, maxTypes: 128, maxBytes: 256 * 1024 } as const;
export const typeList = t.Object(
  {
    profile: t.Literal('types-v1'),
    digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
    types: t.Array(typeDefinition, { maxItems: TYPES_READ_COST.maxTypes }),
  },
  closed,
);
