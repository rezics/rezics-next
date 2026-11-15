import { t } from 'elysia';
import { HOSTED_PAGE_LIMIT } from './hosted-chapters-limits.ts';
import {
  HostedChapterTargetSchema,
  HostedIdSchema,
  HostedLanguageKeySchema,
  HostedLanguagePreferenceQueryFields,
  HostedResolutionSchema,
  HostedRevisionSchema,
  HostedSelectionFields,
} from './hosted-chapters-schemas.ts';

const closed = { additionalProperties: false } as const;
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const choice = { ...HostedSelectionFields, ...HostedLanguagePreferenceQueryFields };

/** A partial exact tuple cannot accidentally become a preference-based selection. */
export const HostedLanguageOccurrenceQuerySchema = t.Union([
  t.Object(choice, closed),
  t.Object(
    {
      ...choice,
      targetPostId: HostedIdSchema,
      targetRevisionId: HostedIdSchema,
      targetSha256: digest,
    },
    closed,
  ),
]);

export const HostedBindChapterLanguageSchema = t.Object(
  {
    expectedRevisionId: HostedIdSchema,
    language: HostedLanguageKeySchema,
    title: t.String({ minLength: 1, maxLength: 256 }),
    target: t.Union([HostedChapterTargetSchema, t.Null()]),
    makeDefault: t.Optional(t.Boolean()),
  },
  closed,
);

export const HostedChapterLanguagesQuerySchema = t.Object(
  {
    ...HostedSelectionFields,
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
  },
  closed,
);

export const HostedChapterLanguagesPageSchema = t.Object(
  {
    ...HostedRevisionSchema.properties,
    occurrenceId: HostedIdSchema,
    items: t.Array(
      t.Object(
        {
          language: HostedLanguageKeySchema,
          title: t.String({ minLength: 1, maxLength: 256 }),
          target: HostedChapterTargetSchema,
          isDefault: t.Boolean(),
        },
        closed,
      ),
      { maxItems: HOSTED_PAGE_LIMIT },
    ),
    nextCursor: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
  },
  closed,
);

export const HostedOccurrenceBodySchema = t.Object(
  { ...HostedResolutionSchema.properties, selectedLanguage: t.Union([HostedLanguageKeySchema, t.Null()]) },
  closed,
);
