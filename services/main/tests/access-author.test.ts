import { expect, test } from 'bun:test';
import { baselineTarget } from '../src/modules/access/baseline.ts';

const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
test('author baseline uses exact resource scopes and a closed action vocabulary', () => {
  for (const [action, prefix] of [['work.edit', 'work:edit'], ['content.publish', 'content:publish'],
    ['content.search-eligibility', 'content:search-eligibility']]) {
    expect(baselineTarget(action!, `${prefix}:${id}`)).toEqual({ kind: 'author-work', id });
    expect(baselineTarget(action!, `${prefix}:urn:rezics:variant:00000000-0000-4000-8000-000000000001`)).toBeNull();
    expect(baselineTarget(action!, `${prefix}:${id}:extra`)).toBeNull();
  }
  expect(baselineTarget('media.avatar', `media:avatar:${id}`)).toEqual({ kind: 'avatar', id });
  expect(baselineTarget('submission.submit', `submission:submit:${id}`)).toEqual({ kind: 'submission', id });
  expect(baselineTarget('media.upload', `media:owner:${id}`)).toEqual({ kind: 'personal', id });
  for (const [action, scope] of [['media.manage', `media:owner:${id}`],
    ['submission.withdraw', `submission:submit:${id}`], ['review.decide', `review:decide:${id}`]]) {
    expect(baselineTarget(action!, scope!)).toBeNull();
  }
});
