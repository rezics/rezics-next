import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { saveAdmittedContentDraft } from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { rejectRealmLocal, realmRejectionDigest } from '../../../services/main/src/modules/work/reject-realm.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../../services/main/src/modules/work/select-realm.ts';

export interface LoadCase {
  name: string;
  lane: 'main' | 'realm' | 'content';
  phrase: string;
  language: string | null;
  expectedWork: string | null;
  expectedContribution?: string;
  expectedReason?: string;
}

export interface LoadCorpus {
  realm: string;
  works: string[];
  mainUnits: number;
  contentUnits: number;
  content: ContentSeed;
  cases: LoadCase[];
}

export interface ContentSeed {
  variantId: string;
  revisionId: string;
  publicationDecision: string;
  eligibilityDecision: string;
  actingSubject: string;
  principal: { issuer: string; subject: string };
}

const actor = ID + randomUUID();
const texts = [
  { phrase: 'cedar atlas', language: 'en' },
  { phrase: 'harbor lantern', language: 'en' },
  { phrase: 'marble circuit', language: 'en' },
  { phrase: 'amber grove', language: 'en' },
  { phrase: 'silver meadow', language: 'en' },
  { phrase: 'quiet compass', language: 'en' },
  { phrase: 'copper orchard', language: 'en' },
  { phrase: '中文检索验证', language: 'zh' },
  { phrase: '海岸星图', language: 'zh' },
  { phrase: '東京図書館', language: 'ja' },
] as const;

function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
  const id = randomUUID();
  return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
    idempotencyKey: `load-${id}`, requestDigest, authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false };
}

async function publishedContribution(env: WorkActivationEnvironment, work: string,
  phrase: string, language: string) {
  const draftInput = { work, language, body: `${phrase} public load corpus`, actingSubject: actor };
  const draft = await activateTextContribution(env,
    admission(`contribution:create:${work}`, 'contribution.create', textContributionDigest(draftInput)), draftInput);
  if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
    throw new Error('load Contribution draft failed');
  }
  const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
    disclosure: 'public' as const, actingSubject: actor };
  const published = await publishTextContribution(env,
    admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
      textPublicationDigest(publishInput)), publishInput);
  if (published.outcome !== 'succeeded' || !published.publicationDecision) {
    throw new Error('load Contribution publication failed');
  }
  return { contribution: draft.contribution, publicationDecision: published.publicationDecision };
}

export async function seedContent(env: WorkActivationEnvironment, pool: Pool, accessPool: Pool, work: string) {
  const content = new ContentCore(pool);
  const access = new AccessAdmissionRegistry(accessPool);
  const principal = { issuer: 'https://qa-load-local.test', subject: randomUUID() };
  const principalId = randomUUID();
  await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
    [principalId, principal.issuer, principal.subject]);
  await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
  const grant = async (scope: string, action: string) => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), principalId, actor, action]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), actor, scope, action]);
  };
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  await grant(`content:draft:${work}`, 'content.draft');
  await grant(`content:publish:${variantId}`, 'content.publish');
  const saved = await saveAdmittedContentDraft(env, content,
    { verify: async () => principal }, access,
    new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa' } }),
    { resourceId: work,
      variant: { id: variantId, resourceId: work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, body: 'exact content beacon', actingSubject: actor,
      idempotencyKey: `load-save-${randomUUID()}` });
  if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('load Content save failed');
  const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new Error('load Content reference unavailable');
  const publishInput = { preparationId: `load-publish-${randomUUID()}`,
    revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
    expectedContentEpoch: saved.position.dataEpoch, resourceId: work, variantId,
    expectedPublicationHead: null };
  const published = await publishPinnedContent(env, content,
    admission(`content:publish:${variantId}`, 'content.publish', contentPublicationDigest(publishInput)),
    publishInput);
  if (published.status !== 'active' || !published.decision) throw new Error('load Content publication failed');
  const eligibilityInput = { resourceId: work, variantId, publicationDecision: published.decision,
    expectedEligibilityHead: null, actingSubject: actor,
    rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
  const eligibilityScope = `content:search-eligibility:${variantId}`;
  await grant(eligibilityScope, 'content.search-eligibility');
  const eligibilityDigest = contentSearchEligibilityDigest(eligibilityInput);
  const registered = await access.register({ principal, actingSubject: actor,
    scope: eligibilityScope, action: 'content.search-eligibility',
    idempotencyKey: `load-eligibility-${randomUUID()}`, requestDigest: eligibilityDigest });
  const claimed = await access.claim(registered.id, eligibilityDigest);
  const eligibility = await selectPublicContentSearch(env, content, access, claimed, eligibilityInput);
  if (eligibility.outcome !== 'succeeded' || !eligibility.decision) {
    throw new Error('load Content eligibility failed');
  }
  return { variantId, revisionId: saved.revisionId, publicationDecision: published.decision,
    eligibilityDecision: eligibility.decision, actingSubject: actor, principal } satisfies ContentSeed;
}

/** Fixed corpus structure; all graph and Content writes use product commands. */
export async function seedLoadCorpus(env: WorkActivationEnvironment, pool: Pool,
  accessPool: Pool): Promise<LoadCorpus> {
  const spaceInput = { name: 'Load Realm', actingSubject: actor };
  const space = await createRealmSpace(env,
    admission('space:create:root', 'space.create', spaceCreationDigest(spaceInput)), spaceInput);
  if (space.outcome !== 'succeeded' || !space.realm) throw new Error('load Realm creation failed');
  const works: string[] = [];
  const mains: string[] = [];
  const publications: { contribution: string; publicationDecision: string }[] = [];
  for (const [index, text] of texts.entries()) {
    const title = `Load Work ${String(index).padStart(2, '0')}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const published = await publishedContribution(env, created.work, text.phrase, text.language);
    const selectionInput = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: published.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selection = await selectMainDefault(env,
      admission(`publication:select:${created.mainVersion}`, 'publication.select',
        mainSelectionDigest(selectionInput)), selectionInput);
    if (selection.outcome !== 'succeeded') throw new Error('load Main selection failed');
    works.push(created.work);
    mains.push(created.mainVersion);
    publications.push(published);
  }
  const alternate = await publishedContribution(env, works[1]!, 'realm violet harbor', 'en');
  const adoptionInput = { context: { kind: 'realm-local' as const, id: space.realm },
    work: works[1]!, mainVersion: mains[1]!, contribution: alternate.contribution,
    publicationDecision: alternate.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'realm-manager-review' as const, actingSubject: actor };
  const adoption = await selectRealmLocal(env,
    admission(`publication:adopt:${space.realm}`, 'publication.adopt', realmSelectionDigest(adoptionInput)),
    adoptionInput);
  if (adoption.outcome !== 'succeeded') throw new Error('load Realm adoption failed');
  const rejected = await publishedContribution(env, works[2]!, 'rejected sapphire harbor', 'en');
  const rejectionInput = { context: { kind: 'realm-local' as const, id: space.realm },
    work: works[2]!, mainVersion: mains[2]!, expectedSelectionHead: null,
    decisionBasis: 'realm-manager-review' as const, reasonCode: 'not-approved' as const,
    actingSubject: actor };
  const rejection = await rejectRealmLocal(env,
    admission(`publication:reject:${space.realm}`, 'publication.reject',
      realmRejectionDigest(rejectionInput)), rejectionInput);
  if (rejection.outcome !== 'succeeded') throw new Error('load Realm rejection failed');
  const content = await seedContent(env, pool, accessPool, works[0]!);
  return { realm: space.realm, works, mainUnits: texts.length + 1, contentUnits: 1, content,
    cases: [
      { name: 'hot-main', lane: 'main', phrase: texts[0].phrase, language: 'en',
        expectedWork: works[0]! },
      { name: 'other-main', lane: 'main', phrase: texts[3].phrase, language: 'en',
        expectedWork: works[3]! },
      { name: 'chinese-main', lane: 'main', phrase: texts[7].phrase, language: 'zh',
        expectedWork: works[7]! },
      { name: 'realm-adoption', lane: 'realm', phrase: 'realm violet harbor', language: 'en',
        expectedWork: works[1]!, expectedContribution: alternate.contribution,
        expectedReason: 'realm-adoption' },
      { name: 'realm-fallback', lane: 'realm', phrase: texts[3].phrase, language: 'en',
        expectedWork: works[3]!, expectedContribution: publications[3]!.contribution,
        expectedReason: 'main-fallback' },
      { name: 'rejected-candidate', lane: 'realm', phrase: 'rejected sapphire harbor',
        language: 'en', expectedWork: null },
      { name: 'content', lane: 'content', phrase: 'exact content beacon', language: 'en',
        expectedWork: works[0]! },
    ] };
}
