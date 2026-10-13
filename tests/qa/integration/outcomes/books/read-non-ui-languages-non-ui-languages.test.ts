import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import reading from '../../../../../scripts/qa/cases/outcomes/books/read-non-ui-languages-non-ui-languages.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
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
const recording = new OutcomeRecorder(reading);
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
  await recording.prepare();
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
  try { await recording.publish(); } finally { await sessions?.close(); }
});

async function read(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  for (const language of ['en', 'sv']) {
    const metadata = await answer<{ localized: { language: string; title: string }[] }>(
      sample(`metadata-${language}`, 'GET', `/v1/works/${short(published.work)}/metadata?${query(person, language)}`),
    );
    expect(metadata.localized).toContainEqual(expect.objectContaining({ language: 'sv', title }));
    const text = await answer<{ body: string; language: string; contribution: string }>(
      sample(`selected-text-${language}`, 'GET', `/v1/main-versions/${short(published.mainVersion)}/selection`),
    );
    expect(text).toMatchObject({ body, language: 'sv', contribution });
    const variants = await answer<{
      variants: { contribution: string; author: string; language: string }[];
    }>(
      sample(
        `native-variants-${language}`, 'GET',
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
      sample(`credits-${language}`, 'GET', `/v1/works/${short(published.work)}/credits?${query(person, language)}`),
    );
    // Native credit identity is retained independently of nullable name presentation.
    expect(credits.items).toContainEqual(
      expect.objectContaining({
        role: 'author',
        agent: sessions.owner.actingSubject,
      }),
    );
  }
  if (name === 'member') {
    const viewer = person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    await answer(sample('work-header', 'GET', `/v1/works/${short(published.work)}?${viewer}`));
    await answer(sample('selected-swedish-text', 'GET', `/v1/main-versions/${short(published.mainVersion)}/selection?language=sv`));
    await answer(sample('missing-selected-language', 'GET', `/v1/main-versions/${short(published.mainVersion)}/selection?language=ja`), 404);
    await answer(sample('text-suitability', 'POST', '/v1/suitability/reads', {
      targets: [published.work], actingSubject: person.actingSubject,
    }));
    const publicSample = recording.session(name, sessions.visitor);
    await answer(publicSample('public-preview', 'GET', `/v1/public-previews/${short(published.work)}`));
    await answer(publicSample('public-work-header', 'GET', `/v1/works/${short(published.work)}`));
  }
  if (name === 'owner')
    await answer(sample('unselected-text', 'GET', `/v1/main-versions/${short(privateWork.mainVersion)}/selection`), 404);
  const privatePath = `/v1/works/${short(privateWork.work)}/metadata?${query(person)}`;
  if (name === 'owner') {
    expect(await answer(sample('private-metadata', 'GET', privatePath))).toMatchObject({ work: privateWork.work });
  } else {
    const hidden = await answer(sample('private-metadata', 'GET', privatePath), 404);
    const absent = await answer(
      sample('missing-metadata', 'GET', `/v1/works/${randomUUID()}/metadata?${query(person)}`),
      404,
    );
    expect(hidden).toEqual(absent);
  }

  const caller = person.actingSubject
    ? `?${new URLSearchParams({ actingSubject: person.actingSubject })}` : '';
  const header = await answer<{ selectedLanguage?: string | null }>(
    sample('reading-page-header', 'GET', `/v1/works/${short(published.work)}${caller}`),
  );
  // readText retains the caller's session but sends only the header's selected language.
  const selectedLanguage = header.selectedLanguage
    ? `?${new URLSearchParams({ language: header.selectedLanguage })}` : '';
  await answer(sample('reading-page-selection', 'GET',
    `/v1/main-versions/${short(published.mainVersion)}/selection${selectedLanguage}`));

  const privateHeader = await answer<{ selectedLanguage?: string | null }>(
    sample('private-reading-page-header', 'GET', `/v1/works/${short(privateWork.work)}${caller}`),
    name === 'owner' ? 200 : 404,
  );
  if (name === 'owner') {
    const privateLanguage = privateHeader.selectedLanguage
      ? `?${new URLSearchParams({ language: privateHeader.selectedLanguage })}` : '';
    await answer(sample('private-reading-page-selection', 'GET',
      `/v1/main-versions/${short(privateWork.mainVersion)}/selection${privateLanguage}`), 404);
  }
  if (name === 'visitor' || name === 'member')
    await answer(sample('credits-zh-Hant', 'GET',
      `/v1/works/${short(published.work)}/credits?${query(person, 'zh-Hant')}`));
  if (person.actingSubject)
    await answer(sample('reader-settings', 'GET', `/v1/reader/settings${caller}`));
}

outcomeTest(reading, 'visitor', () => read('visitor'), recording);
outcomeTest(reading, 'stranger', () => read('stranger'), recording);
outcomeTest(reading, 'member', () => read('member'), recording);
outcomeTest(reading, 'owner', () => read('owner'), recording);
outcomeTest(reading, 'moderator', () => read('moderator'), recording);
outcomeTest(reading, 'operator', () => read('operator'), recording);
