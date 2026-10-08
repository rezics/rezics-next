import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
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
