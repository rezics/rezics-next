import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import hub from '../../../../tests/qa/fixtures/outcomes/books/work-hub-and-edition-choice.json';
import ambiguous from '../../../../tests/qa/fixtures/outcomes/books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions.json';
import formats from '../../../../tests/qa/fixtures/outcomes/books/choose-among-mixed-formats-mixed-formats.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice, Editions } from '../tracking/types.ts';

const records = [hub, ambiguous, formats] as AnswerRecord[];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const answer = record.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing recorded answer: ${record.row}/${persona}/${label}`);
  return answer;
}

function transport(record: AnswerRecord, persona: AnswerPersona, selections: RecordedSelection[], failures: string[] = []) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const fetcher: typeof fetch = async (input, init) => {
    try { return await replay.fetcher(input, init); }
    catch (error) { failures.push(String(error)); throw error; }
  };
  return browserMainApi('https://recorded.invalid', { fetcher });
}

function command(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const answer = sample(record, persona, label);
  const { actingSubject, expectedVersion, ...choice } = answer.body as EditionChoice & {
    actingSubject: string; expectedVersion: number;
  };
  const work = (sample(record, persona, 'work-header').answer as { id: string }).id;
  return { answer, actingSubject, expectedVersion, choice, work };
}

for (const record of records) {
  test(`${record.row}: the production reader consumes the recorded offered editions`, async () => {
    const persona = 'member';
    const own = sample(record, persona, 'own-preference-before');
    const actingSubject = new URL(own.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
    const work = (sample(record, persona, 'work-header').answer as { id: string }).id;
    const releaseLabel = record === records[0] ? 'availability-releases' : 'release-choices';
    const failures: string[] = [];
    const main = transport(record, persona, [
      { label: 'realization-choices', state: 'populated' }, { label: releaseLabel, state: 'populated' },
    ], failures);
    const result = await mainTrackingApi(actingSubject, () => main).editions(work);
    expect(result.ok, failures.join('\n')).toBe(true);
    if (!result.ok) return;
    const realizations = sample(record, persona, 'realization-choices').answer as {
      items: Editions['realizations']; nextCursor: string | null;
    };
    const releases = sample(record, persona, releaseLabel).answer as {
      items: Editions['releases']; nextCursor: string | null;
    };
    expect(result.data.realizations).toEqual(realizations.items);
    expect(result.data.releases).toEqual(releases.items);
    expect(result.data.realizationsCursor).toBe(realizations.nextCursor);
    expect(result.data.releasesCursor).toBe(releases.nextCursor);
  });

  test(`${record.row}: a recorded null preference is a successful empty read`, async () => {
    const own = sample(record, 'member', 'own-preference-before');
    expect(own.answer).toBeNull();
    const actingSubject = new URL(own.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
    const work = (sample(record, 'member', 'work-header').answer as { id: string }).id;
    const main = transport(record, 'member', [{ label: own.label, state: 'empty' }]);
    expect(await mainTrackingApi(actingSubject, () => main).preference(work)).toEqual({ ok: true, data: null });
  });

  test(`${record.row}: a recorded save and compare-and-set conflict retain the exact edition`, async () => {
    for (const label of ['save-preference-ebook', 'save-preference-stale']) {
      const { answer, actingSubject, expectedVersion, choice, work } = command(record, 'member', label);
      const main = transport(record, 'member', [{ label, state: answer.status === 200 ? 'populated' : 'error' }]);
      const result = await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice);
      if (answer.status === 200) expect(result).toEqual({ ok: true, data: answer.answer });
      else expect(result).toEqual({ ok: false, failure: 'stale',
        current: (answer.answer as { current: unknown }).current, submitted: choice });
    }
  });

  test(`${record.row}: visitors cannot save and every signed-in persona is refused another Person's choice`, async () => {
    for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
      const label = persona === 'visitor' ? 'save-preference-sign-in' : 'foreign-save-preference-denied';
      const { actingSubject, expectedVersion, choice, work } = command(record, persona, label);
      const main = transport(record, persona, [{ label, state: 'error' }]);
      expect(await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice))
        .toEqual({ ok: false, failure: 'sign-in' });
    }
  });
}

test('the Work hub progress summary retains the recorded saved edition and continuations', async () => {
  const record = records[0]!;
  const own = sample(record, 'member', 'own-preference-ebook');
  const progress = sample(record, 'member', 'own-progress-summary');
  const actingSubject = new URL(own.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
  const work = (sample(record, 'member', 'work-header').answer as { id: string }).id;
  const main = transport(record, 'member', [
    { label: own.label, state: 'populated' }, { label: progress.label, state: 'populated' },
  ]);
  const api = mainTrackingApi(actingSubject, () => main);
  expect(await api.preference(work)).toEqual({ ok: true, data: own.answer });
  expect(await api.series(work)).toEqual({ ok: true, data: progress.answer });
});
