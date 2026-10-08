import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentComments, commentTargetHasSource, contentCommentIntentDigest,
  resolveParagraphSelector } from '../src/comments.ts';
import { appendContentEvent, ContentCore, ContentUnavailable } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';
import { applyContentErasure, ContentErasureStale, openCommentSourceRevisions,
  probeContentErasure } from '../../main/src/modules/erasure/content.ts';

const root = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-source';
const annotation = 'authored annotation stays';
const neighbor = 'Opening paragraph';
const closing = 'Closing paragraph';
const sourceText = `${neighbor}\n${canary}\n${closing}`;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function cluster() {
  const state = join(root, '.temp', `comment-source-erasure-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  return { pool, async stop() {
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  } };
}

function workId() { return `https://rezics.com/id/${randomUUID()}`; }

test('comment source selectors clear once with the revision and cannot be restored by replay', async () => {
  const source = await cluster();
  const { pool } = source;
  const access = new Pool({ ...pool.options });
  try {
    await migrateContent(pool);
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL,
        released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL REFERENCES access.governance_preservation_hold(id),
        operation_id text NOT NULL, material_ref text NOT NULL, reason text NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (hold_id, operation_id, material_ref))`);
    const content = new ContentCore(pool);
    const comments = new ContentComments(pool);
    const placed = async (text = sourceText, quote = canary, body = annotation) => {
      const work = workId();
      const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
        variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
        serializedJson: JSON.stringify({ body: text }) });
      expect(saved.revisionId).toBeTruthy();
      const author = workId();
      const admissionId = randomUUID();
      const input = { revisionId: saved.revisionId!, resourceId: work, author, exact: quote, body };
      const comment = await comments.create({ ...input, admissionId, authorityEpoch: '1',
        scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
      return { work, revisionId: saved.revisionId!, author, admissionId, input, comment };
    };
    const copies = async (needle: string) => (await pool.query<{ place: string }>(`SELECT place FROM (
      SELECT 'comment.exact' AS place, c.exact AS value
        FROM content.comment c JOIN content.revision_erasure e ON e.revision_id = c.revision_id
      UNION ALL SELECT 'comment.prefix', c.prefix
        FROM content.comment c JOIN content.revision_erasure e ON e.revision_id = c.revision_id
      UNION ALL SELECT 'comment.suffix', c.suffix
        FROM content.comment c JOIN content.revision_erasure e ON e.revision_id = c.revision_id
      UNION ALL SELECT 'comment.body', c.body
        FROM content.comment c JOIN content.revision_erasure e ON e.revision_id = c.revision_id
      UNION ALL SELECT 'revision.body', r.body::text
        FROM content.revision r JOIN content.revision_erasure e ON e.revision_id = r.id
      UNION ALL SELECT 'revision.bytes', convert_from(r.serialized_bytes, 'UTF8')
        FROM content.revision r JOIN content.revision_erasure e ON e.revision_id = r.id
        WHERE r.serialized_bytes IS NOT NULL
      UNION ALL SELECT 'outbox', o.payload::text
        FROM content.outbox o JOIN content.revision_erasure e ON e.revision_id = o.revision_id
      UNION ALL SELECT 'receipt', coalesce(receipt.reason, '')
        FROM content.receipt receipt JOIN content.revision_erasure e ON e.revision_id = receipt.revision_id
    ) found WHERE value LIKE '%' || $1 || '%'`, [needle])).rows.map(row => row.place);
    const commentId = (comment: { comment: string }) => comment.comment.split('/').at(-1)!;
    const selectors = async (id: string) => (await pool.query<{ exact: string | null; prefix: string | null;
      suffix: string | null; body: string; author: string; request_digest: string; revision_id: string }>(
      `SELECT exact, prefix, suffix, body, author, request_digest, revision_id::text
       FROM content.comment WHERE id = $1`, [id])).rows[0]!;

    const fresh = await placed();
    const id = commentId(fresh.comment);
    if (!commentTargetHasSource(fresh.comment.target)) throw new Error('fresh comment has no source selector');
    expect(fresh.comment.target.selector.exact).toBe(canary);
    await expect(pool.query('UPDATE content.comment SET body = $2 WHERE id = $1', [id, 'rewritten']))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM content.comment WHERE id = $1', [id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE content.comment SET exact = NULL, prefix = NULL, suffix = NULL
      WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    expect((await selectors(id)).exact).toBe(canary);

    const held = await placed();
    const holdId = randomUUID();
    await pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
      VALUES ($1, $2, 'legal hold')`, [holdId, held.work]);
    const heldCommand = { preservationAccess: access, erasureId: randomUUID(), erasureEpoch: '4',
      resourceId: held.work, revisionIds: [held.revisionId] };
    await expect(applyContentErasure(pool, heldCommand)).rejects.toBeInstanceOf(ContentErasureStale);
    expect((await selectors(commentId(held.comment))).exact).toBe(canary);
    expect((await pool.query(`SELECT availability FROM content.revision WHERE id = $1`,
      [held.revisionId])).rows[0]?.availability).toBe('available');
    expect((await pool.query(`SELECT 1 FROM content.revision_erasure WHERE revision_id = $1`,
      [held.revisionId])).rowCount).toBe(0);
    expect((await pool.query(`SELECT reason FROM access.governance_erasure_postponement
      WHERE hold_id = $1`, [holdId])).rows[0]?.reason).toBe('legal hold');

    const blocked = await placed();
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM content.comment WHERE id = $1 FOR UPDATE',
        [commentId(blocked.comment)]);
      await expect(applyContentErasure(pool, { preservationAccess: access, erasureId: randomUUID(),
        erasureEpoch: '1', resourceId: blocked.work, revisionIds: [blocked.revisionId] })).rejects.toThrow();
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect((await selectors(commentId(blocked.comment))).exact).toBe(canary);
    expect((await pool.query('SELECT availability FROM content.revision WHERE id = $1',
      [blocked.revisionId])).rows[0]?.availability).toBe('available');

    const raceWork = workId();
    const raced = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: raceWork,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const raceVariant = (await pool.query<{ variant_id: string }>(
      'SELECT variant_id FROM content.revision WHERE id = $1', [raced.revisionId])).rows[0]!.variant_id;
    const share = await pool.connect();
    const raceErasureId = randomUUID();
    const raceCommentId = randomUUID();
    const raceInput = { revisionId: raced.revisionId!, resourceId: raceWork, author: workId(),
      exact: canary, body: annotation };
    try {
      await share.query('BEGIN');
      await share.query("SET LOCAL lock_timeout = '2s'");
      await share.query('SELECT id FROM content.revision WHERE id = $1 FOR SHARE', [raced.revisionId]);
      const erasing = applyContentErasure(pool, { preservationAccess: access, erasureId: raceErasureId,
        erasureEpoch: '1', resourceId: raceWork, revisionIds: [raced.revisionId!] });
      for (let attempt = 0; ; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%ORDER BY id FOR UPDATE%'`);
        if (waiting.rowCount) break;
        if (attempt === 200) throw new Error('erasure did not wait for the comment share lock');
        await Bun.sleep(10);
      }
      const { prefix, suffix } = resolveParagraphSelector(sourceText, canary);
      const raceOperation = `content-comment:${randomUUID()}`;
      await appendContentEvent(share, { operationId: raceOperation,
        requestDigest: contentCommentIntentDigest(raceInput), action: 'comment.create',
        outcome: 'succeeded', variantId: raceVariant, revisionId: raced.revisionId,
        eventType: 'content.comment.created', recipe: 'content-body-v1',
        payload: { comment: raceCommentId, revisionId: raced.revisionId } });
      await share.query(`INSERT INTO content.comment
        (id, operation_id, request_digest, revision_id, resource_id, variant_id,
          author, exact, prefix, suffix, body)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [raceCommentId, raceOperation, contentCommentIntentDigest(raceInput),
        raced.revisionId, raceWork, raceVariant, raceInput.author, canary, prefix, suffix, annotation]);
      await share.query('COMMIT');
      expect(await erasing).toEqual({ applied: 1 });
    } finally {
      await share.query('ROLLBACK').catch(() => undefined);
      share.release();
    }
    expect((await selectors(raceCommentId)).exact).toBeNull();
    expect((await selectors(raceCommentId)).body).toBe(annotation);
    const late = { revisionId: raced.revisionId!, resourceId: raceWork, author: workId(),
      exact: canary, body: 'late annotation' };
    await expect(comments.create({ ...late, admissionId: randomUUID(), authorityEpoch: '1',
      scope: `content:comment:${raceWork}`, requestDigest: contentCommentIntentDigest(late) }))
      .rejects.toBeInstanceOf(ContentUnavailable);
    expect((await pool.query('SELECT count(*)::int AS n FROM content.comment WHERE revision_id = $1',
      [raced.revisionId])).rows[0]?.n).toBe(1);

    const closedWork = workId();
    const closedDraft = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: closedWork,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const winner = await pool.connect();
    const closingCreate = { revisionId: closedDraft.revisionId!, resourceId: closedWork,
      author: workId(), exact: canary, body: 'should not land' };
    let creating: Promise<unknown> | undefined;
    try {
      await winner.query('BEGIN');
      await winner.query('SELECT id FROM content.revision WHERE id = $1 FOR UPDATE',
        [closedDraft.revisionId]);
      creating = comments.create({ ...closingCreate, admissionId: randomUUID(), authorityEpoch: '1',
        scope: `content:comment:${closedWork}`, requestDigest: contentCommentIntentDigest(closingCreate) });
      for (let attempt = 0; ; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FOR SHARE OF r%'`);
        if (waiting.rowCount) break;
        if (attempt === 200) throw new Error('comment create did not wait for the erasure lock');
        await Bun.sleep(10);
      }
      const closedErasure = randomUUID();
      await winner.query(`UPDATE content.revision SET availability = 'erased',
        serialized_bytes = NULL, body = NULL WHERE id = $1`, [closedDraft.revisionId]);
      await winner.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 3)`, [closedDraft.revisionId, closedErasure]);
      await winner.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[closedDraft.revisionId], closedErasure, '3']);
      await winner.query('COMMIT');
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
    }
    await expect(creating).rejects.toBeInstanceOf(ContentUnavailable);
    expect((await pool.query('SELECT count(*)::int AS n FROM content.comment WHERE revision_id = $1',
      [closedDraft.revisionId])).rows[0]?.n).toBe(0);

    const primary = await placed();
    const unrelatedQuote = 'OTHER-PASSAGE-η-kept';
    const unrelated = await placed(`${neighbor}\n${unrelatedQuote}\n${closing}`, unrelatedQuote,
      'unrelated annotation');
    const primaryId = commentId(primary.comment);
    const before = await selectors(primaryId);
    const receiptBefore = (await pool.query(`SELECT request_digest, action, outcome, revision_id::text
      FROM content.receipt WHERE operation_id = $1`, [`content-comment:${primary.admissionId}`])).rows[0];
    const erasureId = randomUUID();
    await pool.query('BEGIN');
    await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [primary.revisionId]);
    await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 7)`, [primary.revisionId, erasureId]);
    await pool.query('COMMIT');
    expect(await probeContentErasure(pool, erasureId, [primary.revisionId])).toEqual(new Map([
      [primary.revisionId, 'erased']]));
    expect(await openCommentSourceRevisions(pool, [primary.revisionId])).toEqual([primary.revisionId]);
    const wrong = { preservationAccess: access, erasureId: randomUUID(), erasureEpoch: '7',
      resourceId: primary.work, revisionIds: [primary.revisionId] };
    await expect(applyContentErasure(pool, wrong)).rejects.toBeInstanceOf(ContentErasureStale);
    await expect(applyContentErasure(pool, { ...wrong, erasureId, erasureEpoch: '8' }))
      .rejects.toBeInstanceOf(ContentErasureStale);
    expect((await selectors(primaryId)).exact).toBe(canary);
    expect(await applyContentErasure(pool, { preservationAccess: access, erasureId, erasureEpoch: '7',
      resourceId: primary.work, revisionIds: [primary.revisionId] })).toEqual({ applied: 0 });
    const cleared = await selectors(primaryId);
    expect(cleared.exact).toBeNull();
    expect(cleared.prefix).toBeNull();
    expect(cleared.suffix).toBeNull();
    expect(cleared.body).toBe(annotation);
    expect(cleared.author).toBe(before.author);
    expect(cleared.request_digest).toBe(before.request_digest);
    expect(cleared.revision_id).toBe(before.revision_id);
    expect((await pool.query(`SELECT request_digest, action, outcome, revision_id::text
      FROM content.receipt WHERE operation_id = $1`,
      [`content-comment:${primary.admissionId}`])).rows[0]).toEqual(receiptBefore);
    expect((await selectors(commentId(unrelated.comment))).exact).toBe(unrelatedQuote);
    expect(await openCommentSourceRevisions(pool, [primary.revisionId, unrelated.revisionId]))
      .toEqual([unrelated.revisionId]);
    expect(await copies(canary)).toEqual([]);
    const annotationCopies = await copies(annotation);
    expect(annotationCopies.length).toBeGreaterThan(0);
    expect(annotationCopies.every(place => place === 'comment.body')).toBe(true);
    await expect(pool.query(`UPDATE content.comment SET exact = NULL, prefix = NULL, suffix = NULL
      WHERE id = $1`, [primaryId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE content.comment SET author = $2 WHERE id = $1',
      [primaryId, workId()])).rejects.toMatchObject({ code: '23514' });
    expect(await applyContentErasure(pool, { preservationAccess: access, erasureId, erasureEpoch: '7',
      resourceId: primary.work, revisionIds: [primary.revisionId] })).toEqual({ applied: 0 });
    expect((await selectors(primaryId)).exact).toBeNull();

    const replay = await comments.create({ ...primary.input, admissionId: primary.admissionId,
      authorityEpoch: '1', scope: `content:comment:${primary.work}`,
      requestDigest: contentCommentIntentDigest(primary.input) });
    expect(replay.replayed).toBe(true);
    expect(replay.body).toBe(annotation);
    expect(commentTargetHasSource(replay.target)).toBe(false);
    expect(JSON.stringify(replay)).not.toContain(canary);
    const read = await comments.read(primaryId);
    expect(read?.body).toBe(annotation);
    expect(read && commentTargetHasSource(read.target)).toBe(false);
    const page = await comments.list(primary.revisionId, 1);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]?.body).toBe(annotation);
    expect(commentTargetHasSource(page.comments[0]!.target)).toBe(false);
    expect(JSON.stringify(page)).not.toContain(canary);

    // Negative component only: replica role skips triggers and puts the quote back.
    // It is not a backup, a retained journal, or a signed coverage replay.
    await pool.query('BEGIN');
    await pool.query(`SET LOCAL session_replication_role = replica`);
    await pool.query(`UPDATE content.comment SET exact = $2, prefix = 'Opening paragraph', suffix = 'Closing'
      WHERE id = $1`, [primaryId, canary]);
    await pool.query('COMMIT');
    expect((await comments.read(primaryId))?.target).toMatchObject({ selector: { exact: canary } });
    expect(await applyContentErasure(pool, { preservationAccess: access, erasureId, erasureEpoch: '7',
      resourceId: primary.work, revisionIds: [primary.revisionId] })).toEqual({ applied: 0 });
    expect((await selectors(primaryId)).exact).toBeNull();
    expect(JSON.stringify(await comments.read(primaryId))).not.toContain(canary);
    expect(await copies(canary)).toEqual([]);
    const again = await comments.create({ ...primary.input, admissionId: primary.admissionId,
      authorityEpoch: '1', scope: `content:comment:${primary.work}`,
      requestDigest: contentCommentIntentDigest(primary.input) });
    expect(JSON.stringify(again)).not.toContain(canary);
  } finally {
    await access.end();
    await source.stop();
  }
}, 30_000);

test('two journals in one transaction bind their own tombstones, and rollback restores both quotes', async () => {
  const source = await cluster();
  const { pool } = source;
  const access = new Pool({ ...pool.options });
  try {
    await migrateContent(pool);
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
        reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
    const content = new ContentCore(pool);
    const comments = new ContentComments(pool);
    const place = async () => {
      const work = workId();
      const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
        variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
        serializedJson: JSON.stringify({ body: sourceText }) });
      const input = { revisionId: saved.revisionId!, resourceId: work, author: workId(), exact: canary,
        body: annotation };
      const comment = await comments.create({ ...input, admissionId: randomUUID(), authorityEpoch: '3',
        scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
      return { work, revisionId: saved.revisionId!, commentId: comment.comment.split('/').at(-1)! };
    };
    const first = await place();
    const second = await place();
    const erasureA = randomUUID();
    const erasureB = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 11), ($3, $4, 12)`, [first.revisionId, erasureA, second.revisionId, erasureB]);
      await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = ANY($1::uuid[])`, [[first.revisionId, second.revisionId]]);
      await client.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[first.revisionId], erasureA, 11]);
      await client.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[second.revisionId], erasureB, 12]);
      await client.query(`SELECT set_config('rezics.comment_source_erasure_id', $1, true)`, [randomUUID()]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    for (const item of [first, second]) {
      const row = (await pool.query<{ exact: string | null; body: string }>(
        'SELECT exact, body FROM content.comment WHERE id = $1', [item.commentId])).rows[0]!;
      expect(row.exact).toBe(canary);
      expect(row.body).toBe(annotation);
    }
    const committed = await pool.connect();
    try {
      await committed.query('BEGIN');
      await committed.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 11), ($3, $4, 12)`, [first.revisionId, erasureA, second.revisionId, erasureB]);
      await committed.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = ANY($1::uuid[])`, [[first.revisionId, second.revisionId]]);
      await committed.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[first.revisionId], erasureA, 11]);
      await expect(committed.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[first.revisionId], erasureB, 12])).rejects.toMatchObject({ code: '23514' });
      await committed.query('ROLLBACK');
      await committed.query('BEGIN');
      await committed.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 11), ($3, $4, 12)`, [first.revisionId, erasureA, second.revisionId, erasureB]);
      await committed.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = ANY($1::uuid[])`, [[first.revisionId, second.revisionId]]);
      await committed.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[first.revisionId], erasureA, 11]);
      await committed.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, $3::bigint)',
        [[second.revisionId], erasureB, 12]);
      await committed.query('COMMIT');
    } finally { committed.release(); }
    for (const item of [first, second]) {
      const row = (await pool.query<{ exact: string | null; body: string; request_digest: string }>(
        'SELECT exact, body, request_digest FROM content.comment WHERE id = $1', [item.commentId])).rows[0]!;
      expect(row.exact).toBeNull();
      expect(row.body).toBe(annotation);
      expect(row.request_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const definition = (await pool.query<{ def: string }>(
      `SELECT pg_get_functiondef('content.erase_comment_sources(uuid[],uuid,bigint)'::regprocedure) AS def`)).rows[0]!.def;
    expect(definition).not.toContain('current_setting');
    expect(definition).not.toContain('set_config');
    expect((await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'comment_open_source_idx'`)).rowCount).toBe(1);
  } finally {
    await access.end();
    await source.stop();
  }
}, 30_000);

test('many comments clear under the erasure deadline, and a statement timeout rolls the tombstone back', async () => {
  const source = await cluster();
  const { pool } = source;
  const access = new Pool({ ...pool.options });
  try {
    await migrateContent(pool);
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
        reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
    const content = new ContentCore(pool);
    const work = workId();
    const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const revisionId = saved.revisionId!;
    const variant = (await pool.query<{ id: string }>('SELECT id FROM content.variant')).rows[0]!.id;
    await pool.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id, revision_id)
      SELECT 'fanout-' || g, repeat('ab', 32), 'comment.create', 'succeeded', $1, $2
      FROM generate_series(1, 100) g`, [variant, revisionId]);
    await pool.query(`INSERT INTO content.comment
      (id, operation_id, request_digest, revision_id, resource_id, variant_id, author, exact, prefix, suffix, body)
      SELECT gen_random_uuid(), operation_id, request_digest, revision_id, $1, $2, $3, $4, 'pre', 'suf', $5
      FROM content.receipt WHERE operation_id LIKE 'fanout-%'`,
    [work, variant, workId(), canary, annotation]);
    const started = Date.now();
    expect(await applyContentErasure(pool, { preservationAccess: access, erasureId: randomUUID(),
      erasureEpoch: '5', resourceId: work, revisionIds: [revisionId] })).toEqual({ applied: 1 });
    expect(Date.now() - started).toBeLessThan(5_000);
    const cleared = await pool.query<{ open: number; bodies: number }>(`SELECT
      count(*) FILTER (WHERE exact IS NOT NULL OR prefix IS NOT NULL OR suffix IS NOT NULL)::int AS open,
      count(*) FILTER (WHERE body = $2)::int AS bodies
      FROM content.comment WHERE revision_id = $1`, [revisionId, annotation]);
    expect(cleared.rows[0]).toEqual({ open: 0, bodies: 100 });

    const slowSaved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: workId(),
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const slowVariant = (await pool.query<{ id: string; resource_id: string }>(
      'SELECT v.id, v.resource_id FROM content.variant v JOIN content.revision r ON r.variant_id = v.id WHERE r.id = $1',
      [slowSaved.revisionId])).rows[0]!;
    await pool.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id, revision_id)
      VALUES ($1, repeat('cd', 32), 'comment.create', 'succeeded', $2, $3)`,
    [`slow-${randomUUID()}`, slowVariant.id, slowSaved.revisionId]);
    const slowReceipt = (await pool.query<{ operation_id: string; request_digest: string }>(
      `SELECT operation_id, request_digest FROM content.receipt WHERE revision_id = $1 AND operation_id LIKE 'slow-%'`,
      [slowSaved.revisionId])).rows[0]!;
    await pool.query(`INSERT INTO content.comment
      (id, operation_id, request_digest, revision_id, resource_id, variant_id, author, exact, prefix, suffix, body)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pre', 'suf', $9)`,
    [randomUUID(), slowReceipt.operation_id, slowReceipt.request_digest, slowSaved.revisionId,
      slowVariant.resource_id, slowVariant.id, workId(), canary, annotation]);
    await pool.query(`CREATE FUNCTION content.comment_source_delay() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER comment_source_delay BEFORE UPDATE ON content.comment
      FOR EACH ROW EXECUTE FUNCTION content.comment_source_delay()`);
    const slowErasure = randomUUID();
    await expect(applyContentErasure(pool, { preservationAccess: access, erasureId: slowErasure,
      erasureEpoch: '6', resourceId: slowVariant.resource_id, revisionIds: [slowSaved.revisionId!] }))
      .rejects.toMatchObject({ code: '57014' });
    expect((await pool.query('SELECT 1 FROM content.revision_erasure WHERE erasure_id = $1',
      [slowErasure])).rowCount).toBe(0);
    expect((await pool.query<{ exact: string; availability: string }>(`SELECT c.exact, r.availability
      FROM content.comment c JOIN content.revision r ON r.id = c.revision_id
      WHERE c.revision_id = $1`, [slowSaved.revisionId])).rows[0]).toEqual({ exact: canary, availability: 'available' });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS comment_source_delay ON content.comment').catch(() => undefined);
    await pool.query('DROP FUNCTION IF EXISTS content.comment_source_delay()').catch(() => undefined);
    await access.end();
    await source.stop();
  }
}, 30_000);

test('migration 1708 leaves a pre-existing quote in place until an erasure names its tombstone', async () => {
  const source = await cluster();
  const { pool } = source;
  const prior = join(root, '.temp', `comment-source-prior-${randomUUID()}`);
  try {
    mkdirSync(prior, { recursive: true });
    const migrations = join(root, 'services/content/migrations');
    for (const name of readdirSync(migrations)) {
      if (name === '1708_comment_source_erasure.sql') continue;
      cpSync(join(migrations, name), join(prior, name));
    }
    await migrateContent(pool, prior);
    const content = new ContentCore(pool);
    const comments = new ContentComments(pool);
    const work = workId();
    const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const input = { revisionId: saved.revisionId!, resourceId: work, author: workId(), exact: canary,
      body: annotation };
    const created = await comments.create({ ...input, admissionId: randomUUID(), authorityEpoch: '1',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
    const id = created.comment.split('/').at(-1)!;
    await pool.query(readFileSync(join(migrations, '1708_comment_source_erasure.sql'), 'utf8'));
    const row = (await pool.query<{ exact: string; body: string }>(
      'SELECT exact, body FROM content.comment WHERE id = $1', [id])).rows[0]!;
    expect(row.exact).toBe(canary);
    expect(row.body).toBe(annotation);
    expect((await pool.query(`SELECT 1 FROM content.schema_migration WHERE version = 1708`)).rowCount).toBe(0);
  } finally {
    await source.stop();
    rmSync(prior, { recursive: true, force: true });
  }
}, 30_000);

async function draftedRevision(pool: Pool) {
  const content = new ContentCore(pool);
  const work = workId();
  const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
    variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
    serializedJson: JSON.stringify({ body: sourceText }) });
  const revisionId = saved.revisionId!;
  const variant = (await pool.query<{ variant_id: string }>(
    'SELECT variant_id FROM content.revision WHERE id = $1', [revisionId])).rows[0]!.variant_id;
  return { work, revisionId, variant };
}

test('a direct insert waits behind comment source erasure and then cannot add a selector', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const { work, revisionId, variant } = await draftedRevision(pool);
    const erasure = randomUUID();
    const erasing = await pool.connect();
    const inserting = await pool.connect();
    try {
      await erasing.query('BEGIN');
      await erasing.query(`UPDATE content.revision SET availability = 'erased',
        serialized_bytes = NULL, body = NULL WHERE id = $1`, [revisionId]);
      await erasing.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 7)`, [revisionId, erasure]);
      await erasing.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 7)', [[revisionId], erasure]);
      await inserting.query('BEGIN');
      const insertingPid = (await inserting.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const commentId = randomUUID();
      const operation = `content-comment:${randomUUID()}`;
      const digest = 'ab'.repeat(32);
      // The receipt's revision foreign key waits on the erasure lock before the
      // comment insert reaches its own share lock. One promise covers both.
      const outcome = (async () => {
        await appendContentEvent(inserting, { operationId: operation, requestDigest: digest,
          action: 'comment.create', outcome: 'succeeded', variantId: variant, revisionId,
          eventType: 'content.comment.created', recipe: 'content-body-v1',
          payload: { comment: commentId, revisionId } });
        await inserting.query(`INSERT INTO content.comment
          (id, operation_id, request_digest, revision_id, resource_id, variant_id,
            author, exact, prefix, suffix, body)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pre', 'suf', $9)`,
        [commentId, operation, digest, revisionId, work, variant, workId(), canary, annotation]);
        return 'inserted';
      })().catch((error: { code?: string }) => `rejected:${error.code}`);
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE pid = $1 AND wait_event_type = 'Lock'`, [insertingPid])).rowCount ?? 0;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(1);
      await erasing.query('COMMIT');
      expect(await outcome).toBe('rejected:23514');
      await inserting.query('ROLLBACK');
    } finally {
      await erasing.query('ROLLBACK').catch(() => undefined);
      await inserting.query('ROLLBACK').catch(() => undefined);
      erasing.release();
      inserting.release();
    }
    expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM content.comment
      WHERE revision_id = $1 AND (exact IS NOT NULL OR prefix IS NOT NULL OR suffix IS NOT NULL)`,
    [revisionId])).rows[0]?.n).toBe(0);
  } finally { await source.stop(); }
}, 60_000);

test('a lock on cleared comment history does not block replay and the update uses the open-source index', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const { work, revisionId, variant } = await draftedRevision(pool);
    await pool.query(`INSERT INTO content.receipt
      (operation_id, request_digest, action, outcome, variant_id, revision_id)
      SELECT 'cleared-' || g, repeat('ab', 32), 'comment.create', 'succeeded', $1, $2
      FROM generate_series(1, 40) g`, [variant, revisionId]);
    await pool.query(`INSERT INTO content.comment
      (id, operation_id, request_digest, revision_id, resource_id, variant_id, author, exact, prefix, suffix, body)
      SELECT gen_random_uuid(), operation_id, request_digest, revision_id, $1, $2, $3, $4, 'pre', 'suf', $5
      FROM content.receipt WHERE operation_id LIKE 'cleared-%'`,
    [work, variant, workId(), canary, annotation]);
    const erasure = randomUUID();
    await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [revisionId]);
    await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 8)`, [revisionId, erasure]);
    expect((await pool.query<{ n: number }>(
      'SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 8) AS n', [[revisionId], erasure])).rows[0]?.n)
      .toBe(40);
    const cleared = (await pool.query<{ id: string }>(
      'SELECT id FROM content.comment WHERE revision_id = $1 LIMIT 1', [revisionId])).rows[0]!.id;
    const holder = await pool.connect();
    const replay = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM content.comment WHERE id = $1 FOR UPDATE', [cleared]);
      await replay.query('BEGIN');
      await replay.query("SET LOCAL lock_timeout = '500ms'");
      const result = await replay.query<{ n: number }>(
        'SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 8) AS n', [[revisionId], erasure]);
      expect(result.rows[0]?.n).toBe(0);
      await replay.query('COMMIT');
    } finally {
      await replay.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      replay.release();
      holder.release();
    }
    const definition = (await pool.query<{ def: string; prosrc: string }>(`SELECT
      pg_get_functiondef('content.erase_comment_sources(uuid[],uuid,bigint)'::regprocedure) AS def,
      prosrc FROM pg_proc
      WHERE oid = 'content.erase_comment_sources(uuid[],uuid,bigint)'::regprocedure`)).rows[0]!;
    expect(definition.def).not.toContain('current_setting');
    expect(definition.def).not.toContain('set_config');
    expect(definition.prosrc).toContain("EXECUTE 'SHOW transaction_isolation' INTO isolation");
    expect(definition.prosrc.slice(0, definition.prosrc.indexOf('UPDATE content.comment')))
      .not.toContain('content.comment');
    const update = definition.def.match(/UPDATE content\.comment[\s\S]*?;/)?.[0]
      ?.replace(/\brevision_ids\b/g, '$1::uuid[]');
    if (!update) throw new Error('comment source update statement is missing');
    await pool.query('ANALYZE content.comment');
    const planned = await pool.connect();
    try {
      await planned.query('BEGIN');
      await planned.query('SET LOCAL enable_seqscan = off');
      const plan = (await planned.query<Record<string, string>>(`EXPLAIN (ANALYZE, TIMING OFF) ${update}`,
        [[revisionId]])).rows.map(row => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('comment_open_source_idx');
      expect(plan).not.toContain('Seq Scan');
      await planned.query('ROLLBACK');
    } finally {
      await planned.query('ROLLBACK').catch(() => undefined);
      planned.release();
    }
  } finally { await source.stop(); }
}, 60_000);

test('repeatable read refuses after a revision lock wait instead of missing a quote committed during it', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const { work, revisionId, variant } = await draftedRevision(pool);
    const lockRow = await draftedRevision(pool);
    const erasure = randomUUID();
    const holder = await pool.connect();
    const early = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM content.revision WHERE id = $1 FOR UPDATE', [revisionId]);
      await early.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const earlyPid = (await early.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const started = Date.now();
      await expect(early.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 9)',
        [[revisionId], erasure])).rejects.toMatchObject({ code: '25000' });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock'`, [earlyPid])).rowCount).toBe(0);
      await early.query('ROLLBACK');
    } finally {
      await early.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      early.release();
      holder.release();
    }

    // The waited row is a different revision, so committing the quote does not
    // change the locked tuple. After the wait the snapshot still misses it.
    const snapshot = await pool.connect();
    const writer = await pool.connect();
    const gate = await pool.connect();
    try {
      await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await snapshot.query('SELECT count(*)::int AS n FROM content.comment WHERE revision_id = $1', [revisionId]);
      const snapshotPid = (await snapshot.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM content.revision WHERE id = $1 FOR UPDATE', [lockRow.revisionId]);
      const waitingLock = snapshot.query('SELECT id FROM content.revision WHERE id = $1 FOR UPDATE',
        [lockRow.revisionId]);
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE pid = $1 AND wait_event_type = 'Lock'`, [snapshotPid])).rowCount ?? 0;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(1);
      const commentId = randomUUID();
      const operation = `content-comment:${randomUUID()}`;
      const digest = 'cd'.repeat(32);
      await writer.query('BEGIN');
      await appendContentEvent(writer, { operationId: operation, requestDigest: digest,
        action: 'comment.create', outcome: 'succeeded', variantId: variant, revisionId,
        eventType: 'content.comment.created', recipe: 'content-body-v1',
        payload: { comment: commentId, revisionId } });
      await writer.query(`INSERT INTO content.comment
        (id, operation_id, request_digest, revision_id, resource_id, variant_id,
          author, exact, prefix, suffix, body)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pre', 'suf', $9)`,
      [commentId, operation, digest, revisionId, work, variant, workId(), canary, annotation]);
      await writer.query(`UPDATE content.revision SET availability = 'erased',
        serialized_bytes = NULL, body = NULL WHERE id = $1`, [revisionId]);
      await writer.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 9)`, [revisionId, erasure]);
      await writer.query('COMMIT');
      await gate.query('COMMIT');
      await waitingLock;
      expect((await snapshot.query<{ n: number }>(`SELECT count(*)::int AS n FROM content.comment
        WHERE revision_id = $1 AND exact IS NOT NULL`, [revisionId])).rows[0]?.n).toBe(0);
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM content.comment
        WHERE revision_id = $1 AND exact IS NOT NULL`, [revisionId])).rows[0]?.n).toBe(1);
      await expect(snapshot.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 9)',
        [[revisionId], erasure])).rejects.toMatchObject({ code: '25000' });
      await snapshot.query('ROLLBACK');
    } finally {
      await snapshot.query('ROLLBACK').catch(() => undefined);
      await writer.query('ROLLBACK').catch(() => undefined);
      await gate.query('ROLLBACK').catch(() => undefined);
      snapshot.release();
      writer.release();
      gate.release();
    }
    expect((await pool.query<{ exact: string; body: string }>(
      'SELECT exact, body FROM content.comment WHERE revision_id = $1', [revisionId])).rows[0])
      .toEqual({ exact: canary, body: annotation });
    expect((await pool.query<{ n: number }>(
      'SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 9) AS n', [[revisionId], erasure])).rows[0]?.n)
      .toBe(1);
    expect((await pool.query<{ exact: string | null; body: string }>(
      'SELECT exact, body FROM content.comment WHERE revision_id = $1', [revisionId])).rows[0])
      .toEqual({ exact: null, body: annotation });
  } finally { await source.stop(); }
}, 60_000);
