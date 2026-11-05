import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { runCommand } from '../../src/command/command.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createVoterRealmsEffect, finishVoterRealmRemoval } from '../../src/rating/voter-realms.ts';
import { createRatingWorkModule } from '../../src/rating/work-module.ts';
import type { Effect } from '../../src/events/effects.ts';
import type { WorkContext } from '../../src/work/registry.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import {
  capture,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const route = 0x3a03;
const membershipType = 'com.rezics.community.realm.membership.v1';
let database: GrowthDatabase;
let effect: ReturnType<typeof createVoterRealmsEffect>;
const at = '2026-10-27T10:00:00.000Z';
const key = (n: number) => `00000000-0000-7000-8000-3a03${n.toString(16).padStart(8, '0')}`;
const B = { questionId: STANDARD_QUESTION_ID, targetId: key(20) };

function membership(voterId: string, realmId: string, role: 'member' | null): CloudEvent {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:kernel',
    type: membershipType,
    time: at,
    datacontenttype: 'application/json',
    sequence: '1',
    data: {
      accountId: voterId,
      realmId,
      role,
      at: '2026-10-27 10:00:00+00',
      reservationId: newId(route),
      transactionId: newId(route),
    },
  };
}
async function row(voterId: string, realmId: string) {
  return (
    await database.admin.query(
      'SELECT * FROM rating.voter_realm WHERE route = $1 AND voter_id = $2 AND realm_id = $3',
      [route, voterId, realmId],
    )
  ).rows[0];
}
async function addRow(
  voterId: string,
  realmId: string,
  state: string,
  cursor: typeof B | null = null,
  limit: typeof B | null = null,
) {
  await database.admin.query(
    `INSERT INTO rating.voter_realm
    (route, voter_id, realm_id, joined_at, state, cursor_question_id, cursor_target_id, limit_question_id, limit_target_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      route,
      voterId,
      realmId,
      at,
      state,
      cursor?.questionId ?? null,
      cursor?.targetId ?? null,
      limit?.questionId ?? null,
      limit?.targetId ?? null,
    ],
  );
}
async function finish(voterId: string, realmId: string) {
  await runCommand(database.pool, { partition: partitionOf(route) }, async (tx) => {
    await finishVoterRealmRemoval(tx, { route, voterId, realmId });
    return {
      value: null,
      events: [{ type: 'com.rezics.rating.voter-realm.changed.v1', subject: voterId, data: { voterId, realmId } }],
    };
  });
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  effect = createVoterRealmsEffect(database.pool);
});
afterAll(async () => {
  if (database) await database.close();
});

test('membership effect is registered with rating work', () => {
  const effects: Effect[] = [];
  createRatingWorkModule(async () => '0'.repeat(64)).register({
    pool: database.pool,
    env: {},
    addEffects: (added: typeof effects) => {
      effects.push(...added);
    },
  } as WorkContext);
  expect(effects.some(({ types }) => types.includes(membershipType))).toBe(true);
});

test('membership joins are idempotent and leave before adding deletes in the voter partition', async () => {
  const voterId = newId(route),
    realmId = newId(0x6b04);
  const event = membership(voterId, realmId, 'member');
  await effect.run(event);
  expect(await row(voterId, realmId)).toMatchObject({
    route,
    state: 'adding',
    cursor_question_id: null,
    rejoin: false,
  });
  await effect.run(event);
  await effect.run(membership(voterId, realmId, 'member'));
  expect(await row(voterId, realmId)).toMatchObject({ state: 'adding' });
  const applied = await database.admin.query('SELECT partition_no FROM core.outbox WHERE subject = $1 AND type = $2', [
    voterId,
    'com.rezics.rating.voter-realm.changed.v1',
  ]);
  expect(applied.rows).toHaveLength(2);
  expect(applied.rows.every((entry) => entry.partition_no === partitionOf(route))).toBe(true);
  await effect.run(membership(voterId, realmId, null));
  expect(await row(voterId, realmId)).toBeUndefined();
  await effect.run(event); // A retried join cannot resurrect a later leave.
  expect(await row(voterId, realmId)).toBeUndefined();
  await effect.run(membership(voterId, realmId, null));
});

test('leaving adding preserves its applied prefix; counted removes all; rejoin restarts only after removal', async () => {
  for (const state of ['adding', 'counted']) {
    const voterId = newId(route),
      realmId = newId(route);
    await addRow(voterId, realmId, state, state === 'adding' ? B : null);
    await effect.run(membership(voterId, realmId, null));
    expect(await row(voterId, realmId)).toMatchObject({
      state: 'removing',
      cursor_question_id: null,
      limit_question_id: state === 'adding' ? B.questionId : null,
      limit_target_id: state === 'adding' ? B.targetId : null,
      rejoin: false,
    });
    await effect.run(membership(voterId, realmId, 'member'));
    expect(await row(voterId, realmId)).toMatchObject({ state: 'removing', rejoin: true });
    await effect.run(membership(voterId, realmId, null));
    expect(await row(voterId, realmId)).toMatchObject({ state: 'removing', rejoin: false });
    await effect.run(membership(voterId, realmId, 'member'));
    await finish(voterId, realmId);
    expect(await row(voterId, realmId)).toMatchObject({
      state: 'adding',
      cursor_question_id: null,
      cursor_target_id: null,
      limit_question_id: null,
      limit_target_id: null,
      rejoin: false,
    });
  }
});

test('duplicate joins preserve membership order and removal toggles preserve its remaining range', async () => {
  const voterId = newId(route);
  for (const state of ['adding', 'counted', 'uncounted']) {
    const realmId = newId(route);
    await addRow(voterId, realmId, state);
    const original = await row(voterId, realmId);
    await effect.run(membership(voterId, realmId, 'member'));
    expect(await row(voterId, realmId)).toEqual(original);
  }
  const realmId = newId(route);
  const limit = { questionId: B.questionId, targetId: key(30) };
  await addRow(voterId, realmId, 'removing', B, limit);
  const original = await row(voterId, realmId);
  await effect.run(membership(voterId, realmId, 'member'));
  expect(await row(voterId, realmId)).toEqual({ ...original, rejoin: true });
  await effect.run(membership(voterId, realmId, null));
  expect(await row(voterId, realmId)).toEqual(original);
});

test('promotion follows join time before the Realm id tie breaker', async () => {
  const voterId = newId(route),
    leaving = newId(route);
  await addRow(voterId, leaving, 'adding');
  await addRow(voterId, key(1), 'uncounted');
  await addRow(voterId, key(2), 'uncounted');
  await database.admin.query(
    `UPDATE rating.voter_realm SET joined_at = '2026-10-26T10:00:00Z'
    WHERE route = $1 AND voter_id = $2 AND realm_id = $3`,
    [route, voterId, key(2)],
  );
  await effect.run(membership(voterId, leaving, null));
  expect(await row(voterId, key(2))).toMatchObject({ state: 'adding' });
  expect(await row(voterId, key(1))).toMatchObject({ state: 'uncounted' });
});

test('the first 100 joined hold the cap through adding and removing; a departure promotes the earliest waiting Realm', async () => {
  const voterId = newId(route);
  for (let n = 1; n <= 102; n++) await effect.run(membership(voterId, key(n), 'member'));
  expect(await row(voterId, key(100))).toMatchObject({ state: 'adding' });
  expect(await row(voterId, key(101))).toMatchObject({ state: 'uncounted' });
  await effect.run(membership(voterId, key(102), null));
  expect(await row(voterId, key(102))).toBeUndefined();
  await database.admin.query(`UPDATE rating.voter_realm SET state = 'counted' WHERE voter_id = $1 AND realm_id = $2`, [
    voterId,
    key(1),
  ]);
  await effect.run(membership(voterId, key(1), null));
  expect(await row(voterId, key(101))).toMatchObject({ state: 'uncounted' });
  await finish(voterId, key(1));
  expect(await row(voterId, key(1))).toBeUndefined();
  expect(await row(voterId, key(101))).toMatchObject({ state: 'adding', cursor_question_id: null });
  await effect.run(membership(voterId, key(102), 'member'));
  await effect.run(membership(voterId, key(2), null));
  expect(await row(voterId, key(102))).toMatchObject({ state: 'adding' });
  expect(
    (
      await database.admin.query(
        `SELECT count(*)::int AS n FROM rating.voter_realm WHERE voter_id = $1 AND state <> 'uncounted'`,
        [voterId],
      )
    ).rows[0].n,
  ).toBe(100);
});

test('vote events list Global and only the applied side of each cursor and removal limit', async () => {
  await bootstrapRelease(database.pool, bundledRelease);
  const voterId = newId(route);
  const actor: AccountActor = {
    kind: 'account',
    accountId: voterId,
    scopes: ['subject:read', 'rating:vote'],
    clientId: 'voter-realms',
    requestedBy: null,
    authnEpoch: 1,
  };
  await database.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
    VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
    [route, voterId, newId(route)],
  );
  const account = (await readAccount(database.pool, route, voterId))!;
  const access = createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: () => account,
  });
  const commands = createVoteCommands({ pool: database.pool, access });
  const requestKey = randomUUID();
  const subject = await createSubject(database.pool, {
    actor,
    target: subjectTarget(new Uint8Array(32).fill(3), voterId, requestKey),
    idempotencyKey: requestKey,
    digest: createHash('sha256').update(requestKey).digest(),
    item: { type: 'schema:Book', labels: { en: 'Population listing' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  const targetId = subject.subject.id;
  const equal = { questionId: STANDARD_QUESTION_ID, targetId };
  const before = { questionId: STANDARD_QUESTION_ID.slice(0, -1) + '0', targetId };
  const after = { questionId: key(1), targetId };
  const targetBefore = { questionId: STANDARD_QUESTION_ID, targetId: '00000000-0000-7000-8000-000000000000' };
  const targetAfter = { questionId: STANDARD_QUESTION_ID, targetId: 'ffffffff-ffff-7fff-bfff-ffffffffffff' };
  const states = [
    ['counted', null, null, true],
    ['uncounted', null, null, false],
    ['adding', null, null, false],
    ['adding', before, null, false],
    ['adding', equal, null, true],
    ['adding', after, null, true],
    ['removing', null, null, true],
    ['removing', before, equal, true],
    ['removing', equal, null, false],
    ['removing', null, before, false],
    ['removing', before, after, true],
    ['removing', after, null, false],
    ['adding', targetBefore, null, false],
    ['adding', targetAfter, null, true],
    ['removing', targetBefore, targetAfter, true],
    ['removing', null, targetBefore, false],
    ['removing', targetAfter, null, false],
    ['removing', null, equal, true],
  ] as const;
  const expected = [GLOBAL_CONTEXT.id];
  for (const [state, cursor, limit, counted] of states) {
    const realmId = newId(route);
    await addRow(voterId, realmId, state, cursor, limit);
    if (counted) expected.push(realmId);
  }
  for (const units of [5, 6, null]) {
    await commands.putVote(actor, { questionId: STANDARD_QUESTION_ID, targetId, units }, randomUUID());
    const event = (
      await database.admin.query(
        `SELECT data FROM core.outbox WHERE type = 'com.rezics.rating.vote.changed.v1' AND subject = $1 ORDER BY position DESC LIMIT 1`,
        [voterId],
      )
    ).rows[0].data;
    expect([...event.populations].sort()).toEqual([...expected].sort());
  }
});

const population: Population = {
  name: 'other voter memberships',
  hotPartition: partitionOf(route),
  hotShare: 1,
  rows: ({ ordinal }) => ({
    'rating.voter_realm': [
      {
        route,
        voter_id: key(1_000_000 + ordinal),
        realm_id: key(2_000_000 + ordinal),
        joined_at: at,
        state: 'counted',
      },
      {
        route,
        voter_id: key(1_000_000 + ordinal),
        realm_id: key(3_000_000 + ordinal),
        joined_at: at,
        state: 'uncounted',
      },
    ],
  }),
};

test('membership join and promotion cost constant rows and statements as other voters grow', async () => {
  const voterId = newId(route),
    leaving = newId(route),
    waiting = newId(route);
  const warmupVoterId = newId(route),
    warmupLeaving = newId(route),
    warmupWaiting = newId(route);
  // Seed 4096 other voters in both partial indexes before the first scale. Grow their genuine
  // effect receipt/outbox shapes too; these service effects do not write an editorial basis.
  const historyVoter = newId(route);
  await effect.run(membership(historyVoter, newId(route), 'member'));
  const receipt = (await database.admin.query('SELECT * FROM core.receipt WHERE principal_id = $1', [historyVoter]))
    .rows[0]!;
  const event = (
    await database.admin.query('SELECT * FROM core.outbox WHERE partition_no = $1 AND position = $2', [
      partitionOf(route),
      receipt.position,
    ])
  ).rows[0]!;
  const initialNeighbours = 4096;
  const result = await checkGrowth(database, {
    name: 'voter Realm membership',
    rule: 'series',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    grow: async (db, scale, previous) => {
      const from = previous === 0 ? 0 : initialNeighbours + previous;
      const position = Number(
        (await db.admin.query('SELECT position FROM core.partition WHERE partition_no = $1', [partitionOf(route)]))
          .rows[0]!.position,
      );
      const history: Population = {
        ...population,
        rows: (input) => {
          const voterId = key(1_000_000 + input.ordinal);
          const nextPosition = position + input.ordinal - from + 1;
          return {
            ...population.rows!(input),
            'core.outbox': [
              {
                ...event,
                id: newId(route),
                position: nextPosition,
                subject: voterId,
                data: { voterId, realmId: key(2_000_000 + input.ordinal) },
              },
            ],
          };
        },
        finish: async (admin, range) => {
          // Copy JSON null in SQL and let PostgreSQL compute actor_account_id.
          await admin.query(
            `INSERT INTO core.receipt
               (partition_no, principal_kind, principal_id, command_kind, idempotency_key,
                request_digest, epoch, position, transaction_id, response, created_at)
             SELECT o.partition_no, r.principal_kind, o.subject::uuid, r.command_kind,
                    encode(sha256(uuid_send(o.id)), 'hex'), r.request_digest,
                    o.epoch, o.position, o.id, r.response, r.created_at
             FROM core.outbox o CROSS JOIN core.receipt r
             WHERE o.partition_no = $1 AND o.position > $2 AND o.position <= $3
               AND r.partition_no = $1 AND r.principal_id = $4
               AND r.command_kind = 'rating.voter-realm.membership'`,
            [partitionOf(route), position, position + range.to - range.from, historyVoter],
          );
          await admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
            partitionOf(route),
            position + range.to - range.from,
          ]);
        },
      };
      await seed({ pool: db.pool, admin: db.admin }, history, { from, to: initialNeighbours + scale });
      for (const [probeVoter, probeLeaving, probeWaiting] of [
        [voterId, leaving, waiting],
        [warmupVoterId, warmupLeaving, warmupWaiting],
      ] as const) {
        await db.admin.query('DELETE FROM rating.voter_realm WHERE route = $1 AND voter_id = $2', [route, probeVoter]);
        await addRow(probeVoter, probeLeaving, 'adding');
        await addRow(probeVoter, probeWaiting, 'uncounted');
      }
    },
    warmup: async (_db, _scale, _repetition) => {
      await effect.run(membership(warmupVoterId, warmupLeaving, null));
      await effect.run(membership(warmupVoterId, newId(route), 'member'));
      expect(await row(warmupVoterId, warmupWaiting)).toMatchObject({ state: 'adding' });
    },
    prepare: async () => {
      // Plan assertions run outside checkGrowth's capture, on reset spare state.
      await database.admin.query('DELETE FROM rating.voter_realm WHERE route = $1 AND voter_id = $2', [
        route,
        warmupVoterId,
      ]);
      await addRow(warmupVoterId, warmupLeaving, 'adding');
      await addRow(warmupVoterId, warmupWaiting, 'uncounted');
      const measured = await capture(database, async () => {
        await effect.run(membership(warmupVoterId, warmupLeaving, null));
        await effect.run(membership(warmupVoterId, newId(route), 'member'));
      });
      const nodes: Record<string, unknown>[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (node['Node Type']) nodes.push(node);
        if (node.Plan) visit(node.Plan);
        if (node.Plans) visit(node.Plans);
      };
      visit(measured.capture.plans);
      for (const index of ['voter_realm_pkey', 'voter_realm_waiting_idx', 'voter_realm_capped_idx']) {
        const probes = nodes.filter((node) => node['Index Name'] === index);
        expect(probes.length).toBeGreaterThan(0);
        for (const probe of probes) {
          expect(String(probe['Index Cond'])).toContain('route');
          expect(String(probe['Index Cond'])).toContain('voter_id');
        }
      }
      expect(nodes.some((node) => node['Index Name'] === 'receipt_pkey')).toBe(true);
      expect(
        nodes.filter((node) => node['Relation Name'] === 'voter_realm' && node['Node Type'] === 'Seq Scan'),
      ).toHaveLength(0);
      expect(await row(warmupVoterId, warmupWaiting)).toMatchObject({ state: 'adding' });
    },
    operation: async () => {
      await effect.run(membership(voterId, leaving, null));
      await effect.run(membership(voterId, newId(route), 'member'));
      expect(await row(voterId, waiting)).toMatchObject({ state: 'adding' });
    },
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
}, 30_000);
