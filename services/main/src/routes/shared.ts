import { t } from 'elysia';

export const groupUuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

export const sourceRightsEvidence = t.Object({ basis: t.Union([
  t.Literal('unknown'), t.Literal('facts'), t.Literal('original'),
  t.Literal('license'), t.Literal('permission'), t.Literal('exception') ]),
note: t.String({ maxLength: 1024 }) }, { additionalProperties: false });

export const titleControlBasis = t.Object({ head: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
  epoch: t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' }),
  protection: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })) },
{ additionalProperties: false });

export const groupAgent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });

export const groupGeneration = t.String({ pattern: '^(0|[1-9][0-9]*)$' });
