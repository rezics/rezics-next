import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createSharedSummaryCoverFixture } from './support/shared-summary-cover-fixture.ts';
import { costOf } from '../support/growth.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';

const fenceReads = (statements: readonly string[]) =>
  statements.filter((sql) => sql.includes('content.source_fences AS stored'));

// All records and images come from the ordinary bulk/media producers. Deliberately
// collide source homes so the 100-tuple chunk is exercised, rather than merely
// returning >100 IDs from a source-only LIMIT.
test('256 raw summary inputs batch shared tuples and 101 distinct selected tuples across separately released homes', async () => {
  const f = await createSharedSummaryCoverFixture();
  try {
    const first = await f.seedCover();
    const home = f.tupleHome(first);
    const records = [first];
    let serial = 0;
    while (records.length < 101) {
      const source = f.source(`chunk-${serial++}`, 'cover');
      if (f.tupleHome({ id: '', media: '', source }) === home) records.push(await f.seedCover(source));
    }
    const shared = await f.seedCover(first.source);
    let otherSource = f.source(undefined, 'cover');
    while (f.tupleHome({ id: '', media: '', source: otherSource }) === home) otherSource = f.source(undefined, 'cover');
    const other = await f.seedCover(otherSource);
    records.push(shared, other);
    await f.converge(records.map((record) => record.id));
    await f.pauseProjection();
    const ids = [
      ...records.map((record) => record.id),
      ...Array.from({ length: 256 - records.length }, () => first.id),
    ];
    const before = await f.capture(() => f.shared(ids));
    expect(before.value.size).toBe(records.length);
    for (const record of records) expect(before.value.get(record.id)?.cover?.media).toBe(record.media);
    expect(fenceReads(before.capture.statements)).toHaveLength(3);
    expect(f.readerPool.options.max).toBe(1);
    expect((await f.takeDown(first, 'cover')).status).toBe(200);
    const after = await f.capture(() => f.shared(ids));
    expect(after.value.get(first.id)?.cover).toBeNull();
    expect(after.value.get(shared.id)?.cover).toBeNull();
    for (const record of records.filter((record) => record !== first && record !== shared))
      expect(after.value.get(record.id)).toEqual(before.value.get(record.id));
    expect(fenceReads(after.capture.statements)).toHaveLength(3);
    const queries = f.nativeQueryCount();
    await expect(f.shared([...ids, first.id])).rejects.toBeInstanceOf(RangeError);
    expect(f.nativeQueryCount()).toBe(queries);
    const directory = new URL('../../../../.temp/goal/semantic/shared-summary-cover/', import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(
      new URL('native-batch.json', directory),
      JSON.stringify(
        {
          rawIds: ids.length,
          tuples: 102,
          home,
          before: before.capture,
          after: after.capture,
          costs: {
            before: costOf(before.capture),
            after: costOf(after.capture),
          },
        },
        null,
        2,
      ),
    );
    console.info(
      `shared-cover-native-batch ${JSON.stringify({ rawIds: ids.length, tuples: 102, fenceReads: 3, before: costOf(before.capture), after: costOf(after.capture) })}`,
    );
  } finally {
    await f.close();
  }
}, 600_000);

test('native image rank, representative language, suitability and later current denial retain their selection semantics', async () => {
  const f = await createSharedSummaryCoverFixture();
  try {
    const normal = await f.seedCover();
    const preferredSource = f.source(undefined, 'cover');
    const preferredMedia = await f.importCover(normal.id, preferredSource);
    const preferred = await f.propose(normal.id, 'schema:image', preferredMedia, preferredSource);
    const deprecatedSource = f.source(undefined, 'cover');
    const deprecatedMedia = await f.importCover(normal.id, deprecatedSource);
    const deprecated = await f.propose(normal.id, 'schema:image', deprecatedMedia, deprecatedSource);
    await f.select(normal.id, 'schema:image', [
      { candidate: normal.candidate, rank: 'normal' },
      { candidate: preferred, rank: 'preferred' },
    ]);
    // Native admission excludes deprecated selections rather than persisting
    // a deprecated current image. Exercise that real boundary without seeding facts.
    const rejected = await f.selectDeprecatedImage(normal.id, deprecated);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).errors).toContainEqual({
      pointer: '/selection/0/rank',
      code: 'unsupported',
    });
    const japanese = await f.seedCover(undefined, 'bf:Instance');
    const english = await f.seedCover(undefined, 'bf:Instance');
    const work = await f.create();
    const ja = await f.propose(work.id, 'rezics:representativeEdition', japanese.id, work.source, [
      {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'ja' },
      },
    ]);
    const en = await f.propose(work.id, 'rezics:representativeEdition', english.id, work.source, [
      {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'en' },
      },
    ]);
    await f.select(work.id, 'rezics:representativeEdition', [
      { candidate: en, rank: 'normal' },
      { candidate: ja, rank: 'normal' },
    ]);
    await f.converge([normal.id, japanese.id, english.id, work.id]);
    const before = (await f.shared([normal.id])).get(normal.id)!;
    expect(before.cover?.media).toBe(preferredMedia);
    expect((await f.shared([work.id], ['ja'])).get(work.id)?.cover?.media).toBe(japanese.media);
    const enBefore = (await f.shared([work.id], ['en'])).get(work.id)!;
    expect(enBefore.cover?.media).toBe(english.media);
    const suitable = (await f.shared([work.id], ['en'], () => false)).get(work.id)!;
    expect(suitable).toEqual({ ...enBefore, cover: null });
    await f.pauseProjection();
    expect((await f.takeDown({ ...normal, source: deprecatedSource }, 'cover')).status).toBe(200);
    expect((await f.shared([normal.id])).get(normal.id)).toEqual(before);
    expect((await f.takeDown({ ...normal, source: preferredSource }, 'cover')).status).toBe(200);
    expect((await f.shared([normal.id])).get(normal.id)).toEqual({
      ...before,
      cover: null,
    });
    await f.takeDownMedia(japanese.media);
    expect((await f.shared([work.id], ['ja'])).get(work.id)?.cover).toBeNull();
    expect((await f.shared([work.id], ['en'])).get(work.id)).toEqual(enBefore);
    await f.takeDownSubject(english.id);
    expect((await f.shared([english.id])).get(english.id)).toBeNull();
    expect((await f.shared([work.id], ['en'])).get(work.id)?.cover).toBeNull();
  } finally {
    await f.close();
  }
}, 180_000);

test('moved native tuple custody never supplies an unfenced proof', async () => {
  const f = await createSharedSummaryCoverFixture();
  try {
    const record = await f.seedCover();
    expect((await f.shared([record.id])).get(record.id)?.cover?.media).toBe(record.media);
    await f.converge([record.id]);
    await f.pauseProjection();
    const home = f.tupleHome(record);
    // A fixture-owned native partition move is infrastructure state, not a source
    // fence, media readiness bit, Access substitute or expected-summary producer.
    await f.runtime.database.admin.query(
      "UPDATE core.partition SET write_state='moved',moved_to='other-native-home' WHERE partition_no=$1",
      [home],
    );
    await expect(f.shared([record.id])).rejects.toBeInstanceOf(CommandUnavailableError);
  } finally {
    await f.close();
  }
}, 180_000);
