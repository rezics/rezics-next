import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { rejectRealmLocal, realmRejectionDigest }
  from '../../../services/main/src/modules/work/reject-realm.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest, StaleRealmSelection }
  from '../../../services/main/src/modules/work/select-realm.ts';
import { expectedPublicPhraseRows, type SelectedText, type WorkPublication }
  from '../oracles/public-selection.ts';

const root = resolve(import.meta.dir, '../../..');

test('WORK03/SEARCH19: partial live Main and Realm phrase results follow independent selection oracle', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `selection-oracle-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const actor = ID + randomUUID();
  const marker = `selectionbeacon${randomUUID().replaceAll('-', '')}`;
  const env: WorkActivationEnvironment = {
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects'),
  };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const app = createMainApp(env.fuseki, { environment: env,
    account: { verify: async () => { throw new Error('no authority request in this query test'); } },
    access: new AccessAdmissionRegistry(accessPool) });

  function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `selection-oracle-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }

  async function realm(name: string) {
    const input = { name, actingSubject: actor };
    const result = await createRealmSpace(env,
      admission('space:create:root', 'space.create', spaceCreationDigest(input)), input);
    if (result.outcome !== 'succeeded' || !result.realm) throw new Error('Realm creation failed');
    return result.realm;
  }

  async function published(work: string, body: string) {
    const draftInput = { work, language: 'en', body, actingSubject: actor };
    const draft = await activateTextContribution(env,
      admission(`contribution:create:${work}`, 'contribution.create', textContributionDigest(draftInput)),
      draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const result = await publishTextContribution(env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publishInput)), publishInput);
    if (result.outcome !== 'succeeded' || !result.publicationDecision) {
      throw new Error('Contribution publication failed');
    }
    return { contribution: draft.contribution, decision: result.publicationDecision };
  }

  async function mainWork(name: string, body: string): Promise<WorkPublication> {
    const title = `Selection oracle ${name} ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const publication = await published(created.work, body);
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: publication.contribution,
      publicationDecision: publication.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const result = await selectMainDefault(env,
      admission(`publication:select:${created.mainVersion}`, 'publication.select',
        mainSelectionDigest(input)), input);
    if (result.outcome !== 'succeeded' || !result.selection || !result.matchUnit
      || !result.selectedDraft || !result.contribution || !result.language) {
      throw new Error('Main selection failed');
    }
    return { work: created.work, mainVersion: created.mainVersion,
      main: { selection: result.selection, matchUnit: result.matchUnit,
        contribution: result.contribution, revision: result.selectedDraft,
      language: result.language, body }, local: {} };
  }

  async function compare(works: readonly WorkPublication[], context: 'main' | 'realm',
    realmId?: string) {
    const expected = expectedPublicPhraseRows(works, context === 'main'
      ? { kind: 'main' } : { kind: 'realm', id: realmId! }, marker, 'en');
    const requestBody = context === 'main'
      ? { profile: 'public-main-phrase-v1', phrase: marker, language: 'en' }
      : { profile: 'public-realm-phrase-v1', context: { kind: 'realm-local', id: realmId },
        phrase: marker, language: 'en' };
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }));
    expect(response.status).toBe(200);
    const actual = await response.json() as { complete: boolean; total: number;
      sourcePosition: { dataEpoch: string; sequence: string };
      results: Array<{ score: number; work: string; mainVersion: string;
        matchUnit: string; contribution: string; revision: string;
        selection: string; language: string; reason?: string }> };
    expect(actual.complete).toBe(true);
    expect(actual.total).toBe(expected.length);
    expect(actual.sourcePosition.dataEpoch).toBe(env.lineage.dataEpoch);
    expect(actual.sourcePosition.sequence).toMatch(/^[0-9]+$/);
    expect(actual.results.map(({ score, ...row }) => row)
      .sort((a, b) => a.work.localeCompare(b.work))).toEqual(expected);
  }

  try {
    const [realmA, realmB] = [await realm(`Oracle A ${randomUUID()}`),
      await realm(`Oracle B ${randomUUID()}`)];
    const workA = await mainWork('A', `${marker} original amber`);
    const workB = await mainWork('B', `${marker} original blue`);
    const works = [workA, workB];
    await compare(works, 'main');
    await compare(works, 'realm', realmA);

    const alternativeBody = `${marker} reviewed violet`;
    const alternative = await published(workA.work, alternativeBody);
    const adoptionInput = { context: { kind: 'realm-local' as const, id: realmA },
      work: workA.work, mainVersion: workA.mainVersion,
      contribution: alternative.contribution, publicationDecision: alternative.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const,
      actingSubject: actor };
    const adopted = await selectRealmLocal(env,
      admission(`publication:adopt:${realmA}`, 'publication.adopt',
        realmSelectionDigest(adoptionInput)), adoptionInput);
    if (adopted.outcome !== 'succeeded' || !adopted.selection || !adopted.matchUnit
      || !adopted.selectedDraft || !adopted.contribution || !adopted.language) {
      throw new Error('Realm adoption failed');
    }
    const adoptedText: SelectedText = { selection: adopted.selection,
      matchUnit: adopted.matchUnit, contribution: adopted.contribution,
      revision: adopted.selectedDraft, language: adopted.language, body: alternativeBody };
    workA.local = { [realmA]: { kind: 'adopted', text: adoptedText } };
    await compare(works, 'realm', realmA);
    await compare(works, 'realm', realmB);
    await compare(works, 'main');

    await expect(selectRealmLocal(env,
      admission(`publication:adopt:${realmA}`, 'publication.adopt',
        realmSelectionDigest(adoptionInput)), adoptionInput)).rejects.toBeInstanceOf(StaleRealmSelection);
    await compare(works, 'realm', realmA);

    const rejectInput = { context: { kind: 'realm-local' as const, id: realmA },
      work: workA.work, mainVersion: workA.mainVersion,
      expectedSelectionHead: adopted.selection,
      decisionBasis: 'realm-manager-review' as const, reasonCode: 'not-approved' as const,
      actingSubject: actor };
    const rejected = await rejectRealmLocal(env,
      admission(`publication:reject:${realmA}`, 'publication.reject',
        realmRejectionDigest(rejectInput)), rejectInput);
    expect(rejected.outcome).toBe('succeeded');
    workA.local = { [realmA]: { kind: 'rejected' } };
    await compare(works, 'realm', realmA);
    await compare(works, 'realm', realmB);
    await compare(works, 'main');
  } finally {
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
