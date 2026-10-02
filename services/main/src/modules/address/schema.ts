import { t } from 'elysia';
export const canonicalAddress = t.Object(
  { prefix: t.String(), key: t.String(), slugSource: t.String() },
  { additionalProperties: false },
);
