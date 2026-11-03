import { expect, test } from 'bun:test';
import {
  albumTrackExample,
  exampleAddress,
  exampleAlbum,
  exampleRecording,
  exampleOtherRecording,
} from '../src/features/catalogue/album-track-reader/examples';
import { albumTrackStreams, readAlbumTracks } from '../src/features/catalogue/album-track-reader/model';

test('one bounded native window preserves ordering, independent slots and exact recording identities without hydration', async () => {
  const fixture = albumTrackExample();
  const page = await fixture.read();
  if (!page.ok || !page.stream) throw new Error('Expected admitted album contents');
  expect(page.rows.map((row) => row.summary?.id)).toEqual([exampleRecording, exampleOtherRecording, exampleRecording]);
  expect(page.rows.map((row) => row.statement?.qualifiers[0]?.value)).toEqual(
    ['2', '1', '1'].map((content) => ({ type: 'value', content })),
  );
  expect(new Set(page.rows.map((row) => row.statementId)).size).toBe(3);
  expect(page.rows[0]?.statement).toEqual(fixture.first.links[0]?.assertion);
  expect(page.rows[0]?.statement?.references[0]?.parts[0]?.value.content.precision).toBe(9);
  expect(page.types['schema:MusicRecording']?.text).toBe('recording');
  expect(page.rows[0]?.statement?.qualifiers[2]?.property.id).toBe('source:unknownPosition');
  expect(page.count).toEqual({ value: 4, exact: false });
  expect(page.caughtUp).toBe(false);
  expect(fixture.calls.map((url) => url.pathname)).toEqual([
    `/v1/subjects/${exampleAlbum}`,
    `/v1/subjects/${exampleAlbum}/links`,
  ]);
  expect(Object.fromEntries(fixture.calls[1]!.searchParams)).toMatchObject({
    context: exampleAddress.context,
    property: page.stream.property,
    limit: '20',
    language: 'en',
  });
  const nextAddress = { ...exampleAddress, stream: page.stream.key, cursor: page.next! };
  const next = await fixture.read(nextAddress);
  expect(next.ok && next.rows.length).toBe(1);
  expect(next.ok && next.next).toBeNull();
  expect(fixture.calls.length).toBe(4);
  expect(fixture.calls[3]!.searchParams.get('cursor')).toBe(page.next);
});

test('forward containment keeps native target summaries and never turns the album holder into the recording', async () => {
  const fixture = albumTrackExample();
  fixture.release.types['schema:MusicAlbum']!.properties.push('bf:hasPart');
  const statement = structuredClone(fixture.first.links[0]!.assertion!);
  statement.property.id = 'bf:hasPart';
  statement.value = { type: 'value', content: exampleRecording };
  fixture.respond({
    relations: [{ statement, summary: fixture.first.links[0]!.summary, related: {} }],
    freshness: fixture.last.freshness,
    next: null,
  });
  const page = await fixture.read({ ...exampleAddress, stream: 'forward:bf:hasPart' });
  expect(page.ok && page.rows[0]?.holder).toBe(exampleAlbum);
  expect(page.ok && page.rows[0]?.summary?.id).toBe(exampleRecording);
  expect(fixture.calls[1]!.pathname.endsWith('/relations')).toBe(true);
});

test('missing configuration, empty, concealed, invalid continuation and over-bound pages remain distinct', async () => {
  const unsupported = albumTrackExample('unconfigured');
  const unconfigured = await unsupported.read();
  expect(unconfigured.ok && unconfigured.stream).toBeUndefined();
  expect(unsupported.calls.length).toBe(1);
  const empty = await albumTrackExample('empty').read();
  expect(empty.ok && empty.rows).toEqual([]);
  expect(empty.ok && empty.stream).toBeDefined();
  expect(await albumTrackExample('withheld').read()).toEqual({ ok: false, reason: 'withheld' });
  const fixture = albumTrackExample();
  expect(await fixture.read({ ...exampleAddress, cursor: 'unbound' })).toEqual({ ok: false, reason: 'invalid' });
  expect(fixture.calls).toEqual([]);
  fixture.respond({ ...fixture.first, links: Array(21).fill(fixture.first.links[0]) });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  const stream = albumTrackStreams(fixture.release, 'en')[0]!;
  fixture.respond({ ...fixture.first, next: 'same' });
  expect(await fixture.read({ ...exampleAddress, stream: stream.key, cursor: 'same' })).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  fixture.respond({
    ...fixture.first,
    links: [{ ...fixture.first.links[0]!, summary: { ...fixture.first.links[0]!.summary!, id: exampleAlbum } }],
  });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  const noRelease = Promise.reject(new Error('Definitions unavailable'));
  expect(await readAlbumTracks(fixture.client, noRelease, exampleAddress, 'en')).toEqual({
    ok: false,
    reason: 'unavailable',
  });
});
