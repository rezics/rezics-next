import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { seedFirstPublicationDate } from '../../../scripts/dev/seed/relation-lexicon.ts';
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
type Work = { work: string; mainVersion: string; title: string };
type Realization = { realization: string; revision: string };
type Release = { release: string; revision: string; title: string };

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

test('anime and manga hubs show recorded publication dates and keep edition choices per reader', async () => {
  const stack = await startMediaStack('anime-manga-hub', { profileCredits: true });
  try {
    const a = await stack.member('anime-manga-reader');
    const b = await stack.member('anime-manga-other-reader');
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
      structureObjects,
      media: stack.media,
      mediaAccess: stack.mediaAccess,
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [a, b].find(candidate => candidate.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        return { ...member.principal, emailVerified: true };
      } },
    });
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = a.token) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const mainCall = (method: string, path: string, body?: object, key = randomUUID()) =>
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
    const person = a.actor;
    const other = b.actor;

    await grant('work:create:root', 'work.create', person);
    await grant('semantic:create:root', 'semantic.change', person);
    await grant(`statement:speak:${person}`, 'statement.record', person);
    await grant('classification:decide:global', 'statement.decide', person);
    const seedClient = {
      post: async <T>(path: string, body: object, key: string): Promise<T> => {
        const response = await mainCall('POST', path, body, key);
        if (response.status !== 200 && response.status !== 201) {
          throw new Error(`${response.status}: ${await response.text()}`);
        }
        return response.json() as Promise<T>;
      },
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

    const createWork = async (title: string): Promise<Work> => {
      const created = await stack.publicWork(person, ['ja'], title);
      await grant(`work:edit:${created.work}`, 'work.edit', person);
      await grant(`work:read:${created.work}`, 'work.read', person);
      await grant(`work:read:${created.work}`, 'work.read', other, b.principalId);
      return { work: created.work, mainVersion: created.mainVersion, title };
    };
    const anime = await createWork('Sky Lantern anime');
    const animeWithoutDate = await createWork('Untitled anime record');
    const manga = await createWork('River of Ink manga');
    const mangaWithoutDate = await createWork('Untitled manga record');

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
          language, kind: 'translation', translators: [person], publishers: [],
          source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: id(),
        }));
      return { realization, revision: saved.revision };
    };
    const firstAnimeEdition = await realize(anime, 'ja');
    const chosenAnimeEdition = await realize(anime, 'en');
    const mangaText = await realize(manga, 'ja');
    const release = async (title: string, publicationYear: number): Promise<Release> => {
      const releaseId = id();
      const saved = await json<{ revision: string }>(await mainCall('PUT',
        `/v1/works/${short(manga.work)}/releases/${short(releaseId)}`, {
          profile: 'release-v2', id: releaseId, expectedHead: null, actingSubject: person,
          kind: 'formal', status: 'official', titleLanguage: 'ja', tracklistLanguage: null,
          title: { value: title, language: 'ja' }, editionStatement: null, publisher: 'River House',
          publicationYear, isbn13: null, originalUrl: null, fixedRelease: null,
          identifiers: [], platform: null, territory: null,
          coverage: [{ realization: mangaText.realization, revision: mangaText.revision, completeness: 'complete' }],
          evidence: null,
        }));
      return { release: releaseId, revision: saved.revision, title };
    };
    const firstMangaEdition = await release('River of Ink tankōbon', 2018);
    const secondMangaEdition = await release('River of Ink omnibus', 2024);

    const preferencePath = (work: Work) => `/v1/me/edition-preferences/${short(work.work)}`;
    const readPreference = (work: Work, actor: string, token: string) => call('GET',
      `${preferencePath(work)}?actingSubject=${encodeURIComponent(actor)}`, undefined, randomUUID(), token);
    const chosenAnime = { actingSubject: person, expectedVersion: 0, language: 'en',
      edition: { kind: 'realization' as const, resource: chosenAnimeEdition.realization, revision: chosenAnimeEdition.revision } };
    const chosenAnimeKey = randomUUID();
    const animeSaved = await json<Preference & { replayed: boolean }>(await call('PUT', preferencePath(anime),
      chosenAnime, chosenAnimeKey));
    expect(animeSaved).toMatchObject({ work: anime.work, version: 1, language: 'en', edition: chosenAnime.edition,
      replayed: false });
    expect(await json<Preference>(await readPreference(anime, person, a.token))).toMatchObject(animeSaved);
    expect(await json(await call('PUT', preferencePath(anime), chosenAnime, chosenAnimeKey)))
      .toMatchObject({ ...animeSaved, replayed: true });
    const animeEditionPage = await json<{ items: Array<{ id: string; revision: string; language: string }> }>(
      await mainCall('GET', `/v1/works/${short(anime.work)}/realizations`));
    expect(animeEditionPage.items).toContainEqual(expect.objectContaining({
      id: chosenAnime.edition.resource, revision: chosenAnime.edition.revision, language: 'en',
    }));
    expect(await json(await readPreference(anime, other, b.token))).toBeNull();
    expect(firstAnimeEdition.realization).not.toBe(chosenAnime.edition.resource);

    const choices = [firstMangaEdition, secondMangaEdition].map((item, index) => ({
      key: randomUUID(), body: { actingSubject: person, expectedVersion: 0, language: 'ja',
        edition: { kind: 'release' as const, resource: item.release, revision: item.revision } },
      item,
      index,
    }));
    const raced = await Promise.all(choices.map(choice => call('PUT', preferencePath(manga), choice.body, choice.key)));
    expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = raced.findIndex(response => response.status === 200);
    const winnerChoice = choices[winnerIndex]!;
    const savedManga = await json<Preference & { replayed: boolean }>(raced[winnerIndex]!);
    expect(savedManga).toMatchObject({ work: manga.work, version: 1, language: 'ja',
      edition: winnerChoice.body.edition, replayed: false });
    const stale = await json<{ current: Preference }>(raced[1 - winnerIndex]!);
    expect(stale.current).toMatchObject(savedManga);
    expect(await json<Preference>(await readPreference(manga, person, a.token))).toMatchObject(savedManga);
    expect(await json(await call('PUT', preferencePath(manga), winnerChoice.body, winnerChoice.key)))
      .toMatchObject({ ...savedManga, replayed: true });
    const mangaRelease = await json<{ id: string; revision: string; title: { value: string } }>(await mainCall('GET',
      `/v1/works/${short(manga.work)}/releases/${short(winnerChoice.item.release)}`));
    expect(mangaRelease).toMatchObject({ id: winnerChoice.item.release, revision: winnerChoice.item.revision,
      title: { value: winnerChoice.item.title } });
    expect(await json(await readPreference(manga, other, b.token))).toBeNull();
    expect(firstMangaEdition.release).not.toBe(secondMangaEdition.release);
  } finally { await stack.stop(); }
}, 600_000);
