import { Value } from 'typebox/value';
import { expect, test } from 'bun:test';
import { discussionItem } from '../src/modules/work-activity/read-contract.ts';
import { workDiscussionText } from '../src/modules/work-activity/read.ts';

const identity = {
  reply: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  realm: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  placement: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
  revisionId: '00000000-0000-4000-8000-000000000004', dataEpoch: 'epoch', sequence: '1',
};

test('Work discussion preserves the authored spoiler declaration in its optional wire field', () => {
  const marked = { ...identity, ...workDiscussionText({ body: 'Marked reply', spoiler: true }) };
  expect(marked).toEqual({ ...identity, body: 'Marked reply', spoiler: true });
  expect(Value.Check(discussionItem, marked)).toBe(true);

  const explicitlyUnmarked = { ...identity, ...workDiscussionText({ body: 'Visible reply', spoiler: false }) };
  expect(explicitlyUnmarked.spoiler).toBe(false);
  expect(Value.Check(discussionItem, explicitlyUnmarked)).toBe(true);

  const legacyUnmarked = { ...identity, ...workDiscussionText({ body: 'Visible reply' }) };
  expect('spoiler' in legacyUnmarked).toBe(false);
  expect(Value.Check(discussionItem, legacyUnmarked)).toBe(true);
  expect(() => workDiscussionText({ body: 'Invalid declaration', spoiler: 'true' }))
    .toThrow('Reply spoiler declaration is invalid');
});
