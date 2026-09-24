import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentConflict, ContentCore, ContentUnavailable, type VariantIdentity } from '../src/core.ts';
import { migrateContent } from '../src/migrate.ts';

const root = resolve(import.meta.dir, '../../..');

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

test('WORK09/WORK10: Content core CAS, exact bytes, receipts, pins and outbox', async () => {
  const state = join(root, '.temp', `content-core-${crypto.randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  try {
    await migrateContent(pool);
    await migrateContent(pool);
    const core = new ContentCore(pool);
    const variant: VariantIdentity = { id: 'urn:rezics:variant:one', resourceId: 'urn:rezics:work:one',
      language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-hans' }, direction: 'ltr' };
    const metadata = { sourceRevision: 'urn:source:1', provenance: { translator: 'user-1' } };
    const updatedMetadata = { sourceRevision: 'urn:source:2', provenance: { translator: 'user-1', evidence: 'v2' } };
    const firstBody = '{ "body" : "第一版 Galaxy42", "blocks": [1,2] }';
    const first = await core.saveDraft({ operationId: 'save-1', variant, ...metadata, expectedHead: null,
      model: 'content-shape-v1', serializedJson: firstBody });
    expect(first.outcome).toBe('succeeded');
    expect(first.revisionId).toBeTruthy();
    expect((await core.saveDraft({ operationId: 'save-1', variant, ...metadata, expectedHead: null,
      model: 'content-shape-v1', serializedJson: firstBody })).replayed).toBe(true);
    await expect(core.saveDraft({ operationId: 'save-1', variant, ...metadata, expectedHead: null,
      model: 'content-shape-v1', serializedJson: '{"body":"different"}' })).rejects.toBeInstanceOf(ContentConflict);
    await expect(core.saveDraft({ operationId: 'bad-unicode', variant, ...metadata, expectedHead: first.revisionId,
      model: 'content-shape-v1', serializedJson: '{"body":"\uD800"}' })).rejects.toBeInstanceOf(ContentConflict);

    await pool.query(`CREATE FUNCTION content.reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id = 'save-rollback' THEN RAISE EXCEPTION 'forced outbox failure'; END IF;
      RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_test_event BEFORE INSERT ON content.outbox
      FOR EACH ROW EXECUTE FUNCTION content.reject_test_event()`);
    await expect(core.saveDraft({ operationId: 'save-rollback', variant, ...metadata, expectedHead: first.revisionId,
      model: 'content-shape-v1', serializedJson: '{"body":"must roll back"}' })).rejects.toThrow();
    expect((await pool.query('SELECT draft_head FROM content.variant WHERE id = $1', [variant.id])).rows[0].draft_head).toBe(first.revisionId!);
    expect((await pool.query('SELECT count(*)::int AS n FROM content.revision')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM content.receipt WHERE operation_id = $1', ['save-rollback'])).rows[0].n).toBe(0);
    await pool.query('DROP TRIGGER reject_test_event ON content.outbox');
    await pool.query('DROP FUNCTION content.reject_test_event()');

    const competing = await Promise.all([
      core.saveDraft({ operationId: 'save-2a', variant, ...updatedMetadata, expectedHead: first.revisionId,
        model: 'content-shape-v1', serializedJson: '{"body":"second A"}' }),
      core.saveDraft({ operationId: 'save-2b', variant, ...updatedMetadata, expectedHead: first.revisionId,
        model: 'content-shape-v1', serializedJson: '{"body":"second B"}' }),
    ]);
    expect(competing.map((result) => result.outcome).sort()).toEqual(['stale_head', 'succeeded']);
    const winner = competing.find((result) => result.outcome === 'succeeded')!;
    const loser = competing.find((result) => result.outcome === 'stale_head')!;
    expect((await pool.query('SELECT count(*)::int AS n FROM content.revision')).rows[0].n).toBe(2);
    expect((await core.saveDraft({ operationId: loser === competing[0] ? 'save-2a' : 'save-2b',
      variant, ...updatedMetadata, expectedHead: first.revisionId, model: 'content-shape-v1',
      serializedJson: loser === competing[0] ? '{"body":"second A"}' : '{"body":"second B"}' })).outcome).toBe('stale_head');

    const secondVariant: VariantIdentity = { ...variant, id: 'urn:rezics:variant:two' };
    const other = await core.saveDraft({ operationId: 'save-other', variant: secondVariant,
      sourceRevision: 'urn:source:3', provenance: { translator: 'user-2' },
      expectedHead: null, model: 'content-shape-v1', serializedJson: '{"body":"同语种另一个版本"}' });
    expect(other.outcome).toBe('succeeded');
    const exact = await core.readExactBatch([first.revisionId!, winner.revisionId!, other.revisionId!],
      async (ids) => new Set(ids.filter((id) => id !== other.revisionId)));
    expect(exact[0]?.status).toBe('available');
    if (exact[0]?.status !== 'available') throw new Error('exact revision unavailable');
    expect(exact[0].serializedJson).toBe(firstBody);
    expect(exact[0].reference.language).toEqual({ kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-hans' });
    expect(exact[0].reference.sourceRevision).toBe('urn:source:1');
    if (exact[1]?.status !== 'available') throw new Error('new revision unavailable');
    expect(exact[1].reference.sourceRevision).toBe('urn:source:2');
    expect(exact[2]?.status).toBe('denied');
    const missing = await core.readExactBatch([crypto.randomUUID()], async (ids) => new Set(ids));
    expect(missing[0]?.status).toBe('missing');

    await expect(core.preparePublication('publish-wrong', first.revisionId!, '0'.repeat(64)))
      .rejects.toBeInstanceOf(ContentUnavailable);
    const prepared = await core.preparePublication('publish-1', first.revisionId!, exact[0].reference.byteDigest);
    expect(prepared.reference.revisionId).toBe(first.revisionId!);
    expect(prepared.status).toBe('pending');
    expect(prepared.pinActive).toBe(true);
    expect((await core.preparePublication('publish-1', first.revisionId!, exact[0].reference.byteDigest)).replayed).toBe(true);
    const pending = await pool.query('SELECT status, pin_active FROM content.publication_preparation WHERE operation_id = $1', ['publish-1']);
    expect(pending.rows[0]).toMatchObject({ status: 'pending', pin_active: true });

    const proof = { outcome: 'active' as const, revisionId: first.revisionId!,
      receipt: 'urn:graph:receipt:1', dataEpoch: crypto.randomUUID(), sequence: '17' };
    await expect(core.settlePublication('settle-wrong', 'publish-1', { ...proof, revisionId: crypto.randomUUID() }))
      .rejects.toBeInstanceOf(ContentConflict);
    const settled = await core.settlePublication('settle-1', 'publish-1', proof);
    expect(settled.status).toBe('active');
    expect(settled.pinActive).toBe(true);
    expect((await core.settlePublication('settle-1', 'publish-1', proof)).replayed).toBe(true);
    await expect(core.settlePublication('settle-conflict', 'publish-1', { ...proof, outcome: 'rejected' }))
      .rejects.toBeInstanceOf(ContentConflict);

    const latest = await core.readExactBatch([winner.revisionId!], async (ids) => new Set(ids));
    if (latest[0]?.status !== 'available') throw new Error('new revision unavailable');
    await core.preparePublication('publish-2', winner.revisionId!, latest[0].reference.byteDigest);
    const rejected = await core.settlePublication('settle-2', 'publish-2',
      { outcome: 'rejected', revisionId: winner.revisionId!,
        receipt: 'urn:graph:receipt:2', dataEpoch: proof.dataEpoch, sequence: '18' });
    expect(rejected.pinActive).toBe(false);
    expect((await core.readExactBatch([winner.revisionId!], async (ids) => new Set(ids)))[0]?.status).toBe('available');

    const events = await core.readOutbox(first.position.dataEpoch, '0', 100);
    expect(events.length).toBe(8);
    expect(events.map((event) => event.eventType)).toContain('content.publication.rejected');
    expect(events.every((event, i) => i === 0 || BigInt(event.position.sequence) > BigInt(events[i - 1]!.position.sequence))).toBe(true);
    expect(events.every((event) => event.recipe === 'content-body-v1')).toBe(true);
    expect((await core.ownerPosition()).sequence).toBe(events.at(-1)!.position.sequence);
    await expect(pool.query('UPDATE content.revision SET byte_digest = $2 WHERE id = $1',
      [first.revisionId, '0'.repeat(64)])).rejects.toThrow();
    await expect(pool.query('DELETE FROM content.revision WHERE id = $1', [first.revisionId])).rejects.toThrow();
    await expect(pool.query('UPDATE content.receipt SET outcome = $2 WHERE operation_id = $1',
      ['save-1', 'rejected'])).rejects.toThrow();
    await expect(pool.query('UPDATE content.publication_preparation SET status = $2 WHERE operation_id = $1',
      ['publish-1', 'rejected'])).rejects.toThrow();
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
});
