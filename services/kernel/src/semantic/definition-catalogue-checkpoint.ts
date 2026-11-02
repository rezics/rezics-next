import { cataloguePublisherQuery } from './definition-catalogue-publication-work.ts';
import type { CommandTransaction } from '../command/command.ts';
import { currentCommand } from '../command/command.ts';
import { catalogueBytes, parseCatalogueJson, catalogueFail } from '@rezics/definitions';

/** The job lock is held by the caller before lookup and through result insertion.
 * The exact stored value wins after a lost reply, even if another command has
 * subsequently advanced the job. Unknown COMMIT outcomes remain Core errors.
 */
export async function catalogueCheckpoint<T>(
  tx: CommandTransaction,
  input: Readonly<{ root: string; phase: 'step' | 'activation-step'; jobId: string; position: string }>,
  body: () => Promise<T>,
): Promise<T> {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(input.position) || BigInt(input.position) > 9223372036854775807n)
    catalogueFail('invalid', 'Invalid retained catalogue position');
  const params = [input.root, input.phase, input.jobId, input.position];
  const saved = await cataloguePublisherQuery<{ result: Buffer }>(tx, 'checkpointRead', params);
  if (saved.rows[0]) return parseCatalogueJson(saved.rows[0].result, 65536) as T;
  const value = await body();
  const bytes = Buffer.from(catalogueBytes(value));
  if (bytes.length > 65536) catalogueFail('invalid', 'Catalogue checkpoint exceeds result bound');
  await cataloguePublisherQuery(tx, 'checkpointWrite', [...params, bytes, currentCommand(tx).transactionId]);
  return value;
}
