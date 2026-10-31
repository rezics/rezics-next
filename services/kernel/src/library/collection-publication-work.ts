import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { accessCheck, type AccessClient } from '../request/access.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { withConnection } from '../database/pool.ts';
import {
  advanceCollectionPublicationEpisodePhase,
  COLLECTION_PUBLICATION_COMMAND,
  COLLECTION_PUBLICATION_WORKFLOW,
  readCollectionPublicationEpisode,
  readCollectionPublicationEpisodeVersion,
  readCollectionPublicationInitiator,
  readCollectionPublicationRule,
} from './collection-publication-episodes.ts';
import {
  authoritativeTimeValue,
  currentCommandResources,
  mintReadTime,
  runCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { ProblemError } from '../http/problem.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readCollection } from './collection-store.ts';
import { authorizeCollectionRule, prepareCollectionRuleAuthority } from './collection-rules.ts';
import { admitSavedCollectionMemberQuery, prepareNativeCollectionMemberAuthority } from './owner-filter.ts';
import { completeCollectionSourceOutput } from './collection-source-output.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { stageCollectionPublicationStep } from './collection-publication-staging.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import { workStepDeadline } from './command-support.ts';
import { scopeAllowance } from '../search/scope-execution.ts';
import { collectionPublicationScopeRuntime } from '../search/work.ts';
import type { WorkContext } from '../work/registry.ts';

type WorkflowInput = Readonly<CollectionPublicationLocator & { accounts: readonly [string] }>;
type Context = Pick<WorkContext, 'pool' | 'client' | 'clock' | 'env' | 'getAuthorization'>;
type PreparedFinal = Readonly<{
  actor: import('../request/access.ts').AccountActor;
  ordinary: CommandAuthorization;
  proof: unknown;
  checks: Awaited<ReturnType<typeof prepareCollectionRuleAuthority>>;
  episode: NonNullable<Awaited<ReturnType<typeof readCollectionPublicationEpisode>>>;
  rule: NonNullable<Awaited<ReturnType<typeof readCollectionPublicationRule>>>;
}>;

function unavailable(): ProblemError {
  return new ProblemError('dependency_unavailable');
}

function validate(input: WorkflowInput): CollectionPublicationLocator {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).length !== 5 ||
    !Array.isArray(input.accounts) ||
    input.accounts.length !== 1 ||
    typeof input.accounts[0] !== 'string' ||
    routeOf(input.accounts[0]) === null ||
    routeOf(input.collectionId) !== routeOf(input.accounts[0]) ||
    routeOf(input.ownerAccountId) !== routeOf(input.accounts[0]) ||
    routeOf(input.publicationId) !== routeOf(input.accounts[0]) ||
    input.route !== routeOf(input.collectionId) ||
    input.accounts[0] !== input.ownerAccountId ||
    Buffer.byteLength(JSON.stringify(input)) > 4096
  )
    throw new TypeError('Invalid whole-query Collection publication locator');
  return {
    route: input.route,
    ownerAccountId: input.ownerAccountId,
    collectionId: input.collectionId,
    publicationId: input.publicationId,
  };
}

function intent(locator: CollectionPublicationLocator, workflowId: string) {
  return {
    queue: 'workflows' as const,
    workflowName: COLLECTION_PUBLICATION_WORKFLOW,
    workflowId,
    input: { accounts: [locator.ownerAccountId], ...locator },
  };
}

async function stage(context: Context, input: WorkflowInput): Promise<'more' | 'sealed' | 'done'> {
  const locator = validate(input);
  const runtime = collectionPublicationScopeRuntime(context as WorkContext);
  if (!runtime || runtime.pool !== context.pool) throw unavailable();
  const { access } = context.getAuthorization();
  const routeKey = readMembershipWorkConfig(context.env).routeKey;
  const deadline = workStepDeadline();
  return runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: COLLECTION_PUBLICATION_WORKFLOW,
      accounts: [locator.ownerAccountId],
      workClient: context.client,
      deadline,
      clock: context.clock,
    },
    async (tx) => {
      const episode = await readCollectionPublicationEpisode(tx, locator);
      if (!episode || episode.phase === 'refused' || episode.phase === 'complete') return 'done';
      const version = await readCollectionPublicationEpisodeVersion(tx, locator);
      if (version === null) throw unavailable();
      const allowance = scopeAllowance(100, `${locator.publicationId}:${version}`);
      const result = await stageCollectionPublicationStep(tx, locator, {
        ...runtime,
        clock: context.clock,
        allowance,
        evidence: {
          access,
          routeKey,
          deadline,
          work: { kind: 'collection-publication', tx, locator },
        },
      });
      if (result.state === 'sealed' && episode.phase === 'staging') {
        if (
          !(await advanceCollectionPublicationEpisodePhase(
            tx,
            locator,
            { version, phase: 'staging' },
            'awaiting_activation',
          ))
        )
          throw unavailable();
      }
      if (result.state === 'more') {
        await enqueueIntent(tx, intent(locator, `${locator.publicationId}:${result.checkpoint.version}`));
        return 'more';
      }
      return 'sealed';
    },
  );
}

async function currentInitiator(context: Context, locator: CollectionPublicationLocator) {
  const deadline = workStepDeadline();
  return withConnection(context.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const time = await mintReadTime(client, context.clock);
    const episode = await readCollectionPublicationEpisode(client, locator);
    if (!episode) throw unavailable();
    const operation = episode.initiator.operation;
    const record = await readCollectionPublicationInitiator(client, operation, time);
    if (
      !record ||
      record.actor.kind !== 'account' ||
      record.initiatorAccountId !== locator.ownerAccountId ||
      record.operation.id !== locator.publicationId ||
      record.operation.kind !== COLLECTION_PUBLICATION_COMMAND
    )
      throw unavailable();
    return { episode, record };
  });
}

function readDigest(value: unknown): Uint8Array {
  const serialized = canonicalize(value);
  if (typeof serialized !== 'string') throw new TypeError('Publication activation input is not canonical');
  return createHash('sha256').update(serialized).digest();
}

async function activate(context: Context, input: WorkflowInput): Promise<void> {
  const locator = validate(input);
  const { episode, record } = await currentInitiator(context, locator);
  if (episode.phase === 'complete' || episode.phase === 'refused') return;
  if (episode.phase !== 'awaiting_activation') throw unavailable();
  const { access, readConsent } = context.getAuthorization();
  const deadline = workStepDeadline();
  const resource = Object.freeze({ route: locator.route, id: locator.collectionId });
  const anchor = {
    resource,
    async validate(client: AccessClient) {
      const collection = await readCollection(client, locator.route, locator.collectionId);
      return (
        collection?.state === 'active' &&
        collection.curatorAccountId === locator.ownerAccountId &&
        collection.membershipKind === 'dynamic'
      );
    },
  };
  const restorer = createInitiatorRestorer({
    pool: context.pool,
    access,
    readOperation: readCollectionPublicationInitiator,
    readConsent,
  });
  const prepared = new WeakMap<AuthoritativeTime, PreparedFinal>();
  const authorization: CommandAuthorization = {
    action: 'collection:update',
    resource,
    denied: () => new ProblemError('forbidden'),
    async prepare(attempt: CommandAttempt) {
      const actor = await restorer.restoreInitiator(
        {
          operation: record.operation,
          action: 'collection:update',
          anchor,
          context: { pool: context.pool, deadline },
        },
        attempt.time,
      );
      const ordinary = resourceAuthorization({
        access,
        actor,
        action: 'collection:update',
        anchor,
        context: { pool: context.pool, deadline, partition: partitionOf(locator.route) },
      });
      const proof = await ordinary.prepare!(attempt);
      const currentRule = await withConnection(context.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        const currentEpisode = await readCollectionPublicationEpisode(client, locator);
        const rule = await readCollectionPublicationRule(client, locator);
        if (
          !currentEpisode ||
          currentEpisode.phase !== 'awaiting_activation' ||
          !isSameSource(currentEpisode, episode) ||
          !rule
        )
          throw unavailable();
        return { episode: currentEpisode, rule };
      });
      const query = await admitSavedCollectionMemberQuery(
        { pool: context.pool, access, clock: () => new Date(authoritativeTimeValue(attempt.time)) },
        actor,
        currentRule.rule,
        {},
        deadline,
      );
      const checks = [
        ...(await prepareCollectionRuleAuthority(
          { pool: context.pool, access },
          actor,
          currentRule.rule.filter,
          attempt,
          deadline,
        )),
        ...(await prepareNativeCollectionMemberAuthority(
          { pool: context.pool, access },
          actor,
          query,
          attempt.time,
          deadline,
          attempt,
        )),
        await accessCheck(
          access,
          actor,
          'collection:read',
          resource,
          commandAccessContext({ pool: context.pool, deadline }, attempt),
        ),
      ];
      prepared.set(attempt.time, {
        actor,
        ordinary,
        proof,
        checks,
        episode: currentRule.episode,
        rule: currentRule.rule,
      });
      return proof;
    },
    async authorize(tx: CommandTransaction, attempt: CommandAttempt, proof: unknown) {
      const item = prepared.get(attempt.time);
      if (!item || proof !== item.proof) throw unavailable();
      const mode = await item.ordinary.authorize(tx, attempt, item.proof);
      if (mode !== 'execute') throw new ProblemError('forbidden');
      try {
        await shareAccount(tx, locator.ownerAccountId);
      } catch (error) {
        if (error instanceof LifecycleDeniedError) throw new ProblemError('forbidden');
        throw error;
      }
      await authorizeCollectionRule(tx, attempt, item.checks);
      const currentEpisode = await readCollectionPublicationEpisode(tx, locator);
      const currentRule = await readCollectionPublicationRule(tx, locator);
      if (
        !currentEpisode ||
        currentEpisode.phase !== 'awaiting_activation' ||
        !isSameSource(currentEpisode, item.episode) ||
        !isDeepStrictEqual(currentRule, item.rule)
      )
        throw unavailable();
      return mode;
    },
    async finalize(tx: CommandTransaction, attempt: CommandAttempt, proof: unknown) {
      const item = prepared.get(attempt.time);
      if (!item || proof !== item.proof) throw unavailable();
      await item.ordinary.finalize?.(tx, attempt, item.proof);
    },
  };
  const identity = {
    principal: { kind: 'account' as const, id: record.initiatorAccountId },
    basis: { clientId: record.actor.clientId, requestedBy: record.actor.requestedBy },
  };
  const kind = 'library.collection.publication.activate';
  const requestKey = locator.publicationId;
  const requestDigest = readDigest({
    principal: identity.principal,
    basis: identity.basis,
    operation: record.operation,
    sourceDigest: record.sourceDigest,
    target: episode.source.target,
  });
  await runCommand(
    context.pool,
    {
      ...identity,
      partition: partitionOf(locator.route),
      deadline,
      clock: context.clock,
      receipt: { kind, key: requestKey, digest: requestDigest },
      authorization,
    },
    async (tx, command) => {
      const item = prepared.get(command.time);
      if (!item || item.episode.phase !== 'awaiting_activation') throw unavailable();
      const route = locator.route;
      const collection = await readCollection(tx, route, locator.collectionId);
      if (
        !collection ||
        collection.state !== 'active' ||
        collection.curatorAccountId !== locator.ownerAccountId ||
        collection.membershipKind !== 'dynamic' ||
        collection.revision !== item.rule.collectionRevision
      )
        throw unavailable();
      const changed = await tx.query(
        `UPDATE library.collection SET visibility=$4,revision=revision+1,
             updated_at=$5::timestamptz,transaction_id=$6
         WHERE route=$1 AND collection_id=$2 AND revision=$3 AND source_generation=$7
           AND state='active' AND curator_account_id=$8 AND membership_kind='dynamic'`,
        [
          route,
          locator.collectionId,
          collection.revision,
          episode.source.target.visibility,
          authoritativeTimeValue(command.time),
          command.transactionId,
          item.rule.sourceGeneration,
          locator.ownerAccountId,
        ],
      );
      if (changed.rowCount !== 1) throw new ProblemError('conflict');
      const resources = currentCommandResources(tx);
      const work = new NativeCollectionWork(
        scopeAllowance(100, `${locator.publicationId}:activation`),
        resources.deadline,
      );
      await completeCollectionSourceOutput(tx, episode.source.output, { locator, work });
      const version = await readCollectionPublicationEpisodeVersion(tx, locator);
      if (
        version === null ||
        !(
          await tx.query(
            `UPDATE library.collection_publication_episode SET phase='complete',version=version+1
           WHERE route=$1 AND publication_id=$2 AND owner_account_id=$3 AND collection_id=$4
             AND version=$5 AND phase='awaiting_activation' RETURNING publication_id`,
            [route, locator.publicationId, locator.ownerAccountId, locator.collectionId, version],
          )
        ).rows.length
      )
        throw unavailable();
      return {
        value: { publicationId: locator.publicationId },
        events: [
          {
            type: 'com.rezics.library.collection.updated.v1',
            subject: locator.collectionId,
            data: { collectionId: locator.collectionId },
          },
          {
            type: 'com.rezics.library.collection.listing.changed.v1',
            subject: locator.collectionId,
            data: { collectionId: locator.collectionId },
          },
        ],
      };
    },
  );
}

function isSameSource(
  left: NonNullable<Awaited<ReturnType<typeof readCollectionPublicationEpisode>>>,
  right: NonNullable<Awaited<ReturnType<typeof readCollectionPublicationEpisode>>>,
): boolean {
  return isDeepStrictEqual(left.source, right.source) && left.durableInitiator === right.durableInitiator;
}

/** Register the locator-only continuation on the Library module's existing workflows queue. */
export function registerCollectionPublicationWork(context: WorkContext): void {
  const step = DBOS.registerStep(async (input: WorkflowInput) => stage(context, input), {
    name: 'library.collectionPublicationStage',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  const activateStep = DBOS.registerStep(async (input: WorkflowInput) => activate(context, input), {
    name: 'library.collectionPublicationActivate',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  DBOS.registerWorkflow(
    async (input: WorkflowInput) => {
      const result = await step(input);
      if (result === 'sealed') await activateStep(input);
    },
    { name: COLLECTION_PUBLICATION_WORKFLOW },
  );
}
