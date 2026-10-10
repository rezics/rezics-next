import { expect, test } from 'bun:test';
import captured from '../../../services/main/tests/bangumi-captured-subjects.json';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { importBangumiWorkFacts, type BangumiFactSource, type BangumiFactsClient }
  from '../../../scripts/datasets/bangumi.ts';
import { startMediaStack } from './media-support.ts';

const QUERY = 'https://rezics.com/query/work-publication-years';
const subjects = captured as Record<string, BangumiFactSource>;

test('a dated Bangumi subject lists in work-publication-years and a replay writes nothing new', async () => {
  const stack = await startMediaStack('bangumi-work-facts');
  try {
    const member = await stack.member('bangumi-facts');
    await member.grant('classification:define:global', 'classification.proposition.define');
    await member.grant('semantic:create:root', 'semantic.change');
    await member.grant('context:create:root', 'context.create');
    await member.grant(`statement:speak:${member.actor}`, 'statement.record');
    await member.grant('classification:decide:global', 'statement.decide');
    const accepted = async (response: Response, path: string) => {
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
      return JSON.parse(text) as never;
    };
    const client: BangumiFactsClient = {
      post: async (path, body, key) => accepted(await member.send('POST', path, body, key), path),
      put: async (path, body, key) => accepted(await member.send('PUT', path, body, key), path),
      authorizeDefinition: async (receipt) => {
        await member.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      },
    };
    const dated = await stack.publicWork(member.actor);
    const undated = await stack.publicWork(member.actor);
    await importBangumiWorkFacts(client, member.actor, dated, subjects['975']!);
    await importBangumiWorkFacts(client, member.actor, undated, { id: 424242, type: 2, platform: 1 });
    const years = async () => {
      const response = await stack.main.handle(new Request('http://main.local/v1/query', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'template-query-v1', query: QUERY, revision: 1, parameters: {} }) }));
      const value = await response.json() as { result?: { items: Array<{ id: string; year: number }> } };
      if (response.status !== 200) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
      return value.result!.items;
    };
    const count = async (work: string) => (await stack.fuseki.query(
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX schema: <https://schema.org/>
      SELECT (COUNT(?statement) AS ?count) WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?statement a rdf:Statement ; rdf:subject ${iri(work)} ; rdf:predicate schema:datePublished .
      } }`)).results!.bindings[0]?.count?.value;
    const listed = await years();
    expect(listed.filter((item) => item.id === dated.work).map((item) => item.year)).toEqual([1999]);
    expect(listed.map((item) => item.id)).not.toContain(undated.work);
    expect(await count(dated.work)).toBe('1');
    expect(await count(undated.work)).toBe('0');
    await importBangumiWorkFacts(client, member.actor, dated, subjects['975']!);
    expect(await count(dated.work)).toBe('1');
    const replayed = await years();
    expect(replayed.filter((item) => item.id === dated.work).map((item) => item.year)).toEqual([1999]);
    expect(replayed.map((item) => item.id)).not.toContain(undated.work);
  } finally {
    await stack.stop();
  }
}, 300_000);
