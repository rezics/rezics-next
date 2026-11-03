import { expect, test } from 'bun:test';
import { feed, openDumpPreviewCli, records } from './cli-dump-preview-fixture.ts';

test('an operator previews a changed dump against a completed baseline then imports through the ordinary CLI', async () => {
  const f = await openDumpPreviewCli();
  try {
    const initial = await f.invoke(feed());
    expect(initial.code, JSON.stringify(initial)).toBe(0);
    expect(f.inspect().source.count).toBe(5);

    const successor = records.map((row, index) =>
      index === 0 ? { ...row, name: 'Revised preview catalogue' } : row,
    );
    const previewDump = feed(successor.slice(0, 4));
    const previewed = await f.preview(previewDump);
    expect(previewed.network).toEqual([]);
    expect(previewed.openHandles).toBe(0);
    const document = JSON.parse(previewed.stdout) as {
      complete: boolean;
      counts: { changed: number; vanished: number; admitted: number };
      disappearanceWouldBlock: boolean;
      page: { kind: string; rows: { recordKey: string }[] };
    };
    expect(document.complete).toBe(true);
    expect(document.counts.admitted).toBe(4);
    expect(document.counts.vanished).toBe(1);
    expect(document.counts.changed).toBeGreaterThanOrEqual(1);
    expect(document.disappearanceWouldBlock).toBe(false);
    expect(document.page.kind).toBe('changed');
    expect(f.inspect().source.count).toBe(5);
    expect(f.inspect().active).toBeNull();

    const imported = await f.invoke(previewDump);
    expect(imported.code, JSON.stringify(imported)).toBe(0);
    const after = f.inspect();
    expect(after.source.count).toBe(4);
    expect(after.records[0]!.claim?.state).toBe('bound');
    expect(after.records[4]!.state.baseline?.state).toBe('vanished');

    const reimport = await f.invoke(previewDump);
    expect(reimport.code).toBe(0);
    expect(reimport.stdout).toContain('unchanged=4');

    const stopped = await f.invoke(feed([]));
    expect(stopped.code).toBe(3);
    expect(f.inspect().source.count).toBe(4);
  } finally {
    await f.close();
  }
}, 1_800_000);
