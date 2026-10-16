import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import { loadBooksLibrary } from './books-library-recorded-page.ts';
import { deviceBook, deviceOwner, deviceSample, deviceYear, twoDeviceRecord, twoDeviceReplay, twoDeviceState } from './books-two-device-recorded-page.ts';
import { parseLibraryState } from './state.ts';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

for (const phase of ['winning', 'recovered'] as const) test(`owner ${phase} position passes through the production Library and tracking readers`, async () => {
  const replay = twoDeviceReplay('owner', phase);
  disposals.push(replay.dispose);
  const all = await loadBooksLibrary(replay.reader, { state: parseLibraryState({}), locale: 'en', year: deviceYear(phase), first: true });
  expect(all.overview.ok).toBe(true);
  expect(all.reading.length).toBeGreaterThan(0);
  const page = await loadBooksLibrary(replay.reader, { state: twoDeviceState, locale: 'en', year: deviceYear(phase), first: false });
  expect(page.overview.ok && page.overview.data.agent).toBe(deviceOwner());
  expect(page.view.ok).toBe(true);
  if (!page.view.ok) return;
  const book = page.view.data.rows.find(row => row.work.id.endsWith(deviceBook()));
  expect(book?.work.title?.value).toBe('Original outcome volume');
  expect(book?.status).toBe('read');
  const media = mainTrackingApi(deviceOwner(), () => replay.main).media!;
  expect((await media.standing(deviceBook())).ok).toBe(true);
  const choices = await media.positions(deviceBook());
  expect(choices.ok).toBe(true);
  if (!choices.ok) return;
  const chapter = choices.data.items.find(item => item.label === 'Chapter 2')!;
  const saved = await media.progress(chapter);
  const recorded = deviceSample('owner', phase === 'winning' ? 'device-two-resumed-chapter' : 'device-one-sees-recovery');
  expect(new URL(recorded.path, 'https://recorded.invalid').pathname).toContain(chapter.occurrence.slice(-36));
  expect(saved).toMatchObject({ ok: true, data: phase === 'winning'
    ? { completed: true, position: 'device one paragraph', version: 2 }
    : { completed: false, position: null, version: 3 } });
});

for (const persona of ['visitor', 'stranger', 'member', 'moderator', 'operator'] satisfies AnswerPersona[])
  test(`${persona} cannot display the owner's Library position`, async () => {
    const replay = twoDeviceReplay(persona, 'winning');
    disposals.push(replay.dispose);
    const page = await loadBooksLibrary(replay.reader, { state: twoDeviceState, locale: 'en', year: deviceYear('winning'), first: false });
    expect(page.overview).toMatchObject({ ok: false, failure: 'sign-in' });
    expect(page.reading).toEqual([]);
    expect(page.view.ok).toBe(false);
    const refusal = deviceSample(persona, 'chapter-progress-refused');
    expect(refusal.status).toBe(persona === 'visitor' ? 401 : 403);
    expect(refusal.answer).toMatchObject({ status: refusal.status, code: expect.any(String), title: expect.any(String) });
    expect(JSON.stringify(page)).not.toContain('device one paragraph');
  });

test('the original stale save problem and recovery remain recorded without a pending state', () => {
  expect(deviceSample('owner', 'device-two-stale-save-refused')).toMatchObject({ status: 409,
    answer: { status: 409, code: 'stale_progress', title: 'progress version changed' } });
  expect(Object.values(twoDeviceRecord.personas).flat().some(item => item.status === 202)).toBe(false);
});
