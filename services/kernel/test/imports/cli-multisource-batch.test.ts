import { expect, test } from 'bun:test';
import { openMultisourceBatchCli } from './cli-multisource-batch.ts';

test('An operator previews and deliberately runs a bounded explicit local manifest of distinct configured launch-source imports, sees independent native outcomes and a truthful stopped/remaining summary, then reruns through ordinary per-source recovery without duplicate subjects or weakened authority.', async () => {
  const f = await openMultisourceBatchCli();
  try {
    const previewed = await f.preview();
    expect(previewed.code).toBe(0);
    expect(previewed.network).toEqual([]);
    expect(previewed.openHandles).toBe(0);
    expect(f.inspect('bangumi', String(f.bangumiRecords[0]!.id)).count).toBe(0);
    expect(f.inspect('catalogue-ol', f.libraryRecords[0]!.key).count).toBe(0);
    expect(f.inspect('wikidata', f.wikidataRecords[0]!.id).count).toBe(0);

    const first = await f.runBatch();
    expect(first.code, first.stderr).toBe(0);
    expect(
      first.document.jobs.map((job: { sourceAlias: string; status: string }) => [job.sourceAlias, job.status]),
    ).toEqual([
      ['bangumi', 'completed'],
      ['catalogue-ol', 'completed'],
      ['wikidata', 'completed'],
    ]);
    const bangumi = f.inspect('bangumi', String(f.bangumiRecords[0]!.id));
    const library = f.inspect('catalogue-ol', f.libraryRecords[0]!.key);
    const wikidata = f.inspect('wikidata', f.wikidataRecords[0]!.id);
    expect(bangumi.count).toBe(3);
    expect(library.count).toBe(3);
    expect(wikidata.count).toBe(2);
    expect(bangumi.claim?.state).toBe('bound');
    expect(library.claim?.state).toBe('bound');
    const bangumiSubject = bangumi.subject;
    const librarySubject = library.subject;
    expect(bangumiSubject).toBeTruthy();
    expect(librarySubject).toBeTruthy();
    expect(bangumiSubject).not.toBe(librarySubject);
    const bangumiRead = await f.readSubject(bangumiSubject!);
    const libraryRead = await f.readSubject(librarySubject!);
    expect(bangumiRead.status).toBe(200);
    expect(libraryRead.status).toBe(200);
    expect(first.exchanges.every((exchange) => ['bangumi', 'catalogue-ol', 'wikidata'].includes(exchange.source))).toBe(
      true,
    );

    const repeat = await f.runBatch();
    expect(repeat.code).toBe(0);
    expect(f.inspect('bangumi', String(f.bangumiRecords[0]!.id)).subject).toBe(bangumiSubject);
    expect(f.inspect('catalogue-ol', f.libraryRecords[0]!.key).subject).toBe(librarySubject);

    await f.reviseOpenLibrary();
    const lost = await f.runBatch(true);
    expect([1, 130]).toContain(lost.code);
    expect(lost.document.jobs.map((job: { status: string }) => job.status)).toEqual([
      'completed',
      'stopped',
      'not-started',
    ]);
    expect(lost.document.notStarted).toEqual([{ index: 3, name: 'wikidata-launch' }]);
    expect(f.inspect('bangumi', String(f.bangumiRecords[0]!.id)).subject).toBe(bangumiSubject);
    expect(f.inspect('wikidata', f.wikidataRecords[0]!.id).subject).toBe(wikidata.subject);
    const afterLoss = f.inspect('catalogue-ol', f.libraryRecords[0]!.key);
    const journal = afterLoss.journals.find((row) => row.acknowledgement === null);
    const pending = afterLoss.pending[0];
    const originalBytes = journal?.bytes ?? pending?.bytes;
    const originalKey = journal?.key ?? pending?.keys[0];
    expect(originalBytes).toBeTruthy();
    expect(originalKey).toBeTruthy();

    const recovered = await f.recoverOpenLibrary();
    expect(recovered.code, recovered.stderr).toBe(0);
    const afterRecovery = f.inspect('catalogue-ol', f.libraryRecords[0]!.key);
    expect(afterRecovery.subject).toBe(librarySubject);
    expect(afterRecovery.journals.some((row) => row.key === originalKey && row.bytes === originalBytes)).toBe(true);

    const rerun = await f.runBatch();
    expect(rerun.code).toBe(0);
    expect(f.inspect('bangumi', String(f.bangumiRecords[0]!.id)).subject).toBe(bangumiSubject);
    expect(f.inspect('catalogue-ol', f.libraryRecords[0]!.key).subject).toBe(librarySubject);
    expect(f.inspect('bangumi', String(f.bangumiRecords[0]!.id)).candidates.length).toBe(bangumi.candidates.length);
    expect((await f.readSubject(bangumiSubject!)).status).toBe(200);
  } finally {
    await f.close();
  }
}, 1_800_000);
