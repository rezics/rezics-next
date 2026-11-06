import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { Value } from 'typebox/value';
import { presentContributedPost } from '../../src/content/contribution-present.ts';
import { ContributedPostResponseSchema } from '../../src/content/schemas.ts';
import type { ItemView } from '../../src/content/reads.ts';

const id = '00000000-0000-8000-8000-123400000001';
const parentId = '00000000-0000-8000-8000-123400000002';
const authorId = '00000000-0000-8000-8000-123400000003';
const post: ItemView = {
  id,
  threadId: id,
  route: 0,
  authorId,
  parentId,
  boardId: id,
  licence: 'CC0-1.0',
  subjectIds: [],
  mediaIds: [],
  visibility: 'published',
  securityRevision: '1',
  availability: 'available',
  createdAt: '2026-11-06T00:00:00.000Z',
  revisedAt: null,
  revisionId: id,
  sha256: 'a'.repeat(64),
  body: fromPlainText('The complete retained writing.'),
  voteCitation: null,
};

test('deletion removes only author identity while unknown attribution retains the exact writing', () => {
  const unknown = presentContributedPost(post, new Map());
  expect(unknown).toEqual({ ...post, attribution: null });
  const deleted = presentContributedPost(post, new Map([[authorId, { displayName: 'Deleted account' }]]));
  const { authorId: _, ...retained } = post;
  expect(deleted).toEqual({ ...retained, attribution: { displayName: 'Deleted account' } });
  expect(Value.Check(ContributedPostResponseSchema(), { post: deleted })).toBe(true);
  expect(post.authorId).toBe(authorId);
});

test('parent attribution requires the admitted exact parent and never invents a deletion', () => {
  const identities = new Map([[authorId, { id: authorId, kind: 'actor' as const, displayName: null }]]);
  const parent = { ...post, id: parentId, parentId: null };
  expect(presentContributedPost(post, identities, parent)).toMatchObject({
    parent: { postId: parentId, attribution: { id: authorId, kind: 'actor', displayName: null } },
  });
  expect(presentContributedPost(post, identities, post)).not.toHaveProperty('parent');
  expect(presentContributedPost(post, new Map(), parent)).toMatchObject({
    parent: { postId: parentId, attribution: null },
  });
});
