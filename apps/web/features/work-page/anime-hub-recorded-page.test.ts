import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import hub from '../../../../tests/qa/fixtures/outcomes/anime/work-hub-and-edition-choice.json';
import type { StatementPage } from '../entity-page/types.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice } from '../tracking/types.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import { publicationLexicals, readDatedAnimeHub, readUndatedAnimeHub } from './anime-hub-recorded-page.ts';

const record = hub as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const signedIn = personas.filter(persona => persona !== 'visitor');
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string) {
  const answer = record.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing recorded answer: ${record.row}/${persona}/${label}`);
  return answer;
}

function transport(persona: AnswerPersona, selections: RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
}

function workId(persona: AnswerPersona, label: string) {
  return new URL(sample(persona, label).path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
}

function actingSubject(persona: AnswerPersona, label: string) {
  return new URL(sample(persona, label).path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
}

function choice(persona: AnswerPersona, label: string) {
  const answer = sample(persona, label);
  const { actingSubject: subject, expectedVersion, ...edition } = answer.body as EditionChoice & {
    actingSubject: string; expectedVersion: number;
  };
  return { answer, subject, expectedVersion, edition };
}

const datedReads = (persona: AnswerPersona): RecordedSelection[] => [
  { label: 'hub-work-header', state: 'populated' }, { label: 'hub-resource-page', state: 'populated' },
  { label: 'hub-facts', state: 'populated' }, { label: 'hub-agent-credits', state: 'populated' },
  { label: 'hub-work-credits', state: 'populated' }, { label: 'hub-realizations', state: 'populated' },
  { label: 'hub-releases', state: 'populated' }, { label: 'hub-availability-parts', state: 'populated' },
  ...persona === 'visitor' ? [] : [{ label: 'hub-reader-state', state: 'populated' as const }],
];

test('the dated hub keeps the recorded publication date, credit and releases', async () => {
  const persona = 'member';
  const main = transport(persona, datedReads(persona));
  const page = await readDatedAnimeHub(main, actingSubject(persona, 'hub-work-header'), workId(persona, 'hub-work-header'));
  expect(page.header.ok).toBe(true);
  if (!page.header.ok) return;
  const facts = sample(persona, 'hub-facts').answer as StatementPage;
  const statements = page.statements;
  expect<unknown>(statements).toEqual({ ok: true, data: facts });
  expect(publicationLexicals(facts).length).toBeGreaterThan(0);
  if (!statements || !statements.ok) throw new Error('statements');
  expect(publicationLexicals(statements.data)).toEqual(publicationLexicals(facts));
  expect<unknown>(page.releases).toEqual({ ok: true, data: sample(persona, 'hub-releases').answer });
  expect<unknown>(page.realizations).toEqual({ ok: true, data: sample(persona, 'hub-realizations').answer });
  expect<unknown>(page.parts).toEqual({ ok: true, data: sample(persona, 'hub-availability-parts').answer });
  expect<unknown>(page.agentCredits).toEqual({ ok: true, data: sample(persona, 'hub-agent-credits').answer });
  expect<unknown>(page.credits).toEqual({ ok: true, data: (sample(persona, 'hub-work-credits').answer as { result: unknown }).result });
  expect<unknown>(page.projection).toEqual({ ok: true, data: sample(persona, 'hub-resource-page').answer });
  expect(page.shown).toBe(true);
  const state = sample(persona, 'hub-reader-state').answer as { work: string };
  expect(page.seed?.[state.work]).toMatchObject({ status: null, version: 0, rating: null });
});

test('the undated hub keeps an empty statement page and an empty release page', async () => {
  const persona = 'visitor';
  const facts = sample(persona, 'undated-work-publication-date');
  const main = transport(persona, [
    { label: 'undated-work-header', state: 'populated' },
    { label: facts.label, state: 'populated' },
    { label: 'hub-undated-releases-empty', state: 'populated' },
  ]);
  const page = await readUndatedAnimeHub(main, undefined, workId(persona, 'undated-work-header'),
    new URL(facts.path, 'https://recorded.invalid').pathname);
  expect<unknown>(page.header).toEqual({ ok: true, data: sample(persona, 'undated-work-header').answer });
  const statements = facts.answer as StatementPage;
  expect<unknown>(page.statements).toEqual({ ok: true, data: statements });
  expect(publicationLexicals(statements)).toEqual([]);
  expect<unknown>(page.releases).toEqual({ ok: true, data: sample(persona, 'hub-undated-releases-empty').answer });
});

test('visitor sign-in and another Person’s refusal stay distinct on the preference reader', async () => {
  const problems: { persona: AnswerPersona; status?: number; code?: string; title?: string }[] = [];
  for (const persona of personas) {
    const refused = sample(persona, 'other-reader-preference-refused');
    const main = transport(persona, [{ label: refused.label, state: 'error' }]);
    const url = new URL(refused.path, 'https://recorded.invalid');
    const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject')! });
    const result = await reads.readEditionPreference(url.pathname.split('/').at(-1)!);
    expect(result).toEqual({ ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer });
    const problem = refused.answer as { code?: string; title?: string };
    problems.push({ persona, status: refused.status, code: problem.code, title: problem.title });
    const write = choice(persona, 'other-reader-edition-write-refused');
    const writing = transport(persona, [{ label: 'other-reader-edition-write-refused', state: 'error' }]);
    expect(await mainTrackingApi(write.subject, () => writing).setPreference(
      workId(persona, 'hub-work-header'), write.expectedVersion, write.edition)).toEqual({ ok: false, failure: 'sign-in' });
  }
  const visitor = problems.find(item => item.persona === 'visitor')!;
  const member = problems.find(item => item.persona === 'member')!;
  expect(visitor).toMatchObject({ status: 401, code: 'account_assertion_denied' });
  expect(member).toMatchObject({ status: 403, code: 'progress_denied' });
  expect(visitor.title).not.toBe(member.title);
  expect(signedIn.every(persona => problems.find(item => item.persona === persona)?.code === 'progress_denied')).toBe(true);
});

test('each signed-in person saves, loses a concurrent choice, and replays the winning save', async () => {
  for (const persona of signedIn) {
    for (const label of ['broadcast-edition-choice', 'restored-edition-choice'] as const) {
      const { answer, subject, expectedVersion, edition } = choice(persona, label);
      const main = transport(persona, [{ label, state: answer.status === 200 ? 'populated' : 'error' }]);
      const result = await mainTrackingApi(subject, () => main).setPreference(
        workId(persona, 'hub-work-header'), expectedVersion, edition);
      if (answer.status === 200) expect<unknown>(result).toEqual({ ok: true, data: answer.answer });
      else expect<unknown>(result).toEqual({ ok: false, failure: 'stale',
        current: (answer.answer as { current: unknown }).current, submitted: edition });
    }
    const replay = choice(persona, 'edition-choice-replay');
    const main = transport(persona, [{ label: 'edition-choice-replay', state: 'populated' }]);
    const saved = await mainTrackingApi(replay.subject, () => main).setPreference(
      workId(persona, 'hub-work-header'), replay.expectedVersion, replay.edition);
    expect<unknown>(saved).toEqual({ ok: true, data: replay.answer.answer });
    expect((replay.answer.answer as { replayed?: boolean }).replayed).toBe(true);
    const progress = sample(persona, 'chosen-edition-progress');
    const reading = transport(persona, [{ label: progress.label, state: 'populated' }]);
    expect<unknown>(await booksEditionReads({ main: reading, actingSubject: actingSubject(persona, progress.label) })
      .readProgressSummary(workId(persona, progress.label), 'en')).toEqual({ ok: true, data: progress.answer });
  }
});
