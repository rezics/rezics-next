import { expect, test } from 'bun:test';
import { gameExample, gameId, editionId } from '../src/features/catalogue/game-reader/examples';
import { gameReaderEntry, readGameReader } from '../src/features/catalogue/game-reader/model';
import { musicReleaseDate } from '../src/features/catalogue/music-release-reader/model';

test('ordinary Game facts preserve work identity, exact editions, qualified contributions and source meaning without hydration', async () => {
  const fixture = gameExample();
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected Game work');
  expect(page.admitted).toBe(true);
  expect(page.public.subject.id).toBe(gameId);
  expect(page.editionsAdmitted).toBe(true);
  expect(page.editions.map((row) => row.summary?.id)).toEqual([editionId]);
  expect(page.editions[0]?.assertion?.value.content).toBe(gameId);
  expect(page.groups.find((group) => group.id === 'classification')?.fields.map((field) => field.property)).toContain(
    'schema:gamePlatform',
  );
  const credit = page.groups.find((group) => group.id === 'credits')?.fields[0]?.statements[0];
  expect(credit?.qualifiers[0]?.value.content).toBe('Harbour Studio');
  expect(credit?.references).toEqual(fixture.publicRead.subject.statements['wdt:P178']![0]!.references);
  expect(page.public.subject.sourceRecords).toEqual(fixture.publicRead.subject.sourceRecords);
  expect(page.editions[0]?.assertion?.qualifiers[0]?.value.content).toBe('Trial 0.8 · ja / Windows');
  expect(fixture.calls.map((url) => new URL(url).pathname)).toEqual([
    `/v1/subjects/${gameId}`,
    `/v1/subjects/${gameId}/links`,
  ]);
  const next = await fixture.read({ ...fixture.address, cursor: page.next! });
  expect(next.ok && next.editions).toEqual([]);
  expect(new URL(fixture.calls.at(-1)!).searchParams.get('cursor')).toBe('opaque:game/next');
});

test('Visual Novel admission never borrows a platform field or manufactures releases from work facts', async () => {
  const fixture = gameExample('visual-novel');
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected Visual Novel');
  expect(page.unsupported).toContain('platform');
  expect(page.groups.flatMap((group) => group.fields).some((field) => field.property === 'schema:gamePlatform')).toBe(
    false,
  );
  fixture.respond(fixture.last);
  const empty = await fixture.read();
  expect(empty.ok && empty.editions).toEqual([]);
  expect(gameReaderEntry('wd:Q209163')).toBe(false);
  expect(gameReaderEntry('wd:Q20631656')).toBe(false);
  const unsupported = await gameExample('unconfigured').read();
  expect(unsupported.ok && unsupported.admitted).toBe(false);
});

test('Game dates keep partial, explicit TBA, no-value and unknown meanings', async () => {
  for (const scenario of ['work', 'tba'] as const) {
    const fixture = gameExample(scenario);
    const date = fixture.publicRead.subject.statements['schema:datePublished']![0]!;
    expect(musicReleaseDate(date, fixture.release.digest, 'en').kind).toBe(scenario === 'tba' ? 'tba' : 'partial');
    expect(musicReleaseDate({ ...date, value: { type: 'novalue' } }, fixture.release.digest, 'en').kind).toBe('none');
    expect(
      musicReleaseDate(
        { ...date, value: { type: 'value', content: { time: '+2024-13-01T00:00:00Z', precision: 11 } } },
        fixture.release.digest,
        'en',
      ).kind,
    ).toBe('unknown');
  }
});

test('bounded release navigation refuses changed identity, cursor loops, duplicates and oversized windows', async () => {
  const fixture = gameExample();
  const first = fixture.first;
  const row = first.links[0]!;
  for (const page of [
    { ...first, links: [{ ...row, summary: { ...row.summary!, id: gameId } }] },
    {
      ...first,
      links: [{ ...row, assertion: { ...row.assertion!, value: { type: 'value' as const, content: editionId } } }],
    },
    { ...first, links: [row, row] },
    { ...first, links: Array.from({ length: 21 }, () => row) },
    { ...first, next: 'x'.repeat(4097) },
  ]) {
    fixture.respond(page);
    expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  }
  fixture.respond(first);
  expect(await fixture.read({ ...fixture.address, cursor: first.next! })).toEqual({ ok: false, reason: 'unavailable' });
  expect(
    await readGameReader(fixture.client, fixture.release, { ...fixture.address, type: 'wd:Q689445' }, 'en'),
  ).toEqual({ ok: false, reason: 'withheld' });
  fixture.fail(404);
  expect(await fixture.read()).toEqual({ ok: false, reason: 'withheld' });
});
