import { expect, test } from 'bun:test';
import {
  musicReleaseExample,
  musicAddress,
  albumId,
  mediumId,
  recordingId,
  releaseId,
} from '../src/features/catalogue/music-release-reader/examples';
import {
  isMusicRelease,
  musicReleaseDate,
  musicReleaseEntry,
  readMusicRelease,
} from '../src/features/catalogue/music-release-reader/model';
import { isReleaseType } from '../src/features/catalogue/release-fidelity/model';

test('a concrete music edition retains album, medium and recording identities, directed slots and sources without hydration', async () => {
  const fixture = musicReleaseExample();
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected music release');
  expect(page.admitted).toBe(true);
  expect(page.identity.id).toBe(releaseId);
  expect(page.facts.find((fact) => fact.kind === 'album')?.statements[0]?.value.content).toBe(albumId);
  expect(page.facts.find((fact) => fact.property === 'wdt:P437')?.statements[0]?.value.content).toBe(
    '00000000-0000-4000-8000-00000000b306',
  );
  expect(page.rows.map((row) => row.summary?.id)).toEqual([mediumId, recordingId, recordingId]);
  expect(page.rows.map((row) => row.statement?.qualifiers[0]?.value.content)).toEqual(['2', '1', '3']);
  expect(page.rows.map((row) => row.statement)).toEqual(fixture.first.relations.map((row) => row.statement));
  expect(new Set(page.rows.map((row) => row.statementId)).size).toBe(3);
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
  expect(await fixture.read({ ...musicAddress, stream: 'forward:bf:hasPart', cursor: 'same' })).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  fixture.respond({ ...fixture.first, relations: Array(21).fill(fixture.first.relations[0]) });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  expect(await readMusicRelease(fixture.client, fixture.release, { ...musicAddress, cursor: 'unbound' }, 'en')).toEqual(
    { ok: false, reason: 'invalid' },
  );
});
