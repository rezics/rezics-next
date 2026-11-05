import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from '../support/growth.ts';

const firstRoute = 0x3a20;
const rowsPerScale = 500;
const repetitionsPerScale = 6;
const recordedAt = '2026-10-26T12:00:00.000Z';
const scopes = [
  'subject:read',
  'progress_session:create',
  'progress_session:update',
  'progress_session:read',
  'progress_session:list',
];
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(59)]]) };
const key = () => randomUUID();

type Fixture = {
  readonly route: number;
  readonly actor: AccountActor;
  readonly commands: ReturnType<typeof createSessionCommands>;
  readonly subjectId: string;
};

let database: GrowthDatabase;
let fixtures: Fixture[];

function persona(accountId: string): AccountActor {
  return {
    kind: 'account',
    accountId,
    scopes,
    clientId: 'growth-sessions-test',
    requestedBy: null,
    authnEpoch: 1,
  };
}

function routed(prefix: string, route: number, ordinal: number): string {
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

function routedSql(prefix: string, route = '$1', ordinal = 'n'): string {
  return `('${prefix}-0000-7000-8000-' || lpad(to_hex(${route}::int), 4, '0') || lpad(to_hex(${ordinal}::bigint), 8, '0'))::uuid`;
}

async function insertAccount(accountId: string, route: number): Promise<void> {
  await database.admin.query(
    `INSERT INTO access.account
      (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
    [route, accountId, newId(route)],
  );
}

async function createFixture(route: number): Promise<Fixture> {
  const actor = persona(newId(route));
  await insertAccount(actor.accountId, route);
  const requestKey = key();
  const created = await createSubject(database.pool, {
    actor,
    target: subjectTarget(new Uint8Array(32).fill(73), actor.accountId, requestKey),
    idempotencyKey: requestKey,
    digest: createHash('sha256').update(requestKey).digest(),
    item: { type: 'schema:Book', labels: { en: 'Growth session subject' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  const access = admittedAccess({
    actions: new Map<string, { anonymous: boolean; authority?: 'own-account' }>([
      ['subject:read', { anonymous: true }],
      ...['progress_session:create', 'progress_session:update', 'progress_session:read', 'progress_session:list'].map(
        (action) => [action, { anonymous: false, authority: 'own-account' as const }] as const,
      ),
    ]),
  });
  return {
    route,
    actor: await authenticateAccount(access, { pool: database.pool, deadline: Date.now() + 300_000 }, actor),
    subjectId: created.subject.id,
    commands: createSessionCommands({ pool: database.pool, access, tokens, clock: () => new Date(recordedAt) }),
  };
}

async function seedAccessAndEnvelope(fixture: Fixture, previous: number, scale: number): Promise<void> {
  const from = previous * rowsPerScale + 1;
  const to = scale * rowsPerScale;
  const route = fixture.route;
  const partition = route >>> 4;

  await database.admin.query(
    `WITH ordinals AS (
       SELECT n FROM generate_series($2::int, $3::int) AS n
     ), source AS (
       SELECT $1::int AS route, ${routedSql('10000000')} AS account_id FROM ordinals
       UNION ALL
       SELECT (($1::int + 16 + (((n - 1) % 1000) * 16)) % 65536)::int,
         ${routedSql('15000000', '(($1::int + 16 + (((n - 1) % 1000) * 16)) % 65536)')}
       FROM ordinals
     )
     INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     SELECT route, account_id, 'actor', 'active', account_id, false, 1
     FROM source`,
    [route, from, to],
  );
  await database.admin.query(
    `WITH source AS (
       SELECT n, ${routedSql('10000000', '$2')} AS principal_id,
         ${routedSql('12000000', '$2')} AS transaction_id
       FROM generate_series($3::int, $4::int) AS n
     )
     INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest, epoch,
        "position", transaction_id, response)
     SELECT $1, 'account', principal_id, 'growth.seed', 'seed-' || n::text, decode(repeat('00', 32), 'hex'), 1,
       n::bigint, transaction_id, '{}'::jsonb
     FROM source`,
    [partition, route, from, to],
  );
  await database.admin.query(
    `WITH source AS (
       SELECT n, ${routedSql('13000000', '$2')} AS event_id
       FROM generate_series($3::int, $4::int) AS n
     )
     INSERT INTO core.outbox
       (partition_no, "position", event_seq, event_count, epoch, id, type, subject, data, recorded_at)
     SELECT $1, 100000000 + ($2::bigint * 10000) + n, 0, 1, 1, event_id, 'com.rezics.growth.seed.v1',
       $5, '{}'::jsonb, $6::timestamptz
     FROM source`,
    [partition, route, from, to, fixture.actor.accountId, recordedAt],
  );
  await database.admin.query(
    `WITH source AS (
       SELECT n, ${routedSql('14000000', '$2')} AS transaction_id
       FROM generate_series($3::int, $4::int) AS n
     )
     INSERT INTO editorial.write_basis
       (partition_no, transaction_id, epoch, "position", principal_id, client_id, requested_by, recorded_at,
        principal_kind)
     SELECT $1, transaction_id, 1, 500000000 + ($2::bigint * 10000) + n, $5, 'growth-seed', NULL,
       $6::timestamptz, 'account'
     FROM source`,
    [partition, route, from, to, fixture.actor.accountId, recordedAt],
  );
}

type RecordProbes = {
  readonly measuredId: string;
  readonly warmupId: string;
  readonly measuredRevision: number;
  readonly warmupRevision: number;
};

async function seedLibrary(fixture: Fixture, previous: number, scale: number, record?: RecordProbes): Promise<void> {
  const route = fixture.route;
  const from = previous * rowsPerScale + 1;
  const to = scale * rowsPerScale;
  const sessionId = routedSql('20000000');
  const otherRoute = '(($1::int + 16 + (((n - 1) % 1000) * 16)) % 65536)';
  const otherSessionId = routedSql('21000000', otherRoute);
  const otherAccountId = routedSql('15000000', otherRoute);
  const transactionId = routedSql('42000000');

  await database.admin.query(
    `WITH ordinals AS (
       SELECT n FROM generate_series($2::int, $3::int) AS n
     ), own_sessions AS (
       SELECT n, ${sessionId} AS session_id FROM ordinals
     ), other_sessions AS (
       SELECT n, ${otherRoute}::int AS route, ${otherSessionId} AS session_id, ${otherAccountId} AS account_id
       FROM ordinals
     ), source AS (
       SELECT $1::int AS route, session_id, $4::uuid AS account_id, $5::uuid AS subject_id,
         'completed_units'::text AS mode, 'episode'::text AS unit, 1 AS completed_unit_count, 2 AS revision,
         ${transactionId} AS transaction_id
       FROM own_sessions
       UNION ALL
       SELECT route, session_id, account_id, $5, 'scalar_amount', 'page', 0, 1,
         ${routedSql('43000000')} FROM other_sessions
     )
     INSERT INTO library.progress_session
       (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount, locator,
        "position", completed_unit_count, state, revision, started_at, completed_at, transaction_id)
     SELECT route, session_id, account_id, subject_id, NULL, mode, unit, NULL, NULL, NULL, NULL,
       completed_unit_count, 'active', revision, $6::timestamptz, NULL, transaction_id
     FROM source`,
    [route, from, to, fixture.actor.accountId, fixture.subjectId, recordedAt],
  );

  const unitSources = [
    `
    SELECT $1::int AS route, ${sessionId} AS session_id, 'seed-unit'::text AS unit_id,
      $4::timestamptz AS added_at
    FROM generate_series($2::int, $3::int) AS n`,
  ];
  const unitValues: unknown[] = [route, from, to, recordedAt];
  if (record) {
    unitSources.push(
      `SELECT $1, $5::uuid, 'record-measured-' || n::text, $4::timestamptz
       FROM generate_series($2::int, $3::int) AS n`,
      `SELECT $1, $6::uuid, 'record-warmup-' || n::text, $4::timestamptz
       FROM generate_series($2::int, $3::int) AS n`,
    );
    unitValues.push(record.measuredId, record.warmupId);
  }
  await database.admin.query(
    `INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
     ${unitSources.join('\nUNION ALL\n')}`,
    unitValues,
  );

  const changeSources = [
    `
    SELECT $1::int AS route, ${sessionId} AS session_id, 2 AS change_no,
      '{"add":["seed-unit"]}'::jsonb AS intent, $4::timestamptz AS recorded_at,
      ${transactionId} AS transaction_id
    FROM generate_series($2::int, $3::int) AS n`,
  ];
  const changeValues: unknown[] = [route, from, to, recordedAt];
  if (record) {
    changeSources.push(
      `SELECT $1, $5::uuid, n, jsonb_build_object('amount', '0'), $4::timestamptz,
        ('40000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid
       FROM generate_series($7::int, $8::int) AS n`,
      `SELECT $1, $6::uuid, n, jsonb_build_object('amount', '0'), $4::timestamptz,
        ('41000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid
       FROM generate_series($9::int, $10::int) AS n`,
    );
    const targetRevision = scale * rowsPerScale + 1;
    changeValues.push(
      record.measuredId,
      record.warmupId,
      record.measuredRevision + 1,
      targetRevision,
      record.warmupRevision + 1,
      targetRevision,
    );
  }
  await database.admin.query(
    `INSERT INTO library.progress_change
       (route, session_id, change_no, intent, recorded_at, transaction_id)
     ${changeSources.join('\nUNION ALL\n')}`,
    changeValues,
  );

  if (record) {
    const revision = scale * rowsPerScale + 1;
    await database.admin.query(
      `UPDATE library.progress_session AS session
       SET revision = grown.revision
       FROM (VALUES ($2::uuid, $4::int), ($3::uuid, $4::int)) AS grown(session_id, revision)
       WHERE session.route = $1 AND session.session_id = grown.session_id`,
      [route, record.measuredId, record.warmupId, revision],
    );
  }
}

async function grow(fixture: Fixture, previous: number, scale: number, record?: RecordProbes): Promise<void> {
  await seedAccessAndEnvelope(fixture, previous, scale);
  await seedLibrary(fixture, previous, scale, record);
}

function expectNoLibraryScans(report: GrowthReport): void {
  for (const sample of report.samples) {
    for (const relation of ['library.progress_session', 'library.progress_unit', 'library.progress_change'])
      expect(sample.cost.relations?.[relation]?.sequentialScans ?? 0, `${relation} at scale ${sample.scale}`).toBe(0);
  }
}

function reportSamples(name: string, report: GrowthReport): void {
  console.log(
    JSON.stringify({
      check: name,
      samples: report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
      })),
    }),
  );
}

function expectConstantStatements(report: GrowthReport): void {
  expect(report.samples.map((sample) => sample.cost.statements)).toEqual([
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
  ]);
}

async function recordProbes(fixture: Fixture): Promise<{ measured: string; warmup: string }> {
  const input = { subjectId: fixture.subjectId, mode: 'scalar_amount' as const, unit: 'page' as const };
  const measured = (await fixture.commands.startSession(fixture.actor, input, key())).value;
  const warmup = (await fixture.commands.startSession(fixture.actor, input, key())).value;
  return { measured: measured.id, warmup: warmup.id };
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  fixtures = [];
  for (let index = 0; index < 5; index += 1) fixtures.push(await createFixture(firstRoute + index));
});

afterAll(async () => {
  if (database) await database.close();
});

test('Session start has constant rows and statements as sessions grow', async () => {
  const fixture = fixtures[0]!;
  const report = await checkGrowth(database, {
    name: 'session start',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => grow(fixture, previous, scale),
    operation: async (_db, _scale, repetition) =>
      fixture.commands.startSession(
        fixture.actor,
        { subjectId: fixture.subjectId, mode: 'scalar_amount', unit: 'page' },
        `growth-session-start-${repetition}-${key()}`,
      ),
  });
  expectConstantStatements(report);
  expectNoLibraryScans(report);
  reportSamples('Session start', report);
});

test("Session record has constant rows and statements as sessions and the session's own history grow", async () => {
  const fixture = fixtures[1]!;
  const probes = await recordProbes(fixture);
  let measuredRevision = 1;
  let warmupRevision = 1;
  const report = await checkGrowth(database, {
    name: 'session record',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => {
      await grow(fixture, previous, scale, {
        measuredId: probes.measured,
        warmupId: probes.warmup,
        measuredRevision,
        warmupRevision,
      });
      measuredRevision = scale * rowsPerScale + 1;
      warmupRevision = scale * rowsPerScale + 1;
    },
    warmup: async (_db, _scale, repetition) => {
      await fixture.commands.recordProgress(
        fixture.actor,
        probes.warmup,
        { revision: warmupRevision, amount: '1' },
        `growth-session-record-warmup-${repetition}-${key()}`,
      );
      warmupRevision += 1;
    },
    operation: async (_db, _scale, repetition) => {
      await fixture.commands.recordProgress(
        fixture.actor,
        probes.measured,
        { revision: measuredRevision, amount: '1' },
        `growth-session-record-${repetition}-${key()}`,
      );
      measuredRevision += 1;
    },
  });
  expectConstantStatements(report);
  expectNoLibraryScans(report);
  reportSamples('Session record', report);
});

async function transitionCheck(action: 'complete' | 'abandon', fixture: Fixture): Promise<void> {
  const probeByRepetition = new Map<number, string>();
  let nextRepetition = 0;
  const report = await checkGrowth(database, {
    name: `session ${action}`,
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => {
      await grow(fixture, previous, scale);
      for (let offset = 0; offset < repetitionsPerScale; offset += 1) {
        const ordinal = previous * rowsPerScale + 1 + offset;
        probeByRepetition.set(nextRepetition, routed('20000000', fixture.route, ordinal));
        nextRepetition += 1;
      }
    },
    warmup: async (_db, _scale, repetition) => {
      const sessionId = probeByRepetition.get(repetition)!;
      await fixture.commands[action === 'complete' ? 'completeSession' : 'abandonSession'](
        fixture.actor,
        sessionId,
        { revision: 2 },
        `growth-session-${action}-warmup-${repetition}-${key()}`,
      );
    },
    operation: async (_db, _scale, repetition) => {
      const sessionId = probeByRepetition.get(repetition)!;
      await fixture.commands[action === 'complete' ? 'completeSession' : 'abandonSession'](
        fixture.actor,
        sessionId,
        { revision: 2 },
        `growth-session-${action}-${repetition}-${key()}`,
      );
    },
  });
  expectConstantStatements(report);
  expectNoLibraryScans(report);
  reportSamples(`Session ${action}`, report);
}

test('Session complete has constant rows and statements as sessions grow', async () => {
  await transitionCheck('complete', fixtures[2]!);
});

test('Session abandon has constant rows and statements as sessions grow', async () => {
  await transitionCheck('abandon', fixtures[3]!);
});

test('Session first and next subject owner unit and change pages retain bounded native work', async () => {
  const fixture = fixtures[4]!;
  const sessionId = routed('20000000', fixture.route, 1);
  const report = await checkGrowth(database, {
    name: 'session first and next pages',
    scales: [1, 4, 16],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => {
      await grow(fixture, previous, scale);
      const input = [fixture.route, sessionId, previous * rowsPerScale + 3, scale * rowsPerScale + 2, recordedAt];
      await database.admin.query(
        `INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
        SELECT $1, $2, 'page-' || lpad(n::text, 8, '0'), $5::timestamptz
        FROM generate_series($3::int, $4::int) n`,
        input,
      );
      await database.admin.query(
        `INSERT INTO library.progress_change
        (route, session_id, change_no, intent, recorded_at, transaction_id)
        SELECT $1, $2, n, '{"add":["sparse"]}'::jsonb, $5::timestamptz, $2
        FROM generate_series($3::int, $4::int) n`,
        input,
      );
    },
    operation: async () => {
      const subject = await fixture.commands.listSessions(fixture.actor, fixture.subjectId, { limit: 100 });
      const subjectNext = await fixture.commands.listSessions(fixture.actor, fixture.subjectId, {
        limit: 100,
        cursor: subject.next!,
      });
      expect(new Set([...subject.sessions, ...subjectNext.sessions].map((row) => row.id)).size).toBe(200);
      const owner = await fixture.commands.listOwnerSessions(fixture.actor, {}, { limit: 50 });
      const ownerNext = await fixture.commands.listOwnerSessions(fixture.actor, {}, { limit: 50, cursor: owner.next! });
      expect(new Set([...owner.sessions, ...ownerNext.sessions].map((row) => row.session.id)).size).toBe(100);
      const units = await fixture.commands.listUnits(fixture.actor, sessionId, { limit: 100 });
      const unitsNext = await fixture.commands.listUnits(fixture.actor, sessionId, { limit: 100, cursor: units.next! });
      expect(new Set([...units.units, ...unitsNext.units].map((row) => row.unitId)).size).toBe(200);
      const changes = await fixture.commands.listChanges(fixture.actor, sessionId, { limit: 100 });
      const changesNext = await fixture.commands.listChanges(fixture.actor, sessionId, {
        limit: 100,
        cursor: changes.next!,
      });
      expect(new Set([...changes.changes, ...changesNext.changes].map((row) => row.changeNo)).size).toBe(200);
    },
  });
  expectConstantStatements(report);
  expectNoLibraryScans(report);
  reportSamples('Session first and next pages', report);
});
