import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { librarySemanticObservations } from './semantic-observation.ts';
import type { LibrarySemanticObservationCapability } from './contract/semantic-observation.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';

export type PreparationSourceRead<T> = Readonly<{ value: T; semanticWork: WorkDimensions }>;

export interface PreparationSourceExecution {
  transaction<T>(read: () => Promise<T>): Promise<T>;
  read<T>(
    client: PoolClient,
    subjectId: string,
    full: boolean,
    observations: LibrarySemanticObservationCapability,
    read: (maxTypeBytes: number) => Promise<PreparationSourceRead<T>>,
  ): Promise<PreparationSourceRead<T>>;
}
type PreparationSourceContext = {
  pool: Pool;
  deadline?: number | undefined;
  execution?: PreparationSourceExecution;
  semanticObservations?: LibrarySemanticObservationCapability;
};

function addWork(...values: readonly WorkDimensions[]): WorkDimensions {
  const dimensions = {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  };
  for (const value of values)
    for (const axis of Object.keys(dimensions) as (keyof WorkDimensions)[]) dimensions[axis] += value[axis];
  return Object.freeze(dimensions);
}

async function observe(context: PreparationSourceContext, subjectId: string, full: boolean) {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Invalid preparation source');
  const partition = partitionOf(route);
  const { pool, deadline, execution } = context;
  const observations = context.semanticObservations ?? librarySemanticObservations();
  const transaction = () =>
    withReadTransaction(
      pool,
      async (client) => {
        const read = async (
          maxTypeBytes: number,
        ): Promise<
          PreparationSourceRead<{
            stamp: { partition: number; epoch: number; position: bigint };
            identity: {
              sourceId: string;
              partition: number;
              epoch: number;
              revision: number;
              transactionId: string;
              redirect: string | null;
            } | null;
            type: string | null;
          }>
        > => {
          const owner = await readPartition(client, partition);
          if (!owner) throw new CommandUnavailableError('deadline', partition);
          if (owner.writeState === 'moved') throw new CommandUnavailableError('moved', partition, owner.movedTo);
          const version = await observations.shelf.readIdentityVersion(client, subjectId);
          const stamp = { partition, epoch: owner.epoch, position: owner.position };
          const identity = version.value
            ? { sourceId: subjectId, partition, epoch: owner.epoch, ...version.value }
            : null;
          const itemTypes = full
            ? await observations.shelf.readItemTypes(client, [subjectId], maxTypeBytes)
            : undefined;
          const type = itemTypes?.value.get(subjectId) ?? null;
          return {
            value: { stamp, identity, type },
            semanticWork: addWork(version.work, ...(itemTypes ? [itemTypes.work] : [])),
          };
        };
        const observed = execution ? await execution.read(client, subjectId, full, observations, read) : await read(0);
        return observed.value;
      },
      deadline,
    );
  return execution ? execution.transaction(transaction) : transaction();
}
export function observePreparationSource(context: PreparationSourceContext, subjectId: string) {
  return observe(context, subjectId, true);
}
export async function observePreparationIdentity(context: PreparationSourceContext, subjectId: string) {
  const { stamp, identity } = await observe(context, subjectId, false);
  return { stamp, identity };
}
