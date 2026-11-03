import { randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { withReactionCounts } from '../../../src/content/reads.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import {
  createReactionRelayBase,
  type ReactionRelayBase,
  type ReactionWorkRuntime,
} from '../reaction-relay-convergence-fixture.ts';

const reactionPath = (id: string) => `/v1/subjects/${id}/reaction`;
const reactionsPath = (id: string) => `/v1/subjects/${id}/reactions`;
const unrelatedRoutes = [0x4200, 0x4220, 0x4240, 0x4260] as const;

export type SubjectReactionBoundaryTargets = Readonly<{
  ownSlot: string;
  zeroCount: string;
  deniedRead: string;
  selectedPartitions: readonly number[];
  unrelatedPartitions: readonly number[];
  unrelatedActorRoute: number;
  historyPartition: number;
}>;

export type SubjectReactionBoundaryFixture = Readonly<{
  base: ReactionRelayBase;
  runtime: ReactionWorkRuntime;
  targets: SubjectReactionBoundaryTargets;
  close(): Promise<void>;
}>;

export type SubjectReactionBoundaryObservation = Readonly<{
  database: GrowthDatabase;
  kernel: ReturnType<typeof createKernel>;
  readDependencies: Parameters<typeof withReactionCounts>[0];
  call(
    method: string,
    path: string,
    options?: Readonly<{ bearer?: string }>,
  ): Promise<{
    response: Response;
    text: string;
    value: Record<string, any> | null;
  }>;
  close(): Promise<void>;
}>;

async function createSubject(base: ReactionRelayBase, label: string): Promise<string> {
  const result = await base.command<{ subject?: { id?: string } }>(
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: `${label} ${randomUUID()}` } },
    { bearer: base.author.bearer, expectedStatus: 201 },
  );
  const id = result.subject?.id;
  if (typeof id !== 'string' || routeOf(id) === null)
    throw new Error('The native subject command returned no routed id');
  return id;
}

async function commitReaction(
  base: ReactionRelayBase,
  runtime: ReactionWorkRuntime,
  targetId: string,
  actor: ReactionRelayBase['other'],
  kind: 'like' | 'love' | null,
): Promise<void> {
  const captured = await runtime.captureBeforeWrite(actor.accountId);
  const result = await base.call(kind === null ? 'DELETE' : 'PUT', reactionPath(targetId), {
    bearer: actor.bearer,
    key: randomUUID(),
    ...(kind === null ? {} : { body: { kind } }),
  });
  const expected = kind === null ? 204 : 200;
  if (result.response.status !== expected)
    throw new Error(`The native subject reaction command returned ${result.response.status}, expected ${expected}`);
  const delivery = await captured.read();
  if (delivery.event.type !== 'com.rezics.content.reaction.changed.v1')
    throw new Error(`Unexpected registered reaction event ${delivery.event.type}`);
  await runtime.waitForEffect(delivery.envelope, delivery.eventSeq);
  await runtime.replay(delivery.event);
}

export async function createSubjectReactionBoundaryFixture(): Promise<SubjectReactionBoundaryFixture> {
  const base = await createReactionRelayBase();
  let runtime: ReactionWorkRuntime | undefined;
  try {
    const ownSlot = await createSubject(base, 'Empty private reaction target');
    const zeroCount = await createSubject(base, 'Zero public reaction target');
    const deniedRead = await createSubject(base, 'Denied public reaction target');
    runtime = await base.startEffects();

    await commitReaction(base, runtime, ownSlot, base.other, 'like');
    await commitReaction(base, runtime, zeroCount, base.other, 'love');
    await commitReaction(base, runtime, zeroCount, base.other, null);
    await commitReaction(base, runtime, deniedRead, base.other, 'like');

    const deniedRoute = routeOf(deniedRead);
    if (deniedRoute === null) throw new TypeError('The denied subject has no route');
    await base.system.database.admin.query(
      `INSERT INTO access.resource_denial
         (route,resource_id,subject_id,action,reason,valid,transaction_id)
       VALUES ($1,$2,$3,'subject:read','resource','(,)',$3)`,
      [deniedRoute, deniedRead, base.governance.accountId],
    );

    const ids = [ownSlot, zeroCount, deniedRead];
    const selectedPartitions = [...new Set(ids.map((id) => partitionOf(routeOf(id)!)))].sort((a, b) => a - b);
    const unrelatedPartitions = [...new Set(unrelatedRoutes.map(partitionOf))].sort((a, b) => a - b);
    if (selectedPartitions.length !== 1)
      throw new Error('The selected subject targets must stay in one fixed partition');
    if (unrelatedPartitions.length !== 4) throw new Error('Unrelated subject pressure must keep four fixed partitions');
    const historyRoute = routeOf(base.other.accountId);
    if (historyRoute === null) throw new TypeError('The native history actor has no route');

    return {
      base,
      runtime,
      targets: {
        ownSlot,
        zeroCount,
        deniedRead,
        selectedPartitions,
        unrelatedPartitions,
        unrelatedActorRoute: historyRoute,
        historyPartition: partitionOf(historyRoute),
      },
      async close() {
        try {
          await runtime?.stop();
        } finally {
          await base.system.close();
        }
      },
    };
  } catch (error) {
    try {
      await runtime?.stop();
    } finally {
      await base.system.close();
    }
    throw error;
  }
}

export async function openSubjectReactionBoundaryObservation(
  fixture: SubjectReactionBoundaryFixture,
): Promise<SubjectReactionBoundaryObservation> {
  const sourceUrl = fixture.base.system.database.pool.options.connectionString;
  if (!sourceUrl) throw new Error('The native reaction fixture has no database connection string');
  const database = await openGrowthDatabase(sourceUrl);
  try {
    const kernel = createKernel({
      pool: database.pool,
      routeKey: fixture.base.system.routeKey,
      tokens: fixture.base.system.tokens,
      access: fixture.base.system.access,
      writeRate: createWriteRateLimiter({
        secret: 'subject-reaction-boundary-read-rate-secret',
        overrides: '{}',
      }),
    });
    return {
      database,
      kernel,
      readDependencies: {
        pool: database.pool,
        access: fixture.base.system.access,
        tokens: fixture.base.system.tokens,
      },
      async call(method, path, options = {}) {
        const headers = new Headers();
        if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
        const response = await kernel.handle(new Request(`http://kernel.test${path}`, { method, headers }));
        const text = await response.text();
        return { response, text, value: text ? (JSON.parse(text) as Record<string, any>) : null };
      },
      async close() {
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function seedUnrelatedSubjectReactions(
  database: GrowthDatabase,
  actorRoute: number,
  from: number,
  to: number,
): Promise<void> {
  if (from === to) return;
  const routes: number[] = [];
  const ids: string[] = [];
  const actors: string[] = [];
  for (let ordinal = from; ordinal < to; ordinal++) {
    const route = unrelatedRoutes[ordinal % unrelatedRoutes.length]!;
    routes.push(route);
    ids.push(newId(route));
    actors.push(newId(actorRoute));
  }
  const sourcePartition = partitionOf(actorRoute);
  await database.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
     SELECT route,subject_id,'schema:Book',subject_id
       FROM unnest($1::integer[],$2::uuid[]) AS targets(route,subject_id)`,
    [routes, ids],
  );
  await database.admin.query(
    `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
     SELECT $1,entry.actor_id,'subject',entry.target_route,entry.target_id,'like',statement_timestamp()
       FROM unnest($2::uuid[],$3::integer[],$4::uuid[])
         AS entry(actor_id,target_route,target_id)`,
    [actorRoute, actors, routes, ids],
  );
  await database.admin.query(
    `INSERT INTO content.subject_reactor(route,subject_id,actor_account_id,kind)
     SELECT entry.target_route,entry.target_id,entry.actor_id,'like'
       FROM unnest($1::integer[],$2::uuid[],$3::uuid[])
         AS entry(target_route,target_id,actor_id)`,
    [routes, ids, actors],
  );
  await database.admin.query(
    `INSERT INTO content.reaction_total(route,target_id,kind,count,source_epoch,source_position)
     SELECT route,target_id,'like',1,1,1
       FROM unnest($1::integer[],$2::uuid[]) AS targets(route,target_id)`,
    [routes, ids],
  );
  await database.admin.query(
    `INSERT INTO content.reaction_count(route,target_id,source_partition,kind,count,source_epoch,source_position)
     SELECT route,target_id,$1,'like',1,1,1
       FROM unnest($2::integer[],$3::uuid[]) AS targets(route,target_id)`,
    [sourcePartition, routes, ids],
  );
}

export async function seedRetainedReactionReceipts(
  database: GrowthDatabase,
  principalRoute: number,
  from: number,
  to: number,
): Promise<void> {
  if (from === to) return;
  const principals: string[] = [];
  const keys: string[] = [];
  const transactions: string[] = [];
  const positions: number[] = [];
  const partition = partitionOf(principalRoute);
  for (let ordinal = from; ordinal < to; ordinal++) {
    principals.push(newId(principalRoute));
    keys.push(`retained-reaction-${ordinal}-${randomUUID()}`);
    transactions.push(randomUUID());
    positions.push(ordinal + 1);
  }
  await database.admin.query(
    `INSERT INTO core.receipt
       (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,"position",transaction_id,response)
     SELECT $1,'account',entry.principal_id,'content.reaction.set',entry.idempotency_key,
            decode(repeat('00',32),'hex'),1,entry.position,entry.transaction_id,
            jsonb_build_object('targetId',entry.principal_id,'kind','like')
       FROM unnest($2::uuid[],$3::text[],$4::uuid[],$5::bigint[])
         AS entry(principal_id,idempotency_key,transaction_id,position)`,
    [partition, principals, keys, transactions, positions],
  );
}

export const subjectReactionPaths = { reactionPath, reactionsPath } as const;
