import { foregroundCounted } from './support/query-cost-meter.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { ContentCore, type ContentOutboxEvent } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor, ContentProjectionSaturated } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessGroups } from '../../../services/main/src/modules/access/groups.ts';
import { ACCESS_OPERATIONAL_BOUNDS_V1, activateOperationalBounds, assessOperationalBounds,
  OperationalBoundsInvalid } from '../../../services/main/src/operations/bounds.ts';
import { BACKPRESSURE_PROFILE_V1 } from '../../../services/main/src/operations/backpressure.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { startPostgresCluster } from '../support/postgres-cluster.ts';

const issuer = 'https://qa-operational-bounds.test';
const SCOPE = 'work:create:root';
const agentIri = () => `https://rezics.com/id/${randomUUID()}`;

function requireTier(): string {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  return Bun.env.REZICS_QA_RUN_ID;
}

/** Access-only Main surface: the claimed routes never reach the graph. */
function mainFor(accessPool: Pool, subjects: Map<string, string>) {
  const work = {
    environment: { fuseki: {} as FusekiClient,
      lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() }, objectDirectory: '/nonexistent' },
    account: { verify: async (request: Request) => {
      const subject = subjects.get(request.headers.get('authorization') ?? '');
      if (!subject) throw new Error('unknown QA bearer');
      return { issuer, subject };
    } },
    access: {},
    actingContexts: new AccessActingContexts(accessPool),
    groups: new AccessGroups(accessPool),
  } as unknown as MainWorkDependencies;
  return createMainApp({} as FusekiClient, work);
}

function countingPool(pool: Pool): { pool: Pool; calls: () => number } {
  let calls = 0;
  return { calls: () => calls, pool: { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property === 'query') return (...args: unknown[]) => {
        if (foregroundCounted()) calls += 1;
        return (target.query as (...values: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } } as unknown as Pool };
}

async function principal(pool: Pool, subjects: Map<string, string>) {
  const id = randomUUID();
  const subject = randomUUID();
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [id, issuer, subject]);
  const bearer = `Bearer ${randomUUID()}`;
  subjects.set(bearer, subject);
  return { id, bearer };
}

async function agents(pool: Pool, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, agentIri);
  await pool.query(`INSERT INTO access.authority_subject (id, kind)
    SELECT id, 'agent' FROM unnest($1::text[]) AS id`, [ids]);
  return ids;
}

async function represent(pool: Pool, principalId: string, subjects: string[], action = 'work.create') {
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    SELECT gen_random_uuid(), $2, subject, $3, now() + interval '1 hour'
    FROM unnest($1::text[]) AS subject`, [subjects, principalId, action]);
}

async function grant(pool: Pool, subjects: string[], action = 'work.create') {
  await pool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    SELECT gen_random_uuid(), subject, subject, $2, $3, now() + interval '1 hour'
    FROM unnest($1::text[]) AS subject`, [subjects, SCOPE, action]);
}

async function problemCode(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

test('IAM35: high branching, negative checks, bulk work and a reduced operational limit stay bounded and typed', async () => {
  const databases = await cloneQaOwnerDatabases(requireTier(), ['account', 'access'], 'owner');
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const subjects = new Map<string, string>();
  try {
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [SCOPE]);
    const app = mainFor(accessPool, subjects);
    const discover = (bearer: string) => app.handle(new Request(
      'http://main.local/v1/me/acting-contexts?task=work.create', { headers: { authorization: bearer } }));
    const contextCount = async (bearer: string) => {
      const response = await discover(bearer);
      expect(response.status).toBe(200);
      return (await response.json() as { contexts: unknown[] }).contexts.length;
    };
    const activation = async () => (await accessPool.query<{ profile_id: string; state: string;
      generation: string }>(`SELECT profile_id, state, generation::text AS generation
      FROM access.operational_bounds_activation`)).rows;
    // Migration 170 activates the profile the Access owners enforced before it.
    expect(await activation()).toEqual([{ profile_id: ACCESS_OPERATIONAL_BOUNDS_V1.id,
      state: 'active', generation: '0' }]);
    expect(await activateOperationalBounds(accessPool, ACCESS_OPERATIONAL_BOUNDS_V1)).toMatchObject({
      status: 'active', profile: ACCESS_OPERATIONAL_BOUNDS_V1.id, reduced: [], generation: '0' });

    // High branching: 50 complete choices are returned complete; the 51st
    // candidate is a negative check (represented, never granted) and still
    // makes discovery unavailable instead of silently truncating the list.
    const wide = await principal(accessPool, subjects);
    const granted = await agents(accessPool, 50);
    await represent(accessPool, wide.id, granted);
    await grant(accessPool, granted);
    const atLimit = await discover(wide.bearer);
    expect(atLimit.status).toBe(200);
    const atLimitBody = await atLimit.json() as { contexts: unknown[]; complete: boolean };
    expect(atLimitBody.contexts).toHaveLength(50);
    expect(atLimitBody.complete).toBe(true);
    const [ungranted] = await agents(accessPool, 1);
    await represent(accessPool, wide.id, [ungranted!]);
    const overLimit = await discover(wide.bearer);
    expect(overLimit.status).toBe(503);
    expect(await problemCode(overLimit)).toBe('acting_context_unavailable');
    await accessPool.query('UPDATE access.representation SET active = false WHERE subject_id = $1', [ungranted]);
    const narrow = await principal(accessPool, subjects);
    const few = await agents(accessPool, 3);
    await represent(accessPool, narrow.id, few);
    await grant(accessPool, few);

    // Reducing the limit below saved grants activates the reduced profile as
    // restricted: the over-limit principal is typed unavailable, never served
    // under the wider old limit and never truncated to 40. Others are unaffected.
    const reduced = { ...ACCESS_OPERATIONAL_BOUNDS_V1, id: 'access-operational-bounds-v2',
      actingContexts: 40, groupDepth: 8 };
    const [first, second] = await Promise.all([activateOperationalBounds(accessPool, reduced),
      activateOperationalBounds(accessPool, reduced)]);
    // Concurrent activations serialize on the activation row and agree.
    for (const result of [first!, second!]) {
      expect(result).toMatchObject({ status: 'restricted', profile: reduced.id,
        violations: [{ bound: 'actingContexts', subject: 'principal-candidates', limit: 40, observed: 50 }] });
    }
    expect(new Set([first!.generation, second!.generation])).toEqual(new Set(['1', '2']));
    expect(first!.reduced.concat(second!.reduced)).toContain('actingContexts');
    expect(await activation()).toEqual([{ profile_id: reduced.id, state: 'restricted', generation: '2' }]);
    const restricted = await discover(wide.bearer);
    expect(restricted.status).toBe(503);
    expect(await problemCode(restricted)).toBe('acting_context_unavailable');
    expect(await contextCount(narrow.bearer)).toBe(3);
    // A profile identity is immutable: changed numbers need a new identity.
    await expect(activateOperationalBounds(accessPool, { ...reduced, actingContexts: 45 }))
      .rejects.toBeInstanceOf(OperationalBoundsInvalid);
    expect((await activation())[0]?.generation).toBe('2');

    // Migration: the operator revokes ten saved grants; reactivation reassesses
    // the same profile to active and discovery returns the admitted forty.
    await accessPool.query(`UPDATE access.representation SET active = false
      WHERE principal_id = $1 AND subject_id = ANY($2::text[])`, [wide.id, granted.slice(40)]);
    expect(await activateOperationalBounds(accessPool, reduced)).toMatchObject({
      status: 'active', profile: reduced.id, violations: [], generation: '3' });
    expect(await contextCount(wide.bearer)).toBe(40);

    // Deep ancestry under the active reduced profile: 8 edges are admitted,
    // a 9th parent edge makes the saved path typed unavailable.
    const deep = await principal(accessPool, subjects);
    const [member] = await agents(accessPool, 1);
    await represent(accessPool, deep.id, [member!]);
    const chain = Array.from({ length: 9 }, () => randomUUID());
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id, parent_id)
      VALUES ($1, $2, NULL)`, [chain[0], SCOPE]);
    for (let index = 1; index < chain.length; index++) {
      await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id, parent_id)
        VALUES ($1, $2, $3)`, [chain[index], SCOPE, chain[index - 1]]);
    }
    await accessPool.query(`INSERT INTO access.group_member (id, group_id, agent_subject)
      VALUES (gen_random_uuid(), $1, $2)`, [chain.at(-1), member]);
    await accessPool.query(`INSERT INTO access.group_permission_grant
      (id, group_id, issuer_subject, scope_id, action, valid_until)
      VALUES (gen_random_uuid(), $1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [chain[0], member, SCOPE]);
    expect(await contextCount(deep.bearer)).toBe(1);
    const above = randomUUID();
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id, parent_id)
      VALUES ($1, $2, NULL)`, [above, SCOPE]);
    await accessPool.query('UPDATE access.recipient_group SET parent_id = $1 WHERE id = $2', [above, chain[0]]);
    const tooDeepReduced = await discover(deep.bearer);
    expect(tooDeepReduced.status).toBe(503);
    // Discovery reports the over-depth group path as its own typed unavailability.
    expect(await problemCode(tooDeepReduced)).toBe('acting_context_unavailable');

    // Raising back to v1 reinterprets nothing saved; the 9-edge path is admitted again.
    expect(await activateOperationalBounds(accessPool, ACCESS_OPERATIONAL_BOUNDS_V1)).toMatchObject({
      status: 'active', profile: ACCESS_OPERATIONAL_BOUNDS_V1.id, previous: reduced.id,
      reduced: [], violations: [] });
    expect(await contextCount(deep.bearer)).toBe(1);

    // The 32-edge v1 limit: extend the chain to 32 edges, then one more.
    let top = above;
    for (let edges = 9; edges < 32; edges++) {
      const next = randomUUID();
      await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id, parent_id)
        VALUES ($1, $2, NULL)`, [next, SCOPE]);
      await accessPool.query('UPDATE access.recipient_group SET parent_id = $1 WHERE id = $2', [next, top]);
      top = next;
    }
    expect(await contextCount(deep.bearer)).toBe(1);
    const beyond = randomUUID();
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id, parent_id)
      VALUES ($1, $2, NULL)`, [beyond, SCOPE]);
    await accessPool.query('UPDATE access.recipient_group SET parent_id = $1 WHERE id = $2', [beyond, top]);
    const tooDeep = await discover(deep.bearer);
    expect(tooDeep.status).toBe(503);
    expect(await problemCode(tooDeep)).toBe('acting_context_unavailable');
    expect((await assessOperationalBounds(accessPool, ACCESS_OPERATIONAL_BOUNDS_V1)).violations)
      .toEqual([{ bound: 'groupDepth', subject: 'group-ancestry', limit: 32, observed: 33 }]);
    await accessPool.query('UPDATE access.recipient_group SET parent_id = NULL WHERE id = $1', [top]);
    expect(await contextCount(deep.bearer)).toBe(1);

    // Bulk work: the scope read admits 256 groups and refuses the 257th row.
    const manager = await principal(accessPool, subjects);
    const [issuerAgent] = await agents(accessPool, 1);
    await represent(accessPool, manager.id, [issuerAgent!], 'access.group.manage');
    await grant(accessPool, [issuerAgent!], 'access.group.manage');
    const scopeRead = () => app.handle(new Request(
      `http://main.local/v1/access/group-scope?issuerSubject=${encodeURIComponent(issuerAgent!)}`,
      { headers: { authorization: manager.bearer } }));
    const existing = Number((await accessPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM access.recipient_group WHERE scope_id = $1', [SCOPE])).rows[0]!.count);
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id)
      SELECT gen_random_uuid(), $2 FROM generate_series(1, $1::integer)`, [256 - existing, SCOPE]);
    const fullScope = await scopeRead();
    expect(fullScope.status).toBe(200);
    expect((await fullScope.json() as { groups: unknown[] }).groups).toHaveLength(256);
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id)
      VALUES (gen_random_uuid(), $1)`, [SCOPE]);
    const bulk = await scopeRead();
    expect(bulk.status).toBe(503);
    expect(await problemCode(bulk)).toBe('group_unavailable');
    expect((await assessOperationalBounds(accessPool, ACCESS_OPERATIONAL_BOUNDS_V1)).violations)
      .toEqual([{ bound: 'groupsPerScope', subject: 'groups', limit: 256, observed: 257 }]);

    // Without an activated profile every bounded owner path is typed unavailable.
    await accessPool.query('DELETE FROM access.operational_bounds_activation');
    const unactivated = await discover(narrow.bearer);
    expect(unactivated.status).toBe(503);
    expect(await problemCode(unactivated)).toBe('acting_context_unavailable');
  } finally {
    await accessPool.end();
    await databases.close();
  }
}, 180_000);

test('OPS05: discovery work stays within its derived bound across candidate and unrelated growth', async () => {
  const databases = await cloneQaOwnerDatabases(requireTier(), ['account', 'access'], 'owner');
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const subjects = new Map<string, string>();
  try {
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [SCOPE]);
    const counted = countingPool(accessPool);
    const contexts = new AccessActingContexts(counted.pool);
    const target = await principal(accessPool, subjects);
    const targetSubject = subjects.get(target.bearer)!;
    const observed: { candidates: number; unrelated: number; calls: number }[] = [];
    let candidates: string[] = [];
    let unrelated = 0;
    // Vary one dimension at a time over geometric scales, then combine them.
    for (const [candidateCount, unrelatedCount] of [[1, 0], [5, 0], [50, 0], [50, 100], [50, 1000]] as const) {
      if (candidateCount > candidates.length) {
        const added = await agents(accessPool, candidateCount - candidates.length);
        await represent(accessPool, target.id, added);
        await grant(accessPool, added);
        candidates = [...candidates, ...added];
      }
      if (unrelatedCount > unrelated) {
        // Unrelated principals each hold their own represented, granted Agent.
        const count = unrelatedCount - unrelated;
        const others = await agents(accessPool, count);
        const ids = Array.from({ length: count }, () => randomUUID());
        await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
          SELECT id, $2, gen_random_uuid()::text FROM unnest($1::uuid[]) AS id`, [ids, issuer]);
        await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
          SELECT gen_random_uuid(), p, s, 'work.create', now() + interval '1 hour'
          FROM unnest($1::uuid[], $2::text[]) AS pair(p, s)`, [ids, others]);
        await grant(accessPool, others);
        unrelated = unrelatedCount;
        await accessPool.query('ANALYZE access.representation, access.permission_grant');
      }
      const before = counted.calls();
      const result = await contexts.discover({ issuer, subject: targetSubject });
      observed.push({ candidates: candidateCount, unrelated: unrelatedCount, calls: counted.calls() - before });
      expect(result.complete).toBe(true);
      expect(result.contexts.map(row => row.actingSubject).sort()).toEqual([...candidates].sort());
    }
    // The derived plan is a fixed number of statements (transaction setup,
    // gate, preference, candidates, direct/group/role proofs); neither more
    // candidates nor more unrelated authority adds a round trip.
    expect(new Set(observed.map(row => row.calls)).size).toBe(1);
    expect(observed[0]!.calls).toBeLessThanOrEqual(15);
    // Just past the candidate bound the result is typed unavailable, with the
    // same fixed plan rather than a longer scan.
    const [extra] = await agents(accessPool, 1);
    await represent(accessPool, target.id, [extra!]);
    const before = counted.calls();
    await expect(contexts.discover({ issuer, subject: targetSubject })).rejects.toThrow('exceeds supported limit');
    expect(counted.calls() - before).toBeLessThanOrEqual(observed[0]!.calls);
    const plan = await accessPool.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT DISTINCT s.id FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
      WHERE r.principal_id = $1 AND r.action = 'work.create' AND r.active
        AND r.valid_until > clock_timestamp() ORDER BY s.id LIMIT 51`, [target.id]);
    const nodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) visit(child);
    };
    visit(plan.rows[0]!['QUERY PLAN'][0].Plan);
    const representationScan = nodes.find(node => node['Relation Name'] === 'representation');
    // 1,000 unrelated representations must not be read to find 51 candidates.
    expect(representationScan?.['Node Type']).not.toBe('Seq Scan');
    expect(Number(representationScan?.['Actual Rows'] ?? 0)
      + Number(representationScan?.['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(51);
    console.info(JSON.stringify({ acceptanceId: 'OPS05', scope: 'acting-context discovery',
      observed, representationScan: representationScan?.['Node Type'] }));
  } finally {
    await accessPool.end();
    await databases.close();
  }
}, 180_000);

test('OPS06: projection pending capacity is transactional and remains visible to backpressure', async () => {
  requireTier();
  const cluster = await startPostgresCluster();
  const contentPool = new Pool({ ...cluster.connection, max: 6 });
  const consumer = `capacity-${randomUUID()}`;
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const cursor = new ContentProjectionCursor(contentPool, BACKPRESSURE_PROFILE_V1.worker);
    const initial = await cursor.initialize(consumer);
    const legacyConsumer = `${consumer}-legacy`;
    await cursor.initialize(legacyConsumer);
    expect(initial.sequence).toBe('0');
    expect((await content.ownerPosition()).sequence).toBe('0');

    const sourcePrefix = `${consumer}-source`;
    await contentPool.query(`INSERT INTO content.receipt
      (operation_id, request_digest, action, outcome, data_epoch, sequence)
      SELECT $1 || '-' || n::text, repeat('a', 64), 'draft.save', 'rejected', $2::uuid, n
      FROM generate_series(1, 1002) AS series(n)`, [sourcePrefix, initial.dataEpoch]);
    await contentPool.query(`INSERT INTO content.outbox
      (id, data_epoch, sequence, operation_id, event_type, recipe, revision_id, payload)
      SELECT gen_random_uuid(), data_epoch, sequence, operation_id,
        'capacity.test', 'capacity-test-v1', NULL, jsonb_build_object('index', sequence)
      FROM content.receipt WHERE operation_id LIKE $1 || '-%'`, [sourcePrefix]);
    await contentPool.query('UPDATE content.owner_control SET sequence = 1002 WHERE singleton');
    const rows = await contentPool.query<{ id: string; data_epoch: string; sequence: string;
      operation_id: string; event_type: string; recipe: string; revision_id: string | null;
      payload: Record<string, unknown> }>(`SELECT id, data_epoch, sequence::text, operation_id,
      event_type, recipe, revision_id, payload FROM content.outbox
      WHERE data_epoch = $1 ORDER BY sequence`, [initial.dataEpoch]);
    expect(rows.rowCount).toBe(1002);
    const events: ContentOutboxEvent[] = rows.rows.map(row => ({ id: row.id,
      position: { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence },
      operationId: row.operation_id, eventType: row.event_type, recipe: row.recipe,
      revisionId: row.revision_id, payload: row.payload }));
    const at = (sequence: number) => events.find(event => event.position.sequence === String(sequence))!;

    // Recreate a pre-migration checkpoint, seed an over-cap backlog, then apply
    // the actual migration SQL to prove it counts and preserves legacy rows.
    await contentPool.query(`ALTER TABLE content.projection_checkpoint
      DROP CONSTRAINT projection_checkpoint_pending_count_nonnegative, DROP COLUMN pending_count`);
    await contentPool.query(`INSERT INTO content.projection_pending
      (consumer, data_epoch, sequence, event_id, target)
      SELECT $1, data_epoch, sequence, id,
        CASE WHEN sequence <= 9 THEN 'legacy:' || sequence::text ELSE 'legacy:1' END
      FROM content.outbox WHERE data_epoch = $2 AND sequence <= 1001 ORDER BY sequence`,
    [legacyConsumer, initial.dataEpoch]);
    await contentPool.query(`INSERT INTO content.projection_target
      (consumer, data_epoch, target, first_sequence)
      SELECT consumer, data_epoch, target, min(sequence) FROM content.projection_pending
      WHERE consumer = $1 GROUP BY consumer, data_epoch, target`, [legacyConsumer]);
    await contentPool.query(`UPDATE content.projection_checkpoint SET scan_sequence = 1001
      WHERE consumer = $1`, [legacyConsumer]);
    await contentPool.query(readFileSync(new URL(
      '../../../services/content/migrations/900_projection_pending_count.sql', import.meta.url), 'utf8'));
    expect((await contentPool.query<{ pending: string; pending_count: string }>(`SELECT
      (SELECT count(*) FROM content.projection_pending WHERE consumer=$1)::text AS pending,
      pending_count::text FROM content.projection_checkpoint WHERE consumer=$1`, [legacyConsumer])).rows[0])
      .toEqual({ pending: '1001', pending_count: '1001' });

    // Seed an existing 999-row backlog to test the exact boundary without
    // issuing a thousand setup transactions through the cursor.
    await contentPool.query(`INSERT INTO content.projection_pending
      (consumer, data_epoch, sequence, event_id, target)
      SELECT $1, data_epoch, sequence, id,
        CASE WHEN sequence <= 10 THEN 'target:' || sequence::text ELSE 'target:1' END
      FROM content.outbox WHERE data_epoch = $2 AND sequence <= 999 ORDER BY sequence`,
    [consumer, initial.dataEpoch]);
    await contentPool.query(`INSERT INTO content.projection_target
      (consumer, data_epoch, target, first_sequence)
      SELECT consumer, data_epoch, target, min(sequence) FROM content.projection_pending
      WHERE consumer = $1 GROUP BY consumer, data_epoch, target`, [consumer]);
    await contentPool.query(`UPDATE content.projection_checkpoint
      SET scan_sequence = 999, pending_count = 999 WHERE consumer = $1`, [consumer]);
    const atCapacityBoundary = await cursor.readScan(consumer);
    expect(atCapacityBoundary.sequence).toBe('999');
    expect(at(1000).position.sequence).toBe('1000');
    expect(at(1000).position.dataEpoch).toBe(atCapacityBoundary.dataEpoch);
    expect((await contentPool.query<{ pending_count: string }>(`SELECT pending_count::text
      FROM content.projection_checkpoint WHERE consumer = $1`, [consumer])).rows[0]?.pending_count).toBe('999');

    // A failed checkpoint update rolls back both the inserted row and count.
    await contentPool.query(`CREATE FUNCTION content.fail_capacity_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scan_sequence > OLD.scan_sequence THEN RAISE EXCEPTION 'capacity ack rollback'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_capacity_ack BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_capacity_ack()`);
    await expect(cursor.acknowledge(consumer, atCapacityBoundary, at(1000).position,
      { event: at(1000), target: 'target:1' })).rejects.toThrow('capacity ack rollback');
    await contentPool.query('DROP TRIGGER fail_capacity_ack ON content.projection_checkpoint');
    await contentPool.query('DROP FUNCTION content.fail_capacity_ack()');
    expect((await contentPool.query<{ pending_count: string; scan_sequence: string }>(`SELECT
      pending_count::text, scan_sequence::text FROM content.projection_checkpoint WHERE consumer = $1`,
    [consumer])).rows[0]).toEqual({ pending_count: '999', scan_sequence: '999' });
    expect((await contentPool.query('SELECT 1 FROM content.projection_pending WHERE consumer=$1 AND sequence=1000',
      [consumer])).rowCount).toBe(0);

    // Two restarted cursor instances race at one free slot. The checkpoint lock
    // admits one event; the other sees the advanced source position.
    const restarted = new ContentProjectionCursor(contentPool, BACKPRESSURE_PROFILE_V1.worker);
    const expected = await restarted.readScan(consumer);
    const concurrent = await Promise.allSettled([
      restarted.acknowledge(consumer, expected, at(1000).position,
        { event: at(1000), target: 'target:1' }),
      new ContentProjectionCursor(contentPool, BACKPRESSURE_PROFILE_V1.worker).acknowledge(
        consumer, expected, at(1000).position, { event: at(1000), target: 'target:1' }),
    ]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const checkpointConflict = concurrent.find(result => result.status === 'rejected');
    expect(checkpointConflict?.status === 'rejected' && checkpointConflict.reason).toMatchObject({
      message: 'projection checkpoint changed' });
    expect((await contentPool.query<{ pending_count: string }>(`SELECT pending_count::text
      FROM content.projection_checkpoint WHERE consumer=$1`, [consumer])).rows[0]?.pending_count).toBe('1000');
    await expect(restarted.acknowledge(consumer, await restarted.readScan(consumer), at(1001).position,
      { event: at(1001), target: 'target:1' })).rejects.toBeInstanceOf(ContentProjectionSaturated);
    expect((await restarted.readScan(consumer)).sequence).toBe('1000');
    expect((await restarted.read(consumer)).sequence).toBe('0');

    const app = createMainApp({} as FusekiClient, { contentProjection: { content, cursor: restarted, consumer }
    } as unknown as MainWorkDependencies);
    const snapshotResponse = await app.handle(new Request('http://main.local/v1/operations/backpressure'));
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as { lanes: [{ state: string; backlog: string | null;
      maxBacklog: number }, { state: string }, { state: string }] };
    expect(snapshot.lanes[0]).toMatchObject({ state: 'saturated', maxBacklog: 1000 });
    const refused = await app.handle(new Request('http://main.local/v1/content-drafts', { method: 'POST' }));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect((await refused.json() as { code: string }).code).toBe('backpressure_saturated');

    // Successful completion decrements the durable count; the refused source
    // position can then be retained without losing or skipping it.
    await restarted.finishRetry(consumer, at(1), true);
    expect((await contentPool.query<{ pending_count: string }>(`SELECT pending_count::text
      FROM content.projection_checkpoint WHERE consumer=$1`, [consumer])).rows[0]?.pending_count).toBe('999');
    await restarted.acknowledge(consumer, await restarted.readScan(consumer), at(1001).position,
      { event: at(1001), target: 'target:1' });
    expect((await restarted.readScan(consumer)).sequence).toBe('1001');
    expect((await contentPool.query<{ pending_count: string }>(`SELECT pending_count::text
      FROM content.projection_checkpoint WHERE consumer=$1`, [consumer])).rows[0]?.pending_count).toBe('1000');

    // An over-cap legacy consumer keeps all rows, refuses further retention, and
    // continues its fair bounded retry schedule until a completion frees a row.
    const legacy = new ContentProjectionCursor(contentPool, BACKPRESSURE_PROFILE_V1.worker);
    expect((await contentPool.query<{ pending: string; pending_count: string }>(`SELECT
      (SELECT count(*) FROM content.projection_pending WHERE consumer=$1)::text AS pending,
      pending_count::text FROM content.projection_checkpoint WHERE consumer=$1`, [legacyConsumer])).rows[0])
      .toEqual({ pending: '1001', pending_count: '1001' });
    await expect(legacy.acknowledge(legacyConsumer, await legacy.readScan(legacyConsumer), at(1002).position,
      { event: at(1002), target: 'legacy:new' })).rejects.toBeInstanceOf(ContentProjectionSaturated);
    const firstWave = await legacy.retries(legacyConsumer);
    expect(firstWave).toHaveLength(8);
    const firstSequences = new Set(firstWave.map(event => event.position.sequence));
    for (const event of firstWave) await legacy.finishRetry(legacyConsumer, event, false);
    const nextWave = await legacy.retries(legacyConsumer);
    expect(nextWave).toHaveLength(8);
    expect(nextWave.some(event => !firstSequences.has(event.position.sequence))).toBe(true);
    for (const event of nextWave) await legacy.finishRetry(legacyConsumer, event, false);
    expect((await contentPool.query<{ pending: string; pending_count: string }>(`SELECT
      (SELECT count(*) FROM content.projection_pending WHERE consumer=$1)::text AS pending,
      pending_count::text FROM content.projection_checkpoint WHERE consumer=$1`, [legacyConsumer])).rows[0])
      .toEqual({ pending: '1001', pending_count: '1001' });
    await legacy.finishRetry(legacyConsumer, nextWave[0]!, true);
    expect((await contentPool.query<{ pending: string; pending_count: string }>(`SELECT
      (SELECT count(*) FROM content.projection_pending WHERE consumer=$1)::text AS pending,
      pending_count::text FROM content.projection_checkpoint WHERE consumer=$1`, [legacyConsumer])).rows[0])
      .toEqual({ pending: '1000', pending_count: '1000' });
  } finally {
    await contentPool.end();
    cluster.remove();
  }
}, 180_000);
