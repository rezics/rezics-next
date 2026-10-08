import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentComments, commentTargetHasSource, contentCommentIntentDigest }
  from '../../../services/content/src/comments.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { applyContentErasure, openCommentSourceRevisions, probeContentErasure }
  from '../../../services/main/src/modules/erasure/content.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-source';
const annotation = 'authored annotation stays';
const sourceText = `Opening paragraph\n${canary}\nClosing paragraph`;

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

class OpenGraph extends FusekiClient {
  constructor() { super('http://comment-source-erasure.invalid'); }
  override async query(query: string): Promise<SparqlResult> {
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT')) return { results: { bindings: [] } };
    throw new Error(`unexpected comment source query: ${query.slice(0, 80)}`);
  }
}

test('journal replay clears restored comment quotes and the comment API does not return them', async () => {
  const state = join(root, '.temp', `comment-source-api-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 });
  const access = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 2 });
  try {
    await migrateContent(pool);
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
        reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
    const work = `https://rezics.com/id/${randomUUID()}`;
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const content = new ContentCore(pool);
    const comments = new ContentComments(pool);
    const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const admissionId = randomUUID();
    const input = { revisionId: saved.revisionId!, resourceId: work, author: actor, exact: canary,
      body: annotation };
    const created = await comments.create({ ...input, admissionId, authorityEpoch: '1',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
    const commentId = created.comment.split('/').at(-1)!;
    const erasureId = randomUUID();
    expect(await applyContentErasure(pool, { preservationAccess: access, erasureId, erasureEpoch: '2',
      resourceId: work, revisionIds: [saved.revisionId!] })).toEqual({ applied: 1 });
    // Component only: this graph answers every ASK, and access is a stub.
    const graph = new OpenGraph();
    const app = createMainApp(graph, { environment: { fuseki: graph, objectDirectory: state,
      lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
    access: { assertRecoveryOpen: async () => {},
      canReadWork: async (_principal: unknown, subject: string, resource: string) =>
        subject === actor && resource === work },
    content, comments } as unknown as MainWorkDependencies);
    const response = await app.handle(new Request(
      `http://main.local/v1/content-comments/${commentId}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer reader' } }));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(canary);
    // Negative component only: replica role skips triggers. It is not a backup,
    // a retained journal, or a signed coverage replay.
    await pool.query('BEGIN');
    await pool.query(`SET LOCAL session_replication_role = replica`);
    await pool.query(`UPDATE content.comment SET exact = $2, prefix = 'Opening paragraph', suffix = 'Closing'
      WHERE id = $1`, [commentId, canary]);
    await pool.query('COMMIT');
    expect(await probeContentErasure(pool, erasureId, [saved.revisionId!]))
      .toEqual(new Map([[saved.revisionId, 'erased']]));
    expect(await openCommentSourceRevisions(pool, [saved.revisionId!])).toEqual([saved.revisionId]);
    const resurrected = await comments.read(commentId);
    expect(resurrected && commentTargetHasSource(resurrected.target) && resurrected.target.selector.exact)
      .toBe(canary);
    expect(await applyContentErasure(pool, { preservationAccess: access, erasureId, erasureEpoch: '2',
      resourceId: work, revisionIds: [saved.revisionId!] })).toEqual({ applied: 0 });
    const replay = await comments.create({ ...input, admissionId, authorityEpoch: '1',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
    expect(replay.replayed).toBe(true);
    expect(replay.body).toBe(annotation);
    expect(commentTargetHasSource(replay.target)).toBe(false);
    expect(JSON.stringify(replay)).not.toContain(canary);
    const again = await app.handle(new Request(
      `http://main.local/v1/content-revisions/${saved.revisionId}/comments?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer reader' } }));
    expect(again.status).toBe(200);
    const page = await again.text();
    expect(page).toContain(annotation);
    expect(page).not.toContain(canary);
    expect(await openCommentSourceRevisions(pool, [saved.revisionId!])).toEqual([]);
  } finally {
    await access.end();
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
});
