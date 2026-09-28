import { t } from 'elysia';
import type { Static } from 'typebox';

const url = t.String({ pattern: '^https://[^\\s]{1,500}$', maxLength: 512 });
const term = t.String({ minLength: 1, maxLength: 64 });
const image = t.Object({ url, width: t.Integer({ minimum: 1, maximum: 8192 }),
  height: t.Integer({ minimum: 1, maximum: 8192 }), source: url }, { additionalProperties: false });

/** Source and observation time qualify every changing release or review claim. */
export const gameFacts = t.Object({ profile: t.Literal('game-facts-v1'),
  pitch: t.String({ minLength: 1, maxLength: 500 }),
  source: url, observedAt: t.String({ format: 'date-time' }),
  status: t.Union([t.Literal('released'), t.Literal('upcoming')]),
  releaseDate: t.Nullable(t.String({ format: 'date' })),
  platforms: t.Array(term, { maxItems: 8 }), languages: t.Array(term, { maxItems: 16 }),
  tags: t.Array(term, { maxItems: 8 }), screenshots: t.Array(image, { maxItems: 6 }),
  modsZone: t.Boolean(),
  review: t.Nullable(t.Object({ label: term, count: t.Integer({ minimum: 0 }),
    period: term, source: url, observedAt: t.String({ format: 'date-time' }) },
  { additionalProperties: false })),
}, { additionalProperties: false });

export type GameFacts = Static<typeof gameFacts>;
export const GAME_FACTS_COST = { workRows: 1, platformItems: 8, languageItems: 16,
  tagItems: 8, screenshotItems: 6, graphQueries: 1 } as const;
