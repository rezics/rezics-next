import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { ContentComments } from '../../../services/content/src/comments.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ratingAccount } from '../support/rating-account.ts';

test('MODEL13: Annotation through the Content comment API retains OA type, target, selector and local revision evidence', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const apps = Bun.env as Record<string, string>;
  const account = await ratingAccount(apps,
    'openid work:create work:edit work:read comment:create');
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  try {
    await migrateContent(contentPool);
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principal = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principal, account.issuer, account.a.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principal, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    };
    const fuseki = new FusekiClient(apps.FUSEKI_URL!);
    const content = new ContentCore(contentPool);
    const environment = { fuseki,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: resolve('.temp', `model-standard-annotation-${randomUUID()}`) };
    await provisionFixtureAuthor(environment, actor);
    const app = createMainApp(fuseki, { environment,
      account: account.verifier, access: new AccessAdmissionRegistry(accessPool),
      content, contentAuthoring: content, comments: new ContentComments(contentPool) });
    const call = (method: 'GET' | 'POST', path: string, body?: object,
      key = randomUUID(), token = account.tokenA) => {
      const url = new URL(`http://main.local${path}`);
      if (method === 'GET') url.searchParams.set('actingSubject', actor);
      return app.handle(new Request(url, { method, headers: {
        authorization: `Bearer ${token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    };
    await grant('work:create:root', 'work.create');
    const workResponse = await call('POST', '/v1/works', { language: 'en',
      profile: 'metadata-only-v1', authoring: 'own-work', title: `Annotation ${randomUUID()}`, actingSubject: actor });
    expect(workResponse.status).toBe(201);
    const work = (await workResponse.json() as { work: string }).work;
    await grant(`work:read:${work}`, 'work.read');
    await grant(`content:draft:${work}`, 'content.draft');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const paragraph = `Exact paragraph ${randomUUID()}`;
    const original = `Opening\n${paragraph}\nClosing`;
    const draft = (body: string, expectedHead: string | null) => ({
      profile: 'content-text-v1', resourceId: work, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead, body, actingSubject: actor });
    const firstResponse = await call('POST', '/v1/content-drafts', draft(original, null));
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { revisionId: string };
    const commentBody = { profile: 'content-paragraph-comment-v1', resourceId: work,
      revisionId: first.revisionId, exact: paragraph, body: 'A precise comment',
      actingSubject: actor };
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`content:comment:${work}`]);
    expect((await call('POST', '/v1/content-comments', commentBody)).status).toBe(403);
    await grant(`content:comment:${work}`, 'content.comment');
    const key = randomUUID();
    const response = await call('POST', '/v1/content-comments', commentBody, key);
    expect(response.status).toBe(201);
    const created = await response.json() as { type: string; motivation: string;
      comment: string; body: string; revisionId: string; byteDigest: string;
      target: { type: string; source: string; selector: { type: string; exact: string;
        prefix: string; suffix: string } }; replayed: boolean };
    expect(created).toMatchObject({ type: 'Annotation', motivation: 'commenting',
      body: 'A precise comment', revisionId: first.revisionId,
      target: { type: 'SpecificResource',
        source: `urn:rezics:content:revision:${first.revisionId}`,
        selector: { type: 'TextQuoteSelector', exact: paragraph,
          prefix: 'Opening\n', suffix: '\nClosing' } } });
    expect(created.comment).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    expect(created.byteDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('POST', '/v1/content-comments', {
      ...commentBody, exact: 'Exact paragraph' })).status).toBe(400);
    const replay = await call('POST', '/v1/content-comments', commentBody, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ comment: created.comment,
      type: 'Annotation', motivation: 'commenting', replayed: true });
    const secondResponse = await call('POST', '/v1/content-drafts',
      draft('Opening\nChanged paragraph\nClosing', first.revisionId));
    expect(secondResponse.status).toBe(201);
    const exact = await call('GET', `/v1/content-comments/${created.comment.split('/').at(-1)}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ comment: created.comment, type: 'Annotation',
      motivation: 'commenting', revisionId: first.revisionId, resolvedText: paragraph,
      target: created.target });
    const page = await call('GET', `/v1/content-revisions/${first.revisionId}/comments`);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ comments: [{ comment: created.comment,
      type: 'Annotation', target: created.target }] });
    expect((await call('GET', `/v1/content-comments/${created.comment.split('/').at(-1)}`,
      undefined, randomUUID(), account.tokenB)).status).toBe(404);
  } finally {
    await account.close();
    await Promise.all([accessPool.end(), contentPool.end()]);
  }
}, 120_000);
