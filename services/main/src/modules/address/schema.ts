import { t } from 'elysia';
export const canonicalAddress = t.Object(
  { prefix: t.String(), key: t.String(), suffixSource: t.String() },
  { additionalProperties: false },
);
