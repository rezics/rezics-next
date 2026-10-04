import { languageTagSchema } from '../display-language/schema.ts';
import { t } from 'elysia';
import { sourcePosition } from '../../api-contract.ts';
import { readId } from '../work/read-contract.ts';
import { MAX_ROLLUP_MEMBERS, RANK_FORMULA, RANK_MINIMUM_RATINGS } from './rollup.ts';
import { meanDisplay, targetGrain } from './target-api.ts';
import { TARGET_RATING_WRITE_COST, MAX_DISPLAY_THRESHOLD } from './target.ts';

export const ROLLUP_PROFILE = 'rating-rollup-v1';
const count = t.Integer({ minimum: 0 });

export const rollupInput = t.Object({ profile: t.Literal(ROLLUP_PROFILE), context: readId,
  targets: t.Array(readId, { minItems: 1, maxItems: MAX_ROLLUP_MEMBERS, uniqueItems: true }),
  formula: t.Union([t.Literal('pooled'), t.Literal('mean-of-means')]), rank: t.Optional(t.Boolean()),
  actingSubject: t.Optional(readId) }, { additionalProperties: false });

const memberComponents = t.Object({ population: count, count, withdrawnCount: count, sum: count,
  histogram: t.Array(count, { minItems: 10, maxItems: 10 }) });
const rollupMember = t.Union([
  t.Object({ target: readId, status: t.Literal('available'), components: memberComponents,
    mean: t.Nullable(t.Number()), meanDisplay, meetsThreshold: t.Boolean() }),
  /** `unavailable` also covers a target the caller cannot read or that does not exist; neither is told apart. */
  t.Object({ target: readId, status: t.Literal('unavailable'),
    reason: t.Union([t.Literal('unavailable'), t.Literal('grain-mismatch'), t.Literal('needs-reconstruction'),
      t.Literal('unverified')]) }),
]);
const rankItem = t.Object({ position: t.Integer({ minimum: 1 }), target: readId, count, mean: t.Number(), score: t.Number() });

export const rollupResult = t.Object({ profile: t.Literal(ROLLUP_PROFILE), context: readId, realm: readId,
  scope: t.Object({ question: t.String({ minLength: 3, maxLength: 120 }),
    language: languageTagSchema(TARGET_RATING_WRITE_COST.questionLanguageBytes), grain: targetGrain,
    population: t.Literal('account-principal') }),
  scale: t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) }),
  formula: t.Union([t.Literal('pooled'), t.Literal('mean-of-means')]),
  displayThreshold: t.Integer({ minimum: 1, maximum: MAX_DISPLAY_THRESHOLD }),
  memberCount: t.Integer({ minimum: 1, maximum: MAX_ROLLUP_MEMBERS }),
  coverage: t.Object({ members: t.Integer({ minimum: 1 }), available: count, meetingThreshold: count }),
  value: t.Nullable(t.Number()), valueWithheld: t.Nullable(t.Literal('coverage-below-half')),
  members: t.Array(rollupMember, { maxItems: MAX_ROLLUP_MEMBERS }),
  rank: t.Nullable(t.Object({ formula: t.Literal(RANK_FORMULA), minimumRatings: t.Literal(RANK_MINIMUM_RATINGS),
    status: t.Union([t.Literal('ranked'), t.Literal('unavailable')]),
    prior: t.Nullable(t.Object({ mean: t.Number(), weight: t.Integer({ minimum: 1 }), ratings: count, targets: count })),
    items: t.Array(rankItem, { maxItems: MAX_ROLLUP_MEMBERS }) })),
  sourcePosition });
