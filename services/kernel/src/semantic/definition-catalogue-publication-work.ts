import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  runCommand,
  withSingleCommandAttempt,
  currentCommand,
  currentCommandResources,
  currentCommandReceipt,
  type CommandTransaction,
  type CommandResult,
  type CommandBasis,
  type CommandReceipt,
  type CommandAuthorization,
} from '../command/command.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../command/dispatch-lifetime.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import {
  CATALOGUE_PUBLISHER_OPERATIONS,
  CATALOGUE_PUBLISHER_CONTROLS,
  catalogueOperationCost,
  catalogueBodyWork,
  CATALOGUE_LEDGER_OPERATIONS,
  catalogueLedgerCost,
  CATALOGUE_WORK_AXES,
  type CataloguePublisherOperation,
  type CatalogueLedgerOperation,
} from './definition-catalogue-work-cost.ts';
import originalAdmit from './definition-catalogue-original-admit.sql';
import originalRead from './definition-catalogue-original-read.sql';
import ticketAdmit from './definition-catalogue-ticket-admit.sql';
import ticketSpend from './definition-catalogue-ticket-spend.sql';
import originalTerminal from './definition-catalogue-original-terminal.sql';
import admissionHead from './definition-catalogue-head-lock.sql';
import admissionRoot from './definition-catalogue-root-lock.sql';
import capturePosition from './definition-catalogue-position.sql';
import reclaimTickets from './definition-catalogue-retirement-tickets.sql';

export type CataloguePublisherPhase = 'artifact' | 'build' | 'step' | 'activate' | 'activation-step';
export type CataloguePublisherMissingTerm = Readonly<{
  owner: 'Core' | 'Access' | 'Semantic' | 'Source';
  operation: string;
}>;
/** These are missing composition operands, not configurable allowances. The actual
 * Core export below explicitly selects single-no-effect and rejects receipt,
 * authorization, clock, events, history and callbacks. No matching is inferred.
 */
export const CATALOGUE_PUBLISHER_MISSING_COMPOSITION: readonly CataloguePublisherMissingTerm[] = Object.freeze([
  Object.freeze({
    owner: 'Core',
    operation:
      'inclusive catalogue command lifetime: bootstrap/admission, authorization, receipt, events/outbox, callbacks, controls, COMMIT and mandatory ROLLBACK',
  }),
  Object.freeze({
    owner: 'Access',
    operation:
      'complete definitions command admission, including original Accounts account projection and both fresh authorization passes',
  }),
  Object.freeze({
    owner: 'Semantic',
    operation: 'ordinary readRelease(composed:false) complete cache-hit and stored-body child declaration',
  }),
  Object.freeze({
    owner: 'Source',
    operation: 'finite exact-consumer withdrawal/current-owner child composition for nonempty retained cuts',
  }),
  Object.freeze({
    owner: 'Core',
    operation: 'committed irreversible dispatch-ticket receipt resolution and original binding before child checkout',
  }),
  Object.freeze({
    owner: 'Core',
    operation:
      'original funding and committed job association for finite retained build/activation schedules at actual native positions',
  }),
]);
export const CATALOGUE_PUBLISHER_COMPOSITION = Object.freeze({
  supportedCoreProfile: COMMAND_DISPATCH_ALLOWANCE.profile,
  ownedBody: CATALOGUE_PUBLISHER_OPERATIONS,
  ownedAdmission: CATALOGUE_LEDGER_OPERATIONS,
  ownedControl: CATALOGUE_PUBLISHER_CONTROLS,
  missing: CATALOGUE_PUBLISHER_MISSING_COMPOSITION,
  installed: false as const,
});
export class CataloguePublisherAdmissionUnavailable extends AccessUnavailableError {
  readonly missing = CATALOGUE_PUBLISHER_MISSING_COMPOSITION;
  constructor() {
    super('overloaded');
    this.name = 'CataloguePublisherAdmissionUnavailable';
  }
}
const unavailable = (): never => {
  throw new CataloguePublisherAdmissionUnavailable();
};

type Binding = Readonly<{
  pool: Pool;
  deadline: number;
  phase: CataloguePublisherPhase;
  root: string;
  work: NativeCollectionWork;
  command: ReturnType<typeof currentCommand>;
  inputDigest: Buffer;
  originalKey: string;
  tickets: CataloguePublisherTickets;
}>;
const bindings = new WeakMap<CommandTransaction, Binding>();
const kinds = Object.freeze({
  artifact: 'definition_catalogues.publish_artifact',
  build: 'definition_catalogues.build',
  step: 'definition_catalogues.step',
  activate: 'definition_catalogues.activate',
});
function boundOriginal(tx: CommandTransaction): Binding {
  const binding = bindings.get(tx);
  const resources = currentCommandResources(tx);
  if (
    !binding ||
    binding.command !== currentCommand(tx) ||
    binding.pool !== resources.pool ||
    binding.deadline !== resources.deadline ||
    Date.now() >= binding.deadline ||
    binding.command.partition !== 0
  )
    return unavailable();
  binding.work.assertReady();
  return binding;
}
export function assertCataloguePublisherFrame(
  tx: CommandTransaction,
  work: NativeCollectionWork,
  root: string,
  operation: 'register' | 'lock' | 'request' | 'advance' | 'finish' | 'frontier' | 'retire',
) {
  const bound = boundOriginal(tx);
  if (
    bound.work !== work ||
    bound.root !== root ||
    (operation === 'register' && bound.phase !== 'build') ||
    ((operation === 'request' || operation === 'finish') && bound.phase !== 'activate') ||
    (!['register', 'request', 'finish'].includes(operation) && !['activate', 'activation-step'].includes(bound.phase))
  )
    return unavailable();
}

/** No interception, SQL recognition, broad body envelope, zero foreign price or
 * independently created ledger. Reads used by the ordinary metadata API retain
 * their ordinary accounting; every publisher call uses its closed operation ID.
 */
export async function cataloguePublisherQuery<R extends QueryResultRow = QueryResultRow>(
  tx: CommandTransaction,
  operation: CataloguePublisherOperation,
  params: unknown[] = [],
) {
  const definition = CATALOGUE_PUBLISHER_OPERATIONS[operation];
  if (!definition) throw new TypeError('Unknown catalogue publisher operation');
  const bound = bindings.get(tx);
  if (!bound && operation === 'buildStatus') return tx.query<R>(definition.sql, params);
  const original = boundOriginal(tx);
  const cost = catalogueOperationCost(operation, params);
  return catalogueBodyWork(original.work, cost, () => tx.query<R>(definition.sql, params), original.deadline);
}
export async function cataloguePublisherControl<T>(
  tx: CommandTransaction,
  operation: keyof typeof CATALOGUE_PUBLISHER_CONTROLS,
  body: () => Promise<T>,
): Promise<T> {
  const original = boundOriginal(tx),
    cost = CATALOGUE_PUBLISHER_CONTROLS[operation];
  if (!cost) throw new TypeError('Unknown catalogue control operation');
  return catalogueBodyWork(original.work, cost, body, original.deadline);
}
async function ledger<T>(
  tx: CommandTransaction,
  operation: CatalogueLedgerOperation,
  params: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> {
  const original = boundOriginal(tx);
  return catalogueBodyWork(original.work, catalogueLedgerCost(operation, params), run, original.deadline);
}
const components = Object.freeze([
  'bootstrap',
  'authorization',
  'framework',
  'body',
  'observations',
  'lifecycle',
  'cleanup',
] as const);
export type CataloguePublisherTickets = Readonly<Record<(typeof components)[number], WorkDimensions>>;
function vector(cost: WorkDimensions): readonly number[] {
  return CATALOGUE_WORK_AXES.map((axis) => {
    if (!Number.isSafeInteger(cost[axis]) || cost[axis] < 0) throw new TypeError('Invalid catalogue work component');
    return cost[axis];
  });
}
function addTickets(tickets: CataloguePublisherTickets): readonly number[] {
  const total = CATALOGUE_WORK_AXES.map(() => 0);
  for (const kind of components)
    vector(tickets[kind]).forEach((n, i) => {
      total[i]! += n;
      if (!Number.isSafeInteger(total[i])) throw new TypeError('Catalogue original exceeds finite work representation');
    });
  return total;
}
function originalKey(tx: CommandTransaction) {
  const receipt = currentCommandReceipt(tx);
  // This is Core's native codec output, read only inside its actual live writer.
  return createHash('sha256')
    .update(JSON.stringify([receipt.principal.kind, receipt.principal.id, receipt.kind, receipt.storageKey]))
    .digest('hex');
}
/** Admission SQL is implemented independently of receipt delivery. It requires the
 * private funded same-command binding, including an already funded bootstrap;
 * this function cannot bootstrap itself from a supplied ledger or a database read.
 * The original identity and all components are immutable after the first insert.
 */
export async function admitCataloguePublisherOriginal(tx: CommandTransaction) {
  const original = boundOriginal(tx),
    key = originalKey(tx),
    tickets = original.tickets,
    admitted = addTickets(tickets);
  if (key !== original.originalKey) return unavailable();
  await ledger(tx, 'headLock', {}, () => admissionHead.run(tx));
  await ledger(tx, 'rootLock', { root: original.root }, () => admissionRoot.run(tx, { root: original.root }));
  const params = {
    original_key: key,
    root: original.root,
    phase: original.phase,
    input_digest: original.inputDigest,
    episode: original.command.transactionId,
    deadline: String(original.deadline),
    admitted: `{${admitted.join(',')}}`,
    position: '0',
  };
  const inserted = await ledger(tx, 'originalAdmit', params, () => originalAdmit.run(tx, params));
  const point = { original_key: key };
  const stored = await ledger(tx, 'originalRead', point, () => originalRead.run(tx, point));
  if (
    !stored ||
    stored.root_digest !== original.root ||
    stored.phase !== original.phase ||
    stored.origin !== 'command' ||
    !Buffer.from(stored.input_digest).equals(original.inputDigest) ||
    stored.deadline_ms !== String(original.deadline) ||
    stored.position !== '0' ||
    JSON.stringify(stored.admitted.map(Number)) !== JSON.stringify(admitted)
  )
    return unavailable();
  if (!inserted) return { key, state: stored.state, deadline: Number(stored.deadline_ms) };
  for (const [index, kind] of components.entries()) {
    const params = { original_key: key, slot: index + 1, kind, allowance: `{${vector(tickets[kind]).join(',')}}` };
    await ledger(tx, 'ticketAdmit', params, () => ticketAdmit.run(tx, params));
  }
  return { key, state: 'admitted', deadline: original.deadline };
}
/** A locator is deliberately NOT an executable grant. The dispatching receiver
 * must resolve this transaction's actual committed receipt before child checkout.
 * Refusal, rollback, restart and lost response never transition spent -> admitted.
 */
export async function spendCataloguePublisherTickets(tx: CommandTransaction) {
  const original = boundOriginal(tx);
  if (originalKey(tx) !== original.originalKey) return unavailable();
  const params = { original_key: original.originalKey, transaction_id: original.command.transactionId };
  const spent = await ledger(tx, 'ticketSpend', params, () => ticketSpend.run(tx, params));
  if (!spent) return unavailable();
  return Object.freeze({ originalKey: spent.original_key, transactionId: spent.dispatch_transaction_id });
}
/** Capture only actual retained positions. A caller's increment is never accepted.
 * This creates no executable allowance for the position. Whole-job composition is
 * a missing operand, separate from this bounded registration statement.
 */
export async function captureCataloguePublisherPosition(tx: CommandTransaction) {
  const original = boundOriginal(tx);
  const params = {
    root: original.root,
    original_key: original.originalKey,
    transaction_id: original.command.transactionId,
  };
  return ledger(tx, 'position', params, () => capturePosition.run(tx, params));
}

/** Terminalization needs the committed result of the ORIGINAL dispatch, not the
 * current command's precommit receipt locator. Core's selected profile has no
 * compatible resolver/association for this publisher. No caller can supply a
 * result digest, complete bit or transaction UUID to bypass that boundary.
 */
function committedOriginalResult(_key: string): Readonly<{ transactionId: string; resultDigest: Buffer }> {
  return unavailable();
}
export async function settleCataloguePublisherOriginal(tx: CommandTransaction) {
  const original = boundOriginal(tx),
    key = original.originalKey,
    point = { original_key: key };
  const stored = await ledger(tx, 'originalRead', point, () => originalRead.run(tx, point));
  if (!stored || stored.root_digest !== original.root || !Buffer.from(stored.input_digest).equals(original.inputDigest))
    return unavailable();
  if (stored.state === 'terminal') return { key, state: 'terminal' as const };
  if (stored.state !== 'spent' || JSON.stringify(stored.admitted) !== JSON.stringify(stored.spent))
    return unavailable();
  const completion = committedOriginalResult(key);
  const params = {
    original_key: key,
    transaction_id: completion.transactionId,
    result_digest: completion.resultDigest,
  };
  if (!(await ledger(tx, 'originalTerminal', params, () => originalTerminal.run(tx, params)))) return unavailable();
  return { key, state: 'terminal' as const };
}

/** Point cleanup also covers terminal artifact-command originals, whose addressed
 * digest need not have a catalogue enrollment row. A separately funded authentic
 * repair association is required; terminal state itself carries no executable work.
 * Native result/owner records and the permanent spent identity are never deleted.
 */
export async function reclaimCataloguePublisherOriginal(tx: CommandTransaction) {
  const original = boundOriginal(tx),
    point = { original_key: original.originalKey };
  const stored = await ledger(tx, 'originalRead', point, () => originalRead.run(tx, point));
  if (!stored || stored.root_digest !== original.root || !Buffer.from(stored.input_digest).equals(original.inputDigest))
    return unavailable();
  if (stored.state !== 'terminal') return { removed: 0, retained: 'committed-native-settlement' as const };
  const params = { root: original.root, original_key: original.originalKey };
  const removed = await ledger(tx, 'retirementTickets', params, () => reclaimTickets.run(tx, params));
  return { removed: removed.length, retained: 'terminal-spent-identity' as const };
}

/** No compatible Core profile is installed. Keeping this receiver separate from
 * runCommand is essential: the body starts AFTER checkout, authorization and
 * receipt IO, and disappears BEFORE the fence/COMMIT/ROLLBACK. Neither point can
 * lend authority for that uncovered lifetime. The single-no-effect profile cannot
 * be promoted to the event-bearing catalogue profile by a cast or configuration.
 */
function receiveFundedPublisherOriginal(
  _pool: Pool,
  _phase: CataloguePublisherPhase,
): Readonly<{
  work: NativeCollectionWork;
  deadline: number;
  inputDigest: Buffer;
  originalKey: string;
  root: string;
  phase: CataloguePublisherPhase;
  tickets: CataloguePublisherTickets;
}> {
  return unavailable();
}
export function cataloguePublisherInvocation(pool: Pool, phase: CataloguePublisherPhase, suppliedDeadline?: number) {
  // Before parsing, bootstrap, any checkout or configured clock. Repeated factories
  // cannot create allocation, a new reservation ID, or a new deadline.
  const original = receiveFundedPublisherOriginal(pool, phase);
  if (suppliedDeadline !== undefined && suppliedDeadline !== original.deadline) return unavailable();
  let dispatched = false;
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
      if (dispatched) return unavailable();
      dispatched = true;
      if (
        root !== original.root ||
        phase !== original.phase ||
        !/^sha256:[a-f0-9]{64}$/.test(root) ||
        options.partition !== 0 ||
        (options.deadline !== undefined && options.deadline !== original.deadline)
      )
        return unavailable();
      const mechanical = phase === 'activation-step' || (phase === 'step' && !options.receipt);
      const action = phase === 'activate' ? 'definitions:activate' : 'definitions:publish';
      if (
        mechanical
          ? options.basis || options.receipt || options.authorization
          : !options.basis ||
            options.receipt?.kind !== kinds[phase as keyof typeof kinds] ||
            !Buffer.from(options.receipt.digest).equals(original.inputDigest) ||
            options.authorization?.action !== action ||
            options.authorization.resource.route !== 0 ||
            options.authorization.resource.id !== GLOBAL_CONTEXT
      )
        return unavailable();
      return withSingleCommandAttempt(() =>
        runCommand(pool, { ...options, deadline: original.deadline }, async (tx, context) => {
          const command = currentCommand(tx),
            resources = currentCommandResources(tx);
          if (
            resources.pool !== pool ||
            resources.deadline !== original.deadline ||
            command.transactionId !== context.transactionId ||
            command.time !== context.time ||
            command.partition !== 0 ||
            (mechanical
              ? command.authorization !== null
              : command.authorization?.mode !== 'execute' ||
                command.authorization.action !== action ||
                command.authorization.resource.id !== GLOBAL_CONTEXT ||
                command.authorization.resource.route !== 0)
          )
            return unavailable();
          bindings.set(tx, Object.freeze({ ...original, pool, phase, root, command }));
          try {
            return await body(tx, context, original.work);
          } finally {
            bindings.delete(tx);
          }
        }),
      );
    },
  };
}
