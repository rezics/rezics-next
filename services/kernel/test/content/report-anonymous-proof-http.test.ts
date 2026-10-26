import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createTurnstileVerifier } from '../../src/content/turnstile.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(61);
const reportEvent = 'com.rezics.content.report.created.v1';

function provider() {
  const issued = new Set<string>();
  const verifier = createTurnstileVerifier({
    secret: 'anonymous-report-test-secret',
    hostname: 'kernel.test',
    action: 'report',
    fetch: async (url, init) => {
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('secret')).toBe('anonymous-report-test-secret');
      expect(init?.signal).toBeDefined();
      const token = form.get('response')!;
      return Response.json({ success: issued.delete(token), hostname: 'kernel.test', action: 'report' });
    },
  });
  return {
    verifier,
    mint: () => {
      const token = randomUUID();
      issued.add(token);
      return token;
    },
  };
}

describe('anonymous report proof over the real kernel and migrated PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let app: ReturnType<typeof createKernel>;
  let movedTarget: Awaited<ReturnType<typeof threadTarget>> | undefined;
  let priorPartition: { write_state: string; moved_to: string | null } | undefined;
  let peer = 0;
  const remote = provider();

  beforeAll(async () => {
    db = await openGrowthDatabase();
    app = createKernel({
      pool: db.pool,
      routeKey,
      reports: { anonymousVerifier: remote.verifier },
      writeRate: createWriteRateLimiter({ secret: 'anonymous-report-test-rate-secret-at-least-32-bytes' }),
      ratePeer: () => `2001:db8:${(++peer).toString(16)}::1`,
    });
  });

  afterAll(async () => {
    if (movedTarget) {
      await db.admin.query('UPDATE core.partition SET write_state=$2, moved_to=$3 WHERE partition_no=$1', [
        partitionOf(routeOf(movedTarget.threadId)!),
        priorPartition?.write_state ?? 'active',
        priorPartition?.moved_to ?? null,
      ]);
    }
    await db?.close();
  });

  async function threadTarget(route: number) {
    const boardId = newId(route);
    const threadId = newId(route);
    const postId = newId(route);
    const revisionId = newId(route);
    const actorId = newId(route);
    const transactionId = randomUUID();
    const subjectId = newId(route);
    const document = Buffer.from(JSON.stringify(fromPlainText('Anonymous report target body')));
    const digest = createHash('sha256').update(document).digest();
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.board
           (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, 'Anonymous report board', 'published', 1, $4)`,
        [route, boardId, subjectId, transactionId],
      );
      await client.query(
        `INSERT INTO content.thread
           (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
            recorded_transaction_id, first_post_id)
         VALUES ($1, $2, $3, $4, 'Anonymous report thread', 'published', 1, $5, $6)`,
        [route, threadId, actorId, boardId, transactionId, postId],
      );
      await client.query(
        `INSERT INTO content.post
           (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision,
            recorded_transaction_id)
         VALUES ($1, $2, $3, $4, $5, 'published', 1, $6)`,
        [route, threadId, postId, actorId, revisionId, transactionId],
      );
      await client.query(
        `INSERT INTO content.revision
           (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
            subject_ids, board_id, availability, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'Anonymous report target body', 'MIT', $7, $8, 'available', $9)`,
        [route, threadId, postId, revisionId, document, digest, [subjectId], boardId, transactionId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { boardId, threadId, route };
  }

  async function call(
    target: Awaited<ReturnType<typeof threadTarget>>,
    key: string,
    extra: Record<string, unknown> = {},
  ) {
    const response = await app.handle(
      new Request('http://kernel.test/v1/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) },
        body: JSON.stringify({
          target: { kind: 'thread', id: target.threadId },
          reason: 'spam',
          evidence: 'Anonymous report evidence',
          ...extra,
        }),
      }),
    );
    return { response, body: await response.json() };
  }

  async function reportEffects(targetId: string, key: string) {
    const [reports, receipts, outbox] = await Promise.all([
      db.admin.query('SELECT report_id FROM content.report WHERE target_kind=$1 AND target_id=$2', [
        'thread',
        targetId,
      ]),
      db.admin.query(
        `SELECT idempotency_key FROM core.receipt
         WHERE principal_kind='anonymous' AND command_kind='content.report.create' AND idempotency_key=$1`,
        [key],
      ),
      db.admin.query("SELECT position FROM core.outbox WHERE type=$1 AND data->>'targetId'=$2", [
        reportEvent,
        targetId,
      ]),
    ]);
    return { reports: reports.rows, receipts: receipts.rows, outbox: outbox.rows };
  }

  async function expectNoReportEffects(targetId: string, key: string) {
    const effects = await reportEffects(targetId, key);
    expect(effects.reports).toHaveLength(0);
    expect(effects.receipts).toHaveLength(0);
    expect(effects.outbox).toHaveLength(0);
  }

  test('readable thread needs provider proof and only accepted proof creates a report', async () => {
    const target = await threadTarget(0x5a11);
    const readable = await app.handle(new Request(`http://kernel.test/v1/threads/${target.threadId}`));
    expect(readable.status).toBe(200);
    const key = randomUUID();

    const missing = await call(target, key);
    expect(missing.response.status).toBe(403);
    expect(missing.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    await expectNoReportEffects(target.threadId, key);

    const rejected = await call(target, key, { botToken: 'rejected-by-provider' });
    expect(rejected.response.status).toBe(403);
    expect(rejected.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    await expectNoReportEffects(target.threadId, key);

    const asserted = await call(target, key, { verified: true });
    expect(asserted.response.status).toBe(400);
    expect(asserted.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    await expectNoReportEffects(target.threadId, key);

    const accepted = await call(target, key, { botToken: remote.mint() });
    expect(accepted.response.status).toBe(201);
    expect(accepted.body.reportId).toEqual(expect.any(String));
    const effects = await reportEffects(target.threadId, key);
    expect(effects.reports).toHaveLength(1);
    expect(effects.receipts).toHaveLength(1);
    expect(effects.outbox).toHaveLength(1);
  });

  test('moved report target partition maps to partition_unavailable with retry guidance', async () => {
    movedTarget = await threadTarget(0x5a21);
    const partition = partitionOf(routeOf(movedTarget.threadId)!);
    const prior = await db.admin.query<{ write_state: string; moved_to: string | null }>(
      'SELECT write_state, moved_to FROM core.partition WHERE partition_no=$1',
      [partition],
    );
    priorPartition = prior.rows[0];
    await db.admin.query(
      "UPDATE core.partition SET write_state='moved', moved_to='content-node-2' WHERE partition_no=$1",
      [partition],
    );
    const key = randomUUID();
    const before = await reportEffects(movedTarget.threadId, key);
    const result = await call(movedTarget, key, { botToken: remote.mint() });
    expect(result.response.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'partition_unavailable', effect_status: 'not_applied' });
    expect(result.response.headers.get('retry-after')).toBe('1');
    expect(await reportEffects(movedTarget.threadId, key)).toEqual(before);
  });
});
