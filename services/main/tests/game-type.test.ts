import { expect, test } from 'bun:test';
import { checkedWorkTypes } from '../src/modules/work/type-schema.ts';
import { metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { workKinds } from '../src/modules/work/work-kinds.ts';

const game = 'https://schema.org/VideoGame';

test('a VideoGame is admitted at creation and type change with an external visit intent', () => {
  expect(metadataWorkRequestDigest('Stardew Valley', [game])).toMatch(/^[0-9a-f]{64}$/);
  expect(checkedWorkTypes([game])).toEqual([game]);
  expect(workKinds[game]).toEqual({ interest: 'media', primaryAction: 'visit' });
  expect(() => checkedWorkTypes([game, 'https://schema.org/SoftwareApplication'])).toThrow();
});
