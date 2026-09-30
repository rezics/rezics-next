import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneOwners } from './recommendation-support.ts';
import { RankingGenerations, RANKING_PROFILE } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { graphZeroSnapshot } from '../../../services/main/src/modules/recommendation/zero-candidates.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { CatalogueIntakeStore, unverifiedWorks } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { readExportPlan, ExportSourceNotFound } from '../../../services/main/src/modules/export/readers.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readCatalogueVerification } from '../../../services/main/src/modules/catalogue-intake/verification.ts';
import { ownerOutboxEventHandler } from '../../../services/main/src/modules/outbox/event-handlers.ts';

async function json<T>(response: Response, expected = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
type Candidates = { candidateReceipt: string; candidates: { work: string; attributes: { field: string; value: string; language: string | null }[] }[] };
type Created = { work: string; workRevision: string; mainVersion: string; replayed: boolean };

test('G842: multilingual candidate receipts, grain guard, quota races, replay and reviewed trust through HTTP', async () => {
  const stack = await startMediaStack('g842-intake');
  let relay: Pool | undefined;
  let relayOwner: Awaited<ReturnType<typeof cloneOwners>> | undefined;
  try {
    const editor = await stack.member('new-editor');
    const reviewer = await stack.member('reviewer');
    await editor.grant('work:create:root', 'work.create');
    await reviewer.grant('catalogue:verify:root', 'catalogue.verify');
    await reviewer.grant(MANAGE_SCOPE, MANAGE_ACTION);
    relayOwner = await cloneOwners(Bun.env.REZICS_QA_RUN_ID!, ['relay']);
    relay = new Pool({ connectionString: relayOwner.urls.relay, max: 2 });
    let rankingCandidates: string[] = [];
    const recommendations = new RankingGenerations({ access: stack.accessPool, relay,
      dataEpoch: stack.env.lineage.dataEpoch, cursorKey: randomBytes(32),
      canReadWork: (principal, actor, work) => stack.access.canReadWork(principal, actor, work),
      zeroSnapshot: () => graphZeroSnapshot(stack.env),
      zeroCandidates: async (after, _snapshot, limit) => rankingCandidates.filter(work => !after || work > after).slice(0, limit),
      unverifiedWorks: works => unverifiedWorks(stack.env, works) });
    const catalogueIntake = new CatalogueIntakeStore(stack.accessPool, stack.env);
    const deps: MainWorkDependencies = { environment: stack.env, access: stack.access,
      media: stack.media, catalogueIntake, recommendations, account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [editor, reviewer].find(member => member.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown test bearer');
        return member.principal;
      } } };
    const app = createMainApp(stack.fuseki, deps);
    const send = (method: string, path: string, body?: unknown, key = randomUUID(), token = editor.token) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const candidateBody = (value: string, language = 'en') => ({ profile: 'catalogue-candidates-v1',
      originalTitle: { value, language }, aliases: [], romanizations: [], creators: [], dates: [], identifiers: [] });
    const search = async (value: string, language = 'en') => json<Candidates>(await send('POST', '/v1/catalogue/candidates', candidateBody(value, language)));
    const creation = (title: string, candidateReceipt: string, language = 'en') => ({ profile: 'metadata-only-v1',
      title, language, actingSubject: editor.actor, grain: 'new-creative-scope', candidateReceipt });

    const title = `ソードアート・オンライン ${randomUUID()}`;
    const before = await json<Candidates>(await send('POST', '/v1/catalogue/candidates', {
      ...candidateBody(title, 'ja'), aliases: [{ value: 'Sword Art Online', language: 'en' }],
      romanizations: [{ value: 'Sōdo Āto Onrain', language: 'ja-Latn' }] }));
    const key = randomUUID();
    const body = { ...creation(title, before.candidateReceipt, 'ja'),
      aliases: [{ value: 'Sword Art Online', language: 'en' }],
      romanizations: [{ value: 'Sōdo Āto Onrain', language: 'ja-Latn' }] };
    const created = await json<Created>(await send('POST', '/v1/works', body, key), 201);
    expect(await json<Created>(await send('POST', '/v1/works', body, key))).toMatchObject({ work: created.work, replayed: true });
    for (const term of ['Sword Art Online', 'Sōdo Āto Onrain']) {
      const found = await search(term);
      expect(found.candidates.map(candidate => candidate.work)).toContain(created.work);
      expect(found.candidates.find(candidate => candidate.work === created.work)!.attributes)
        .toContainEqual({ field: 'alias', value: term, language: term === 'Sword Art Online' ? 'en' : 'ja-Latn' });
    }
    const header = await json<{ verification: string; fieldProvenance: { contributor: string; candidateReceipt: string; fields: string[] } }>(
      await send('GET', `/v1/works/${created.work.slice(-36)}`, undefined, randomUUID(), ''));
    expect(header.verification).toBe('unverified');
    expect(header.fieldProvenance).toMatchObject({ contributor: editor.actor, candidateReceipt: before.candidateReceipt });
    expect(header.fieldProvenance.fields).toContain('romanizations');
    expect(await unverifiedWorks(stack.env, [created.work])).toEqual(new Set([created.work]));
    await editor.grant(`work:read:${created.work}`, 'work.read');
    rankingCandidates = [created.work];
    const basis = { profile: RANKING_PROFILE, population: { kind: 'public' as const }, candidateGrain: 'work' as const, semantic: null };
    const build = await json<{ generation: string }>(await send('POST', '/v1/recommendations/generation-builds', {
      profile: 'ranking-generation-build-v1', actingSubject: reviewer.actor, basis, partitionCount: 4 }, randomUUID(), reviewer.token));
    const lease = await recommendations.claim(build.generation);
    await recommendations.runBatch(build.generation, lease);
    await recommendations.finish(build.generation, lease);
    await json(await send('POST', '/v1/recommendations/generation-activations', {
      profile: 'ranking-generation-activation-v1', actingSubject: reviewer.actor,
      generation: build.generation, expectedHeadRevision: null }, randomUUID(), reviewer.token));
    const rankingPage = () => send('POST', '/v1/recommendations/queries', {
      profile: 'ranking-page-v1', actingSubject: editor.actor, basis, pageSize: 20 });
    expect((await json<{ items: unknown[] }>(await rankingPage())).items).toEqual([]);

    const translation = await json(await send('POST', '/v1/works', { ...body, grain: 'translation' }));
    expect(translation).toMatchObject({ outcome: 'use-owner-api', ownerApi: { path: '/v1/works/{work}/realizations/{realization}' } });
    const count = async () => (await stack.accessPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM quota.catalogue_creation WHERE principal_id = $1', [editor.principalId])).rows[0]!.count;
    expect(await count()).toBe('1');
    const foreign = await send('POST', '/v1/works', { ...body, actingSubject: reviewer.actor }, randomUUID(), reviewer.token);
    expect(foreign.status).toBe(403);
    expect((await send('POST', '/v1/works', { ...body, title: 'Unsearched title' })).status).toBe(400);

    const inputs = await Promise.all([1, 2, 3].map(async value => {
      const title = `Pending book ${value} ${randomUUID()}`;
      return creation(title, (await search(title)).candidateReceipt);
    }));
    const results = await Promise.all(inputs.map(input => send('POST', '/v1/works', input)));
    expect(results.map(result => result.status).sort()).toEqual([201, 201, 429]);
    expect(results.find(result => result.status === 429)!.headers.get('retry-after')).toBe('60');
    expect(await count()).toBe('3');
    expect((await stack.accessPool.query('SELECT slot FROM quota.catalogue_pending WHERE principal_id = $1', [editor.principalId])).rows).toHaveLength(3);

    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    const metadataAlias = `Metadata title ${randomUUID()}`;
    const description = `Description only ${randomUUID()}`;
    await json(await send('PUT', `/v1/works/${created.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: editor.actor,
      state: { kind: 'header', originalTitle: { value: title, language: 'ja' }, localized: [
        { language: 'en', title: metadataAlias, description, mainVersionLabel: null } ] } }));
    expect((await search(metadataAlias)).candidates.map(candidate => candidate.work)).toContain(created.work);
    expect((await search(description)).candidates).toEqual([]);
    const successfulInput = inputs[results.findIndex(result => result.status === 201)]!;
    const unrelated = (await search(successfulInput.title)).candidates[0]!;
    expect(unrelated.work).not.toBe(created.work);
    expect(unrelated.attributes.some(attribute => attribute.value === metadataAlias || attribute.value === title)).toBe(false);

    // Release evidence is returned as compared attributes of the covered Work,
    // never interpreted as a new Work identity.
    const realization = `https://rezics.com/id/${randomUUID()}`;
    const textRevision = await json<{ revision: string }>(await send('PUT',
      `/v1/works/${created.work.slice(-36)}/realizations/${realization.slice(-36)}`, {
        profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor, id: realization,
        language: 'ja', kind: 'original', translators: [], publishers: [editor.actor],
        source: { kind: 'unresolved', work: created.work }, status: 'official', verification: 'verified',
        evidence: `https://rezics.com/id/${randomUUID()}` }));
    const publication = `https://rezics.com/id/${randomUUID()}`;
    await json(await send('PUT', `/v1/works/${created.work.slice(-36)}/releases/${publication.slice(-36)}`, {
      profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: publication,
      kind: 'formal', status: 'official', title: { value: title, language: 'ja' }, titleLanguage: 'ja', tracklistLanguage: null,
      editionStatement: null, publisher: 'Example publisher', publicationYear: 2014, isbn13: '9780316371247',
      originalUrl: null, fixedRelease: null, evidence: null, platform: 'paperback', territory: 'JP',
      identifiers: [{ provider: 'https://publisher.example', value: 'g842-original' }],
      coverage: [{ realization, revision: textRevision.revision, completeness: 'complete' }] }));
    for (const criterion of [{ dates: [2014] }, { identifiers: [{ isbn13: '9780316371247' }] },
      { identifiers: [{ provider: 'https://publisher.example', identifier: 'g842-original' }] }]) {
      const found = await json<Candidates>(await send('POST', '/v1/catalogue/candidates', {
        ...candidateBody('Unrelated catalogue title'), ...criterion }));
      expect(found.candidates.map(candidate => candidate.work)).toContain(created.work);
      expect(found.candidates.find(candidate => candidate.work === created.work)!.attributes)
        .toContainEqual({ field: 'release', value: publication, language: null });
    }

    const contribution = await stack.contribution(created.work, editor.actor, 'ja', 'G842 exact native text for export qualification');
    const select = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(select)), select);
    expect(selected.outcome).toBe('succeeded');
    await editor.grant(`release:seal:${created.mainVersion}`, 'release.seal');
    const release = await json<{ release: string; sourcePosition: { dataEpoch: string; sequence: string } }>(
      await send('POST', '/v1/fixed-releases', { profile: 'fixed-native-text-release-v1', work: created.work,
        mainVersion: created.mainVersion, expectedMainRevision: selected.mainRevision,
        expectedSelection: selected.selection, actingSubject: editor.actor }), 201);
    const exportPlan = () => readExportPlan({ env: stack.env, canReadWork: (principal, actor, work) =>
      stack.access.canReadWork(principal, actor, work) }, editor.principal, editor.actor,
      { kind: 'fixed-release', reference: release.release, expectedPosition: release.sourcePosition }, 'full');
    await expect(exportPlan()).rejects.toBeInstanceOf(ExportSourceNotFound);

    const verifyPath = `/v1/works/${created.work.slice(-36)}/catalogue-verifications`;
    const verification = { expectedHead: created.workRevision, evidence: 'Compared the published original and bibliographic evidence', actingSubject: reviewer.actor };
    expect((await send('POST', verifyPath, { ...verification, actingSubject: editor.actor })).status).toBe(403);
    expect((await send('POST', verifyPath, { ...verification, expectedHead: `https://rezics.com/id/${randomUUID()}` }, randomUUID(), reviewer.token)).status).toBe(409);
    const verifyKey = randomUUID();
    const originalCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    let lostResponse = false;
    stack.fuseki.commandWithReceipt = async envelope => {
      const result = await originalCommand(envelope);
      if (!lostResponse && envelope.update.includes('rv:provisional false') && result.status === 'committed') {
        lostResponse = true;
        throw new Error('G842 simulated lost verification response after commit');
      }
      return result;
    };
    const verified = await json<{ receipt: string; replayed: boolean }>(await send('POST', verifyPath, verification, verifyKey, reviewer.token));
    stack.fuseki.commandWithReceipt = originalCommand;
    expect(lostResponse).toBe(true);
    expect((await json<{ replayed: boolean }>(await send('POST', verifyPath, verification, verifyKey, reviewer.token))).replayed).toBe(true);
    expect(await unverifiedWorks(stack.env, [created.work])).toEqual(new Set());
    expect((await exportPlan()).members.some(member => member.exactRef === selected.mainRevision)).toBe(true);
    expect((await json<{ items: { candidate: string }[] }>(await rankingPage())).items).toEqual([{ candidate: created.work }]);
    expect(await json(await send('GET', `/v1/works/${created.work.slice(-36)}`, undefined, randomUUID(), ''))).toMatchObject({ verification: 'verified' });
    const admissionId = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { <${verified.receipt}> rv:admissionId ?admission } }`)).results!.bindings[0]!.admission!.value;
    const terminal = (await readCatalogueVerification(stack.env, admissionId))!;
    const values: Record<string, string> = { admissionId, receipt: terminal.receipt, digest: terminal.requestDigest,
      scope: terminal.scope, authorityEpoch: terminal.authorityEpoch };
    const handler = ownerOutboxEventHandler(`${RV}CatalogueVerifiedEvent`)!;
    const event = await handler.read({ fuseki: stack.fuseki, eventId: 'urn:rezics:event:g842-test', ordinal: 0,
      batch: { batchId: 'urn:rezics:outbox:g842-test', dataEpoch: terminal.dataEpoch,
        routingEpoch: stack.env.lineage.routingEpoch, sequence: terminal.sequence } as Parameters<typeof handler.read>[0]['batch'],
      value: name => values[name] });
    expect(event.data.receipt.work).toBe(created.work);
    const fourth = creation(`After review ${randomUUID()}`, (await search('After review')).candidateReceipt);
    fourth.title = 'After review';
    expect((await send('POST', '/v1/works', fourth)).status).toBe(201);

    // The semantic export path cannot turn a provisional Work into a trusted
    // member even when ordinary disclosure is allowed.
    const pending = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?work rv:provisional true } } LIMIT 1`)).results!.bindings[0]!.work!.value;
    await expect(readExportPlan({ env: stack.env, canReadWork: async () => true, canReadSemantic: async () => true },
      editor.principal, editor.actor, { kind: 'semantic-revision', resource: pending,
        reference: created.workRevision, expectedPosition: { dataEpoch: stack.env.lineage.dataEpoch, sequence: '0' } }, 'full'))
      .rejects.toBeInstanceOf(ExportSourceNotFound);
  } finally {
    await relay?.end();
    await relayOwner?.close();
    await stack.stop();
  }
}, 120_000);
