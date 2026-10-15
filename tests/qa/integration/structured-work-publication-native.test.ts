import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { iri } from '../../../services/main/src/modules/work/activate.ts';
import { publicWork } from '../../../services/main/src/modules/work/public-patterns.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';

type PublicationFixture = Awaited<ReturnType<typeof authorCreditFixture>>;

interface PublicationRestriction { caseId: string; decisionId: string; enforcementId: string }

async function grantPublicationAuthority(fixture: PublicationFixture, scope: string, action: string): Promise<void> {
  await grantFixtureAuthority(fixture.accessPool, {
    scope, requireDispatch: true,
    representations: [{ principalId: fixture.principalId, actor: fixture.actor, action, lifetime: '8 hours' }],
    grant: { actor: fixture.actor, action, lifetime: '8 hours' },
  });
}

async function restrictPublicationTarget(fixture: PublicationFixture, target: string): Promise<PublicationRestriction> {
  const caseId = randomUUID(), decisionId = randomUUID(), enforcementId = randomUUID();
  const digest = 'b'.repeat(64);
  await ensureFixtureScopeGate(fixture.accessPool, 'governance:platform');
  await fixture.accessPool.query(`INSERT INTO access.governance_case
    (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
    VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global',
      'graph',$2,'publication','private')`, [caseId, target]);
  await fixture.accessPool.query(`INSERT INTO access.moderation_decision
    (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
      authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
      evidence_digest,disclosure,statement_of_reasons)
    VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,
      'platform','governance:platform',0,$5,$1::text,$5,'urn:rezics:rule:publication-read','1',$5,$5,
      'private',$6::jsonb)`, [decisionId, caseId, fixture.principalId, fixture.actor, digest, {
    facts: 'Publication is restricted for this Work container.', scope: 'publication',
    duration: 'Until the restriction is removed.', automation: false,
    appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
    rule: { ref: 'urn:rezics:rule:publication-read', revision: '1', digest },
  }]);
  await fixture.accessPool.query(`INSERT INTO access.moderation_decision_target
    (decision_id,ordinal,owner,resource,component,scope_kind,effect)
    VALUES ($1,1,'graph',$2,'publication','component','disclosure')`, [decisionId, target]);
  await fixture.accessPool.query(`UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1`,
    [caseId, decisionId]);
  await fixture.accessPool.query(`INSERT INTO access.governance_enforcement
    (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
    VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,'publication',NULL,
      'disclosure',$3,1,'restricted',1)`, [enforcementId, target, decisionId]);
  return { caseId, decisionId, enforcementId };
}

async function removePublicationRestriction(fixture: PublicationFixture, restriction: PublicationRestriction): Promise<void> {
  const restored = randomUUID();
  const client = await fixture.accessPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
        authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,
        evidence_digest,disclosure,statement_of_reasons)
      SELECT $1::uuid,kind,'restore',context,case_id,case_sequence+1,principal_id,acting_subject,authority_kind,
        authority_scope_id,authority_epoch,authority_proof_digest,$1::text,request_digest,rule_ref,rule_revision,
        rule_digest,evidence_digest,disclosure,statement_of_reasons
      FROM access.moderation_decision WHERE id=$2`, [restored, restriction.decisionId]);
    await client.query(`INSERT INTO access.moderation_decision_target
      (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
      SELECT $1,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect
      FROM access.moderation_decision_target WHERE decision_id=$2`, [restored, restriction.decisionId]);
    await client.query(`UPDATE access.governance_case SET decision_head=$2,generation=generation+1,
      state='closed',closed_at=clock_timestamp() WHERE id=$1`, [restriction.caseId, restored]);
    await client.query(`UPDATE access.governance_enforcement SET state='released',decision_id=$2,
      fence_epoch=fence_epoch+1 WHERE id=$1`, [restriction.enforcementId, restored]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function expectStructuredWorkAbsent(fixture: PublicationFixture, work: string,
  structure: string, revision: string): Promise<void> {
  const missingWork = '00000000-0000-4000-8000-000000000099';
  const missingRevision = '00000000-0000-4000-8000-000000000098';
  const paths: Array<[string, string]> = [
    [`/v1/works/${shortId(work)}`, `/v1/works/${missingWork}`],
    [`/v1/recipes/works/${shortId(work)}`, `/v1/recipes/works/${missingWork}`],
    [`/v1/compositions/${shortId(structure)}`, `/v1/compositions/${missingWork}`],
    [`/v1/compositions/${shortId(structure)}/revisions/${shortId(revision)}`,
      `/v1/compositions/${missingWork}/revisions/${missingRevision}`],
    [`/v1/recipes/${shortId(structure)}/exports/schema-org?actingSubject=${encodeURIComponent(fixture.actor)}`,
      `/v1/recipes/${missingWork}/exports/schema-org?actingSubject=${encodeURIComponent(fixture.actor)}`],
  ];
  for (const [path, missingPath] of paths) {
    const hidden = await fixture.call('GET', path, undefined, randomUUID(), null);
    const missing = await fixture.call('GET', missingPath, undefined, randomUUID(), null);
    const hiddenBody = await hidden.text(), missingBody = await missing.text();
    expect(hidden.status).toBe(missing.status);
    expect(hiddenBody).toBe(missingBody);
    expect(Object.keys(JSON.parse(hiddenBody)).sort()).toEqual(Object.keys(JSON.parse(missingBody)).sort());
  }
}

test('WORK10/RECIPE03: native admission publishes one exact Work candidate and withdrawal removes its name', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structured-work-publication-native-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (fixture.env as typeof fixture.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await fixture.json<{ work: string; mainVersion: string }>(await fixture.call(
      'POST', '/v1/works', await fixture.authoredBody({ profile: 'metadata-only-v1', language: 'en',
        title: 'Native structured publication', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: fixture.actor })), 201);
    await grantPublicationAuthority(fixture, `work:edit:${work.work}`, 'work.edit');
    await grantPublicationAuthority(fixture, `work:edit:${work.work}`, 'recipe.edit');
    await grantPublicationAuthority(fixture, `work:read:${work.work}`, 'work.read');
    await grantPublicationAuthority(fixture, `work:publish:${work.work}`, 'work.publish');
    await grantPublicationAuthority(fixture, `work:publish:${work.work}`, 'work.withdraw-publication');

    const created = await fixture.json<{ structure: string; revision: string }>(await fixture.call(
      'POST', '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: fixture.actor }, `recipe-${randomUUID()}`), 201);
    const current = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?workHead WHERE { GRAPH <urn:rezics:graph:current> { ${iri(work.work)} rv:head ?workHead } } LIMIT 2`);
    const workHeads = current.results?.bindings ?? [];
    expect(workHeads).toHaveLength(1);
    const initiallyPublic = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(initiallyPublic.results?.bindings ?? []).toHaveLength(0);

    const published = await fixture.json<{ publicationDecision: string; predecessor: string | null }>(
      await fixture.call('POST', '/v1/work-publications', {
        profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
        actingSubject: fixture.actor, expectedWorkHead: workHeads[0]!.workHead!.value,
        expectedMainVersion: work.mainVersion, structure: created.structure,
        expectedStructureHead: created.revision, expectedPublicationHead: null,
        disclosure: 'public', rightsBasis: 'original-contribution',
      }, `publication-${randomUUID()}`), 201);
    expect(published).toMatchObject({ predecessor: null });

    const publicCandidate = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(publicCandidate.results?.bindings ?? []).toHaveLength(1);

    const recipePath = `/v1/recipes/works/${shortId(work.work)}`;
    const selectedRecipe = await fixture.json<{ profile: string; structure: string; revision: string;
      occurrences: unknown[] }>(await fixture.call('GET', recipePath, undefined, randomUUID(), null), 200);
    expect(selectedRecipe).toMatchObject({ profile: 'recipe-work-page-v1',
      structure: created.structure, revision: created.revision, occurrences: [] });
    const selectedComposition = await fixture.json<{ structure: string; revision: string; occurrences: unknown[] }>(
      await fixture.call('GET', `/v1/compositions/${shortId(created.structure)}`, undefined, randomUUID(), null), 200);
    expect(selectedComposition).toMatchObject({ structure: created.structure, revision: created.revision, occurrences: [] });
    const exportPath = `/v1/recipes/${shortId(created.structure)}/exports/schema-org?actingSubject=${encodeURIComponent(fixture.actor)}`;
    const selectedExport = await fixture.json<{ revision: string; recipe: { recipeInstructions: unknown[] } }>(
      await fixture.call('GET', exportPath), 200);
    expect(selectedExport).toMatchObject({ revision: created.revision, recipe: { recipeInstructions: [] } });

    const draft = await fixture.json<{ revision: string; occurrences: string[] }>(await fixture.call('POST',
      `/v1/compositions/${shortId(created.structure)}/changes`, {
        profile: 'recipe-composition', expectedHead: created.revision, actingSubject: fixture.actor,
        operations: [{ op: 'insert', parent: created.structure, position: 'last', role: 'step',
          qualifier: { type: 'recipe-step', instructionText: { value: 'Keep the draft private.', language: 'en' },
            usesIngredient: [], media: [], scaling: 'linear' } }],
      }, `draft-${randomUUID()}`), 200);
    const stillSelected = await fixture.json<{ revision: string; occurrences: unknown[] }>(
      await fixture.call('GET', recipePath, undefined, randomUUID(), null), 200);
    expect(stillSelected).toMatchObject({ revision: created.revision, occurrences: [] });
    const stillSelectedComposition = await fixture.json<{ revision: string; occurrences: unknown[] }>(
      await fixture.call('GET', `/v1/compositions/${shortId(created.structure)}`, undefined, randomUUID(), null), 200);
    expect(stillSelectedComposition).toMatchObject({ revision: created.revision, occurrences: [] });
    const privatePreviewExport = await fixture.json<{ revision: string; recipe: { recipeInstructions: unknown[] } }>(
      await fixture.call('GET', `${exportPath}&revision=${encodeURIComponent(draft.revision)}`), 200);
    expect(privatePreviewExport.revision).toBe(draft.revision);
    expect(privatePreviewExport.recipe.recipeInstructions).toHaveLength(1);
    const previewMeasures = await fixture.json<{ revision: string }>(await fixture.call('GET',
      `/v1/recipes/${shortId(created.structure)}/measures?actingSubject=${encodeURIComponent(fixture.actor)}&revision=${encodeURIComponent(draft.revision)}`), 200);
    expect(previewMeasures.revision).toBe(draft.revision);
    const privateDraftRevision = await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}/revisions/${shortId(draft.revision)}`,
      undefined, randomUUID(), null);
    const missingRevision = await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}/revisions/00000000-0000-4000-8000-000000000099`,
      undefined, randomUUID(), null);
    expect([privateDraftRevision.status, await privateDraftRevision.text()])
      .toEqual([missingRevision.status, await missingRevision.text()]);
    if (draft.occurrences[0]) {
      const privateDraftOccurrence = await fixture.call('GET',
        `/v1/compositions/${shortId(created.structure)}/occurrences/${shortId(draft.occurrences[0]!)}`,
        undefined, randomUUID(), null);
      const missingOccurrence = await fixture.call('GET',
        `/v1/compositions/${shortId(created.structure)}/occurrences/00000000-0000-4000-8000-000000000099`,
        undefined, randomUUID(), null);
      expect([privateDraftOccurrence.status, await privateDraftOccurrence.text()])
        .toEqual([missingOccurrence.status, await missingOccurrence.text()]);
    }

    const republished = await fixture.json<{ publicationDecision: string }>(await fixture.call(
      'POST', '/v1/work-publications', {
        profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
        actingSubject: fixture.actor, expectedWorkHead: workHeads[0]!.workHead!.value,
        expectedMainVersion: work.mainVersion, structure: created.structure,
        expectedStructureHead: draft.revision, expectedPublicationHead: published.publicationDecision,
        disclosure: 'public', rightsBasis: 'original-contribution',
      }, `republish-${randomUUID()}`), 201);
    const republishedRecipe = await fixture.json<{ revision: string; occurrences: Array<{ role: string }> }>(
      await fixture.call('GET', recipePath, undefined, randomUUID(), null), 200);
    expect(republishedRecipe).toMatchObject({ revision: draft.revision, occurrences: [{ role: 'step' }] });

    const workRestriction = await restrictPublicationTarget(fixture, work.work);
    await expectStructuredWorkAbsent(fixture, work.work, created.structure, draft.revision);
    await removePublicationRestriction(fixture, workRestriction);

    const oldPublishedRevision = await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}/revisions/${shortId(created.revision)}`,
      undefined, randomUUID(), null);
    const missingAfterRepublish = await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}/revisions/00000000-0000-4000-8000-000000000099`,
      undefined, randomUUID(), null);
    expect([oldPublishedRevision.status, await oldPublishedRevision.text()])
      .toEqual([missingAfterRepublish.status, await missingAfterRepublish.text()]);

    const withdrawn = await fixture.json<{ publicationDecision: string; predecessor: string | null }>(
      await fixture.call('POST', '/v1/work-publications', {
        profile: 'work-structure-publication-v1', operation: 'withdraw', work: work.work,
        actingSubject: fixture.actor, expectedPublicationHead: republished.publicationDecision,
      }, `withdrawal-${randomUUID()}`), 201);
    expect(withdrawn.predecessor).toBe(republished.publicationDecision);
    const hiddenCandidate = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(hiddenCandidate.results?.bindings ?? []).toHaveLength(0);
    const absentRecipe = await fixture.call('GET', recipePath, undefined, randomUUID(), null);
    const missingRecipe = await fixture.call('GET',
      '/v1/recipes/works/00000000-0000-4000-8000-000000000099', undefined, randomUUID(), null);
    expect([absentRecipe.status, await absentRecipe.text()]).toEqual([missingRecipe.status, await missingRecipe.text()]);
    const absentComposition = await fixture.call('GET', `/v1/compositions/${shortId(created.structure)}`,
      undefined, randomUUID(), null);
    const missingComposition = await fixture.call('GET',
      '/v1/compositions/00000000-0000-4000-8000-000000000099', undefined, randomUUID(), null);
    expect([absentComposition.status, await absentComposition.text()])
      .toEqual([missingComposition.status, await missingComposition.text()]);
    const withdrawnRevision = await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}/revisions/${shortId(draft.revision)}`,
      undefined, randomUUID(), null);
    const missingWithdrawnRevision = await fixture.call('GET',
      `/v1/compositions/${shortId(created.structure)}/revisions/00000000-0000-4000-8000-000000000099`,
      undefined, randomUUID(), null);
    expect([withdrawnRevision.status, await withdrawnRevision.text()])
      .toEqual([missingWithdrawnRevision.status, await missingWithdrawnRevision.text()]);
    if (draft.occurrences[0]) {
      const withdrawnOccurrence = await fixture.call('GET',
        `/v1/compositions/${shortId(created.structure)}/occurrences/${shortId(draft.occurrences[0]!)}`,
        undefined, randomUUID(), null);
      const missingWithdrawnOccurrence = await fixture.call('GET',
        `/v1/compositions/${shortId(created.structure)}/occurrences/00000000-0000-4000-8000-000000000099`,
        undefined, randomUUID(), null);
      expect([withdrawnOccurrence.status, await withdrawnOccurrence.text()])
        .toEqual([missingWithdrawnOccurrence.status, await missingWithdrawnOccurrence.text()]);
    }
  } finally { await fixture.close(); }
}, 180_000);
