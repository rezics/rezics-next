import { expect, test } from 'bun:test';
import { mangaDraft, mangaFields, validateManga, readMangaProfile } from '../src/features/catalogue/manga-profile';
import { mangaExample, mangaFixture, mangaSeriesId, mangaVolumeId } from '../src/kernel/fake/catalogue-manga-profile';
import { sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { statementInput } from '../src/features/catalogue/statement-editor';

test('Manga series and volume editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  const fixture = mangaFixture();
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected current released manga definitions');
  expect(read.releaseDigest).toBeTruthy();
  expect(mangaFields(read.release, 'schema:ComicSeries', 'en')).not.toContain('schema:numberOfPages');
  expect(mangaFields(read.release, 'schema:ComicSeries', 'en')).not.toContain('schema:isbn');
  expect(mangaFields(read.release, 'schema:PublicationVolume', 'en')).not.toContain('wdt:P2635');
  expect(mangaFields(read.release, 'schema:ComicSeries', 'en')).not.toContain('schema:name');
  const volume = mangaExample(true);
  const draft = mangaDraft(
    read.release,
    volume.type,
    'en',
    [
      { language: 'en', label: volume.labels.en!, description: '', aliases: '' },
      { language: 'ja', label: volume.labels.ja!, description: '', aliases: '' },
    ],
    Object.values(volume.statements).flat(),
  );
  expect(draft.errors).toEqual([]);
  const key = crypto.randomUUID();
  const created = await fixture.transport.create({ item: draft.item, key, independent: true });
  expect(created).toEqual({
    ok: true,
    id: mangaVolumeId,
    reader: {
      state: 'ready',
      href: `/en/subjects/${mangaVolumeId}/the-paper-observatory-volume-2`,
      identity: { id: mangaVolumeId, label: 'The Paper Observatory, volume 2', type: 'schema:PublicationVolume' },
    },
  });
  expect(fixture.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: '/v1/subjects',
    body: draft.item,
    key,
    authorization: 'Bearer fixture',
  });
  expect(fixture.calls.at(-1)?.path).toBe(`/v1/subjects/${mangaVolumeId}`);
  expect(fixture.reads.get(mangaVolumeId)!.subject.statements['wdt:P179']![0]).toMatchObject({
    value: { content: mangaSeriesId },
    qualifiers: [{ property: { id: 'schema:position' }, value: { content: '2' } }],
  });
  expect(fixture.reads.get(mangaSeriesId)!.subject.statements['schema:numberOfPages']).toBeUndefined();
  const current = await readMangaProfile(fixture.client, mangaVolumeId);
  if (!current.ok || !current.public) throw new Error('Expected exact native current volume');
  expect(current.releaseDigest).toBe(read.releaseDigest);
  const editor = { ...current, public: current.public, source: null };
  const pages = stageFact(
    editor,
    'schema:numberOfPages',
    current.public.subject.statements['schema:numberOfPages']![0]!.id,
  )!;
  const unchanged = stageFact(editor, 'schema:isbn', current.public.subject.statements['schema:isbn']![0]!.id)!;
  pages.statement.value = { type: 'value', content: { amount: '+196', unit: '1' } };
  const sealed = sealFacts(mangaVolumeId, read.release, [pages, unchanged]);
  expect(sealed[1]!.command).toBeUndefined();
  const results: unknown[] = [];
  await sendFacts(sealed, fixture.propose, (_property, result) => results.push(result));
  expect(results[0]).toMatchObject({ ok: true, kind: 'proposed-awaiting-review' });
  expect(fixture.calls.filter((call) => call.method === 'POST').at(-1)?.body).toEqual({ statement: pages.statement });
  expect(statementInput(current.public.subject.statements['wdt:P179']![0]!).qualifiers).toEqual(
    volume.statements['wdt:P179']![0]!.qualifiers,
  );
  expect(fixture.reads.get(mangaVolumeId)!.subject.statements['schema:numberOfPages']![0]!.value).toEqual({
    type: 'value',
    content: { amount: '+192', unit: '1' },
  });
});

test('Manga creation retains exact native command on uncertain delivery and rejects unsupported or stale grain', async () => {
  const fixture = mangaFixture('uncertain');
  const command = { key: crypto.randomUUID(), item: mangaExample(), independent: false };
  expect(await fixture.transport.create(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.create(command)).toMatchObject({ ok: true, id: mangaSeriesId });
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  const unsupported = mangaExample();
  unsupported.statements['schema:numberOfPages'] = mangaExample(true).statements['schema:numberOfPages']!;
  expect(validateManga(fixture.release, unsupported, 'en').length).toBeGreaterThan(0);
  const volume = mangaExample(true);
  volume.statements['wdt:P179']![0]!.qualifiers![0]!.value = { type: 'value', content: '0' };
  expect(validateManga(fixture.release, volume, 'en').length).toBeGreaterThan(0);
  const missing = mangaExample(true);
  delete missing.statements['wdt:P179'];
  expect(await fixture.transport.create({ key: crypto.randomUUID(), item: missing, independent: true })).toMatchObject({
    ok: false,
    reason: 'invalid',
  });
  delete fixture.release.types['schema:ComicSeries'];
  expect(await fixture.transport.create({ ...command, key: crypto.randomUUID() })).toMatchObject({
    ok: false,
    reason: 'invalid',
  });
  expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
});
