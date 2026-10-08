import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentComments, contentCommentIntentDigest } from '../../content/src/comments.ts';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { applyContentErasure } from '../src/modules/erasure/content.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../..');
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

test('an authorized reader keeps the annotation after source erasure and a denied reader does not', async () => {
  const state = join(root, '.temp', `comment-source-http-${randomUUID()}`);
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
    const input = { revisionId: saved.revisionId!, resourceId: work, author: actor, exact: canary,
      body: annotation };
    const created = await comments.create({ ...input, admissionId: randomUUID(), authorityEpoch: '1',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
    const commentId = created.comment.split('/').at(-1)!;
    await applyContentErasure(pool, { preservationAccess: access, erasureId: randomUUID(),
      erasureEpoch: '1', resourceId: work, revisionIds: [saved.revisionId!] });
    const graph = new OpenGraph();
    const app = createMainApp(graph, { environment: { fuseki: graph, objectDirectory: state,
      lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
    access: { assertRecoveryOpen: async () => {},
      canReadWork: async (_principal: unknown, subject: string, resource: string) =>
        subject === actor && resource === work },
    content, comments } as unknown as MainWorkDependencies);
    const read = (path: string, subject = actor) => app.handle(new Request(
      `http://main.local${path}?actingSubject=${encodeURIComponent(subject)}`,
      { headers: { authorization: 'Bearer reader' } }));
    const denied = await read(`/v1/content-comments/${commentId}`, `https://rezics.com/id/${randomUUID()}`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(canary);
    const one = await read(`/v1/content-comments/${commentId}`);
    expect(one.status).toBe(200);
    const body = await one.json() as { body: string; resolvedText?: string; target: { selector?: unknown } };
    expect(body.body).toBe(annotation);
    expect(body.resolvedText).toBeUndefined();
    expect(body.target.selector).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(canary);
    const page = await read(`/v1/content-revisions/${saved.revisionId}/comments`);
    expect(page.status).toBe(200);
    const listed = await page.json() as { comments: Array<{ body: string; resolvedText?: string }> };
    expect(listed.comments.map(comment => comment.body)).toEqual([annotation]);
    expect(listed.comments.every(comment => comment.resolvedText === undefined)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(canary);
    const deniedPage = await read(`/v1/content-revisions/${saved.revisionId}/comments`,
      `https://rezics.com/id/${randomUUID()}`);
    expect(deniedPage.status).toBe(404);
    expect(await deniedPage.text()).not.toContain(annotation);
  } finally {
    await access.end();
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
});
