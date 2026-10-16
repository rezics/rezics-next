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

test('an Anime section list finds each searchable Content placement through composed Main', async () => {
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
    const changed = await json<{ occurrences: string[] }>(await actor.send('POST',
      `/v1/compositions/${short(structure.structure)}/changes`, {
        profile: 'section-list-v1', actingSubject: actor.actor, expectedHead: structure.revision,
        operations: [0, 1].map(index => ({ op: 'insert', role: 'entry', parent: structure.structure,
          position: 'last', target: source.work, qualifier: { note: `Use ${index}` } })),
      }));
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
    const eligible = await json<{ decision: string }>(await actor.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: source.work, variantId,
      publicationDecision: published.decision, expectedEligibilityHead: null,
      actingSubject: actor.actor, rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
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
    const query = () => stack.call('POST', '/v1/queries/page', { body: {
      profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 } });
    const before = stack.fuseki.queries;
    const page = await json<{ total: number; results: Array<{ work: string; revision: string;
      matchedPlacements?: Array<{ resource: string; work: string; occurrence: string; profile: string }> }> }>(await query());
    expect(page.results.map(hit => hit.work)).toEqual([owner.work]);
    expect(new Set(page.results.flatMap(hit => hit.matchedPlacements?.map(place => place.occurrence) ?? []))).toEqual(new Set(changed.occurrences));
    for (const hit of page.results) expect(hit).toMatchObject({ revision: `urn:rezics:content:revision:${draft.revisionId}`,
      matchedPlacements: expect.arrayContaining([{ resource: source.work, work: owner.work, profile: 'section-list-v1', occurrence: changed.occurrences[0], title: 'Production notes' }]) });
    expect(stack.fuseki.queries - before).toBeLessThanOrEqual(40);
    await json(await actor.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: source.work, variantId,
      publicationDecision: published.decision, expectedEligibilityHead: eligible.decision,
      actingSubject: actor.actor, rightsBasis: 'original-contribution', disclosure: 'private' }), 201);
    await relay();
    expect(await json(await query())).toMatchObject({ total: 0, results: [] });
  } finally { await stack.stop(); }
}, 240_000);
