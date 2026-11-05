import { expect, test } from 'bun:test';
import { createRatingIdentityRepairCommands } from '../../src/rating/identity-repair.ts';
import { RATING_IDENTITY_PAGE_SIZE, type IdentityRepairPage } from '../../src/rating/identity-work-frame.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { at, ratingIdentityFixture, route } from './identity-repair-fixture.ts';

const scales = [256, 1024, 4096] as const;
const id = (ordinal: number) => `00000000-0000-7000-8000-3a07${ordinal.toString(16).padStart(8, '0')}`;
const destination = (original: string) => id(100000 + Number.parseInt(original.slice(-8), 16));
const scenarios = ['commit', 'replay', 'rollback', 'cancel', 'withdrawal', 'empty', 'pending'] as const;
type Scenario = (typeof scenarios)[number];

function votes(voterId: string): Population {
  return {
    name: `rating repair input ${voterId}`,
    hotPartition: route >>> 4,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'rating.vote': [
        {
          route,
          voter_id: voterId,
          question_id: STANDARD_QUESTION_ID,
          target_id: id(ordinal + 1),
          counted_target: id(ordinal + 1),
          units: ordinal % 8 === 0 ? null : ordinal % 21,
          revision: 1,
          changed_at: at,
          transaction_id: newId(route),
        },
      ],
    }),
  };
}
function receipts(voterId: string): Population {
  return {
    name: `rating retained withdrawal receipts ${voterId}`,
    hotPartition: route >>> 4,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      // Local withdrawal history makes no claim about Semantic producer observations.
      'rating.identity_repair_receipt': [
        {
          route,
          voter_id: voterId,
          page_id: id(3000000 + ordinal),
          work_id: id(4000000),
          generation: 1,
          digest: 'f'.repeat(64),
          transaction_id: newId(route),
          checkpoint: null,
          terminal: true,
          mode: 'withdrawal',
          obligation_id: null,
          mapping_digest: null,
        },
      ],
    }),
  };
}
function unrelated(voterIds: string[]): Population {
  return {
    ...votes(id(2000000)),
    name: 'rating unrelated voters',
    rows: () => {
      const voterId = newId(route);
      voterIds.push(voterId);
      return {
        'rating.vote': [
          {
            route,
            voter_id: voterId,
            question_id: STANDARD_QUESTION_ID,
            target_id: id(1),
            units: 7,
            revision: 1,
            changed_at: at,
            transaction_id: newId(route),
          },
        ],
      };
    },
  };
}

// 64 selected votes; <=100 memberships; each vote has a fixed number of full-key winner/write probes
// and <=3 effects. Command/account, frame and receipt work is fixed. Thus examined rows/statements
// are constant and index blocks logarithmic in each independent history/input axis. No producer
// currentness or retained Semantic obligation is proved by the injected transaction/page fixture.
for (const axis of ['voters', 'receipts', 'input'] as const) {
  for (const scenario of scenarios) {
    test(`Rating transaction/page seam: ${scenario} stays bounded as ${axis} grow`, async () => {
      const db = await openGrowthDatabase();
      const voterIds: string[] = [];
      try {
        await series(db, axis, scenario, voterIds);
      } finally {
        try {
          // Remove only this scenario's fixtures so the independent axes start at the same baseline.
          for (const table of ['vote', 'identity_repair_receipt', 'identity_work_frame', 'voter_state'])
            await db.admin.query(`DELETE FROM rating.${table} WHERE route = $1 AND voter_id = ANY($2::uuid[])`, [
              route,
              voterIds,
            ]);
        } finally {
          await db.close();
        }
      }
    });
  }
}

async function series(
  db: GrowthDatabase,
  axis: 'voters' | 'receipts' | 'input',
  scenario: Scenario,
  voterIds: string[],
) {
  const background = unrelated(voterIds);
  const fixture = ratingIdentityFixture(() => db);
  const { voter, producer, admit, select, binding, key, effects } = fixture;
  async function snapshot(voterId: string) {
    return (
      await db.admin.query(
        `SELECT target_id, units, revision, to_char(changed_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS changed_at, counted_target, counted_revision
       FROM rating.vote WHERE route = $1 AND voter_id = $2 ORDER BY question_id, target_id LIMIT 128`,
        [route, voterId],
      )
    ).rows;
  }
  async function frame(voterId: string) {
    return (
      await db.admin.query(
        'SELECT state, cursor, selected FROM rating.identity_work_frame WHERE route = $1 AND voter_id = $2',
        [route, voterId],
      )
    ).rows[0]!;
  }
  async function receiptCount(voterId: string) {
    return Number(
      (
        await db.admin.query(
          'SELECT count(*) AS count FROM rating.identity_repair_receipt WHERE route = $1 AND voter_id = $2',
          [route, voterId],
        )
      ).rows[0]!.count,
    );
  }
  async function prepare(scale: number) {
    const actor = await voter();
    voterIds.push(actor.accountId);
    const injected = producer(destination);
    // Production unavailability and local withdrawal deliberately use the delivered default composition.
    const commands = createRatingIdentityRepairCommands({
      pool: db.pool,
      ...(scenario === 'pending' || scenario === 'withdrawal' ? {} : { producer: injected.port }),
    });
    const target = { pool: db.pool, admin: db.admin };
    const input = axis === 'input' ? scale : 256;
    await seed(target, votes(actor.accountId), {
      from: 0,
      to: scenario === 'empty' ? 64 : input,
    });
    await seed(target, receipts(actor.accountId), {
      from: 0,
      to: axis === 'receipts' ? scale : 256,
    });
    const ref = await admit(commands, actor);
    if (scenario === 'empty') {
      const first = await select(commands, actor, ref);
      expect((await commands.commit(actor, binding(first), key())).value.status).toBe('committed');
      // Later input lies beyond the captured upper key; exhaustion must still be a separate receipt.
      await seed(target, votes(actor.accountId), { from: 64, to: input });
    }
    if (scenario === 'withdrawal') {
      await db.admin.query(
        `INSERT INTO rating.voter_state
        (route, voter_id, state, transition_id, purge_votes, populations)
        VALUES ($1, $2, 'ineligible', $3, false, '{}')`,
        [route, actor.accountId, newId(route)],
      );
      await commands.cancel(actor, ref, key());
      const first = await select(commands, actor, ref);
      expect((await commands.commit(actor, binding(first), key())).value.status).toBe('committed');
      const cancelled = (await commands.cancel(actor, ref, key())).value;
      expect(cancelled.status === 'admitted' && cancelled.frame.cursor).toEqual(first.next);
    }
    let page: IdentityRepairPage | null = null;
    if (!['commit', 'withdrawal', 'empty'].includes(scenario)) page = await select(commands, actor, ref);
    const requestKey = key();
    const committed = scenario === 'replay' ? (await commands.commit(actor, binding(page!), requestKey)).value : null;
    if (committed) expect(committed.status).toBe('committed');
    injected.setHandoff(scenario !== 'rollback');
    return {
      actor,
      commands,
      injected,
      ref,
      page,
      requestKey,
      committed,
      before: await snapshot(actor.accountId),
      frame: await frame(actor.accountId),
      effects: await effects(actor),
      receipts: await receiptCount(actor.accountId),
    };
  }
  type State = Awaited<ReturnType<typeof prepare>>;
  const states: State[] = [];
  let state: State;
  async function operation() {
    const s = state;
    if (scenario === 'cancel') {
      expect((await s.commands.cancel(s.actor, s.ref, key())).value).toMatchObject({
        status: 'admitted',
        frame: { state: 'cancelled' },
      });
    } else if (scenario === 'replay') {
      for (const request of [s.requestKey, key()])
        expect((await s.commands.commit(s.actor, binding(s.page!), request)).value).toEqual(s.committed!);
    } else {
      s.page ??= await select(s.commands, s.actor, s.ref);
      expect(s.page.votes).toHaveLength(scenario === 'empty' ? 0 : RATING_IDENTITY_PAGE_SIZE);
      expect(s.page.terminal).toBe(scenario === 'empty');
      const result = (await s.commands.commit(s.actor, binding(s.page), key())).value;
      if (scenario === 'rollback' || scenario === 'pending') {
        expect(result).toEqual({
          status: 'pending',
          reason:
            scenario === 'rollback'
              ? 'semantic-repair-obligation-handoff-pending'
              : 'semantic-exact-currentness-and-held-repair-obligation-unavailable',
        });
      } else {
        expect(result).toMatchObject({
          status: 'committed',
          receipt: {
            checkpoint: s.page.next,
            terminal: s.page.terminal,
            mode: s.page.mode,
          },
        });
      }
    }
    states.push(s);
  }
  const report = await checkGrowth(db, {
    name: `rating repair ${scenario} / ${axis} (Rating transaction/page seam only)`,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    grow: async (_, scale, previous) => {
      const to = axis === 'voters' ? scale : 256;
      await seed({ pool: db.pool, admin: db.admin }, background, {
        from: axis === 'voters' ? previous : previous === 0 ? 0 : to,
        to,
      });
    },
    warmup: async (_, scale) => {
      state = await prepare(scale);
      await operation();
    },
    prepare: async (_, scale) => {
      state = await prepare(scale);
    },
    operation,
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.blocks).toBeGreaterThan(0);
    expect(cost.statements).toBeGreaterThan(0);
    expect(cost.plans).toBeGreaterThan(0);
  }
  // Outcome reads are outside measured commands; checkGrowth retains native background attribution
  // and its original per-statement diagnostics rather than treating preparation as passed evidence.
  for (const s of states) {
    const after = await snapshot(s.actor.accountId);
    const changed = scenario === 'commit' || scenario === 'withdrawal';
    const selected = new Set(changed ? s.page!.votes.map((vote) => vote.targetId) : []);
    expect(after).toEqual(
      s.before.map((row) =>
        !selected.has(row.target_id)
          ? row
          : {
              ...row,
              counted_target: scenario === 'withdrawal' ? null : destination(row.target_id),
              counted_revision: row.counted_revision + (scenario === 'withdrawal' ? 1 : 2),
            },
      ),
    );
    const addedReceipt = changed || scenario === 'empty';
    expect(await receiptCount(s.actor.accountId)).toBe(s.receipts + Number(addedReceipt));
    const emitted = await effects(s.actor);
    expect(emitted.slice(0, s.effects.length)).toEqual(s.effects);
    expect(emitted.length - s.effects.length).toBe(changed ? (scenario === 'withdrawal' ? 64 : 128) : 0);
    const current = await frame(s.actor.accountId);
    if (addedReceipt) {
      expect(current).toEqual({
        state: scenario === 'empty' ? 'complete' : 'active',
        cursor: s.page!.next,
        selected: null,
      });
    } else if (scenario === 'cancel') {
      expect(current).toEqual({
        ...s.frame,
        state: 'cancelled',
        selected: null,
      });
    } else {
      expect(current).toEqual(s.frame);
    }
    if (scenario === 'rollback') {
      expect((await select(s.commands, s.actor, s.ref)).pageId).toBe(s.page!.pageId);
      s.injected.setHandoff(true);
      const resumed = (await s.commands.commit(s.actor, binding(s.page!), key())).value;
      expect(resumed.status).toBe('committed');
      expect((await s.commands.commit(s.actor, binding(s.page!), key())).value).toEqual(resumed);
      expect(await receiptCount(s.actor.accountId)).toBe(s.receipts + 1);
      expect(await effects(s.actor)).toHaveLength(s.effects.length + 128);
    }
  }
}
