import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/read-non-ui-languages-non-ui-languages.json';
import { mainApiWithToken } from '../api/main.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import {
  booksLanguageReading,
  booksLanguageReads,
  type RecordedProblem,
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

/** A typed read compared with the unchanged recorded answer. */
function same(actual: unknown, recorded: unknown): void {
  expect(actual).toEqual(recorded);
}

function problemOf(value: unknown): RecordedProblem {
  if (!value || typeof value !== 'object') throw new Error('Recorded problem is empty');
  const problem = value as { type?: unknown; title?: unknown; code?: unknown; status?: unknown };
  if (
    typeof problem.type !== 'string' ||
    typeof problem.title !== 'string' ||
    typeof problem.code !== 'string' ||
    typeof problem.status !== 'number'
  ) {
    throw new Error('Recorded problem is incomplete');
  }
  return { type: problem.type, title: problem.title, code: problem.code, status: problem.status };
}

test('a member reads the recorded Swedish text while the UI language is English', async () => {
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
  const reads = booksLanguageReads({ main, actingSubject: actingSubject! });
  const work = await reads.readWorkHeader(recordedId(header.path));
  expect(work.ok).toBe(true);
  if (!work.ok) return;
  same(work.data, header.answer);
  expect(work.data.selectedLanguage).toBe(queryOf(text.path).get('language'));
  const selection = await reads.readText(work.data.mainVersion, work.data.selectedLanguage ?? undefined);
  expect(selection.ok).toBe(true);
  if (!selection.ok) return;
  same(selection.data, text.answer);
  const creditPage = await reads.readCredits(work.data.id, presentation!);
  expect(creditPage.ok).toBe(true);
  if (!creditPage.ok) return;
  same(creditPage.data, credits.answer);

  const reading = booksLanguageReading({ text: selection, credits: creditPage, header: work.data });
  expect(reading.kind).toBe('reading');
  if (reading.kind !== 'reading') return;
  expect(reading.language).toBe(selection.data.language);
  expect(reading.language).not.toBe(presentation);
  expect(reading.body).toBe(selection.data.body);
  expect(reading.title).toEqual(work.data.title);
  expect(reading.header).toEqual(work.data);
  const author = creditPage.data.items.find(
    (item) => item.role === 'author' && item.participantKind === 'agent' && item.agent,
  );
  if (!author?.agent) throw new Error('Recorded credits have no author');
  expect(reading.credit).toEqual({
    id: author.id,
    role: author.role,
    agent: author.agent,
    displayName: author.displayName,
    handle: author.handle,
  });
});

test('a missing selected language keeps the recorded refusal', async () => {
  const header = sample('member', 'work-header');
  const refused = sample('member', 'missing-selected-language');
  const actingSubject = queryOf(header.path).get('actingSubject');
  const language = queryOf(refused.path).get('language');
  expect(actingSubject).toBeString();
  expect(language).toBeString();
  const main = client('member', [
    { label: 'work-header', state: 'populated' },
    { label: 'missing-selected-language', state: 'error' },
  ]);
  const reads = booksLanguageReads({ main, actingSubject: actingSubject! });
  const work = await reads.readWorkHeader(recordedId(header.path));
  expect(work.ok).toBe(true);
  if (!work.ok) return;
  const selection = await reads.readText(work.data.mainVersion, language!);
  expect(selection.ok).toBe(false);
  if (selection.ok) return;
  expect(selection.failure).toBe('missing');
  const problem = problemOf(refused.answer);
  expect(selection.problem).toEqual(problem);
  expect(booksLanguageReading({ text: selection, header: work.data })).toEqual({
    kind: 'refused',
    failure: 'missing',
    problem,
  });
});
