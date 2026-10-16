import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { deliverFixtureContentEligibility } from '../fixtures/content-projection.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Anime composition parts are searchable while section-list targets follow reader admission', async () => {
  const stack = await startMediaStack('search-profile-placements', { contentProjection: true });
  try {
    await stack.contentCursor.initialize(stack.contentConsumer);
    const actor = await stack.member('placement-author');
    const owner = await stack.catalogueWork(actor.actor, 'Anime anthology', ['https://schema.org/TVSeries']);
    const source = await stack.privateWork(actor.actor, 'Production notes');
    for (const work of [owner, source]) {
      const text = await stack.contribution(work.work, actor.actor, 'en', 'Opening text');
      const input = { context: { kind: 'main-version-default' as const, id: work.mainVersion },
        work: work.work, contribution: text.contribution, publicationDecision: text.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor.actor };
      await selectMainDefault(stack.env, stack.admission(actor.actor,
        `publication:select:${work.mainVersion}`, 'publication.select', mainSelectionDigest(input)), input);
      await actor.grant(`work:edit:${work.work}`, 'work.edit');
      await actor.grant(`work:read:${work.work}`, 'work.read');
    }
    const structure = await json<{ structure: string; revision: string }>(await actor.send('POST',
      '/v1/compositions', { profile: 'section-list-v1', work: owner.work,
        mainVersion: owner.mainVersion, actingSubject: actor.actor }), 201);
    for (const [scope, action] of [['draft', 'draft'], ['publish', 'publish'],
      ['search-eligibility', 'search-eligibility']] as const) {
      await actor.grant(`content:${scope}:${source.work}`, `content.${action}`);
    }
    const phrase = `celestial railway ${randomUUID().slice(0, 8)}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await actor.send('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: source.work,
        variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead: null, body: phrase, actingSubject: actor.actor }), 201);
    const published = await json<{ decision: string }>(await actor.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `placement-${randomUUID()}`, revisionId: draft.revisionId,
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      resourceId: source.work, variantId, expectedPublicationHead: null, actingSubject: actor.actor }), 201);
    await json<{ decision: string }>(await actor.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: source.work, variantId,
      publicationDecision: published.decision, expectedEligibilityHead: null,
      actingSubject: actor.actor, rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
    const changed = await json<{ revision: string; occurrences: string[] }>(await actor.send('POST',
      `/v1/compositions/${short(structure.structure)}/changes`, {
        profile: 'section-list-v1', actingSubject: actor.actor, expectedHead: structure.revision,
        operations: [0, 1].map(index => ({ op: 'insert', role: 'entry', parent: structure.structure,
          position: 'last', target: source.work, qualifier: { note: `Use ${index}` },
          selection: { mode: 'fixed-revision', revision: draft.revisionId,
            selector: { grain: 'content', variantId, revision: draft.revisionId } } })),
      }));
    // Search consumes an explicitly published Structure root rather than
    // the editable draft head, with target admission supplied by its reader.
    await actor.grant(`work:publish:${owner.work}`, 'work.publish');
    const heads = (await stack.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head WHERE { GRAPH <urn:rezics:graph:current> { <${owner.work}> rv:head ?head } }`)).results!.bindings;
    await json(await actor.send('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: owner.work,
      actingSubject: actor.actor, expectedWorkHead: heads[0]!.head!.value,
      expectedMainVersion: owner.mainVersion, structure: structure.structure,
      expectedStructureHead: changed.revision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public',
    }), 201);
    const command = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
    const relayEnv = { ...stack.env, fuseki: command };
    await stack.contentCursor.initialize(stack.contentConsumer);
    const relay = async () => {
      await deliverFixtureContentEligibility(relayEnv, stack.content);
      const cut = await stack.content.ownerPosition();
      for (let i = 0; i < 12 && (await stack.contentCursor.read(stack.contentConsumer)).sequence !== cut.sequence; i++) {
        await relayContentProjectionOnce(relayEnv, stack.content, stack.contentCursor, stack.contentConsumer);
      }
    };
    await relay();
    const input = { profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 };
    const outline = await json<{ occurrences: Array<{ occurrence: string }> }>(
      await actor.read(`/v1/compositions/${short(structure.structure)}`));
    expect(outline.occurrences.map(item => item.occurrence)).toEqual(changed.occurrences);
    const visitorOutline = await json<{ occurrences: unknown[] }>(
      await stack.call('GET', `/v1/compositions/${short(structure.structure)}`));
    expect(visitorOutline.occurrences).toEqual([]);
    const visitorPage = await json<{ results: Array<{ matchedPlacements?: unknown[] }> }>(
      await stack.call('POST', '/v1/queries/page', { body: input }));
    expect(visitorPage.results.flatMap(hit => hit.matchedPlacements ?? [])).toEqual([]);
    // Signing in supplies preferences, not Structure acting authority.
    expect(await json(await actor.send('POST', '/v1/queries/page', input)))
      .toMatchObject({ total: 0, results: [] });
    const query = () => stack.call('POST', '/v1/queries/page', { body: input });
    // A later section-list draft does not change visitor target admission.
    const removed = await json<{ revision: string }>(await actor.send('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
      profile: 'section-list-v1', expectedHead: changed.revision, actingSubject: actor.actor,
      operations: [{ op: 'remove', occurrence: changed.occurrences[0] }],
    }));
    await json(await actor.send('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
      profile: 'section-list-v1', expectedHead: removed.revision, actingSubject: actor.actor,
      operations: [{ op: 'insert', role: 'entry', parent: structure.structure, position: 'last',
          target: source.work, qualifier: { note: 'Unpublished replacement' } }],
    }));
    expect(await json(await query())).toMatchObject({ total: 0, results: [] });

    // The generic composition profile admits public Work parts for every owner
    // type. Its declared searchable role gives this Anime a public phrase path.
    const anime = await stack.catalogueWork(actor.actor, 'Anime collection', ['https://schema.org/TVSeries']);
    const introduction = await stack.contribution(anime.work, actor.actor, 'en', 'Collection introduction');
    const selected = { context: { kind: 'main-version-default' as const, id: anime.mainVersion },
      work: anime.work, contribution: introduction.contribution, publicationDecision: introduction.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor.actor };
    await selectMainDefault(stack.env, stack.admission(actor.actor,
      `publication:select:${anime.mainVersion}`, 'publication.select', mainSelectionDigest(selected)), selected);
    for (const action of ['edit', 'read']) await actor.grant(`work:${action}:${anime.work}`, `work.${action}`);
    const composition = await json<{ structure: string; revision: string }>(await actor.send('POST',
      '/v1/compositions', { profile: 'work-composition', work: anime.work,
        mainVersion: anime.mainVersion, actingSubject: actor.actor }), 201);
    const parts = await json<{ revision: string; occurrences: string[] }>(await actor.send('POST',
      `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'work-composition', actingSubject: actor.actor, expectedHead: composition.revision,
        operations: [0, 1].map(index => ({ op: 'insert', role: 'part', parent: composition.structure,
          position: 'last', target: source.work, displayLabel: `Part ${index + 1}`, inclusion: 'required' })),
      }));
    const publicParts = await json<{ occurrences: Array<{ occurrence: string }> }>(
      await stack.call('GET', `/v1/compositions/${short(composition.structure)}`));
    expect(publicParts.occurrences.map(item => item.occurrence)).toEqual(parts.occurrences);
    const before = stack.fuseki.queries;
    const page = await json<{ total: number; results: Array<{ work: string; revision: string;
      matchedPlacements?: Array<{ resource: string; work: string; occurrence: string; profile: string }> }> }>(await query());
    expect(page.results.map(hit => hit.work)).toEqual([anime.work]);
    expect(page.results.flatMap(hit => hit.matchedPlacements?.map(place => place.occurrence) ?? []))
      .toEqual(parts.occurrences);
    for (const hit of page.results) expect(hit).toMatchObject({ revision: `urn:rezics:content:revision:${draft.revisionId}`,
      matchedPlacements: expect.arrayContaining([{ resource: source.work, work: anime.work, profile: 'work-composition',
        occurrence: parts.occurrences[0], title: 'Production notes' }]) });
    expect(stack.fuseki.queries - before).toBeLessThanOrEqual(40);
    // Public Content eligibility does not publish its source Work into the
    // Main Work phrase-search relation.
    const privateSource = await stack.privateWork(actor.actor, 'Private production notes');
    for (const action of ['edit', 'read']) await actor.grant(`work:${action}:${privateSource.work}`, `work.${action}`);
    for (const action of ['draft', 'publish', 'search-eligibility']) {
      await actor.grant(`content:${action}:${privateSource.work}`, `content.${action}`);
    }
    const privatePhrase = `unreleased railway ${randomUUID().slice(0, 8)}`;
    const privateVariant = `urn:rezics:variant:${randomUUID()}`;
    const privateDraft = await json<typeof draft>(await actor.send('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: privateSource.work, variantId: privateVariant,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null, body: privatePhrase, actingSubject: actor.actor }), 201);
    const privatePublication = await json<typeof published>(await actor.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `placement-${randomUUID()}`, revisionId: privateDraft.revisionId,
      expectedDigest: privateDraft.byteDigest, expectedContentEpoch: privateDraft.sourcePosition.dataEpoch,
      resourceId: privateSource.work, variantId: privateVariant, expectedPublicationHead: null,
      actingSubject: actor.actor }), 201);
    await json(await actor.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: privateSource.work, variantId: privateVariant,
      publicationDecision: privatePublication.decision, expectedEligibilityHead: null,
      actingSubject: actor.actor, rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
    await relay();
    expect(await json(await stack.call('POST', '/v1/queries/page', { body: {
      profile: 'public-main-phrase-page-v1', phrase: privatePhrase, language: null, pageSize: 10,
    } }))).toMatchObject({ total: 0, results: [] });
  } finally { await stack.stop(); }
}, 240_000);
