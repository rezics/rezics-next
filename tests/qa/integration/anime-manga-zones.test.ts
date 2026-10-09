import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { importBangumiWorkFacts, type BangumiFactsClient } from '../../../scripts/datasets/bangumi.ts';
import { animeMangaSamplePlan, importOneShotFacts, type CatalogueSample, type CatalogueZoneId }
  from '../../../scripts/dev/seed/anime-manga-zones-step.ts';
import { startMediaStack } from './media-support.ts';

const PAGE = 20;

interface Recorded {
  key: string;
  zone: CatalogueZoneId;
  work: string;
  concept: string | null;
  year: number | null;
  status: string | null;
  countLexical: string | null;
  countPredicate: string | null;
}
interface BrowsePage {
  items: { id: string }[];
  nextCursor: string | null;
  matches: { value: number; kind: string };
  tags: string;
}

// The publication-year template is read by the browser journey. Folding a date takes the
// claim-fold fence, and this stack's assembler does not serve the raw update that would release it.
test('Anime and manga Zones: format and status filters page, and an unclassified Work stays out of a format it was not given', async () => {
  const stack = await startMediaStack('anime-manga-zones');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const author = await stack.member('catalogue-editor');
    for (const [scope, action] of [
      ['classification:define:global', 'classification.proposition.define'],
      ['semantic:create:root', 'semantic.change'],
      ['context:create:root', 'context.create'],
      [`statement:speak:${author.actor}`, 'statement.record'],
      ['classification:decide:global', 'statement.decide'],
    ] as const) await author.grant(scope, action);
    const accepted = async <T>(response: Response, path: string): Promise<T> => {
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${path}: ${text.slice(0, 500)}`);
      return JSON.parse(text) as T;
    };
    const client: BangumiFactsClient = {
      post: async (path, body, key) => accepted(await author.send('POST', path, body, key), path),
      put: async (path, body, key) => accepted(await author.send('PUT', path, body, key), path),
      authorizeDefinition: async receipt => {
        await author.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      },
    };
    const realms = {} as Record<CatalogueZoneId, string>;
    for (const id of ['anime', 'manga'] as const) {
      const input = { name: id === 'anime' ? 'Anime' : 'Manga', actingSubject: author.actor };
      const space = await createRealmSpace(stack.env, stack.admission(author.actor, 'space:create:root', 'space.create',
        spaceCreationDigest(input)), input);
      if (space.outcome !== 'succeeded' || !space.realm) throw new Error(`${id} Realm was not created`);
      realms[id] = space.realm;
    }
    const recorded: Recorded[] = [];
    for (const sample of animeMangaSamplePlan()) {
      const created = await stack.catalogueWork(author.actor, sample.title);
      await author.grant(`work:edit:${created.work}`, 'work.edit');
      const text = await stack.contribution(created.work, author.actor, sample.language, sample.title);
      const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
        work: created.work, contribution: text.contribution, publicationDecision: text.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
      if ((await selectMainDefault(stack.env, stack.admission(author.actor, `publication:select:${created.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection)).outcome !== 'succeeded') {
        throw new Error(`Main selection failed for ${sample.key}`);
      }
      const imported = await importSample(client, author.actor, created, sample);
      const adoption = { ...selection, mainVersion: created.mainVersion,
        context: { kind: 'realm-local' as const, id: realms[sample.zone] },
        selectionBasis: 'realm-manager-review' as const };
      if ((await selectRealmLocal(stack.env, stack.admission(author.actor, `publication:adopt:${realms[sample.zone]}`,
        'publication.adopt', realmSelectionDigest(adoption)), adoption)).outcome !== 'succeeded') {
        throw new Error(`Adoption failed for ${sample.key}`);
      }
      recorded.push({ key: sample.key, zone: sample.zone, work: created.work, year: sample.year, ...imported });
    }
    await stack.statementSeek.rebuild();
    const statements = async (work: string) => {
      const response = await stack.main.handle(new Request(`http://main.local/v1/resources/${work.slice(-36)}/statements`));
      const body = await response.json() as { groups: { predicate: string; items: { value: { lexical?: string } }[] }[] };
      if (response.status !== 200) throw new Error(`Statements ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
      return body;
    };
    const lexical = (page: Awaited<ReturnType<typeof statements>>, predicate: string | null) =>
      predicate ? page.groups.find(group => group.predicate === predicate)?.items.map(item => item.value.lexical) ?? [] : [];
    const row = (key: string) => recorded.find(item => item.key === key)!;
    expect(lexical(await statements(row('long-tv').work), row('long-tv').countPredicate)).toEqual(['1155']);
    expect(lexical(await statements(row('long-manga').work), row('long-manga').countPredicate)).toEqual(['21']);
    expect(lexical(await statements(row('anime-unclassified').work), row('long-tv').countPredicate)).toEqual([]);
    expect(lexical(await statements(row('one-shot').work), row('one-shot').countPredicate)).toEqual(['1']);

    const projection = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
    await projection.backfill();
    const concepts = new Map(recorded.flatMap(item => item.concept ? [[item.work, item.concept]] : []));
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, zoneBrowse: projection,
      discovery: { active: async () => ({ stale: false }),
        workTerms: async (_active: unknown, ids: string[]) => ids.flatMap(work => {
          const concept = concepts.get(work);
          return concept ? [{ work, concept }] : [];
        }) } as never,
      account: { verify: async () => { throw new Error('Public browse requested authority'); } } });
    const read = async (realm: string, params: URLSearchParams): Promise<BrowsePage> => {
      const response = await app.handle(new Request(
        `http://main.local/v1/realms/${realm.slice(-36)}/modules/browse?${params}`));
      const body = await response.text();
      if (response.status !== 200) throw new Error(`Browse ${response.status}: ${body.slice(0, 400)}`);
      return JSON.parse(body) as BrowsePage;
    };
    const collect = async (realm: string, filter: Record<string, string>) => {
      const params = new URLSearchParams(filter);
      const seen: string[] = [];
      let first: BrowsePage | null = null;
      for (let page = 0; page < 8; page++) {
        const result = await read(realm, params);
        if (!first) first = result;
        seen.push(...result.items.map(item => item.id));
        if (!result.nextCursor) break;
        params.set('cursor', result.nextCursor);
      }
      return { seen, first: first! };
    };
    const ids = (zone: CatalogueZoneId, predicate: (item: Recorded) => boolean) =>
      recorded.filter(item => item.zone === zone && predicate(item)).map(item => item.work).sort();
    const same = (actual: string[], expected: string[]) => {
      expect(actual.slice().sort()).toEqual(expected);
    };
    const tv = await collect(realms.anime, { concept: row('long-tv').concept! });
    expect(tv.first.items).toHaveLength(PAGE);
    expect(tv.first.nextCursor).not.toBeNull();
    expect(tv.first.tags).toBe('current');
    same(tv.seen, ids('anime', item => item.concept === row('long-tv').concept));
    expect(tv.seen).not.toContain(row('anime-unclassified').work);
    expect(tv.seen).toContain(row('tv-3').work);
    same((await collect(realms.anime, {})).seen, ids('anime', () => true));
    same((await collect(realms.anime, { status: 'upcoming' })).seen, ids('anime', item => item.status === 'upcoming'));
    same((await collect(realms.anime, { status: 'cancelled' })).seen, ids('anime', item => item.status === 'cancelled'));
    for (const key of ['movie', 'ova', 'ona', 'special'] as const) {
      same((await collect(realms.anime, { concept: row(key).concept! })).seen,
        ids('anime', item => item.concept === row(key).concept));
    }
    const manga = await collect(realms.manga, { concept: row('long-manga').concept! });
    expect(manga.first.items).toHaveLength(PAGE);
    expect(manga.first.nextCursor).not.toBeNull();
    same(manga.seen, ids('manga', item => item.concept === row('long-manga').concept));
    expect(manga.seen).not.toContain(row('manga-unclassified').work);
    expect(manga.seen).not.toContain(row('one-shot').work);
    expect(manga.seen).toContain(row('manga-3').work);
    same((await collect(realms.manga, { concept: row('one-shot').concept! })).seen,
      ids('manga', item => item.concept === row('one-shot').concept));
    same((await collect(realms.manga, {})).seen, ids('manga', () => true));
    expect((await collect(realms.manga, { status: 'cancelled' })).seen).toContain(row('manga-2').work);
    expect((await collect(realms.manga, { status: 'upcoming' })).seen).toEqual(expect.arrayContaining([
      row('manga-1').work, row('one-shot-en').work,
    ]));
  } finally {
    await relay.end();
    await stack.stop();
  }
}, 600_000);

async function importSample(client: BangumiFactsClient, actor: string,
  work: { work: string; mainVersion: string }, sample: CatalogueSample):
  Promise<Pick<Recorded, 'concept' | 'status' | 'countLexical' | 'countPredicate'>> {
  if (sample.subject.kind === 'one-shot') {
    const imported = await importOneShotFacts(client, actor, work, sample.subject);
    return { concept: imported.concept, status: sample.subject.status, countLexical: sample.subject.volumes === null
      ? null : String(sample.subject.volumes), countPredicate: imported.countPredicate };
  }
  const imported = await importBangumiWorkFacts(client, actor, work, sample.subject.source);
  return { concept: imported.concept, status: imported.facts.status, countLexical: imported.facts.count?.lexical ?? null,
    countPredicate: imported.countPredicate };
}
