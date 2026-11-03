import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { noEffect, principalCommandIdentity, runCommand, type CommandAuthorization } from '../command/command.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { readFences, type SourceFence, type SourceFenceTuple } from '../content/source-fences.ts';
import {
  MAX_SOURCE_CLASSIFICATION_BATCH, SOURCE_CLASSIFICATION_CHANGED,
  classificationAssociationKey, classificationDigest, classificationObservation,
  validateClassificationObservation, validateClassificationClear,
  type ClassificationAssociation, type ClassificationPayload, type ClassificationObservation,
  type ClassificationClear, type ImmutableClassificationObservation,
  type SourceClassificationFigure, type SourceClassificationRead,
} from './source-classification-contract.ts';
import {
  createClassificationAssociationReader, type ClassificationAssociationResolution,
} from './source-classification-semantic.ts';
import lockSubject from './source-provider-lock.sql';
import { lockClassificationHead, readClassificationHeads, saveClassificationHead } from './source-classification-store.ts';

/** Reuses the existing bulk/governance authority. It grants no native ballot or public fence access. */
export const SOURCE_CLASSIFICATION_WRITE_ACTION = 'source_statistic:write';
const root = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });
export type SourceClassificationConfig = {
  pool: Pool; access: Access; routeKey: Uint8Array; clock?: KernelClock;
};
type CommonCommand = {
  actor: Actor; association: ClassificationAssociation; expectedObservation: string | null;
  idempotencyKey: string; deadline: number;
};
export type PutSourceClassification = CommonCommand & { value: ClassificationObservation };
export type ClearSourceClassification = CommonCommand & { value: ClassificationClear };
export type ReadSourceClassificationBatch = {
  actor: Actor; subjectId: string; associations: readonly ClassificationAssociation[];
  limit: number; deadline: number;
};
export type SourceClassificationMutation = { observationDigest: string; state: 'published' | 'cleared' };

/** An identical immutable payload is already satisfied. Every other change requires
 * explicit CAS; even correct CAS cannot let an older observation replace a tombstone.
 */
export function admitClassificationObservation(
  next: ImmutableClassificationObservation, current: ImmutableClassificationObservation | null,
  expectedObservation: string | null,
): 'identical' | 'changed' {
  if (current?.digest === next.digest) return 'identical';
  if (expectedObservation !== (current?.digest ?? null)) throw new ProblemError('conflict');
  if (current && next.payload.asOf < current.payload.asOf) throw new ProblemError('conflict');
  return 'changed';
}
function available(value: ClassificationAssociationResolution | undefined) {
  return value?.state === 'available' ? value.evidence : null;
}
function provenanceMatches(resolution: ClassificationAssociationResolution | undefined, value: ClassificationPayload) {
  const evidence = available(resolution);
  if (!evidence) return false;
  return !evidence.source || (evidence.source.source === value.sourceAlias &&
    evidence.source.external_id === value.sourceRecordId && evidence.source.field_group === 'facts');
}
function sameFence(a: SourceFence | undefined, b: SourceFence | undefined) {
  return !!a && !!b && !a.takenDown && !b.takenDown && a.securityRevision === b.securityRevision;
}
function tupleKey(tuple: SourceFenceTuple) {
  return JSON.stringify([tuple.route, tuple.source, tuple.external_id, tuple.field_group]);
}
function toFigure(
  association: ClassificationAssociation, observation: ImmutableClassificationObservation, now: Date,
): SourceClassificationFigure | null {
  const payload = observation.payload;
  if ('cleared' in payload) return null;
  return {
    provider: 'vndb', association,
    observation: { digest: observation.digest, sourceVersion: payload.sourceVersion },
    sourceAlias: payload.sourceAlias, sourceRecordId: payload.sourceRecordId,
    sourceAssociationId: payload.sourceAssociationId,
    confidence: payload.confidence === undefined ? { state: 'unavailable', reason: 'not_supplied' }
      : { state: 'available', value: payload.confidence, unit: 'vndb-tag-rating', minExclusive: 0, max: 3 },
    lie: payload.lie === undefined ? { state: 'unavailable', reason: 'not_supplied' }
      : { state: 'available', value: payload.lie, unit: 'boolean' },
    ...(payload.confidenceCount === undefined ? {} : { confidenceCount: payload.confidenceCount }),
    ...(payload.lieCount === undefined ? {} : { lieCount: payload.lieCount }),
    asOf: payload.asOf, ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(payload.asOf)) / 1000)),
    attribution: payload.attribution, licence: payload.licence,
  };
}

/** The producer consumes admitted aggregate observations. It never fetches a provider,
 * creates an external voter, or reads/writes native ballot or enjoyment tables.
 */
export function createSourceClassificationProducer(config: SourceClassificationConfig) {
  const observe = createClassificationAssociationReader(config);
  function tuple(payload: ClassificationPayload): SourceFenceTuple {
    return {
      route: tupleRoute(config.routeKey, payload.sourceAlias, payload.sourceRecordId),
      source: payload.sourceAlias, external_id: payload.sourceRecordId, field_group: 'facts',
    };
  }
  async function fences(tuples: readonly SourceFenceTuple[], deadline: number) {
    const groups = new Map<number, Map<string, SourceFenceTuple>>();
    for (const value of tuples) {
      const partition = partitionOf(value.route);
      const group = groups.get(partition) ?? new Map<string, SourceFenceTuple>();
      group.set(tupleKey(value), value); groups.set(partition, group);
    }
    const result = new Map<string, SourceFence>();
    for (const [partition, group] of groups) {
      const rows = await withReadTransaction(config.pool, async (client) => {
        await partitionReadClient(client, partition);
        return readFences(client, [...group.values()]);
      }, deadline);
      for (const fence of rows) result.set(tupleKey(fence), fence);
    }
    return result;
  }
  async function heads(subjectId: string, keys: string[], deadline: number) {
    const route = routeOf(subjectId);
    if (route === null) throw new ProblemError('not_found');
    return withReadTransaction(config.pool, async (client) => {
      await partitionReadClient(client, partitionOf(route));
      return readClassificationHeads(client, route, subjectId, keys);
    }, deadline);
  }
  async function readBatch(input: ReadSourceClassificationBatch): Promise<readonly SourceClassificationRead[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SOURCE_CLASSIFICATION_BATCH ||
      input.associations.length > input.limit) throw new RangeError('Invalid supplied-association batch limit');
    const associations = input.associations.map((a) => {
      classificationAssociationKey(a);
      if (a.subjectId !== input.subjectId) throw new TypeError('Association belongs to another Subject');
      return { ...a };
    });
    if (!associations.length) return [];
    return within(input.deadline, async () => {
      const keys = associations.map(classificationAssociationKey);
      const before = await observe(input.actor, associations, input.deadline);
      // Denied/unknown keys are never used to probe a retained observation slot.
      const permitted = [...new Set(keys.filter((key) => available(before.get(key))))];
      const first = await heads(input.subjectId, permitted, input.deadline);
      const tuples = [...first.values()].flatMap((head) => 'cleared' in head.payload ? [] : [tuple(head.payload)]);
      const fenceBefore = await fences(tuples, input.deadline);
      const now = config.clock?.() ?? new Date();
      const figures = associations.map((a, index) => {
        const head = first.get(keys[index]!);
        return head ? toFigure(a, head, now) : null;
      });
      const after = await observe(input.actor, associations, input.deadline);
      const last = await heads(input.subjectId, permitted, input.deadline);
      const fenceAfter = await fences(tuples, input.deadline);
      return keys.map((key, index): SourceClassificationRead => {
        const start = before.get(key), end = after.get(key);
        if (start?.state !== 'available') return start ?? { state: 'unavailable', reason: 'authority_unavailable' };
        if (end?.state !== 'available') return end ?? { state: 'unavailable', reason: 'authority_unavailable' };
        if (start.evidence.stamp !== end.evidence.stamp) return { state: 'unavailable', reason: 'changed' };
        const head = first.get(key);
        if (!head || 'cleared' in head.payload) return { state: 'unavailable', reason: 'not_observed' };
        if (head.digest !== last.get(key)?.digest) return { state: 'unavailable', reason: 'changed' };
        if (!provenanceMatches(start, head.payload) || !provenanceMatches(end, head.payload))
          return { state: 'unavailable', reason: 'provenance_unavailable' };
        const fenceKey = tupleKey(tuple(head.payload));
        if (!sameFence(fenceBefore.get(fenceKey), fenceAfter.get(fenceKey)))
          return { state: 'unavailable', reason: 'not_found' };
        return { state: 'available', value: figures[index]! };
      });
    });
  }
  async function readExact(input: Omit<ReadSourceClassificationBatch, 'associations' | 'limit'> & {
    association: ClassificationAssociation;
  }): Promise<SourceClassificationRead> {
    return (await readBatch({ ...input, associations: [input.association], limit: 1 }))[0]!;
  }
  async function mutate(input: CommonCommand & { value: ClassificationPayload }) {
    if (input.actor.kind !== 'account') throw new GrantDeniedError();
    if (input.expectedObservation !== null && !/^[0-9a-f]{64}$/.test(input.expectedObservation))
      throw new TypeError('Explicit expectedObservation digest or null is required');
    const association = { ...input.association };
    const key = classificationAssociationKey(association);
    const next = classificationObservation(association, input.value);
    const cleared = 'cleared' in next.payload;
    const route = routeOf(association.subjectId);
    if (route === null || routeOf(association.candidateId) !== route) throw new ProblemError('not_found');
    const writer = await accessCommandAuthorization(config.access, input.actor,
      SOURCE_CLASSIFICATION_WRITE_ACTION, root, { pool: config.pool, deadline: input.deadline },
      () => new GrantDeniedError());
    // Core calls prepare without a target checkout, then authorize before every receipt lookup,
    // including uncertain retries and exact replays. No foreign checkout is held by the command.
    const authorization: CommandAuthorization = {
      action: writer.action, resource: writer.resource, denied: writer.denied,
      async prepare(attempt) {
        const writerEvidence = await writer.prepare?.(attempt);
        if (cleared) return { writerEvidence };
        const semantic = (await observe(input.actor, [association], input.deadline)).get(key);
        const fence = (await fences([tuple(next.payload)], input.deadline)).get(tupleKey(tuple(next.payload)));
        return { writerEvidence, semantic, fence };
      },
      async authorize(tx, attempt, evidence) {
        const prepared = evidence as { writerEvidence: unknown; semantic?: ClassificationAssociationResolution; fence?: SourceFence };
        const mode = await writer.authorize(tx, attempt, prepared.writerEvidence);
        if (!cleared && (!provenanceMatches(prepared.semantic, next.payload) || !prepared.fence || prepared.fence.takenDown))
          throw new ProblemError('not_found');
        return mode;
      },
      async finalize(tx, attempt, evidence) {
        const prepared = evidence as { writerEvidence: unknown };
        await writer.finalize?.(tx, attempt, prepared.writerEvidence);
      },
    };
    return runCommand(config.pool, {
      ...principalCommandIdentity(input.actor), partition: partitionOf(route), deadline: input.deadline,
      ...(config.clock ? { clock: config.clock } : {}), authorization,
      receipt: {
        kind: cleared ? 'rating.source_classification.clear' : 'rating.source_classification.put',
        key: input.idempotencyKey,
        digest: Buffer.from(classificationDigest([association, next.payload, input.expectedObservation]), 'hex'),
      },
    }, async (tx, command) => {
      if (!(await lockSubject.run(tx, { route, subject_id: association.subjectId }))) throw new ProblemError('not_found');
      const address = { route, subjectId: association.subjectId, key };
      const current = await lockClassificationHead(tx, address);
      const value: SourceClassificationMutation = { observationDigest: next.digest, state: cleared ? 'cleared' : 'published' };
      if (admitClassificationObservation(next, current, input.expectedObservation) === 'identical') return noEffect(value);
      // A retained clear cannot silently rebind an existing slot to an unrelated source record.
      if (cleared && current && (current.payload.sourceAlias !== next.payload.sourceAlias ||
        current.payload.sourceRecordId !== next.payload.sourceRecordId ||
        current.payload.sourceAssociationId !== next.payload.sourceAssociationId)) throw new ProblemError('conflict');
      await saveClassificationHead(tx, address, association, next, command.transactionId);
      return { value, events: [{ type: SOURCE_CLASSIFICATION_CHANGED, subject: association.subjectId,
        data: { subjectId: association.subjectId, associationKey: key, observationDigest: next.digest,
          state: value.state } }] };
    });
  }
  async function put(input: PutSourceClassification) {
    validateClassificationObservation(input.value);
    const outcome = await mutate(input);
    const read = await readExact({ actor: input.actor, subjectId: input.association.subjectId,
      association: input.association, deadline: input.deadline });
    if (read.state !== 'available' || read.value.observation.digest !== outcome.value.observationDigest)
      throw new ProblemError('not_found', { effectStatus: 'not_applicable' });
    return { ...outcome, value: { ...outcome.value, figure: read.value } };
  }
  async function clear(input: ClearSourceClassification) {
    validateClassificationClear(input.value);
    // Deliberately no public Semantic/fence read: current writer authority can clear a retained slot
    // after retraction, concealment or takedown. The exact association and CAS still apply.
    return mutate(input);
  }
  return { put, clear, readExact, readBatch };
}
export type SourceClassificationProducer = ReturnType<typeof createSourceClassificationProducer>;
