import { expect, test } from 'bun:test';
import {
  IDENTITY_REPAIR_GROWTH_ANCHORS,
  IDENTITY_REPAIR_MEMBERSHIP_CAP,
} from '../../src/rating/identity-repair-bounds.ts';
import { createInstalledIdentityRepairCommands } from '../../src/rating/module.ts';
import { createRatingIdentityRepairCommands } from '../../src/rating/identity-repair.ts';
import { unavailableRatingIdentityProducer } from '../../src/rating/segment-identity-guard.ts';
import { RATING_IDENTITY_PAGE_SIZE, type IdentityRepairPage } from '../../src/rating/identity-work-frame.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { at, ratingIdentityFixture, route } from './identity-repair-fixture.ts';
import {
  IDENTITY_REPAIR_NATIVE_AT,
  IDENTITY_REPAIR_NATIVE_ROUTE,
  openInstalledIdentityRepairGrowth,
  type InstalledIdentityRepairGrowth,
} from './support/growth-identity-repair-installed.ts';

const scales = IDENTITY_REPAIR_GROWTH_ANCHORS.scales;
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
          for (const table of ['vote', 'identity_repair_receipt', 'identity_work_frame', 'voter_state', 'voter_realm'])
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
  const { voter, producer, admit, select, binding, key, effects, seedMemberships } = fixture;
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
    // pending is the omitted-producer seam; withdrawal uses local counted identities; other scenarios inject the page seam.
    const commands = createRatingIdentityRepairCommands({
      pool: db.pool,
      ...(scenario === 'pending'
        ? { producer: unavailableRatingIdentityProducer }
        : scenario === 'withdrawal'
          ? {}
          : { producer: injected.port }),
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
    if (scenario !== 'pending') await seedMemberships(actor, IDENTITY_REPAIR_MEMBERSHIP_CAP);
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

function installedUnrelated(): Population {
  return {
    name: 'rating installed unrelated voters',
    hotPartition: IDENTITY_REPAIR_NATIVE_ROUTE >>> 4,
    hotShare: 1,
    rows: () => {
      const voterId = newId(IDENTITY_REPAIR_NATIVE_ROUTE);
      return {
        'rating.vote': [
          {
            route: IDENTITY_REPAIR_NATIVE_ROUTE,
            voter_id: voterId,
            question_id: STANDARD_QUESTION_ID,
            target_id: newId(IDENTITY_REPAIR_NATIVE_ROUTE),
            units: 7,
            revision: 1,
            changed_at: IDENTITY_REPAIR_NATIVE_AT,
            transaction_id: newId(IDENTITY_REPAIR_NATIVE_ROUTE),
          },
        ],
      };
    },
  };
}

function installedReceipts(voterId: string): Population {
  return {
    name: `rating installed retained receipts ${voterId}`,
    hotPartition: IDENTITY_REPAIR_NATIVE_ROUTE >>> 4,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'rating.identity_repair_receipt': [
        {
          route: IDENTITY_REPAIR_NATIVE_ROUTE,
          voter_id: voterId,
          page_id: newId(IDENTITY_REPAIR_NATIVE_ROUTE),
          work_id: newId(IDENTITY_REPAIR_NATIVE_ROUTE),
          generation: 1,
          digest: 'a'.repeat(64),
          transaction_id: newId(IDENTITY_REPAIR_NATIVE_ROUTE),
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

// Installed Semantic hold/complete: 64 mapped originals, 100 memberships, later votes past the
// captured upper key. Injected seam series above cannot reprice this native producer work.
for (const axis of IDENTITY_REPAIR_GROWTH_ANCHORS.axes) {
  test(`Rating installed repair: commit stays bounded as ${axis} grow`, async () => {
    const installed = await openInstalledIdentityRepairGrowth({ identities: IDENTITY_REPAIR_GROWTH_ANCHORS.pageSize });
    try {
      await installedSeries(installed, axis, 'commit');
    } finally {
      await installed.close();
    }
  });
}

test('Rating installed repair: empty completion stays bounded as later input grows beyond the captured upper key', async () => {
  const installed = await openInstalledIdentityRepairGrowth({ identities: IDENTITY_REPAIR_GROWTH_ANCHORS.pageSize });
  try {
    await installedSeries(installed, 'input', 'empty');
  } finally {
    await installed.close();
  }
});

async function installedSeries(
  installed: InstalledIdentityRepairGrowth,
  axis: 'voters' | 'receipts' | 'input',
  scenario: 'commit' | 'empty',
) {
  const { db, host, later } = installed;
  const background = installedUnrelated();
  const commands = createInstalledIdentityRepairCommands({ pool: db.pool });
  async function mint(): Promise<AccountActor> {
    const accountId = newId(host.route);
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [host.route, accountId],
    );
    return {
      kind: 'account',
      accountId,
      scopes: ['rating:vote'],
      clientId: 'identity-repair-installed-growth',
      requestedBy: null,
      authnEpoch: 1,
    };
  }
  async function prepare(scale: number) {
    const actor = await mint();
    for (const original of host.originals) await host.seedVote(actor, original);
    await host.seedMemberships(actor, IDENTITY_REPAIR_MEMBERSHIP_CAP);
    await seed({ pool: db.pool, admin: db.admin }, installedReceipts(actor.accountId), {
      from: 0,
      to: axis === 'receipts' ? scale : 256,
    });
    const extras = axis === 'input' && scenario === 'commit' ? Math.max(0, scale - host.originals.length) : 0;
    for (const target of later(extras)) await host.seedVote(actor, target);
    const admitted = (await commands.admit(actor, { workId: newId(host.route), expectedGeneration: null }, host.key()))
      .value;
    if (admitted.status !== 'admitted') throw new Error(admitted.reason);
    const ref = { workId: admitted.frame.workId, generation: admitted.frame.generation };
    async function select() {
      const selected = (await commands.select(actor, ref, host.key())).value;
      if (selected.status !== 'selected') throw new Error(selected.reason);
      return selected.page;
    }
    if (scenario === 'empty') {
      const first = await select();
      expect(first.votes).toHaveLength(IDENTITY_REPAIR_GROWTH_ANCHORS.pageSize);
      expect((await commands.commit(actor, host.binding(first), host.key())).value.status).toBe('committed');
      for (const target of later(scale)) await host.seedVote(actor, target);
    }
    const page = await select();
    return {
      actor,
      ref,
      page,
      receipts: (await host.read.receipts(actor.accountId)).length,
      effects: (await host.read.voteEffects(actor.accountId)).length,
    };
  }
  type State = Awaited<ReturnType<typeof prepare>>;
  const states: State[] = [];
  let state: State;
  async function operation() {
    const result = (await commands.commit(state.actor, host.binding(state.page), host.key())).value;
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.receipt.terminal).toBe(scenario === 'empty');
      expect(result.receipt.obligationId).toBeTruthy();
      expect(result.receipt.mappingDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    states.push(state);
  }
  const report = await checkGrowth(db, {
    name: `rating installed repair ${scenario} / ${axis}`,
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
  }
  for (const s of states) {
    const votes = await host.read.countedVotes(s.actor.accountId);
    const selected = new Set(s.page.votes.map((vote) => vote.targetId));
    if (scenario === 'commit') {
      expect(s.page.votes).toHaveLength(IDENTITY_REPAIR_GROWTH_ANCHORS.pageSize);
      for (const original of host.originals) {
        expect(votes.find((vote) => vote.targetId === original)).toMatchObject({
          countedTargetId: host.terminal(original),
          units: 7,
          revision: 1,
        });
      }
      const extras = votes.filter((vote) => !selected.has(vote.targetId));
      expect(extras.every((vote) => vote.countedTargetId === null)).toBe(true);
    } else {
      expect(s.page.votes).toHaveLength(0);
      expect(s.page.terminal).toBe(true);
      const mapped = new Set(host.originals);
      expect(votes.filter((vote) => !mapped.has(vote.targetId)).every((vote) => vote.countedTargetId === null)).toBe(
        true,
      );
      expect((await host.read.obligations(s.actor.accountId)).some((row) => row.laterVote)).toBe(true);
    }
    expect((await host.read.receipts(s.actor.accountId)).length).toBe(s.receipts + 1);
    expect((await host.read.voteEffects(s.actor.accountId)).length).toBeGreaterThanOrEqual(s.effects);
    const obligation = await host.read.boundObligation(s.actor.accountId, s.page.pageId);
    expect(obligation).toMatchObject({
      state: 'bound',
      pageId: s.page.pageId,
    });
    expect(await host.read.checkpoint(s.actor.accountId)).toMatchObject({
      state: scenario === 'empty' ? 'complete' : 'active',
      selectedPageId: null,
      generation: s.ref.generation,
    });
  }
}
