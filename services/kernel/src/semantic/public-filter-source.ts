import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import type {
  PrivacyReduction,
  PrivacyReductionLogEntry,
  PrivacyReductionLogRequest,
  PrivacyReductionObservationRequest,
  PublicFilterProjectionMeaning,
  PublicFilterProjectionRequest,
  PublicFilterSource,
  PublicFilterSourceFactory,
  RecordPrivacyReduction as RecordPrivacyReductionType,
} from './public-filter-source-contract.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../access/unavailable.ts';
import type { JoinedPopulationRequest, PublicFilterNativeSource } from './public-filter-source-binding.ts';
import type {
  PublicFilterConsumerContext,
  PublicCanonicalCaptureInput,
} from '../search/public-filter-consumer-contract.ts';
import { readPublicFilterPopulation } from './public-filter-coverage-population.ts';
import { createPublicFilterSourceBinding } from './public-filter-source-binding.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { Pool } from 'pg';
import type {
  PrivacyReductionHead,
  PrivacyReductionLogPage,
  PrivacyReductionObservation,
} from './public-filter-source-contract.ts';
import readPrivacyHead from './public-filter-source-head.sql';
import readPrivacyEntries from './public-filter-source-log-page.sql';
import ensurePrivacyHead from './public-filter-source-head-ensure.sql';
import lockPrivacyHead from './public-filter-source-head-lock.sql';
import advancePrivacyHead from './public-filter-source-head-advance.sql';
import appendPrivacyEntry from './public-filter-source-log-append.sql';
import { enqueuePublicFilterCoverage } from './public-filter-coverage-pending.ts';
import { readPublicFilterProjectionPage as readProjectionPage } from './public-filter-projection.ts';
import { isDeepStrictEqual } from 'node:util';
import realmOfBoard from '../content/realm-of-board.sql';

type SourceConfiguration = Parameters<PublicFilterSourceFactory>[0];
const origins = new WeakMap<PublicFilterSource, SourceConfiguration>();

/** Internal constructor routing only. The binding independently validates persisted owner rows. */
export function publicFilterSourceOrigin(source: PublicFilterSource): SourceConfiguration | undefined {
  return origins.get(source);
}

const cost = (inputKeys = 0) => ({
  inputKeys,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});

function rows<T>(value: T | T[] | null): T[] {
  return value === null ? [] : Array.isArray(value) ? value : [value];
}

function unready(reason: 'owner_pending' | 'identity_pending' | 'dependency_pending' | 'metadata_missing') {
  return { status: 'unready' as const, reason, cost: cost() };
}

function unavailable(reason: 'missing_owner' | 'moved' | 'deadline' | 'dependency_unavailable') {
  return { status: 'unavailable' as const, reason, cost: cost() };
}

function privacyHead(partition: number, epoch: number, position: string): PrivacyReductionHead {
  return { partition, epoch, position: BigInt(position) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function belongsToPartition(route: unknown, partition: number): route is number {
  return (
    typeof route === 'number' && Number.isInteger(route) && route >= 0 && route < 65_536 && route >>> 4 === partition
  );
}

function validDependency(value: unknown, partition: number): value is PrivacyReduction['affected'][number] {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  const routed = (route: unknown, id: unknown) =>
    belongsToPartition(route, partition) && typeof id === 'string' && routeOf(id) === route;
  if (value.kind === 'subject') return routed(value.route, value.subject);
  if (value.kind === 'selection')
    return (
      routed(value.route, value.subject) &&
      routed(value.route, value.candidate) &&
      typeof value.slot === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.slot)
    );
  if (value.kind === 'sourceTuple') {
    const tuple = value.tuple;
    return (
      isRecord(tuple) &&
      belongsToPartition(tuple.route, partition) &&
      typeof tuple.source === 'string' &&
      /^[a-z][a-z0-9_-]{0,31}$/.test(tuple.source) &&
      typeof tuple.external_id === 'string' &&
      tuple.external_id.length > 0 &&
      tuple.external_id.length <= 1024 &&
      tuple.external_id.isWellFormed() &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(tuple.external_id) &&
      Buffer.byteLength(tuple.external_id, 'utf8') <= 1024 &&
      ['facts', 'summary', 'cover'].includes(String(tuple.field_group))
    );
  }
  if (value.kind === 'consent')
    return (
      routed(value.route, value.subject) &&
      routed(value.route, value.candidate) &&
      typeof value.account === 'string' &&
      value.account.length > 0
    );
  if (value.kind === 'collection') return routed(value.route, value.collection);
  if (value.kind === 'realm') return routed(value.route, value.realm);
  if (value.kind === 'board') return routed(value.route, value.board);
  return false;
}

function validDependencyKey(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'type') return true;
  if (value.kind === 'realm') return typeof value.realm === 'string' && routeOf(value.realm) !== null;
  if (value.kind === 'property') return typeof value.property === 'string' && value.property.length > 0;
  if (value.kind === 'order') return ['relevance', 'name', 'id', 'collections', 'rating'].includes(String(value.order));
  if (value.kind === 'field')
    return ['labels', 'aliases', 'descriptions', 'name_sort', 'id'].includes(String(value.field));
  if (value.kind === 'function') return ['public_collection_count', 'public_rating'].includes(String(value.input));
  return false;
}

function validImpact(value: unknown, partition: number): value is PrivacyReduction['impacts'][number] {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'subject')
    return (
      typeof value.route === 'number' &&
      belongsToPartition(value.route, partition) &&
      typeof value.subject === 'string' &&
      routeOf(value.subject) === value.route
    );
  if (value.kind === 'keys')
    return (
      belongsToPartition(value.route, partition) &&
      typeof value.subject === 'string' &&
      routeOf(value.subject) === value.route &&
      Array.isArray(value.keys) &&
      value.keys.length > 0 &&
      value.keys.every(validDependencyKey)
    );
  return value.kind === 'dependency' && validDependency(value.locator, partition);
}

function validBroadReduction(reduction: Pick<PrivacyReduction, 'cause' | 'affected' | 'impacts'>): boolean {
  if (reduction.cause !== 'realm' && reduction.cause !== 'board') return true;
  // Broad native causes carry authority locators, never a synthetic Subject
  // or a hit-derived key list. A Realm board has one immutable parent Realm.
  const affected = reduction.affected.filter((value) => value.kind === 'realm' || value.kind === 'board');
  const primary = affected.filter((value) => value.kind === reduction.cause);
  if (
    primary.length !== 1 ||
    affected.length > (reduction.cause === 'board' ? 2 : 1) ||
    affected.some(
      (value) => value.kind !== reduction.cause && !(reduction.cause === 'board' && value.kind === 'realm'),
    ) ||
    affected.some(
      (value) =>
        reduction.impacts.filter((impact) => impact.kind === 'dependency' && isDeepStrictEqual(impact.locator, value))
          .length !== 1,
    ) ||
    reduction.impacts.some(
      (impact) =>
        impact.kind === 'dependency' &&
        (impact.locator.kind === 'realm' || impact.locator.kind === 'board') &&
        !affected.some((value) => isDeepStrictEqual(impact.locator, value)),
    )
  )
    return false;

  return true;
}

function validatePrivacyReduction(tx: CommandTransaction, reduction: PrivacyReduction) {
  const command = currentCommand(tx);
  authoritativeTimeValue(command.time);
  if (
    !reduction ||
    !Number.isInteger(reduction.partition) ||
    reduction.partition < 0 ||
    reduction.partition > 4095 ||
    command.partition !== reduction.partition ||
    command.transactionId !== reduction.transactionId ||
    command.time !== reduction.time ||
    command.authorization === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reduction.transactionId) ||
    !['subject', 'candidate', 'selection', 'sourceTuple', 'consent', 'collection', 'realm', 'board'].includes(
      reduction.cause,
    ) ||
    !Array.isArray(reduction.affected) ||
    !Array.isArray(reduction.impacts) ||
    reduction.affected.length < 1 ||
    reduction.impacts.length < 1 ||
    reduction.affected.length + reduction.impacts.length > 1000
  )
    throw new TypeError('Invalid native privacy reduction');

  if (!reduction.affected.every((value) => validDependency(value, reduction.partition)))
    throw new TypeError('Invalid native privacy dependency');
  if (!reduction.impacts.every((value) => validImpact(value, reduction.partition)))
    throw new TypeError('Invalid native privacy impact');
  if (!validBroadReduction(reduction)) throw new TypeError('Invalid broad native privacy reduction');
  return command;
}

async function inReadSnapshot<T>(pool: Pool, deadline: number, read: (client: import('pg').PoolClient) => Promise<T>) {
  return withConnection(pool, async (client) => {
    requireAccessDeadline(deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const remaining = Math.max(1, Math.floor(deadline - Date.now()));
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      requireAccessDeadline(deadline);
      const result = await read(client);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      requireAccessDeadline(deadline);
      throw error;
    }
  });
}

/**
 * Constructor-origin routing is internal; the binding independently registers and verifies
 * persisted Source metadata. Population coverage stays closed until its retained cut is complete.
 */
export const publicFilterSource: PublicFilterSourceFactory = (config) => {
  if (!config.pool || typeof config.pool.connect !== 'function' || typeof config.pool.query !== 'function')
    throw new TypeError('A native pool is required');
  if (!(config.routeKey instanceof Uint8Array) || config.routeKey.byteLength < 32)
    throw new TypeError('Route key must contain at least 32 bytes');
  if (
    !config.access ||
    typeof config.access.authorize !== 'function' ||
    typeof config.access.authenticate !== 'function'
  )
    throw new TypeError('A native Access instance is required');
  const source: PublicFilterNativeSource = {
    async resolvePublicFilterDefinition(
      request: Readonly<{ meaning: PublicFilterProjectionMeaning; capture: PublicCanonicalCaptureInput }>,
      context: PublicFilterConsumerContext,
    ) {
      const native = origins.get(source)!;
      const result = await createPublicFilterSourceBinding(native.pool, native.routeKey, native.access).resolve(
        { source, ...request },
        context,
      );
      if (result.status === 'resolved') return { status: 'bound', definition: result.definition, cost: result.cost };
      return {
        status: result.status,
        reason: result.reason === 'deadline' ? 'deadline' : 'source_pending',
        cost: result.cost,
      };
    },
    async readPublicFilterProjectionPage(request: PublicFilterProjectionRequest) {
      return readProjectionPage(config, request);
    },
    async readPrivacyReductionHeads(
      request: PrivacyReductionObservationRequest | JoinedPopulationRequest,
      context?: PublicFilterConsumerContext,
    ): Promise<PrivacyReductionObservation> {
      const readContext = 'context' in request ? request.context : context;
      if (!readContext) return unready('metadata_missing');
      if (request.kind === 'population') {
        return readPublicFilterPopulation(config.pool, config.routeKey, request);
      }
      if (request.kind !== 'home') return unready('metadata_missing');
      try {
        requireAccessDeadline(readContext.deadline);
        return await withRequestDeadline(readContext.deadline, () =>
          inReadSnapshot(config.pool, readContext.deadline, async (client) => {
            const owner = await readPartition(client, request.partition);
            if (!owner) return unavailable('missing_owner');
            if (owner.writeState === 'moved') return unavailable('moved');
            if (owner.writeState !== 'active') return unready('owner_pending');
            const row = await readPrivacyHead.run(client, {
              partition_no: request.partition,
            });
            if (!row) return unready('metadata_missing');
            if (row.population_fenced || row.owner_epoch !== owner.epoch) return unready('owner_pending');
            const head = privacyHead(request.partition, owner.epoch, row.position);
            return { status: 'home', head, cost: cost(1) };
          }),
        );
      } catch (error) {
        if (error instanceof AccessUnavailableError) return unavailable('deadline');
        throw error;
      }
    },
    async readPrivacyReductionPage(request: PrivacyReductionLogRequest): Promise<PrivacyReductionLogPage> {
      if (
        !Number.isInteger(request.partition) ||
        request.partition < 0 ||
        request.partition > 4095 ||
        !Number.isInteger(request.epoch) ||
        request.epoch < 1 ||
        request.after < 0n ||
        request.through < request.after ||
        !Number.isInteger(request.inputLimit) ||
        request.inputLimit < 1 ||
        request.inputLimit > 1000
      )
        throw new RangeError('Invalid native privacy log page');
      try {
        requireAccessDeadline(request.context.deadline);
        return await withRequestDeadline(request.context.deadline, () =>
          inReadSnapshot(config.pool, request.context.deadline, async (client) => {
            const owner = await readPartition(client, request.partition);
            if (!owner) return unavailable('missing_owner');
            if (owner.writeState === 'moved') return unavailable('moved');
            if (owner.writeState !== 'active') return unready('owner_pending');
            if (owner.epoch !== request.epoch) return { status: 'changed', cost: cost() };
            const currentRow = await readPrivacyHead.run(client, {
              partition_no: request.partition,
            });
            if (!currentRow) return unready('metadata_missing');
            if (currentRow.population_fenced || currentRow.owner_epoch !== owner.epoch) return unready('owner_pending');
            const current = BigInt(currentRow.position);
            if (request.through > current) return { status: 'changed', cost: cost(1) };
            if (request.after === request.through)
              return {
                status: 'complete',
                head: { partition: request.partition, epoch: owner.epoch, position: request.through },
                entries: [],
                after: request.through,
                cost: cost(1),
              };
            const found = rows(
              await readPrivacyEntries.run(client, {
                partition_no: request.partition,
                after: request.after.toString(),
                through: request.through.toString(),
                input_limit: request.inputLimit,
              }),
            );
            const entries: PrivacyReductionLogEntry[] = found.map((row) => ({
              head: privacyHead(request.partition, owner.epoch, row.position),
              transactionId: row.transaction_id,
              cause: row.cause,
              affected: row.affected as PrivacyReduction['affected'],
              impacts: row.impacts as PrivacyReduction['impacts'],
            }));
            if (
              entries.some(
                (entry) =>
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    entry.transactionId,
                  ) ||
                  ![
                    'subject',
                    'candidate',
                    'selection',
                    'sourceTuple',
                    'consent',
                    'collection',
                    'realm',
                    'board',
                  ].includes(entry.cause) ||
                  !Array.isArray(entry.affected) ||
                  !entry.affected.every((value) => validDependency(value, request.partition)) ||
                  !Array.isArray(entry.impacts) ||
                  !entry.impacts.every((value) => validImpact(value, request.partition)) ||
                  !validBroadReduction(entry),
              )
            )
              return { ...unready('metadata_missing'), cost: cost(found.length) };
            const after = entries.at(-1)?.head.position ?? request.after;
            const contiguous = entries.every(
              (entry, index) => entry.head.position === request.after + BigInt(index) + 1n,
            );
            if (!contiguous || (entries.length === 0 && request.after < request.through))
              return { ...unready('metadata_missing'), cost: cost(found.length) };
            const complete = after === request.through;
            return {
              status: complete ? ('complete' as const) : ('progress' as const),
              head: { partition: request.partition, epoch: owner.epoch, position: request.through },
              entries,
              after,
              cost: cost(found.length),
            };
          }),
        );
      } catch (error) {
        if (error instanceof AccessUnavailableError) return unavailable('deadline');
        throw error;
      }
    },
  };
  origins.set(source, Object.freeze({ ...config, routeKey: new Uint8Array(config.routeKey) }));
  return Object.freeze(source);
};

export const recordPrivacyReduction: RecordPrivacyReductionType = async (
  tx: CommandTransaction,
  reduction: PrivacyReduction,
): Promise<PrivacyReductionLogEntry> => {
  const command = validatePrivacyReduction(tx, reduction);
  if (reduction.cause === 'board') {
    const board = reduction.affected.find((value) => value.kind === 'board');
    if (!board || board.kind !== 'board') throw new TypeError('Missing native board authority');
    const native = await realmOfBoard.run(tx, { route: board.route, id: board.board });
    const realm = reduction.affected.find((value) => value.kind === 'realm');
    if (
      !native ||
      (native.realm_id === null
        ? realm !== undefined
        : realm?.kind !== 'realm' || realm.realm !== native.realm_id || realm.route !== board.route)
    )
      throw new TypeError('Board privacy reduction does not bind its native parent Realm');
  }
  const owner = await readPartition(tx, reduction.partition);
  if (!owner || owner.writeState !== 'active' || owner.epoch < 1)
    throw new CommandUnavailableError('fenced', reduction.partition);
  await ensurePrivacyHead.run(tx, { partition_no: reduction.partition, owner_epoch: owner.epoch });
  const locked = await lockPrivacyHead.run(tx, {
    partition_no: reduction.partition,
    owner_epoch: owner.epoch,
  });
  if (!locked) throw new CommandUnavailableError('fenced', reduction.partition);
  const advanced = rows(
    await advancePrivacyHead.run(tx, {
      partition_no: reduction.partition,
      owner_epoch: owner.epoch,
    }),
  )[0];
  if (!advanced) throw new CommandUnavailableError('fenced', reduction.partition);
  const position = BigInt(advanced.position);
  const appended = await appendPrivacyEntry.run(tx, {
    partition_no: reduction.partition,
    owner_epoch: owner.epoch,
    position: position.toString(),
    transaction_id: command.transactionId,
    cause: reduction.cause,
    affected: JSON.stringify(reduction.affected),
    impacts: JSON.stringify(reduction.impacts),
    recorded_at: authoritativeTimeValue(command.time),
  });
  if (!appended) throw new AccessUnavailableError('overloaded');
  const entry: PrivacyReductionLogEntry = {
    head: { partition: reduction.partition, epoch: owner.epoch, position },
    transactionId: command.transactionId,
    cause: reduction.cause,
    affected: reduction.affected,
    impacts: reduction.impacts,
  };
  await enqueuePublicFilterCoverage(tx, entry);
  return entry;
};
