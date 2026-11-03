import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { ACCESS_EVENTS } from '../access/events.ts';
import { currentCommand, noEffect, runCommand, authoritativeTimeValue } from '../command/command.ts';
import type { CommandEvent } from '../command/command.ts';
import type { CloudEvent, Envelope } from '../events/log.ts';
import { projectBatch } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  CLASSIFICATION_AGGREGATE_CHANGED,
  CLASSIFICATION_BALLOT_CHANGED,
  CLASSIFICATION_BALLOT_CLEANUP,
  RATING_EVENTS,
} from './events.ts';
import type { Assessment } from './classification-ballot.ts';
import actorStateRead from './classification-ballot-actor-state-lock.sql';
import actorStateInsert from './classification-ballot-actor-state-insert.sql';
import actorStateLifecycle from './classification-ballot-actor-state-lifecycle.sql';
import cleanupPage from './classification-ballot-cleanup-page.sql';
import cleanupUpdate from './classification-ballot-cleanup-update.sql';
import cleanupDone from './classification-ballot-actor-state-cleanup-done.sql';
import contributionLock from './classification-ballot-contribution-lock.sql';
import contributionUpsert from './classification-ballot-contribution-upsert.sql';
import aggregateLock from './classification-ballot-aggregate-lock.sql';
import aggregateUpsert from './classification-ballot-aggregate-upsert.sql';

const SUSPENDED = 'com.rezics.access.account.suspended.v1';
const REINSTATED = 'com.rezics.access.account.reinstated.v1';
const TOMBSTONED = 'com.rezics.access.account-tombstoned.v1';
const ACTOR_LIFECYCLE = new Set([SUSPENDED, REINSTATED, TOMBSTONED]);
const PAGE_SIZE = 50;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const CONSUMER = 'rating_classification_ballot';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ContributionState = Readonly<{
  assessment: Assessment | null;
  falsePositive: boolean;
  eligible: boolean;
}>;
type CountDelta = Readonly<{ support: number; oppose: number; falsePositive: number }>;
type ContributionRow = ContributionState & {
  bindingHash: Buffer;
  revision: string;
  sourceEpoch: number;
  sourcePosition: string;
};
type ActorState = { eligible: boolean; generation: string; tombstoned: boolean; cleanup_pending: boolean };

export function classificationBallotCountDelta(
  previous: ContributionState | null,
  next: ContributionState,
): CountDelta {
  const counted = (value: ContributionState | null): CountDelta => {
    if (!value?.eligible || value.assessment === null)
      return { support: 0, oppose: 0, falsePositive: 0 };
    return {
      support: value.assessment === 'support' ? 1 : 0,
      oppose: value.assessment === 'oppose' ? 1 : 0,
      falsePositive: value.falsePositive ? 1 : 0,
    };
  };
  const before = counted(previous);
  const after = counted(next);
  return {
    support: after.support - before.support,
    oppose: after.oppose - before.oppose,
    falsePositive: after.falsePositive - before.falsePositive,
  };
}

export function classificationBallotEnvelopeIsNewer(
  previous: Pick<ContributionRow, 'revision' | 'sourceEpoch' | 'sourcePosition'> | null,
  next: { revision: string; epoch: number; position: bigint },
): boolean {
  if (!previous) return true;
  const order = next.epoch - previous.sourceEpoch || (next.position > BigInt(previous.sourcePosition) ? 1 : -1);
  return order > 0 && BigInt(next.revision) > BigInt(previous.revision);
}

function routeOfRequired(id: string): number {
  const route = routeOf(id);
  if (route === null || !UUID.test(id)) throw new TypeError('Invalid classification ballot event identity');
  return route;
}

function receiptKey(event: CloudEvent, envelope: Envelope): string {
  return createHash('sha256')
    .update(canonicalize([event.source, event.id, envelope.epoch, envelope.position.toString()])!)
    .digest('hex');
}

function receiptDigest(event: CloudEvent, envelope: Envelope): Buffer {
  return createHash('sha256')
    .update(canonicalize([event.type, event.subject ?? null, event.data, envelope.epoch, envelope.position.toString()])!)
    .digest();
}

function validateEnvelope(envelope: Envelope): void {
  if (!Number.isInteger(envelope.partition) || envelope.partition < 0 || envelope.partition > 4095 ||
      !Number.isInteger(envelope.epoch) || envelope.epoch < 1 || envelope.position < 1n)
    throw new TypeError('Invalid classification ballot source envelope');
}

function validateEventAddress(event: CloudEvent, envelope: Envelope): void {
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  if (!source || Number(source[1]) !== envelope.partition || Number(source[2]) !== envelope.epoch)
    throw new TypeError('Classification ballot event source does not match its envelope');
}

async function ensureActorState(tx: Parameters<typeof actorStateRead.run>[0], actorId: string): Promise<ActorState> {
  const route = routeOfRequired(actorId);
  let state = (await actorStateRead.run(tx, { route, actor_id: actorId })) as ActorState | null;
  if (!state) {
    await actorStateInsert.run(tx, { route, actor_id: actorId });
    state = (await actorStateRead.run(tx, { route, actor_id: actorId })) as ActorState | null;
  }
  if (!state) throw new Error('Could not initialize classification ballot actor state');
  return state;
}

async function applyLifecycle(pool: Pool, event: CloudEvent, envelope: Envelope, clock?: () => Date) {
  const type = event.type;
  if (!ACTOR_LIFECYCLE.has(type)) return;
  const schema = ACCESS_EVENTS[type as keyof typeof ACCESS_EVENTS];
  if (!schema || !Value.Check(schema, event.data)) throw new TypeError('Invalid account lifecycle event');
  const accountId = (event.data as { accountId: string }).accountId;
  const route = routeOfRequired(accountId);
  if (event.subject !== accountId || partitionOf(route) !== envelope.partition)
    throw new TypeError('Account lifecycle event has an invalid classification ballot home');
  await runCommand(
    pool,
    {
      partition: envelope.partition,
      ...(clock ? { clock } : {}),
      receipt: {
        actorAccountId: accountId,
        kind: 'rating.classification-ballot.lifecycle',
        key: receiptKey(event, envelope),
        digest: receiptDigest(event, envelope),
      },
    },
    async (tx) => {
      const state = await actorStateLifecycle.run(tx, {
        route,
        actor_id: accountId,
        eligible: type === REINSTATED,
        tombstoned: type === TOMBSTONED,
        source_epoch: envelope.epoch,
        source_position: envelope.position.toString(),
      });
      if (!state) return noEffect(null);
      return {
        value: null,
        events: [
          {
            type: CLASSIFICATION_BALLOT_CLEANUP,
            subject: accountId,
            data: { actorId: accountId, generation: String(state.generation) },
          },
        ],
      };
    },
  );
}

async function applyCleanup(pool: Pool, event: CloudEvent, envelope: Envelope, clock?: () => Date) {
  if (event.type !== CLASSIFICATION_BALLOT_CLEANUP || !Value.Check(RATING_EVENTS[CLASSIFICATION_BALLOT_CLEANUP], event.data))
    throw new TypeError('Invalid classification ballot cleanup event');
  const data = event.data as { actorId: string; generation: string };
  const route = routeOfRequired(data.actorId);
  if (event.subject !== data.actorId || partitionOf(route) !== envelope.partition || BigInt(data.generation) > MAX_BIGINT)
    throw new TypeError('Classification ballot cleanup has an invalid actor home');
  await runCommand(
    pool,
    {
      partition: envelope.partition,
      ...(clock ? { clock } : {}),
      receipt: {
        actorAccountId: data.actorId,
        kind: 'rating.classification-ballot.cleanup',
        key: receiptKey(event, envelope),
        digest: receiptDigest(event, envelope),
      },
    },
    async (tx) => {
      const state = await ensureActorState(tx, data.actorId);
      if (state.generation !== data.generation || !state.cleanup_pending) return noEffect(null);
      const page = (await cleanupPage.run(tx, {
        route,
        actor_id: data.actorId,
        generation: data.generation,
      })) as Array<{
        subjectId: string;
        associationId: string;
        bindingHash: Buffer;
        assessment: Assessment;
        falsePositive: boolean;
      }>;
      const selected = page.slice(0, PAGE_SIZE);
      const changed = selected.length
        ? await cleanupUpdate.run(tx, {
            route,
            actor_id: data.actorId,
            generation: data.generation,
            eligible: state.eligible,
            subject_ids: selected.map(({ subjectId }) => subjectId),
            association_ids: selected.map(({ associationId }) => associationId),
          })
        : [];
      const events: CommandEvent[] = changed.map((row) => ({
        type: CLASSIFICATION_BALLOT_CHANGED,
        subject: String(row.subjectId),
        data: {
          actorId: data.actorId,
          subjectId: String(row.subjectId),
          associationId: String(row.associationId),
          bindingHash: Buffer.from(row.bindingHash as Uint8Array).toString('hex'),
          assessment: row.assessment as Assessment,
          falsePositive: Boolean(row.falsePositive),
          revision: String(row.revision),
          eligibilityGeneration: data.generation,
          eligible: state.eligible,
        },
      }));
      if (page.length > PAGE_SIZE) {
        events.push({
          type: CLASSIFICATION_BALLOT_CLEANUP,
          subject: data.actorId,
          data: { actorId: data.actorId, generation: data.generation },
        });
      } else {
        await cleanupDone.run(tx, { route, actor_id: data.actorId, generation: data.generation });
      }
      return { value: null, events };
    },
  );
}

async function applyChanged(pool: Pool, event: CloudEvent, envelope: Envelope, clock?: () => Date) {
  if (event.type !== CLASSIFICATION_BALLOT_CHANGED || !Value.Check(RATING_EVENTS[CLASSIFICATION_BALLOT_CHANGED], event.data))
    throw new TypeError('Invalid classification ballot event');
  const data = event.data as {
    actorId: string;
    subjectId: string;
    associationId: string;
    bindingHash: string;
    assessment: Assessment | null;
    falsePositive: boolean;
    revision: string;
    eligibilityGeneration: string;
    eligible: boolean;
  };
  const actorRoute = routeOfRequired(data.actorId);
  const subjectRoute = routeOfRequired(data.subjectId);
  if (
    event.subject !== data.subjectId ||
    routeOfRequired(data.associationId) !== subjectRoute ||
    partitionOf(actorRoute) !== envelope.partition ||
    BigInt(data.revision) > MAX_BIGINT ||
    BigInt(data.eligibilityGeneration) > MAX_BIGINT
  )
    throw new TypeError('Classification ballot event has an invalid projection address');
  const bindingHash = Buffer.from(data.bindingHash, 'hex');
  const next = { assessment: data.assessment, falsePositive: data.falsePositive, eligible: data.eligible };
  await runCommand(
    pool,
    {
      partition: partitionOf(subjectRoute),
      ...(clock ? { clock } : {}),
      receipt: {
        actorAccountId: data.actorId,
        kind: 'rating.classification-ballot.project',
        key: receiptKey(event, envelope),
        digest: receiptDigest(event, envelope),
      },
    },
    async (tx, context) => {
      const address = {
        route: subjectRoute,
        subject_id: data.subjectId,
        association_id: data.associationId,
        actor_route: actorRoute,
        actor_id: data.actorId,
      };
      const previous = (await contributionLock.run(tx, address)) as ContributionRow | null;
      if (!classificationBallotEnvelopeIsNewer(previous, { revision: data.revision, epoch: envelope.epoch, position: envelope.position }))
        return noEffect(null);
      if (previous && !Buffer.from(previous.bindingHash).equals(bindingHash)) return noEffect(null);

      const aggregateAddress = {
        route: subjectRoute,
        subject_id: data.subjectId,
        association_id: data.associationId,
        binding_hash: bindingHash,
      };
      const aggregate = (await aggregateLock.run(tx, aggregateAddress)) as {
        supportCount: number;
        opposeCount: number;
        falsePositiveCount: number;
        generation: string;
      } | null;
      const delta = classificationBallotCountDelta(previous, next);
      if (!aggregate && previous?.eligible && previous.assessment !== null)
        throw new Error('Classification ballot aggregate is missing a retained contribution');
      const supportCount = (aggregate?.supportCount ?? 0) + delta.support;
      const opposeCount = (aggregate?.opposeCount ?? 0) + delta.oppose;
      const falsePositiveCount = (aggregate?.falsePositiveCount ?? 0) + delta.falsePositive;
      if (supportCount < 0 || opposeCount < 0 || falsePositiveCount < 0)
        throw new Error('Classification ballot aggregate contribution would become negative');
      await contributionUpsert.run(tx, {
        ...address,
        binding_hash: bindingHash,
        assessment: data.assessment,
        false_positive: data.falsePositive,
        revision: data.revision,
        source_epoch: envelope.epoch,
        source_position: envelope.position.toString(),
        eligibility_generation: data.eligibilityGeneration,
        eligible: data.eligible,
      });
      const totalsChanged = delta.support !== 0 || delta.oppose !== 0 || delta.falsePositive !== 0;
      if (!totalsChanged) return { value: null, events: [] };
      const generation = BigInt(aggregate?.generation ?? '0') + 1n;
      if (generation > MAX_BIGINT) throw new Error('Classification ballot aggregate generation exhausted');
      const asOf = authoritativeTimeValue(currentCommand(tx).time);
      await aggregateUpsert.run(tx, {
        ...aggregateAddress,
        support_count: supportCount,
        oppose_count: opposeCount,
        false_positive_count: falsePositiveCount,
        generation: generation.toString(),
        as_of: asOf,
      });
      return {
        value: null,
        events: [
          {
            type: CLASSIFICATION_AGGREGATE_CHANGED,
            subject: data.subjectId,
            data: { subjectId: data.subjectId, associationId: data.associationId, generation: generation.toString(), asOf },
          },
        ],
      };
    },
  );
}

async function applyEnvelope(pool: Pool, envelope: Envelope, clock?: () => Date): Promise<void> {
  validateEnvelope(envelope);
  for (const event of envelope.events) {
    validateEventAddress(event, envelope);
    if (ACTOR_LIFECYCLE.has(event.type)) await applyLifecycle(pool, event, envelope, clock);
    else if (event.type === CLASSIFICATION_BALLOT_CHANGED) await applyChanged(pool, event, envelope, clock);
    else if (event.type === CLASSIFICATION_BALLOT_CLEANUP) await applyCleanup(pool, event, envelope, clock);
  }
}

export function createClassificationBallotRelay(pool: Pool, clock?: () => Date): Relay {
  return {
    consumer: CONSUMER,
    run(partition) {
      return projectBatch(pool, {
        consumer: CONSUMER,
        partition,
        apply: async (envelopes) => {
          for (const envelope of envelopes) await applyEnvelope(pool, envelope, clock);
        },
      });
    },
  };
}
