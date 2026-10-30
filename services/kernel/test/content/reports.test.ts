import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
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
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { seedReportGrowth, type ReportGrowthRow } from './support/report-growth.ts';

let system: NativeContentSystem;
let permissionKernel: ReturnType<typeof createKernel>;
let governanceBearer: string;
let schemeId: string;
let conceptId: string;
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
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl },
    JSON.stringify({
      'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
      member: { write: { maximum: 10_000, seconds: 86_400 } },
    }),
  );
  // Unmeasured growth setup uses public grants with a budget sized for its fixed background.
  permissionKernel = createKernel({
    pool: system.database.pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    access: () => system.access,
    writeRate: createWriteRateLimiter({
      secret: randomUUID() + randomUUID(),
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10_000, seconds: 60 } } }),
    }),
  });
  await bootstrapRelease(system.database.pool, bundledRelease);
  const { rows } = await system.database.pool.query(
    'SELECT account_id FROM access.governance_bootstrap WHERE route=0 AND resource_id=$1',
    [PLATFORM_RESOURCE.id],
  );
  const governance = await system.auth.issue({
    accountId: rows[0]!.account_id,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['access:grant', 'moderation:read_reports'],
  });
  governanceBearer = governance.bearer;
  if (!governance.actor.scopes.includes('moderation:read_reports'))
    throw new Error('Governance credential lacks report inspection scope');
  const { subject: scheme } = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Reports fixture scheme' },
  });
  const { subject: concept } = await command<{ subject: { id: string } }>('POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Reports fixture concept' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  schemeId = scheme.id;
  conceptId = concept.id;
}, 30_000);
afterAll(async () => {
  await system?.close();
});
beforeEach(() => {
  grantRanges.clear();
});

async function permission(path: string, body: unknown, bearer = governanceBearer) {
  const response = await permissionKernel.handle(
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

async function command<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  bearer = system.actors.moderator.bearer,
  headers: Record<string, string> = {},
): Promise<T> {
  const { response } = await system.transport.capture(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`Fixture command ${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function readReportHttp(reportId: string, bearer: string): Promise<Response> {
  const { response } = await system.transport.capture(
    new Request(`https://content.test/v1/reports/${reportId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
  return response;
}

async function grant(target: ReportTarget, actorId: string, action: string) {
  const result = await permission('/v1/grants', {
    resource: resource(target),
    subject: { kind: 'account', id: actorId },
    actions: [action],
    valid: '(,)',
  });
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
  const { space } = await command<{ space: { spaceId: string } }>('POST', '/v1/spaces', {
    title: 'Reports fixture space',
    summary: 'Reports fixture space',
  });
  const { realm } = await command<{ realm: { realmId: string; headRevisionId: string } }>('POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Reports fixture Realm',
    summary: 'Reports fixture Realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  await command<unknown>(
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId },
    system.actors.moderator.bearer,
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  const { board: createdBoard } = await command<{ board: { id: string } }>(
    'POST',
    `/v1/realms/${realm.realmId}/boards`,
    {
      conceptId,
      title: 'Reports fixture board',
      visibility: 'published',
    },
  );
  const board: ReportTarget = { kind: 'board', id: createdBoard.id };
  const author = await accountActor(system.actors.author.bearer);
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
  await grant(target, author.accountId, 'access:grant');
  const authorGrantor = await system.auth.issue({
    accountId: author.accountId,
    clientId: author.clientId,
    scopes: ['access:grant', 'reaction:set', 'report:create'],
  });
  const standing = await system.database.pool.query<{ valid: string }>(
    `SELECT valid::text AS valid FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND grant_role='content.post.standing' AND upper_inf(valid)`,
    [routeOf(target.id), target.id],
  );
  if (standing.rows.length !== 1) throw new Error('Fixture post standing role was not installed');
  const input: ReportInput = {
    target,
    revisionId: created.value.revisionId,
    reason: 'other',
    evidence: 'Evidence',
  };
  const moderator = await accountActor(system.actors.moderator.bearer);
  await grant(target, moderator.accountId, 'moderation:read_reports');
  return {
    board,
    author,
    authorGrantor: authorGrantor.bearer,
    moderator,
    target,
    input,
    created,
    standingValid: standing.rows[0]!.valid,
  };
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
  // Explicit projection barrier; only persisted outbox events are delivered. One consumer per
  // partition resumes after the events it has passed, so a new report reads only the log's new tail.
  for (let batch = 0; batch < 1000 && delivered === 0; batch++) {
    const delivery = await projectBatch(system.database.pool, {
      consumer: `reports_partition_${partitionOf(routeOf(id)!)}`,
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
    if (delivery.status === 'stopped') {
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
      break;
    }
    if (delivery.status === 'read' && delivery.envelopes === 0) break;
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
  await permission(
    '/v1/roleGrants:revoke',
    {
      resource: resource(f.target),
      subject: { kind: 'active_accounts' },
      role: 'content.post.standing',
      valid: f.standingValid,
    },
    f.authorGrantor,
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

test('reporters read only their own report through native account:read while moderators retain inspection', async () => {
  const f = await fixture();
  const result = await createReport(deps(), f.author, f.input, context());
  const owner = await system.auth.issue({
    accountId: f.author.accountId,
    clientId: f.author.clientId,
    scopes: ['account:read'],
  });
  const ownRead = await readReportHttp(result.value.reportId, owner.bearer);
  expect(ownRead.status).toBe(200);
  const ownBody = (await ownRead.json()) as { report: Record<string, unknown> };
  expect(ownBody.report).toMatchObject({
    id: result.value.reportId,
    target: f.target,
    reporterId: f.author.accountId,
    reason: f.input.reason,
    evidence: f.input.evidence,
  });
  expect(JSON.stringify(ownBody)).not.toContain('Original');

  const noScope = await system.auth.issue({
    accountId: f.author.accountId,
    clientId: f.author.clientId,
    scopes: [],
  });
  expect((await readReportHttp(result.value.reportId, noScope.bearer)).status).toBe(404);
  expect((await readReportHttp(result.value.reportId, system.actors.other.bearer)).status).toBe(404);

  const limitedClientId = `reports-read-${randomUUID()}`;
  await system.nativeAuth.internal.registerClient({
    clientId: limitedClientId,
    firstParty: true,
    scopes: ['moderation:read_reports'],
  });
  const limitedClient = await system.auth.issue({
    accountId: f.author.accountId,
    clientId: limitedClientId,
    scopes: ['moderation:read_reports'],
  });
  expect((await readReportHttp(result.value.reportId, limitedClient.bearer)).status).toBe(404);
  await expect(
    system.auth.issue({
      accountId: f.author.accountId,
      clientId: limitedClientId,
      scopes: ['account:read'],
    }),
  ).rejects.toThrow();

  const unassignedRequest = `urn:rezics:request:${f.moderator.accountId}:${newId(routeOf(f.moderator.accountId)!)}`;
  await expect(
    system.auth.issue({
      accountId: f.author.accountId,
      clientId: f.author.clientId,
      scopes: ['account:read'],
      requestedBy: unassignedRequest,
    }),
  ).rejects.toThrow();

  const moderator = await system.auth.issue({
    accountId: f.moderator.accountId,
    clientId: f.moderator.clientId,
    scopes: ['moderation:read_reports'],
  });
  expect((await readReportHttp(result.value.reportId, moderator.bearer)).status).toBe(200);

  const anonymous = await createReport(deps(), { kind: 'anonymous' }, f.input, {
    ...context(),
    botToken: proof(),
  });
  expect((await readReportHttp(anonymous.value.reportId, owner.bearer)).status).toBe(404);
  expect((await readReport(deps(), anonymous.value.reportId, readContext({ kind: 'anonymous' }))).value).toBeNull();

  await system.database.pool.query(
    `UPDATE content.report
     SET evidence=NULL, reporter_account_id=NULL, reporter_erased=true
     WHERE route=$1 AND report_id=$2`,
    [routeOf(result.value.reportId), result.value.reportId],
  );
  expect((await readReportHttp(result.value.reportId, owner.bearer)).status).toBe(404);
  expect((await readReportHttp(result.value.reportId, system.actors.other.bearer)).status).toBe(404);
});

test('moderator inspection resolves anchored records without joining partitions', async () => {
  const f = await fixture();
  const other = await fixture();
  const otherActor = await accountActor(system.actors.other.bearer);
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
    expect((await readReport(deps(), result.value.reportId, readContext({ kind: 'anonymous' }))).value).toBeNull();
    expect((await readReport(deps(), result.value.reportId, readContext(current.author))).value).toMatchObject({
      id: result.value.reportId,
      reporterId: current.author.accountId,
      evidence: 'Evidence',
    });
    expect((await readReport(deps(), result.value.reportId, readContext(otherActor))).value).toBeNull();
    for (const actor of [{ kind: 'anonymous' } as const, current.author, otherActor])
      expect((await listTargetReports(deps(), current.target, readContext(actor))).entries).toEqual([]);
    await revoke(current.target, current.moderator.accountId, 'moderation:read_reports');
    expect((await readReport(deps(), result.value.reportId, readContext(current.moderator))).value).toBeNull();
    expect((await listTargetReports(deps(), current.target, readContext(current.moderator))).entries).toEqual([]);
  }
  expect(routeOf(f.target.id)).not.toBe(routeOf(other.target.id));
  expect(routeOf(reports[0]!)).not.toBe(routeOf(f.target.id));
  expect((await readReport(deps(), newId(0x9810), readContext(f.moderator))).value).toBeNull();
});

// Public grant commands and native report projection run outside the measured growth bound.
test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const f = await fixture();
  const db = await openGrowthDatabase(system.database.pool.options.connectionString);
  const renew = (actor: typeof f.author) =>
    system.auth.issue({ accountId: actor.accountId, clientId: actor.clientId, scopes: [...actor.scopes] });
  let authorBearer: string;
  let moderatorBearer: string;
  const grow = async (_db: { admin: Pool }, scale: number, previous: number) => {
    if (previous === 0) {
      // Fixed unrelated grant rows give the planner realistic statistics. The
      // actual report and moderator grants above still use public governance routes.
      const route = routeOf(f.target.id)!;
      const resources = Array.from({ length: 4096 }, () => newId(route));
      const transactions = resources.map(() => randomUUID());
      await _db.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         SELECT $1,resource_id,$2,'moderation:read_reports','(,)'::tstzrange,transaction_id
         FROM unnest($3::uuid[],$4::uuid[]) AS row(resource_id,transaction_id)`,
        [route, f.moderator.accountId, resources, transactions],
      );
      await _db.admin.query('ANALYZE access.resource_grant');
    }
    // Bulk rows retain the same target prefix and actual report projection
    // shape while keeping the measured API operation and its bounds unchanged.
    const targetRoute = routeOf(f.target.id)!;
    const rows: ReportGrowthRow[] = Array.from({ length: scale - previous }, (_, offset) => {
      const index = previous + offset;
      const reportRoute = (index * 31) % 65_536;
      return {
        reportId: newId(reportRoute),
        reportRoute,
        targetKind: 'post',
        targetId: f.target.id,
        targetRoute,
        createdAt: '2026-01-01T00:00:00.000Z',
        transactionId: randomUUID(),
        idempotencyKey: `growth-${randomUUID()}`,
        reporterAccountId: f.author.accountId,
      };
    });
    await seedReportGrowth(_db.admin, rows, [], {
      commandEvents: {
        principalId: f.author.accountId,
        principalKind: 'account',
        clientId: f.author.clientId,
      },
    });
    // Native tokens expire after five minutes; renew outside every measured scale.
    authorBearer = (await renew(f.author)).bearer;
    moderatorBearer = (await renew(f.moderator)).bearer;
  };
  try {
    const report = await checkGrowth(db, {
      name: 'report create, reverse projection and bounded reporter and moderator inspection',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow,
      operation: async (observed, _scale, repetition) => {
        const author = await system.access.authenticate(authorBearer, {
          pool: observed.pool,
          deadline: Date.now() + 30_000,
        });
        const moderator = await system.access.authenticate(moderatorBearer, {
          pool: observed.pool,
          deadline: Date.now() + 30_000,
        });
        const result = await createReport(deps(observed.pool), author, f.input, context(`growth-${repetition}`));
        const reporterRead = await readReport(deps(observed.pool), result.value.reportId, readContext(author));
        expect(reporterRead.value?.reporterId).toBe(author.accountId);
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
}, 600_000);
