import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { Acquisition } from '../../../scripts/datasets/network.ts';
import { freezeSnapshot } from '../../../scripts/datasets/snapshot.ts';
import { importDataset } from '../../../scripts/datasets/import.ts';
import { repository } from '../../../scripts/datasets/store.ts';
import type { DatasetRecord, DatasetSnapshot, DatasetSource } from '../../../scripts/datasets/types.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { requestUseRenditions } from '../../../services/main/src/modules/media-rendition/request.ts';
import type { DiscoveryRow } from '../../../services/main/src/modules/discovery/contract.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import { RightsCounterNotices } from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { requireQa } from './recommendation-support.ts';
import { fixtureReasons } from './g-565-decision-support.ts';
import { safetyFixture, type Receipt } from './g-744-support.ts';
import { sha, type MediaStack } from './media-support.ts';

const revisionIri = (id: string) => `urn:rezics:content:revision:${id}`;

type Member = Awaited<ReturnType<MediaStack['member']>>;
type UseRow = { selection: string; use: string; revision: string; asset: string };
type Avatar = { kind: string; selection?: string; use?: string; representation?: string; url?: string;
  coverCredit?: unknown };
type WorkPage = { id: string; revision: string; mainVersion: string; title: { value: string };
  cover: Avatar };
type ImportedMapping = { id: string; kind: string; receipt: { mainVersion: string; workRevision: string } };
type ImportJournal = { native: Record<string, ImportedMapping> };
type NoticeReceipt = Receipt & { replayed?: boolean };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

async function image(color: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 320, height: 180, channels: 3, background: color } })
    .png().toBuffer();
}

async function catchUpContentProjection(stack: MediaStack) {
  const command = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
    Bun.env.FUSEKI_COMMAND_TOKEN!);
  const relayEnv = { ...stack.env, fuseki: command };
  const cut = await stack.content.ownerPosition();
  for (let step = 0; step < 64; step++) {
    const checkpoint = await stack.contentCursor.read(stack.contentConsumer);
    if (checkpoint.dataEpoch !== cut.dataEpoch)
      throw new Error('Content owner epoch changed before cover search preparation');
    if (checkpoint.sequence === cut.sequence) return;
    if (BigInt(checkpoint.sequence) > BigInt(cut.sequence))
      throw new Error('Content projection passed the cover search source cut');
    if (!await relayContentProjectionOnce(relayEnv, stack.content, stack.contentCursor, stack.contentConsumer))
      throw new Error('Content projection stopped before the cover search source cut');
  }
  throw new Error('Content projection exceeded its cover search preparation budget');
}

async function frozenCover(root: string, bytes: Buffer, title: string): Promise<DatasetSnapshot> {
  const externalId = `subject-${randomUUID()}`;
  const sourceUrl = `https://bgm.tv/subject/${externalId}`;
  const imageUrl = `https://lain.bgm.tv/pic/cover/${externalId}.png`;
  const sourceData = { id: externalId, title, images: { common: imageUrl }, rightsHolder: 'Evidence Holder' };
  const sourceBytes = Buffer.from(JSON.stringify(sourceData));
  const sourceDigest = sha(sourceBytes);
  const record: DatasetRecord = {
    key: `bangumi:subject:${externalId}`, provider: 'bangumi', kind: 'subject', externalId,
    title, language: 'en', sourceUrl, data: sourceData, native: 'work',
  };
  const source: DatasetSource = {
    provider: 'bangumi', roots: [record.key], records: [record], edges: [],
    images: [{ record: record.key, role: 'cover', url: imageUrl, sourceEvidence: {
      provider: 'bangumi', namespace: record.kind, externalId, revision: `snapshot-${randomUUID()}`,
      captureUrl: sourceUrl, recordDigest: sourceDigest, field: '/images/common',
      sourceName: 'Bangumi', sourceUrl, holder: { name: 'Evidence Holder', field: '/rightsHolder' },
    } }],
    scope: { fixture: 'frozen-provider-record-and-cover', provider: 'bangumi' },
  };
  const fakeFetch: typeof fetch = async input => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === sourceUrl) return new Response(sourceBytes, { status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(sourceBytes.length) } });
    if (url === imageUrl) return new Response(bytes, { status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } });
    return new Response(null, { status: 404 });
  };
  const acquisition = new Acquisition(root, true, fakeFetch, async () => {}, () => 0);
  await acquisition.capture(sourceUrl);
  return freezeSnapshot(acquisition, [source], 'covers');
}

async function selectAvatar(stack: MediaStack, owner: Member, work: string, asset: string,
  expectedSelection: string | null) {
  await owner.grant(`media:avatar:${work}`, 'media.avatar');
  const response = await owner.send('PUT', `/v1/resources/${work.slice(-36)}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection, asset, actingSubject: owner.actor,
  });
  const selected = await json<{ selection: string }>(response, 201);
  const row = (await stack.contentPool.query<UseRow>(`SELECT s.id::text AS selection,u.id::text AS use,
      u.asset_revision_id::text AS revision,u.asset_id::text AS asset
    FROM media.selection_revision s JOIN media.use u ON u.id=s.use_id WHERE s.id=$1`,
  [selected.selection])).rows[0];
  if (!row) throw new Error('avatar selection has no retained Media Use');
  return row;
}

function copyrightNotice(target: string, use: string, revision: string, statement: string) {
  return { profile: 'public-report-v1', target,
    selection: { component: 'media_use', revision: revisionIri(revision), locator: use },
    category: 'copyright', statement, contentLanguage: 'en', contactEmail: 'claimant@example.test',
    copyright: { signature: 'Claimant signature', claimantName: 'Claimant', claimantAddress: '1 Main Street',
      claimantPhone: '+1 555 555 0100', claimedWork: 'The original artwork', materialLocation: target,
      goodFaith: true, accurateAndAuthorizedUnderPerjury: true },
  };
}

test('GOV24/GOV25: frozen imported covers keep exact credit and lifecycle fences through notice, re-import, restore and erasure',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with the integration tier');
    const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'owner');
    const root = mkdtempSync(join(repository, '.temp/imported-cover-lifecycle-'));
    let fixture: Awaited<ReturnType<typeof safetyFixture>> | undefined;
    let restoreDiscovery: (() => void) | undefined;
    try {
      fixture = await safetyFixture('imported-cover-lifecycle', true, owners.urls, { contentProjection: true });
      const stack = fixture.stack;
      await stack.contentCursor.initialize(stack.contentConsumer);
      let rightsClock = new Date();
      fixture.setClock(rightsClock);
      fixture.deps.publicReports = new PublicReports(stack.accessPool,
        publicReportOwners(fixture.deps, stack.contentPool, stack.content), () => rightsClock);
      // This journey needs the delivered receipt gate; outbound account mail is covered separately.
      const counterNotices = new RightsCounterNotices(stack.accessPool, fixture.governance,
        async () => 'sent', () => rightsClock);
      const owner = fixture.author;
      const moderator = fixture.staff;
      await owner.grant('work:create:root', 'work.create');
      await owner.grant('work:create:catalogue-import', 'work.create');
      await grantRecordedPlatformUse(stack.accessPool, owner.principalId, ['catalogue-import']);

      const call = (method: string, path: string, body?: unknown, token?: string, key?: string) =>
        stack.call(method, path, { token, body, key });
      const govern = (method: string, path: string, body?: unknown, token?: string,
        key: string = randomUUID(), credential?: string) => fixture!.call(method, path, body, token, key, credential);
      const affectedCredential = async (caseId: string, decisionId: string) => {
        let cursor: string | null = null;
        do {
          const page = await json<{ items: Array<{ caseId: string; decisionId: string; credential: string }>;
            nextCursor: string | null }>(await call('GET',
            `/v1/safety-notices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
            undefined, owner.token));
          const notice = page.items.find(item => item.caseId === caseId && item.decisionId === decisionId);
          if (notice) return notice.credential;
          cursor = page.nextCursor;
        } while (cursor);
        throw new Error('The affected uploader did not receive the decision notice through the API');
      };
      const avatarGrantTargets = new Set<string>();
      const importerApi = {
        request: async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, key?: string) => {
          // Work IDs are allocated by Main; grant the exact avatar target before its selection call.
          if (path === '/v1/media/uploads' && body && typeof body === 'object'
            && 'importedCover' in body) {
            const targetWork = ((body as { importedCover?: { targetWork?: unknown } }).importedCover)?.targetWork;
            if (typeof targetWork === 'string' && !avatarGrantTargets.has(targetWork)) {
              await owner.grant(`media:avatar:${targetWork}`, 'media.avatar');
              avatarGrantTargets.add(targetWork);
            }
          }
          const response = await call(method, path, body, owner.token, key);
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
        },
        transfer: async (path: string, bytes: Uint8Array) => {
          const response = await stack.call('PUT', path, { token: owner.token, raw: bytes });
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
        },
      };
      const importOptions = { api: importerApi, mainOrigin: 'http://main.local', webOrigin: 'http://web.local',
        actingSubject: owner.actor, nativeBatchItems: 16 };
      const bytes = await image({ r: 18, g: 112, b: 201 });
      const snapshot = await frozenCover(root, bytes, `Imported cover ${randomUUID().replaceAll('-', '')}`);
      const record = snapshot.sources[0]!.records[0]!;
      const initial = await importDataset(root, snapshot, importOptions);
      expect(initial.completed).toBe(true);
      expect(initial.coverResults.map(result => result.status)).toEqual(['imported']);
      expect(initial.limitations.some(item => /^cover pending [a-f0-9]{16} \(/.test(item))).toBe(false);
      const initialJournal = JSON.parse(readFileSync(initial.receiptFile, 'utf8')) as ImportJournal;
      const imported = initialJournal.native[record.key]!;
      const work = imported.id;
      const searchPhrase = `coverlifecycle${randomUUID().replaceAll('-', '')}`;
      const contribution = await stack.contribution(work, owner.actor, 'en', `Imported cover search ${searchPhrase}`);
      const publishInput = { context: { kind: 'main-version-default' as const, id: imported.receipt.mainVersion },
        work, contribution: contribution.contribution, publicationDecision: contribution.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: owner.actor };
      const publication = await selectMainDefault(stack.env, stack.admission(owner.actor,
        `publication:select:${imported.receipt.mainVersion}`, 'publication.select', mainSelectionDigest(publishInput)),
      publishInput);
      expect(publication.outcome).toBe('succeeded');
      await catchUpContentProjection(stack);

      const expectedCredit = { kind: 'copyright', text: 'Evidence Holder', holder: 'Evidence Holder',
        source: { name: 'Bangumi', href: record.sourceUrl }, permittedRole: 'cover' };
      const workPath = `/v1/works/${work.slice(-36)}`;
      const before = await json<WorkPage>(await call('GET', workPath));
      expect(before.cover).toMatchObject({ kind: 'image', coverCredit: expectedCredit });
      expect(before.title.value).toBe(record.title);
      const importedUse: UseRow = { selection: before.cover.selection!, use: before.cover.use!,
        revision: '', asset: '' };
      const importedRow = (await stack.contentPool.query<{ revision: string; asset: string }>(
        `SELECT u.asset_revision_id::text AS revision,u.asset_id::text AS asset FROM media.use u WHERE u.id=$1`,
      [importedUse.use])).rows[0]!;
      importedUse.revision = importedRow.revision;
      importedUse.asset = importedRow.asset;
      const coverMetadata = await json<{ items: Array<{ status: string; url: string; coverCredit: unknown }> }>(
        await call('POST', '/v1/media/metadata', { items: [{ representation: before.cover.representation,
          use: importedUse.use }] }));
      expect(coverMetadata.items[0]).toMatchObject({ status: 'available', coverCredit: expectedCredit });
      const coverDescriptor = await json<{ coverCredit: unknown; url: string }>(await call('GET',
        `/v1/media/representations/${before.cover.representation}?use=${importedUse.use}`));
      expect(coverDescriptor.coverCredit).toEqual(expectedCredit);
      const originalBytes = await call('GET', coverDescriptor.url);
      expect(originalBytes.status).toBe(200);
      const oldEtag = originalBytes.headers.get('etag');
      expect(oldEtag).toBeTruthy();

      await requestUseRenditions(stack.store.renditions, stack.objects, importedUse.use);
      const renditionWorker = new MediaRenditionWorker(stack.store.renditions,
        new LocalImageTransformer(), stack.objects);
      for (let step = 0; step < 12; step++) {
        if ((await stack.store.renditions.candidatesBatch([importedUse.use])).get(importedUse.use)?.length) break;
        await renditionWorker.tick();
      }
      const thumbnail = (await stack.store.renditions.candidatesBatch([importedUse.use])).get(importedUse.use)?.[0];
      expect(thumbnail).toBeDefined();
      const thumbnailUrl = new URL(thumbnail!.url, 'http://main.local');
      const thumbnailPath = thumbnailUrl.pathname + thumbnailUrl.search;
      const thumbnailId = thumbnailUrl.pathname.match(/\/representations\/([0-9a-f-]+)/)?.[1];
      expect(thumbnailId).toBeDefined();
      const thumbnailDescriptor = await json<{ coverCredit: unknown }>(await call('GET',
        `/v1/media/representations/${thumbnailId}?use=${importedUse.use}`));
      expect(thumbnailDescriptor.coverCredit).toEqual(expectedCredit);

      const content = await json<{ results: Array<{ work: string; cover: Avatar }> }>(
        await call('POST', '/v1/queries/page', { profile: 'public-main-phrase-page-v1',
          phrase: searchPhrase, language: 'en', pageSize: 20 }));
      expect(content.results).toContainEqual(expect.objectContaining({ work,
        cover: expect.objectContaining({ kind: 'image', coverCredit: expectedCredit }) }));
      const originalDiscovery = stack.composition.dependencies.discovery!;
      const active = originalDiscovery.active;
      const page = originalDiscovery.page;
      const generation = randomUUID();
      const row: DiscoveryRow = { work, order_key: '1', payload: { revision: before.revision,
        mainVersion: imported.receipt.mainVersion, types: [], primaryCredits: [], classifications: [],
        rating: null, classification: null } };
      originalDiscovery.active = async (_basis, position) => ({ generation_id: generation, stale: false,
        source_epoch: position.dataEpoch, source_sequence: position.sequence }) as unknown as Awaited<ReturnType<typeof active>>;
      originalDiscovery.page = async () => [row];
      restoreDiscovery = () => { originalDiscovery.active = active; originalDiscovery.page = page; };
      const readSurfaces = async (visible: boolean) => {
        const pageRead = await json<WorkPage>(await call('GET', workPath));
        const summary = await json<{ summaries: Array<{ avatar: Avatar }> }>(await call('POST',
          '/v1/resources/summaries', { profile: 'resource-summary-batch-v1', resources: [work] }));
        const search = await json<{ results: Array<{ work: string; cover: Avatar }> }>(await call('POST',
          '/v1/queries/page', { profile: 'public-main-phrase-page-v1', phrase: searchPhrase,
            language: 'en', pageSize: 20 }));
        const discovery = await json<{ items: Array<{ id: string; cover: Avatar }> }>(
          await call('GET', '/v1/works?limit=20'));
        expect(pageRead).toMatchObject({ title: before.title, revision: before.revision,
          mainVersion: imported.receipt.mainVersion });
        const card = search.results.find(item => item.work === work);
        expect(card).toBeDefined();
        const found = discovery.items.find(item => item.id === work);
        expect(found).toBeDefined();
        for (const descriptor of [pageRead.cover, summary.summaries[0]!.avatar, card!.cover, found!.cover]) {
          if (visible) expect(descriptor).toMatchObject({ kind: 'image', coverCredit: expectedCredit });
          else {
            expect(descriptor.kind).toBe('fallback');
            expect(descriptor).not.toHaveProperty('coverCredit');
          }
        }
        expect(summary.summaries).toHaveLength(1);
        expect(search.results).toContainEqual(expect.objectContaining({ work }));
        expect(discovery.items).toContainEqual(expect.objectContaining({ id: work }));
        return pageRead;
      };
      await readSurfaces(true);

      const unrelated = await stack.publicWork(owner.actor, ['en'], `Unrelated cover ${randomUUID()}`);
      const unrelatedBytes = await image({ r: 211, g: 38, b: 97 });
      const unrelatedUpload = await owner.upload(unrelatedBytes, 'public');
      const unrelatedUse = await selectAvatar(stack, owner, unrelated.work, unrelatedUpload.asset, null);
      const unrelatedUrl = `/v1/media/representations/${unrelatedUpload.representation}/bytes?use=${unrelatedUse.use}`;

      const foreign = await stack.publicWork(owner.actor, ['en'], `Foreign cover ${randomUUID()}`);
      const foreignUpload = await owner.upload(await image({ r: 93, g: 29, b: 161 }), 'public');
      const foreignUse = await selectAvatar(stack, owner, foreign.work, foreignUpload.asset, null);
      const reportInput = copyrightNotice(work, importedUse.use, importedUse.revision,
        'The imported cover displays artwork I own.');
      const wrongUse = await govern('POST', '/v1/public-reports', copyrightNotice(work,
        foreignUse.use, importedUse.revision, 'A foreign Work Use is not selectable.'), undefined,
        `foreign-use-${randomUUID()}`);
      const absentUse = await govern('POST', '/v1/public-reports', copyrightNotice(work,
        randomUUID(), importedUse.revision, 'An absent Work Use is not selectable.'), undefined,
        `absent-use-${randomUUID()}`);
      expect(wrongUse.status).toBe(404);
      const wrongUseBody = await wrongUse.json();
      const absentUseBody = await absentUse.json();
      expect(wrongUseBody).toEqual({ type: 'https://rezics.com/problems/case_unavailable',
        title: 'Case is unavailable', status: 404, code: 'case_unavailable' });
      expect({ status: wrongUse.status, body: wrongUseBody }).toEqual(
        { status: absentUse.status, body: absentUseBody });

      const privateUseWork = await stack.publicWork(owner.actor, ['en'], `Private cover use ${randomUUID()}`);
      const privateUseUpload = await owner.upload(await image({ r: 62, g: 180, b: 34 }), 'private');
      const privateUse = await selectAvatar(stack, owner, privateUseWork.work, privateUseUpload.asset, null);
      const hiddenUse = await govern('POST', '/v1/public-reports', copyrightNotice(privateUseWork.work,
        privateUse.use, privateUse.revision, 'A private cover use is concealed.'), undefined,
        `private-use-${randomUUID()}`);
      const absentPrivateUse = await govern('POST', '/v1/public-reports', copyrightNotice(privateUseWork.work,
        randomUUID(), privateUse.revision, 'An absent cover use is concealed.'), undefined,
        `absent-private-use-${randomUUID()}`);
      expect(hiddenUse.status).toBe(404);
      expect({ status: hiddenUse.status, body: await hiddenUse.clone().json() }).toEqual(
        { status: absentPrivateUse.status, body: await absentPrivateUse.clone().json() });

      const privateWork = await stack.privateWork(owner.actor, `Private Work cover ${randomUUID()}`);
      const privateWorkUpload = await owner.upload(await image({ r: 8, g: 160, b: 141 }), 'public');
      await owner.grant(`work:read:${privateWork.work}`, 'work.read');
      const privateWorkUse = await selectAvatar(stack, owner, privateWork.work, privateWorkUpload.asset, null);
      const hiddenWork = await govern('POST', '/v1/public-reports', copyrightNotice(privateWork.work,
        privateWorkUse.use, privateWorkUse.revision, 'A private Work cover is concealed.'), undefined,
        `private-work-${randomUUID()}`);
      const absentPrivateWork = await govern('POST', '/v1/public-reports', copyrightNotice(privateWork.work,
        randomUUID(), privateWorkUse.revision, 'An absent private Work use is concealed.'), undefined,
        `absent-private-work-${randomUUID()}`);
      expect(hiddenWork.status).toBe(404);
      expect({ status: hiddenWork.status, body: await hiddenWork.clone().json() }).toEqual(
        { status: absentPrivateWork.status, body: await absentPrivateWork.clone().json() });

      const missingDeclaration = await govern('POST', '/v1/public-reports', { profile: 'public-report-v1',
        target: work, category: 'copyright', statement: 'A signed declaration is required.',
        contentLanguage: 'en' }, undefined, `missing-declaration-${randomUUID()}`);
      expect(missingDeclaration.status).toBe(400);

      await moderator.grant('governance:platform', 'governance.rights.decide');
      const ruleKey = randomUUID();
      const ruleReceipt = await json<{ ref: string; revision: string; digest: string }>(await govern('POST',
        '/v1/governance/rules', { profile: 'governance-rule-v1', ref: `urn:cover-lifecycle:${randomUUID()}`,
          scopeId: 'governance:platform', actingSubject: moderator.actor, expectedRevision: null,
          document: { rule: 'Restrict an exact reported imported cover Use.' }, idempotencyKey: ruleKey },
      moderator.token, ruleKey), 201);
      const rule = { ref: ruleReceipt.ref, revision: ruleReceipt.revision, digest: ruleReceipt.digest };
      const reportKey = `imported-cover-notice-${randomUUID()}`;
      const publicReceipt = await json<NoticeReceipt>(await govern('POST', '/v1/public-reports', reportInput,
        undefined, reportKey), 201);
      expect(publicReceipt.replayed).toBe(false);
      const anonymousRead = await govern('GET', `/v1/public-reports/${publicReceipt.caseId}`,
        undefined, undefined, randomUUID(), publicReceipt.credential);
      const anonymousReport = await anonymousRead.json() as { category: string };
      expect(anonymousRead.status).toBe(200);
      expect(anonymousReport.category).toBe('copyright');
      expect(JSON.stringify(anonymousReport)).not.toContain(importedUse.use);
      const staffRead = await govern('GET', `/v1/reports/${publicReceipt.reportId}?actingSubject=${encodeURIComponent(moderator.actor)}`,
        undefined, moderator.token);
      const staffReport = await staffRead.json() as { evidence: Array<Record<string, unknown>> };
      expect(staffRead.status).toBe(200);
      expect(staffReport.evidence).toEqual([expect.objectContaining({ owner: 'media', resource: work,
        component: 'media_use', locator: importedUse.use, revision: importedUse.revision, state: 'available' })]);

      const decide = async (receipt: NoticeReceipt, target: Record<string, unknown>, outcome: string,
        reversesDecisionId: string | null = null, expectedGeneration?: string,
        answersStepId: string | null = null) => {
        const claimKey = randomUUID();
        const claimed = await govern('POST', `/v1/safety-cases/${receipt.caseId}/claim`, {
          actingSubject: moderator.actor, idempotencyKey: claimKey,
        }, moderator.token, claimKey);
        expect(claimed.status).toBe(200);
        const viewResponse = await govern('GET',
          `/v1/safety-cases/${receipt.caseId}?actingSubject=${encodeURIComponent(moderator.actor)}`,
          undefined, moderator.token);
        const view = await viewResponse.json() as { generation: string; reports: Array<{ evidenceDigest: string }> };
        expect(viewResponse.status).toBe(200);
        const idempotencyKey = randomUUID();
        const input = { caseId: receipt.caseId, expectedGeneration: expectedGeneration ?? view.generation,
          actingSubject: moderator.actor, outcome, targets: [target], rule,
          evidenceDigest: view.reports[0]!.evidenceDigest, reversesDecisionId, answersStepId,
          rationale: 'The exact retained notice evidence supports this restriction.', disclosure: 'parties',
          reasons: fixtureReasons, idempotencyKey };
        const accepted = await govern('POST', `/v1/safety-cases/${receipt.caseId}/decisions`, input,
          moderator.token, idempotencyKey);
        return { input, view, accepted };
      };
      const target = { owner: 'media', resource: work, component: 'media_use', locator: importedUse.use,
        scopeKind: 'exact_revision', revision: importedUse.revision, expectedHead: null,
        effect: 'media_delivery' };
      const firstDecision = await decide(publicReceipt, target, 'interim_restrict');
      expect(firstDecision.accepted.status, await firstDecision.accepted.clone().text()).toBe(202);
      const completed = await govern('POST', `/v1/safety-cases/${publicReceipt.caseId}/decisions`,
        firstDecision.input, moderator.token, firstDecision.input.idempotencyKey);
      const decisionReceipt = await completed.json() as { decisionId: string; operation: { status: string } };
      expect(completed.status).toBe(200);
      expect(decisionReceipt.operation.status).toBe('completed');
      await catchUpContentProjection(stack);

      const replayNotice = await govern('POST', '/v1/public-reports', reportInput, undefined, reportKey);
      expect(replayNotice.status).toBe(200);
      expect(await replayNotice.json()).toMatchObject({ caseId: publicReceipt.caseId,
        reportId: publicReceipt.reportId, replayed: true });
      const restrictionRead = await govern('GET', `/v1/reports/${publicReceipt.reportId}?actingSubject=${encodeURIComponent(moderator.actor)}`,
        undefined, moderator.token);
      expect(restrictionRead.status).toBe(200);
      expect(await restrictionRead.json()).toMatchObject({ evidence: [expect.objectContaining({
        owner: 'media', resource: work, component: 'media_use', locator: importedUse.use,
        revision: importedUse.revision })] });
      const restrictedPage = await readSurfaces(false);
      expect(restrictedPage.title).toEqual(before.title);
      const unavailableMetadata = await json<{ items: Array<{ status: string }> }>(await call('POST',
        '/v1/media/metadata', { items: [{ representation: before.cover.representation, use: importedUse.use }] }));
      expect(unavailableMetadata.items[0]?.status).not.toBe('available');
      expect(unavailableMetadata.items[0]).not.toHaveProperty('coverCredit');
      expect((await stack.store.readAsset(importedUse.asset))?.moderation).toBe('suppressed');
      const conditional = await stack.main.handle(new Request(`http://main.local${coverDescriptor.url}`,
        { headers: { 'if-none-match': oldEtag! } }));
      expect(conditional.status).toBe(404);
      expect((await call('GET', before.cover.url!)).status).toBe(404);
      expect((await call('GET', coverDescriptor.url)).status).toBe(404);
      expect((await stack.store.renditions.candidatesBatch([importedUse.use])).get(importedUse.use) ?? []).toEqual([]);
      expect((await call('GET', thumbnailPath)).status).toBe(404);
      expect((await call('GET', unrelatedUrl)).status).toBe(200);

      const editorBytes = await image({ r: 236, g: 161, b: 24 });
      const editorAsset = await owner.upload(editorBytes, 'public');
      expect(editorAsset.asset).not.toBe(importedUse.asset);
      const editorUse = await selectAvatar(stack, owner, work, editorAsset.asset, importedUse.selection);
      const editorCover = await json<WorkPage>(await call('GET', workPath));
      expect(editorCover.cover).toMatchObject({ kind: 'image', selection: editorUse.selection, use: editorUse.use });
      expect(editorCover.cover.coverCredit).toBeNull();
      expect((await call('GET', editorCover.cover.url!)).status).toBe(200);
      const staleAvatar = await owner.send('PUT', `/v1/resources/${work.slice(-36)}/avatar`, {
        profile: 'resource-avatar-selection-v1', expectedSelection: importedUse.selection,
        asset: importedUse.asset, actingSubject: owner.actor,
      });
      expect(staleAvatar.status).toBe(409);
      expect(await staleAvatar.json()).toMatchObject({ code: 'stale_head' });
      expect((await json<WorkPage>(await call('GET', workPath))).cover.selection).toBe(editorUse.selection);

      const sameRecord = await importDataset(root, snapshot, importOptions);
      expect(sameRecord.limitations.some(item => item.startsWith('cover pending '))).toBe(true);
      expect((await json<WorkPage>(await call('GET', workPath))).title).toEqual(before.title);

      const sameBytesAnotherRecord = await frozenCover(root, bytes, `Second record ${randomUUID().replaceAll('-', '')}`);
      const otherRecord = sameBytesAnotherRecord.sources[0]!.records[0]!;
      const anotherRecordImport = await importDataset(root, sameBytesAnotherRecord, importOptions);
      expect(anotherRecordImport.coverResults.map(result => result.status)).toEqual(['imported']);

      // The subsequent stages exercise the same owner paths after the digest fence is admitted.
      const affected = await affectedCredential(publicReceipt.caseId, decisionReceipt.decisionId);
      const counterNoticeKey = randomUUID();
      const counterNotice = await json<{ stepId: string }>(await govern('POST',
        `/v1/public-reports/${publicReceipt.caseId}/correspondence`, {
          kind: 'counter_notice', statement: 'The imported artwork was identified by mistake.',
          contentLanguage: 'en', counterNotice: {
            signature: 'Subscriber signature', materialLocation: `https://rezics.com/id/${work}`,
            goodFaithMistakeUnderPerjury: true, name: 'Subscriber', address: '1 Main Street',
            phone: '+1 555 555 0100', courtJurisdiction: 'Federal District Court',
            consentToJurisdiction: true, acceptService: true,
          },
        }, undefined, counterNoticeKey, affected), 200);
      expect(counterNotice.replayed).toBe(false);
      expect(await counterNotices.runPage()).toEqual({ processed: 1, deferred: 0 });
      const receiptWindow = (await stack.accessPool.query<{ delivered_at: Date | null; not_before: Date }>(
        `SELECT delivered_at,not_before FROM access.rights_counter_notice WHERE step_id = $1`,
        [counterNotice.stepId])).rows[0]!;
      expect(receiptWindow.delivered_at).toBeInstanceOf(Date);
      const beforeDue = await decide(publicReceipt, target, 'restore', null, undefined,
        counterNotice.stepId);
      expect(beforeDue.accepted.status, await beforeDue.accepted.clone().text()).toBe(409);
      rightsClock = receiptWindow.not_before;
      fixture.setClock(rightsClock);
      const beforeRestore = await decide(publicReceipt, target, 'restore', null, '0',
        counterNotice.stepId);
      expect(beforeRestore.accepted.status, await beforeRestore.accepted.clone().text()).toBe(409);
      const restoreAttempt = await decide(publicReceipt, target, 'restore', null, undefined,
        counterNotice.stepId);
      expect(restoreAttempt.accepted.status).toBe(202);
      const restored = await govern('POST', `/v1/safety-cases/${publicReceipt.caseId}/decisions`,
        restoreAttempt.input, moderator.token, restoreAttempt.input.idempotencyKey);
      expect(restored.status).toBe(200);
      expect((await json<{ operation: { status: string } }>(restored)).operation.status).toBe('completed');
      expect((await call('GET', coverDescriptor.url)).status).toBe(200);
      expect((await json<{ coverCredit: unknown }>(await call('GET',
        `/v1/media/representations/${before.cover.representation}?use=${importedUse.use}`))).coverCredit)
        .toEqual(expectedCredit);

      const restoredUse = await selectAvatar(stack, owner, work, importedUse.asset, editorUse.selection);
      expect(restoredUse.asset).toBe(importedUse.asset);
      expect(restoredUse.use).not.toBe(importedUse.use);
      const reimported = await importDataset(root, snapshot, importOptions);
      expect(reimported.completed).toBe(true);
      expect(reimported.coverResults.map(result => result.status)).toEqual(['imported']);
      const restoredPage = await json<WorkPage>(await call('GET', workPath));
      expect(restoredPage.cover).toMatchObject({ kind: 'image', coverCredit: expectedCredit });
      const secondRecordResult = await importDataset(root, sameBytesAnotherRecord, importOptions);
      expect(secondRecordResult.completed).toBe(true);
      const secondJournal = JSON.parse(readFileSync(secondRecordResult.receiptFile, 'utf8')) as ImportJournal;
      const secondWork = secondJournal.native[otherRecord.key]!.id;
      const secondCover = await json<WorkPage>(await call('GET', `/v1/works/${secondWork.slice(-36)}`));
      expect(secondCover.cover).toMatchObject({ kind: 'image', coverCredit: {
        ...expectedCredit, source: { ...expectedCredit.source, href: otherRecord.sourceUrl },
      } });

      const finalReportInput = copyrightNotice(work, restoredPage.cover.use!,
        (await stack.contentPool.query<{ revision: string }>(
          `SELECT asset_revision_id::text AS revision FROM media.use WHERE id=$1`, [restoredPage.cover.use])).rows[0]!.revision,
        'The restored source cover remains restricted after its provenance is erased.');
      const finalReportKey = `imported-cover-final-${randomUUID()}`;
      const finalReport = await json<NoticeReceipt>(await govern('POST', '/v1/public-reports', finalReportInput,
        undefined, finalReportKey), 201);
      const finalTarget = { ...target, locator: restoredPage.cover.use,
        revision: (await stack.contentPool.query<{ revision: string }>(
          `SELECT asset_revision_id::text AS revision FROM media.use WHERE id=$1`, [restoredPage.cover.use])).rows[0]!.revision };
      const finalDecision = await decide(finalReport, finalTarget, 'interim_restrict');
      expect(finalDecision.accepted.status).toBe(202);
      const finalCompleted = await govern('POST', `/v1/safety-cases/${finalReport.caseId}/decisions`,
        finalDecision.input, moderator.token, finalDecision.input.idempotencyKey);
      expect(finalCompleted.status).toBe(200);
      const sourceAsset = (await stack.contentPool.query<{ asset: string }>(
        'SELECT asset_id::text AS asset FROM media.use WHERE id=$1', [restoredPage.cover.use])).rows[0]!.asset;
      const sourceState = await stack.store.readAsset(sourceAsset);
      const erased = await owner.send('POST', `/v1/media/assets/${sourceAsset}/state`, {
        profile: 'media-asset-state-v1', expectedState: sourceState!.state, disclosure: 'public',
        lifecycle: 'erased', actingSubject: owner.actor,
      });
      expect(erased.status).toBe(201);
      expect((await stack.contentPool.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM media.imported_cover_revision WHERE asset_id=$1`, [sourceAsset])).rows[0]!.count).toBe(0);
      const duplicateUse = secondCover.cover.use!;
      const duplicateRevision = secondCover.cover.representation!;
      const suppression = (await stack.contentPool.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM media.suppressed_digest WHERE digest=$1`, [sha(bytes)])).rows[0]!.count;
      const duplicateBytes = await call('GET',
        `/v1/media/representations/${duplicateRevision}/bytes?use=${duplicateUse}`);
      expect(duplicateBytes.status,
        `identical bytes remained available after source cover erasure; digest suppression markers=${suppression}`)
        .toBe(404);
      expect(suppression).toBeGreaterThan(0);
      expect((await call('GET', unrelatedUrl)).status).toBe(200);
    } finally {
      restoreDiscovery?.();
      if (fixture) await fixture.stop();
      await owners.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 360_000);
