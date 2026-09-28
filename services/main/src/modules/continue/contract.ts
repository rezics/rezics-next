import { t } from 'elysia';
import { readAvatar, readId, readName, readUuid } from '../work/read-contract.ts';

export const continueQuery = t.Object({ actingSubject: readId,
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 6 })) }, { additionalProperties: false });
export const continueItem = t.Object({ work: readId, title: readName, cover: readAvatar,
  types: t.Array(t.String(), { maxItems: 3 }),
  source: t.Union([t.Literal('reading'), t.Literal('followed')]),
  lastPosition: t.Nullable(t.Object({ occurrence: readId, position: t.Nullable(t.String()),
    completed: t.Boolean(), updatedAt: t.String() })),
  nextUnread: t.Object({ occurrence: readId, title: t.Nullable(t.String()), href: t.String() }),
  unreadCount: t.Object({ value: t.Integer({ minimum: 1 }),
    kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }),
  updatedAt: t.String() });
export const continueResult = t.Object({ profile: t.Literal('home-continue-v1'),
  items: t.Array(continueItem, { maxItems: 6 }), sourcePosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }),
  scanned: t.Object({ reading: t.Integer(), followed: t.Integer(), limit: t.Integer() }) });
export const hiddenCommand = t.Object({ actingSubject: readId, hidden: t.Boolean() },
  { additionalProperties: false });
export const hiddenResult = t.Object({ profile: t.Literal('home-exclusion-v1'), actingSubject: readId,
  kind: t.Literal('continue'), target: readId,
  strength: t.Union([t.Literal('hide'), t.Literal('clear')]), revision: readUuid, replayed: t.Boolean() });
/** Two candidate seeks, one metadata and progress batch, and at most three
 * position reads per Book. Exact counts retain the former small-Book ceiling. */
export const CONTINUE_COST = { candidatesPerSource: 8, maxCandidates: 16, exactCountPlacements: 20,
  responseBytes: 64 * 1024 } as const;
