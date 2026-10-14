import { expect, test } from 'bun:test';
import { waitForPublisherExpiry } from '../integration/outcomes/realm/closure-fixture.ts';

test('publisher expiry follows server Date past a fractional deadline despite an ahead client clock', async () => {
  const validUntil = '2020-01-01T00:00:03.296Z';
  const dates = ['Wed, 01 Jan 2020 00:00:03 GMT', 'Wed, 01 Jan 2020 00:00:04 GMT',
    'Wed, 01 Jan 2020 00:00:05 GMT'];
  const observed: string[] = [];
  const pauses: number[] = [];
  const result = await waitForPublisherExpiry(validUntil, () => {
    const date = dates[observed.length]!;
    observed.push(date);
    return Promise.resolve(Response.json({}, { headers: { date } }));
  }, milliseconds => { pauses.push(milliseconds); return Promise.resolve(); });

  // +704 ms by the second-resolution server Date is still unqualified,
  // even though this stored deadline has long passed on the client clock.
  expect(observed).toEqual(dates);
  expect(pauses).toEqual([1_000, 1_000]);
  expect(result).toEqual({ validUntil, serverDate: dates[2], offsetMs: 1_704 });
});

test('publisher expiry cannot be qualified by a missing server Date', async () => {
  await expect(waitForPublisherExpiry('2020-01-01T00:00:03.296Z',
    () => Promise.resolve(Response.json({}))))
    .rejects.toThrow('Publisher expiry requires the server Date header');
});

test('publisher expiry does not consume an unavailable clock read as an expiry witness', async () => {
  await expect(waitForPublisherExpiry('2020-01-01T00:00:03.296Z',
    () => Promise.resolve(Response.json({ code: 'dependency_unavailable' }, { status: 503,
      headers: { date: 'Wed, 01 Jan 2020 00:00:05 GMT' } }))))
    .rejects.toThrow('Publisher expiry clock read: 503');
});
