import { afterEach, expect, test } from 'bun:test';
import type {
  AnswerPersona,
  AnswerRecord,
  AnswerSample,
} from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/read-non-ui-languages-non-ui-languages.json';
import { mainApiWithToken } from '../api/main.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import {
  fetchBooksLanguageMetadata,
  fetchBooksLanguageSelection,
  fetchMemberBooksLanguage,
  fetchPublishedBooksLanguage,
  type BooksLanguageReading,
} from './books-language-recorded-page.ts';

const record = books as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find((item) => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found;
}

function recordedId(path: string): string {
  const id = new URL(path, 'https://recorded.invalid').pathname.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )?.[0];
  if (!id) throw new Error(`Recorded path has no id: ${path}`);
  return id;
}

function queryOf(path: string): URLSearchParams {
  return new URL(path, 'https://recorded.invalid').searchParams;
}

function client(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections);
  disposals.push(replay.dispose);
  return mainApiWithToken(undefined, { fetcher: replay.fetcher });
}

function textOf(value: unknown): { language: string; body: string; work: string } {
  if (!value || typeof value !== 'object') throw new Error('Recorded selection is empty');
  const text = value as { language?: unknown; body?: unknown; work?: unknown };
  if (
    typeof text.language !== 'string' ||
    typeof text.body !== 'string' ||
    typeof text.work !== 'string'
  ) {
    throw new Error('Recorded selection has no text');
  }
  return { language: text.language, body: text.body, work: text.work };
}

function creditOf(value: unknown): {
  id: string;
  role: string;
  agent: string;
  displayName: string | null;
  handle: string | null;
} {
  if (
    !value ||
    typeof value !== 'object' ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !value.items[0]
  ) {
    throw new Error('Recorded credits have no author');
  }
  const item = value.items[0] as {
    id?: unknown;
    role?: unknown;
    agent?: unknown;
    displayName?: unknown;
    handle?: unknown;
  };
  if (
    typeof item.id !== 'string' ||
    typeof item.role !== 'string' ||
    typeof item.agent !== 'string' ||
    (item.displayName !== null && typeof item.displayName !== 'string') ||
    !(item.handle === null || typeof item.handle === 'string')
  ) {
    throw new Error('Recorded author is incomplete');
  }
  return {
    id: item.id,
    role: item.role,
    agent: item.agent,
    displayName: item.displayName,
    handle: item.handle,
  };
}

function titleOf(value: unknown): { value: string; language: string } {
  if (!value || typeof value !== 'object' || !('originalTitle' in value) || !value.originalTitle) {
    throw new Error('Recorded metadata has no title');
  }
  const title = value.originalTitle as { value?: unknown; language?: unknown };
  if (typeof title.value !== 'string' || typeof title.language !== 'string')
    throw new Error('Recorded title is incomplete');
  return { value: title.value, language: title.language };
}

function problemOf(value: unknown): { title: string; code: string; status: number } {
  if (!value || typeof value !== 'object') throw new Error('Recorded problem is empty');
  const problem = value as { title?: unknown; code?: unknown; status?: unknown };
  if (
    typeof problem.title !== 'string' ||
    typeof problem.code !== 'string' ||
    typeof problem.status !== 'number'
  ) {
    throw new Error('Recorded problem is incomplete');
  }
  return { title: problem.title, code: problem.code, status: problem.status };
}

test('a visitor reads the recorded Swedish text while the presentation language is English', async () => {
  const text = sample('visitor', 'selected-text-en');
  const credits = sample('visitor', 'credits-en');
  const metadata = sample('visitor', 'metadata-en');
  const main = client('visitor', [
    { label: 'metadata-en', state: 'populated' },
    { label: 'selected-text-en', state: 'populated' },
    { label: 'credits-en', state: 'populated' },
  ]);
  const presentation = queryOf(metadata.path).get('language');
  expect(presentation).toBe('en');
  expect(queryOf(text.path).get('language')).toBeNull();
  const [selection, creditPage, details] = await Promise.all([
    main.v1['main-versions']({ mainVersion: recordedId(text.path) }).selection.get({ query: {} }),
    main.v1
      .works({ id: recordedId(metadata.path) })
      .credits.get({ query: { language: presentation! } }),
    main.v1
      .works({ id: recordedId(metadata.path) })
      .metadata.get({ query: { language: presentation! } }),
  ]);
  expect(selection.error).toBeNull();
  expect(selection.data).toEqual(text.answer);
  expect(creditPage.error).toBeNull();
  expect(creditPage.data).toEqual(credits.answer);
  expect(details.error).toBeNull();
  expect(details.data).toEqual(metadata.answer);

  const reading = await fetchPublishedBooksLanguage(main, {
    workId: recordedId(metadata.path),
    mainVersionId: recordedId(text.path),
    presentationLanguage: presentation!,
  });
  const recordedText = textOf(text.answer);
  expect(reading.kind).toBe('reading');
  if (reading.kind !== 'reading') return;
  expect(reading.language).toBe(recordedText.language);
  expect(reading.language).not.toBe(presentation);
  expect(reading.body).toBe(recordedText.body);
  expect(reading.workId).toBe(recordedText.work);
  expect(reading.text).toEqual(text.answer);
  expect(reading.title).toEqual(titleOf(metadata.answer));
  expect(reading.credit).toEqual(creditOf(credits.answer));
  expect(reading.header).toBeNull();
});

test('a Swedish presentation still shows the recorded text language', async () => {
  const text = sample('visitor', 'selected-text-sv');
  const metadata = sample('visitor', 'metadata-sv');
  const credits = sample('visitor', 'credits-sv');
  const main = client('visitor', [
    { label: 'metadata-sv', state: 'populated' },
    { label: 'selected-text-sv', state: 'populated' },
    { label: 'credits-sv', state: 'populated' },
  ]);
  const presentation = queryOf(metadata.path).get('language');
  expect(presentation).toBe('sv');
  const reading = await fetchPublishedBooksLanguage(main, {
    workId: recordedId(metadata.path),
    mainVersionId: recordedId(text.path),
    presentationLanguage: presentation!,
  });
  const recordedText = textOf(text.answer);
  expect(reading.kind).toBe('reading');
  if (reading.kind !== 'reading') return;
  expect(reading.language).toBe(recordedText.language);
  expect(reading.body).toBe(recordedText.body);
  expect(reading.title).toEqual(titleOf(metadata.answer));
  expect(reading.credit).toEqual(creditOf(credits.answer));
});

test('a member reads the text in the language the recorded header selected', async () => {
  const header = sample('member', 'work-header');
  const text = sample('member', 'selected-swedish-text');
  const credits = sample('member', 'credits-en');
  const actingSubject = queryOf(header.path).get('actingSubject');
  const presentation = queryOf(credits.path).get('language');
  expect(actingSubject).toBeString();
  expect(presentation).toBe('en');
  const main = client('member', [
    { label: 'work-header', state: 'populated' },
    { label: 'selected-swedish-text', state: 'populated' },
    { label: 'credits-en', state: 'populated' },
  ]);
  const reply = await main.v1
    .works({ id: recordedId(header.path) })
    .get({ query: { actingSubject: actingSubject! } });
  expect(reply.error).toBeNull();
  expect(reply.data).toEqual(header.answer);
  const reading = await fetchMemberBooksLanguage(main, {
    workId: recordedId(header.path),
    actingSubject: actingSubject!,
    presentationLanguage: presentation!,
  });
  const recordedText = textOf(text.answer);
  const recordedHeader = header.answer as {
    title: { value: string; language: string; direction: 'ltr' | 'rtl' };
  };
  expect(reading.kind).toBe('reading');
  if (reading.kind !== 'reading') return;
  expect(reading.language).toBe(recordedText.language);
  expect(reading.language).not.toBe(presentation);
  expect(reading.body).toBe(recordedText.body);
  expect(reading.text).toEqual(text.answer);
  expect(reading.title).toEqual(recordedHeader.title);
  expect(reading.header).toEqual(header.answer);
  expect(reading.credit).toEqual(creditOf(credits.answer));
});

test('a missing selected language is the recorded refusal', async () => {
  const refused = sample('member', 'missing-selected-language');
  const language = queryOf(refused.path).get('language');
  expect(language).toBeString();
  const main = client('member', [{ label: 'missing-selected-language', state: 'error' }]);
  const reply = await main.v1['main-versions']({
    mainVersion: recordedId(refused.path),
  }).selection.get({
    query: { language: language! },
  });
  expect(reply.data).toBeNull();
  expect(reply.error?.status).toBe(refused.status);
  expect(reply.error?.value).toEqual(refused.answer);
  const reading = await fetchBooksLanguageSelection(main, recordedId(refused.path), language!);
  expect(reading).toEqual({
    kind: 'refused',
    failure: 'missing',
    problem: problemOf(refused.answer),
  });
});

test('a private Work the visitor cannot read refuses with the same problem as a missing Work', async () => {
  const hidden = sample('visitor', 'private-metadata');
  const missing = sample('visitor', 'missing-metadata');
  expect(hidden.answer).toEqual(missing.answer);
  expect(hidden.status).toBe(missing.status);
  const language = queryOf(hidden.path).get('language');
  expect(language).toBeString();
  const main = client('visitor', [{ label: 'private-metadata', state: 'error' }]);
  const reply = await main.v1
    .works({ id: recordedId(hidden.path) })
    .metadata.get({ query: { language: language! } });
  expect(reply.data).toBeNull();
  expect(reply.error?.value).toEqual(hidden.answer);
  const reading = await fetchBooksLanguageMetadata(main, recordedId(hidden.path), language!);
  const again = await fetchBooksLanguageMetadata(
    client('visitor', [{ label: 'missing-metadata', state: 'error' }]),
    recordedId(missing.path),
    language!,
  );
  const problem = problemOf(hidden.answer);
  expect(reading).toEqual({ kind: 'refused', failure: 'missing', problem });
  expect(again).toEqual(reading);
});

test('the owner of a private Work with no recorded text gets an empty record, not a refusal', async () => {
  const empty = sample('owner', 'private-metadata');
  const language = queryOf(empty.path).get('language');
  const actingSubject = queryOf(empty.path).get('actingSubject');
  expect(language).toBeString();
  expect(actingSubject).toBeString();
  const main = client('owner', [{ label: 'private-metadata', state: 'empty' }]);
  const reply = await main.v1.works({ id: recordedId(empty.path) }).metadata.get({
    query: { language: language!, actingSubject: actingSubject! },
  });
  expect(reply.error).toBeNull();
  expect(reply.data).toEqual(empty.answer);
  const reading: BooksLanguageReading = await fetchBooksLanguageMetadata(
    main,
    recordedId(empty.path),
    language!,
    actingSubject!,
  );
  const body = empty.answer as { work?: unknown; originalTitle?: unknown; localized?: unknown };
  expect(body.originalTitle).toBeNull();
  expect(body.localized).toEqual([]);
  expect(reading).toEqual({ kind: 'empty', workId: body.work });
});

test('an unselected private text is a refusal, not an empty record', async () => {
  const refused = sample('owner', 'unselected-text');
  expect(queryOf(refused.path).get('language')).toBeNull();
  const main = client('owner', [{ label: 'unselected-text', state: 'error' }]);
  const reply = await main.v1['main-versions']({
    mainVersion: recordedId(refused.path),
  }).selection.get({ query: {} });
  expect(reply.data).toBeNull();
  expect(reply.error?.value).toEqual(refused.answer);
  const reading = await fetchBooksLanguageSelection(main, recordedId(refused.path));
  expect(reading).toEqual({
    kind: 'refused',
    failure: 'missing',
    problem: problemOf(refused.answer),
  });
});
