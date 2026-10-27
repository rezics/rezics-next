import type { PoolClient } from 'pg';
import readReceipt from '../command/read-receipt.sql';
import { partitionOf, routeOf } from '../route/route.ts';
import { preparationHeaderCommitment, type PreparationHeaderCommitment } from './preparation-bindings.ts';
import readHeader from './preparation-native-read.sql';
/** Initial provenance only; caller owns RR/command anchoring, admission, source and final publication checks. */
export async function readPreparationNativeHeader(
  client: Pick<PoolClient, 'query'>,
  { route, accountId, preparationId }: Readonly<{ route: number; accountId: string; preparationId: string }>,
) {
  const partition = partitionOf(route);
  if (routeOf(accountId) !== route || routeOf(preparationId) !== route)
    throw new TypeError('Preparation and account must carry the requested route');
  const row = await readHeader.run(client, { route, account_id: accountId, preparation_id: preparationId });
  if (!row || row.route !== route || row.accountId !== accountId || row.preparationId !== preparationId) return null;
  const header: PreparationHeaderCommitment = {
    version: 1,
    route: row.route,
    accountId: row.accountId,
    preparationId: row.preparationId,
    binding: row.binding as PreparationHeaderCommitment['binding'],
    origin: row.origin as PreparationHeaderCommitment['origin'],
    sourceIdentity: row.sourceIdentity as PreparationHeaderCommitment['sourceIdentity'],
    originIdentity: row.originIdentity as PreparationHeaderCommitment['originIdentity'],
    principalNamespace: row.principalNamespace as PreparationHeaderCommitment['principalNamespace'],
    reservationId: row.reservationId,
    inputByteLength: row.inputByteLength,
    inputDigest: row.inputDigest,
    creationTransactionId: row.creationTransactionId,
    creationReceipt: row.creationReceipt as PreparationHeaderCommitment['creationReceipt'],
    createdAt: row.createdAt!,
  };
  let commitment: string;
  try {
    commitment = preparationHeaderCommitment(header);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (commitment !== row.creationCommitment) return null;
  const receipt = await readReceipt.run(client, {
    partition_no: partition,
    principal_kind: 'account',
    principal_id: accountId,
    command_kind: 'library.type-preparation.create',
    idempotency_key: header.creationReceipt.key,
  });
  const response = receipt?.response as { metadataCommitment?: unknown; preparationId?: unknown } | null;
  if (
    !receipt ||
    Buffer.from(receipt.requestDigest).toString('hex') !== header.creationReceipt.digest ||
    receipt.transactionId !== header.creationTransactionId ||
    response?.metadataCommitment !== commitment ||
    response?.preparationId !== preparationId
  )
    return null;
  return Object.freeze({ ...header, creationCommitment: commitment });
}
export type NativePreparationHeader = NonNullable<Awaited<ReturnType<typeof readPreparationNativeHeader>>>;
