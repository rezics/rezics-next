import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/manga/continue-progress-across-devices-two-device-progress.json';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from './api.ts';
import { mainEpisodeApi } from './episode-api.ts';
import {
  mangaActingSubject, mangaDeviceApi, mangaDevicePersonas, mangaDeviceSelections, mangaFrameSelections,
  mangaRecordedClient, mangaRecordedTransport, mangaSample, mangaWorkId, readMangaDeviceFrame, readMangaPublicOpening,
} from './manga-two-device-recorded-page.ts';

const origin = 'https://recorded.invalid';
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function open(persona: AnswerPersona, selections: readonly RecordedSelection[], loseAnswer = false) {
  const requests: Request[] = [], errors: unknown[] = [];
  const transport = mangaRecordedTransport(persona, selections, {
    loseAnswer, onRequest: request => requests.push(request), onError: error => errors.push(error),
  });
  disposals.push(transport.dispose);
  return { main: mangaRecordedClient(transport.fetcher, persona, origin), requests, errors };
}

type Progress = { structure: string; occurrence: string; completed: boolean; position: string | null; version: number };
type Inventory = { items: { structure: string; occurrence: string; role: string; labels?: { value: string }[]; displayLabel?: string }[] };
type Write = { completed: boolean; position: string | null; expectedVersion: number };
function mappedProgress(persona: AnswerPersona, label: string) {
  const { completed, position, version, occurrence } = mangaSample(persona, label).answer as Progress;
  return { completed, position, version, occurrence };
}
const partOf = (path: string) => {
  const parts = new URL(path, origin).pathname.split('/');
  return { structure: parts[3]!, occurrence: parts[5]! };
};

test('visitor reads the recorded public Work, author and opening chapters without an acting Person', async () => {
  const { main, errors } = open('visitor', mangaFrameSelections('visitor'));
  const frame = await readMangaDeviceFrame(main, 'visitor');
  expect<unknown>(frame.header.ok && frame.header.data).toEqual(mangaSample('visitor', 'frame-1').answer);
  expect<unknown>(frame.agentCredits.ok && frame.agentCredits.data).toEqual(mangaSample('visitor', 'frame-2').answer);
  expect(frame.actingSubject).toBeUndefined();
  expect(frame.seed).toBeNull();
  const opening = await readMangaPublicOpening(main, 'visitor', 'en');
  expect(opening.kind).toBe('page');
  if (opening.kind !== 'page') throw new Error('Recorded public contents did not map');
  const answer = mangaSample('visitor', 'public-contents-1').answer as Inventory;
  expect<unknown>(opening.chapters.map(chapter => chapter.label)).toEqual(answer.items.map(item => item.labels?.[0]?.value ?? item.displayLabel));
  expect(opening.complete).toBe(true);
  expect(opening.nextHref).toBeNull();
  expect(errors).toEqual([]);
});

test('visitor private read and save retain the recorded HTTP 401 problem', async () => {
  const samples = (record as AnswerRecord).personas.visitor;
  const read = samples.find(sample => sample.status === 401 && sample.method === 'GET' && sample.path.includes('/progress?'))!;
  const write = samples.find(sample => sample.status === 401 && sample.method === 'PUT' && sample.path.endsWith('/progress'))!;
  const { main, errors } = open('visitor', [{ label: read.label, state: 'error' }, { label: write.label, state: 'error' }]);
  const actor = new URL(read.path, origin).searchParams.get('actingSubject')!;
  const progress = await mainEpisodeApi(actor, () => main).progress(partOf(read.path));
  expect<unknown>(progress).toEqual({ ok: false, failure: 'sign-in', status: 401, problem: read.answer });
  // The visitor frame hides private commands; the shared typed command boundary retains its refusal too.
  const { putAnimeEpisodeProgress } = await import('./anime-collection-recorded-page.ts');
  const saved = await putAnimeEpisodeProgress(main, partOf(write.path), write.body as Parameters<typeof putAnimeEpisodeProgress>[2], 'recorded-visitor-refusal');
  expect(saved.error?.status).toBe(401);
  expect<unknown>(saved.error?.value).toEqual(write.answer);
  expect(errors).toEqual([]);
});

for (const persona of mangaDevicePersonas) {
  test(`${persona} keeps the recorded frame, own Person, two real grants and edition reads`, async () => {
    const frameRead = open(persona, mangaFrameSelections(persona));
    const frame = await readMangaDeviceFrame(frameRead.main, persona);
    expect<unknown>(frame.header.ok && frame.header.data).toEqual(mangaSample(persona, 'frame-1').answer);
    expect<unknown>(frame.agentCredits.ok && frame.agentCredits.data).toEqual(mangaSample(persona, 'frame-2').answer);
    expect(frame.actingSubject).toBe(mangaActingSubject(persona));
    expect(frame.seed).not.toBeNull();
    const identities = [];
    for (const device of ['first', 'second']) {
      const label = `${device}-device-identity`;
      const { main, errors } = open(persona, [{ label, state: 'populated' }]);
      // Answer records exclude session secrets; each local replay still sends its own opaque key.
      const read = await main.v1.me['session-agent'].get({ headers: { 'x-session-key': crypto.randomUUID() } });
      expect<unknown>(read.data).toEqual(mangaSample(persona, label).answer);
      expect(read.data?.sessionAgent.actingSubject).toBe(frame.actingSubject);
      expect(read.data?.sessionAgent.eligible).toBe(true);
      identities.push(read.data?.sessionAgent.revision);
      expect(errors).toEqual([]);
    }
    expect(identities[0]).not.toBe(identities[1]);
    const tracking = open(persona, [{ label: 'tracking-1', state: 'populated' }, { label: 'tracking-2', state: 'populated' }]);
    const api = mainTrackingApi(frame.actingSubject!, () => tracking.main);
    expect<unknown>(await api.preference(mangaWorkId(persona))).toEqual({ ok: true, data: mangaSample(persona, 'tracking-1').answer });
    expect<unknown>(await api.series(mangaWorkId(persona), 'en')).toEqual({ ok: true, data: mangaSample(persona, 'tracking-2').answer });
    expect([...frameRead.errors, ...tracking.errors]).toEqual([]);
  });

  test(`${persona} retries one production save with the same command key and receives the recorded replay`, async () => {
    const replay = open(persona, mangaDeviceSelections('first', 'replay'), true);
    const api = mangaDeviceApi(replay.main, persona), work = mangaWorkId(persona);
    expect((await api.types(work)).ok).toBe(true);
    expect((await api.standing(work)).ok).toBe(true);
    const positions = await api.positions(work);
    expect(positions.ok && positions.data.items).toHaveLength(4);
    const part = partOf(mangaSample(persona, 'mark-6').path);
    const before = await api.progress(part);
    expect<unknown>(before.ok && before.data).toEqual(mappedProgress(persona, 'mark-4'));
    const body = mangaSample(persona, 'mark-6').body as Write;
    const saved = await api.mark(part, body);
    expect<unknown>(saved.ok && saved.data).toEqual(mangaSample(persona, 'mark-7').answer);
    expect(saved.ok && saved.data).toMatchObject({ completed: true, version: 3, replayed: true });
    expect((await api.standing(work)).ok).toBe(true);
    const writes = replay.requests.filter(request => request.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(writes[1]!.headers.get('idempotency-key')).toBe(writes[0]!.headers.get('idempotency-key'));
    expect(await writes[0]!.json()).toEqual(mangaSample(persona, 'mark-6').body);
    expect(await writes[1]!.json()).toEqual(mangaSample(persona, 'mark-7').body);
    expect(replay.errors).toEqual([]);
  });

  test(`${persona} undoes across the series and omnibus, resolves stale progress, then reads both devices independently`, async () => {
    const first = open(persona, mangaDeviceSelections('first', 'undo'));
    const second = open(persona, mangaDeviceSelections('second', 'undo'));
    const apis = [mangaDeviceApi(first.main, persona), mangaDeviceApi(second.main, persona)];
    const part = partOf(mangaSample(persona, 'first-undo-6').path);
    for (const [index, device] of (['first', 'second'] as const).entries()) {
      const api = apis[index]!, work = mangaWorkId(persona, device);
      expect((await api.types(work)).ok).toBe(true);
      const standing = await api.standing(work);
      expect(standing.ok && standing.data.last?.occurrence).toBe((mangaSample(persona, 'first-undo-4').answer as Progress).occurrence);
      const positions = await api.positions(work);
      expect(positions.ok && positions.data.items.some(item => item.occurrence.endsWith(part.occurrence))).toBe(true);
      const before = await api.progress(part);
      expect<unknown>(before.ok && before.data).toEqual(mappedProgress(persona, `${device}-undo-4`));
    }
    const cleared = await apis[0]!.mark(part, mangaSample(persona, 'first-undo-6').body as Write);
    expect<unknown>(cleared.ok && cleared.data).toEqual(mangaSample(persona, 'first-undo-6').answer);
    await apis[0]!.standing(mangaWorkId(persona));
    const stale = await apis[1]!.mark(part, mangaSample(persona, 'second-undo-6').body as Write);
    expect(stale).toMatchObject({ ok: false, failure: 'stale', status: 409,
      problem: mangaSample(persona, 'second-undo-6').answer,
      current: mappedProgress(persona, 'second-undo-7'), submitted: { completed: false, position: null } });
    await apis[1]!.standing(mangaWorkId(persona, 'second'));
    const recovered = await apis[1]!.mark(part, mangaSample(persona, 'second-undo-10').body as Write);
    expect<unknown>(recovered.ok && recovered.data).toEqual(mangaSample(persona, 'second-undo-10').answer);
    expect(recovered.ok && recovered.data.version).toBe(5);
    await apis[1]!.standing(mangaWorkId(persona, 'second'));
    expect([...first.errors, ...second.errors]).toEqual([]);
    for (const device of ['first', 'second'] as const) {
      const fresh = open(persona, mangaDeviceSelections(device, 'after-undo'));
      const api = mangaDeviceApi(fresh.main, persona), work = mangaWorkId(persona, device);
      await api.types(work);
      const standing = await api.standing(work);
      expect(standing.ok).toBe(true);
      const inventory = await api.positions(work);
      expect(inventory.ok && inventory.data.items.some(item => item.occurrence.endsWith(part.occurrence))).toBe(true);
      const after = await api.progress(part);
      expect<unknown>(after.ok && after.data).toEqual(mappedProgress(persona, `${device}-after-undo-4`));
      expect(after.ok && after.data).toMatchObject({ completed: false, version: 5 });
      expect(fresh.errors).toEqual([]);
    }
  });
}
