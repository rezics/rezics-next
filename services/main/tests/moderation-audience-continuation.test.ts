import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  NotificationProducer,
  PRODUCER_COST,
} from '../src/modules/notification-producers/producer.ts';
import { NotificationStore } from '../src/modules/notification/store.ts';
import type { RecipientFrontier } from '../src/modules/follows/recipients.ts';
import { notificationProducerSubjectReader } from '../src/modules/notification-producers/subjects.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agent = (n: number) => `https://rezics.com/id/${uid(n)}`;
const actor = uid(9000);
const decision = uid(9001);
const caseId = uid(9002);
const range = (count: number, start = 1) => Array.from({ length: count }, (_, i) => uid(start + i));
interface Progress {
  after_principal: string | null;
  frontier: RecipientFrontier | null;
  complete: boolean;
}
interface Item {
  id: string;
  principal: string;
  source: string;
  topic: string;
}
interface State {
  cursor: { epoch: string; xid: string; id: string };
  editorial: string;
  progress: Map<string, Progress>;
  seen: Set<string>;
  items: Item[];
}

/** Exercise the real store's deduplication and transactional ACK with owner rows
 * isolated per test. A failed transaction restores both intake and frontier. */
function audienceScene(kind = 'moderation_outcome') {
  let state: State = {
    cursor: { epoch: '0', xid: '0', id: '0' },
    editorial: '0',
    progress: new Map(),
    seen: new Set(),
    items: [],
  };
  const reports: { report_id: string; received_at: string; id: string }[] = [];
  const parties: string[] = [];
  const representations = new Map<string, string[]>();
  const authors: string[] = [];
  const effects: string[] = [];
  const impactMembers: string[] = [];
  const inactive = new Set<string>();
  const inactiveAgents = new Set<string>();
  const reads: { sql: string; args: unknown[] }[] = [];
  const committedBatchSizes: number[] = [];
  let held = 0;
  let owner: object | null = null;
  let failAfterItems: number | null = null;
  let stale = false;
  let open = true;
  let editorialPending = false;
  let relaySequence = '0';
  let alertTicks = 0;
  let pauseIntake: (() => Promise<void>) | undefined;
  const key = (args: unknown[]) => [args[0], args[1], args[2]].join('|');
  const seenKey = (principal: unknown, source: unknown, topic: unknown) =>
    `${principal}|${source}|${topic}`;
  const eligible = (id: string) => !inactive.has(id);

  const pool = {
    query: async (sql: string) => {
      if (sql.includes('sequence_editorial_events')) return { rows: [] };
      throw new Error(`unexpected pool read (intake must use held client): ${sql}`);
    },
    connect: async () => {
      held++;
      let snapshot: State | undefined;
      let ownsCursor = false;
      const client = {
        release: () => {
          held--;
          if (ownsCursor) owner = null;
        },
        query: async (sql: string, args: unknown[] = []) => {
          reads.push({ sql, args });
          if (sql === 'BEGIN') {
            snapshot = structuredClone(state);
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            committedBatchSizes.push(state.items.length - snapshot!.items.length);
            snapshot = undefined;
            if (ownsCursor) {
              owner = null;
              ownsCursor = false;
            }
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            if (snapshot) state = snapshot;
            if (ownsCursor) {
              owner = null;
              ownsCursor = false;
            }
            return { rows: [] };
          }
          if (sql.startsWith('SET LOCAL') || sql.includes('set_config')) return { rows: [] };
          if (sql.includes('current_setting'))
            return { rows: [{ sequential: 'on', bitmap: 'on' }] };
          if (sql.includes('SELECT open')) return { rows: [{ open }] };
          if (sql.includes('FROM access.notification_producer_cursor')) {
            if (sql.includes('position::text'))
              return { rows: editorialPending ? [{ position: state.editorial }] : [] };
            if (owner && owner !== client) return { rows: [] };
            owner = client;
            ownsCursor = true;
            return { rows: [{ ...state.cursor }] };
          }
          if (sql.includes('FROM access.notification_producer_event'))
            return {
              rows: [
                { epoch: '0', xid: '42', id: '1', kind, event_id: decision },
                { epoch: '0', xid: '42', id: '2', kind: 'feed_post_vote', event_id: uid(9003) },
              ]
                .filter((row) => Number(row.id) > Number(args[2]))
                .slice(0, Number(args[3])),
            };
          if (sql.includes('UPDATE access.notification_producer_cursor')) {
            if (sql.includes('SET position')) state.editorial = String(args[0]);
            else
              state.cursor = { epoch: String(args[1]), xid: String(args[2]), id: String(args[3]) };
            return { rows: [] };
          }
          if (sql.includes('FROM access.moderation_decision')) {
            expect(sql).toContain('c.decision_head = d.id');
            expect(sql).toContain('op.cancelled');
            return {
              rows: stale
                ? []
                : [
                    {
                      case_id: caseId,
                      principal_id: actor,
                      acting_subject: agent(9000),
                      context: agent(9004),
                      target_resource: agent(9005),
                      statement_of_reasons: authors.length ? null : {},
                    },
                  ],
            };
          }
          if (sql.includes('FROM access.realm_admin_receipt') && !sql.includes('WITH effect'))
            return {
              rows: [{ realm: agent(9004), principal_id: actor, acting_subject: agent(9000) }],
            };
          if (sql.includes('FROM access.realm_submission_revision'))
            return {
              rows: [
                {
                  id: caseId,
                  realm: agent(9004),
                  submitting_agent: agent(1),
                  reviewer: agent(9000),
                  actor,
                },
              ],
            };
          if (
            sql.includes('FROM access.feed_post_vote_event') ||
            sql.includes('FROM access.realm_invitation')
          )
            return { rows: [] };
          if (sql.includes('FROM access.governance_report')) {
            expect(sql).toContain('ORDER BY received_at,id LIMIT $4');
            expect(Number(args[3])).toBe(257);
            return {
              rows: reports
                .filter(
                  (row) =>
                    !args[1] ||
                    row.received_at > String(args[1]) ||
                    (row.received_at === args[1] && row.report_id > String(args[2])),
                )
                .slice(0, Number(args[3]))
                .map((row) => ({ ...row, eligible: eligible(row.id) && row.id !== actor })),
            };
          }
          if (sql.includes('FROM access.safety_party_notice')) {
            expect(Number(args[2])).toBe(257);
            return {
              rows: [...parties]
                .sort()
                .filter((id) => !args[1] || id > String(args[1]))
                .slice(0, Number(args[2]))
                .map((id) => ({ id, eligible: eligible(id) })),
            };
          }
          if (sql.includes('WITH effect')) {
            expect(sql).toContain('ORDER BY member LIMIT 1');
            const member = [...new Set([...effects, ...impactMembers])]
              .sort()
              .find((value) => !args[1] || value > String(args[1]));
            return { rows: member ? [{ member }] : [] };
          }
          if (
            sql.includes('FROM access.work_maintainer') ||
            sql.includes('JOIN access.work_maintainer')
          )
            return { rows: [] };
          if (sql.includes('raw_follows AS MATERIALIZED'))
            return { rows: [{ id: uid(9024), reason: 'manual', eligible: true }] };
          if (sql.includes('FROM access.representation')) {
            expect(Number(args[4])).toBe(257);
            return {
              rows: [...new Set(representations.get(String(args[0])) ?? [])]
                .sort()
                .filter((id) => id !== args[1] && (!args[3] || id > String(args[3])))
                .slice(0, Number(args[4]))
                .map((id) => ({
                  id,
                  eligible: eligible(id) && !inactiveAgents.has(String(args[0])),
                })),
            };
          }
          if (sql.includes('INSERT INTO access.notification_recipient_progress')) {
            if (!state.progress.has(key(args)))
              state.progress.set(key(args), {
                after_principal: null,
                frontier: null,
                complete: false,
              });
            return { rows: [] };
          }
          if (sql.includes('FROM access.notification_recipient_progress'))
            return { rows: [state.progress.get(key(args))] };
          if (sql.includes('UPDATE access.notification_recipient_progress')) {
            state.progress.set(key(args), {
              after_principal: args[3] as string | null,
              complete: args[4] as boolean,
              frontier: args[5] ? (JSON.parse(String(args[5])) as RecipientFrontier) : null,
            });
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO access.notification_seen')) {
            const seen = seenKey(args[0], args[2], args[3]);
            if (state.seen.has(seen) || !eligible(String(args[0])))
              return { rows: [], rowCount: 0 };
            state.seen.add(seen);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT p.active AND')) return { rows: [{ inbox: true, email: false }] };
          if (sql.includes('SELECT generation::text'))
            return { rows: [{ generation: uid(9010), head_sequence: '0' }] };
          if (sql.includes('FROM access.notification_item i')) {
            const item = state.items.find(
              (item) =>
                item.principal === args[0] && item.source === args[2] && item.topic === args[3],
            );
            return {
              rows: item
                ? [{ id: item.id, generation: uid(9010), sequence: '1', deliveries: 0 }]
                : [],
            };
          }
          if (sql.includes('INSERT INTO access.notification_item (')) {
            if (pauseIntake) {
              const pause = pauseIntake;
              pauseIntake = undefined;
              await pause();
            }
            if (failAfterItems !== null && state.items.length >= failAfterItems) {
              failAfterItems = null;
              throw new Error('intake interrupted');
            }
            state.items.push({
              id: String(args[0]),
              principal: String(args[1]),
              source: String(args[7]),
              topic: String(args[5]),
            });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('FROM access.editorial_event e'))
            return {
              rows:
                state.editorial === '0'
                  ? [
                      {
                        sequence: '1',
                        id: uid(9020),
                        proposal: uid(9021),
                        revision: 1,
                        kind: 'created',
                        actor: agent(9000),
                        occurredAt: '2026-01-01T00:00:00Z',
                      },
                    ]
                  : [],
            };
          if (sql.includes('SELECT p.proposer_principal'))
            return {
              rows: [
                {
                  proposer_principal: uid(9022),
                  resource: agent(9023),
                  work: agent(9023),
                  context: agent(9004),
                  actor_principal: actor,
                },
              ],
            };
          if (
            sql.includes('FROM access.work_maintainer') ||
            sql.includes('remaining ORDER BY target')
          )
            return { rows: [] };
          if (
            sql.includes('INSERT INTO access.notification_') ||
            sql.includes('UPDATE access.notification_stream') ||
            sql.includes('pg_notify')
          )
            return { rows: [], rowCount: 0 };
          throw new Error(`unexpected client query: ${sql}`);
        },
      };
      return client;
    },
  } as unknown as Pool;
  const relayClient = {
    release() {},
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM relay.notification_producer_cursor'))
        return { rows: [{ data_epoch: 'epoch', sequence: relaySequence }] };
      if (sql.includes('FROM relay.delivered_batch'))
        return { rows: relaySequence === '0' ? [{ sequence: '1', event_count: 0 }] : [] };
      if (sql.includes('SET sequence =')) relaySequence = String(args[1]);
      return { rows: [] };
    },
  };
  const relay = { connect: async () => relayClient } as unknown as Pool;
  const checkpoint = {
    query: async () => ({ rows: [{ data_epoch: 'epoch', sequence: '1' }] }),
  } as unknown as Pool;
  const graph = {
    query: async (sql: string) => {
      expect(sql).toContain('ORDER BY STR(?author) LIMIT 1');
      const after = sql.match(/STR\(\?author\) > "([^"]+)"/)?.[1];
      const author = [...authors]
        .sort()
        .find((value) => value !== agent(9000) && (!after || value > after));
      return { results: { bindings: author ? [{ author: { type: 'uri', value: author } }] : [] } };
    },
  };
  const producer = () =>
    new NotificationProducer(
      pool,
      relay,
      {} as Pool,
      graph as never,
      new NotificationStore(pool),
      'main-graph-v1',
      checkpoint,
      {
        runOnce: async () => {
          alertTicks++;
          return 0;
        },
      },
    );
  return {
    producer,
    reports,
    parties,
    representations,
    authors,
    effects,
    impactMembers,
    inactive,
    inactiveAgents,
    reads,
    committedBatchSizes,
    get state() {
      return state;
    },
    get held() {
      return held;
    },
    get relaySequence() {
      return relaySequence;
    },
    get alertTicks() {
      return alertTicks;
    },
    addReports(ids: string[]) {
      ids.forEach((id) =>
        reports.push({
          id,
          report_id: uid(10000 + reports.length),
          received_at: '2026-01-01 00:00:00.123456+00',
        }),
      );
    },
    failAfter(count: number) {
      failAfterItems = count;
    },
    setStale() {
      stale = true;
    },
    setHeldForRecovery() {
      open = false;
    },
    withEditorial() {
      editorialPending = true;
    },
    pauseNextIntake(pause: () => Promise<void>) {
      pauseIntake = pause;
    },
  };
}

async function exhaust(scene: ReturnType<typeof audienceScene>, ticks = 1200) {
  for (let i = 0; i < ticks && scene.state.cursor.id !== '2'; i++)
    await scene.producer().runAccessOnce();
  expect(scene.state.cursor.id).toBe('2');
  expect(scene.held).toBe(0);
  expect(
    scene.committedBatchSizes.every((count) => count <= PRODUCER_COST.recipientsPerEvent),
  ).toBe(true);
}

test('600 disjoint reporters and parties receive one outcome each through committed pages and restart', async () => {
  const scene = audienceScene();
  scene.addReports(range(300));
  scene.parties.push(...range(300, 301));
  await scene.producer().runAccessOnce();
  expect(scene.state.items).toHaveLength(256);
  expect(scene.state.cursor.id).toBe('0');
  expect([...scene.state.progress.values()][0]?.frontier).toMatchObject({
    phase: 'reporters',
    reportAfter: { id: uid(10255), receivedAt: '2026-01-01 00:00:00.123456+00' },
  });
  // Every subsequent tick constructs a fresh producer/store-independent runtime.
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(range(600));
  expect(scene.committedBatchSizes.filter((count) => count > 0)).toEqual([256, 44, 256, 44]);
});

test('separately small reporter and party sources can exceed 256 between them', async () => {
  const scene = audienceScene();
  scene.addReports(range(200));
  scene.parties.push(...range(200, 201));
  await scene.producer().runAccessOnce();
  expect(scene.state.items).toHaveLength(200);
  expect(scene.state.cursor.id).toBe('0');
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(range(400));
});

test('an inactive party page advances to later active parties', async () => {
  const scene = audienceScene();
  scene.parties.push(...range(600));
  range(256).forEach((id) => scene.inactive.add(id));
  await scene.producer().runAccessOnce();
  await scene.producer().runAccessOnce();
  expect(scene.state.items).toHaveLength(0);
  expect([...scene.state.progress.values()][0]?.frontier).toMatchObject({
    phase: 'parties',
    afterPrincipal: uid(256),
  });
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(range(344, 257));
});

test('repeated reports and overlapping parties deduplicate while empty ineligible pages advance', async () => {
  const scene = audienceScene();
  scene.addReports(Array(256).fill(actor) as string[]);
  scene.addReports([...range(300), ...range(300)]);
  scene.parties.push(...range(100, 251), actor);
  scene.inactive.add(uid(1));
  await scene.producer().runAccessOnce();
  expect(scene.state.items).toHaveLength(0);
  expect(scene.state.cursor.id).toBe('0');
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(
    [...range(349, 2), actor].sort(),
  );
});

test('partial intake rollback preserves the committed frontier and a restart has no gaps', async () => {
  const scene = audienceScene();
  scene.addReports(range(600));
  await scene.producer().runAccessOnce();
  const committed = structuredClone(scene.state);
  scene.failAfter(270);
  await expect(scene.producer().runAccessOnce()).rejects.toThrow('intake interrupted');
  expect(scene.state).toEqual(committed);
  expect(scene.held).toBe(0);
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(range(600));
});

test('editorial, safety alerts and relay advance during a large moderation audience', async () => {
  const scene = audienceScene();
  scene.addReports(range(600));
  scene.withEditorial();
  const worker = scene.producer();
  await worker.runAccessOnce();
  expect(scene.state.cursor.id).toBe('0');
  expect(scene.state.editorial).toBe('1');
  expect(scene.state.items.some((item) => item.topic === 'review-requested')).toBe(true);
  expect(scene.alertTicks).toBe(1);
  await worker.runRelayOnce();
  expect(scene.relaySequence).toBe('1');
});

test('concurrent ticks skip a locked source and cannot repeat a committed audience page', async () => {
  const scene = audienceScene();
  scene.addReports(range(600));
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intake = new Promise<void>((resolve) => {
    entered = resolve;
  });
  scene.pauseNextIntake(async () => {
    entered();
    await paused;
  });
  const first = scene.producer().runAccessOnce();
  await intake;
  expect(await scene.producer().runAccessOnce()).toBe(0);
  release();
  await first;
  expect(scene.state.items).toHaveLength(256);
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(range(600));
});

test('a superseded decision advances without a notice and a recovery fence prevents all progress', async () => {
  const stale = audienceScene();
  stale.addReports(range(600));
  stale.setStale();
  await exhaust(stale);
  expect(stale.state.items).toHaveLength(0);
  const held = audienceScene();
  held.addReports(range(600));
  held.setHeldForRecovery();
  await expect(held.producer().runAccessOnce()).rejects.toThrow('Access is held for recovery');
  expect(held.state.cursor.id).toBe('0');
  expect(held.state.progress.size).toBe(0);
  expect(held.state.items).toHaveLength(0);
});

test('legacy outcomes page over 256 authors and over 256 representatives for an author', async () => {
  const scene = audienceScene();
  scene.authors.push(...range(300).map((id) => `https://rezics.com/id/${id}`));
  scene.authors.forEach((author, i) => scene.representations.set(author, [uid(i + 1)]));
  scene.representations.set(agent(1), range(300, 301));
  scene.inactiveAgents.add(agent(2));
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual([
    ...range(298, 3),
    ...range(300, 301),
  ]);
  expect(
    scene.reads.some(
      (read) => read.sql.includes('FROM access.representation') && read.args[3] === uid(556),
    ),
  ).toBe(true);
});

test('Realm outcomes page over 256 effects and impact members plus large represented audiences', async () => {
  const scene = audienceScene('realm_role_change');
  scene.effects.push(...range(300).map((id) => `https://rezics.com/id/${id}`));
  scene.impactMembers.push(
    ...range(300, 251).map((id) => `https://rezics.com/id/${id}`),
    agent(9000),
  );
  [...scene.effects, ...scene.impactMembers].forEach((member) =>
    scene.representations.set(member, [member.slice(-36)]),
  );
  scene.representations.set(agent(1), range(300, 601));
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual([
    ...range(549, 2),
    ...range(300, 601),
  ]);
  expect(JSON.stringify([...scene.state.progress.values()])).not.toContain('afterMember');
});

test('submission outcomes page a large represented audience using the action restriction', async () => {
  const scene = audienceScene('submission_decision');
  scene.representations.set(agent(1), [...range(600), actor]);
  await exhaust(scene);
  expect(scene.state.items.map((item) => item.principal).sort()).toEqual(range(600));
  const reads = scene.reads.filter((read) => read.sql.includes('FROM access.representation'));
  expect(reads.every((read) => read.args[2] === 'submission.submit')).toBe(true);
});

test('a legacy author beyond 256 remains readable through the recipient holdings, with revocation rechecks', async () => {
  let holdings = range(600).map((id) => `https://rezics.com/id/${id}`);
  let revokeDuringRead = false;
  let safety = false;
  const seeks: (string | null)[] = [];
  const access = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM access.moderation_decision'))
        return {
          rows: [
            {
              case_id: caseId,
              target_resource: agent(9005),
              context: 'urn:rezics:context:global',
              outcome: 'restrict',
              reporter: false,
              affected: false,
              safety,
            },
          ],
        };
      if (sql.includes('subject_id=ANY'))
        return {
          rows: revokeDuringRead
            ? []
            : holdings
                .filter((author) => (args[1] as string[]).includes(author))
                .map((author) => ({ author })),
        };
      if (sql.includes('AS author FROM access.representation')) {
        expect(args[0]).toBe(uid(7000));
        expect(sql).toContain('ORDER BY r.subject_id LIMIT 257');
        seeks.push(args[1] as string | null);
        return {
          rows: holdings
            .filter((author) => !args[1] || author > String(args[1]))
            .slice(0, 257)
            .map((author) => ({ author })),
        };
      }
      throw new Error(`unexpected legacy subject read: ${sql}`);
    },
  } as unknown as Pool;
  const env = {
    fuseki: {
      query: async (sql: string) => {
        if (!sql.includes('ASK')) return { results: { bindings: [] } };
        expect(sql).toContain('VALUES ?author');
        expect(sql).not.toContain(uid(7000));
        const values = sql.slice(sql.indexOf('VALUES ?author'), sql.indexOf('GRAPH'));
        expect((values.match(/https:\/\/rezics[.]com\/id\//g) ?? []).length).toBeLessThanOrEqual(
          256,
        );
        return { boolean: values.includes(agent(600)) };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const reader = notificationProducerSubjectReader(access, {} as Pool, env);
  const input = {
    owner: 'access',
    ref: decision,
    revision: null,
    principalId: uid(7000),
    disclosureBasis: 'moderation-outcome-v1',
    realm: null,
  };
  expect(await reader.resolve(input)).toMatchObject({
    status: 'available',
    subject: { fields: { linkTarget: agent(9005), excerpt: 'restrict' } },
  });
  expect(seeks).toEqual([null, agent(256), agent(512)]);
  revokeDuringRead = true;
  expect(await reader.resolve(input)).toEqual({ status: 'undisclosed' });
  revokeDuringRead = false;
  holdings = [];
  expect(await reader.resolve(input)).toEqual({ status: 'undisclosed' });
  holdings = [agent(600)];
  safety = true;
  expect(await reader.resolve(input)).toEqual({ status: 'undisclosed' });
});

test('a recipient beyond 256 Realm effects can read the outcome and loses it after authority revocation', async () => {
  let revoked = false;
  let authorizations = 0;
  const access = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes('AS member,impact.ordinal FROM access.representation')) {
        authorizations++;
        expect(args).toEqual([uid(600), decision]);
        expect(sql).toContain('effect.member=r.subject_id');
        expect(sql).toContain('LIMIT 1');
        return { rows: revoked ? [] : [{ member: agent(600) }] };
      }
      if (sql.includes('FROM access.realm_admin_receipt'))
        return {
          rows: [
            {
              realm: agent(9004),
              result: {
                impact: {
                  changes: range(600).map((id) => ({ member: `https://rezics.com/id/${id}` })),
                },
                notificationRole: { name: 'Realm moderator' },
                auditDetail: { kind: 'assignment', member: agent(600), assigned: true },
              },
            },
          ],
        };
      throw new Error(`unexpected Realm subject read: ${sql}`);
    },
  } as unknown as Pool;
  const env = {
    fuseki: { query: async () => ({ results: { bindings: [] } }) },
  } as unknown as WorkActivationEnvironment;
  const reader = notificationProducerSubjectReader(access, {} as Pool, env);
  const input = {
    owner: 'access',
    ref: decision,
    revision: null,
    principalId: uid(600),
    disclosureBasis: 'realm-role-change-v1',
    realm: agent(9004),
  };
  expect(await reader.resolve(input)).toMatchObject({
    status: 'available',
    subject: {
      fields: {
        linkTarget: agent(9004),
        roleName: 'Realm moderator',
        roleChange: 'given',
      },
    },
  });
  revoked = true;
  expect(await reader.resolve(input)).toEqual({ status: 'undisclosed' });
  expect(authorizations).toBe(2);
});
