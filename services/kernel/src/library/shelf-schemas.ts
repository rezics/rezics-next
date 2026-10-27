import { t } from 'elysia';
import { ENTRY_STATES, SHELF_DIRECTIONS, SHELF_ORDERS } from './shelf-contract.ts';
import { embedded, subjectFields, viewQuery } from './views.ts';

const closed = { additionalProperties: false } as const;
const text = t.String();
const nullable = t.Union([text, t.Null()]);
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });
export const shelfPageQuery = {
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: t.Optional(t.String({ maxLength: 4096 })),
};
export const shelfListQuerySchema = t.Object(
  {
    ...viewQuery,
    ...shelfPageQuery,
    state: t.Optional(t.Union(ENTRY_STATES.map((value) => t.Literal(value)))),
    orderBy: t.Union(SHELF_ORDERS.map((value) => t.Literal(value))),
    direction: t.Optional(t.Union(SHELF_DIRECTIONS.map((value) => t.Literal(value)))),
    type: t.Optional(text),
  },
  closed,
);
export const shelfSummaryQuerySchema = t.Object({ type: t.Optional(text) }, closed);
export const shelfTypesQuerySchema = t.Object(shelfPageQuery, closed);

// Shelf owns its wire schema; progress routes keep their independent schema ownership.
const uuid = t.String({ format: 'uuid' });
const shelfSessionSchema = t.Object(
  {
    id: uuid,
    subjectId: uuid,
    versionSubjectId: t.Union([uuid, t.Null()]),
    mode: t.Union([t.Literal('scalar_amount'), t.Literal('cursor_position'), t.Literal('completed_units')]),
    unit: t.Union(
      (['page', 'chapter', 'episode', 'volume', 'minute', 'percent'] as const).map((value) => t.Literal(value)),
    ),
    total: nullable,
    amount: nullable,
    locator: nullable,
    position: nullable,
    completedUnitCount: t.Integer({ minimum: 0, maximum: 20_000 }),
    state: t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('abandoned')]),
    revision,
    startedAt: text,
    completedAt: nullable,
  },
  closed,
);
export const shelfEntrySchema = embedded(
  t.Object(
    {
      subjectId: text,
      state: t.Union(ENTRY_STATES.map((value) => t.Literal(value))),
      revision,
      createdAt: text,
      updatedAt: text,
      lastActivityAt: text,
      finishedAt: nullable,
      activeProgressSession: t.Union([shelfSessionSchema, t.Null()]),
    },
    closed,
  ),
  subjectFields,
);
const count = t.Integer({ minimum: 0 });
const tab = t.Object({ total: count, shown: count }, closed);
export const shelfSummarySchema = t.Object(
  {
    tabs: t.Object(
      { all: tab, in_progress: tab, planned: tab, completed: tab, paused: tab, dropped: tab, collections: tab },
      closed,
    ),
  },
  closed,
);
export const shelfTypesSchema = t.Object(
  { types: t.Array(t.Object({ type: text, count }, closed)), next: nullable },
  closed,
);
