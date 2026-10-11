import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { json, png, safetyFixture, sha, type Receipt } from './g-744-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import {
  RightsCounterNotices,
  type CounterNoticeDelivery,
} from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import { safetyCorrespondenceApi } from '../../../services/account/src/email-safety.ts';
import { accountEmailQueue } from '../../../services/account/src/email.ts';
import type { DecisionInput, DecisionResult } from '../../../services/main/src/modules/governance/store.ts';
import { addBusinessDays } from '../../../services/main/src/modules/public-report/contract.ts';
import type { ModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';

type Fixture = Awaited<ReturnType<typeof safetyFixture>>;
type Member = Awaited<ReturnType<Fixture['stack']['member']>>;
type ContentHead = { revision: string; publication: string; eligibility: string; variant: string };
type CoverUse = { use: string; revision: string; asset: string };
type PublicReceipt = Receipt & { profile: string; replayed: boolean };

const revisionIri = (revision: string) => `urn:rezics:content:revision:${revision}`;
const shortId = (resource: string) => resource.slice(-36);
const counterDeclaration = {
  signature: 'Subscriber signature',
  materialLocation: 'https://rezics.com/media/removed',
  goodFaithMistakeUnderPerjury: true,
  name: 'Subscriber private name',
  address: 'Subscriber private address',
  phone: '+1 555 987 1234',
  courtJurisdiction: 'Federal District Court',
  consentToJurisdiction: true,
  acceptService: true,
} as const;

async function body<T>(response: Response, statuses: number | readonly number[] = 200): Promise<T> {
  const text = await response.text();
  const accepted = typeof statuses === 'number' ? [statuses] : statuses;
  expect(accepted, text).toContain(response.status);
  return JSON.parse(text) as T;
}

async function observed(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) as unknown }; }
  catch { return { status: response.status, body: text }; }
}

async function affectedCredential(f: Fixture, member: Member, caseId: string,
  decisionId: string): Promise<string> {
  let cursor: string | null = null;
  do {
    const page = await json<{ items: { caseId: string; decisionId: string; credential: string }[];
      nextCursor: string | null }>(await f.call('GET',
      `/v1/safety-notices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined, member.token));
    const notice = page.items.find(item => item.caseId === caseId && item.decisionId === decisionId);
    if (notice) {
      expect(notice.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return notice.credential;
    }
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error('Affected party did not receive a decision credential through the safety-notices API');
}

async function selectCover(f: Fixture, owner: Member, work: string, asset: string,
  expectedSelection: string | null): Promise<CoverUse & { selection: string }> {
  await owner.grant(`media:avatar:${work}`, 'media.avatar');
  const response = await owner.send('PUT', `/v1/resources/${shortId(work)}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection, asset, crop: null, actingSubject: owner.actor,
  });
  const selected = await body<{ selection: string }>(response, 201);
  const use = (await f.stack.contentPool.query<CoverUse>(`SELECT u.id::text AS use,
      u.asset_revision_id::text AS revision, u.asset_id::text AS asset
    FROM media.selection_revision s JOIN media.use u ON u.id = s.use_id WHERE s.id = $1`,
  [selected.selection])).rows[0];
  if (!use) throw new Error('Selected Work cover did not retain its exact Media Use');
  return { selection: selected.selection, ...use };
}

async function publishBody(f: Fixture, author: Member, resource: string, text: string,
  existing?: ContentHead): Promise<ContentHead> {
  const variant = existing?.variant ?? `urn:rezics:variant:${randomUUID()}`;
  await author.grant(`content:draft:${resource}`, 'content.draft');
  await author.grant(`content:publish:${resource}`, 'content.publish');
  await author.grant(`content:search-eligibility:${resource}`, 'content.search-eligibility');
  const draftResponse = await author.send('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: resource, variantId: variant,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    expectedHead: existing?.revision ?? null, body: text, actingSubject: author.actor,
  });
  const draft = await body<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    draftResponse, 201);
  const exact = (await f.stack.content.readExactBatch([draft.revisionId], async ids => new Set(ids)))[0];
  expect(exact?.status).toBe('available');
  const publicationResponse = await author.send('POST', '/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: `rights-${randomUUID()}`,
    revisionId: draft.revisionId, expectedDigest: draft.byteDigest,
    expectedContentEpoch: draft.sourcePosition.dataEpoch, resourceId: resource, variantId: variant,
    expectedPublicationHead: existing?.publication ?? null, actingSubject: author.actor,
  });
  const publication = await body<{ decision: string }>(publicationResponse, 201);
  const eligibilityResponse = await author.send('POST', '/v1/content-search-eligibility', {
    profile: 'content-search-eligibility-v1', resourceId: resource, variantId: variant,
    publicationDecision: publication.decision, expectedEligibilityHead: existing?.eligibility ?? null,
    actingSubject: author.actor, rightsBasis: 'original-contribution', disclosure: 'public',
  });
  const eligibility = await body<{ decision: string }>(eligibilityResponse, 201);
  return { revision: draft.revisionId, publication: publication.decision,
    eligibility: eligibility.decision, variant };
}

function copyrightNotice(target: string, statement: string, contactEmail: string,
  materialLocation: string, selection?: { component: 'body' | 'media_use'; revision: string; locator: string | null }) {
  return {
    profile: 'public-report-v1', target, ...(selection ? { selection } : {}),
    category: 'copyright', statement, contentLanguage: 'en-US', contactEmail,
    copyright: {
      signature: `Signed by ${contactEmail}`,
      claimantName: `Claimant ${contactEmail}`,
      claimantAddress: 'Claimant private address',
      claimantPhone: '+1 555 111 2222',
      claimedWork: 'The protected original',
      materialLocation,
      goodFaith: true,
      accurateAndAuthorizedUnderPerjury: true,
    },
  };
}

async function submit(f: Fixture, claimant: Member, input: object): Promise<PublicReceipt> {
  return body<PublicReceipt>(await f.call('POST', '/v1/public-reports', input,
    claimant.token, `public-rights-${randomUUID()}`), 201);
}

async function decision(f: Fixture, receipt: Receipt, basisImage: Awaited<ReturnType<Member['upload']>>,
  target: DecisionInput['targets'][number], outcome: DecisionInput['outcome'] = 'interim_restrict',
  answersStepId: string | null = null): Promise<DecisionInput> {
  const input = await f.input(receipt, basisImage, outcome);
  input.targets = [target];
  input.answersStepId = answersStepId;
  return input;
}

async function decideThroughCompletion(f: Fixture, input: DecisionInput, concurrent = false): Promise<DecisionResult> {
  const call = async () => {
    const response = await f.decide(input);
    return { status: response.status, result: await body<DecisionResult>(response, [200, 202]) };
  };
  const first = concurrent ? await Promise.all([call(), call()]) : [await call()];
  const ids = first.map(item => item.result.decisionId);
  expect(new Set(ids).size).toBe(1);
  let completed = first.find(item => item.result.operation.status === 'completed')?.result;
  for (let attempt = 0; !completed && attempt < 5; attempt++) {
    completed = (await call()).result;
    if (completed.operation.status !== 'completed') completed = undefined;
  }
  expect(completed?.operation.status).toBe('completed');
  const replay = await call();
  expect(replay.result).toMatchObject({ decisionId: ids[0], replayed: true,
    operation: { status: 'completed' } });
  return replay.result;
}

async function decideAfterLostEffectAcknowledgement(f: Fixture, input: DecisionInput,
  gaps: string[]): Promise<DecisionResult> {
  const internals = f.governance as unknown as { effects: ModerationEffects };
  const effects = internals.effects;
  const apply = effects.apply.bind(effects);
  let lostAcknowledgement = false;
  let calls = 0;
  effects.apply = async (...args) => {
    calls++;
    const result = await apply(...args);
    if (!lostAcknowledgement) {
      lostAcknowledgement = true;
      throw new Error('Lost committed owner acknowledgement');
    }
    return result;
  };
  try {
    const uncertain = await f.decide(input);
    const pending = await body<DecisionResult>(uncertain, 202);
    expect(pending.operation.status).toBe('partial');
    expect(pending.operation.items[0]?.state).toBe('uncertain');
    const resumed = await f.decide(input);
    const completed = await body<DecisionResult>(resumed, 200);
    expect(completed).toMatchObject({ decisionId: pending.decisionId, replayed: true,
      operation: { status: 'completed' } });
    if (!lostAcknowledgement || calls !== 2)
      gaps.push(`lost effect acknowledgement was not reconciled exactly once (owner apply calls: ${calls})`);
    return completed;
  } finally {
    effects.apply = apply;
  }
}

async function publicStatus(f: Fixture, receipt: Receipt, credential: string, member?: Member) {
  return json<{
    state: string; generation: string; process: string; outcome: string | null; reasons: string | null;
    notice: { statement: string | null; contactEmail: string | null; declarations: Record<string, unknown> | null };
    statementOfReasons: unknown; operation: { status: string } | null;
    items: { id: string; kind: string; dueAt: string | null; statement: string | null;
      contentLanguage: string | null; declarations: Record<string, unknown> | null }[];
  }>(await f.call('GET', `/v1/public-reports/${receipt.caseId}`, undefined,
    member?.token, randomUUID(), credential), 200);
}

test('GOV01/GOV02/GOV03/GOV24/GOV25: public rights restrictions compose across Work, cover Use, Content and party reads',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with the integration tier');
    const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID,
      ['access', 'content', 'relay', 'account'], 'owner');
    const f = await safetyFixture('rights-public-restriction', true, databases.urls);
    const accountPool = new Pool({ connectionString: databases.urls.account });
    let now = new Date('2026-10-02T14:37:12Z');
    f.setClock(now);
    const maintainer = await f.stack.member('rights-affected-maintainer');
    const claimant = await f.stack.member('rights-claimant');
    const outsider = await f.stack.member('rights-unrelated-caller');
    const extraPrincipals = new Map([maintainer, claimant, outsider].map(member => [member.token, member.principal]));
    const verify = f.deps.account!.verify.bind(f.deps.account);
    f.deps.account!.verify = async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      return extraPrincipals.get(token) ?? verify(request);
    };
    f.deps.publicReports = new PublicReports(
      f.stack.accessPool,
      publicReportOwners(f.deps, f.stack.contentPool, f.stack.content),
      () => now,
    );
    const accountSecret = Bun.env.ACCOUNT_SECRET!;
    const mainSecret = 'rights-notice-private-intake';
    const account = safetyCorrespondenceApi(accountPool, accountSecret, mainSecret,
      'https://accounts.example.test');
    const sent: { to: string; text: string }[] = [];
    const notices = new RightsCounterNotices(f.stack.accessPool, f.governance, async mail => {
      const response = await account.handle(new Request('http://account.local/api/internal/safety-correspondence', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mainSecret}` },
        body: JSON.stringify(mail),
      }));
      return (await json<{ state: CounterNoticeDelivery }>(response)).state;
    }, () => now);
    const drainEmail = () => accountEmailQueue(accountPool, accountSecret, async mail => {
      sent.push(mail);
    }, 'https://accounts.example.test').drain();

    try {
      const workTarget = await f.stack.publicWork(maintainer.actor, ['en'], `Rights title ${randomUUID()}`);
      const coverTarget = await f.stack.publicWork(maintainer.actor, ['en'], `Rights cover ${randomUUID()}`);
      const sharedCover = await f.stack.publicWork(maintainer.actor, ['en'], `Shared cover ${randomUUID()}`);
      const contentTarget = await f.stack.publicWork(maintainer.actor, ['en'], `Rights body ${randomUUID()}`);
      for (const work of [workTarget, coverTarget, sharedCover, contentTarget])
        await maintainer.grant(`work:read:${work.work}`, 'work.read');

      const workHeader = await json<{ revision: string; title: { value: string } }>(
        await f.call('GET', `/v1/works/${shortId(workTarget.work)}`));
      const coverBytes = png(256, 256);
      const sharedAsset = await maintainer.upload(coverBytes, 'public');
      const targetUse = await selectCover(f, maintainer, coverTarget.work, sharedAsset.asset, null);
      const sameAssetOtherUse = await selectCover(f, maintainer, sharedCover.work, sharedAsset.asset, null);

      const unrelatedBytes = png(256, 256, 111);
      const unrelatedAsset = await maintainer.upload(unrelatedBytes, 'public');
      await selectCover(f, maintainer, contentTarget.work, unrelatedAsset.asset, null);
      const bodyText = `Rights body original ${randomUUID().replaceAll('-', '')}`;
      const content = await publishBody(f, maintainer, contentTarget.work, bodyText);

      const missingSignature = await f.call('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: workTarget.work, category: 'copyright',
        statement: 'An unsigned copyright notice is not accepted.', contentLanguage: 'en',
      }, claimant.token, `unsigned-${randomUUID()}`);
      expect(missingSignature.status).toBe(400);
      const missingStatement = await f.call('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: workTarget.work, category: 'copyright', contentLanguage: 'en',
        copyright: { signature: 'Signed', claimantName: 'Claimant', claimantAddress: 'Address',
          claimantPhone: 'Phone', claimedWork: 'Work', materialLocation: workTarget.work,
          goodFaith: true, accurateAndAuthorizedUnderPerjury: true },
      }, claimant.token, `missing-statement-${randomUUID()}`);
      expect([400, 422]).toContain(missingStatement.status);
      const missingLanguage = await f.call('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: workTarget.work, category: 'copyright',
        statement: 'A copyright notice needs its original language.',
        copyright: { signature: 'Signed', claimantName: 'Claimant', claimantAddress: 'Address',
          claimantPhone: 'Phone', claimedWork: 'Work', materialLocation: workTarget.work,
          goodFaith: true, accurateAndAuthorizedUnderPerjury: true },
      }, claimant.token, `missing-language-${randomUUID()}`);
      expect([400, 422]).toContain(missingLanguage.status);

      const workNotice = await submit(f, claimant, copyrightNotice(workTarget.work,
        'The reported Work title is the protected expression.', `work-${randomUUID()}@example.test`, workTarget.work));
      const coverNotice = await submit(f, claimant, copyrightNotice(coverTarget.work,
        'The exact selected Work cover is the protected image.', `cover-${randomUUID()}@example.test`, coverTarget.work,
        { component: 'media_use', revision: revisionIri(targetUse.revision), locator: targetUse.use }));
      const contentNotice = await submit(f, claimant, copyrightNotice(contentTarget.work,
        'The exact published Content body is the protected text.', `content-${randomUUID()}@example.test`,
        `https://rezics.com/v1/content-revisions/${content.revision}`,
        { component: 'body', revision: revisionIri(content.revision), locator: null }));
      const cases = [
        { receipt: workNotice, work: workTarget.work, statement: 'The reported Work title is the protected expression.',
          email: 'work', target: { owner: 'graph', resource: workTarget.work, component: 'title', locator: null,
            scopeKind: 'exact_revision', revision: workHeader.revision, expectedHead: workHeader.revision,
            effect: 'disclosure' } satisfies DecisionInput['targets'][number] },
        { receipt: coverNotice, work: coverTarget.work, statement: 'The exact selected Work cover is the protected image.',
          email: 'cover', target: { owner: 'media', resource: coverTarget.work, component: 'media_use', locator: targetUse.use,
            scopeKind: 'exact_revision', revision: targetUse.revision, expectedHead: null,
            effect: 'disclosure' } satisfies DecisionInput['targets'][number] },
        { receipt: contentNotice, work: contentTarget.work, statement: 'The exact published Content body is the protected text.',
          email: 'content', target: { owner: 'content', resource: contentTarget.work, component: 'body', locator: null,
            scopeKind: 'exact_revision', revision: content.revision, expectedHead: content.revision,
            effect: 'disclosure' } satisfies DecisionInput['targets'][number] },
      ];
      const gaps: string[] = [];

      const preRestriction = new Map<string, { header: unknown; summary: unknown; search: string }>();
      for (const item of cases) {
        const id = shortId(item.work);
        const header = await f.call('GET', `/v1/works/${id}`);
        const summary = await f.call('GET', `/v1/resources/${id}`);
        expect(header.status).toBe(200);
        expect(summary.status).toBe(200);
        const search = await f.call('GET', `/v1/search/catalogue?q=${encodeURIComponent(
          item === cases[2] ? bodyText : (await body<{ title: { value: string } }>(header.clone())).title.value)}&limit=20`);
        expect(search.status).toBe(200);
        preRestriction.set(item.receipt.caseId, { header: await header.json(), summary: await summary.json(),
          search: await search.text() });
      }
      const coverSummary = await body<{ avatar: { kind: string; selection?: string; use?: string; url?: string } }>(
        await f.call('GET', `/v1/resources/${shortId(coverTarget.work)}`));
      expect(coverSummary.avatar).toMatchObject({ kind: 'image', selection: targetUse.selection, use: targetUse.use });
      const oldCoverUrl = coverSummary.avatar.url!;
      const oldCoverBytes = await f.call('GET', oldCoverUrl);
      expect(oldCoverBytes.status).toBe(200);
      const oldCoverDigest = sha(new Uint8Array(await oldCoverBytes.arrayBuffer()));
      const sharedCoverBefore = await body<{ avatar: { kind: string; selection?: string; use?: string; url?: string } }>(
        await f.call('GET', `/v1/resources/${shortId(sharedCover.work)}`));
      expect(sharedCoverBefore.avatar).toMatchObject({ kind: 'image', selection: sameAssetOtherUse.selection,
        use: sameAssetOtherUse.use });
      const unrelatedCoverBefore = await body<{ avatar: { kind: string; url?: string } }>(
        await f.call('GET', `/v1/resources/${shortId(contentTarget.work)}`));
      expect(unrelatedCoverBefore.avatar.kind).toBe('image');

      const exactContentBefore = await f.call('GET', `/v1/content-revisions/${content.revision}`);
      expect(exactContentBefore.status).toBe(200);
      expect(await exactContentBefore.text()).toContain(bodyText);
      expect(preRestriction.get(contentNotice.caseId)!.search).toContain(bodyText);

      const receipts = cases.map(item => item.receipt);
      for (const receipt of receipts) {
        const queue = await f.read('/v1/safety-cases');
        const queuePage = await queue.json() as { items: { caseId: string }[] };
        expect(queuePage.items.some(item => item.caseId === receipt.caseId)).toBe(true);
        const staffCase = await f.read(`/v1/safety-cases/${receipt.caseId}`);
        expect(staffCase.status).toBe(200);
        const staffDetail = await body<{ reports: { reportId: string }[] }>(staffCase);
        expect(staffDetail.reports).toContainEqual({ reportId: receipt.reportId });
      }

      const caseResults = new Map<string, { decision: DecisionResult; affected: string; input: DecisionInput }>();
      const basisImage = await f.author.upload(png(24, 24));
      for (const item of cases) {
        const claimantRead = await claimant.read(`/v1/reports/${item.receipt.reportId}`);
        const claimReport = await body<{ evidence: { owner: string; resource: string; component: string;
          locator?: string | null; revision: string | null }[]; staffNotice?: unknown }>(claimantRead, 200);
        expect(claimReport.staffNotice).toBeUndefined();
        expect(claimReport.evidence).toHaveLength(1);
        const staffRead = await f.read(`/v1/reports/${item.receipt.reportId}`);
        const staffReport = await json<{
          evidence: { owner: string; resource: string; component: string; locator: string | null;
            revision: string | null; state: string }[];
          staffNotice: { statement: string | null; contentLanguage: string | null; process: string | null;
            contactEmail: string | null; declarations: Record<string, unknown> | null };
        }>(staffRead);
        expect(staffReport.staffNotice).toMatchObject({ statement: item.statement,
          contentLanguage: 'en-US', process: 'dmca_512', contactEmail: expect.stringContaining(item.email),
          declarations: { claimantAddress: 'Claimant private address' } });
        expect(staffReport.evidence[0]).toMatchObject({ resource: item.work, state: 'available' });

        const input = await decision(f, item.receipt, basisImage, item.target);
        const decided = item === cases[0]
          ? await decideAfterLostEffectAcknowledgement(f, input, gaps)
          : await decideThroughCompletion(f, input, item === cases[1]);
        expect(decided.outcome).toBe('interim_restrict');
        const stale = await f.decide({ ...input, idempotencyKey: `stale-${randomUUID()}` });
        expect(stale.status).toBe(409);
        const affected = await affectedCredential(f, maintainer, item.receipt.caseId, decided.decisionId);
        caseResults.set(item.receipt.caseId, { decision: decided, affected, input });
      }

      for (const item of cases) {
        const result = caseResults.get(item.receipt.caseId)!;
        const claimantBeforeCounter = await publicStatus(f, item.receipt, item.receipt.credential, claimant);
        const affectedBeforeCounter = await publicStatus(f, item.receipt, result.affected, maintainer);
        expect(claimantBeforeCounter).toMatchObject({ process: 'dmca_512', outcome: 'interim_restrict',
          operation: { status: 'completed' }, notice: { statement: item.statement } });
        expect(affectedBeforeCounter).toMatchObject({ process: 'dmca_512', outcome: 'interim_restrict',
          operation: { status: 'completed' }, notice: { statement: item.statement, contactEmail: null } });
        expect(affectedBeforeCounter.notice.declarations).not.toHaveProperty('claimantName');
        expect(affectedBeforeCounter.notice.declarations).not.toHaveProperty('claimantContact');
        expect(affectedBeforeCounter.statementOfReasons).not.toBeNull();
        expect((await maintainer.read(`/v1/reports/${item.receipt.reportId}`)).status).toBe(404);

        const correspondencePath = `/v1/public-reports/${item.receipt.caseId}/correspondence`;
        const missingStatement = await f.call('POST', correspondencePath, { kind: 'counter_notice',
          statement: '   ', contentLanguage: 'en', counterNotice: counterDeclaration }, undefined,
        `blank-counter-${randomUUID()}`, result.affected);
        expect([400, 422]).toContain(missingStatement.status);
        const missingLanguage = await f.call('POST', correspondencePath, { kind: 'counter_notice',
          statement: 'A signed counter-notice with no valid language must be rejected.',
          contentLanguage: 'not_a_language', counterNotice: counterDeclaration }, undefined,
        `language-counter-${randomUUID()}`, result.affected);
        expect([400, 422]).toContain(missingLanguage.status);
        const unsignedCounter = await f.call('POST', correspondencePath, { kind: 'counter_notice',
          statement: 'A counter-notice without signed declarations must be rejected.', contentLanguage: 'en' }, undefined,
        `unsigned-counter-${randomUUID()}`, result.affected);
        expect([400, 422]).toContain(unsignedCounter.status);

        const counterStatement = `Affected party response ${item.email} ${randomUUID()}`;
        const counter = await body<{ stepId: string; replayed: boolean }>(await f.call('POST', correspondencePath, {
          kind: 'counter_notice', statement: counterStatement, contentLanguage: 'en',
          counterNotice: counterDeclaration,
        }, undefined, `counter-${randomUUID()}`, result.affected), 201);
        expect(counter.replayed).toBe(false);
        const delivered = await notices.runPage();
        expect(delivered.processed).toBe(1);
        await drainEmail();
        const claimantAfterCounter = await publicStatus(f, item.receipt, item.receipt.credential, claimant);
        const affectedAfterCounter = await publicStatus(f, item.receipt, result.affected, maintainer);
        expect(affectedAfterCounter.items.find(step => step.id === counter.stepId)).toMatchObject({
          kind: 'counter_notice', statement: counterStatement, contentLanguage: 'en',
        });
        expect(affectedAfterCounter.items.find(step => step.id === counter.stepId)?.declarations)
          .toMatchObject({ address: counterDeclaration.address, phone: counterDeclaration.phone });
        expect(claimantAfterCounter.items.find(step => step.id === counter.stepId)?.declarations)
          .not.toHaveProperty('address');
        if (claimantAfterCounter.items.find(step => step.id === counter.stepId)?.statement === counterStatement)
          gaps.push(`${item.email}: claimant status exposes the affected party's counter-notice statement`);
        expect(affectedAfterCounter.notice).toMatchObject({ statement: item.statement, contactEmail: null });
        expect(affectedAfterCounter.notice.declarations).not.toHaveProperty('claimantAddress');
        const earliest = addBusinessDays(new Date(item.receipt.receivedAt), 10).toISOString();
        const latest = addBusinessDays(new Date(item.receipt.receivedAt), 14).toISOString();
        expect(claimantAfterCounter.items.find(step => step.kind === 'restoration_not_before')?.dueAt).toBe(earliest);
        expect(affectedAfterCounter.items.find(step => step.kind === 'restoration_not_after')?.dueAt).toBe(latest);

        const finalInput = await decision(f, item.receipt, basisImage, item.target,
          'final_restrict', counter.stepId);
        const upheld = await decideThroughCompletion(f, finalInput);
        expect(upheld.outcome).toBe('final_restrict');
        const finalAffected = await affectedCredential(f, maintainer, item.receipt.caseId, upheld.decisionId);
        const finalClaimantStatus = await publicStatus(f, item.receipt, item.receipt.credential, claimant);
        const finalAffectedStatus = await publicStatus(f, item.receipt, finalAffected, maintainer);
        expect(finalClaimantStatus.outcome).toBe('final_restrict');
        expect(finalAffectedStatus.outcome).toBe('final_restrict');
        expect(finalAffectedStatus.items.find(step => step.id === counter.stepId)?.statement).toBe(counterStatement);
        expect((await claimant.read(`/v1/reports/${item.receipt.reportId}`)).status).toBe(200);
      }

      const absentWork = await observed(await f.call('GET', `/v1/works/${randomUUID()}`));
      const restrictedWork = await observed(await f.call('GET', `/v1/works/${shortId(workTarget.work)}`));
      if (JSON.stringify(restrictedWork) !== JSON.stringify(absentWork))
        gaps.push('restricted Work title direct read differs from an absent Work');
      const absentSummary = await observed(await f.call('GET', `/v1/resources/${randomUUID()}`));
      const restrictedSummary = await observed(await f.call('GET', `/v1/resources/${shortId(workTarget.work)}`));
      if (JSON.stringify(restrictedSummary) !== JSON.stringify(absentSummary))
        gaps.push('restricted Work title summary differs from an absent Work');
      const restrictedTitleSearch = await f.call('GET', `/v1/search/catalogue?q=${encodeURIComponent(
        (preRestriction.get(workNotice.caseId)!.header as { title: { value: string } }).title.value)}&limit=20`);
      expect(restrictedTitleSearch.status).toBe(200);
      expect(await restrictedTitleSearch.text()).not.toContain(workTarget.title);
      expect(preRestriction.get(workNotice.caseId)!.search).toContain(workTarget.title);

      const targetCoverResult = caseResults.get(coverNotice.caseId)!;
      const coverStatus = await publicStatus(f, coverNotice, coverNotice.credential, claimant);
      const affectedCoverStatus = await publicStatus(f, coverNotice, targetCoverResult.affected, maintainer);
      expect(coverStatus.outcome).toBe('final_restrict');
      expect(affectedCoverStatus.outcome).toBe('final_restrict');
      const restrictedCoverSummary = await f.call('GET', `/v1/resources/${shortId(coverTarget.work)}`);
      expect(restrictedCoverSummary.status).toBe(200);
      const restrictedAvatar = await restrictedCoverSummary.json() as { avatar: { kind: string; url?: string } };
      if (restrictedAvatar.avatar.kind === 'image') gaps.push('restricted cover Use remains in the public summary');
      const restrictedCoverBytes = await observed(await f.call('GET', oldCoverUrl));
      const absentCoverBytes = await observed(await f.call('GET', `/v1/media/avatars/${randomUUID()}`));
      if (JSON.stringify(restrictedCoverBytes) !== JSON.stringify(absentCoverBytes))
        gaps.push('restricted cover image delivery differs from an absent image');
      for (const credential of [coverNotice.credential, targetCoverResult.affected]) {
        const credentialRead = await observed(await f.call('GET', oldCoverUrl, undefined, undefined,
          randomUUID(), credential));
        if (JSON.stringify(credentialRead) !== JSON.stringify(restrictedCoverBytes))
          gaps.push('a case credential changes restricted cover byte delivery');
      }
      const sharedCoverAfter = await body<{ avatar: { kind: string; selection?: string; use?: string; url?: string } }>(
        await f.call('GET', `/v1/resources/${shortId(sharedCover.work)}`));
      if (sharedCoverAfter.avatar.kind !== 'image' || sharedCoverAfter.avatar.selection !== sameAssetOtherUse.selection
        || sharedCoverAfter.avatar.use !== sameAssetOtherUse.use) {
        gaps.push('restricting one Work cover Use changed a different Work Use of the same Asset');
      } else {
        const sharedCoverBytesAfter = await f.call('GET', sharedCoverAfter.avatar.url!);
        if (sharedCoverBytesAfter.status !== 200) {
          gaps.push('the other Work Use of the same Asset stopped delivering bytes');
        } else {
          const sharedDigestAfter = sha(new Uint8Array(await sharedCoverBytesAfter.arrayBuffer()));
          if (sharedDigestAfter !== oldCoverDigest)
            gaps.push('the other Work Use of the same Asset returned different bytes');
        }
      }
      const replacementAsset = await maintainer.upload(png(256, 256, 217), 'public');
      const replacementUse = await selectCover(f, maintainer, coverTarget.work, replacementAsset.asset,
        targetUse.selection);
      const replacementSummary = await body<{ avatar: { kind: string; selection?: string; use?: string; url?: string } }>(
        await f.call('GET', `/v1/resources/${shortId(coverTarget.work)}`));
      expect(replacementSummary.avatar).toMatchObject({ kind: 'image', selection: replacementUse.selection,
        use: replacementUse.use });
      expect((await f.call('GET', replacementSummary.avatar.url!)).status).toBe(200);
      const oldAfterReplacement = await observed(await f.call('GET', oldCoverUrl));
      if (JSON.stringify(oldAfterReplacement) !== JSON.stringify(absentCoverBytes))
        gaps.push('replacing the cover head reopened delivery of the previously restricted cover Use');

      const contentResult = caseResults.get(contentNotice.caseId)!;
      const restrictedContent = await observed(await f.call('GET', `/v1/content-revisions/${content.revision}`));
      const absentContent = await observed(await f.call('GET', `/v1/content-revisions/${randomUUID()}`));
      if (JSON.stringify(restrictedContent) !== JSON.stringify(absentContent))
        gaps.push('restricted Content revision read differs from an absent revision');
      for (const credential of [contentNotice.credential, contentResult.affected]) {
        const credentialRead = await observed(await f.call('GET', `/v1/content-revisions/${content.revision}`,
          undefined, undefined, randomUUID(), credential));
        if (JSON.stringify(credentialRead) !== JSON.stringify(restrictedContent))
          gaps.push('a case credential changes restricted Content revision delivery');
      }
      const absentContentSearch = await f.call('GET', `/v1/search/catalogue?q=${encodeURIComponent(bodyText)}&limit=20`);
      expect(absentContentSearch.status).toBe(200);
      expect(await absentContentSearch.text()).not.toContain(bodyText);

      const updatedText = `Rights body replacement ${randomUUID().replaceAll('-', '')}`;
      const updatedContent = await publishBody(f, maintainer, contentTarget.work, updatedText, content);
      expect((await f.call('GET', `/v1/content-revisions/${content.revision}`)).status).toBe(404);
      const updatedRead = await body<{ body: { body: string } }>(
        await f.call('GET', `/v1/content-revisions/${updatedContent.revision}`));
      expect(updatedRead.body.body).toBe(updatedText);
      const updatedSearch = await f.call('GET', `/v1/search/catalogue?q=${encodeURIComponent(updatedText)}&limit=20`);
      expect(updatedSearch.status).toBe(200);
      expect(await updatedSearch.text()).toContain(updatedText);
      const unrelatedCoverAfter = await body<{ avatar: { kind: string; url?: string } }>(
        await f.call('GET', `/v1/resources/${shortId(contentTarget.work)}`));
      expect(unrelatedCoverAfter.avatar.kind).toBe('image');
      const unrelatedCoverBytes = await f.call('GET', unrelatedCoverAfter.avatar.url!);
      expect(unrelatedCoverBytes.status).toBe(200);

      const unauthorizedCase = await observed(await f.call('GET', `/v1/public-reports/${workNotice.caseId}`,
        undefined, outsider.token));
      const absentCase = await observed(await f.call('GET', `/v1/public-reports/${randomUUID()}`));
      expect(unauthorizedCase).toEqual(absentCase);
      expect((await f.call('GET', `/v1/reports/${workNotice.reportId}`, undefined, outsider.token)).status).toBe(404);
      expect(sent.length).toBeGreaterThanOrEqual(3);
      if (gaps.length) throw new Error(`Public rights adapter gaps:\n- ${gaps.join('\n- ')}`);
    } finally {
      await f.stop();
      await accountPool.end();
      await databases.close();
    }
  }, 300_000);
