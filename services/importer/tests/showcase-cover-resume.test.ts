import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { resumeSelectedCover, type SelectedCoverJournal } from '../src/cross-media-covers.ts';

const containerId = '00000000-0000-4000-8000-000000000301';
const owner = { source: 'bangumi_cross_media', external_id: '101' };
const intent = {
  containerId,
  sourceUrl: 'https://lain.bgm.tv/pic/cover/l/101.jpg',
} as unknown as MediaImportRequest;

test('a selected cover resumes only a journal that is not final, through the exact sealed key', async () => {
  const signature = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const key = `${owner.source}:${owner.external_id}:${signature}`;
  const cases: [string, SelectedCoverJournal | null, 'absent' | 'final' | 'resumed'][] = [
    ['no sealed journal', null, 'absent'],
    ['prepared request', { accepted: null, status: null }, 'resumed'],
    ['accepted reservation', { accepted: {}, status: { media: { state: 'reserved' } } }, 'resumed'],
    ['available media', { accepted: {}, status: { media: { state: 'available' } } }, 'final'],
    ['rejected media', { accepted: {}, status: { media: { state: 'rejected' } } }, 'final'],
  ];
  for (const [name, journal, outcome] of cases) {
    const lookups: string[] = [];
    const resolutions: Record<string, unknown>[] = [];
    const result = await resumeSelectedCover(
      {
        bindings: {
          mediaPending(target, lookup) {
            expect(target).toEqual(owner);
            lookups.push(lookup);
            return journal;
          },
        },
        resolver: {
          async resolve(input) {
            resolutions.push(input as unknown as Record<string, unknown>);
            return { status: 'pending' };
          },
        },
      },
      { owner, containerId, intent, signal: AbortSignal.timeout(1000) },
    );
    expect(result, name).toBe(outcome);
    expect(lookups, name).toEqual([key]);
    expect(resolutions, name).toHaveLength(outcome === 'resumed' ? 1 : 0);
    if (outcome === 'resumed')
      expect(resolutions[0]).toMatchObject({
        owner,
        subject: containerId,
        mediaImportIntents: [intent],
        deferPending: false,
      });
  }
});
