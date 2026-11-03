import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createInitiatorRestorer } from '../../../src/access/durable-initiator.ts';
import { createAccountsWorkModule } from '../../../src/access/membership-work.ts';
import { GLOBAL_CONTEXT } from '../../../src/access/gates/catalogue.ts';
import type { AccessRealmRoleReader } from '../../../src/request/access.ts';
import { createRealmMembership, readMembershipInitiator } from '../../../src/community/membership.ts';
import { communityWorkModule } from '../../../src/community/work.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER } from '../../../src/http/request.ts';
import { createRatingWorkModule } from '../../../src/rating/work-module.ts';
import { readAggregate } from '../../../src/rating/aggregate-effect.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../../src/semantic/subject.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createSuspensionCommands } from '../../../src/access/suspension.ts';
import { createReinstatementCommands } from '../../../src/access/reinstatement.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { effectsRelay } from '../../../src/events/effects.ts';
import type { RatingSegmentJob } from '../../../src/rating/segment-job.ts';
import { ratingSegmentWorkflowId } from '../../../src/rating/segment-job.ts';
import { createProductionAccess } from '../../community/membership-fixture.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';

const route = 0x3a19;
const actorScopes = ['subject:read', 'rating:vote', 'realm:join'];
const at = '2026-10-27T10:00:00.000Z';
const nilId = '00000000-0000-0000-0000-000000000000';
export const id = (ordinal: number) => `00000000-0000-7000-8000-3a19${ordinal.toString(16).padStart(8, '0')}`;
const voters = {
  segment: newId(route),
  segmentWarmup: newId(route),
  eligibility: newId(route),
  eligibilityWarmup: newId(route),
  empty: newId(route),
  owner: newId(route),
  history: newId(route),
};
const routeKey = new Uint8Array(32).fill(0x6b);
const sessionKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(0x6b)]]) };
const accessActions = [...actorScopes, 'account:suspend', 'account:reinstate'];

type TerminalKind = 'realm' | 'eligibility';
type PageObservation = { position: string; epoch: number; votes: unknown[]; direction: string };

export type TerminalGrowthFixture = {
  readonly database: GrowthDatabase;
  readonly realmId: string;
  readonly route: number;
  readonly partition: number;
  readonly globalPopulationId: string;
  readonly targetIds: readonly string[];
  readonly ids: typeof voters;
  readonly selectedNeighbourhood: (voterId: string) => Promise<{ memberships: number; populations: string[] }>;
  readonly registeredAggregateEffect: (position: string) => Promise<boolean>;
  addRealmMembership(voterId: string): Promise<PageObservation[]>;
  removeRealmMembership(voterId: string): Promise<PageObservation[]>;
  suspend(voterId: string): Promise<PageObservation[]>;
  reinstate(voterId: string): Promise<PageObservation[]>;
  replayFirstPage(
    voterId: string,
    pagePosition: string,
    populationId: string,
    targetId: string,
    before: unknown,
  ): Promise<void>;
  readAggregate(populationId: string, targetId: string): Promise<unknown>;
  latestPagePosition(voterId: string): Promise<bigint>;
  checkpoint(): Promise<bigint>;
  close(): Promise<void>;
};

async function seedRealm(database: GrowthDatabase, realmId: string, spaceId: string, ownerId: string): Promise<void> {
  const spaceRevisionId = newId(route);
  const realmRevisionId = newId(route);
  const transactionId = newId(route);
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
      [route, spaceId, spaceRevisionId, at, ownerId],
    );
    await client.query(
      `INSERT INTO community.space_revision
         (route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Terminal growth host', '', $4, $5)`,
      [route, spaceId, spaceRevisionId, at, ownerId],
    );
    await client.query(
      `INSERT INTO community.realm
         (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1, $2, $3, 'active', 'public', $4, $5, $6, $7)`,
      [route, realmId, spaceId, GLOBAL_CONTEXT.id, realmRevisionId, at, ownerId],
    );
    await client.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Terminal growth Realm', '', 'public', $4, $5, $6)`,
      [route, realmId, realmRevisionId, GLOBAL_CONTEXT.id, at, ownerId],
    );
    await client.query(
      `INSERT INTO access.resource_initialization
         (route, resource_id, resource_type, creator_id, initialized_at)
       VALUES ($1, $2, 'community.space', $3, $4), ($1, $5, 'community.realm', $3, $4)`,
      [route, spaceId, ownerId, at, realmId],
    );
    await client.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES
         ($1, $2, 'active_accounts', $3, '', 'community.realm.standing', '(,)', $4),
         ($1, $2, 'identity', $5, '', 'community.realm.owner', '(,)', $4)`,
      [route, realmId, nilId, transactionId, ownerId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await database.admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     SELECT $1, $2, account_id, 'realm:join', '(,)', account_id FROM access.account
     WHERE route = $1 AND account_id = ANY($3::uuid[])`,
    [route, realmId, Object.values(voters)],
  );
}

export async function openTerminalGrowthFixture(): Promise<TerminalGrowthFixture> {
  const database = await openGrowthDatabase();
  let runtime: Awaited<ReturnType<typeof composeWork>> | undefined;
  let workClient: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  try {
    await bootstrapRelease(database.pool, bundledRelease);
    await database.admin.query(
      `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
       SELECT $1, account_id, 'actor', 'active', account_id FROM unnest($2::uuid[]) AS account_id`,
      [route, Object.values(voters)],
    );
    const staffId = newId(0xfffe);
    await database.admin.query(
      `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'active', $2)`,
      [routeOf(staffId), staffId],
    );
    await database.admin.query(
      `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
       VALUES ($1, $2, $3, 'account:suspend', '(,)', $3),
              ($1, $2, $3, 'account:reinstate', '(,)', $3)`,
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, staffId],
    );
    await database.admin.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
      [newId(route)],
    );
    const realmId = newId(route);
    const spaceId = newId(route);
    await seedRealm(database, realmId, spaceId, voters.owner);

    let roleReader: AccessRealmRoleReader = async () => null;
    const production = await createProductionAccess({
      actions: accessActions,
      realmRoleReader: (client, input) => roleReader(client, input),
    });
    const membership = createRealmMembership({
      pool: database.pool,
      access: production.access,
      referenceKeys: sessionKeys,
      restorer: createInitiatorRestorer({
        pool: database.pool,
        access: production.access,
        readOperation: readMembershipInitiator,
        async readConsent({ actorAccountId, clientId }) {
          return { actorAccountId, clientId, scopes: actorScopes };
        },
      }),
    });
    roleReader = membership.roleReader;

    workClient = await createWorkClient(database.url, database.pool);
    const routeKeyText = Buffer.from(routeKey).toString('base64url');
    const env = {
      KERNEL_ROUTE_KEY: routeKeyText,
      KERNEL_SESSION_KEYS: `1:${Buffer.from(sessionKeys.keys.get(1)!).toString('base64url')}`,
    };
    runtime = await composeWork(
      [
        createAccountsWorkModule({ realm: membership, access: production.access, authorize: membership.authorize }),
        communityWorkModule,
        createRatingWorkModule(async () => '0'.repeat(64)),
      ],
      { databaseUrl: database.url, pool: database.pool, client: workClient, env, executorId: `rating-terminal-${randomUUID()}` },
    );
    await runtime.launch();

    const kernel = createKernel({
      pool: database.pool,
      routeKey,
      tokens: sessionKeys,
      access: production.access,
      workClient,
      writeRate: createWriteRateLimiter({
        secret: 'rating-segment-terminal-growth-write-rate-secret',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
      }),
      ratePeer: () => '127.0.0.1',
    });
    const relay = effectsRelay(database.pool, runtime.effects);
    const partition = route >>> 4;

    async function latestPagePosition(voterId: string): Promise<bigint> {
      const result = await database.admin.query<{ position: string }>(
        `SELECT coalesce(max(position), 0)::text AS position FROM core.outbox
         WHERE subject = $1 AND type = 'com.rezics.rating.segment.page.v1'`,
        [voterId],
      );
      return BigInt(result.rows[0]!.position);
    }

    async function checkpoint(): Promise<bigint> {
      const result = await database.admin.query<{ position: string }>(
        `SELECT position::text FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = 'effects'`,
        [partition],
      );
      return BigInt(result.rows[0]?.position ?? '0');
    }

    async function commandPosition(voterId: string, commandKind: string): Promise<bigint> {
      const result = await database.admin.query<{ position: string }>(
        `SELECT coalesce(max(position), 0)::text AS position FROM core.receipt
         WHERE partition_no = $1 AND principal_id = $2 AND command_kind = $3`,
        [partition, voterId, commandKind],
      );
      return BigInt(result.rows[0]!.position);
    }

    async function selectedNeighbourhood(voterId: string) {
      const [memberships, state] = await Promise.all([
        database.admin.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM rating.voter_realm
           WHERE route = $1 AND voter_id = $2 AND state <> 'uncounted'`,
          [route, voterId],
        ),
        database.admin.query<{ populations: string[] }>(
          `SELECT populations FROM rating.voter_state WHERE route = $1 AND voter_id = $2`,
          [route, voterId],
        ),
      ]);
      return { memberships: memberships.rows[0]?.count ?? 0, populations: state.rows[0]?.populations ?? [] };
    }

    async function registeredAggregateEffect(position: string): Promise<boolean> {
      const result = await database.admin.query<{ state: string }>(
        `SELECT state FROM core.history_event_consumer
         WHERE partition_no = $1 AND position = $2 AND consumer = 'effects'
           AND workflow_id LIKE '%:rating_aggregate'`,
        [partition, position],
      );
      return result.rows.length > 0 && result.rows.every(({ state }) => state === 'completed');
    }

    async function drainEffects(): Promise<void> {
      for (let round = 0; round < 200; round++) {
        const before = await checkpoint();
        const batch = await relay.run(partition);
        if (batch.status === 'busy') continue;
        if (batch.status === 'stopped') throw new Error(`Effects relay stopped: ${batch.reason}`);
        if (batch.envelopes === 0) return;
        const workflows = await database.admin.query<{ workflow_id: string }>(
          `SELECT DISTINCT workflow_id FROM core.history_event_consumer
           WHERE partition_no = $1 AND consumer = 'effects' AND position > $2 AND position <= $3`,
          [partition, before.toString(), batch.position.toString()],
        );
        await Promise.all(workflows.rows.map(({ workflow_id }) => workClient!.retrieveWorkflow(workflow_id).getResult()));
      }
      throw new Error('Effects relay did not reach a settled checkpoint');
    }

    async function request(method: 'POST' | 'DELETE', path: string, voterId: string, body?: unknown): Promise<string> {
      const token = await production.mint(voterId, actorScopes, 'rating-terminal-growth');
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            [IDEMPOTENCY_HEADER]: JSON.stringify(randomUUID()),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const text = await response.text();
      if (response.status !== 202) throw new Error(`Realm membership returned ${response.status}: ${text}`);
      const value = JSON.parse(text) as { workflowId?: string };
      if (!value.workflowId) throw new Error('Realm membership did not return a workflow ID');
      await workClient!.retrieveWorkflow(value.workflowId).getResult();
      return value.workflowId;
    }

    async function eligibilityJob(
      voterId: string,
      direction: 'adding' | 'removing',
      transitionId: string,
    ): Promise<RatingSegmentJob> {
      const result = await database.admin.query<{ transition_id: string; populations: string[] }>(
        `SELECT transition_id, populations FROM rating.voter_state WHERE route = $1 AND voter_id = $2`,
        [route, voterId],
      );
      if (!result.rows[0]) throw new Error('Rating eligibility transition did not create voter state');
      return {
        voterId,
        eligibility: true,
        direction,
        transitionId,
        populations: result.rows[0].populations,
      };
    }

    async function commandTransitionId(voterId: string, commandKind: string, floor: bigint): Promise<string> {
      const result = await database.admin.query<{ transaction_id: string }>(
        `SELECT transaction_id::text FROM core.receipt
         WHERE partition_no = $1 AND principal_id = $2 AND command_kind = $3 AND position > $4
         ORDER BY position DESC LIMIT 1`,
        [partition, voterId, commandKind, floor.toString()],
      );
      if (!result.rows[0]) throw new Error(`Registered ${commandKind} producer did not retain its transition receipt`);
      return result.rows[0].transaction_id;
    }

    async function pagesSince(voterId: string, floor: bigint): Promise<PageObservation[]> {
      const result = await database.admin.query<{
        position: string;
        epoch: number;
        data: { votes: unknown[]; direction: string };
      }>(
        `SELECT position::text, epoch, data FROM core.outbox
         WHERE subject = $1 AND type = 'com.rezics.rating.segment.page.v1' AND position > $2
         ORDER BY position, event_seq`,
        [voterId, floor.toString()],
      );
      return result.rows.map(({ position, epoch, data }) => ({ position, epoch, ...data }));
    }

    async function completeRegisteredJob(job: RatingSegmentJob): Promise<void> {
      await workClient!.retrieveWorkflow(ratingSegmentWorkflowId(job)).getResult();
      await drainEffects();
    }

    async function transition(kind: TerminalKind, voterId: string, direction: 'adding' | 'removing') {
      const floor = await latestPagePosition(voterId);
      const receiptKind = kind === 'realm' ? 'rating.voter-realm.membership' : 'rating.voter-eligibility.event';
      const receiptFloor = await commandPosition(voterId, receiptKind);
      if (kind === 'realm') {
        await request(
          direction === 'adding' ? 'POST' : 'DELETE',
          `/v1/realms/${realmId}/membership`,
          voterId,
        );
        await drainEffects();
        const transitionId = await commandTransitionId(voterId, receiptKind, receiptFloor);
        await completeRegisteredJob({ voterId, realmId, direction, transitionId });
      } else {
        const actor = await production.authenticate(database.pool, staffId, accessActions, 'rating-terminal-staff');
        const context = { pool: database.pool, deadline: Date.now() + 30_000, actor };
        const config = { pool: database.pool, access: production.access, clock: () => new Date() };
        const input = { accountId: voterId, key: randomUUID(), reason: 'Rating eligibility growth fixture' };
        if (direction === 'removing') await createSuspensionCommands(config).suspend(context, input);
        else await createReinstatementCommands(config).reinstate(context, input);
        await drainEffects();
        const transitionId = await commandTransitionId(voterId, receiptKind, receiptFloor);
        await completeRegisteredJob(await eligibilityJob(voterId, direction, transitionId));
      }
      return pagesSince(voterId, floor);
    }

    async function addRealmMembership(voterId: string) {
      return transition('realm', voterId, 'adding');
    }
    async function removeRealmMembership(voterId: string) {
      return transition('realm', voterId, 'removing');
    }
    async function suspend(voterId: string) {
      return transition('eligibility', voterId, 'removing');
    }
    async function reinstate(voterId: string) {
      return transition('eligibility', voterId, 'adding');
    }

    async function replayFirstPage(
      voterId: string,
      pagePosition: string,
      populationId: string,
      targetId: string,
      before: unknown,
    ): Promise<void> {
      const pages = await database.admin.query<{ partition_no: number; epoch: number; position: string; data: { votes: unknown[] } }>(
        `SELECT partition_no, epoch, position::text, data FROM core.outbox
         WHERE subject = $1 AND type = 'com.rezics.rating.segment.page.v1'
           AND position = $2
         ORDER BY event_seq LIMIT 1`,
        [voterId, pagePosition],
      );
      const page = pages.rows[0];
      if (!page || page.data.votes.length !== 100) throw new Error('Replay must target the applied 100-vote page');
      const start = await database.admin.query<{ epoch: number | null; position: string }>(
        `SELECT epoch, position::text FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = 'effects'`,
        [page.partition_no],
      );
      if (!start.rows[0] || start.rows[0].epoch !== page.epoch || BigInt(start.rows[0].position) < BigInt(page.position))
        throw new Error('Effects checkpoint did not settle through the segment page');
      await database.admin.query(
        `UPDATE core.consumer_checkpoint SET epoch = $2, position = $3, updated_at = clock_timestamp()
         WHERE partition_no = $1 AND consumer = 'effects'`,
        [page.partition_no, page.epoch, (BigInt(page.position) - 1n).toString()],
      );
      await drainEffects();
      const after = await aggregateSnapshot(database.admin, populationId, targetId);
      if (!isDeepStrictEqual(after, before)) throw new Error('Replaying the registered page changed its aggregate');
    }

    async function readAggregate(populationId: string, targetId: string): Promise<unknown> {
      return aggregateSnapshot(database.admin, populationId, targetId);
    }

    const targetIds = await makeNativeVoteNeighbourhood(database, production, routeKey);
    await drainEffects();
    await addRealmMembership(voters.eligibility);
    await addRealmMembership(voters.eligibilityWarmup);
    await drainEffects();

    return {
      database,
      realmId,
      route,
      partition,
      globalPopulationId: GLOBAL_CONTEXT.id,
      targetIds,
      ids: voters,
      selectedNeighbourhood,
      registeredAggregateEffect,
      addRealmMembership,
      removeRealmMembership,
      suspend,
      reinstate,
      replayFirstPage,
      readAggregate,
      latestPagePosition,
      checkpoint,
      async close() {
        await runtime?.shutdown();
        await workClient?.close();
        await database.close();
      },
    };
  } catch (error) {
    try {
      await runtime?.shutdown();
    } catch {}
    try {
      await workClient?.close();
    } catch {}
    await database.close();
    throw error;
  }
}

async function makeNativeVoteNeighbourhood(
  database: GrowthDatabase,
  production: Awaited<ReturnType<typeof createProductionAccess>>,
  routeKey: Uint8Array,
): Promise<string[]> {
  const owner = voters.owner;
  const actor = await production.authenticate(database.pool, owner, actorScopes);
  const nativeTargets: string[] = [];
  for (let ordinal = 1; ordinal <= 100; ordinal++) {
    const key = randomUUID();
    const subject = await createSubject(database.pool, {
      actor,
      target: subjectTarget(routeKey, owner, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: `terminal-growth-${ordinal}` } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });
    nativeTargets.push(subject.subject.id);
  }
  const kernel = createKernel({
    pool: database.pool,
    routeKey,
    tokens: sessionKeys,
    access: production.access,
    writeRate: createWriteRateLimiter({
      secret: 'rating-segment-terminal-vote-fixture-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
  });
  for (const voterId of [voters.segment, voters.segmentWarmup, voters.eligibility, voters.eligibilityWarmup]) {
    const token = await production.mint(voterId, actorScopes, 'rating-terminal-growth');
    for (const [index, targetId] of nativeTargets.entries()) {
      const response = await kernel.handle(
        new Request(`http://kernel.test/v1/subjects/${targetId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            [IDEMPOTENCY_HEADER]: JSON.stringify(randomUUID()),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ units: 1 + (index % 20) }),
        }),
      );
      if (response.status !== 200) throw new Error(`Native vote returned ${response.status}: ${await response.text()}`);
    }
  }
  return nativeTargets;
}

async function aggregateSnapshot(client: Parameters<typeof readAggregate>[0], populationId: string, targetId: string) {
  return readAggregate(client, { questionId: STANDARD_QUESTION_ID, populationId, targetId });
}
