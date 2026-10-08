import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { ContentComments, contentCommentIntentDigest } from '../../content/src/comments.ts';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { applyContentErasure, ContentErasureStale } from '../src/modules/erasure/content.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { assertContentRecoveryCoverage, assertReplayedCommentSourcesTerminal,
  captureContentRecoveryCoverage, ContentRecoveryConflict } from '../src/modules/work/content-recovery-coverage.ts';

const root = resolve(import.meta.dir, '../..');
const repoRoot = resolve(import.meta.dir, '../../..');
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

test('component: stubbed access and an always-true graph keep the annotation shape without the quote', async () => {
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
    const secondBody = 'second annotation stays';
    const second = { ...input, body: secondBody };
    await comments.create({ ...second, admissionId: randomUUID(), authorityEpoch: '2',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(second) });
    const commentId = created.comment.split('/').at(-1)!;
    const empty = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    await applyContentErasure(pool, { preservationAccess: access, erasureId: randomUUID(),
      erasureEpoch: '1', resourceId: work, revisionIds: [saved.revisionId!, empty.revisionId!] });
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
    const listed = await page.json() as { comments: Array<{ body: string; resolvedText?: string }>; next: string | null };
    expect(listed.comments.map(comment => comment.body)).toEqual([annotation, secondBody]);
    expect(listed.comments.every(comment => comment.resolvedText === undefined)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(canary);
    const first = await app.handle(new Request(
      `http://main.local/v1/content-revisions/${saved.revisionId}/comments?actingSubject=${encodeURIComponent(actor)}&pageSize=1`,
      { headers: { authorization: 'Bearer reader' } }));
    expect(first.status).toBe(200);
    const firstPage = await first.json() as { comments: unknown[]; next: string | null };
    expect(firstPage.comments).toHaveLength(1);
    expect(firstPage.next).toBeTruthy();
    const rest = await app.handle(new Request(
      `http://main.local/v1/content-revisions/${saved.revisionId}/comments?actingSubject=${encodeURIComponent(actor)}&pageSize=1&cursor=${encodeURIComponent(firstPage.next!)}`,
      { headers: { authorization: 'Bearer reader' } }));
    expect(rest.status).toBe(200);
    const restPage = await rest.json() as { comments: Array<{ body: string }>; next: string | null };
    expect(restPage.comments.map(comment => comment.body)).toEqual([secondBody]);
    expect(restPage.next).toBeNull();
    expect(JSON.stringify(restPage)).not.toContain(canary);
    const emptyPage = await app.handle(new Request(
      `http://main.local/v1/content-revisions/${empty.revisionId}/comments?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer reader' } }));
    expect(emptyPage.status).toBe(200);
    expect(await emptyPage.json()).toMatchObject({ comments: [], next: null });
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

test('real account, access, native graph, backup and signed coverage keep the annotation and drop the quote', async () => {
  const state = join(root, '.temp', `comment-source-real-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 });
  let restored: Pool | undefined;
  let fusekiContainer = '';
  let accountServer: ReturnType<typeof Bun.serve> | undefined;
  const issuer = 'https://account.comment-source.test';
  const audience = 'https://main.comment-source.test';
  const accountSubject = randomUUID();
  const actor = `https://rezics.com/id/${randomUUID()}`;
  let introspection: Record<string, unknown> = {};
  try {
    for (const file of schemaFiles(repoRoot, 'access')) {
      await pool.query(readFileSync(join(repoRoot, 'services/main/migrations/access', file), 'utf8'));
    }
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const comments = new ContentComments(pool);
    const work = `https://rezics.com/id/${randomUUID()}`;
    const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const input = { revisionId: saved.revisionId!, resourceId: work, author: actor, exact: canary,
      body: annotation };
    const created = await comments.create({ ...input, admissionId: randomUUID(), authorityEpoch: '1',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
    const secondBody = 'second annotation stays';
    const second = { ...input, body: secondBody };
    await comments.create({ ...second, admissionId: randomUUID(), authorityEpoch: '2',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(second) });
    const commentId = created.comment.split('/').at(-1)!;
    const fusekiPort = await freePort();
    fusekiContainer = execFileSync('docker', ['run', '-d', '--name', `comment-source-fuseki-${randomUUID()}`,
      '-p', `127.0.0.1:${fusekiPort}:3030`,
      '-e', 'JVM_ARGS=-Xms128m -Xmx512m',
      '-e', 'FUSEKI_MAINTENANCE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '-e', 'FUSEKI_COMMAND_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '-e', 'FUSEKI_TITLE_ADMISSION_KEY=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'rezics/fuseki:6.2.0-cmd0.5.39-78dc38c96966',
      '/opt/apache-jena-fuseki-6.2.0/fuseki-server', '--port=3030', '--no-cors', '--timeout=10000',
      '--config=/fuseki/fuseki-text-qa.ttl'],
    { encoding: 'utf8' }).trim();
    const fuseki = new FusekiClient(`http://127.0.0.1:${fusekiPort}/rezics/`);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      try {
        await fuseki.query('ASK { }');
        ready = true;
      } catch { await Bun.sleep(500); }
    }
    if (!ready) throw new Error('native Fuseki did not accept a query');
    const captured = await captureContentRecoveryCoverage(pool, []);
    const archive = join(state, 'content.dump');
    execFileSync('pg_dump', ['-Fc', '-f', archive, '-h', '127.0.0.1', '-p', String(port),
      '-U', process.env.USER!, 'postgres'], { cwd: state });
    await pool.query('CREATE DATABASE comment_source_restore');
    execFileSync('pg_restore', ['--no-owner', '--no-acl', '-h', '127.0.0.1', '-p', String(port),
      '-U', process.env.USER!, '-d', 'comment_source_restore', archive], { cwd: state });
    restored = new Pool({ host: '127.0.0.1', port, user: process.env.USER,
      database: 'comment_source_restore', max: 4 });
    await assertContentRecoveryCoverage(restored, fuseki, captured);
    const stillQuoted = (await restored.query<{ exact: string; body: string }>(
      'SELECT exact, body FROM content.comment WHERE id = $1', [commentId])).rows[0]!;
    expect(stillQuoted.exact).toBe(canary);
    expect(stillQuoted.body).toBe(annotation);
    const heldWork = `https://rezics.com/id/${randomUUID()}`;
    const heldSaved = await new ContentCore(restored).saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: heldWork,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const heldInput = { revisionId: heldSaved.revisionId!, resourceId: heldWork, author: actor,
      exact: canary, body: annotation };
    const heldComment = await new ContentComments(restored).create({ ...heldInput, admissionId: randomUUID(),
      authorityEpoch: '2', scope: `content:comment:${heldWork}`,
      requestDigest: contentCommentIntentDigest(heldInput) });
    const caseScope = `governance:case:${randomUUID()}`;
    await restored.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [caseScope]);
    const caseId = randomUUID();
    await restored.query(`INSERT INTO access.governance_case
      (id, kind, authority_kind, authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
      VALUES ($1, 'content_report', 'platform', $2, 'urn:rezics:context:global', 'content', $3, 'body', 'private')`,
    [caseId, caseScope, heldWork]);
    await restored.query(`INSERT INTO access.governance_preservation_hold
      (id, case_id, target_resource, reason) VALUES ($1, $2, $3, 'current legal hold')`,
    [randomUUID(), caseId, heldWork]);
    await expect(applyContentErasure(restored, { preservationAccess: restored, erasureId: randomUUID(),
      erasureEpoch: '3', resourceId: heldWork, revisionIds: [heldSaved.revisionId!] }))
      .rejects.toBeInstanceOf(ContentErasureStale);
    expect((await restored.query<{ exact: string }>('SELECT exact FROM content.comment WHERE id = $1',
      [heldComment.comment.split('/').at(-1)])).rows[0]!.exact).toBe(canary);
    const erasureId = randomUUID();
    expect(await applyContentErasure(restored, { preservationAccess: restored, erasureId, erasureEpoch: '9',
      resourceId: work, revisionIds: [saved.revisionId!] })).toEqual({ applied: 1 });
    await assertReplayedCommentSourcesTerminal(restored, [saved.revisionId!], erasureId, '9');
    const terminal = (await restored.query<{ exact: string | null; body: string; request_digest: string }>(
      'SELECT exact, body, request_digest FROM content.comment WHERE id = $1', [commentId])).rows[0]!;
    expect(terminal.exact).toBeNull();
    expect(terminal.body).toBe(annotation);
    expect(terminal.request_digest).toMatch(/^[0-9a-f]{64}$/);
    await expect(assertContentRecoveryCoverage(restored, fuseki, captured))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
    const update = await fetch(`http://127.0.0.1:${fusekiPort}/rezics/update`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: `PREFIX schema: <https://schema.org/> PREFIX rv: <https://rezics.com/vocab/>
        INSERT DATA {
          GRAPH <urn:rezics:graph:current> { <${work}> a schema:CreativeWork }
          GRAPH <urn:rezics:graph:control> {
            <urn:rezics:dataset:product> rv:dataEpoch "epoch" ; rv:routingEpoch "1" }
        }` });
    if (!update.ok) throw new Error(`native graph update returned ${update.status}`);
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.alg = 'ES256';
    jwk.kid = 'comment-source';
    jwk.use = 'sig';
    const sign = () => new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'comment-source' })
      .setIssuer(issuer).setAudience(audience).setSubject(accountSubject)
      .setIssuedAt().setExpirationTime('4m').sign(privateKey);
    introspection = { active: true, iss: issuer, sub: accountSubject, aud: audience,
      exp: Math.floor(Date.now() / 1000) + 240, scope: 'work:read' };
    accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
      if (url.pathname === '/introspect') return Response.json(introspection);
      return new Response('missing', { status: 404 });
    } });
    const account = new AccountAssertionVerifier({ issuer, audience,
      jwksUrl: `http://127.0.0.1:${accountServer.port}/jwks`,
      introspectUrl: `http://127.0.0.1:${accountServer.port}/introspect`,
      clientId: 'comment-source', clientSecret: 'comment-source-secret' });
    const principalId = randomUUID();
    await restored.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, issuer, accountSubject]);
    await restored.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actor]);
    const scope = `work:read:${work}`;
    await restored.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    const grant = async (until: string, active = true) => {
      const id = randomUUID();
      await restored!.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, active, valid_until)
        VALUES ($1, $2, $3, 'work.read', $4, ${until})`, [randomUUID(), principalId, actor, active]);
      await restored!.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, active, valid_until)
        VALUES ($1, $2, $2, $3, 'work.read', $4, ${until})`, [id, actor, scope, active]);
      return id;
    };
    const currentGrant = await grant(`clock_timestamp() + interval '1 hour'`);
    const access = new AccessAdmissionRegistry(restored);
    const app = createMainApp(fuseki, { environment: { fuseki, objectDirectory: state,
      lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account, access, content: new ContentCore(restored),
    comments: new ContentComments(restored) } as unknown as MainWorkDependencies);
    const read = async (path: string, token?: string, subject = actor) => app.handle(new Request(
      `http://main.local${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(subject)}`,
      { headers: { authorization: `Bearer ${token ?? await sign()}` } }));
    const allowed = await read(`/v1/content-comments/${commentId}`);
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { body: string; resolvedText?: string; target: { selector?: unknown } };
    expect(body.body).toBe(annotation);
    expect(body.resolvedText).toBeUndefined();
    expect(body.target.selector).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(canary);
    await restored.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [currentGrant]);
    const revoked = await read(`/v1/content-comments/${commentId}`);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).not.toContain(canary);
    await grant(`clock_timestamp() - interval '1 minute'`);
    const expired = await read(`/v1/content-comments/${commentId}`);
    expect(expired.status).toBe(404);
    expect(await expired.text()).not.toContain(annotation);
    await grant(`clock_timestamp() + interval '1 hour'`);
    await restored.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    const closed = await read(`/v1/content-comments/${commentId}`);
    expect(closed.status).toBe(503);
    expect(await closed.text()).not.toContain(canary);
    await restored.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    introspection = { ...introspection, active: false };
    const inactive = await read(`/v1/content-comments/${commentId}`);
    expect(inactive.status).toBe(401);
    expect(await inactive.text()).not.toContain(canary);
    introspection = { ...introspection, active: true, scope: 'profile' };
    const unscope = await read(`/v1/content-comments/${commentId}`, await sign());
    expect(unscope.status).toBe(401);
    introspection = { ...introspection, scope: 'work:read' };
    const first = await read(`/v1/content-revisions/${saved.revisionId}/comments?pageSize=1`);
    expect(first.status).toBe(200);
    const firstPage = await first.json() as { comments: Array<{ body: string }>; next: string | null };
    expect(firstPage.comments.map(comment => comment.body)).toEqual([annotation]);
    expect(firstPage.next).toBeTruthy();
    const rest = await read(`/v1/content-revisions/${saved.revisionId}/comments?pageSize=1&cursor=${encodeURIComponent(firstPage.next!)}`);
    expect(rest.status).toBe(200);
    const restPage = await rest.json() as { comments: Array<{ body: string }>; next: string | null };
    expect(restPage.comments.map(comment => comment.body)).toEqual([secondBody]);
    expect(restPage.next).toBeNull();
    const bare = await new ContentCore(restored).saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const bareErasure = randomUUID();
    await applyContentErasure(restored, { preservationAccess: restored, erasureId: bareErasure,
      erasureEpoch: '7', resourceId: work, revisionIds: [bare.revisionId!] });
    await assertReplayedCommentSourcesTerminal(restored, [bare.revisionId!], bareErasure, '7');
    const emptyPage = await read(`/v1/content-revisions/${bare.revisionId}/comments`);
    expect(emptyPage.status).toBe(200);
    expect(await emptyPage.json()).toMatchObject({ comments: [], next: null });
    const visible = `https://rezics.com/id/${randomUUID()}`;
    const visibleSaved = await new ContentCore(restored).saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: visible,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const visibleInput = { revisionId: visibleSaved.revisionId!, resourceId: visible, author: actor,
      exact: canary, body: annotation };
    const visibleComment = await new ContentComments(restored).create({ ...visibleInput,
      admissionId: randomUUID(), authorityEpoch: '4', scope: `content:comment:${visible}`,
      requestDigest: contentCommentIntentDigest(visibleInput) });
    const visibleId = visibleComment.comment.split('/').at(-1)!;
    const visibleScope = `work:read:${visible}`;
    await restored.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [visibleScope]);
    await restored.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', clock_timestamp() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await restored.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', clock_timestamp() + interval '1 hour')`,
    [randomUUID(), actor, visibleScope]);
    const graphHold = await fetch(`http://127.0.0.1:${fusekiPort}/rezics/update`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: `PREFIX schema: <https://schema.org/> PREFIX rv: <https://rezics.com/vocab/>
        INSERT DATA {
          GRAPH <urn:rezics:graph:current> { <${visible}> a schema:CreativeWork }
          GRAPH <urn:rezics:graph:revisions> {
            <urn:rezics:content:revision:${visibleSaved.revisionId}> a rv:ErasedRevision }
        }` });
    if (!graphHold.ok) throw new Error(`native graph hold update returned ${graphHold.status}`);
    const hidden = await read(`/v1/content-comments/${visibleId}`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain(canary);
    const visibleErasure = randomUUID();
    await applyContentErasure(restored, { preservationAccess: restored, erasureId: visibleErasure,
      erasureEpoch: '8', resourceId: visible, revisionIds: [visibleSaved.revisionId!] });
    await assertReplayedCommentSourcesTerminal(restored, [visibleSaved.revisionId!], visibleErasure, '8');
    const shown = await read(`/v1/content-comments/${visibleId}`);
    expect(shown.status).toBe(200);
    const shownBody = await shown.json() as { body: string; resolvedText?: string };
    expect(shownBody.body).toBe(annotation);
    expect(shownBody.resolvedText).toBeUndefined();
    expect(JSON.stringify(shownBody)).not.toContain(canary);
  } finally {
    await accountServer?.stop(true);
    if (fusekiContainer) execFileSync('docker', ['rm', '-f', fusekiContainer], { stdio: 'ignore' });
    await restored?.end();
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 180_000);
