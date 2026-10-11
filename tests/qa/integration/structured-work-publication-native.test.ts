import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { iri } from '../../../services/main/src/modules/work/activate.ts';
import { publicWork } from '../../../services/main/src/modules/work/public-patterns.ts';

test('RECIPE07 native admission publishes one exact Work candidate and withdrawal removes its name', async () => {
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
    await fixture.grant(`work:edit:${work.work}`, 'work.edit');
    await fixture.grant(`work:edit:${work.work}`, 'recipe.edit');
    await fixture.grant(`work:publish:${work.work}`, 'work.publish');
    await fixture.grant(`work:publish:${work.work}`, 'work.withdraw-publication');

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
    const nameUnit = `urn:rezics:search:name:work:${shortId(work.work)}`;
    const publicName = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      ASK { GRAPH <urn:rezics:graph:public-search> { <${nameUnit}> rv:publicTitle ?title } }`);
    expect(publicName.boolean).toBe(true);

    const withdrawn = await fixture.json<{ publicationDecision: string; predecessor: string | null }>(
      await fixture.call('POST', '/v1/work-publications', {
        profile: 'work-structure-publication-v1', operation: 'withdraw', work: work.work,
        actingSubject: fixture.actor, expectedPublicationHead: published.publicationDecision,
      }, `withdrawal-${randomUUID()}`), 201);
    expect(withdrawn.predecessor).toBe(published.publicationDecision);
    const hiddenCandidate = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(hiddenCandidate.results?.bindings ?? []).toHaveLength(0);
    const hiddenName = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      ASK { GRAPH <urn:rezics:graph:public-search> { <${nameUnit}> rv:publicTitle ?title } }`);
    expect(hiddenName.boolean).toBe(false);
  } finally { await fixture.close(); }
}, 180_000);
