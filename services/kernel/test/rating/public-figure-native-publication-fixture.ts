import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { Account } from '../../../../specs/community-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import {
  capturePublicFigurePriorInputs,
  markPublicFigurePriorPage,
  readPublicFigures,
  type SubjectPriorInput,
} from '../../src/rating/public-figure.ts';
import { createPublicRatingSource } from '../../src/rating/public-rating-source.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { contentGovernanceCredential } from '../content/support/system.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

export const PUBLICATION_GROWTH_SCALES = [8, 32, 128] as const;
export const votePath = (subjectId: string, questionId = STANDARD_QUESTION_ID) =>
  `/v1/subjects/${subjectId}/ratings/${questionId}/vote`;
export const aggregatePath = (subjectId: string, populationId = GLOBAL_CONTEXT.id, questionId = STANDARD_QUESTION_ID) =>
  `/v1/subjects/${subjectId}/ratings?question=${questionId}&population=${populationId}`;

export async function body(response: Response, status = 200): Promise<any> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`HTTP ${response.status}, expected ${status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export type NativeVote = Readonly<{
  subjectId: string;
  voter: Account;
  units: number | null;
  revision: number;
  key: string;
  value: unknown;
  session: string;
  partition: number;
  epoch: number;
  position: string;
  eventSeq: number;
}>;

export type NativePublicationFixture = Awaited<ReturnType<typeof createNativePublicationFixture>>;

/** Reuse native Auth's owner and the existing isolated, fully composed Kernel worker.
 * The companion fixture owns their shutdown; this module never launches DBOS in Auth's process.
 * Only real HTTP commands produce votes, totals, priors, membership history and figures.
 */
export async function createNativePublicationFixture() {
  const base = await createFigureFixture({ subjects: 12, partitions: 1, deferMembership: true });
  let work: WorkClient | undefined;
  try {
    const { system } = communityFixtureRuntime();
    const governanceCredential = await contentGovernanceCredential(system);
    const governance: Account = {
      id: governanceCredential.actor.accountId,
      bearer: governanceCredential.bearer,
    };
    const owner: Account = { id: system.actors.author.actor.accountId, bearer: system.actors.author.bearer };
    const reader: Account = { id: system.actors.other.actor.accountId, bearer: system.actors.other.bearer };
    const database = base.database;
    work = await createWorkClient(database.url, database.pool);
    // All foreground API reads use the harness's instrumented pool, including production Access.
    const app = createKernel({
      pool: database.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      requestDeadlineMs: 30_000,
      access: system.access,
      workClient: work,
      writeRate: createWriteRateLimiter({
        secret: `${randomUUID()}${randomUUID()}`,
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
      }),
      ratePeer: () => '127.0.0.1',
    });
    const request = async (
      method: string,
      path: string,
      options: { actor?: Account | null; bearer?: string; key?: string; body?: unknown; headers?: HeadersInit } = {},
    ) => {
      const actor = options.actor ?? null;
      if (actor && options.bearer === undefined && (decodeJwt(actor.bearer).exp ?? 0) * 1000 <= Date.now() + 30_000) {
        actor.bearer = (
          await system.auth.issue({
            accountId: actor.id,
            clientId: system.auth.ordinaryClient.id,
            scopes: system.auth.ordinaryScopes,
          })
        ).bearer;
      }
      const headers = new Headers(options.headers);
      if (options.bearer !== undefined || actor)
        headers.set('authorization', `Bearer ${options.bearer ?? actor!.bearer}`);
      if (options.key !== undefined) headers.set('idempotency-key', JSON.stringify(options.key));
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      return app.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
    };
    const command = async (method: string, path: string, actor: Account, value?: unknown, status = 200) =>
      body(
        await request(method, path, {
          actor,
          key: randomUUID(),
          ...(value === undefined ? {} : { body: value }),
        }),
        status,
      );

    const vote = async (subjectId: string, voter: Account, units: number | null): Promise<NativeVote> => {
      const key = randomUUID();
      const response = await request(units === null ? 'DELETE' : 'PUT', votePath(subjectId), {
        actor: voter,
        key,
        ...(units === null ? {} : { body: { units } }),
      });
      const session = response.headers.get(SESSION_HEADER);
      const value = await body(response, units === null ? 204 : 200);
      expect(session).toBeString();
      const receipts = await database.admin.query<{ partition_no: number; epoch: number; position: string }>(
        `SELECT partition_no, epoch, position::text FROM core.receipt
         WHERE partition_no = $1 AND principal_kind = 'account' AND principal_id = $2
           AND command_kind = 'rating.vote.put' AND idempotency_key = $3`,
        [partitionOf(routeOf(voter.id)!), voter.id, key],
      );
      expect(receipts.rows).toHaveLength(1);
      const receipt = receipts.rows[0]!;
      const components = decodeSession(system.tokenKeys, `account:${voter.id}`, session!);
      expect(components).toContainEqual({
        partition: receipt.partition_no,
        epoch: receipt.epoch,
        position: BigInt(receipt.position),
      });
      const events = await database.admin.query<{
        event_seq: number;
        data: { revision: number; units: number | null };
      }>(
        `SELECT event_seq, data FROM core.outbox WHERE partition_no = $1 AND epoch = $2 AND position = $3
           AND type = 'com.rezics.rating.vote.changed.v1'`,
        [receipt.partition_no, receipt.epoch, receipt.position],
      );
      expect(events.rows).toHaveLength(1);
      const event = events.rows[0]!;
      expect(event.data).toMatchObject({
        voterId: voter.id,
        questionId: STANDARD_QUESTION_ID,
        targetId: subjectId,
        units,
      });
      if (units !== null) expect(value).toMatchObject({ units, revision: event.data.revision });
      return {
        subjectId,
        voter,
        units,
        key,
        value,
        session: session!,
        revision: event.data.revision,
        partition: receipt.partition_no,
        epoch: receipt.epoch,
        position: receipt.position,
        eventSeq: event.event_seq,
      };
    };

    const workerSuccess = async (
      partition: number,
      epoch: number,
      position: string,
      eventSeq: number,
      name: string,
    ) => {
      const id = `fx:${epoch}:${partition}:${position}:${eventSeq}:${name}`;
      const result = await database.admin.query<{ status: string }>(
        'SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1',
        [id],
      );
      expect(result.rows, `Actual worker completion for ${id}`).toEqual([{ status: 'SUCCESS' }]);
    };

    const applied = async (nativeVote: NativeVote) => {
      await base.drain();
      await workerSuccess(
        nativeVote.partition,
        nativeVote.epoch,
        nativeVote.position,
        nativeVote.eventSeq,
        'rating_aggregate',
      );
      const result = await database.admin.query<{ units: number | null; revision: number }>(
        `SELECT units, revision FROM rating.population_vote
         WHERE route = $1 AND question_id = $2 AND population_id = $3 AND target_id = $4 AND voter_id = $5`,
        [
          routeOf(nativeVote.subjectId),
          STANDARD_QUESTION_ID,
          GLOBAL_CONTEXT.id,
          nativeVote.subjectId,
          nativeVote.voter.id,
        ],
      );
      expect(result.rows).toEqual([{ units: nativeVote.units, revision: nativeVote.revision }]);
    };

    const current = async (subjectId: string, populationId = GLOBAL_CONTEXT.id) => {
      await base.drain();
      const result = await readPublicFigures(database.pool, {
        partition: partitionOf(routeOf(subjectId)!),
        questionId: STANDARD_QUESTION_ID,
        populationId,
        subjectIds: [subjectId],
      });
      expect(result).toHaveLength(1);
      const figure = result[0]!;
      const physical = await database.admin.query<{
        pending_position: string | null;
        pending_prior_generation: string | null;
        published_prior_generation: string;
      }>(
        `SELECT pending_position::text, pending_prior_generation::text, published_prior_generation::text
         FROM rating.public_figure WHERE route = $1 AND question_id = $2 AND population_id = $3 AND subject_id = $4`,
        [routeOf(subjectId), STANDARD_QUESTION_ID, populationId, subjectId],
      );
      expect(physical.rows).toHaveLength(1);
      expect(physical.rows[0]!).toMatchObject({ pending_position: null, pending_prior_generation: null });
      // The exact published source coordinate must have a real successful figure consumer, not just an enqueue.
      const source = await database.admin.query<{ epoch: number; event_seq: number }>(
        `SELECT epoch, event_seq FROM core.outbox WHERE partition_no = $1 AND position = $2
           AND type IN ('com.rezics.rating.aggregate.applied.v1', 'com.rezics.rating.prior_epoch.work.v1')`,
        [partitionOf(routeOf(subjectId)!), figure.position],
      );
      expect(source.rows).toHaveLength(1);
      await workerSuccess(
        partitionOf(routeOf(subjectId)!),
        source.rows[0]!.epoch,
        figure.position,
        source.rows[0]!.event_seq,
        'rating_public_figure',
      );
      const events = await database.admin.query<{ data: unknown }>(
        `SELECT data FROM core.outbox WHERE partition_no = $1
           AND type = 'com.rezics.rating.public_figure.changed.v1'
           AND data->>'subjectId' = $2 AND data->>'populationId' = $3 AND data->>'revision' = $4`,
        [partitionOf(routeOf(subjectId)!), subjectId, populationId, figure.revision],
      );
      expect(events.rows).toEqual([{ data: figure }]);
      if (figure.priorEpoch !== null) {
        const prior = await database.admin.query<{ generation: string; epoch: number; m: number; c: number }>(
          `SELECT generation::text, epoch, m::float8, c::integer FROM rating.population_prior_epoch
           WHERE route = $1 AND question_id = $2 AND population_id = $3 AND start_count IS NOT NULL`,
          [routeOf(populationId), STANDARD_QUESTION_ID, populationId],
        );
        expect(prior.rows).toHaveLength(1);
        expect(prior.rows[0]!).toMatchObject({ epoch: figure.priorEpoch, m: figure.m, c: figure.C });
        expect(BigInt(physical.rows[0]!.published_prior_generation)).toBeGreaterThanOrEqual(
          BigInt(prior.rows[0]!.generation),
        );
      }
      return figure;
    };

    const captureGlobalPrior = async () => {
      const [prior] = await capturePublicFigurePriorInputs(database.pool, [
        {
          questionId: STANDARD_QUESTION_ID,
          populationId: GLOBAL_CONTEXT.id,
        },
      ]);
      if (!prior) throw new Error('Global prior input capture is unavailable');
      return prior;
    };
    const redeliverGlobalPrior = async (subjectId: string, prior: SubjectPriorInput) => {
      // Delay only transport: replay the ordinary subject command with a real earlier owner capture.
      // Publication still runs through the worker's registered rating_public_figure effect.
      await markPublicFigurePriorPage(database.pool, {
        partition: partitionOf(routeOf(subjectId)!),
        subjectIds: [subjectId],
        prior,
        requiredGeneration: prior.generation,
      });
      await base.drain();
    };

    const createSubject = async (partition?: number): Promise<string> => {
      let key: string;
      do {
        key = randomUUID();
      } while (
        partition !== undefined &&
        partitionOf(subjectTarget(system.routeKey, governance.id, key).route) !== partition
      );
      const result = await body(
        await request('POST', '/v1/subjects', {
          actor: governance,
          key,
          body: { type: 'schema:Book', labels: { en: `Native figure ${randomUUID()}` } },
        }),
        201,
      );
      const id = result.subject.id as string;
      expect(routeOf(id)).not.toBeNull();
      if (partition !== undefined) expect(partitionOf(routeOf(id)!)).toBe(partition);
      return id;
    };

    const priorSubjects = base.subjectIds.slice(0, 10);
    const target = base.subjectIds[10]!;
    const privateTarget = base.subjectIds[11]!;
    const source = createPublicRatingSource(database.pool);
    const establishPrior = async (units = 4) => {
      expect(await source.epoch()).toEqual({
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        priorEpoch: null,
      });
      let counted = 0;
      for (const subjectId of priorSubjects) {
        for (const voter of base.realmMembers) {
          await applied(await vote(subjectId, voter, units));
          if (++counted === 49) {
            expect(await source.epoch()).toEqual({
              questionId: STANDARD_QUESTION_ID,
              populationId: GLOBAL_CONTEXT.id,
              priorEpoch: null,
            });
            const totals = await database.admin.query(
              `SELECT sum(count)::integer AS count, sum(sum)::integer AS sum FROM rating.population_total_component
               WHERE route = $1 AND question_id = $2 AND population_id = $3`,
              [routeOf(GLOBAL_CONTEXT.id), STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
            );
            expect(totals.rows).toEqual([{ count: 49, sum: 49 * units }]);
          }
        }
      }
      expect(await source.epoch()).toEqual({
        questionId: STANDARD_QUESTION_ID,
        populationId: GLOBAL_CONTEXT.id,
        priorEpoch: 1,
      });
      const prior = await database.admin.query(
        `SELECT start_count::integer, m::float8, c::integer, epoch FROM rating.population_prior_epoch
         WHERE route = $1 AND question_id = $2 AND population_id = $3`,
        [routeOf(GLOBAL_CONTEXT.id), STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
      );
      expect(prior.rows).toEqual([{ start_count: 50, m: units / 2, c: 5, epoch: 1 }]);
      for (const subjectId of priorSubjects)
        expect(await current(subjectId)).toMatchObject({
          count: 5,
          mean: units / 2,
          score: units / 2,
          m: units / 2,
          C: 5,
          priorEpoch: 1,
        });
    };

    const realm = (await body(await request('GET', `/v1/realms/${base.realmId}`, { actor: owner }))).realm;
    const createHistoricalPopulation = async (subjectId: string, voter: Account) => {
      const created = await command(
        'POST',
        '/v1/realms',
        owner,
        {
          spaceId: realm.spaceId,
          contextId: realm.contextId,
          title: `Native population ${randomUUID()}`,
          visibility: 'protected',
        },
        201,
      );
      const realmId: string = created.realm.realmId;
      await command('POST', `/v1/realms/${realmId}/members`, owner, { accountId: voter.id }, 202);
      await base.drain();
      expect(await body(await request('GET', `/v1/realms/${realmId}/members/me`, { actor: voter }))).toMatchObject({
        state: 'member',
      });
      expect(await current(subjectId, realmId)).toMatchObject({ count: 1, mean: null, score: null, priorEpoch: null });
      await command('DELETE', `/v1/realms/${realmId}/membership`, voter, undefined, 202);
      await base.drain();
      expect(await current(subjectId, realmId)).toMatchObject({ count: 0, mean: null, score: null, priorEpoch: null });
      return realmId;
    };

    return {
      database,
      app,
      owner,
      reader,
      governance,
      target,
      privateTarget,
      priorSubjects,
      source,
      realmId: base.realmId,
      members: base.realmMembers,
      outsiders: base.globalVoters,
      request,
      command,
      vote,
      applied,
      current,
      createSubject,
      captureGlobalPrior,
      redeliverGlobalPrior,
      establishPrior,
      createHistoricalPopulation,
      joinMembers: base.joinMembers,
      settle: base.drain,
      async close() {
        try {
          await work?.close();
        } finally {
          await base.close();
        }
      },
    };
  } catch (error) {
    try {
      await work?.close();
    } finally {
      await base.close();
    }
    throw error;
  }
}
