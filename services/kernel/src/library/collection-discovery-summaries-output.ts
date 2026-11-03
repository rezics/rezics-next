import type { AccessClient } from '../request/access.ts';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import outputHead from './collection-source-output-head.sql';

/** Reuse the native activation formula verbatim, once per supplied key inside one bounded statement.
 * The selected head, complete generation, publication receipt, native XID, incarnation, source/member
 * fences and current Core commit must all agree. Neither a generation ID nor a COMPLETE flag is proof.
 */
const selectedOutputSQL = `
SELECT requested.id::text AS id, selected.*
FROM unnest($1::integer[], $2::uuid[], $3::bigint[]) AS requested(route, id, source_generation)
CROSS JOIN LATERAL (
${outputHead.sql.trim().replace(/;$/, '').replace(/\$([123])\b/g, (_, n: string) =>
  ({ '1': 'requested.route', '2': 'requested.id', '3': 'requested.source_generation' })[n]!)}
) selected`;

export async function readDiscoveryOutputs(
  client: AccessClient,
  keys: readonly { route: number; id: string; sourceGeneration: string }[],
): Promise<ReadonlyMap<string, CollectionOutputPublication>> {
  if (!keys.length) return new Map();
  const result = await client.query<CollectionOutputPublication & { id: string }>(selectedOutputSQL, [
    keys.map((key) => key.route), keys.map((key) => key.id), keys.map((key) => key.sourceGeneration),
  ]);
  if (result.rows.length > keys.length || new Set(result.rows.map((row) => row.id)).size !== result.rows.length)
    throw new Error('Native Collection output authority returned duplicate keys');
  return new Map(result.rows.map(({ id, ...publication }) => [id, publication]));
}
