import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import type { readSeriesProgress } from '../../../services/main/src/modules/session/series-read.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { seedFirstPublicationDate } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { animeMangaSamplePlan } from '../../../scripts/dev/seed/anime-manga-zones-step.ts';
import { importBangumiWorkFacts } from '../../../scripts/datasets/bangumi.ts';
import { call as catalogueCall, createCatalogueWork, publishCatalogueText, type SeedPort }
  from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (resource: string) => resource.slice(-36);
const DATE_PUBLISHED = 'https://schema.org/datePublished';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

type Edition = { kind: 'realization' | 'release'; resource: string; revision: string };
type Preference = { work: string; language: string; edition: Edition; version: number };
type StatementPage = { groups: Array<{ predicate: string; items: Array<{
  kind: string; value?: { kind: string; lexical?: string; datatype?: string };
}> }> };
type Work = { work: string; mainVersion: string; title: string; concept: string };
type Realization = { realization: string; revision: string };
type Release = { release: string; revision: string; title: string };
type Summary = Awaited<ReturnType<typeof readSeriesProgress>>;

const persistedPreference = ({ work, language, edition, version }: Preference): Preference =>
  ({ work, language, edition, version });

async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function write<T>(call: (method: string, path: string, body?: object, key?: string,
  token?: string) => Promise<Response>, path: string, body: object, key = randomUUID()): Promise<T> {
  const response = await call('POST', path, body, key);
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`${path} ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

test('anime and manga hubs show recorded and missing publication dates, name chosen releases per reader, and settle concurrent replayed saves', async () => {
  const stack = await startMediaStack('anime-manga-hub', { profileCredits: true });
  try {
    const a = await stack.member('anime-manga-reader');
    const b = await stack.member('anime-manga-other-reader');
    const person = (await json<{ agent: string }>(await a.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Anime manga reader',
    }), 201)).agent;
    const other = (await json<{ agent: string }>(await b.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Other anime manga reader',
    }), 201)).agent;
    await ensureGlobalClassificationContext(stack.env);
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const preferences = new EditionPreferenceStore(stack.contentPool);
    const structureObjects = stack.objects('semantic/structure/');
    await structureObjects.initialize();
    const app = createMainApp(stack.fuseki, {
      environment: stack.env,
      access: stack.access,
      libraryStatus: library,
      sessions: new ConsumptionSessionStore(stack.contentPool, library),
      editionPreferences: preferences,
      seriesSessions: new SeriesSessionReader(stack.contentPool),
      structureObjects,
      media: stack.media,
      mediaAccess: stack.mediaAccess,
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [a, b].find(candidate => candidate.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        const verified = { ...member.principal, emailVerified: true as const };
        return { ...verified, currentAssertion: async () => verified };
      } },
    });
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = a.token) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const mainCall = (method: string, path: string, body?: unknown, key = randomUUID()) =>
      a.send(method, path, body, key);
    const grant = async (scope: string, action: string, actor: string, principalId = a.principalId) => {
      const client = await stack.accessPool.connect();
      try {
        await client.query('BEGIN');
        await grantFixtureAuthority(client, { scope, requireDispatch: true,
          representations: [{ principalId, actor, action, lifetime: '8 hours' }],
          grant: { actor, action, lifetime: '8 hours' } });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };
    await grant('work:create:root', 'work.create', person);
    await grant('catalogue:verify:root', 'catalogue.verify', person);
    await grant('classification:define:global', 'classification.proposition.define', person);
    await grant('semantic:create:root', 'semantic.change', person);
    await grant('context:create:root', 'context.create', person);
    await grant(`statement:speak:${person}`, 'statement.record', person);
    await grant('classification:decide:global', 'statement.decide', person);
    const port: SeedPort = {
      actingSubject: person,
      request: async (method, path, body, key) => {
        const response = await mainCall(method, path, body, key);
        return { status: response.status, body: await response.json() };
      },
      grant: (scope, action) => grant(scope, action, person),
    };
    const seedClient = {
      post: <T>(path: string, body: object, key: string): Promise<T> => catalogueCall<T>(port, 'POST', path, body, key),
      put: <T>(path: string, body: object, key: string): Promise<T> => catalogueCall<T>(port, 'PUT', path, body, key),
      authorizeDefinition: async (definition: { component: string }) => {
        await grant(`semantic:read:${definition.component}`, 'semantic.read', person);
      },
      currentDefinition: async (key: string) => {
        const response = await mainCall('GET', `/v1/lexicon/definitions/${key}?actingSubject=${encodeURIComponent(person)}`);
        if (response.status === 404) return null;
        const current = await json<{ kind: string; definition: string; revision: string; lifecycle: string;
          roles: unknown[] }>(response);
        if (current.kind !== 'property' || current.lifecycle !== 'active' || current.roles.length !== 0) return null;
        return { component: current.definition, revision: current.revision,
          state: { component: 'definition' as const, kind: 'property' as const, lifecycle: 'active' as const,
            successor: null, roles: [], notation: key } };
      },
    };
    const firstPublication = await seedFirstPublicationDate(seedClient, person);

    const samples = animeMangaSamplePlan();
    const createWork = async (key: string): Promise<Work> => {
      const sample = samples.find(item => item.key === key);
      if (!sample || sample.subject.kind !== 'bangumi') throw new Error(`Missing classified catalogue sample ${key}`);
      const created = await createCatalogueWork(port, { key: `anime-manga-hub:${key}`, title: sample.title,
        language: sample.language, semanticType: 'https://schema.org/Book' });
      await grant(`work:edit:${created.work}`, 'work.edit', person);
      await grant(`work:read:${created.work}`, 'work.read', person);
      await grant(`work:read:${created.work}`, 'work.read', other, b.principalId);
      await grant(`contribution:create:${created.work}`, 'contribution.create', person);
      await grant(`publication:select:${created.mainVersion}`, 'publication.select', person);
      await publishCatalogueText(port, created, `anime-manga-hub:${key}`, sample.language, sample.title);
      const imported = await importBangumiWorkFacts(seedClient, person, created, sample.subject.source);
      expect(imported.facts.format).toBe(sample.zone === 'anime' ? 'tv' : 'manga');
      if (!imported.concept) throw new Error(`Catalogue sample ${key} has no media classification`);
      return { work: created.work, mainVersion: created.mainVersion, title: sample.title, concept: imported.concept };
    };
    const anime = await createWork('long-tv');
    const animeWithoutDate = await createWork('tv-3');
    const manga = await createWork('long-manga');
    const mangaWithoutDate = await createWork('manga-3');
    for (const [work, name] of [[anime, 'TV'], [animeWithoutDate, 'TV'], [manga, 'Manga'],
      [mangaWithoutDate, 'Manga']] as const) {
      const classified = await json<{ items: Array<{ concept: string; name: { value: string }; source: string }> }>(
        await mainCall('GET', `/v1/works/${short(work.work)}/classifications?language=en&actingSubject=${encodeURIComponent(person)}`));
      expect(classified.items).toContainEqual(expect.objectContaining({
        concept: work.concept, name: expect.objectContaining({ value: name }), source: 'global',
        decision: expect.any(String),
      }));
    }

    const recordDate = async (work: Work, lexical: string) => {
      const statement = await write<{ statement: string }>(mainCall, '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work,
        predicate: firstPublication.component, relationDefinition: firstPublication.revision,
        value: { kind: 'literal', lexical, datatype: `${XSD}date`, language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: person,
      });
      await write(mainCall, '/v1/statement-decisions', {
        profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
        acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: person,
      });
    };
    await recordDate(anime, '1980-04-01');
    await recordDate(manga, '1995-07-12');
    while (await stack.statementSeek.projectOnce()) { /* catch up both date and decision writes */ }

    const publicationDates = async (work: Work) => {
      const page = await json<StatementPage>(await a.read(`/v1/resources/${short(work.work)}/statements`));
      return page.groups.flatMap(group => group.predicate === DATE_PUBLISHED ? group.items : [])
        .filter(item => item.kind === 'statement' && item.value?.kind === 'literal')
        .map(item => item.value!.lexical);
    };
    expect(await publicationDates(anime)).toEqual(['1980-04-01']);
    expect(await publicationDates(manga)).toEqual(['1995-07-12']);
    expect(await publicationDates(animeWithoutDate)).toEqual([]);
    expect(await publicationDates(mangaWithoutDate)).toEqual([]);

    const realize = async (work: Work, language: string): Promise<Realization> => {
      const realization = id();
      const saved = await json<{ revision: string }>(await mainCall('PUT',
        `/v1/works/${short(work.work)}/realizations/${short(realization)}`, {
          profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: person,
          language, kind: 'original', translators: [], publishers: [],
          source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: id(),
        }));
      return { realization, revision: saved.revision };
    };
    const animeText = await realize(anime, 'ja');
    const mangaText = await realize(manga, 'ja');
    const release = async (work: Work, text: Realization, title: string, publicationYear: number,
      platform: string): Promise<Release> => {
      const releaseId = id();
      const saved = await json<{ revision: string }>(await mainCall('PUT',
        `/v1/works/${short(work.work)}/releases/${short(releaseId)}`, {
          profile: 'release-v2', id: releaseId, expectedHead: null, actingSubject: person,
          kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
          title: { value: title, language: 'en' }, editionStatement: null, publisher: 'REZICS Catalogue',
          publicationYear, isbn13: null, originalUrl: null, fixedRelease: null,
          identifiers: [], platform, territory: null,
          coverage: [{ realization: text.realization, revision: text.revision, completeness: 'complete' }],
          evidence: null,
        }));
      return { release: releaseId, revision: saved.revision, title };
    };
    const firstAnimeRelease = await release(anime, animeText, 'Sky Lantern television broadcast', 1980, 'Broadcast');
    const secondAnimeRelease = await release(anime, animeText, 'Sky Lantern remastered Blu-ray', 2024, 'Blu-ray');
    const firstMangaEdition = await release(manga, mangaText, 'River of Ink tankōbon', 2018, 'Tankōbon');
    const secondMangaEdition = await release(manga, mangaText, 'River of Ink omnibus', 2024, 'Omnibus');

    const preferencePath = (work: Work) => `/v1/me/edition-preferences/${short(work.work)}`;
    const readPreference = (work: Work, actor: string, token: string) => call('GET',
      `${preferencePath(work)}?actingSubject=${encodeURIComponent(actor)}`, undefined, randomUUID(), token);
    const summary = (work: Work, actor: string, token: string) => call('GET',
      `/v1/me/progress-summaries/${short(work.work)}?language=ja&actingSubject=${encodeURIComponent(actor)}`,
      undefined, randomUUID(), token);
    for (const { work, releases } of [
      { work: anime, releases: [firstAnimeRelease, secondAnimeRelease] },
      { work: manga, releases: [firstMangaEdition, secondMangaEdition] },
    ]) {
      await write(call, '/v1/compositions', {
        profile: 'work-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: person,
      });
      expect(await json<Summary>(await summary(work, person, a.token)))
        .toMatchObject({ resource: work.work, preference: null, language: 'ja' });
      expect(releases[0]!.release).not.toBe(releases[1]!.release);
      const choices = releases.map(item => ({
        key: randomUUID(), body: { actingSubject: person, expectedVersion: 0, language: 'ja',
          edition: { kind: 'release' as const, resource: item.release, revision: item.revision } },
        item,
      }));
      const raced = await Promise.all(choices.map(choice => call('PUT', preferencePath(work), choice.body, choice.key)));
      expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
      const winnerIndex = raced.findIndex(response => response.status === 200);
      const winnerChoice = choices[winnerIndex]!;
      const saved = await json<Preference & { replayed: boolean }>(raced[winnerIndex]!);
      expect(saved).toMatchObject({ work: work.work, version: 1, language: 'ja',
        edition: winnerChoice.body.edition, replayed: false });
      const stale = await json<{ code: string; current: Preference }>(raced[1 - winnerIndex]!, 409);
      expect(stale).toMatchObject({ code: 'stale_edition_preference', current: persistedPreference(saved) });
      expect(await json<Preference>(await readPreference(work, person, a.token)))
        .toEqual(persistedPreference(saved));
      expect(await json(await call('PUT', preferencePath(work), winnerChoice.body, winnerChoice.key)))
        .toEqual({ ...saved, replayed: true });
      const hub = await json<Summary>(await summary(work, person, a.token));
      expect(hub).toMatchObject({ resource: work.work, preference: persistedPreference(saved), language: 'ja' });
      const selected = hub.preference!.edition!;
      expect(selected).toEqual(winnerChoice.body.edition);
      const namedRelease = await json<{ id: string; revision: string; title: { value: string } }>(await mainCall('GET',
        `/v1/works/${short(work.work)}/releases/${short(selected.resource)}?actingSubject=${encodeURIComponent(person)}`));
      expect(namedRelease).toMatchObject({ id: selected.resource, revision: selected.revision,
        title: { value: winnerChoice.item.title } });
      expect(await json(await readPreference(work, other, b.token))).toBeNull();
      expect(await json<Summary>(await summary(work, other, b.token)))
        .toMatchObject({ resource: work.work, preference: null, language: 'ja' });
    }
  } finally { await stack.stop(); }
}, 600_000);
