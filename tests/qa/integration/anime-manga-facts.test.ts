import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import captured from '../../../services/main/tests/bangumi-captured-subjects.json';
import { importBangumiWorkFacts, type BangumiFactSource, type BangumiFactsClient }
  from '../../../scripts/datasets/bangumi.ts';
import { startHomeStack } from './feed-read-support.ts';

const subjects = captured as Record<string, BangumiFactSource>;

test('imported anime and manga facts are read by concept search and the statement page', async () => {
  const home = await startHomeStack('anime-manga-facts');
  const app = createMainApp(home.stack.fuseki, { ...home.deps, statementSeek: home.stack.statementSeek });
  const call = (method: string, path: string, body?: object, key = randomUUID(), signed = true) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: {
      // A signed Query asks for the mute presentation owner. Format search is public.
      ...(signed ? { authorization: `Bearer ${home.author.token}` } : {}),
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const accepted = async <T>(response: Response, path: string): Promise<T> => {
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
    return JSON.parse(text) as T;
  };
  const client: BangumiFactsClient = {
    post: async (path, body, key) => accepted(await call('POST', path, body, key), path),
    put: async (path, body, key) => accepted(await call('PUT', path, body, key), path),
    authorizeDefinition: async (receipt) => {
      await home.author.grant(`semantic:read:${receipt.component}`, 'semantic.read');
    },
  };
  try {
    await home.author.grant('classification:define:global', 'classification.proposition.define');
    await home.author.grant('semantic:create:root', 'semantic.change');
    await home.author.grant('context:create:root', 'context.create');
    await home.author.grant(`statement:speak:${home.author.actor}`, 'statement.record');
    await home.author.grant('classification:decide:global', 'statement.decide');
    const animeToken = `anime${randomUUID().replaceAll('-', '')}`;
    const mangaToken = `manga${randomUUID().replaceAll('-', '')}`;
    // Phrase search reads the selected contribution's body, not the Work title.
    const publish = async (token: string) => {
      const created = await home.stack.catalogueWork(home.author.actor, `Work ${token}`);
      const text = await home.stack.contribution(created.work, home.author.actor, 'en',
        `A searchable ${token} story`);
      const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work, contribution: text.contribution, publicationDecision: text.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const,
        actingSubject: home.author.actor };
      const selected = await selectMainDefault(home.stack.env, home.stack.admission(home.author.actor,
        `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(input)), input);
      if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
      return created;
    };
    const anime = await publish(animeToken);
    const manga = await publish(mangaToken);
    await home.author.grant(`work:edit:${anime.work}`, 'work.edit');
    await home.author.grant(`work:edit:${manga.work}`, 'work.edit');
    const animeFacts = await importBangumiWorkFacts(client, home.author.actor, anime, subjects['975']!);
    const mangaFacts = await importBangumiWorkFacts(client, home.author.actor, manga, subjects['3582']!);
    expect(animeFacts.facts).toMatchObject({ format: 'tv', count: { notation: 'episode-count', lexical: '1155' },
      status: null });
    expect(mangaFacts.facts).toMatchObject({ format: 'manga', count: { notation: 'volume-count', lexical: '21' },
      status: 'completed' });
    await home.stack.statementSeek.rebuild();
    // One Concept condition uses the classified phrase page. The set template
    // applies only when several Concept conditions are combined.
    const search = async (phrase: string, concept: string) => json<{
      template: string; result: { results: { work: string }[] };
    }>(await call('POST', '/v1/query', { context: 'global', scope: { kind: 'all' }, text: { phrase },
      filter: { all: [{ facet: 'concept', any: [concept] }] }, sort: 'relevance', page: { size: 20 } },
    randomUUID(), false));
    const animeHits = await search(animeToken, animeFacts.concept!);
    const mangaHits = await search(mangaToken, mangaFacts.concept!);
    expect(animeHits.template).toBe('public-main-classified-phrase-page-v1');
    expect(mangaHits.template).toBe('public-main-classified-phrase-page-v1');
    expect(animeHits.result.results.map((row) => row.work)).toContain(anime.work);
    expect(mangaHits.result.results.map((row) => row.work)).toContain(manga.work);
    expect(animeHits.result.results.map((row) => row.work)).not.toContain(manga.work);
    const statements = async (work: string) => json<{ groups: { predicate: string;
      items: { value: { lexical?: string } }[] }[] }>(
      await call('GET', `/v1/resources/${work.slice(-36)}/statements`, undefined, randomUUID(), false));
    const animePage = await statements(anime.work);
    const mangaPage = await statements(manga.work);
    const lexical = (page: Awaited<ReturnType<typeof statements>>, predicate: string) =>
      page.groups.find((group) => group.predicate === predicate)?.items.map((item) => item.value.lexical);
    expect(lexical(animePage, animeFacts.countPredicate!)).toEqual(['1155']);
    expect(lexical(mangaPage, mangaFacts.countPredicate!)).toEqual(['21']);
    const metadata = await json<{ completionStatus: string | null }>(await call('GET',
      `/v1/works/${manga.work.slice(-36)}/metadata?actingSubject=${encodeURIComponent(home.author.actor)}`));
    expect(metadata.completionStatus).toBe('completed');
  } finally {
    await home.stop();
  }
}, 300_000);
