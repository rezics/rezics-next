import { t } from 'elysia';
import type { Static } from 'typebox';
import { Compile } from 'typebox/compile';

/** Native encoding limits, independent of provider revisions and record populations. */
export const SOURCE_FIGURE_MAX_BINS = 10;
export const SOURCE_FIGURE_MAX_BYTES = 4096;
export const SOURCE_OBSERVATION_MAX_BYTES = 32768;
export const SOURCE_STATISTICS_MAX_BODY_BYTES = 65536;
const closed = { additionalProperties: false } as const;
const safePositive = t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/** Only the permitted Bangumi converter may supply these original provider units.
 * Missing fields are unavailable. A partial distribution never asserts coverage.
 */
export const SourceFiguresSchema = t.Object(
  {
    schemaVersion: t.Literal(1),
    distribution: t.Optional(t.Object({
      unit: t.Literal('ratings'),
      completeness: t.Union([t.Literal('complete'), t.Literal('partial')]),
      bins: t.Array(t.Object({
        score: t.Integer({ minimum: 1, maximum: 10 }),
        count: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      }, closed), { minItems: 1, maxItems: SOURCE_FIGURE_MAX_BINS }),
    }, closed)),
    rank: t.Optional(t.Object({
      unit: t.Literal('subjects'),
      position: safePositive,
      population: t.Optional(safePositive),
    }, closed)),
  },
  closed,
);
export type SourceFigures = Static<typeof SourceFiguresSchema>;
const validator = Compile(SourceFiguresSchema);

/** Shape validation runs before serialization, so arrays/keys and byte work are bounded.
 * Canonical ascending keys avoid two encodings of the same histogram. Neither a
 * missing bin nor a missing rank denominator is synthesized by the reader.
 */
export function validSourceFigures(source: string, figures: unknown, count: number): figures is SourceFigures {
  if (source !== 'bangumi' || !validator.Check(figures)) return false;
  if (!figures.distribution && !figures.rank) return false;
  if (Buffer.byteLength(JSON.stringify(figures), 'utf8') > SOURCE_FIGURE_MAX_BYTES) return false;
  const distribution = figures.distribution;
  if (distribution) {
    let total = 0;
    let previous = 0;
    for (const bin of distribution.bins) {
      if (bin.score <= previous) return false;
      previous = bin.score;
      total += bin.count;
      if (!Number.isSafeInteger(total) || total > count) return false;
    }
    if (distribution.completeness === 'complete' &&
        (distribution.bins.length !== SOURCE_FIGURE_MAX_BINS || total !== count)) return false;
  }
  if (figures.rank?.population !== undefined && figures.rank.position > figures.rank.population) return false;
  return true;
}
