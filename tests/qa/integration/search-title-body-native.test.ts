import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { queryPublicMainTitleBody }
  from '../../../services/main/src/modules/work/search-multifield.ts';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { searchRoutes, type SearchRouteDependencies }
  from '../../../services/main/src/routes/search.ts';
import { startMediaStack } from './media-support.ts';

test('SEARCH14: dedicated public title and selected body join at one unit without unrelated labels', async () => {
  const stack = await startMediaStack('bodyword');
  try {
    const member = await stack.member('title-body-owner');
    const titleTerm = `title${randomUUID().replaceAll('-', '')}`;
    const work = await stack.publicWork(member.actor, ['en'], titleTerm);
    const unrelated = await stack.privateWork(member.actor, `${titleTerm} unrelated label`);
    const label = await stack.fuseki.query(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(unrelated.work)} rdfs:label ?label . FILTER(STR(?label) = ${lit(unrelated.title)})
      } }`);
    expect(label.results?.bindings).toHaveLength(1);
    const input = { titleTerm, bodyTerm: 'bodyword', language: 'en' };
    const joined = await queryPublicMainTitleBody(stack.env, input);
    expect(joined).toMatchObject({ profile: 'public-main-title-body-v1', complete: true, total: 1,
      results: [{ work: work.work, mainVersion: work.mainVersion }] });
    expect(joined.results[0]!.score).toBeGreaterThan(0);
    expect((await queryPublicMainTitleBody(stack.env,
      { ...input, bodyTerm: titleTerm })).total).toBe(0);
    expect((await queryPublicMainTitleBody(stack.env,
      { ...input, titleTerm: 'bodyword' })).total).toBe(0);
    const app = searchRoutes(stack.fuseki, { environment: stack.env,
      access: stack.access, account: { verify: async () => member.principal },
    } as SearchRouteDependencies);
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-title-body-v1', ...input }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true, total: 1,
      results: [{ work: work.work, mainVersion: work.mainVersion,
        score: joined.results[0]!.score }] });
  } finally { await stack.stop(); }
}, 120_000);
