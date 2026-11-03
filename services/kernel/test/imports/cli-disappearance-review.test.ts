import { expect, test } from 'bun:test';
import { feed, openDisappearanceReviewCli, records } from './cli-disappearance-review.ts';

test('an operator reviews a native mass-disappearance stop, repairs the capture, and advances only the corrected import', async () => {
  const f = await openDisappearanceReviewCli();
  try {
    const initial = await f.invoke(feed());
    expect(initial.code, JSON.stringify(initial)).toBe(0);
    const before = f.inspect();
    expect(before.source.count).toBe(5);
    expect(before.active).toBeNull();
    const baselineGeneration = before.source.generation;
    if (typeof baselineGeneration !== 'string') throw new Error('Missing completed baseline generation');
    const bound = before.records.map((row) => {
      expect(row.claim?.state).toBe('bound');
      if (row.claim?.state !== 'bound') throw new Error('Missing native CLI binding');
      return row.claim.subject;
    });
    expect(new Set(bound).size).toBe(5);

    const truncated = feed(records.slice(0, 3));
    const stopped = await f.invoke(truncated);
    expect(stopped.code).toBe(3);
    expect(stopped.exchanges).toEqual([]);
    expect(stopped.stderr).toContain('Disappearance threshold exceeded');
    const halted = f.inspect();
    expect(halted.source.generation).toBe(baselineGeneration);
    expect(halted.source.count).toBe(5);
    expect(halted.active).toBeNull();
    expect(halted.records.map((row) => row.claim)).toEqual(before.records.map((row) => row.claim));
    const stoppedGeneration = f.lastGeneration();
    expect(stoppedGeneration.status).toBe('mass-disappearance');

    const first = await f.review(stoppedGeneration.id, ['--page', 'missing', '--limit', '1']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.network).toEqual([]);
    expect(first.openHandles).toBe(0);
    const document = JSON.parse(first.stdout) as {
      generation: { status: string; input: string; counts: { prior: number; missing: number }; comparedBaseline: { generation: string } };
      evidence: { availability: string };
      page: { rows: { recordKey: string }[]; end: string; nextCursor: string };
      authority: { disappearanceApproval: string; thresholdChange: string; transport: string };
    };
    expect(document.generation.status).toBe('mass-disappearance');
    expect(document.generation.input).toBe('complete');
    expect(document.generation.comparedBaseline.generation).toBe(baselineGeneration);
    expect(document.generation.counts).toMatchObject({ prior: 5, missing: 2 });
    expect(document.evidence.availability).toBe('complete');
    expect(document.page.rows).toHaveLength(1);
    expect(document.authority).toMatchObject({
      disappearanceApproval: 'none',
      thresholdChange: 'none',
      transport: 'none',
    });

    const next = await f.review(stoppedGeneration.id, [
      '--page',
      'missing',
      '--limit',
      '1',
      '--cursor',
      document.page.nextCursor,
    ]);
    expect(next.code, next.stdout + next.stderr).toBe(0);
    expect(next.network).toEqual([]);
    const second = JSON.parse(next.stdout) as { page: { rows: { recordKey: string }[]; end: string } };
    expect(second.page.rows[0]!.recordKey).not.toBe(document.page.rows[0]!.recordKey);
    expect(second.page.end).toBe('end');

    const exact = await f.review(stoppedGeneration.id, ['--record', document.page.rows[0]!.recordKey]);
    expect(JSON.parse(exact.stdout).record.found).toBe(true);
    expect(JSON.parse(exact.stdout).record.nativeDeletion).toBe('not-established');

    const repaired = records.map((row, index) =>
      index === 0 ? { ...row, name: 'Corrected disappearance review catalogue 1' } : row,
    );
    const completed = await f.invoke(feed(repaired));
    expect(completed.code, JSON.stringify(completed)).toBe(0);
    expect(completed.exchanges.length).toBeGreaterThan(0);
    const after = f.inspect();
    expect(after.source.generation).not.toBe(baselineGeneration);
    expect(after.source.count).toBe(5);
    expect(after.active).toBeNull();
    for (const [index, row] of after.records.entries()) {
      expect(row.claim?.state).toBe('bound');
      if (row.claim?.state !== 'bound') throw new Error('Corrected import lost a native binding');
      expect(row.claim.subject).toBe(bound[index]);
    }
    const selected = await f.editor.read('bangumi', String(records[0]!.id));
    expect(selected.subject?.id).toBe(bound[0]);
  } finally {
    await f.close();
  }
}, 1_800_000);
