import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore, migrateContent, type VariantIdentity } from '../../content/src/index.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';

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

class ReadGraph extends FusekiClient {
  currentWorkPresent = true;
  constructor() { super('http://127.0.0.1:1/rezics'); }
  override async query(sparql: string): Promise<SparqlResult> {
    return { boolean: sparql.includes('schema:CreativeWork') ? this.currentWorkPresent : true };
  }
}

test('WORK09: partial Content exact history requires current Work disclosure and reports byte damage', async () => {
  const state = join(root, '.temp', `content-read-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const workId = `https://rezics.com/id/${randomUUID()}`;
    const actingSubject = `https://rezics.com/id/${randomUUID()}`;
    const variant: VariantIdentity = { id: `urn:rezics:variant:${randomUUID()}`,
      resourceId: workId, language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-hans' },
      direction: 'ltr' };
    const serializedJson = '{ "body" : "第一版", "count": 1 }';
    const first = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant,
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { editor: 'test' }, serializedJson });
    const second = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant,
      expectedHead: first.revisionId, model: 'content-shape-v1', sourceRevision: null,
      provenance: { editor: 'test' }, serializedJson: '{"body":"第二版","count":2}' });
    if (!first.revisionId || !second.revisionId) throw new Error('test drafts were not saved');
    const graph = new ReadGraph();
    let grant = true;
    const scopes: string[][] = [];
    const dependencies: MainWorkDependencies = {
      environment: { fuseki: graph, lineage: { dataEpoch: 'test', routingEpoch: 'test' },
        objectDirectory: join(state, 'objects') },
      account: { verify: async (request, requiredScopes) => {
        scopes.push([...requiredScopes]);
        if (request.headers.get('authorization') !== 'Bearer valid') {
          throw new AccountAssertionDenied('missing token');
        }
        return { issuer: 'test', subject: 'account-user' };
      } },
      access: { canReadWork: async (_principal, subject, resource) =>
        grant && subject === actingSubject && resource === workId } as MainWorkDependencies['access'],
      content,
    };
    const app = createMainApp(graph, dependencies);
    const read = (revisionId: string, token = 'Bearer valid') => app.handle(new Request(
      `http://localhost/v1/content-revisions/${revisionId}?actingSubject=${encodeURIComponent(actingSubject)}`,
      { headers: { authorization: token } }));

    const old = await read(first.revisionId);
    expect(old.status).toBe(200);
    expect(old.headers.get('cache-control')).toBe('no-store');
    expect(await old.json()).toMatchObject({
      reference: { owner: 'content', resourceId: workId, variantId: variant.id,
        revisionId: first.revisionId, format: 'rezics-content-json-v1',
        language: variant.language, byteLength: Buffer.byteLength(serializedJson),
        byteDigest: createHash('sha256').update(serializedJson).digest('hex') },
      serializedJson, body: { body: '第一版', count: 1 },
    });
    expect(scopes).toEqual([['work:read']]);
    const head = await read(second.revisionId);
    expect((await head.json() as { body: { body: string } }).body.body).toBe('第二版');

    const unknown = await read(randomUUID());
    expect(unknown.status).toBe(404);
    grant = false;
    const denied = await read(first.revisionId);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json());
    grant = true;
    graph.currentWorkPresent = false;
    expect((await read(first.revisionId)).status).toBe(404);
    graph.currentWorkPresent = true;
    expect((await read(first.revisionId, 'Bearer invalid')).status).toBe(401);
    expect((await read('invalid')).status).toBe(400);

    await pool.query(`UPDATE content.revision SET availability = 'unavailable',
      serialized_bytes = NULL, body = NULL WHERE id = $1`, [first.revisionId]);
    expect((await read(first.revisionId)).status).toBe(503);
    expect((await read(second.revisionId)).status).toBe(200);
    grant = false;
    expect((await read(first.revisionId)).status).toBe(404);
    grant = true;

    await pool.query('ALTER TABLE content.revision DISABLE TRIGGER revision_immutable');
    await pool.query('UPDATE content.revision SET byte_digest = $2 WHERE id = $1',
      [second.revisionId, '0'.repeat(64)]);
    await pool.query('ALTER TABLE content.revision ENABLE TRIGGER revision_immutable');
    expect((await read(second.revisionId)).status).toBe(503);
    grant = false;
    expect((await read(second.revisionId)).status).toBe(404);
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
