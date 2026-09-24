import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
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
  cases: LoadCase[];
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

async function seedContent(env: WorkActivationEnvironment, pool: Pool, work: string) {
  const content = new ContentCore(pool);
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const saved = await content.saveDraft({ operationId: `load-save-${randomUUID()}`,
    variant: { id: variantId, resourceId: work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    sourceRevision: null, provenance: { author: actor }, expectedHead: null,
    model: 'content-shape-v1', serializedJson: '{"body":"exact content beacon"}' });
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
  const eligibility = await selectPublicContentSearch(env,
    admission(`content:search-eligibility:${variantId}`, 'content.search-eligibility',
      contentSearchEligibilityDigest(eligibilityInput)) as Parameters<typeof selectPublicContentSearch>[1],
    eligibilityInput);
  if (eligibility.outcome !== 'succeeded') throw new Error('load Content eligibility failed');
}

/** Fixed corpus structure; all graph and Content writes use product commands. */
export async function seedLoadCorpus(env: WorkActivationEnvironment, pool: Pool): Promise<LoadCorpus> {
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
  await seedContent(env, pool, works[0]!);
  return { realm: space.realm, works, mainUnits: texts.length + 1, contentUnits: 1,
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
