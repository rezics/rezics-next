import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/read-non-ui-languages-non-ui-languages.json';
import { mainApiWithToken } from '../api/main.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import type { AgentCreditPage, WorkHeader } from './types.ts';
import {
  booksLanguageReading,
  booksLanguageReads,
  type RecordedProblem,
} from './books-language-recorded-page.ts';

const record = books as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const refusedPrivate = ['visitor', 'stranger', 'member', 'moderator', 'operator'] as const;
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

test('each persona reads the language its published header selects', async () => {
  for (const persona of personas) {
    const header = sample(persona, 'reading-page-header');
    const text = sample(persona, 'reading-page-selection');
    const actingSubject = queryOf(header.path).get('actingSubject');
    const selections: RecordedSelection[] = [
      { label: 'reading-page-header', state: 'populated' },
      { label: 'reading-page-selection', state: 'populated' },
    ];
    if (persona !== 'visitor') selections.push({ label: 'reader-settings', state: 'populated' });
    const main = client(persona, selections);
    const host = { main, ...(actingSubject ? { actingSubject } : {}) };
    const reads = booksLanguageReads(host);
    const work = await booksEditionReads(host).readWorkHeader(recordedId(header.path));
    expect(work.ok).toBe(true);
    if (!work.ok) return;
    same(work.data, header.answer);
    expect(work.data.selectedLanguage).toBe(queryOf(text.path).get('language'));
    const selection = await reads.readText(work.data.mainVersion, work.data.selectedLanguage ?? undefined);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    same(selection.data, text.answer);
    const reading = booksLanguageReading({ text: selection, header: work.data });
    expect(reading.kind).toBe('reading');
    if (reading.kind !== 'reading') return;
    expect(reading.language).toBe(selection.data.language);
    expect(reading.language).not.toBe('en');
    expect(reading.language).not.toBe('zh-Hant');
    expect(reading.body).toBe(selection.data.body);
    expect(reading.title).toEqual(work.data.title);
    expect(reading.header).toEqual(work.data);
    if (!actingSubject) continue;
    const settings = sample(persona, 'reader-settings');
    expect(queryOf(settings.path).get('actingSubject')).toBe(actingSubject);
    const response = await main.v1.reader.settings.get({ query: { actingSubject } });
    expect(response.error).toBeNull();
    same(response.data, settings.answer);
  }
});

test('a refused private header keeps its problem and the owner missing text keeps its problem', async () => {
  for (const persona of refusedPrivate) {
    const header = sample(persona, 'private-reading-page-header');
    expect(header.status).toBe(404);
    const actingSubject = queryOf(header.path).get('actingSubject');
    const main = client(persona, [{ label: 'private-reading-page-header', state: 'error' }]);
    const work = await booksEditionReads({ main, ...(actingSubject ? { actingSubject } : {}) })
      .readWorkHeader(recordedId(header.path));
    expect(work.ok).toBe(false);
    if (work.ok) return;
    expect(work.failure).toBe('missing');
    expect(work.problem).toEqual(problemOf(header.answer));
  }

  const header = sample('owner', 'private-reading-page-header');
  const refused = sample('owner', 'private-reading-page-selection');
  const actingSubject = queryOf(header.path).get('actingSubject');
  expect(actingSubject).toBeString();
  expect(queryOf(refused.path).has('language')).toBe(false);
  const main = client('owner', [
    { label: 'private-reading-page-header', state: 'populated' },
    { label: 'private-reading-page-selection', state: 'error' },
  ]);
  const host = { main, actingSubject: actingSubject! };
  const reads = booksLanguageReads(host);
  const work = await booksEditionReads(host).readWorkHeader(recordedId(header.path));
  expect(work.ok).toBe(true);
  if (!work.ok) return;
  same(work.data, header.answer);
  expect(work.data.selectedLanguage).toBeNull();
  const selection = await reads.readText(work.data.mainVersion, work.data.selectedLanguage ?? undefined);
  expect(selection.ok).toBe(false);
  if (selection.ok) return;
  expect(selection.failure).toBe('missing');
  const problem = problemOf(refused.answer);
  expect(selection.problem).toEqual(problem);
  expect(booksLanguageReading({ text: selection, header: work.data })).toEqual({
    kind: 'refused',
    failure: 'missing',
    status: refused.status,
    problem,
  });
});

test('the production page retains published Swedish text and original credit for every persona', async () => {
  const owner = new URL(sample('owner', 'reading-page-header').path, 'https://recorded.invalid')
    .searchParams.get('actingSubject');
  for (const persona of personas) {
    const header = sample(persona, 'reading-page-header');
    const actingSubject = queryOf(header.path).get('actingSubject') ?? undefined;
    const main = client(persona, [
      { label: 'reading-page-header', state: 'populated' },
      { label: 'reading-page-selection', state: 'populated' },
      { label: 'reading-page-agent-credits', state: 'populated' },
      { label: 'reading-page-credits', state: 'populated' },
    ]);
    const page = await booksLanguageReads({ main, actingSubject }).readPage(recordedId(header.path));
    expect(page.kind).toBe('shown');
    if (page.kind !== 'shown') continue;
    expect(page.actingSubject).toBe(actingSubject ?? null);
    expect(page.reading.kind).toBe('reading');
    if (page.reading.kind !== 'reading') continue;
    same(page.reading.text, sample(persona, 'reading-page-selection').answer);
    same(page.reading.header, header.answer);
    expect(page.reading.language).toBe('sv');
    same(page.reading.agentCredits, { ok: true, data: sample(persona, 'reading-page-agent-credits').answer });
    const credits = sample(persona, 'reading-page-agent-credits').answer as AgentCreditPage;
    expect(credits.items).toContainEqual(expect.objectContaining({ role: 'author', agent: owner }));
    expect(page.reading.credits.ok).toBe(true);
  }
});

test('production route reuses a cached header and only requests credits after successful selected text', async () => {
  for (const persona of personas) {
    const header = sample(persona, 'private-reading-page-header');
    const actingSubject = queryOf(header.path).get('actingSubject') ?? undefined;
    const main = client(persona, persona === 'owner' ? [
      { label: 'private-reading-page-selection', state: 'error' },
    ] : [{ label: 'private-reading-page-header', state: 'error' }]);
    const page = await booksLanguageReads({ main, actingSubject }).readPage(recordedId(header.path),
      persona === 'owner' ? { header: header.answer as WorkHeader } : {});
    if (persona !== 'owner') {
      expect(page).toEqual({ kind: 'work-missing' });
      continue;
    }
    expect(page).toEqual({ kind: 'shown', actingSubject: actingSubject ?? null,
      reading: { kind: 'refused', failure: 'missing',
        status: sample('owner', 'private-reading-page-selection').status,
        problem: problemOf(sample('owner', 'private-reading-page-selection').answer) } });
  }
});
