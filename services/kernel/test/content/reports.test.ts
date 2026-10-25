import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { IdempotencyConflictError, principalCommandIdentity } from '../../src/command/command.ts';
import { createThread } from '../../src/content/commands.ts';
import { revisePost } from '../../src/content/commands.ts';
import { applyReportEffect, createReportEffect } from '../../src/content/report-effect.ts';
import {
  createReport,
  listTargetReports,
  readReport,
  type ReportInput,
  type ReportTarget,
} from '../../src/content/reports.ts';
import { createTurnstileVerifier } from '../../src/content/turnstile.ts';
import type { Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

let system: NativeContentSystem;
let governanceBearer: string;
let governanceAccountId: string;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const routeKey = new Uint8Array(32).fill(71);
let verifications = 0;
const verifier = createTurnstileVerifier({
  secret: 'report-fixture-secret',
  hostname: 'reports.example.test',
  action: 'report',
  fetch: async (_url, init) => {
    verifications++;
    const form = new URLSearchParams(String(init?.body));
    return Response.json({
      success: form.get('response')?.startsWith('one-use-proof-') === true,
      hostname: 'reports.example.test',
      action: 'report',
    });
  },
});
const proof = () => `one-use-proof-${randomUUID()}`;
const context = (idempotencyKey: string = randomUUID()) => ({
  idempotencyKey,
  requestId: randomUUID(),
  deadline: Date.now() + 30_000,
});
const readContext = (actor: Actor) => ({ actor, deadline: Date.now() + 30_000 });
const deps = (pool = system.database.pool) => ({ pool, access: system.access, routeKey, anonymousVerifier: verifier });
const resource = (target: ReportTarget) => ({ route: routeOf(target.id)!, id: target.id });
const grantRanges = new Map<string, string>();
const grantKey = (target: ReportTarget, actorId: string, action: string) => `${target.id}:${actorId}:${action}`;

async function accountActor(bearer: string) {
  const actor = await system.access.authenticate(bearer, {
    pool: system.database.pool,
    deadline: Date.now() + 30_000,
  });
  if (actor.kind !== 'account') throw new Error('Fixture credential must authenticate an account');
  return actor;
}

beforeAll(async () => {
  system = await createNativeContentSystem({ databaseUrl });
  const { rows } = await system.database.pool.query(
    'SELECT account_id FROM access.governance_bootstrap WHERE route=0 AND resource_id=$1',
    ['00000000-0000-8000-8000-000000000000'],
  );
  governanceAccountId = rows[0]!.account_id;
  governanceBearer = (
    await system.auth.issue({
      accountId: rows[0]!.account_id,
      clientId: system.auth.ordinaryClient.id,
      scopes: [...system.actions.keys()].filter((action) => action !== 'media:complete'),
    })
  ).bearer;
}, 30_000);
afterAll(async () => {
  await system?.close();
});

async function permission(path: string, body: unknown, bearer = governanceBearer) {
  const { response } = await system.transport.capture(
    new Request(`https://content.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`Fixture permission ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as { grant: { valid: string } };
}

async function grant(target: ReportTarget, actorId: string, action: string) {
  const result = await permission(
    '/v1/grants',
    {
      resource: resource(target),
      subject: { kind: 'account', id: actorId },
      actions: [action],
      valid: '(,)',
    },
    target.kind === 'board' ? system.actors.moderator.bearer : governanceBearer,
  );
  grantRanges.set(grantKey(target, actorId, action), result.grant.valid);
}

async function revoke(target: ReportTarget, actorId: string, action: string) {
  await permission('/v1/grants:revoke', {
    resource: resource(target),
    subject: { kind: 'account', id: actorId },
    actions: [action],
    valid: grantRanges.get(grantKey(target, actorId, action)),
  });
}

async function fixture() {
  const board: ReportTarget = { kind: 'board', id: newId(0x1270) };
  // Privileged fixture setup creates the parent only. Reports always use the production command.
  await system.database.pool.query(
    `INSERT INTO content.board
       (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Reports fixture','published',1,$4)`,
    [routeOf(board.id), board.id, newId(0x5600), randomUUID()],
  );
  await provisionGrantAuthority(board, ['thread:create'], system.actors.moderator.actor.accountId);
  const author = await accountActor(system.actors.author.bearer);
  await grant(board, author.accountId, 'thread:create');
  const created = await createThread(
    { pool: system.database.pool, access: system.access, routeKey },
    author,
    {
      boardId: board.id,
      subjectIds: [newId(0x6700)],
      title: 'Exact target',
      licence: 'CC-BY-SA-4.0',
      visibility: 'published',
      body: fromPlainText('Original'),
    },
    context(),
  );
  const target: ReportTarget = { kind: 'post', id: created.value.itemId };
  await provisionGrantAuthority(target, ['report:create', 'reaction:set', 'moderation:read_reports']);
  // A separate setup grantor keeps each real actor within its native write budget.
  await provisionGrantAuthority(target, ['reaction:set'], author.accountId);
  const standing = await permission(
    '/v1/roleGrants',
    {
      resource: resource(target),
      subject: { kind: 'active_accounts' },
      role: 'content.post.standing',
      valid: '(,)',
    },
    system.actors.author.bearer,
  );
  const input: ReportInput = {
    target,
    revisionId: created.value.revisionId,
    reason: 'other',
    evidence: 'Evidence',
  };
  const moderator = await accountActor(system.actors.moderator.bearer);
  await grant(target, author.accountId, 'report:create');
  await grant(target, moderator.accountId, 'moderation:read_reports');
  return { board, author, moderator, target, input, created, standingValid: standing.grant.valid };
}

async function provisionGrantAuthority(target: ReportTarget, actions: string[], accountId = governanceAccountId) {
  // Account subjects use the shared Access identity storage discriminant.
  await system.database.pool.query(
    `INSERT INTO access.resource_grant
       (route,resource_id,subject_kind,subject_id,subject_role,action,valid,transaction_id)
     SELECT $1,$2,'identity',$3,'',action,'(,)'::tstzrange,$4
     FROM unnest($5::text[]) AS action`,
    [routeOf(target.id), target.id, accountId, randomUUID(), ['access:grant', ...actions]],
  );
}

async function nativeReport(id: string, pool = system.database.pool) {
  const { rows } = await pool.query('SELECT * FROM content.report WHERE route=$1 AND report_id=$2', [routeOf(id), id]);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function reportEvent(id: string) {
  const effect = createReportEffect(system.database.pool);
  const { projectBatch } = await import('../../src/events/log.ts');
  let delivered = 0;
  // Explicit bounded projection barrier; only persisted outbox events are delivered.
  for (let batch = 0; batch < 20 && delivered === 0; batch++) {
    const delivery = await projectBatch(system.database.pool, {
      consumer: `reports_${id.replaceAll('-', '')}`,
      partition: partitionOf(routeOf(id)!),
      apply: async (envelopes) => {
        for (const envelope of envelopes) {
          for (const event of envelope.events) {
            if (effect.types.includes(event.type)) {
              await effect.run(event);
              if ((event.data as { reportId: string }).reportId === id) {
                await applyReportEffect(system.database.pool, event);
                delivered++;
                expect(JSON.stringify(event.data)).not.toContain('Evidence');
              }
            }
          }
        }
      },
    });
    if (batch === 0 && delivery.status === 'stopped') {
      const { rows } = await system.database.pool.query(
        'SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
        [partitionOf(routeOf(id)!), (delivery.position + 1n).toString()],
      );
      console.error('Report projection stopped', {
        reason: delivery.reason,
        partition: partitionOf(routeOf(id)!),
        position: (delivery.position + 1n).toString(),
        types: rows.map((row) => row.type),
      });
    }
  }
  expect(delivered).toBe(1);
}

test('reports persist as independently anchored exact target records', async () => {
  const f = await fixture();
  const before = await system.database.pool.query(
    'SELECT visibility,security_revision FROM content.post WHERE route=$1 AND post_id=$2',
    [routeOf(f.target.id), f.target.id],
  );
  const request = context();
  const result = await createReport(deps(), f.author, f.input, request);
  expect(result.value).toEqual({ reportId: expect.any(String) });
  expect(result.replayed).toBe(false);
  const row = await nativeReport(result.value.reportId);
  expect(row).toMatchObject({
    route: routeOf(result.value.reportId),
    report_id: result.value.reportId,
    target_kind: 'post',
    target_id: f.target.id,
    revision_id: f.input.revisionId,
    evidence: 'Evidence',
    reporter_account_id: f.author.accountId,
  });
  expect(result.value.reportId).not.toBe(f.target.id);
  expect((await createReport(deps(), f.author, f.input, request)).replayed).toBe(true);
  await expect(createReport(deps(), f.author, { ...f.input, evidence: 'Changed' }, request)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  const after = await system.database.pool.query(
    'SELECT visibility,security_revision FROM content.post WHERE route=$1 AND post_id=$2',
    [routeOf(f.target.id), f.target.id],
  );
  expect(after.rows).toEqual(before.rows);
  expect(
    (
      await system.database.pool.query('SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
        routeOf(result.value.reportId),
        result.value.reportId,
      ])
    ).rows,
  ).toEqual([]);
  await reportEvent(result.value.reportId);
});

test('anonymous UUIDv4 receipt replay and digest conflict use shared pipeline', async () => {
  const f = await fixture();
  const anonymous = { kind: 'anonymous' } as const;
  expect(principalCommandIdentity(anonymous)).toEqual({
    principal: { kind: 'anonymous', id: '00000000-0000-0000-0000-000000000000' },
    basis: { clientId: null, requestedBy: null },
  });
  const key = randomUUID();
  const start = verifications;
  const first = await createReport(deps(), anonymous, f.input, { ...context(key.toUpperCase()), botToken: proof() });
  const replay = await createReport(deps(), anonymous, f.input, { ...context(key), botToken: proof() });
  expect(replay.value).toEqual(first.value);
  expect(replay.replayed).toBe(true);
  expect(verifications - start).toBe(2);
  const row = await nativeReport(first.value.reportId);
  expect(row.reporter_account_id).toBeNull();
  expect(JSON.stringify(row)).not.toContain('one-use-proof-');
  const receipt = await system.database.pool.query(
    `SELECT principal_kind,principal_id,response FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='anonymous' AND principal_id=$2
       AND command_kind='content.report.create' AND idempotency_key=$3`,
    [partitionOf(routeOf(first.value.reportId)!), '00000000-0000-0000-0000-000000000000', key],
  );
  expect(receipt.rows).toEqual([
    { principal_kind: 'anonymous', principal_id: '00000000-0000-0000-0000-000000000000', response: first.value },
  ]);
  for (const change of [
    { evidence: 'Changed evidence' },
    { revisionId: newId(routeOf(f.target.id)!) },
    { target: f.board },
  ]) {
    await expect(
      createReport(deps(), anonymous, { ...f.input, ...change }, { ...context(key), botToken: proof() }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  }
  await reportEvent(first.value.reportId);
});

test('missing proof and malformed anonymous possession keys deny; authenticated grants require scope and disclosure', async () => {
  const f = await fixture();
  for (const key of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', Bun.randomUUIDv7()]) {
    await expect(
      createReport(deps(), { kind: 'anonymous' }, f.input, { ...context(key), botToken: proof() }),
    ).rejects.toThrow();
  }
  await expect(createReport(deps(), { kind: 'anonymous' }, f.input, context())).rejects.toThrow();
  await expect(
    createReport({ pool: system.database.pool, access: system.access, routeKey }, { kind: 'anonymous' }, f.input, {
      ...context(),
      botToken: proof(),
    }),
  ).rejects.toThrow();
  const credential = await system.auth.issue({
    accountId: f.author.accountId,
    clientId: f.author.clientId,
    scopes: [],
  });
  await expect(createReport(deps(), credential.actor, f.input, context())).rejects.toThrow();
  await revoke(f.target, f.author.accountId, 'report:create');
  await permission(
    '/v1/roleGrants:revoke',
    {
      resource: resource(f.target),
      subject: { kind: 'active_accounts' },
      role: 'content.post.standing',
      valid: f.standingValid,
    },
    system.actors.author.bearer,
  );
  await expect(createReport(deps(), f.author, f.input, context())).rejects.toThrow();
});

test('revoked anonymous eligibility denies replay without disclosing stored report or evidence', async () => {
  const f = await fixture();
  const request = context();
  const result = await createReport(deps(), { kind: 'anonymous' }, f.input, { ...request, botToken: proof() });
  await system.database.pool.query(
    "UPDATE content.post SET visibility='protected',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
    [routeOf(f.target.id), f.target.id],
  );
  const denied = await createReport(deps(), { kind: 'anonymous' }, f.input, { ...request, botToken: proof() }).catch(
    (error: unknown) => error,
  );
  expect(denied).toBeInstanceOf(Error);
  expect(JSON.stringify(denied)).not.toContain(result.value.reportId);
  expect(JSON.stringify(denied)).not.toContain(f.input.evidence!);
  expect((await nativeReport(result.value.reportId)).evidence).toBe(f.input.evidence);
});

test('invalid exact revision leaves no partial record and later revisions do not replace reported bytes', async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(
    createReport(deps(), f.author, { ...f.input, revisionId: other.input.revisionId! }, context()),
  ).rejects.toThrow();
  const result = await createReport(deps(), f.author, f.input, context());
  await revisePost(
    { pool: system.database.pool, access: system.access, routeKey },
    f.author,
    {
      threadId: f.created.value.threadId,
      itemId: f.target.id,
      body: fromPlainText('Revised'),
    },
    context(),
  );
  const read = await readReport(deps(), result.value.reportId, readContext(f.moderator));
  expect(read.value).toMatchObject({ revisionId: f.input.revisionId, evidence: f.input.evidence });
});

test('moderator inspection resolves anchored records without joining partitions', async () => {
  const f = await fixture();
  const other = await fixture();
  const reports = [];
  for (const current of [f, other]) {
    const result = await createReport(deps(), current.author, current.input, context());
    await reportEvent(result.value.reportId);
    reports.push(result.value.reportId);
    const page = await listTargetReports(deps(), current.target, readContext(current.moderator), undefined, 1);
    expect(page.entries.map((entry) => entry.id)).toEqual([result.value.reportId]);
    expect(page.entries[0]).toMatchObject({
      partition: partitionOf(routeOf(result.value.reportId)!),
      target: current.target,
    });
    for (const actor of [{ kind: 'anonymous' } as const, current.author, system.actors.other.actor]) {
      expect((await readReport(deps(), result.value.reportId, readContext(actor))).value).toBeNull();
      expect((await listTargetReports(deps(), current.target, readContext(actor))).entries).toEqual([]);
    }
    await revoke(current.target, current.moderator.accountId, 'moderation:read_reports');
    expect((await readReport(deps(), result.value.reportId, readContext(current.moderator))).value).toBeNull();
    expect((await listTargetReports(deps(), current.target, readContext(current.moderator))).entries).toEqual([]);
  }
  expect(routeOf(f.target.id)).not.toBe(routeOf(other.target.id));
  expect(routeOf(reports[0]!)).not.toBe(routeOf(f.target.id));
  expect((await readReport(deps(), newId(0x9810), readContext(f.moderator))).value).toBeNull();
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const f = await fixture();
  const db = await openGrowthDatabase(system.database.pool.options.connectionString);
  const grow = async (_db: { admin: Pool }, scale: number, previous: number) => {
    // Setup is outside capture. Same-target distractors exercise the hot reverse-index prefix.
    for (let index = previous; index < scale; index++) {
      const author = await accountActor(system.actors.author.bearer);
      const distractor = await createReport(deps(), author, { ...f.input, evidence: `Distractor ${index}` }, context());
      await reportEvent(distractor.value.reportId);
    }
  };
  try {
    const report = await checkGrowth(db, {
      name: 'report create, reverse projection and bounded moderator inspection',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow,
      operation: async (observed, _scale, repetition) => {
        const author = await system.access.authenticate(system.actors.author.bearer, {
          pool: observed.pool,
          deadline: Date.now() + 30_000,
        });
        const moderator = await system.access.authenticate(system.actors.moderator.bearer, {
          pool: observed.pool,
          deadline: Date.now() + 30_000,
        });
        const result = await createReport(deps(observed.pool), author, f.input, context(`growth-${repetition}`));
        const exact = await readReport(deps(observed.pool), result.value.reportId, readContext(moderator));
        expect(exact.value?.id).toBe(result.value.reportId);
        const page = await listTargetReports(deps(observed.pool), f.target, readContext(moderator), undefined, 1);
        expect(page.entries).toHaveLength(1);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
    console.info(JSON.stringify(report));
  } finally {
    await db.close();
  }
}, 120_000);
