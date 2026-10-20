import { t } from 'elysia';
import type { Static } from 'typebox';

const closed = { additionalProperties: false } as const;
// Independent of the Work header schema: headers and entity pages both embed
// this descriptor, while the query templates themselves consume Work schemas.
const root = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
export const navigationOperation = t.Union([
  t.Object({ kind: t.Literal('resource'), method: t.Literal('GET'),
    href: t.String({ pattern: '^/v1/[^#{}]+$', maxLength: 4096 }),
    operationId: t.String({ pattern: '^getV1[A-Z]', maxLength: 128 }),
    responseProfile: t.Nullable(t.String({ minLength: 1, maxLength: 128 })),
  }, closed),
  t.Object({ kind: t.Literal('query'), method: t.Literal('POST'),
    href: t.Literal('/v1/query'), operationId: t.Literal('postV1Query'),
    responseProfile: t.Literal('query-v1'),
    request: t.Object({ profile: t.Literal('template-query-v1'),
      query: t.Union([t.Literal('https://rezics.com/query/work-versions'),
        t.Literal('https://rezics.com/query/work-adoptions')]),
      revision: t.Literal(1),
      parameters: t.Object({ roots: t.Tuple([root]) }, closed),
      limit: t.Literal(20),
    }, closed),
  }, closed),
]);
export const catalogueNavigation = t.Record(t.String(), navigationOperation);
export type NavigationOperation = Static<typeof navigationOperation>;
