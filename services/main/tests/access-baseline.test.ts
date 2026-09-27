import { expect, test } from 'bun:test';
import { baselineTarget } from '../src/modules/access/baseline.ts';

const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('baseline vocabulary excludes moderation, adoption, Realm management and future actions', () => {
  for (const [action, scope] of [
    ['publication.adopt', `publication:adopt:${id}`],
    ['publication.reject', `publication:reject:${id}`],
    ['translation.authorize', `translation:link:${id}`],
    ['statement.decide', 'classification:decide:global'],
    ['classification.decision.set', 'classification:decide:global'],
    ['rating.context.create', `rating:context:${id}`],
    ['rating.context.policy.set', `rating:policy:${id}`],
    ['work.create.future', 'work:create:root'],
    ['work.create', `work:create:${id}`],
    ['collection.edit', `collection:edit:${id}:extra`],
    ['collection.edit', 'collection:edit:https://attacker.example/id'],
    ['constructor', 'constructor'],
  ]) expect(baselineTarget(action!, scope!)).toBeNull();
});

test('selection and reply drafts have narrow target kinds, not generic public-Work authority', () => {
  expect(baselineTarget('publication.select', `publication:select:${id}`)).toEqual({ kind: 'maintainer', id });
  expect(baselineTarget('reply.create', `reply:create:${id}`)).toEqual({ kind: 'reply', id });
  expect(baselineTarget('content.draft', `content:draft:${id}`)).toEqual({ kind: 'reply-draft', id });
});

test('personal Statements and global observations use distinct scope families', () => {
  expect(baselineTarget('statement.record', `statement:speak:${id}`)).toEqual({ kind: 'personal', id });
  expect(baselineTarget('statement.withdraw', `statement:speak:${id}`)).toEqual({ kind: 'personal', id });
  expect(baselineTarget('rating.observation.set', `rating:observe:${id}`)).toEqual({ kind: 'rating', id });
  expect(baselineTarget('statement.record', `classification:decide:${id}`)).toBeNull();
});
