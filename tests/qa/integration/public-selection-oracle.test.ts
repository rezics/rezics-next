import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { createClassificationContext, classificationContextDigest }
  from '../../../services/main/src/modules/classification/context.ts';
import { setClassificationDecision, classificationDecisionDigest, classificationDecisionScope,
  type ClassificationDecisionContext } from '../../../services/main/src/modules/classification/decision.ts';
import { createClassificationProposition, classificationPropositionDigest }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, GRAPHS, ID, metadataWorkRequestDigest, RV,
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

test('WORK03/SEARCH07/SEARCH19: joined decisions and Realm selection refresh only affected roots', async () => {
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
    const rows = actual.results.map(({ score, ...row }) => row)
      .sort((a, b) => a.work.localeCompare(b.work));
    expect(rows).toEqual(expected);
    return rows;
  }

  async function contributorState(contribution: string) {
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?author ?draft ?publication WHERE {
      GRAPH <${GRAPHS.current}> { <${contribution}> a rv:TextContribution ;
        rv:author ?author ; rv:draftHead ?draft ; rv:publicationHead ?publication . }
    }`);
    expect(result.results?.bindings).toHaveLength(1);
    return result.results!.bindings[0];
  }

  async function searchTriples(work: string) {
    const result = await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?unit ?predicate ?object WHERE {
        GRAPH <urn:rezics:search:public> {
          ?unit a rv:MatchUnit ; rv:work <${work}> ; ?predicate ?object .
        }
      }`);
    return (result.results?.bindings ?? []).map(row => [row.unit?.value,
      row.predicate?.value, row.object?.type, row.object?.value,
      row.object?.['xml:lang'], row.object?.datatype].join('|')).sort();
  }

  async function classified(context: 'main' | 'realm', sense: string, realmId?: string) {
    const body = context === 'main'
      ? { profile: 'public-main-classified-phrase-v1', phrase: marker,
        language: 'en', sense }
      : { profile: 'public-realm-classified-phrase-v1',
        context: { kind: 'realm-local', id: realmId }, phrase: marker,
        language: 'en', sense };
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    const actual = await response.json() as { complete: boolean; total: number;
      results: Array<{ work: string; matchUnit: string;
        classification: { decision: string; source: string } }> };
    expect(actual.complete).toBe(true);
    return actual.results;
  }

  async function decision(work: WorkPublication, sense: string,
    context: ClassificationDecisionContext, outcome: 'accepted' | 'rejected',
    expectedDecisionHead: string | null = null) {
    const input = { context, work: work.work, mainVersion: work.mainVersion,
      sense, expectedDecisionHead, outcome, actingSubject: actor };
    const result = await setClassificationDecision(env,
      admission(classificationDecisionScope(context), 'classification.decision.set',
        classificationDecisionDigest(input)), input);
    if (result.outcome !== 'succeeded' || !result.decision) {
      throw new Error('Classification decision failed');
    }
    return result.decision;
  }

  try {
    const [realmA, realmB] = [await realm(`Oracle A ${randomUUID()}`),
      await realm(`Oracle B ${randomUUID()}`)];
    const workA = await mainWork('A', `${marker} original amber`);
    const workB = await mainWork('B', `${marker} original blue`);
    const works = [workA, workB];
    const originalMain = await compare(works, 'main');
    await compare(works, 'realm', realmA);
    const originalRealmB = await compare(works, 'realm', realmB);
    const originalUnitsA = await searchTriples(workA.work);
    const originalUnitsB = await searchTriples(workB.work);
    expect(originalUnitsA.length).toBeGreaterThan(0);
    expect(originalUnitsB.length).toBeGreaterThan(0);

    const contextInput = { realm: realmA, actingSubject: actor };
    const context = await createClassificationContext(env,
      admission(`classification:context:${realmA}`, 'classification.context.configure',
        classificationContextDigest(contextInput)), contextInput);
    if (context.outcome !== 'succeeded' || !context.context) {
      throw new Error('Realm classification context failed');
    }
    const propositionInput = { label: `Selection oracle ${randomUUID()}`, actingSubject: actor };
    const proposition = await createClassificationProposition(env,
      admission('classification:define:global', 'classification.proposition.define',
        classificationPropositionDigest(propositionInput)), propositionInput);
    if (proposition.outcome !== 'succeeded' || !proposition.definitions?.sense) {
      throw new Error('Classification proposition failed');
    }
    const sense = proposition.definitions.sense;
    expect(await classified('main', sense)).toEqual([]);
    const globalA = await decision(workA, sense, { kind: 'global' }, 'accepted');
    expect(await classified('main', sense)).toMatchObject([{ work: workA.work,
      matchUnit: workA.main!.matchUnit,
      classification: { decision: globalA, source: 'global' } }]);
    expect(await classified('realm', sense, realmA)).toMatchObject([{ work: workA.work,
      matchUnit: workA.main!.matchUnit,
      classification: { decision: globalA, source: 'inherited-global' } }]);
    await decision(workA, sense, { kind: 'realm-classification', id: realmA }, 'rejected');
    expect(await classified('realm', sense, realmA)).toEqual([]);
    const localB = await decision(workB, sense,
      { kind: 'realm-classification', id: realmA }, 'accepted');
    expect(await classified('realm', sense, realmA)).toMatchObject([{ work: workB.work,
      matchUnit: workB.main!.matchUnit,
      classification: { decision: localB, source: 'local' } }]);
    expect(await classified('main', sense)).toMatchObject([{ work: workA.work,
      matchUnit: workA.main!.matchUnit,
      classification: { decision: globalA, source: 'global' } }]);
    await decision(workB, sense, { kind: 'realm-classification', id: realmA },
      'rejected', localB);
    expect(await classified('realm', sense, realmA)).toEqual([]);
    expect(await searchTriples(workA.work)).toEqual(originalUnitsA);
    expect(await searchTriples(workB.work)).toEqual(originalUnitsB);
    expect(await compare(works, 'main')).toEqual(originalMain);
    expect(await compare(works, 'realm', realmB)).toEqual(originalRealmB);

    const alternativeBody = `${marker} reviewed violet`;
    const alternative = await published(workA.work, alternativeBody);
    const alternativeOwner = await contributorState(alternative.contribution);
    expect(alternativeOwner?.author?.value).toBe(actor);
    expect(alternativeOwner?.publication?.value).toBe(alternative.decision);
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
    const adoptedUnitsA = await searchTriples(workA.work);
    expect(adoptedUnitsA.some(triple => triple.startsWith(`${adopted.matchUnit}|`))).toBe(true);
    expect(await searchTriples(workB.work)).toEqual(originalUnitsB);
    expect(await compare(works, 'realm', realmB)).toEqual(originalRealmB);
    expect(await compare(works, 'main')).toEqual(originalMain);
    expect(await contributorState(alternative.contribution)).toEqual(alternativeOwner);

    const replacementBody = `${marker} reviewed copper`;
    const replacement = await published(workA.work, replacementBody);
    const replacementOwner = await contributorState(replacement.contribution);
    expect(replacementOwner?.author?.value).toBe(actor);
    expect(replacementOwner?.publication?.value).toBe(replacement.decision);
    const replacementInput = { ...adoptionInput, contribution: replacement.contribution,
      publicationDecision: replacement.decision, expectedSelectionHead: adopted.selection };
    const switched = await selectRealmLocal(env,
      admission(`publication:adopt:${realmA}`, 'publication.adopt',
        realmSelectionDigest(replacementInput)), replacementInput);
    if (switched.outcome !== 'succeeded' || !switched.selection || !switched.matchUnit
      || !switched.selectedDraft || !switched.contribution || !switched.language) {
      throw new Error('Realm content switch failed');
    }
    workA.local = { [realmA]: { kind: 'adopted', text: {
      selection: switched.selection, matchUnit: switched.matchUnit,
      contribution: switched.contribution, revision: switched.selectedDraft,
      language: switched.language, body: replacementBody } } };
    await compare(works, 'realm', realmA);
    const switchedUnitsA = await searchTriples(workA.work);
    expect(switchedUnitsA.some(triple => triple.startsWith(`${adopted.matchUnit}|`))).toBe(false);
    expect(switchedUnitsA.some(triple => triple.startsWith(`${switched.matchUnit}|`))).toBe(true);
    expect(await searchTriples(workB.work)).toEqual(originalUnitsB);
    expect(await compare(works, 'realm', realmB)).toEqual(originalRealmB);
    expect(await compare(works, 'main')).toEqual(originalMain);
    expect(await contributorState(alternative.contribution)).toEqual(alternativeOwner);
    expect(await contributorState(replacement.contribution)).toEqual(replacementOwner);

    await expect(selectRealmLocal(env,
      admission(`publication:adopt:${realmA}`, 'publication.adopt',
        realmSelectionDigest(adoptionInput)), adoptionInput)).rejects.toBeInstanceOf(StaleRealmSelection);
    await compare(works, 'realm', realmA);

    const rejectInput = { context: { kind: 'realm-local' as const, id: realmA },
      work: workA.work, mainVersion: workA.mainVersion,
      expectedSelectionHead: switched.selection,
      decisionBasis: 'realm-manager-review' as const, reasonCode: 'not-approved' as const,
      actingSubject: actor };
    const rejected = await rejectRealmLocal(env,
      admission(`publication:reject:${realmA}`, 'publication.reject',
        realmRejectionDigest(rejectInput)), rejectInput);
    expect(rejected.outcome).toBe('succeeded');
    workA.local = { [realmA]: { kind: 'rejected' } };
    await compare(works, 'realm', realmA);
    expect(await searchTriples(workA.work)).toEqual(originalUnitsA);
    expect(await searchTriples(workB.work)).toEqual(originalUnitsB);
    expect(await compare(works, 'realm', realmB)).toEqual(originalRealmB);
    expect(await compare(works, 'main')).toEqual(originalMain);
    expect(await contributorState(alternative.contribution)).toEqual(alternativeOwner);
    expect(await contributorState(replacement.contribution)).toEqual(replacementOwner);
  } finally {
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
