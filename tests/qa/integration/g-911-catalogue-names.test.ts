import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, PUBLIC_SEARCH_GRAPH, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { commitMetadata } from '../../../services/main/src/modules/work/metadata-command.ts';
import { metadataDigest, type MetadataState } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { backfillCatalogueNames } from '../../../services/main/src/modules/search/names.ts';
import { searchRoutes, type SearchRouteDependencies } from '../../../services/main/src/routes/search.ts';
import { startMediaStack } from './media-support.ts';

interface Page { count: { value: number; precision: string }; next: string | null;
  results: Array<{ work: string; mainVersion: string; score: number; title: { value: string } }> }

test('G-911: catalogue ranks titles and multilingual aliases first, folds scripts, and pages one Work per identity', async () => {
  const stack = await startMediaStack(`g911${randomUUID().replaceAll('-', '')}`);
  try {
    const member = await stack.member('catalogue-name-reader');
    const marker = `g911${randomUUID().replaceAll('-', '')}`;
    const title = `${marker} Camp Lanterns`;
    const aliases = [{ value: `${marker} 魔法禁書目錄`, language: 'zh-Hant' },
      { value: `${marker} ガラス`, language: 'ja' }, { value: `${marker} ＲＵＳＴ`, language: 'en' }];
    const catalogue = { candidateReceipt: randomUUID(), grain: 'new-creative-scope' as const, aliases };
    async function create(name: string, body: string, details: { catalogue?: typeof catalogue } = {}) {
      const created = await activateMetadataWork(stack.env, { title: name, language: 'en', ...details,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create',
          metadataWorkRequestDigest(name, undefined, 'en', details)) });
      const published = await stack.contribution(created.work, member.actor, 'en', body);
      const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work, contribution: published.contribution, publicationDecision: published.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
      const selected = await selectMainDefault(stack.env, stack.admission(member.actor,
        `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(input)), input);
      expect(selected.outcome).toBe('succeeded');
      return { ...created, unit: selected.matchUnit! };
    }
    const named = await create(title, 'An article about lighting outdoors.', { catalogue });
    const bodyOnly = await create(`Different ${marker} article`, `${title} ${aliases.map(alias => alias.value).join(' ')} article`);
    const both = await create(`${marker} Camp Other Lanterns`, `${marker} Camp Lanterns selected body`);
    await stack.privateWork(member.actor, `${marker} Secret Camp Lanterns`);
    const read = async (term: string, limit = 64, cursor?: string, app = stack.main): Promise<Page> => {
      const response = await app.handle(new Request(`http://main.local/v1/search/catalogue?q=${encodeURIComponent(term)}&limit=${limit}`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
      const value = await response.json();
      if (response.status !== 200) throw new Error(`catalogue HTTP ${response.status}: ${JSON.stringify(value)}`);
      return value as Page;
    };
    for (const term of ['Camp', `${marker} Camp Lanterns`, `${marker} Lanterns Camp`,
      `${marker} 魔法禁书目录`, `${marker} 魔法禁書目錄`, `${marker} がらす`, `${marker} ｶﾞﾗｽ`, `${marker} rust`]) {
      const page = await read(term);
      const nameHit = page.results.find(row => row.work === named.work);
      expect(nameHit).toBeDefined();
      expect(page.results[0]!.score).toBe(nameHit!.score);
      expect(nameHit!.title.value).toBe(title);
      expect(new Set(page.results.map(row => row.mainVersion)).size).toBe(page.results.length);
      const bodyHit = page.results.find(row => row.work === bodyOnly.work);
      if (bodyHit) expect(nameHit!.score).toBeGreaterThan(bodyHit.score);
    }
    expect((await read(`${marker} 魔法禁书目录 rust`)).results).toEqual([]); // Words cannot span two aliases.
    const multiField = await stack.main.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile: 'public-main-title-body-v1', titleTerm: 'Camp', bodyTerm: 'lighting outdoors', language: null,
      }),
    }));
    expect(multiField.status).toBe(200);
    expect(await multiField.json()).toMatchObject({ total: 1, results: [{ work: named.work }] });
    expect((await read(`${marker} Secret`)).count).toEqual({ value: 0, precision: 'exact' });
    // All three titles match the marker at the same name-tier score. Lucene
    // breaks ties by document order within this commit, not Work creation order.
    const complete = await read(marker);
    expect(complete.results.map(row => row.work).sort()).toEqual([named.work, bodyOnly.work, both.work].sort());
    expect(new Set(complete.results.map(row => row.score)).size).toBe(1);
    const traversed = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await read(marker, 1, cursor);
      traversed.push(...page.results.map(row => row.work));
      if (!page.next) { expect(page.count).toEqual({ value: 3, precision: 'exact' }); break; }
      cursor = page.next;
      if (pageNumber === 9) throw new Error('Catalogue did not exhaust its small multilingual fixture');
    }
    expect(traversed).toEqual(complete.results.map(row => row.work));

    // Metadata writes replace their exact name projection while preserving
    // creation aliases. Retired localized names must leave Lucene as well.
    const header = (name: string): Extract<MetadataState, { kind: 'header' }> => ({ kind: 'header', originalTitle: null,
      localized: [{ language: 'fr', title: `${marker} ${name}`, description: null, mainVersionLabel: null }] });
    const first = { work: named.work, expectedHead: null, state: header('Lumières') };
    expect(await commitMetadata(stack.env, stack.admission(member.actor, `work:edit:${named.work}`, 'work.edit', metadataDigest(first)), first)).toBe(true);
    expect((await read(`${marker} Lumières`)).results[0]!.work).toBe(named.work);
    const head = (await stack.fuseki.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(named.work)} <https://rezics.com/vocab/descriptiveMetadataHead> ?head } }`)).results!.bindings[0]!.head!.value;
    const second = { work: named.work, expectedHead: head, state: header('Lampes') };
    expect(await commitMetadata(stack.env, stack.admission(member.actor, `work:edit:${named.work}`, 'work.edit', metadataDigest(second)), second)).toBe(true);
    expect((await read(`${marker} Lumières`)).results).toEqual([]);
    expect((await read(`${marker} Lampes`)).results[0]!.work).toBe(named.work);
    expect((await read(`${marker} 魔法禁书目录`)).results[0]!.work).toBe(named.work);

    // Simulate pre-G-911 units and use the stopped-writer rebuild recipe.
    await stack.fuseki.update(`DELETE WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ${iri(named.unit)} <https://rezics.com/vocab/publicTitle> ?name } }`);
    expect((await read(`${marker} Lampes`)).results).toEqual([]);
    expect(await backfillCatalogueNames(stack.env)).toBeGreaterThanOrEqual(3);
    expect((await read(`${marker} Lampes`)).results[0]!.work).toBe(named.work);
    expect((await read(`${marker} 魔法禁書目錄`)).results[0]!.work).toBe(named.work);

    // The existing exact-head title owner must gate counts as well as cards.
    const restricted = searchRoutes(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async () => member.principal }, governance: { store: {
        restrictedTitles: async () => new Set([named.work]),
      } } } as unknown as SearchRouteDependencies);
    const hidden = await read(`${marker} Lampes`, 64, undefined, restricted);
    expect(hidden.results).toEqual([]);
    expect(hidden.count).toEqual({ value: 0, precision: 'exact' });
    // A stale public index name cannot resurrect a Work whose graph disclosure
    // is no longer public. Its count is unchanged by that private name.
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(named.work)} rv:catalogueVisible true .
        ${iri(named.mainVersion)} rv:selectionHead ?selection } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(named.mainVersion)} rv:selectionHead ?selection } }`);
    expect((await read(`${marker} Lampes`)).count).toEqual({ value: 0, precision: 'exact' });
    expect((await read(marker)).results.map(row => row.work)).not.toContain(named.work);
  } finally { await stack.stop(); }
}, 180_000);
