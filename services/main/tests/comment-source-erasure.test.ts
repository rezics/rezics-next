import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateAccount, migrationRecords } from '../../../scripts/ops/migrate.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { openRecoveryPayload, RecoveryEnvelopeConflict, sealRecoveryPayload }
  from '../../account/src/recovery-envelope.ts';
import { ContentComments, contentCommentIntentDigest } from '../../content/src/comments.ts';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { applyContentErasure, ContentErasureStale } from '../src/modules/erasure/content.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold }
  from '../src/modules/erasure/reconcile.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence,
  type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../src/modules/content-publication/publish.ts';
import { journalErasure, markErasureSuppressed } from '../src/modules/erasure/journal.ts';
import { assertCurrentRecoveryCoverageHead, retainRecoveryCoverageHead }
  from '../src/modules/outbox/recovery-coverage-head.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';
import { activateMetadataWork, hash, initializeFreshGraph, metadataWorkRequestDigest }
  from '../src/modules/work/activate.ts';
import { assertContentRecoveryCoverage, assertReplayedCommentSourcesTerminal,
  captureContentRecoveryCoverage, ContentRecoveryConflict }
  from '../src/modules/work/content-recovery-coverage.ts';
import { captureGraphRecoveryCoverage, RestoreLineageConflict, type RecoveryCoverage }
  from '../src/modules/work/restore-lineage.ts';

const root = resolve(import.meta.dir, '../..');
const repoRoot = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-source';
const annotation = 'authored annotation stays';
const sourceText = `Opening paragraph\n${canary}\nClosing paragraph`;
/** Qualified integer runtime. New runs use this pin, the image built with the
 * reviewed command profiles, including the widened native-agent credit roles.
 * A prior run of this file on 835daa8774ac remains that run's evidence. */
const qualifiedFuseki = 'rezics/fuseki:6.2.0-cmd0.5.39-5fc82f7d04cd';

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
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 4 });
  const access = new Pool({ ...cluster.connection, max: 2 });
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
    try { cluster.remove(); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
});

test('real account, access, native graph and a restored content catalog keep the annotation and drop the quote', async () => {
  const state = join(root, '.temp', `comment-source-real-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 4 });
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
      qualifiedFuseki,
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
    // Empty pin set, raw catalog object, no recovery envelope. This is dump/restore
    // comparison of the content catalog, not authenticated signed recovery.
    const captured = await captureContentRecoveryCoverage(pool, []);
    const archive = join(state, 'content.dump');
    execFileSync('pg_dump', ['-Fc', '-f', archive, '-h', '127.0.0.1', '-p', String(cluster.port),
      '-U', cluster.user, 'postgres'], { cwd: state });
    await pool.query('CREATE DATABASE comment_source_restore');
    execFileSync('pg_restore', ['--no-owner', '--no-acl', '-h', '127.0.0.1', '-p', String(cluster.port),
      '-U', cluster.user, '-d', 'comment_source_restore', archive], { cwd: state });
    restored = new Pool({ ...cluster.connection, database: 'comment_source_restore', max: 4 });
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
    try { cluster.remove(); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 180_000);

async function applyMigrations(pool: Pool, owner: 'access' | 'relay') {
  for (const file of migrationRecords(repoRoot, owner)) {
    await pool.query(readFileSync(join(repoRoot, file.name), 'utf8'));
  }
}

// Same live account, access, content, relay and graph. This does not take a
// physical backup, restore an independent copy, or carry a held restore lineage.
test('sealed envelope on the same captured owners stays closed until journal replay clears the quote', async () => {
  const state = join(root, '.temp', `comment-source-envelope-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(join(state, 'objects'), { recursive: true, mode: 0o700 });
  const cluster = await startPostgresCluster();
  const admin = new Pool({ ...cluster.connection, max: 1 });
  const owners = new Pool({ ...cluster.connection, database: 'quote_access', max: 4 });
  // Access state coverage digests every table in the Access database. Content
  // replay must use its own database or the sealed Access cut moves with the quote.
  const contentDb = new Pool({ ...cluster.connection, database: 'quote_content', max: 4 });
  const account = new Pool({ ...cluster.connection, database: 'quote_account', max: 2 });
  const relay = new Pool({ ...cluster.connection, database: 'quote_relay', max: 4 });
  let fusekiContainer = '';
  let accountServer: ReturnType<typeof Bun.serve> | undefined;
  const hmacKey = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  const wrongKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  try {
    await admin.query('CREATE DATABASE quote_access');
    await admin.query('CREATE DATABASE quote_content');
    await admin.query('CREATE DATABASE quote_account');
    await admin.query('CREATE DATABASE quote_relay');
    await applyMigrations(owners, 'access');
    await migrateContent(contentDb);
    const accountUrl = new URL(`postgresql://127.0.0.1:${cluster.port}/quote_account`);
    accountUrl.username = cluster.user;
    await migrateAccount({
      ACCOUNT_DATABASE_URL: accountUrl.href,
      ACCOUNT_BASE_URL: 'http://127.0.0.1:3002',
      ACCOUNT_SECRET: 'comment-source-envelope-secret-32-characters',
      ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.test',
    }, repoRoot);
    await applyMigrations(relay, 'relay');
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const content = new ContentCore(contentDb);
    const comments = new ContentComments(contentDb);
    const fusekiPort = await freePort();
    const maintenance = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const commandToken = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    fusekiContainer = execFileSync('docker', ['run', '-d', '--name', `comment-source-envelope-${randomUUID()}`,
      '-p', `127.0.0.1:${fusekiPort}:3030`,
      '-e', 'JVM_ARGS=-Xms128m -Xmx512m',
      '-e', `FUSEKI_MAINTENANCE_TOKEN=${maintenance}`,
      '-e', `FUSEKI_COMMAND_TOKEN=${commandToken}`,
      '-e', 'FUSEKI_TITLE_ADMISSION_KEY=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      qualifiedFuseki,
      '/opt/apache-jena-fuseki-6.2.0/fuseki-server', '--port=3030', '--no-cors', '--timeout=10000',
      '--config=/fuseki/fuseki-text-qa.ttl'],
    { encoding: 'utf8' }).trim();
    const fuseki = new FusekiClient(`http://127.0.0.1:${fusekiPort}/rezics`, maintenance, commandToken);
    let fusekiUp = false;
    for (let attempt = 0; attempt < 40 && !fusekiUp; attempt++) {
      try { await fuseki.query('ASK { }'); fusekiUp = true; }
      catch { await Bun.sleep(500); }
    }
    if (!fusekiUp) throw new Error('native Fuseki did not accept a query');
    const prior = { dataEpoch: randomUUID(), routingEpoch: '1' };
    await initializeFreshGraph(fuseki, prior);
    const title = `Comment source ${randomUUID()}`;
    const activated = await activateMetadataWork({ fuseki, lineage: prior,
      objectDirectory: join(state, 'objects') }, { title, language: 'en', admission: {
        id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `comment-source-work-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest(title, [], 'en'), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const work = activated.work;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await content.saveDraft({ operationId: `draft-${randomUUID()}`,
      variant: { id: variantId, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: sourceText }) });
    const revisionId = saved.revisionId!;
    const input = { revisionId, resourceId: work, author: actor, exact: canary, body: annotation };
    const created = await comments.create({ ...input, admissionId: randomUUID(), authorityEpoch: '1',
      scope: `content:comment:${work}`, requestDigest: contentCommentIntentDigest(input) });
    const commentId = created.comment.split('/').at(-1)!;
    const exact = (await content.readExactBatch([revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('comment revision is not available to cite');
    const publishInput: PublishPinnedContentInput = { preparationId: `publish-${randomUUID()}`,
      revisionId, expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: saved.position.dataEpoch, resourceId: work, variantId,
      expectedPublicationHead: null };
    const publishAdmission: RegisteredAdmission = { id: randomUUID(), principalId: randomUUID(),
      actingSubject: actor, scope: `content:publish:${variantId}`, action: 'content.publish',
      idempotencyKey: `publish-${randomUUID()}`, requestDigest: contentPublicationDigest(publishInput),
      authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'registered', dispatchEligible: true, replayed: false };
    const published = await publishPinnedContent({ fuseki, lineage: prior,
      objectDirectory: join(state, 'objects') }, content, publishAdmission, publishInput);
    if (published.status !== 'active' || !published.decision) {
      throw new Error(`content publication did not cite the revision: ${published.status}`);
    }
    const consumer = `comment-source:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, prior.dataEpoch);
    for (;;) {
      const delivered = await relayMainOutboxOnce(fuseki, relay, consumer);
      if (!delivered) break;
    }
    const issuer = 'https://account.comment-source.test';
    const accountSubject = randomUUID();
    const principalId = randomUUID();
    await owners.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, issuer, accountSubject]);
    await owners.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actor]);
    const scope = `work:read:${work}`;
    await owners.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await owners.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, active, valid_until)
      VALUES ($1, $2, $3, 'work.read', true, clock_timestamp() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await owners.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, active, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', true, clock_timestamp() + interval '1 hour')`,
    [randomUUID(), actor, scope]);
    const audience = 'https://main.comment-source.test';
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.alg = 'ES256';
    jwk.kid = 'comment-source';
    jwk.use = 'sig';
    const sign = () => new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'comment-source' })
      .setIssuer(issuer).setAudience(audience).setSubject(accountSubject)
      .setIssuedAt().setExpirationTime('4m').sign(privateKey);
    accountServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
      if (url.pathname === '/introspect') return Response.json({ active: true, iss: issuer,
        sub: accountSubject, aud: audience, exp: Math.floor(Date.now() / 1000) + 240, scope: 'work:read' });
      return new Response('missing', { status: 404 });
    } });
    const verifier = new AccountAssertionVerifier({ issuer, audience,
      jwksUrl: `http://127.0.0.1:${accountServer.port}/jwks`,
      introspectUrl: `http://127.0.0.1:${accountServer.port}/introspect`,
      clientId: 'comment-source', clientSecret: 'comment-source-secret' });
    const fenceGeneration = await engageAccessRecoveryFence(owners);
    let captured: RecoveryCoverage | undefined;
    for (let attempt = 0; attempt < 8 && !captured; attempt++) {
      try {
        captured = await captureGraphRecoveryCoverage(fuseki, account, owners, relay, consumer, contentDb,
          { directory: join(state, 'objects') });
      } catch (error) {
        if (!(error instanceof RestoreLineageConflict)
          || !error.message.includes('Account WAL frontier') || attempt === 7) throw error;
        await Bun.sleep(100);
      }
    }
    if (!captured?.content || captured.content.graphReferencesCount === '0') {
      throw new Error('signed capture did not cite the revision');
    }
    const sealed = JSON.stringify(sealRecoveryPayload(captured, hmacKey, 'graph-recovery-coverage'));
    const opened = openRecoveryPayload<RecoveryCoverage>(sealed, hmacKey, 'graph-recovery-coverage');
    if (!opened.content) throw new Error('opened recovery envelope has no content cut');
    await assertContentRecoveryCoverage(contentDb, fuseki, opened.content);
    expect(opened.content.graphReferencesCount).not.toBe('0');
    expect(opened.content.catalogDigest).toBe(captured.content.catalogDigest);
    const quote = async () => (await contentDb.query<{ exact: string | null }>(
      'SELECT exact FROM content.comment WHERE revision_id = $1', [revisionId])).rows[0]!.exact;
    expect(await quote()).toBe(canary);
    expect(() => openRecoveryPayload(sealed, wrongKey, 'graph-recovery-coverage'))
      .toThrow(RecoveryEnvelopeConflict);
    const tampered = JSON.parse(sealed) as { mac: string };
    tampered.mac = tampered.mac.replace(/^./, tampered.mac.startsWith('a') ? 'b' : 'a');
    expect(() => openRecoveryPayload(JSON.stringify(tampered), hmacKey, 'graph-recovery-coverage'))
      .toThrow(RecoveryEnvelopeConflict);
    await retainRecoveryCoverageHead(relay, sealed, hmacKey);
    const headBefore = (await relay.query<{ coverage_digest: string }>(
      'SELECT coverage_digest FROM relay.recovery_coverage_head WHERE consumer = $1', [consumer])).rows[0]!;
    await expect(assertCurrentRecoveryCoverageHead(relay, { ...opened, priorSequence: '9' }))
      .rejects.toThrow('signed recovery coverage is not the retained current capture');
    await expect(assertReplayedCommentSourcesTerminal(contentDb, [revisionId], randomUUID(), opened.priorSequence))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
    await expect(assertReplayedCommentSourcesTerminal(contentDb, [revisionId], randomUUID(), '999'))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
    expect(await quote()).toBe(canary);
    const restored = { account, access: owners, content: contentDb,
      graph: { fuseki, lineage: prior }, objects: { directory: join(state, 'objects') } };
    const authority = { sealedCoverage: sealed, hmacKey };
    const admission = new AccessAdmissionRegistry(owners);
    const reader = { issuer, subject: accountSubject };
    const app = createMainApp(fuseki, { environment: { fuseki, objectDirectory: state, lineage: prior },
      account: verifier, access: admission, content: new ContentCore(contentDb),
      comments: new ContentComments(contentDb) } as unknown as MainWorkDependencies);
    const ready = () => app.handle(new Request('http://main.local/health/ready'));
    const readComment = async () => app.handle(new Request(
      `http://main.local/v1/content-comments/${commentId}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${await sign()}` } }));
    const closed = async () => {
      expect((await ready()).status).toBe(503);
      const response = await readComment();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(canary);
      await expect(admission.assertRecoveryOpen()).rejects.toBeInstanceOf(AdmissionUnavailable);
      await expect(admission.canReadWork(reader, actor, work)).rejects.toBeInstanceOf(AdmissionUnavailable);
      expect((await owners.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]!.open).toBe(false);
    };
    await closed();
    const entry = await journalErasure(relay, { operationId: randomUUID(),
      requestDigest: hash(revisionId), kind: 'revision', principalId, admissionId: randomUUID(),
      authorityEpoch: '1', targets: [{ kind: 'content_revision', ref: revisionId }] });
    await markErasureSuppressed(relay, entry.erasureId);
    await expect(assertReplayedCommentSourcesTerminal(contentDb, [revisionId], randomUUID(), entry.erasureEpoch))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
    await expect(assertReplayedCommentSourcesTerminal(contentDb, [revisionId], entry.erasureId, '999'))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
    expect(await quote()).toBe(canary);
    await closed();
    const held = await reconcileRestoredErasures(relay, restored, {
      operationId: `comment-source-before-replay-${randomUUID()}`, consumer, replay: false, authority });
    expect(held.state).toBe('held');
    await expect(releaseErasureRestoreHold(relay, restored, held.reconciliationId, fenceGeneration, authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    expect(await quote()).toBe(canary);
    await closed();
    const refusedKey = await reconcileRestoredErasures(relay, restored, {
      operationId: `comment-source-wrong-key-${randomUUID()}`, consumer, replay: true,
      authority: { sealedCoverage: sealed, hmacKey: wrongKey } });
    expect(refusedKey.state).toBe('held');
    const refusedEnvelope = await reconcileRestoredErasures(relay, restored, {
      operationId: `comment-source-wrong-envelope-${randomUUID()}`, consumer, replay: true,
      authority: { sealedCoverage: JSON.stringify(tampered), hmacKey } });
    expect(refusedEnvelope.state).toBe('held');
    expect(await quote()).toBe(canary);
    await closed();
    const replayed = await reconcileRestoredErasures(relay, restored, {
      operationId: `comment-source-journal-replay-${randomUUID()}`, consumer, replay: true, authority });
    if (replayed.state !== 'reconciled') {
      throw new Error(`${replayed.state}: ${replayed.holdReason ?? 'no hold reason'} ${JSON.stringify(replayed.counts)}`);
    }
    expect(await quote()).toBeNull();
    await assertReplayedCommentSourcesTerminal(contentDb, [revisionId], entry.erasureId, entry.erasureEpoch);
    await closed();
    await releaseErasureRestoreHold(relay, restored, replayed.reconciliationId, fenceGeneration, authority);
    expect(await quote()).toBeNull();
    await assertReplayedCommentSourcesTerminal(contentDb, [revisionId], entry.erasureId, entry.erasureEpoch);
    expect((await owners.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]!.open).toBe(true);
    await admission.assertRecoveryOpen();
    expect(await admission.canReadWork(reader, actor, work)).toBe(true);
    expect((await ready()).status).toBe(200);
    const shown = await readComment();
    expect(shown.status).toBe(200);
    const shownBody = await shown.json() as { body: string; resolvedText?: string; target?: { selector?: unknown } };
    expect(shownBody.body).toBe(annotation);
    expect(shownBody.resolvedText).toBeUndefined();
    expect(shownBody.target?.selector).toBeUndefined();
    expect(JSON.stringify(shownBody)).not.toContain(canary);
    const reopened = openRecoveryPayload<RecoveryCoverage>(sealed, hmacKey, 'graph-recovery-coverage');
    expect(reopened.content?.catalogDigest).toBe(opened.content.catalogDigest);
    await assertCurrentRecoveryCoverageHead(relay, reopened);
    const headAfter = (await relay.query<{ coverage_digest: string }>(
      'SELECT coverage_digest FROM relay.recovery_coverage_head WHERE consumer = $1', [consumer])).rows[0]!;
    expect(headAfter.coverage_digest).toBe(headBefore.coverage_digest);
    await expect(assertContentRecoveryCoverage(contentDb, fuseki, opened.content))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
  } finally {
    await accountServer?.stop(true);
    if (fusekiContainer) execFileSync('docker', ['rm', '-f', fusekiContainer], { stdio: 'ignore' });
    await Promise.allSettled([owners.end(), contentDb.end(), account.end(), relay.end(), admin.end()]);
    try { cluster.remove(); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 300_000);
