import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { editTextContributionDraft, textContributionEditDigest }
  from '../../../services/main/src/modules/contribution/edit.ts';
import { PRIVATE_SEARCH_GRAPH, privateDraftUnit }
  from '../../../services/main/src/modules/contribution/private-projection.ts';
import { queryPrivateContributionPhrase }
  from '../../../services/main/src/modules/contribution/search-private.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest, RV,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

test('SEARCH11/SEARCH12: native private draft posting follows one current Contribution head', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `private-contribution-native-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = {
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects'),
  };
  const actor = ID + randomUUID();
  const admission = (scope: string, action: string,
    requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor,
      scope, action, idempotencyKey: `private-native-${id}`, requestDigest,
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  const publicHits = async (term: string) => {
    const response = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?unit WHERE { GRAPH <urn:rezics:search:public> {
        (?unit ?score) text:query (rv:searchBody ${JSON.stringify(term)} 2) .
      } }`);
    return response.results?.bindings ?? [];
  };

  try {
    const health = await env.fuseki.commandHealth();
    expect(health.moduleVersion).toBe('0.5.14');
    expect(health.privateSearchWriteActive).toBe(false);
    expect(health.publicSearchDeltaAvailable).toBe(true);
    const title = `Private native projection ${randomUUID()}`;
    const created = await activateMetadataWork(env, {
      title, admission: admission('work:create:root', 'work.create',
        metadataWorkRequestDigest(title)),
    });
    const firstTerm = `hidden${randomUUID().replaceAll('-', '')}`;
    const secondTerm = `revised${randomUUID().replaceAll('-', '')}`;
    const firstInput = { work: created.work, language: 'en',
      body: `Private ${firstTerm} body`, actingSubject: actor };
    const createAdmission = admission(`contribution:create:${created.work}`,
      'contribution.create', textContributionDigest(firstInput));
    const first = await activateTextContribution(env, createAdmission, firstInput);
    expect(first.outcome).toBe('succeeded');
    if (!first.contribution || !first.draftRevision) {
      throw new Error('private Contribution draft receipt is incomplete');
    }
    const initial = await queryPrivateContributionPhrase(env,
      { contribution: first.contribution, phrase: firstTerm });
    expect(initial).toMatchObject({ complete: true, total: 1,
      results: [{ matchUnit: privateDraftUnit(first.draftRevision),
        contribution: first.contribution, revision: first.draftRevision,
        field: 'body', language: 'en' }] });
    expect(JSON.stringify(initial)).not.toContain(firstInput.body);
    expect(JSON.stringify(initial)).not.toContain('score');
    expect(await publicHits(firstTerm)).toEqual([]);

    const editInput = { contribution: first.contribution,
      expectedHead: first.draftRevision,
      body: `Private ${secondTerm} body`, actingSubject: actor };
    const edited = await editTextContributionDraft(env,
      admission(`contribution:edit:${first.contribution}`,
        'contribution.edit', textContributionEditDigest(editInput)), editInput);
    expect(edited.outcome).toBe('succeeded');
    if (!edited.draftRevision) throw new Error('edited private draft has no head');
    expect(edited.draftRevision).not.toBe(first.draftRevision);
    const oldUnit = await env.fuseki.query(`ASK { GRAPH <${PRIVATE_SEARCH_GRAPH}> {
      <${privateDraftUnit(first.draftRevision)}> ?predicate ?object . } }`);
    expect(oldUnit.boolean).toBe(false);
    const oldPhrase = await queryPrivateContributionPhrase(env,
      { contribution: first.contribution, phrase: firstTerm });
    expect(oldPhrase).toMatchObject({ complete: true, total: 0, results: [] });
    const current = await queryPrivateContributionPhrase(env,
      { contribution: first.contribution, phrase: secondTerm });
    expect(current).toMatchObject({ complete: true, total: 1,
      results: [{ matchUnit: privateDraftUnit(edited.draftRevision),
        revision: edited.draftRevision }] });
    expect(await publicHits(firstTerm)).toEqual([]);
    expect(await publicHits(secondTerm)).toEqual([]);

    const replay = await activateTextContribution(env, createAdmission, firstInput);
    expect(replay).toEqual(first);
    const afterReplay = await queryPrivateContributionPhrase(env,
      { contribution: first.contribution, phrase: secondTerm });
    expect(afterReplay.results).toEqual(current.results);
    expect((await queryPrivateContributionPhrase(env,
      { contribution: first.contribution, phrase: firstTerm })).total).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
