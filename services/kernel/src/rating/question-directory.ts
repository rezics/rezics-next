import type { PoolClient } from 'pg';
import directory from './question-directory.sql';

/** One primary-key seek, including one unconsumed lookahead row. Authority is checked by the mounted route. */
export async function readRatingQuestionDirectory(
  client: Pick<PoolClient, 'query'>,
  input: { after: string | null; limit: number },
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
    throw new RangeError('Invalid rating question page limit');
  const rows = await directory.run(client, {
    after_id: input.after ?? '00000000-0000-0000-0000-000000000000',
    limit: input.limit,
  });
  const consumed = rows.slice(0, input.limit);
  return {
    ratingQuestions: consumed.map((row) => ({
      id: row.id,
      revision: row.revision,
      label: row.label,
      grain: row.grain,
      scale: { min: row.minimumUnits, max: row.maximumUnits, displayStep: row.stepUnits },
    })),
    after: consumed.at(-1)?.id ?? null,
    hasMore: rows.length > input.limit,
  };
}
