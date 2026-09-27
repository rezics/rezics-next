import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { activateMetadataWork, metadataWorkRequestDigest,
  ID, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { seedContent } from '../load/corpus.ts';

/** Keep one independent main text unit beside the Content unit for stale-index proofs. */
export async function seedRecoveryContent(env: WorkActivationEnvironment, contentPool: Pool,
  accessPool: Pool) {
  const actor = ID + randomUUID();
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `recovery-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
      dispatchEligible: true, replayed: false };
  };
  const title = `Recovery Content ${randomUUID()}`;
  const created = await activateMetadataWork(env, { title,
    admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
  const draftInput = { work: created.work, language: 'en', body: 'recovery companion public text',
    actingSubject: actor };
  const draft = await activateTextContribution(env, admission(`contribution:create:${created.work}`,
    'contribution.create', textContributionDigest(draftInput)), draftInput);
  if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
    throw new Error('recovery companion draft failed');
  }
  const publicationInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
    disclosure: 'public' as const, actingSubject: actor };
  const published = await publishTextContribution(env, admission(`contribution:publish:${draft.contribution}`,
    'contribution.publish', textPublicationDigest(publicationInput)), publicationInput);
  if (published.outcome !== 'succeeded' || !published.publicationDecision) {
    throw new Error('recovery companion publication failed');
  }
  const selectionInput = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
    work: created.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: actor };
  const selection = await selectMainDefault(env, admission(`publication:select:${created.mainVersion}`,
    'publication.select', mainSelectionDigest(selectionInput)), selectionInput);
  if (selection.outcome !== 'succeeded') throw new Error('recovery companion selection failed');
  const content = await seedContent(env, contentPool, accessPool, created.work);
  return { works: [created.work], content };
}
