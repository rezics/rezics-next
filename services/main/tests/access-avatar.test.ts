import { expect, test } from 'bun:test';
import { baselineTarget } from '../src/modules/access/baseline.ts';

const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('G-317: avatar scope selects the Agent controller or authored Work proof', () => {
  expect(baselineTarget('media.avatar', `media:avatar:${id}`)).toEqual({ kind: 'avatar', id });
  expect(baselineTarget('media.avatar', `media:avatar:${id}:extra`)).toBeNull();
  expect(baselineTarget('media.avatar', 'media:avatar:urn:foreign')).toBeNull();
  expect(baselineTarget('work.edit', `work:edit:${id}`)).toEqual({ kind: 'author-work', id });
});
