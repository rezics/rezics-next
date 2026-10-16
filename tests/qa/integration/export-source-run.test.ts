import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { mainConfig } from '../../../services/main/src/config.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { OPEN_LIBRARY_WORKS_RUN, type SourceRunProviderAdapter } from '../../../services/main/src/modules/source/acquisition-run.ts';
import type { ExportPlan } from '../../../services/main/src/modules/export/planner.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('an editor seals, reads and exports Open Library edition evidence through the composed owners', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Use the isolated QA integration tier');
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content'], 'owner');
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  const previousGroups = process.env.REZICS_PLATFORM_OPEN_GROUPS;
  process.env.REZICS_PLATFORM_OPEN_GROUPS = '*';
  try {
    await migrateContent(contentPool);
    account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>,
      'openid export:create export:read work:create work:edit work:read');
    const actor = agent(), principalId = randomUUID();
    const client = await accessPool.connect();
    try {
      await client.query('BEGIN');
      await registerFixtureIdentity(client, { principalId, issuer: account.issuer, subject: account.a.id, actor });
      await client.query('COMMIT');
    } finally { client.release(); }
    const grant = (scope: string, action: string) => grantFixtureAuthority(accessPool, {
      scope, requireDispatch: true, representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    const runtime = await composeMain({ config: mainConfig(), accessPool, contentPool,
      fuseki: new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN),
      overrides: { account: account.verifier } });
    const request = new Request('http://main.local', { headers: { authorization: `Bearer ${account.tokenA}` } });
    const call = (method: string, path: string, body?: unknown, key = randomUUID(), token = account!.tokenA) =>
      runtime.app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json',
          'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    await grant('work:create:root', 'work.create');
    const work = await createAdmittedMetadataWork(runtime.environment, account.verifier, runtime.access, request,
      { title: 'Frozen edition evidence', semanticTypes: ['https://schema.org/Book'],
        actingSubject: actor, idempotencyKey: randomUUID() });
    await grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await createAdmittedTextContribution(runtime.environment, account.verifier, runtime.access, request,
      { work: work.work, language: 'en', body: 'An editor supplies the native text; the source supplies no author.',
        actingSubject: actor, idempotencyKey: randomUUID() });
    if (!draft.contribution || !draft.draftRevision) throw new Error('Missing fixture draft');
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const publication = await publishAdmittedTextContribution(runtime.environment, account.verifier, runtime.access, request,
      { contribution: draft.contribution, expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor, idempotencyKey: randomUUID() });
    if (!publication.publicationDecision) throw new Error('Missing fixture publication');
    await grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await selectAdmittedMainDefault(runtime.environment, account.verifier, runtime.access, request,
      { context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
        contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor, idempotencyKey: randomUUID() });
    if (!selected.mainRevision || !selected.selection) throw new Error('Missing fixture selection');

    const runs = runtime.dependencies.sourceAcquisitions!.runs;
    const bytes = Buffer.from('{"size":2,"entries":[{"key":"/books/OL12M","authors":null,"revision":7},' +
      '{"key":"/books/OL11M","authors":[],"revision":3}],"provider_note":"kept exactly"}');
    const digest = sha(bytes), requestKey = 'GET /works/OL1W/editions.json?limit=25&offset=0';
    const started = await runs.start(principalId, randomUUID(), 'open-library', OPEN_LIBRARY_WORKS_RUN,
      sha('edition-fixture'), [{ surface: 'editions', namespace: 'work-editions', required: true, captureLimit: 1 }],
      'https://openlibrary.org/developers/api');
    const adapter: SourceRunProviderAdapter = { provider: 'open-library', termsReference: 'https://openlibrary.org/developers/api',
      decode: value => JSON.parse(value.toString()), fetch: async () => ({ ok: true, status: 200,
        url: 'https://openlibrary.org/works/OL1W/editions.json?limit=25&offset=0', mediaType: 'application/json',
        bytes, parsed: JSON.parse(bytes.toString()), etag: null, lastModified: null, fetchedAt: '2026-10-16T00:00:00.000Z' }) };
    expect((await runs.acquire(principalId, started.runId, 'editions', { requestKey,
      path: '/works/OL1W/editions.json?limit=25&offset=0', namespace: 'work-editions', externalId: 'OL1W',
      captureProfile: 'open-library-run-capture-v1', coverageScope: 'open-library-work-editions-v1', validate: () => null }, adapter)).ok).toBe(true);
    await runs.settle(started.runId, 'editions', 'qualified', 'complete');
    await runs.complete(started.runId);
    const run = (await runs.read(principalId, started.runId))!;
    const position = { dataEpoch: sha(`editions\t${digest}`), sequence: '0' };
    const links = ['OL12M', 'OL11M'].map(id => {
      const release = `open-library:edition:${id}`;
      return { run: run.run, release, sourceClaim: `urn:rezics:source-occurrence:${sha(`${digest}\0${release}`)}`,
        expectedPosition: position };
    });
    await grant(`release:seal:${work.mainVersion}`, 'release.seal');
    const intent = { profile: 'fixed-native-text-release-v1', work: work.work, mainVersion: work.mainVersion,
      expectedMainRevision: selected.mainRevision, expectedSelection: selected.selection,
      actingSubject: actor, externalReleases: links };
    const key = randomUUID();
    const sealed = await call('POST', '/v1/fixed-releases', intent, key);
    expect(sealed.status, await sealed.clone().text()).toBe(201);
    const release = await sealed.json() as { release: string; sourcePosition: typeof position;
      externalReleases: Array<typeof links[number] & { observation: string; captureDigest: string }> };
    expect(release.externalReleases.map(link => link.release)).toEqual(links.map(link => link.release));
    expect(release.externalReleases.every(link => link.captureDigest === digest)).toBe(true);
    expect(JSON.stringify(release)).not.toContain('sourcePrincipalId');
    expect((await call('POST', '/v1/fixed-releases', intent, key)).status).toBe(200);
    const read = await call('GET', `/v1/fixed-releases/${release.release.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`);
    expect(read.status, await read.clone().text()).toBe(200);
    expect((await read.json() as typeof release).externalReleases).toEqual(release.externalReleases);
    for (const selection of [{ kind: 'fixed-release', reference: release.release, expectedPosition: release.sourcePosition },
      { kind: 'source-run', reference: run.run, expectedPosition: position }]) {
      await grant(`export:${selection.reference}`, 'export.create');
      const body = { profile: 'export-create-v1', actingSubject: actor, useScope: 'evaluation', selection };
      const exportKey = randomUUID(), response = await call('POST', '/v1/exports', body, exportKey);
      expect(response.status, await response.clone().text()).toBe(201);
      const saved = await response.json() as { manifestId: string; manifestDigest: string; plan: ExportPlan };
      expect(saved.plan.licenseScope).toBe('uncertain');
      expect(saved.plan.members.every(member => member.data?.rightsIdentity !== undefined)).toBe(true);
      if (selection.kind === 'source-run') {
        expect(saved.plan.targetProfile).toBe('rezics-source-run-v1');
        const capture = saved.plan.members.find(member => member.sourceGrain === 'source_observation')!;
        expect(Buffer.from(capture.data!.rawBytesBase64 as string, 'base64')).toEqual(bytes);
        expect(saved.plan.work.bytes).toBeLessThan(1_048_576);
        expect(JSON.stringify(saved.plan)).not.toContain('creditedName');
      } else expect(saved.plan.members.slice(1).map(member => member.exactRef)).toEqual(links.map(link => link.release));
      expect((await call('POST', '/v1/exports', body, exportKey)).status).toBe(200);
      const download = await call('GET', `/v1/exports/${saved.manifestId}`);
      expect(download.status, await download.clone().text()).toBe(200);
      expect((await download.json() as typeof saved).manifestDigest).toBe(saved.manifestDigest);
      expect((await call('GET', `/v1/exports/${saved.manifestId}`, undefined, randomUUID(), account.tokenB)).status).toBe(403);
      await accessPool.query('UPDATE access.permission_grant SET active=false WHERE recipient_subject=$1 AND scope_id=$2',
        [actor, `export:${selection.reference}`]);
      expect((await call('GET', `/v1/exports/${saved.manifestId}`)).status).toBe(403);
    }
  } finally {
    if (previousGroups === undefined) delete process.env.REZICS_PLATFORM_OPEN_GROUPS;
    else process.env.REZICS_PLATFORM_OPEN_GROUPS = previousGroups;
    await account?.close();
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
  }
}, 120_000);
