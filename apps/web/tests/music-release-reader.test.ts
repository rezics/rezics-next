import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  musicReleaseExample,
  musicAddress,
  albumId,
  recordingId,
  releaseId,
} from '../src/features/catalogue/music-release-reader/examples';
import {
  acceptMusicReleaseAddress,
  musicReleaseFirstAddress,
  musicReleaseMatchesAddress,
  musicReleaseNavigation,
  musicReleaseNextAddress,
  musicReleaseOccurrenceKey,
  requestMusicReleaseAddress,
  validMusicReleaseAddress,
  isMusicRelease,
  musicReleaseDate,
  musicReleaseEntry,
  readMusicRelease,
} from '../src/features/catalogue/music-release-reader/model';
import { albumEditionProperty, readAlbumEditions } from '../src/features/catalogue/music-reader';
import { isReleaseType } from '../src/features/catalogue/release-fidelity/model';
import recordedRelease from '../src/kernel/recorded/definitions-release.json';
import recordedActive from '../src/kernel/recorded/definitions-active.json';

test('a concrete music edition keeps album and recording identities distinct and reports the unpublished medium grain', async () => {
  const fixture = musicReleaseExample();
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected music release');
  expect(page.admitted).toBe(true);
  expect(page.identity.id).toBe(releaseId);
  expect(page.facts.find((fact) => fact.kind === 'album')?.statements[0]?.value.content).toBe(albumId);
  expect(page.facts.find((fact) => fact.property === 'wdt:P437')?.statements[0]?.value.content).toBe(
    '00000000-0000-4000-8000-00000000b306',
  );
  expect(page.unreleasedGrains).toEqual(['rezics:MusicMedium']);
  expect(page.rows.map((row) => row.summary?.id)).toEqual([recordingId, recordingId]);
  expect(page.rows.map((row) => row.statement?.qualifiers[0]?.value.content)).toEqual(['1', '3']);
  expect(page.rows.map((row) => row.statement)).toEqual(fixture.first.relations.map((row) => row.statement));
  expect(new Set(page.rows.map((row) => row.statementId)).size).toBe(2);
  expect(page.public.subject.sourceRecords).toEqual(fixture.publicRead.subject.sourceRecords);
  expect(fixture.calls.map((url) => url.pathname)).toEqual([
    `/v1/subjects/${releaseId}`,
    `/v1/subjects/${releaseId}/relations`,
  ]);
  const inverse = await fixture.read({ ...musicAddress, stream: 'inverse:wdt:P361' });
  expect(inverse.ok && inverse.rows[0]?.holder).toBe(recordingId);
  expect(inverse.ok && inverse.rows[0]?.statement?.value.content).toBe(releaseId);
  expect(fixture.calls.at(-1)?.searchParams.get('context')).toBe(musicAddress.context);
  expect(fixture.calls.at(-1)?.searchParams.get('limit')).toBe('20');
});

test('only exact released music admission enables the reader; existing release kinds keep their meaning', async () => {
  const fixture = musicReleaseExample('unconfigured');
  const unsupported = await fixture.read();
  expect(unsupported.ok && unsupported.admitted).toBe(false);
  expect(unsupported.ok && unsupported.facts).toEqual([]);
  expect(fixture.calls.length).toBe(1);
  for (const type of ['schema:MusicAlbum', 'bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656']) {
    expect(isMusicRelease(fixture.release, type)).toBe(false);
    expect(musicReleaseEntry(type)).toBe(false);
  }
  for (const type of ['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'])
    expect(isReleaseType(fixture.release, type)).toBe(true);
  fixture.release.types['source:MusicRelease'] = {
    ...fixture.release.types['bf:Instance']!,
    labels: { en: 'Music release' },
  };
  expect(isMusicRelease(fixture.release, 'source:MusicRelease')).toBe(false);
  const configured = musicReleaseExample();
  configured.release.types['source:Edition'] = {
    ...configured.release.types['schema:MusicRelease']!,
    bases: ['schema:MusicRelease'],
  };
  expect(isMusicRelease(configured.release, 'source:Edition')).toBe(true);
  expect(musicReleaseEntry('source:Edition', ['schema:MusicRelease'])).toBe(true);
  configured.release.types['schema:MusicRelease']!.properties = ['schema:exampleOfWork'];
  const missing = await configured.read();
  expect(missing.ok && missing.unsupported).toEqual([
    'schema:datePublished',
    'schema:musicReleaseFormat',
    'schema:contentLocation',
  ]);
  const empty = await musicReleaseExample('empty').read();
  expect(empty.ok && empty.stream).toBeDefined();
  expect(empty.ok && empty.rows).toEqual([]);
});

test('TBA, partial month/year, absent, explicit none and unknown precision remain distinct; continuation is bounded', async () => {
  const fixture = musicReleaseExample();
  const statement = fixture.publicRead.subject.statements['schema:datePublished']![0]!;
  expect(musicReleaseDate(statement, fixture.release.digest, 'en')).toMatchObject({
    kind: 'partial',
    precision: 'month',
    text: 'May 2024',
  });
  statement.value = { type: 'value', content: { time: '+2024-00-00T00:00:00Z', precision: 9 } };
  expect(musicReleaseDate(statement, fixture.release.digest, 'en')).toMatchObject({ kind: 'partial', text: '2024' });
  statement.value = { type: 'value', content: { time: '+2024-05-02T00:00:00Z', precision: 11 } };
  expect(musicReleaseDate(statement, fixture.release.digest, 'en')).toMatchObject({
    kind: 'exact',
    text: 'May 2, 2024',
  });
  statement.value = { type: 'value', content: { time: '+2024-02-31T00:00:00Z', precision: 11 } };
  expect(musicReleaseDate(statement, fixture.release.digest, 'en').kind).toBe('unknown');
  statement.value = { type: 'somevalue' };
  expect(musicReleaseDate(statement, fixture.release.digest, 'en').kind).toBe('tba');
  statement.value = { type: 'novalue' };
  expect(musicReleaseDate(statement, fixture.release.digest, 'en').kind).toBe('none');
  statement.value = { type: 'value', content: { time: '+2024-05-01T00:00:00Z', precision: 8 } };
  expect(musicReleaseDate(statement, fixture.release.digest, 'en').kind).toBe('unknown');
  fixture.publicRead.subject.statements['schema:datePublished'] = [];
  const absent = await fixture.read();
  expect(absent.ok && absent.facts.find((fact) => fact.kind === 'date')?.statements).toEqual([]);
  fixture.respond({ ...fixture.first, next: 'same' });
  expect(await fixture.read({ ...musicAddress, stream: 'forward:schema:track', cursor: 'same' })).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  fixture.respond({ ...fixture.first, relations: Array(21).fill(fixture.first.relations[0]) });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  expect(await readMusicRelease(fixture.client, fixture.release, { ...musicAddress, cursor: 'unbound' }, 'en')).toEqual(
    { ok: false, reason: 'invalid' },
  );
});

test('recorded native music release binds album, format, ordered duplicate tracks and withheld controls', async () => {
  const fixture = musicReleaseExample();
  const recorded = {
    ...structuredClone(recordedRelease.release),
    digest: recordedRelease.digest,
  };
  expect(recordedActive.digest).toBe(recordedRelease.digest);
  expect(recorded.types['schema:MusicRelease']).toBeDefined();
  expect(recorded.types['schema:MusicRecording']).toBeDefined();
  expect(recorded.types['rezics:MusicMedium']).toBeUndefined();
  expect(recorded.types['schema:MusicAlbum']?.library).toBeUndefined();
  expect(recorded.types['schema:MusicRelease']?.library).toBeUndefined();
  expect(recorded.properties['schema:track']?.relation?.slotKey).toBe('wdt:P642');
  const occurrenceA = '00000000-0000-4000-8000-00000000b307';
  const occurrenceB = '00000000-0000-4000-8000-00000000b308';
  fixture.first.relations[0]!.statement.qualifiers.push({
    property: { id: 'wdt:P642', data_type: 'wikibase-item' },
    value: { type: 'value', content: occurrenceA },
  });
  fixture.first.relations[1]!.statement.qualifiers.push({
    property: { id: 'wdt:P642', data_type: 'wikibase-item' },
    value: { type: 'value', content: occurrenceB },
  });
  const page = await readMusicRelease(
    fixture.client,
    recorded,
    { ...musicAddress, stream: 'forward:schema:track' },
    'en',
  );
  if (!page.ok) throw new Error('Expected recorded music release');
  expect(page.admitted).toBe(true);
  expect(page.stream?.key).toBe('forward:schema:track');
  const defaulted = await readMusicRelease(fixture.client, recorded, musicAddress, 'en');
  expect(defaulted.ok && defaulted.stream?.key).toBe('forward:schema:track');
  expect(page.facts.find((fact) => fact.kind === 'album')?.property).toBe('schema:releaseOf');
  expect(page.facts.find((fact) => fact.property === 'wdt:P437')).toBeDefined();
  expect(page.unsupported).toContain('schema:contentLocation');
  expect(page.unreleasedGrains).toContain('rezics:MusicMedium');
  expect(page.rows.map((row) => row.summary?.id)).toEqual([recordingId, recordingId]);
  expect(new Set(page.rows.map((row) => row.statementId)).size).toBe(2);
  expect(page.rows.map((row) => row.statement?.qualifiers.at(-1)?.value.content)).toEqual([occurrenceA, occurrenceB]);
  fixture.fail(403);
  expect(
    await readMusicRelease(fixture.client, recorded, { ...musicAddress, stream: 'forward:schema:track' }, 'en'),
  ).toEqual({
    ok: false,
    reason: 'withheld',
  });
  fixture.fail(503);
  expect(
    await readMusicRelease(fixture.client, recorded, { ...musicAddress, stream: 'forward:schema:track' }, 'en'),
  ).toEqual({
    ok: false,
    reason: 'unavailable',
  });
});

test('album inverse release window binds ordered editions from recorded descriptors', async () => {
  const recorded = { ...structuredClone(recordedRelease.release), digest: recordedRelease.digest };
  const calls: string[] = [];
  const fetchFn: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(`${url.pathname}${url.search}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname === `/v1/subjects/${albumId}`)
        return json({
          subject: {
            id: albumId,
            type: 'schema:MusicAlbum',
            context: musicAddress.context,
            labels: { en: 'Harbour sessions' },
            statements: {},
            sourceRecords: [],
          },
          related: {},
          account: null,
          summary: null,
        });
      if (url.pathname === `/v1/subjects/${albumId}/links`)
        return json({
          links: [
            {
              subject: releaseId,
              property: albumEditionProperty,
              statement: '00000000-0000-4000-8000-00000000b309',
              assertion: {
                id: '00000000-0000-4000-8000-00000000b309',
                property: { id: albumEditionProperty, data_type: 'wikibase-item' },
                value: { type: 'value', content: albumId },
                rank: 'normal',
                qualifiers: [],
                references: [],
                rezics: { release: recorded.digest, revision: 1 },
              },
              summary: {
                id: releaseId,
                type: 'schema:MusicRelease',
                label: { value: 'Japan CD', language: 'en' },
                types: ['schema:MusicRelease'],
                creativeWork: true,
                cover: null,
              },
              type: 'schema:MusicRelease',
              label: 'Japan CD',
              related: {},
            },
          ],
          freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
          next: 'opaque:album/editions',
        });
      return json({}, 404);
    },
    { preconnect: fetch.preconnect },
  );
  const client = createKernelClient('https://release.example', { fetch: fetchFn });
  const page = await readAlbumEditions(client, recorded, { id: albumId, context: musicAddress.context }, 'en');
  if (!page.ok) throw new Error('Expected album editions');
  expect(page.admitted).toBe(true);
  expect(page.rows.map((row) => row.subject)).toEqual([releaseId]);
  expect(page.next).toBe('opaque:album/editions');
  expect(calls.some((path) => path.includes('limit=20'))).toBe(true);
  const denied = await readAlbumEditions(
    createKernelClient('https://release.example', {
      fetch: Object.assign(async () => new Response('{}', { status: 403 }), { preconnect: fetch.preconnect }),
    }),
    recorded,
    { id: albumId, context: musicAddress.context },
    'en',
  );
  expect(denied).toEqual({ ok: false, reason: 'withheld' });
});

test('bounded previous addresses reread their native direction, stream and opaque cursor without retaining bodies', async () => {
  const fixture = musicReleaseExample();
  const first = await fixture.read();
  if (!first.ok || !first.stream) throw new Error('Expected stream');
  let navigation = musicReleaseNavigation(musicAddress, first);
  expect(new Set(first.rows.map(musicReleaseOccurrenceKey)).size).toBe(2);
  const previousAddresses = [];
  for (let index = 0; index < 12; index++) {
    const cursor = `opaque:${index}/?+曲`;
    const page = { ...first, next: cursor };
    const address = musicReleaseNextAddress(navigation, page)!;
    previousAddresses.push(navigation.accepted);
    expect(address).toEqual({ ...musicAddress, stream: first.stream.key, cursor });
    navigation = requestMusicReleaseAddress(navigation, address, 'next');
    const read = await fixture.read(address);
    expect(read.ok).toBe(true);
    expect(fixture.calls.at(-1)?.searchParams.get('cursor')).toBe(cursor);
    expect(fixture.calls.at(-1)?.searchParams.get('property')).toBe(first.stream.property);
    expect(fixture.calls.at(-1)?.pathname).toEndWith('/relations');
    navigation = acceptMusicReleaseAddress(navigation, first.stream.key);
  }
  expect(navigation.previous).toEqual(previousAddresses.slice(-8));
  expect(Object.keys(navigation).sort()).toEqual(['accepted', 'previous']);
  while (navigation.previous.length) {
    const address = navigation.previous.at(-1)!;
    navigation = requestMusicReleaseAddress(navigation, address, 'previous');
    const retained = JSON.stringify(navigation);
    fixture.fail(503);
    expect(await fixture.read(address)).toEqual({ ok: false, reason: 'unavailable' });
    expect(JSON.stringify(navigation)).toBe(retained);
    fixture.fail(0);
    expect((await fixture.read(navigation.pending!.address)).ok).toBe(true);
    expect(fixture.calls.at(-1)?.searchParams.get('cursor')).toBe(address.cursor ?? null);
    navigation = acceptMusicReleaseAddress(navigation, first.stream.key);
    expect(navigation.accepted).toEqual(address);
  }
  const start = musicReleaseFirstAddress(musicAddress, 'inverse:wdt:P361');
  navigation = requestMusicReleaseAddress(navigation, start, 'start');
  const inverse = await fixture.read(start);
  if (!inverse.ok) throw new Error('Expected inverse stream');
  navigation = acceptMusicReleaseAddress(navigation, inverse.stream?.key);
  expect(navigation).toEqual({ accepted: start, previous: [] });
  expect(fixture.calls.at(-1)?.pathname).toEndWith('/links');
  expect(fixture.calls.at(-1)?.searchParams.has('cursor')).toBe(false);
  expect(musicReleaseMatchesAddress(inverse, { ...start, context: albumId })).toBe(false);
  expect(musicReleaseMatchesAddress(inverse, { ...start, stream: first.stream.key })).toBe(false);
  expect(musicReleaseNextAddress(navigation, first)).toBeUndefined();
  expect(validMusicReleaseAddress({ ...start, cursor: 'x'.repeat(4096) })).toBe(true);
  expect(validMusicReleaseAddress({ ...start, cursor: 'x'.repeat(4097) })).toBe(false);
  expect(await fixture.read({ ...start, stream: 'forward:missing' })).toEqual({ ok: false, reason: 'invalid' });
});
