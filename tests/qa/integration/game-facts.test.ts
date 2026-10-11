import { expect, test } from 'bun:test';
import captured from '../../../services/main/tests/bangumi-captured-subjects.json';
import { importBangumiWorkFacts, type BangumiFactSource, type BangumiFactsClient }
  from '../../../scripts/datasets/bangumi.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { CONCEPT_FACET } from '../../../services/main/src/modules/concept-page/contract.ts';
import { startMediaStack } from './media-support.ts';

const subjects = captured as Record<string, BangumiFactSource>;
const YEARS = 'https://rezics.com/query/work-publication-years';

test('game platforms are public Concept facets and the earliest date is read by statements and years', async () => {
  const stack = await startMediaStack('game-facts');
  try {
    const member = await stack.member('game-facts');
    await grantRecordedPlatformUse(stack.accessPool, member.principalId, ['platform-admin']);
    await member.grant(MANAGE_SCOPE, MANAGE_ACTION);
    await member.grant('classification:define:global', 'classification.proposition.define');
    await member.grant('semantic:create:root', 'semantic.change');
    await member.grant('context:create:root', 'context.create');
    await member.grant(`statement:speak:${member.actor}`, 'statement.record');
    await member.grant('classification:decide:global', 'statement.decide');
    const accepted = async <T>(response: Response, path: string): Promise<T> => {
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
      return JSON.parse(text) as T;
    };
    const client: BangumiFactsClient = {
      post: async <T>(path, body, key) => accepted<T>(await member.send('POST', path, body, key), path),
      put: async <T>(path, body, key) => accepted<T>(await member.send('PUT', path, body, key), path),
      authorizeDefinition: async receipt => {
        await member.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      },
    };
    const multiPlatform = await stack.publicWork(member.actor);
    const noPlatform = await stack.publicWork(member.actor);
    await member.grant(`work:edit:${multiPlatform.work}`, 'work.edit');
    await member.grant(`work:edit:${noPlatform.work}`, 'work.edit');
    const imported = await importBangumiWorkFacts(client, member.actor, multiPlatform, subjects['2113']!);
    const undetailed = await importBangumiWorkFacts(client, member.actor, noPlatform, subjects['636913']!);
    expect(imported.facts.platforms).toEqual(['ngc', 'n64']);
    expect(undetailed.facts.platforms).toEqual([]);
    expect(imported.facts.date).toEqual({ lexical: '1998-11-21', datatype: 'http://www.w3.org/2001/XMLSchema#date' });
    expect(undetailed.facts.date).toEqual({ lexical: '2021', datatype: 'http://www.w3.org/2001/XMLSchema#gYear' });

    await stack.statementSeek.rebuild();
    type Generation = { generation: string; checkpoint: string; complete: boolean; state: string };
    let generation = await accepted<Generation>(await member.send('POST', '/v1/discovery/generation-builds', {
      profile: 'discovery-generation-build-v1', actingSubject: member.actor,
      basis: { scope: 'global', realm: null, context: null },
    }), '/v1/discovery/generation-builds');
    for (let steps = 0; !generation.complete && steps < 20; steps++) {
      generation = await accepted<Generation>(await member.send('POST',
        `/v1/discovery/generations/${generation.generation}/advance`, {
          actingSubject: member.actor, expectedCheckpoint: generation.checkpoint,
        }), '/v1/discovery/generations/advance');
    }
    expect(generation).toMatchObject({ complete: true, state: 'ready' });
    const head = await accepted<{ activeHeadRevision: string | null }>(await stack.call('GET',
      `/v1/discovery/generations/${generation.generation}?actingSubject=${encodeURIComponent(member.actor)}`,
      { token: member.token }), '/v1/discovery/generations');
    await accepted(await member.send('POST', '/v1/discovery/generation-activations', {
      profile: 'discovery-generation-activation-v1', actingSubject: member.actor,
      generation: generation.generation, expectedHeadRevision: head.activeHeadRevision,
    }), '/v1/discovery/generation-activations');
    const concepts = imported.platformConcepts;
    const facet = async (concept: string) => accepted<{ template: string; result: {
      items: { id: string }[]; filter: { all: { facet: string; any?: string[] }[] };
    } }>(await stack.call('POST', '/v1/query', { body: {
      context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 20 },
      filter: { all: [{ facet: 'concept', any: [concept] }] },
    } }), '/v1/query');
    for (const key of ['ngc', 'n64'] as const) {
      const page = await facet(concepts[key]!);
      expect(page.template).toBe('concept-works-v1');
      expect(page.result.filter.all).toContainEqual({ facet: CONCEPT_FACET, all: [concepts[key]] });
      expect(page.result.items.map(item => item.id)).toContain(multiPlatform.work);
      expect(page.result.items.map(item => item.id)).not.toContain(noPlatform.work);
    }

    const statements = async (work: string) => accepted<{ groups: {
      predicate: string; items: { value: { lexical?: string; datatype?: string } }[];
    }[] }>(await stack.call('GET', `/v1/resources/${work.slice(-36)}/statements`), '/v1/resources/statements');
    const dates = async (work: string) => {
      const page = await statements(work);
      return page.groups.find(group => group.predicate === imported.datePredicate)?.items.map(item => ({
        lexical: item.value.lexical, datatype: item.value.datatype,
      }));
    };
    expect(await dates(multiPlatform.work)).toEqual([{
      lexical: '1998-11-21', datatype: 'http://www.w3.org/2001/XMLSchema#date',
    }]);
    expect(await dates(noPlatform.work)).toEqual([{
      lexical: '2021', datatype: 'http://www.w3.org/2001/XMLSchema#gYear',
    }]);
    expect(imported.datePredicate).toBeTruthy();
    expect(undetailed.datePredicate).toBe(imported.datePredicate);

    const response = await stack.call('POST', '/v1/query', { body: {
      profile: 'template-query-v1', query: YEARS, revision: 1, parameters: {},
    } });
    const years = await accepted<{ result: { items: { id: string; year: number }[] } }>(response, '/v1/query');
    expect(years.result.items.filter(item => item.id === multiPlatform.work).map(item => item.year)).toEqual([1998]);
    expect(years.result.items.filter(item => item.id === noPlatform.work).map(item => item.year)).toEqual([2021]);
  } finally {
    await stack.stop();
  }
}, 300_000);
