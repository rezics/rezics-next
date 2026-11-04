import { expect, test } from 'bun:test';
import { gameExample } from '../src/features/catalogue/game-reader/examples';
import { gameDatePresentation } from '../src/features/catalogue/game-reader/date';
import { GREGORIAN_CALENDAR, JULIAN_CALENDAR } from '../src/subject/time-presentation';

test('Game release dates retain signed partial dates, uncertainty, TBA, no-value and unsupported calendars', () => {
  const fixture = gameExample();
  const original = fixture.publicRead.subject.statements['schema:datePublished']![0]!;
  const read = (content: unknown, locale = 'en') =>
    gameDatePresentation({ ...original, value: { type: 'value', content } }, fixture.release.digest, locale);
  const month = { time: '+2024-05-00T00:00:00Z', precision: 10 };
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const partial = read(month, locale);
    expect(partial.kind).toBe('partial');
    expect(partial.text).toContain('+2024-05');
    expect(partial.structuredDate).toBe('2024-05');
  }
  const uncertain = read({ ...month, before: 2, after: 3, timezone: 0 });
  expect(uncertain.kind).toBe('partial');
  expect(uncertain.text).toContain('2');
  expect(uncertain.text).toContain('3');
  expect(uncertain.structuredDate).toBeUndefined();
  const signed = read({ time: '-0044-00-00T00:00:00Z', precision: 9, calendarmodel: GREGORIAN_CALENDAR });
  expect(signed.kind).toBe('partial');
  expect(signed.text).toContain('-0044');
  expect(signed.structuredDate).toBeUndefined();
  expect(read({ ...month, calendarmodel: JULIAN_CALENDAR }).kind).toBe('unsupported');
  expect(read({ ...month, calendarmodel: 'source:unknown-calendar' }).kind).toBe('unsupported');
  expect(read({ ...month, precision: 8 }).kind).toBe('unsupported');
  expect(read({ ...month, time: '+2024-13-00T00:00:00Z' }).kind).toBe('invalid');
  expect(read({ ...month, before: -1 }).kind).toBe('unsupported');
  expect(gameDatePresentation({ ...original, value: { type: 'somevalue' } }, fixture.release.digest, 'en').kind).toBe(
    'tba',
  );
  expect(gameDatePresentation({ ...original, value: { type: 'novalue' } }, fixture.release.digest, 'en').kind).toBe(
    'none',
  );
  expect(original.value.type === 'value' && original.value.content).toEqual(month);
});

test('native invalid_request on a supplied release cursor is a restart rather than exhaustion', async () => {
  const fixture = gameExample();
  const { createKernelClient } = await import('@rezics/client');
  const { readGameReader } = await import('../src/features/catalogue/game-reader/model');
  const client = createKernelClient('https://game.example', {
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return new Response(JSON.stringify(url.pathname.endsWith('/links') ? {} : fixture.publicRead), {
          status: url.pathname.endsWith('/links') ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  expect(await readGameReader(client, fixture.release, { ...fixture.address, cursor: 'old-cursor' }, 'en')).toEqual({
    ok: false,
    reason: 'restart',
  });
});
