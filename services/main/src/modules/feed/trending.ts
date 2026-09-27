import { t } from 'elysia';
import type { Static } from 'typebox';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readAvatar, readId, readName, readPosition } from '../work/read-contract.ts';

export const trendingQuery = t.Object({ scope: t.Optional(t.String({ maxLength: 100 })),
  kind: t.Optional(t.Union([t.Literal('work'), t.Literal('contribution'), t.Literal('adoption')])),
  window: t.Optional(t.Union([t.Literal('day'), t.Literal('week')])),
  actingSubject: t.Optional(readId) }, { additionalProperties: false });
export const trendingResult = t.Object({ profile: t.Literal('home-trending-v1'),
  rankingVersion: t.String(), window: t.Union([t.Literal('day'), t.Literal('week')]),
  items: t.Array(t.Object({ work: readId, realm: readId, title: readName,
    cover: readAvatar, rank: t.Integer({ minimum: 1 }), reason: t.Literal('growth-in-realm') }),
  { maxItems: 5 }), sourcePosition: readPosition });
export type TrendingQuery = Static<typeof trendingQuery>;
export type TrendingResult = Static<typeof trendingResult>;
/** G-291's ranking projection plugs in here after it lands. The adapter must
 * re-admit public Work/Realm heads, honor viewer exclusions and cap two per Realm. */
export interface HomeTrendingReader {
  read(input: { query: TrendingQuery; principal: VerifiedPrincipal | null;
    agent: string | null }): Promise<TrendingResult>;
}
export const TRENDING_COST = { items: 5, realmCap: 2, candidatePool: 40,
  responseBytes: 64 * 1024 } as const;
