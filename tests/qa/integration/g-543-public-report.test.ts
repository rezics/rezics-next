import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import { PostgresRateLimitStore, type RateLimitOptions } from '../../../services/main/src/modules/rate-limit/store.ts';
import { principalClasses, rateLimitBudgets } from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { AccountAssertionUnavailable } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

interface Receipt { caseId: string; reportId: string; credential: string }

test('G-543/G-564: an exhausted writer files a real public report, reads its status and appeals independently', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run with the QA integration tier');
  const directory = `.temp/g-543-joint-${randomUUID()}`;
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content', 'relay']);
  const f = await authorCreditFixture({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account,
    ACCESS_DATABASE_URL: databases.urls.access, CONTENT_DATABASE_URL: databases.urls.content } as Record<string, string>,
  directory, 'openid work:create work:read work:edit agent:create governance:report');
  const accountPool = new Pool({ connectionString: databases.urls.account });
  try {
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor, kind: 'person',
      displayName: 'Joint report writer', digest: createHash('sha256').update(f.actor).digest('hex') });
    const core = new ContentCore(f.pool);
    const options: RateLimitOptions = { secret: 'g543-joint-test-secret-at-least-32-characters',
      serviceClientIds: new Set(), trustedProxyPeers: new Set(), clientIpHeader: 'x-rezics-client-ip' };
    const store = new PostgresRateLimitStore(f.accessPool, options);
    const deps: MainWorkDependencies = { environment: f.env, access: f.access, account: f.account.verifier,
      content: core, contentAuthoring: core, rateLimit: { options, store,
        budgets: rateLimitBudgets(JSON.stringify(Object.fromEntries(principalClasses.map(item => [item,
          { write: { maximum: 4, seconds: 60 } }])))) } };
    deps.publicReports = new PublicReports(f.accessPool, publicReportOwners(deps, f.pool, core));
    const app = createMainApp(f.env.fuseki, deps);
    const call = (method: string, path: string, body?: unknown, token?: string, secret?: string) =>
      app.handle(new Request(`http://main.test${path}`, { method, headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(secret ? { 'x-rezics-case-credential': secret } : {}),
        ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(response: Response, status: number): Promise<T> => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    const create = () => call('POST', '/v1/works', { profile: 'metadata-only-v1', language: 'en',
      title: `Budget joint report ${randomUUID()}`, semanticTypes: ['https://schema.org/Book'],
      authoring: 'own-work', actingSubject: f.actor }, f.account.tokenA);
    const work = await json<{ work: string; mainVersion: string }>(await create(), 201);
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'Published reported text',
      actingSubject: f.actor,
    }, f.account.tokenA), 201);
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const publication = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor,
    }, f.account.tokenA), 201);
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    await json(await call('POST', '/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, expectedSelectionHead: null,
      work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      selectionBasis: 'main-maintainer', actingSubject: f.actor,
    }, f.account.tokenA), 201);
    const exhausted = await create();
    expect(exhausted.status).toBe(429);
    expect(Number(exhausted.headers.get('retry-after'))).toBeGreaterThan(0);
    const input = { profile: 'public-report-v1', target: work.work, category: 'harassment',
      statement: 'Reported after my ordinary budget was spent', contentLanguage: 'sw-KE' };
    const signed = await json<Receipt>(await call('POST', '/v1/public-reports', input, f.account.tokenA), 201);
    const own = await json<{ reports: Array<{ reportId: string }> }>(await call('GET', '/v1/public-reports/mine',
      undefined, f.account.tokenA), 200);
    expect(own.reports.map(item => item.reportId)).toContain(signed.reportId);
    const status = () => call('GET', `/v1/public-reports/${signed.caseId}`, undefined,
      f.account.tokenA, signed.credential);
    expect(await json(await status(), 200)).toMatchObject({ reportId: signed.reportId, state: 'open' });
    await json(await call('POST', `/v1/public-reports/${signed.caseId}/correspondence`, {
      kind: 'appeal', statement: 'Independent appeal intake', contentLanguage: 'sw-KE',
    }, f.account.tokenA, signed.credential), 200);
    expect(await json(await status(), 200)).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ kind: 'appeal', statement: 'Independent appeal intake' }),
    ]) });
    // Both Account denial and outage are exercised through the real G-564
    // handler/owner/store, rather than a stub that unconditionally succeeds.
    await json(await call('POST', '/v1/public-reports', input, 'rejected'), 201);
    const verify = deps.account.verify;
    deps.account.verify = async () => { throw new AccountAssertionUnavailable('offline'); };
    try {
      await json(await call('POST', '/v1/public-reports', input, f.account.tokenA), 201);
      await json(await status(), 200);
    } finally { deps.account.verify = verify; }
    await accountPool.query(`UPDATE rezics_account_security SET suspended_at = now(), generation = generation + 1
      WHERE user_id = $1`, [f.account.a.id]);
    await json(await call('POST', '/v1/public-reports', input, f.account.tokenA), 201);
    await json(await status(), 200);
    expect((await f.accessPool.query('SELECT id FROM access.governance_report WHERE statement = $1', [input.statement])).rowCount).toBe(4);
    expect((await f.accessPool.query('SELECT id FROM access.governance_report WHERE principal_id IS NULL AND statement = $1', [input.statement])).rowCount).toBe(3);
  } finally {
    await accountPool.end(); await f.close(); await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
