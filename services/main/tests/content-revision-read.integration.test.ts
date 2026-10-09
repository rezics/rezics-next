import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentConflict, ContentCore, migrateContent, type VariantIdentity } from '../../content/src/index.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { fromPlainText } from '@rezics/document';

const root = resolve(import.meta.dir, '../../..');

class ReadGraph extends FusekiClient {
  currentWorkPresent = true;
  constructor() { super('http://127.0.0.1:1/rezics'); }
  override async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('SELECT DISTINCT ?type')) return { results: { bindings: this.currentWorkPresent
      ? [{ type: { type: 'uri', value: 'https://schema.org/CreativeWork' } }] : [] } };
    if (sparql.includes('SELECT ?target WHERE') && sparql.includes('rv:ErasedRevision')) {
      return { results: { bindings: [] } };
    }
    return { boolean: sparql.includes('schema:CreativeWork') ? this.currentWorkPresent : true };
  }
}

test('WORK09: partial Content exact history requires current Work disclosure and reports byte damage', async () => {
  const state = join(root, '.temp', `content-read-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection });
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
    const document = structuredClone(fromPlainText('第二版'));
    document.doc.content![0]!.content![0]!.marks = [{ type: 'bold' }];
    const structuredBytes = JSON.stringify({ body: '第二版', document });
    const second = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant,
      expectedHead: first.revisionId, model: 'content-shape-v1', sourceRevision: null,
      provenance: { editor: 'test' }, serializedJson: structuredBytes });
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
      access: { assertRecoveryOpen: async () => undefined,
        canReadWork: async (_principal, subject, resource) =>
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
    expect(await head.json()).toMatchObject({ serializedJson: structuredBytes,
      body: { body: '第二版', document } });
    await expect(content.saveDraft({ operationId: `save-${randomUUID()}`, variant,
      expectedHead: second.revisionId, model: 'content-shape-v1', sourceRevision: null,
      provenance: { editor: 'test' }, serializedJson: JSON.stringify({ body: 'false projection', document }) }))
      .rejects.toBeInstanceOf(ContentConflict);

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
    cluster.remove();
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
