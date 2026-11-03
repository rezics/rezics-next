import { DBOS } from '@dbos-inc/dbos-sdk';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { principalCommandIdentity } from '../../../src/command/command.ts';
import { registerContent } from '../../../src/content/register.ts';
import { setReaction } from '../../../src/content/reactions.ts';
import { effectWorkflowId, type Effect } from '../../../src/events/effects.ts';
import { readBatch, type Envelope } from '../../../src/events/log.ts';
import { bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createNativeContentSystem } from './native-system.ts';

export type MembershipAxis = 'other-actors' | 'same-actor-history';
export const membershipScales = [256, 1024, 4096] as const;
export const membershipVersion = 9_007_199_254_740_993n;

/** Only this suite owns these seeds. Selected slots and their effects use native commands and registration. */
export async function createMembershipGrowthFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createNativeContentSystem({ databaseUrl });
  let db: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let runtime: Awaited<ReturnType<typeof composeWork>> | undefined;
  const close = async () => {
    try {
      await runtime?.shutdown();
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          await db?.close();
        } finally {
          await system.close();
        }
      }
    }
  };
  try {
    db = await openGrowthDatabase(system.database.pool.options.connectionString!);
    const growth = db;
    await bootstrapRelease(growth.pool, bundledRelease);
    const actor = system.actors.author.actor;
    const other = system.actors.other.actor;
    const home = routeOf(actor.accountId)!;
    const partition = partitionOf(home);
    async function subject(label: string) {
      const response = await system.kernel.handle(
        new Request('https://content.test/v1/subjects', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${system.actors.author.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
          body: JSON.stringify({ type: 'schema:Book', labels: { en: label } }),
        }),
      );
      const body = await response.text();
      if (response.status !== 201) throw new Error(`POST /v1/subjects: ${response.status} ${body}`);
      const value = JSON.parse(body) as { subject: { id: string } };
      return value.subject.id;
    }
    const ids: string[] = [];
    for (const label of ['Liked', 'Loved', 'Laughed', 'Other account only']) ids.push(await subject(label));
    const [liked, loved, laughed, otherOnly] = ids as [string, string, string, string];
    const absent = newId(routeOf(liked)!);
    // Numerical fixture pressure, before real commands: their trigger increments cross Number.MAX_SAFE_INTEGER.
    await growth.admin.query('INSERT INTO content.reaction_liked_version VALUES ($1,$2,$3)', [
      home,
      actor.accountId,
      (membershipVersion - 2n).toString(),
    ]);
    const sources: Array<{ actorId: string; result: NonNullable<Awaited<ReturnType<typeof setReaction>>> }> = [];
    for (const [who, targetId, kind] of [
      [actor, liked, 'like'],
      [actor, loved, 'love'],
      [actor, laughed, 'laugh'],
      [other, otherOnly, 'love'],
    ] as const) {
      const result = await setReaction(
        { pool: growth.pool, access: system.access },
        who,
        { targetKind: 'subject', targetId, kind },
        { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(), deadline: Date.now() + 30_000 },
      );
      if (!result) throw new Error('Expected a committed native reaction command');
      sources.push({ actorId: who.accountId, result });
    }
    const template = sources[2]!.result;
    // Capture the real committed envelopes before adding unrelated retained history.
    const envelopes: Envelope[] = [];
    for (const sourcePartition of new Set(sources.map(({ actorId }) => partitionOf(routeOf(actorId)!)))) {
      const read = await readBatch(growth.pool, {
        consumer: `membership_setup_${crypto.randomUUID()}`,
        partition: sourcePartition,
        apply: async (batch) => { envelopes.push(...batch); },
      });
      if (read.status !== 'read') throw new Error(`Native membership setup source stopped: ${JSON.stringify(read)}`);
    }
    const registered: Effect[] = [];
    client = await createWorkClient(growth.url, growth.openPool({ max: 4 }));
    // Native Auth has completed its identities; Content now owns this fixture's executor.
    await DBOS.shutdown({ deregister: true });
    runtime = await composeWork([
      {
        name: registerContent.name,
        register(context) {
          return registerContent.register({
            ...context,
            addEffects(effects) { registered.push(...effects); context.addEffects(effects); },
          });
        },
      },
    ], {
      databaseUrl: growth.url,
      pool: growth.openPool({ max: 4 }),
      client,
      executorId: `membership-growth-${crypto.randomUUID()}`,
      env: workerTestEnv({
        KERNEL_ROUTE_KEY: Buffer.from(system.routeKey).toString('base64url'),
        CONTENT_TEST_COLLECTION_PARTITIONS: '0',
      }),
    });
    await runtime.launch();
    const selected = envelopes.flatMap((envelope) =>
      envelope.events.some((event) => event.type === 'com.rezics.content.reaction.changed.v1') ? [envelope] : [],
    );
    const reactionEffect = registered.find(({ name }) => name === 'content_reaction_count');
    if (!reactionEffect) throw new Error('Production reaction effect was not registered');
    await runtime.effects.enqueue(selected);
    for (const envelope of selected) {
      for (const [index, event] of envelope.events.entries()) {
        for (const effect of registered.filter(({ types }) => types.includes(event.type)))
          await client.retrieveWorkflow(effectWorkflowId(envelope, index, effect.name)).getResult();
      }
    }
    // Verify effect completion from its native target projection, before selecting the read operation.
    const projected = await growth.admin.query(
      'SELECT target_id FROM content.reaction_contribution WHERE target_id=ANY($1::uuid[]) AND kind IS NOT NULL',
      [ids],
    );
    if (projected.rowCount !== 4) throw new Error('Native selected reaction effects did not complete');

    let noise: Array<{ actor: string; target: string; transaction: string; event: string; key: string; digest: string }> = [];
    async function resetNoise() {
      if (noise.length === 0) return;
      await growth.admin.query('DELETE FROM content.reaction WHERE target_id=ANY($1::uuid[])', [noise.map((r) => r.target)]);
      await growth.admin.query('DELETE FROM core.outbox WHERE id=ANY($1::uuid[])', [noise.map((r) => r.event)]);
      await growth.admin.query('DELETE FROM core.receipt WHERE transaction_id=ANY($1::uuid[])', [noise.map((r) => r.transaction)]);
      await growth.admin.query('DELETE FROM editorial.write_basis WHERE transaction_id=ANY($1::uuid[])', [noise.map((r) => r.transaction)]);
      const actors = noise.map((r) => r.actor).filter((id) => id !== actor.accountId);
      await growth.admin.query('DELETE FROM content.reaction_liked_version WHERE actor_account_id=ANY($1::uuid[])', [actors]);
      await growth.admin.query('DELETE FROM access.account WHERE account_id=ANY($1::uuid[])', [actors]);
      noise = [];
    }
    async function grow(axis: MembershipAxis, scale: number, previous: number) {
      const rows = Array.from({ length: scale - previous }, () => {
        const target = newId(routeOf(liked)!);
        const body = { targetKind: 'subject', targetId: target, kind: 'laugh' };
        return {
          actor: axis === 'other-actors' ? newId(home) : actor.accountId,
          target,
          transaction: Bun.randomUUIDv7(), event: Bun.randomUUIDv7(), key: crypto.randomUUID(),
          digest: createHash('sha256').update(canonicalize([principalCommandIdentity(actor), 'content.reaction.set', body])!).digest('hex'),
        };
      });
      const seed = await growth.admin.connect();
      try {
        await seed.query('BEGIN');
        if (axis === 'other-actors')
          await seed.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
             SELECT $1, id, 'actor', 'active', id FROM unnest($2::uuid[]) id`,
            [home, rows.map((r) => r.actor)],
          );
        await seed.query(
          `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
           SELECT $1, actor, 'subject', $2, target, $3, statement_timestamp()
           FROM jsonb_to_recordset($4::jsonb) AS r(actor uuid,target uuid)`,
          [home, routeOf(liked), axis === 'other-actors' ? 'love' : 'laugh', JSON.stringify(rows)],
        );
        if (axis === 'same-actor-history') {
          const fence = await seed.query<{ start: string }>(
            'UPDATE core.partition SET position=position+$2 WHERE partition_no=$1 RETURNING (position-$2)::text AS start',
            [partition, rows.length],
          );
          const parameters = [JSON.stringify(rows), fence.rows[0]!.start, partition, template.transactionId];
          const seeds = `WITH seeds AS (
            SELECT data, $2::bigint + ordinal AS position
            FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS s(data,ordinal)
          )`;
          await seed.query(`${seeds}
            INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
            SELECT o.partition_no,s.position,o.event_seq,o.event_count,o.epoch,(s.data->>'event')::uuid,o.type,
              s.data->>'target',jsonb_set(o.data,'{targetId}',s.data->'target')
            FROM seeds s JOIN core.receipt c ON c.partition_no=$3 AND c.transaction_id=$4
            JOIN core.outbox o ON o.partition_no=c.partition_no AND o.position=c.position`, parameters);
          await seed.query(`${seeds}
            INSERT INTO editorial.write_basis(partition_no,transaction_id,epoch,position,principal_kind,principal_id,client_id,requested_by)
            SELECT b.partition_no,(s.data->>'transaction')::uuid,b.epoch,s.position,b.principal_kind,b.principal_id,b.client_id,b.requested_by
            FROM seeds s JOIN editorial.write_basis b ON b.partition_no=$3 AND b.transaction_id=$4`, parameters);
          await seed.query(`${seeds}
            INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
            SELECT c.partition_no,c.principal_kind,c.principal_id,c.command_kind,s.data->>'key',decode(s.data->>'digest','hex'),
              c.epoch,s.position,(s.data->>'transaction')::uuid,jsonb_set(c.response,'{targetId}',s.data->'target')
            FROM seeds s JOIN core.receipt c ON c.partition_no=$3 AND c.transaction_id=$4`, parameters);
        }
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally { seed.release(); }
      noise.push(...rows);
      const counts = await growth.admin.query<{ reactions: number; actors: number; receipts: number; events: number; basis: number }>(
        `SELECT
          (SELECT count(*)::int FROM content.reaction WHERE target_id=ANY($1::uuid[])) AS reactions,
          (SELECT count(DISTINCT actor_account_id)::int FROM content.reaction WHERE target_id=ANY($1::uuid[])) AS actors,
          (SELECT count(*)::int FROM core.receipt WHERE transaction_id=ANY($2::uuid[])) AS receipts,
          (SELECT count(*)::int FROM core.outbox WHERE id=ANY($3::uuid[])) AS events,
          (SELECT count(*)::int FROM editorial.write_basis WHERE transaction_id=ANY($2::uuid[])) AS basis`,
        [noise.map((r) => r.target), noise.map((r) => r.transaction), noise.map((r) => r.event)],
      );
      return counts.rows[0]!;
    }
    return {
      db: growth, actorId: actor.accountId, home, liked, loved, laughed, otherOnly, absent,
      baselineActorId: system.actors.moderator.actor.accountId,
      grow, resetNoise, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
