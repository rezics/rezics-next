import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MainClient } from '../features/discover/types.ts';
import { mainTrackingApi } from '../features/tracking/api.ts';
import * as fixture from '../features/tracking/fixtures.ts';
import { shelfFollowing } from '../features/catalogue/reader-store.ts';
import { createMemoryMain, memoryTracking } from '../features/tracking/memory.ts';
import { copyOf, englishMessages, messages } from '../features/tracking/messages.ts';
import { conflictRows, dateText, editionOptions, hasEnded, isOpen, movesFrom, numbered, parsePosition, parseTime,
  timeText, validDate, withoutVersion } from '../features/tracking/model.ts';
import { SeriesStates } from '../features/tracking/series-states.tsx';
import { equivalentCounterparts } from '../features/tracking/series-progress-panel.tsx';
import { uiLocales } from '../i18n/define.ts';

describe('G-838 attempts: what the status control offers', () => {
  test('an attempt that has ended offers no move; a live one offers the moves Main accepts', () => {
    expect(movesFrom('planned')).toEqual(['active', 'dnf', 'finished']);
    expect(movesFrom('active')).toEqual(['paused', 'dnf', 'finished']);
    expect(movesFrom('paused')).toEqual(['active', 'dnf', 'finished']);
    for (const state of ['dnf', 'finished'] as const) {
      expect(movesFrom(state)).toEqual([]);
      expect(hasEnded({ state })).toBe(true);
    }
  });

  test('two active attempts are both open; a finished one is not', () => {
    const sessions = [fixture.session({ id: fixture.iri('a2') }), fixture.session({ state: 'paused' }), fixture.session({ id: fixture.iri('a3'), state: 'finished' })];
    expect(sessions.filter(isOpen)).toHaveLength(2);
    expect(numbered(sessions).map(row => row.number)).toEqual([3, 2, 1]);
  });
});

describe('G-838 dates, times and positions', () => {
  test('a date keeps the precision it was given and unknown is never today', () => {
    expect(validDate('2024')).toBe(true);
    expect(validDate('2024-05')).toBe(true);
    expect(validDate('2024-02-29')).toBe(true);
    for (const bad of ['2023-02-29', '2024-13', '2024-00-10', '0000', '24', '2024-5-1', '']) expect(validDate(bad)).toBe(false);
    expect(dateText(null, 'en')).toBeNull();
    expect(dateText('2024', 'en')).toBe('2024');
    expect(dateText('2024-05', 'en')).toBe('May 2024');
    expect(dateText('2024-05-17', 'en')).toBe('May 17, 2024');
  });

  test('a time reads as h:mm:ss, m:ss or seconds, and a position must fit its unit', () => {
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('12:30')).toBe(750);
    expect(parseTime('90')).toBe(90);
    expect(parseTime('1:75')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(timeText(3723)).toBe('1:02:03');
    expect(timeText(750)).toBe('12:30');
    expect(parsePosition('page', '120')).toBe(120);
    expect(parsePosition('page', '12.5')).toBeNull();
    expect(parsePosition('percentage', '100')).toBe(100);
    expect(parsePosition('percentage', '101')).toBeNull();
    expect(parsePosition('media-time', '1:00:00')).toBe(3600);
  });
});

describe('G-838 editions', () => {
  test('an attempt offers each edition once and never the Work again', () => {
    const attempt = fixture.session({ selections: [...fixture.session().selections,
      { target: { ...fixture.session().target, resource: fixture.iri('p1'), base: 'release' }, language: 'en', format: 'print', progress: 'locator' }] });
    const options = editionOptions(fixture.saoOne, fixture.editions, attempt).map(option => option.resource);
    expect(options).toEqual([fixture.iri('r1'), fixture.iri('r2'), fixture.iri('p2')]);
    expect(editionOptions(fixture.saoOne, fixture.editions, null).map(option => option.resource)).toContain(fixture.saoOne);
  });
});

describe('G-838 conflicts show both sides and merge nothing', () => {
  test('only the fields the refused change touched, and only where they differ', () => {
    const current = fixture.session({ state: 'paused', startedOn: '2026-09', version: 4 });
    const rows = conflictRows(current, { state: 'finished', startedOn: '2026-09', finishedOn: '2026-10-01',
      position: { target: fixture.saoOne, unit: 'page', value: 40 } });
    expect(rows.map(row => row.field)).toEqual(['state', 'finishedOn', 'position']);
    expect(rows[0]).toMatchObject({ mine: 'finished', theirs: 'paused' });
    expect(conflictRows(current, { state: 'paused' })).toEqual([]);
  });

  test('an edition the other device already added the same way is not a disagreement', () => {
    const same = fixture.session({ selections: [...fixture.session().selections,
      { target: { ...fixture.session().target, resource: fixture.iri('p2'), base: 'release' }, language: 'en', format: 'audiobook', progress: 'locator' }] });
    expect(conflictRows(same, { addSelections: [{ target: fixture.iri('p2'), format: 'audiobook' }] })).toEqual([]);
    expect(conflictRows(same, { addSelections: [{ target: fixture.iri('p2'), format: 'print' }] })).toHaveLength(1);
  });

  test('keeping my change sends it again without the old version', () => {
    expect(withoutVersion({ state: 'finished', expectedVersion: 2 })).toEqual({ state: 'finished' });
  });
});

describe('G-838 two devices over one Main', () => {
  test('a stale edit is refused with both states; keeping it on the new version applies it', async () => {
    const main = createMemoryMain({ sessions: [fixture.session()], editions: fixture.editions });
    const [phone, desktop] = [memoryTracking(main), memoryTracking(main)];
    const id = fixture.session().id;
    // The phone pauses first; the desktop still holds version 1.
    expect((await phone.change(id, 1, { state: 'paused' })).ok).toBe(true);
    const refused = await desktop.change(id, 1, { state: 'finished' });
    expect(refused).toMatchObject({ ok: false, failure: 'stale', current: { state: 'paused', version: 2 }, submitted: { state: 'finished', expectedVersion: 1 } });
    expect(main.sessions[0]!.state).toBe('paused');
    if (refused.ok || refused.failure !== 'stale') throw new Error('expected a conflict');
    const kept = await desktop.change(id, refused.current.version, withoutVersion(refused.submitted));
    expect(kept).toMatchObject({ ok: true, data: { state: 'finished', version: 3 } });
  });

  test('a reread starts a second attempt after the first has ended; two starts leave two open', async () => {
    const main = createMemoryMain({ editions: fixture.editions });
    const [a, b] = [memoryTracking(main), memoryTracking(main)];
    await a.start(fixture.saoOne, { state: 'active' });
    await b.start(fixture.saoOne, { state: 'active' });
    const listed = await a.sessions(fixture.saoOne);
    if (!listed.ok) throw new Error('unreadable');
    expect(listed.data.items.filter(isOpen)).toHaveLength(2);
  });

  test('a page needs an edition: the Work on its own takes no position; the furthest never moves back', async () => {
    const main = createMemoryMain({ sessions: [fixture.session()], editions: fixture.editions });
    const device = memoryTracking(main);
    const id = fixture.session().id;
    expect((await device.change(id, 1, { position: { target: fixture.saoOne, unit: 'page', value: 10 } })).ok).toBe(false);
    const added = await device.change(id, 1, { addSelections: [{ target: fixture.iri('p1'), format: 'print' }] });
    expect(added.ok).toBe(true);
    await device.change(id, 2, { position: { target: fixture.iri('p1'), unit: 'page', value: 200 } });
    const back = await device.change(id, 3, { position: { target: fixture.iri('p1'), unit: 'page', value: 50 } });
    expect(back).toMatchObject({ ok: true, data: { locators: [{ unit: 'page', current: 50, furthest: 200 }] } });
  });
});

describe('G-838 the Main client sends versions and reads conflicts', () => {
  test('a write carries its expected version and an idempotency key; a 409 yields both states', async () => {
    const sent: { id?: string; body: unknown; headers: unknown }[] = [];
    const current = fixture.session({ state: 'paused', version: 3 });
    const main = { v1: { me: { sessions: Object.assign(
      (path: { id: string }) => ({ patch: async (body: unknown, options: { headers: unknown }) => {
        sent.push({ id: path.id, body, headers: options.headers });
        return { data: null, error: { status: 409, value: { code: 'stale_session', current, submitted: { state: 'finished', expectedVersion: 2 } } } };
      } }), {}) } } } as unknown as MainClient;
    const api = mainTrackingApi('https://rezics.com/id/agent', () => main);
    const written = await api.change(fixture.session().id, 2, { state: 'finished' });
    expect(sent[0]!.id).toBe(fixture.session().id.slice(-36));
    expect(sent[0]!.body).toEqual({ actingSubject: 'https://rezics.com/id/agent', expectedVersion: 2, state: 'finished' });
    expect(String((sent[0]!.headers as Record<string, string>)['idempotency-key']).length).toBeGreaterThan(8);
    expect(written).toMatchObject({ ok: false, failure: 'stale', current: { version: 3 }, submitted: { expectedVersion: 2 } });
  });
});

describe('G-838 class guard: the states are Main’s, each on its own line', () => {
  const lines = (states: object) => [...renderToStaticMarkup(createElement(SeriesStates, { states: states as never, t: copyOf('en') }))
    .matchAll(/data-state="(\w+)" data-value="(\w+)"><dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)</g)].map(match => match.slice(1));

  test('Index Original in zh-Hant is caught up with available material and not finished with the published parts', () => {
    expect(lines(fixture.indexSummary.states)).toEqual([
      ['caughtUpWithAvailableMaterial', 'true', 'Caught up with available material', 'Yes'],
      ['finishedPublishedParts', 'false', 'Finished the published parts', 'No'],
      ['seriesConcluded', 'false', 'Series concluded', 'No'],
      ['correspondenceUnresolved', 'true', 'Correspondence unresolved', 'Yes']]);
  });

  test('a state Main did not return is not drawn; one it could not decide reads unknown, not no', () => {
    const { seriesConcluded: _omitted, ...returned } = fixture.indexSummary.states;
    expect(lines(returned).map(line => line[0])).toEqual(['caughtUpWithAvailableMaterial', 'finishedPublishedParts', 'correspondenceUnresolved']);
    expect(lines(fixture.partialSummary.states).slice(0, 3).map(line => line[3])).toEqual(['Unknown', 'Unknown', 'Unknown']);
  });

  test('every state has its own label in every language, and no two share one', () => {
    for (const locale of uiLocales) {
      const t = copyOf(locale);
      const labels = [t.stateCaughtUp, t.stateFinishedParts, t.stateConcluded, t.stateCorrespondence];
      expect(new Set(labels).size).toBe(4);
    }
  });
});

describe('G-838 correspondence is offered only for an equivalent counterpart', () => {
  test('the equivalent relation names the book; another meaning names nobody', () => {
    const relations = fixture.spiderRelations();
    expect(equivalentCounterparts(relations, fixture.equivalentDefinition)).toEqual([{ work: fixture.spider.book, title: 'So I’m a Spider, So What? (book)' }]);
    expect(equivalentCounterparts(relations, fixture.iri('other'))).toEqual([]);
  });
});

describe('G-838 catalogs', () => {
  test('every locale supplies every key', () => {
    for (const locale of uiLocales) {
      expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(englishMessages).sort());
    }
  });
});

describe('G-838 counts agree with their numbers in every language', () => {
  test('one part and many parts take their own forms where the language has them', () => {
    const en = copyOf('en');
    expect(en.partsFinished(1)).toBe('1 part finished in all');
    expect(en.partsFinished(3)).toBe('3 parts finished in all');
    expect(en.countsLine({ count: 1, completedRequired: '1' })).toBe('1 of 1 required part finished');
    expect(en.countsLine({ count: 4, completedRequired: '2' })).toBe('2 of 4 required parts finished');
    expect(copyOf('de').partsFinished(1)).toBe('Insgesamt 1 Teil gelesen');
    expect(copyOf('es').partsFinished(2)).toBe('2 partes terminadas en total');
    expect(copyOf('fr').countsLine({ count: 1, completedRequired: '0' })).toBe('0 partie obligatoire sur 1 terminée');
  });
});

describe('G-838 the shelf follows a write that took', () => {
  test('a started or changed attempt reads the Work’s shelf again; a refused write does not', async () => {
    const main = createMemoryMain({ editions: fixture.editions });
    const changed: string[] = [];
    const api = shelfFollowing(memoryTracking(main), work => changed.push(work));
    const started = await api.start(fixture.saoOne, { state: 'active' });
    if (!started.ok) throw new Error('start refused');
    expect(changed).toEqual([fixture.saoOne]);
    await api.change(started.data.id, 1, { state: 'finished' });
    expect(changed).toEqual([fixture.saoOne, fixture.saoOne]);
    const refused = await api.change(started.data.id, 1, { state: 'paused' });
    expect(refused.ok).toBe(false);
    expect(changed).toHaveLength(2);
  });
});

describe('G-838 a Work without a composition', () => {
  test('is answered with its own status and no parts, so no series is drawn for it', () => {
    const summary = fixture.standaloneSummary('not-started');
    expect(summary.scope).toBe('work');
    expect('next' in summary).toBe(false);
    expect('completedParts' in summary).toBe(false);
  });
});
