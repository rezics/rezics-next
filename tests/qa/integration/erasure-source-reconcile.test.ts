import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { ContentComments } from '../../../services/content/src/comments.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { graphErasureReceipt } from '../../../services/main/src/modules/erasure/graph.ts';
import { OwnerOperations } from '../../../services/main/src/modules/owner/operations.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const scopes = 'openid work:create work:edit work:read comment:create access:manage owner:operate claim:create claim:read claim:evidence';
const language = { kind: 'tag', tag: 'en', originalTag: 'en' } as const;

interface HttpResult { status: number; body: unknown; text: string }
interface Problem { title?: string; code?: string; status?: number }
interface ErasureView {
  profile: string; id: string; kind: string; erasure: string;
  state: string; disposition: string | null; replayed: boolean;
}
interface Triple { graph: string; s: string; p: string; o: string }
interface Planted {
  revisionId: string; commentId: string; claimId: string; evidenceId: string;
  erasureId: string; erasureEpoch: string; quote: string; annotation: string;
  start: number; end: number; prefix: string; suffix: string; manifestDigest: string;
  graph: Triple[];
}
interface StoredSource {
  exact: string | null; prefix: string | null; suffix: string | null; body: string;
  selector: { exact?: string; start?: number; end?: number };
  sourceTerminal: boolean;
}

const short = (value: string) => value.split('/').at(-1)!;

async function take(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try { body = JSON.parse(text) as unknown; } catch { /* leave the raw body for the failure */ }
  }
  return { status: response.status, body, text };
}

function problemOf(body: unknown): Problem {
  return body && typeof body === 'object' ? body as Problem : {};
}

function requireQa(): Record<string, string> {
  const names = ['REZICS_QA_RUN_ID', 'FUSEKI_URL', 'FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN',
    'MAIN_DATA_EPOCH', 'MAIN_ROUTING_EPOCH', 'CONTENT_DATABASE_URL', 'ACCOUNT_DATABASE_URL',
    'ACCOUNT_RELAY_DATABASE_URL', 'ACCESS_DATABASE_URL', 'ACCOUNT_SECRET', 'ACCOUNT_MAIN_RESOURCE'];
  for (const name of names) if (!Bun.env[name]) throw new Error('Run through the isolated QA integration tier');
  return Bun.env as Record<string, string>;
}

type Stack = Awaited<ReturnType<typeof startStack>>;
let started: Promise<Stack> | undefined;
const stack = () => started ??= startStack();

afterAll(async () => {
  if (!started) return;
  try { await (await started).stop(); } catch { /* a failed start already closed its own resources */ }
});

/** One Account issuer, Access principal, Content owner, Fuseki dataset and Main app. */
async function startStack() {
  const apps = requireQa();
  const state = join(root, '.temp', `erasure-source-reconcile-${randomUUID()}`);
  mkdirSync(join(state, 'objects'), { recursive: true, mode: 0o700 });
  const account = await ratingAccount(apps, scopes);
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  const relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await account.close().catch(() => undefined);
    await Promise.allSettled([accessPool.end(), contentPool.end(), relay.end()]);
    rmSync(state, { recursive: true, force: true });
  };
  try {
    await migrateContent(contentPool);
    const fuseki = new FusekiClient(apps.FUSEKI_URL);
    const environment = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH,
      routingEpoch: apps.MAIN_ROUTING_EPOCH }, objectDirectory: join(state, 'objects') };
    const access = new AccessAdmissionRegistry(accessPool);
    const content = new ContentCore(contentPool);
    const comments = new ContentComments(contentPool);
    const verification = new VerificationStore(contentPool);
    const erasures = new ErasureService(relay, contentPool, accessPool);
    const ownerOperations = new OwnerOperations(relay, environment, undefined, undefined, undefined, erasures);
    const main = createMainApp(fuseki, { environment, account: account.verifier, access,
      platformAccess: new AccessExposure(accessPool), content, contentAuthoring: content, comments,
      verification, erasures, ownerOperations });
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, account.issuer, account.a.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await grantRecordedPlatformUse(accessPool, principalId, ['wiki-agents']);
    const authorIntent = { kind: 'person' as const, displayName: 'Fixture author' };
    await createAgentGraph(environment, { id: randomUUID(), agent: actor, ...authorIntent,
      digest: agentProvisionDigest(authorIntent) });
    const grant = async (resourceScope: string, action: string) => {
      const client = await accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [resourceScope]);
        await client.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [randomUUID(), principalId, actor, action]);
        await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
        [randomUUID(), actor, resourceScope, action]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };
    const token = account.tokenA;
    const send = (path: string, body: object, key: string, bearer = token) => main.handle(new Request(
      `http://main.local${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
    const read = (path: string, acting = false, bearer = token) => {
      const url = new URL(`http://main.local${path}`);
      if (acting) url.searchParams.set('actingSubject', actor);
      return main.handle(new Request(url, { headers: { authorization: `Bearer ${bearer}` } }));
    };
    const must = async (response: Response, status: number, label: string): Promise<HttpResult> => {
      const result = await take(response);
      if (result.status !== status) throw new Error(`${label}: HTTP ${result.status} ${result.text.slice(0, 800)}`);
      return result;
    };
    await grant('work:create:root', 'work.create');
    const createdWork = await must(await send('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
      language: 'en', title: `Erasure source ${randomUUID()}`, actingSubject: actor },
    `work-${randomUUID()}`), 201, 'work');
    const work = (createdWork.body as { work: string }).work;
    await grant(`work:read:${work}`, 'work.read');
    await grant(`content:draft:${work}`, 'content.draft');
    await grant(`content:comment:${work}`, 'content.comment');
    await grant(`erasure:${work}`, 'erasure.request');
    await grant('verification:claim:global', 'verification.claim-create');

    // The integration role cannot set session_replication_role. The immutability
    // trigger is what refuses putting a cleared selector back; turn it off for
    // the fixture statement and back on before commit so the product clear
    // still runs under that guard.
    const tamper = async (table: string, trigger: string, sql: string, values: unknown[]) => {
      const client = await contentPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        const result = await client.query(sql, values);
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        await client.query('COMMIT');
        return result.rowCount ?? 0;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };

    const stored = async (planted: Planted): Promise<StoredSource> => {
      const comment = (await contentPool.query<{ exact: string | null; prefix: string | null;
        suffix: string | null; body: string }>(
        'SELECT exact, prefix, suffix, body FROM content.comment WHERE id = $1',
        [planted.commentId])).rows[0];
      const evidence = (await contentPool.query<{ selector: StoredSource['selector']; source_terminal: boolean }>(
        `SELECT selector, source_terminal FROM verification.evidence_item
         WHERE content_revision_id = $1`, [planted.revisionId])).rows[0];
      if (!comment || !evidence) throw new Error('planted source row is missing');
      return { exact: comment.exact, prefix: comment.prefix, suffix: comment.suffix, body: comment.body,
        selector: evidence.selector, sourceTerminal: evidence.source_terminal };
    };

    const recorded = async (key: string) => (await relay.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM relay.owner_reconciliation WHERE operation_id = $1',
      [`owner:erasure:${key}`])).rows[0]?.n ?? 0;

    const triples = async (revisionId: string, erasureId: string): Promise<Triple[]> => {
      const revision = `urn:rezics:content:revision:${revisionId}`;
      const receipt = graphErasureReceipt(erasureId);
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?graph ?s ?p ?o WHERE {
        { GRAPH <${GRAPHS.revisions}> { ${iri(revision)} ?p ?o .
            BIND(${iri(revision)} AS ?s) BIND(<${GRAPHS.revisions}> AS ?graph) } }
        UNION
        { GRAPH <${GRAPHS.receipts}> { ${iri(receipt)} ?p ?o .
            BIND(${iri(receipt)} AS ?s) BIND(<${GRAPHS.receipts}> AS ?graph) } }
      }`);
      return (result.results?.bindings ?? []).map(row => ({
        graph: row.graph?.value ?? '', s: row.s?.value ?? '', p: row.p?.value ?? '', o: row.o?.value ?? '',
      })).sort((left, right) => `${left.graph} ${left.s} ${left.p} ${left.o}`
        .localeCompare(`${right.graph} ${right.s} ${right.p} ${right.o}`));
    };

    const reconcile = (erasureId: string, key: string, bearer = token) => send('/v1/owners/reconciliations',
      { profile: 'owner-reconciliation-v1', kind: 'erasure', erasureId }, key, bearer);

    /** Publish one revision, quote it, erase it, then put the quotes back. */
    const plant = async (): Promise<Planted> => {
      const quote = `Quoted paragraph ζ ${randomUUID()}`;
      const annotation = `Authored annotation ζ ${randomUUID()}`;
      const body = `Opening paragraph ${randomUUID()}\n${quote}\nClosing paragraph ${randomUUID()}`;
      const start = body.indexOf(quote);
      const end = start + quote.length;
      expect(annotation.includes(quote)).toBe(false);
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await must(await send('/v1/content-drafts', { profile: 'content-text-v1', resourceId: work,
        variantId, language, direction: 'ltr', expectedHead: null, body, actingSubject: actor },
      `draft-${randomUUID()}`), 201, 'draft');
      const revisionId = (draft.body as { revisionId: string }).revisionId;
      const commented = await must(await send('/v1/content-comments', { profile: 'content-paragraph-comment-v1',
        resourceId: work, revisionId, exact: quote, body: annotation, actingSubject: actor },
      `comment-${randomUUID()}`), 201, 'comment');
      const commentBody = commented.body as { comment: string; body: string;
        target: { selector: { exact: string; prefix: string; suffix: string } } };
      const commentId = short(commentBody.comment);
      expect(commentBody.body).toBe(annotation);
      expect(commentBody.target.selector.exact).toBe(quote);
      const claimed = await must(await send('/v1/claims', { profile: 'claim-create-v1',
        referent: `https://rezics.com/id/${randomUUID()}`, interpretationContext: 'urn:rezics:context:global',
        propositionPredicate: 'https://rezics.com/definition/source-quote',
        value: { kind: 'literal', lexical: 'quoted', datatype: 'string' }, valuePrecision: 'exact',
        valueQualifiers: [], validFrom: null, validUntil: null, editionScope: null, actingSubject: actor },
      `claim-${randomUUID()}`), 201, 'claim');
      const claim = (claimed.body as { claim: { claim: string; revision: string } }).claim;
      const evidenced = await must(await send(`/v1/claims/${short(claim.claim)}/evidence`, {
        profile: 'claim-evidence-v1', claimRevision: claim.revision, expectedHead: null,
        items: [{ stance: 'supports', contentRevision: revisionId,
          selector: { exact: quote, start, end }, availability: 'available' }] },
      `evidence-${randomUUID()}`), 201, 'evidence');
      const evidence = (evidenced.body as { evidence: { revision: string; manifestDigest: string;
        items: { selector: { exact?: string; start?: number; end?: number } }[] } }).evidence;
      expect(evidence.items[0]?.selector.exact).toBe(quote);
      expect(evidence.items[0]?.selector.start).toBe(start);
      expect(evidence.items[0]?.selector.end).toBe(end);
      const visible = await must(await read(`/v1/content-comments/${commentId}`, true), 200, 'comment read');
      expect((visible.body as { resolvedText?: string }).resolvedText).toBe(quote);
      const evidenceRead = await must(await read(
        `/v1/claims/${short(claim.claim)}/evidence/${short(evidence.revision)}`), 200, 'evidence read');
      expect(JSON.stringify(evidenceRead.body)).toContain(quote);
      const erased = await must(await send('/v1/erasures', { profile: 'content-revision-erasure-v1',
        actingSubject: actor, resourceId: work, revisionIds: [revisionId] },
      `erase-${randomUUID()}`), 200, 'erasure');
      const erasure = erased.body as { erasureId: string; erasureEpoch: string };
      const planted: Planted = { revisionId, commentId, claimId: short(claim.claim),
        evidenceId: short(evidence.revision), erasureId: erasure.erasureId, erasureEpoch: erasure.erasureEpoch,
        quote, annotation, start, end, prefix: commentBody.target.selector.prefix,
        suffix: commentBody.target.selector.suffix, manifestDigest: evidence.manifestDigest, graph: [] };
      const commentRows = await tamper('content.comment', 'comment_immutable',
        'UPDATE content.comment SET exact = $2, prefix = $3, suffix = $4 WHERE id = $1',
        [commentId, quote, planted.prefix, planted.suffix]);
      const evidenceRows = await tamper('verification.evidence_item', 'verification_evidence_item_immutable',
        `UPDATE verification.evidence_item
           SET selector = selector || jsonb_build_object('exact', $2::text),
               source_terminal = false, source_erasure_id = NULL, source_erasure_epoch = NULL
         WHERE content_revision_id = $1`, [revisionId, quote]);
      if (commentRows !== 1 || evidenceRows !== 1) {
        throw new Error(`replant updated comment ${commentRows} evidence ${evidenceRows}`);
      }
      const open = await stored(planted);
      expect(open.exact).toBe(quote);
      expect(open.prefix).toBe(planted.prefix);
      expect(open.suffix).toBe(planted.suffix);
      expect(open.body).toBe(annotation);
      expect(open.selector.exact).toBe(quote);
      expect(open.selector.start).toBe(start);
      expect(open.selector.end).toBe(end);
      expect(open.sourceTerminal).toBe(false);
      // A replanted selector on an erased revision is hidden. The annotation returns only
      // after exact, prefix and suffix are all null.
      const hidden = await take(await read(`/v1/content-comments/${commentId}`, true));
      expect(hidden.status).toBe(404);
      expect(problemOf(hidden.body).code).toBe('comment_unavailable');
      // The evidence route drops source text for every erased revision, even when the
      // quote is still stored. Coordinates and the manifest stay. SQL above is the
      // stored-byte proof; a remaining quote cannot reconcile as erased.
      const projected = await must(await read(`/v1/claims/${planted.claimId}/evidence/${planted.evidenceId}`),
        200, 'evidence after replant');
      const projectedItem = (projected.body as { items: { selector: { exact?: string; start?: number; end?: number };
        currentAvailability?: string }[]; manifestDigest: string });
      expect(projectedItem.manifestDigest).toBe(evidence.manifestDigest);
      expect(projectedItem.items[0]?.selector.exact).toBeUndefined();
      expect(projectedItem.items[0]?.selector.start).toBe(start);
      expect(projectedItem.items[0]?.selector.end).toBe(end);
      expect(projectedItem.items[0]?.currentAvailability).toBe('erased');
      expect(JSON.stringify(projected.body)).not.toContain(quote);
      planted.graph = await triples(revisionId, erasure.erasureId);
      expect(planted.graph.some(row => row.o === `${RV}ErasedRevision`)).toBe(true);
      expect(planted.graph.some(row => row.graph === GRAPHS.receipts)).toBe(true);
      return planted;
    };

    const expectOpen = async (planted: Planted) => {
      const row = await stored(planted);
      expect(row.exact).toBe(planted.quote);
      expect(row.prefix).toBe(planted.prefix);
      expect(row.suffix).toBe(planted.suffix);
      expect(row.body).toBe(planted.annotation);
      expect(row.selector.exact).toBe(planted.quote);
      expect(row.selector.start).toBe(planted.start);
      expect(row.selector.end).toBe(planted.end);
      expect(row.sourceTerminal).toBe(false);
    };
    const expectCleared = async (planted: Planted) => {
      const row = await stored(planted);
      expect(row.exact).toBeNull();
      expect(row.prefix).toBeNull();
      expect(row.suffix).toBeNull();
      expect(row.body).toBe(planted.annotation);
      expect(row.selector.exact).toBeUndefined();
      expect(row.selector.start).toBe(planted.start);
      expect(row.selector.end).toBe(planted.end);
      expect(JSON.stringify(row.selector)).not.toContain(planted.quote);
      expect(row.sourceTerminal).toBe(true);
    };
    const expectCommentKept = async (planted: Planted) => {
      const result = await must(await read(`/v1/content-comments/${planted.commentId}`, true), 200, 'cleared comment');
      const comment = result.body as { body: string; resolvedText?: string;
        target: { type: string; source: string; selector?: unknown } };
      expect(comment.body).toBe(planted.annotation);
      expect(comment.resolvedText).toBeUndefined();
      expect(comment.target).toEqual({ type: 'SpecificResource',
        source: `urn:rezics:content:revision:${planted.revisionId}` });
      expect(JSON.stringify(comment)).not.toContain(planted.quote);
    };
    const expectEvidenceKept = async (planted: Planted) => {
      const result = await must(await read(`/v1/claims/${planted.claimId}/evidence/${planted.evidenceId}`),
        200, 'evidence after');
      const evidence = result.body as { manifestDigest: string; items: { contentRevision?: string;
        currentAvailability?: string; selector: { exact?: string; start?: number; end?: number } }[] };
      expect(evidence.manifestDigest).toBe(planted.manifestDigest);
      expect(evidence.items[0]?.contentRevision).toBe(planted.revisionId);
      expect(evidence.items[0]?.selector.start).toBe(planted.start);
      expect(evidence.items[0]?.selector.end).toBe(planted.end);
      expect(evidence.items[0]?.selector.exact).toBeUndefined();
      expect(evidence.items[0]?.currentAvailability).toBe('erased');
      expect(JSON.stringify(evidence)).not.toContain(planted.quote);
    };
    const expectHidden = async (planted: Planted) => {
      const hidden = await take(await read(`/v1/content-comments/${planted.commentId}`, true));
      expect(hidden.status).toBe(404);
      expect(problemOf(hidden.body).code).toBe('comment_unavailable');
      await expectEvidenceKept(planted);
    };
    const revisionTriples = (rows: Triple[]) => rows.filter(row => row.graph === GRAPHS.revisions);

    const deleteReceipt = async (erasureId: string) => {
      const receipt = graphErasureReceipt(erasureId);
      await fuseki.update(`DELETE { GRAPH <${GRAPHS.receipts}> { ${iri(receipt)} ?p ?o } }
        WHERE { GRAPH <${GRAPHS.receipts}> { ${iri(receipt)} ?p ?o } }`);
    };
    return { stop, plant, reconcile, recorded, expectOpen, expectCleared, expectCommentKept,
      expectEvidenceKept, expectHidden, triples, revisionTriples, tamper, deleteReceipt,
      token, noScope: account.noScope, work, accessPool, principalId, read };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('operator reconciliation clears replanted comment and evidence sources or refuses without recording', async () => {
  const live = await stack();
  console.info('erasure source reconciliation: clear and replay');
  {
    const planted = await live.plant();
    const key = `erasure-source-${randomUUID()}`;
    const first = await take(await live.reconcile(planted.erasureId, key));
    expect(first.status, first.text).toBe(201);
    const view = first.body as ErasureView;
    expect(view).toMatchObject({ profile: 'owner-reconciliation-v1', kind: 'erasure',
      erasure: planted.erasureId, disposition: 'erased', replayed: false });
    expect(['held', 'reconciled']).toContain(view.state);
    // The read path reports the stored row. It does not repeat the create's replayed flag.
    const fetched = await take(await live.read(`/v1/owners/reconciliations/${view.id}`));
    expect(fetched.status, fetched.text).toBe(200);
    expect(fetched.body).toMatchObject({ kind: 'erasure', id: view.id, erasure: planted.erasureId,
      disposition: 'erased' });
    const replay = await take(await live.reconcile(planted.erasureId, key));
    expect(replay.status, replay.text).toBe(200);
    expect(replay.body).toMatchObject({ id: view.id, kind: 'erasure', erasure: planted.erasureId,
      replayed: true, disposition: 'erased' });
    await live.expectCleared(planted);
    await live.expectCommentKept(planted);
    await live.expectEvidenceKept(planted);
    expect(await live.triples(planted.revisionId, planted.erasureId)).toEqual(planted.graph);
  }

  console.info('erasure source reconciliation: native proof');
  {
    const planted = await live.plant();
    await live.deleteReceipt(planted.erasureId);
    const deleted = await live.triples(planted.revisionId, planted.erasureId);
    expect(deleted.some(row => row.graph === GRAPHS.receipts)).toBe(false);
    expect(deleted.some(row => row.o === `${RV}ErasedRevision`)).toBe(true);
    const key = `erasure-source-${randomUUID()}`;
    const refused = await take(await live.reconcile(planted.erasureId, key));
    expect(refused.status, refused.text).toBe(503);
    expect(problemOf(refused.body).code).toBe('owner_unavailable');
    expect(problemOf(refused.body).title).toContain('native');
    expect(await live.recorded(key)).toBe(0);
    await live.expectOpen(planted);
    await live.expectHidden(planted);
    expect(live.revisionTriples(await live.triples(planted.revisionId, planted.erasureId)))
      .toEqual(live.revisionTriples(planted.graph));
    expect((await live.triples(planted.revisionId, planted.erasureId))
      .some(row => row.graph === GRAPHS.receipts)).toBe(false);
  }

  console.info('erasure source reconciliation: foreign epoch');
  {
    const planted = await live.plant();
    expect(await live.tamper('content.revision_erasure', 'revision_erasure_immutable',
      'UPDATE content.revision_erasure SET erasure_epoch = erasure_epoch + 1000 WHERE revision_id = $1',
      [planted.revisionId])).toBe(1);
    const key = `erasure-source-${randomUUID()}`;
    const refused = await take(await live.reconcile(planted.erasureId, key));
    expect(refused.status, refused.text).toBe(400);
    expect(problemOf(refused.body).code).toBe('invalid_owner_request');
    expect(problemOf(refused.body).title).toContain('stale');
    expect(await live.recorded(key)).toBe(0);
    await live.expectOpen(planted);
    await live.expectHidden(planted);
  }

  console.info('erasure source reconciliation: foreign journal');
  {
    const planted = await live.plant();
    const other = randomUUID();
    expect(await live.tamper('content.revision_erasure', 'revision_erasure_immutable',
      'UPDATE content.revision_erasure SET erasure_id = $2 WHERE revision_id = $1',
      [planted.revisionId, other])).toBe(1);
    const key = `erasure-source-${randomUUID()}`;
    const refused = await take(await live.reconcile(planted.erasureId, key));
    expect(refused.status, refused.text).toBe(400);
    expect(problemOf(refused.body).code).toBe('invalid_owner_request');
    expect(problemOf(refused.body).title).toContain('stale');
    expect(await live.recorded(key)).toBe(0);
    await live.expectOpen(planted);
    await live.expectHidden(planted);
  }

  console.info('erasure source reconciliation: inactive principal');
  {
    const planted = await live.plant();
    const key = `erasure-source-${randomUUID()}`;
    await live.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [live.principalId]);
    try {
      const refused = await take(await live.reconcile(planted.erasureId, key));
      expect(refused.status, refused.text).toBe(403);
      expect(problemOf(refused.body).code).toBe('authority_denied');
      expect(await live.recorded(key)).toBe(0);
      await live.expectOpen(planted);
    } finally {
      await live.accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [live.principalId]);
    }
    await live.expectHidden(planted);
    expect(live.revisionTriples(await live.triples(planted.revisionId, planted.erasureId)))
      .toEqual(live.revisionTriples(planted.graph));
  }

  console.info('erasure source reconciliation: preservation hold, then the same key');
  {
    const planted = await live.plant();
    const caseId = randomUUID();
    const holdId = randomUUID();
    await live.accessPool.query(`INSERT INTO access.governance_case
      (id, kind, authority_kind, authority_scope_id, context, target_owner,
        target_resource, target_component, disclosure)
      VALUES ($1, 'content_report', 'platform', 'governance:platform',
        'urn:rezics:context:global', 'content', $2, 'body', 'private')`, [caseId, live.work]);
    await live.accessPool.query(`INSERT INTO access.governance_preservation_hold
      (id, case_id, target_resource, reason) VALUES ($1, $2, $3, 'retained safety evidence')`,
    [holdId, caseId, live.work]);
    const release = () => live.accessPool.query(
      `UPDATE access.governance_preservation_hold SET released_at = clock_timestamp()
       WHERE id = $1 AND released_at IS NULL`, [holdId]);
    const key = `erasure-source-${randomUUID()}`;
    try {
      const refused = await take(await live.reconcile(planted.erasureId, key));
      expect(refused.status, refused.text).toBe(409);
      expect(problemOf(refused.body).code).toBe('owner_operation_busy');
      expect(problemOf(refused.body).title).toBe('erasure is held by a preservation hold');
      expect(await live.recorded(key)).toBe(0);
      await live.expectOpen(planted);
      await live.expectHidden(planted);
      await release();
      const retried = await take(await live.reconcile(planted.erasureId, key));
      expect(retried.status, retried.text).toBe(201);
      const view = retried.body as ErasureView;
      expect(view).toMatchObject({ kind: 'erasure', erasure: planted.erasureId, disposition: 'erased',
        replayed: false });
      await live.expectCleared(planted);
      await live.expectCommentKept(planted);
      await live.expectEvidenceKept(planted);
      const replay = await take(await live.reconcile(planted.erasureId, key));
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body).toMatchObject({ id: view.id, replayed: true, disposition: 'erased' });
    } finally { await release(); }
  }

  console.info('erasure source reconciliation: missing owner:operate');
  {
    const planted = await live.plant();
    const key = `erasure-source-${randomUUID()}`;
    const refused = await take(await live.reconcile(planted.erasureId, key, live.noScope));
    await live.expectOpen(planted);
    expect(await live.recorded(key)).toBe(0);
    await live.expectHidden(planted);
    // The operation refuses a caller that did not present owner:operate.
    expect(refused.status, refused.text).toBe(403);
    expect(problemOf(refused.body).code, refused.text).toBe('authority_denied');
  }
}, 420_000);
