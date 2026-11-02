import type { Pool, QueryResultRow } from 'pg';
import {
  runCommand,
  currentCommand,
  currentCommandResources,
  type CommandTransaction,
  type CommandResult,
  type CommandBasis,
  type CommandReceipt,
  type CommandAuthorization,
} from '../command/command.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import {
  CATALOGUE_PUBLISHER_OPERATIONS,
  CATALOGUE_PUBLISHER_CONTROLS,
  CATALOGUE_BODY_COST,
  CATALOGUE_NATIVE_CONTROLS,
  CATALOGUE_LEDGER_OPERATIONS,
  CATALOGUE_WORK_AXES,
  catalogueOperationCost,
  catalogueBodyWork,
  type CataloguePublisherOperation,
} from './definition-catalogue-work-cost.ts';

export type CataloguePublisherPhase = 'artifact' | 'build' | 'step' | 'activate' | 'activation-step';
const kinds = {
  artifact: 'definition_catalogues.publish_artifact',
  build: 'definition_catalogues.build',
  step: 'definition_catalogues.step',
  activate: 'definition_catalogues.activate',
} as const;

/** Static request bounds, independent of catalogue size. A step visits one node
 * (256 entries), one member page (64), or one label page (64). Include all branch
 * alternatives, even rollback, by addition. No balance or funding survives a command.
 */
const repetitions: Partial<Record<CataloguePublisherOperation, number>> = {
  branchTask: 256,
  leafTask: 256,
  identityUpsert: 65,
  memberInsert: 64,
  labelInsert: 64,
  artifactRead: 2,
  buildStatus: 2,
  buildLock: 2,
  typeClosure: 2,
  profileClosure: 2,
};
function commandBound(): WorkDimensions {
  const total = Object.fromEntries(CATALOGUE_WORK_AXES.map((axis) => [axis, 0])) as {
    -readonly [Axis in keyof WorkDimensions]: number;
  };
  const add = (cost: WorkDimensions, count: number) => {
    for (const axis of CATALOGUE_WORK_AXES) total[axis] += cost[axis] * count;
  };
  for (const [id, op] of Object.entries(CATALOGUE_PUBLISHER_OPERATIONS))
    add(
      {
        ...op.bound,
        bytes: op.bound.bytes + Buffer.byteLength(op.sql) + op.parameterMaxima.reduce((n, v) => n + v + 6, 0),
      },
      repetitions[id as CataloguePublisherOperation] ?? 1,
    );
  for (const [id, cost] of Object.entries(CATALOGUE_PUBLISHER_CONTROLS)) add(cost, id === 'memberIdentity' ? 65 : 1);
  // Request, close, cut/stage and finish: at most four transitions, each with
  // at most four head/root/status points. Include one bounded retirement component.
  for (const [id, cost] of Object.entries(CATALOGUE_BODY_COST))
    add({ ...cost, bytes: cost.bytes + 262144 }, id === 'withdrawalAck' ? 100 : 16);
  for (const cost of Object.values(CATALOGUE_NATIVE_CONTROLS)) add(cost, 4);
  for (const op of Object.values(CATALOGUE_LEDGER_OPERATIONS))
    add(
      {
        ...op.bound,
        bytes: op.bound.bytes + Buffer.byteLength(op.sql) + op.parameterMaxima.reduce((n, v) => n + v + 6, 0),
      },
      2,
    );
  for (const axis of CATALOGUE_WORK_AXES)
    if (!Number.isSafeInteger(total[axis])) throw new TypeError('Catalogue bound overflow');
  return Object.freeze(total);
}
export const CATALOGUE_COMMAND_BOUND = commandBound();
type Binding = Readonly<{
  phase: CataloguePublisherPhase;
  root: string;
  work: NativeCollectionWork;
  command: ReturnType<typeof currentCommand>;
}>;
const bindings = new WeakMap<CommandTransaction, Binding>();
function boundCommand(tx: CommandTransaction): Binding {
  const bound = bindings.get(tx);
  if (!bound || bound.command !== currentCommand(tx) || Date.now() >= currentCommandResources(tx).deadline)
    throw new AccessUnavailableError('overloaded');
  bound.work.assertReady();
  return bound;
}
export function assertCataloguePublisherFrame(
  tx: CommandTransaction,
  work: NativeCollectionWork,
  root: string,
  operation: 'register' | 'lock' | 'request' | 'advance' | 'finish' | 'frontier' | 'retire',
) {
  const bound = boundCommand(tx);
  if (
    bound.root !== root ||
    bound.work !== work ||
    (operation === 'register' && bound.phase !== 'build') ||
    (['request', 'finish'].includes(operation) && bound.phase !== 'activate') ||
    (!['register', 'request', 'finish'].includes(operation) && !['activate', 'activation-step'].includes(bound.phase))
  )
    throw new AccessUnavailableError('overloaded');
}
export async function cataloguePublisherQuery<R extends QueryResultRow = QueryResultRow>(
  tx: CommandTransaction,
  operation: CataloguePublisherOperation,
  params: unknown[] = [],
) {
  const definition = CATALOGUE_PUBLISHER_OPERATIONS[operation];
  if (!definition) throw new TypeError('Unknown catalogue publisher operation');
  if (!bindings.has(tx) && operation === 'buildStatus') return tx.query<R>(definition.sql, params);
  const bound = boundCommand(tx);
  return catalogueBodyWork(
    bound.work,
    catalogueOperationCost(operation, params),
    () => tx.query<R>(definition.sql, params),
    currentCommandResources(tx).deadline,
  );
}
export async function cataloguePublisherControl<T>(
  tx: CommandTransaction,
  operation: keyof typeof CATALOGUE_PUBLISHER_CONTROLS,
  body: () => Promise<T>,
): Promise<T> {
  const bound = boundCommand(tx);
  return catalogueBodyWork(
    bound.work,
    CATALOGUE_PUBLISHER_CONTROLS[operation],
    body,
    currentCommandResources(tx).deadline,
  );
}

/** Core owns authorization, transaction fencing, sealed command replay and uncertain
 * commit handling. This frame only checks phase identity and meters bounded local work.
 */
export function cataloguePublisherInvocation(pool: Pool, phase: CataloguePublisherPhase, deadline?: number) {
  return {
    async run<T>(
      root: string,
      options: {
        partition: number;
        deadline?: number;
        clock?: (() => Date) | undefined;
        basis?: CommandBasis;
        receipt?: CommandReceipt;
        authorization?: CommandAuthorization | undefined;
      },
      body: (
        tx: CommandTransaction,
        context: { transactionId: string; time: ReturnType<typeof currentCommand>['time'] },
        work: NativeCollectionWork,
      ) => Promise<CommandResult<T>>,
    ) {
      if (!/^sha256:[a-f0-9]{64}$/.test(root) || options.partition !== 0)
        throw new TypeError('Invalid catalogue command');
      const mechanical = phase === 'activation-step' || (phase === 'step' && !options.receipt);
      if (
        mechanical
          ? options.authorization || options.basis || options.receipt
          : !options.receipt ||
            options.receipt.kind !== kinds[phase as keyof typeof kinds] ||
            options.authorization?.action !== (phase === 'activate' ? 'definitions:activate' : 'definitions:publish') ||
            options.authorization.resource.route !== 0 ||
            options.authorization.resource.id !== GLOBAL_CONTEXT
      )
        throw new AccessUnavailableError('overloaded');
      return runCommand(pool, { ...options, ...(deadline === undefined ? {} : { deadline }) }, async (tx, context) => {
        const command = currentCommand(tx);
        if (!mechanical && command.authorization?.mode !== 'execute') throw new AccessUnavailableError('overloaded');
        const work = new NativeCollectionWork(
          { reservationId: context.transactionId, remaining: CATALOGUE_COMMAND_BOUND },
          currentCommandResources(tx).deadline,
        );
        bindings.set(tx, { phase, root, command, work });
        try {
          return await body(tx, context, work);
        } finally {
          bindings.delete(tx);
        }
      });
    },
  };
}
