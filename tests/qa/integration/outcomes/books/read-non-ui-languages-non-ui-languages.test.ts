import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import reading from '../../../../../scripts/qa/cases/outcomes/books/read-non-ui-languages-non-ui-languages.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let published: Work;
let privateWork: Work;
let contribution: string;
const title = `Den lilla fröträdgården ${randomUUID()}`;
const body =
  'På morgonen planterade Mira ett frö. När regnet kom öppnade hon grinden och lät trädgården dricka.';
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession, language = 'en') =>
  new URLSearchParams({
    language,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

beforeAll(async () => {
  sessions = await personaSessions();
  const owner = sessions.owner;
  const create = (name: string) =>
    answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title: name,
        language: 'sv',
        semanticTypes: ['https://schema.org/Book'],
        authoring: 'own-work',
        actingSubject: owner.actingSubject,
      }),
      201,
    );
  published = await create(title);
  privateWork = await create('En opublicerad fröträdgård');
  await answer(
    owner.main('PUT', `/v1/works/${short(published.work)}/metadata`, {
      profile: 'work-metadata-details-v1',
      expectedHead: null,
      actingSubject: owner.actingSubject,
      state: {
        kind: 'header',
        originalTitle: { value: title, language: 'sv' },
        localized: [
          {
            language: 'sv',
            title,
            description: 'En egen berättelse om Mira och hennes fröträdgård.',
            mainVersionLabel: null,
          },
        ],
      },
    }),
  );
  const draft = await answer<{
    contribution: string;
    draftRevision: string;
    author: string;
    language: string;
  }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: published.work,
      language: 'sv',
      body,
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  expect(draft).toMatchObject({ author: owner.actingSubject, language: 'sv' });
  contribution = draft.contribution;
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution,
      expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  await answer(
    owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: published.mainVersion },
      work: published.work,
      contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
}, 180_000);
afterAll(async () => {
  await sessions?.close();
});

async function read(name: PersonaName) {
  const person = sessions[name];
  for (const language of ['en', 'sv']) {
    const metadata = await answer<{ localized: { language: string; title: string }[] }>(
      person.main('GET', `/v1/works/${short(published.work)}/metadata?${query(person, language)}`),
    );
    expect(metadata.localized).toContainEqual(expect.objectContaining({ language: 'sv', title }));
    const text = await answer<{ body: string; language: string; contribution: string }>(
      person.main('GET', `/v1/main-versions/${short(published.mainVersion)}/selection`),
    );
    expect(text).toMatchObject({ body, language: 'sv', contribution });
    const variants = await answer<{
      variants: { contribution: string; author: string; language: string }[];
    }>(
      person.main(
        'GET',
        `/v1/main-versions/${short(published.mainVersion)}/native-variants?language=sv`,
      ),
    );
    expect(variants.variants).toContainEqual(
      expect.objectContaining({
        contribution,
        author: sessions.owner.actingSubject,
        language: 'sv',
      }),
    );
    const credits = await answer<{ items: { role: string; agent: string }[] }>(
      person.main('GET', `/v1/works/${short(published.work)}/credits?${query(person, language)}`),
    );
    // Native credit identity is retained independently of nullable name presentation.
    expect(credits.items).toContainEqual(
      expect.objectContaining({
        role: 'author',
        agent: sessions.owner.actingSubject,
      }),
    );
  }
  const privatePath = `/v1/works/${short(privateWork.work)}/metadata?${query(person)}`;
  if (name === 'owner') {
    expect(await answer(person.main('GET', privatePath))).toMatchObject({ work: privateWork.work });
  } else {
    const hidden = await answer(person.main('GET', privatePath), 404);
    const absent = await answer(
      person.main('GET', `/v1/works/${randomUUID()}/metadata?${query(person)}`),
      404,
    );
    expect(hidden).toEqual(absent);
  }
}

outcomeTest(reading, 'visitor', () => read('visitor'));
outcomeTest(reading, 'stranger', () => read('stranger'));
outcomeTest(reading, 'member', () => read('member'));
outcomeTest(reading, 'owner', () => read('owner'));
outcomeTest(reading, 'moderator', () => read('moderator'));
outcomeTest(reading, 'operator', () => read('operator'));
