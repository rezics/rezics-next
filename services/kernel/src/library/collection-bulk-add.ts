import canonicalize from 'canonicalize';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { withConnection } from '../database/pool.ts';
import {
  authoritativeTimeValue,
  noEffect,
  runCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import type { AccessClient, AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { addCollectionMemberIfAbsentNative, type CollectionBulkAddEffect } from './collections.ts';
import { applyCollectionBulkTarget, pageCollectionBulkManifest, readCollectionBulk } from './collection-bulk-store.ts';
import { resolveSubject, type ResolvedSubject } from './subject-anchor.ts';
import type {
  AttemptResult,
  BulkDependencies,
  BulkReason,
  ReceiptLocator,
  SubjectTarget,
  TargetCommand,
  TargetEvidence,
} from './bulk-contract.ts';

type ExpectationResult = { matches: true } | { matches: false; reason: BulkReason };
type Prepared = {
  attempt: object;
  actor: AccountActor;
  subject: ResolvedSubject | null;
  expectation: ExpectationResult;
  access: ReturnType<typeof resourceAuthorization>;
  accessProof: unknown;
};

class EvidenceMissingError extends Error {}

function capturedSubject(target: SubjectTarget): Omit<SubjectTarget, 'operationId' | 'ordinal'> {
  const { operationId: _operationId, ordinal: _ordinal, ...captured } = target;
  return captured;
}

function sameJson(left: unknown, right: unknown): boolean {
  const a = canonicalize(left),
    b = canonicalize(right);
  return typeof a === 'string' && a === b;
}

function validReceipt(receipt: ReceiptLocator, accountId: string, destinationPartition: number): boolean {
  return (
    receipt.partition === destinationPartition &&
    receipt.principalKind === 'account' &&
    receipt.principalId === accountId &&
    receipt.commandKind === 'library.collectionBulk.target' &&
    receipt.key.length > 0 &&
    receipt.key.length <= 255 &&
    /^[a-f0-9]{64}$/.test(receipt.digest)
  );
}

async function checkEntryExpectation(
  client: Pick<CommandTransaction, 'query'>,
  accountId: string,
  subjectId: string,
  expected: SubjectTarget['expected'],
): Promise<ExpectationResult> {
  const route = routeOf(accountId);
  if (route === null) return { matches: false, reason: 'revision_mismatch' };
  const entry = await client.query<{
    incarnationId: string | null;
    admissionSequence: string | null;
    revision: number;
  }>(
    `SELECT incarnation_id AS "incarnationId", owner_write_seq::text AS "admissionSequence", revision
     FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [route, accountId, subjectId],
  );
  const current = entry.rows[0];
  if (expected.kind === 'present') {
    if (!current) return { matches: false, reason: 'revision_mismatch' };
    if (current.incarnationId !== expected.incarnation) return { matches: false, reason: 'incarnation_mismatch' };
    if (current.revision !== expected.revision || current.admissionSequence !== expected.admissionSequence)
      return { matches: false, reason: 'revision_mismatch' };
    return { matches: true };
  }
  if (current) return { matches: false, reason: 'revision_mismatch' };
  const generation = await client.query<{ seq: string }>(
    'SELECT seq::text AS seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
    [route, accountId],
  );
  if ((generation.rows[0]?.seq ?? '0') !== expected.slotGeneration)
    return { matches: false, reason: 'revision_mismatch' };
  return { matches: true };
}

async function verifyPersistedTarget(
  dependencies: BulkDependencies,
  command: TargetCommand & { target: SubjectTarget },
): Promise<ExpectationResult> {
  return withConnection(dependencies.pool, async (client) => {
    const key = {
      route: command.source.route,
      accountId: command.receipt.principalId,
      operationId: command.target.operationId,
    };
    const operation = await readCollectionBulk(client as CommandTransaction, key);
    if (
      !operation ||
      operation.phase !== 'applying' ||
      operation.sourceDigest !== command.sourceDigest ||
      operation.request.action !== 'add_to_collection' ||
      operation.request.collectionId !== command.target.collectionId
    )
      throw new EvidenceMissingError();
    const ordinal = Number(command.target.ordinal);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 1_000) throw new EvidenceMissingError();
    const [row] = await pageCollectionBulkManifest(client as CommandTransaction, {
      ...key,
      after: ordinal - 1,
      limit: 1,
    });
    if (
      !row ||
      row.ordinal !== command.target.ordinal ||
      !sameJson(row.target, capturedSubject(command.target)) ||
      !sameJson(row.receipt, command.receipt)
    )
      throw new EvidenceMissingError();
    return checkEntryExpectation(
      client,
      command.receipt.principalId,
      command.target.subjectId,
      command.target.expected,
    );
  });
}

function evidence(
  command: TargetCommand,
  transactionId: string,
  effect: Pick<CollectionBulkAddEffect, 'state' | 'reason' | 'resultingMemberId'>,
): TargetEvidence {
  return {
    operationId: command.target.operationId,
    ordinal: command.target.ordinal,
    sourceDigest: command.sourceDigest,
    receipt: command.receipt,
    transactionId,
    outcome: effect.state,
    reason: effect.reason,
    resultingMemberId: effect.state === 'applied' ? effect.resultingMemberId : null,
  };
}

/** Execute one exact captured subject add. Same-home effects and outcomes share one command;
 * remote Collection commands return their durable receipt evidence for source-side acknowledgement.
 */
export async function executeCollectionAddTarget(
  dependencies: BulkDependencies,
  command: TargetCommand,
): Promise<AttemptResult> {
  if (command.target.kind !== 'subject') return { kind: 'stop', reason: 'evidence_missing' };
  const target = command.target;
  const collectionId = target.collectionId;
  if (!collectionId) return { kind: 'stop', reason: 'evidence_missing' };
  const sourceRoute = command.source.route;
  const accountId = command.receipt.principalId;
  const collectionRoute = routeOf(collectionId);
  if (
    collectionRoute === null ||
    command.source.id !== target.operationId ||
    !Number.isInteger(sourceRoute) ||
    sourceRoute < 0 ||
    sourceRoute > 65535 ||
    routeOf(target.subjectId) === null ||
    routeOf(accountId) !== sourceRoute ||
    !/^[a-f0-9]{64}$/.test(command.sourceDigest) ||
    !validReceipt(command.receipt, accountId, partitionOf(collectionRoute))
  )
    return { kind: 'stop', reason: 'evidence_missing' };

  const resource = Object.freeze({ route: collectionRoute, id: collectionId });
  const anchor = Object.freeze({
    resource,
    async validate(client: AccessClient, _time: AuthoritativeTime) {
      const rows = await client.query(
        `SELECT 1 FROM library.collection
         WHERE route=$1 AND collection_id=$2 AND state='active'`,
        [collectionRoute, collectionId],
      );
      return rows.rowCount === 1;
    },
  });
  const prepared = new WeakMap<AuthoritativeTime, Prepared>();
  const authorization = {
    action: 'collection:update',
    resource,
    denied: () => new GrantDeniedError(),
    async prepare(attempt: CommandAttempt) {
      const durable = await withConnection(dependencies.pool, (client) =>
        dependencies.readInitiator(client, command.source, attempt.time),
      );
      if (
        !durable ||
        durable.initiatorAccountId !== accountId ||
        durable.actor.clientId !== command.identity.clientId ||
        durable.actor.requestedBy !== command.identity.requestedBy
      )
        throw new GrantDeniedError();
      const actor = await dependencies.initiators.restoreInitiator(
        {
          operation: command.source,
          action: 'collection:update',
          anchor,
          context: { pool: dependencies.pool, deadline: command.deadline },
        },
        attempt.time,
      );
      if (
        actor.accountId !== accountId ||
        actor.clientId !== command.identity.clientId ||
        actor.requestedBy !== command.identity.requestedBy
      )
        throw new GrantDeniedError();
      const currentAccess = resourceAuthorization({
        access: dependencies.access,
        actor,
        action: 'collection:update',
        anchor,
        context: { pool: dependencies.pool, deadline: command.deadline, partition: partitionOf(collectionRoute) },
      });
      const accessProof = await currentAccess.prepare!(attempt);
      let subject: ResolvedSubject | null;
      try {
        subject = await resolveSubject(
          { pool: dependencies.pool, access: dependencies.access, clock: dependencies.clock },
          actor,
          target.subjectId,
          attempt.time,
          { pool: dependencies.pool, deadline: command.deadline },
        );
      } catch (error) {
        if (!(error instanceof GrantDeniedError)) throw error;
        subject = null;
      }
      const expectation =
        collectionRoute === sourceRoute
          ? ({ matches: true } as const)
          : await withConnection(dependencies.pool, (client) =>
              checkEntryExpectation(client as CommandTransaction, accountId, target.subjectId, target.expected),
            );
      if (collectionRoute !== sourceRoute)
        await verifyPersistedTarget(dependencies, command as TargetCommand & { target: SubjectTarget });
      prepared.set(attempt.time, { attempt, actor, subject, expectation, access: currentAccess, accessProof });
      return Object.freeze({});
    },
    async authorize(tx: CommandTransaction, attempt: CommandAttempt, proof: unknown) {
      const value = prepared.get(attempt.time);
      if (!value || value.attempt !== attempt || !proof) throw new GrantDeniedError();
      if ((await value.access.authorize(tx, attempt, value.accessProof)) !== 'execute') throw new GrantDeniedError();
      return 'execute' as const;
    },
  };

  try {
    const result = await runCommand<TargetEvidence>(
      dependencies.pool,
      {
        principal: { kind: 'account', id: accountId },
        basis: command.identity,
        partition: partitionOf(collectionRoute),
        deadline: command.deadline,
        clock: dependencies.clock,
        receipt: {
          kind: command.receipt.commandKind,
          key: command.receipt.key,
          digest: Buffer.from(command.receipt.digest, 'hex'),
        },
        authorization,
      },
      async (tx, context) => {
        const state = prepared.get(context.time);
        if (!state) throw new GrantDeniedError();
        const subjectResult: ExpectationResult = !state.subject
          ? { matches: false, reason: 'target_denied' }
          : state.subject.subjectId !== target.subjectId
            ? { matches: false, reason: 'incarnation_mismatch' }
            : state.expectation;
        const targetEffect = async (): Promise<CollectionBulkAddEffect> => {
          if (!subjectResult.matches)
            return {
              state: subjectResult.reason === 'target_denied' ? 'denied' : 'conflict',
              reason: subjectResult.reason,
              resultingMemberId: null,
              events: [],
            };
          const expectation =
            collectionRoute === sourceRoute
              ? await checkEntryExpectation(tx, accountId, target.subjectId, target.expected)
              : state.expectation;
          if (!expectation.matches)
            return { state: 'conflict', reason: expectation.reason, resultingMemberId: null, events: [] };
          return addCollectionMemberIfAbsentNative(tx, state.actor, collectionId, target.subjectId, {
            transactionId: context.transactionId,
            time: authoritativeTimeValue(context.time),
          });
        };

        if (collectionRoute !== sourceRoute) {
          const effect = await targetEffect();
          const value = evidence(command, context.transactionId, effect);
          return effect.events.length > 0 ? { value, events: effect.events } : noEffect(value);
        }

        let invoked = false;
        let events: CollectionBulkAddEffect['events'] = [];
        const applied = await applyCollectionBulkTarget(
          tx,
          {
            route: sourceRoute,
            accountId,
            operationId: target.operationId,
            ordinal: Number(target.ordinal),
            now: authoritativeTimeValue(context.time),
          },
          async (native, operation, row) => {
            if (
              operation.request.action !== 'add_to_collection' ||
              operation.request.collectionId !== target.collectionId ||
              row.target.kind !== 'subject' ||
              !sameJson(row.target, capturedSubject(target)) ||
              !sameJson(row.receipt, command.receipt) ||
              operation.sourceDigest !== command.sourceDigest
            )
              throw new EvidenceMissingError();
            invoked = true;
            const effect = await targetEffect();
            events = effect.events;
            return {
              state: effect.state,
              reason: effect.reason,
              resultingMemberId: effect.resultingMemberId,
            };
          },
        );
        if (!applied || (!invoked && applied.reason !== 'execution_expired')) throw new EvidenceMissingError();
        const value = evidence(command, context.transactionId, {
          state: applied.state,
          reason: applied.reason,
          resultingMemberId: applied.resultingMemberId ?? null,
        });
        return events.length > 0 ? { value, events } : noEffect(value);
      },
    );
    if (!result.value || result.value.operationId !== target.operationId || result.value.ordinal !== target.ordinal)
      return { kind: 'stop', reason: 'evidence_missing' };
    return { kind: 'terminal', evidence: result.value };
  } catch (error) {
    if (error instanceof EvidenceMissingError) return { kind: 'stop', reason: 'evidence_missing' };
    if (error instanceof GrantDeniedError) return { kind: 'stop', reason: 'authority_lost' };
    throw error;
  }
}
