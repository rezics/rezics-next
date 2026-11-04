import { t } from 'elysia';
import type { Static } from 'typebox';
import { Compile } from 'typebox/compile';

const closed = { additionalProperties: false };
const id = t.String({ minLength: 1, maxLength: 128 });
const label = t.String({ minLength: 1, maxLength: 1024 });
const opaque = (maxLength: number) => t.String({ minLength: 1, maxLength });
const viewer = t.Object(
  { open: t.Union([t.Literal('permitted'), t.Literal('denied'), t.Literal('unavailable')]) },
  closed,
);
const item = t.Union([
  t.Object(
    {
      scope: t.Object({ kind: t.Literal('board'), id }, closed),
      label,
      parent: t.Union([t.Object({ id, label }, closed), t.Null()]),
      queues: t.Array(t.Union([t.Literal('reports'), t.Literal('appeals'), t.Literal('resolved')]), {
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      }),
      viewer,
    },
    closed,
  ),
  t.Object(
    {
      scope: t.Object({ kind: t.Literal('catalogue') }, closed),
      label,
      parent: t.Null(),
      queues: t.Array(t.Union([t.Literal('reports'), t.Literal('resolved')]), {
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
      }),
      viewer,
    },
    closed,
  ),
]);

/** Public mounted input; directory and selected-queue frontiers are independent. */
export const ModerationDirectoryQuerySchema = t.Object(
  {
    cursor: t.Optional(opaque(4096)),
    realmId: t.Optional(id),
    limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
  },
  closed,
);

/** Candidate references, grants, counts and private case payloads never cross this boundary. */
export const ModerationDirectoryPageSchema = t.Union([
  t.Object(
    {
      state: t.Literal('ready'),
      items: t.Array(item, { maxItems: 20 }),
      next: t.Union([opaque(4096), t.Null()]),
      source: opaque(256),
      validUntil: t.String({ format: 'date-time', maxLength: 40 }),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Union([
        t.Literal('preparing'),
        t.Literal('unavailable'),
        t.Literal('denied'),
        t.Literal('stale'),
      ]),
      items: t.Tuple([]),
      next: t.Null(),
    },
    closed,
  ),
]);
export type ModerationDirectoryPage = Static<typeof ModerationDirectoryPageSchema>;
export type ModerationDirectoryInput = Readonly<{ cursor?: string; realmId?: string; limit: number }>;

const validate = Compile(ModerationDirectoryPageSchema);

/** Cross-field public invariants supplement the closed OpenAPI shape. This
 * validates an observation's lifetime; it does not establish native authority. */
export function moderationDirectoryPageIssues(value: unknown, now = Date.now()) {
  if (!validate.Check(value)) return [{ pointer: '', code: 'invalid_page' }];
  const page = value as ModerationDirectoryPage;
  if (page.state !== 'ready') return [];
  const until = Date.parse(page.validUntil);
  if (!Number.isFinite(until) || until <= now || until > now + 180_000)
    return [{ pointer: '/validUntil', code: 'invalid_lifetime' }];
  const scopes = page.items.map(({ scope }) => (scope.kind === 'board' ? `board:${scope.id}` : 'catalogue'));
  return new Set(scopes).size === scopes.length ? [] : [{ pointer: '/items', code: 'duplicate_scope' }];
}
