import type { PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { ClassificationAssociation, ImmutableClassificationObservation } from './source-classification-contract.ts';

export type ClassificationHead = ImmutableClassificationObservation & { association: ClassificationAssociation };
type Address = { route: number; subjectId: string; key: string };
type QueryClient = Pick<PoolClient, 'query'>;
export const SOURCE_CLASSIFICATION_HEAD_SQL = `
SELECT head.association_key AS key, observation.digest, observation.association, observation.payload
FROM unnest($3::text[]) AS requested(key)
CROSS JOIN LATERAL (
  SELECT digest, association_key FROM rating.source_classification_slot
  WHERE route=$1::integer AND subject_id=$2::uuid AND association_key=requested.key
  LIMIT 1
) AS head
CROSS JOIN LATERAL (
  SELECT digest, association, payload FROM rating.source_classification_observation
  WHERE route=$1::integer AND subject_id=$2::uuid
    AND association_key=head.association_key AND digest=head.digest
  LIMIT 1
) AS observation`;


export async function readClassificationHeads(client: QueryClient, route: number, subjectId: string, keys: string[]) {
  if (keys.length === 0) return new Map<string, ClassificationHead>();
  const { rows } = await client.query<ClassificationHead & { key: string }>(
    SOURCE_CLASSIFICATION_HEAD_SQL, [route, subjectId, keys],
  );
  return new Map(rows.map(({ key, ...row }) => [key, row]));
}
export async function lockClassificationHead(tx: CommandTransaction, address: Address) {
  const parameters = [address.route, address.subjectId, address.key];
  await tx.query(`INSERT INTO rating.source_classification_slot (route,subject_id,association_key)
    VALUES ($1,$2,$3) ON CONFLICT (route,subject_id,association_key) DO NOTHING`, parameters);
  await tx.query(`SELECT digest FROM rating.source_classification_slot
    WHERE route=$1 AND subject_id=$2 AND association_key=$3 FOR UPDATE`, parameters);
  return (await readClassificationHeads(tx, address.route, address.subjectId, [address.key])).get(address.key) ?? null;
}
export async function saveClassificationHead(
  tx: CommandTransaction, address: Address, association: ClassificationAssociation,
  observation: ImmutableClassificationObservation, transactionId: string,
) {
  await tx.query(`INSERT INTO rating.source_classification_observation
    (route,subject_id,association_key,digest,association,payload,as_of,transaction_id)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::timestamptz,$8::uuid)
    ON CONFLICT (route,subject_id,association_key,digest) DO NOTHING`,
  [address.route, address.subjectId, address.key, observation.digest, JSON.stringify(association),
    JSON.stringify(observation.payload), observation.payload.asOf, transactionId]);
  await tx.query(`UPDATE rating.source_classification_slot SET digest=$4
    WHERE route=$1 AND subject_id=$2 AND association_key=$3`,
  [address.route, address.subjectId, address.key, observation.digest]);
}
