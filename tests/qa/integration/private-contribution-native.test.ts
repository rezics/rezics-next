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
import { PrivateSearchUnavailable, queryPrivateContributionPhrase }
  from '../../../services/main/src/modules/contribution/search-private.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest, RV,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

test('SEARCH11/SEARCH12 foundation: native private posting follows one current Contribution head', async () => {
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
  const privatePosting = async (unit: string, term: string) => {
    const response = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?literal ?graph ?predicate WHERE { GRAPH <${PRIVATE_SEARCH_GRAPH}> {
        (<${unit}> ?score ?literal ?graph ?predicate)
          text:query (rv:privateSearchBody ${JSON.stringify(term)} 2) .
      } }`);
    return response.results?.bindings ?? [];
  };

  try {
    const health = await env.fuseki.commandHealth();
    expect(health.moduleVersion).toBe('0.5.20');
    expect(health.privateSearchWriteActive).toBe(false);
    // The shared QA assembler exposes raw update for fault fixtures. The
    // adapter must reject that writer topology even though native postings
    // can be inspected here; its command-only path needs separate evidence.
    expect(health.publicSearchDeltaAvailable).toBe(false);
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
    const firstUnit = privateDraftUnit(first.draftRevision);
    const initial = await privatePosting(firstUnit, firstTerm);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      literal: { value: firstInput.body, 'xml:lang': 'en' },
      graph: { value: PRIVATE_SEARCH_GRAPH },
      predicate: { value: `${RV}privateSearchBody` },
    });
    expect(await privatePosting(firstUnit, 'privateBody:*')).toHaveLength(1);
    await expect(queryPrivateContributionPhrase(env,
      { contribution: first.contribution, phrase: firstTerm }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
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
    expect(await privatePosting(firstUnit, firstTerm)).toEqual([]);
    const current = await privatePosting(privateDraftUnit(edited.draftRevision), secondTerm);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      literal: { value: editInput.body, 'xml:lang': 'en' },
      graph: { value: PRIVATE_SEARCH_GRAPH },
      predicate: { value: `${RV}privateSearchBody` },
    });
    expect(await publicHits(firstTerm)).toEqual([]);
    expect(await publicHits(secondTerm)).toEqual([]);

    const replay = await activateTextContribution(env, createAdmission, firstInput);
    expect(replay).toEqual(first);
    expect(await privatePosting(privateDraftUnit(edited.draftRevision), secondTerm)).toEqual(current);
    expect(await privatePosting(firstUnit, firstTerm)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
