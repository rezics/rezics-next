import { t } from 'elysia';
export const reasons = t.Object(
  {
    facts: t.String({ minLength: 1, maxLength: 4000 }),
    scope: t.String({ minLength: 1, maxLength: 4000 }),
    duration: t.String({ minLength: 1, maxLength: 4000 }),
    automation: t.Boolean(),
    appealRoute: t.Literal('/v1/public-reports/{caseId}/correspondence'),
    contentLanguage: t.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);
