import { expect, test } from 'bun:test';
import {
  definedViews,
  planReads,
  platformRegistry,
  readCost,
  resolveView,
  templateViews,
  validateProfile,
  type PresentationProfile,
} from '../src/index.ts';
import platform from '../profiles/platform.json' with { type: 'json' };

const profile = platform as unknown as PresentationProfile;
const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e30';
const account = { id: '018f0000-0000-7000-8000-00a000000001', handle: 'agent_1' };
const agents = ['schema:Person', 'schema:Organization'];
const entry = (type: string) => profile.types.find((candidate) => candidate.type === type)!;

test('the agent templates define the account views beside the graph views, in the documented order', () => {
  expect(validateProfile(platformRegistry, profile)).toEqual([]);
  const person = templateViews(entry('schema:Person'));
  expect(person.overview?.content.map((node) => node.props.id).join(',')).toBe(
    'header,summary,author,illustrator,director,music,voice-roles,side-stories,adaptations,versions,related,account-posts,account-reviews,account-collections,threads,lists,sources',
  );
  expect(person.details?.content.map((node) => node.type).join(',')).toBe('MoreStatements,Sources');
  expect(definedViews(profile, { type: 'schema:Person' })).toEqual([
    'overview',
    'characters',
    'works',
    'relations',
    'posts',
    'reviews',
    'discussion',
    'lists',
    'collections',
    'details',
  ]);
  expect(definedViews(profile, { type: 'schema:Organization' })).toEqual([
    'overview',
    'works',
    'relations',
    'posts',
    'reviews',
    'discussion',
    'lists',
    'collections',
    'details',
  ]);
});

test('each account view is one bounded page of its list, and the overview previews a few of each', () => {
  for (const type of agents) {
    const views = templateViews(entry(type));
    const read = (view: 'posts' | 'reviews' | 'collections') =>
      Object.values(planReads(platformRegistry, views[view]!, { subject, account }).reads);
    expect(read('posts')).toEqual([{ kind: 'accountPosts', id: account.id, limit: 20 }]);
    expect(read('reviews')).toEqual([{ kind: 'accountThreads', id: account.id, threadKind: 'review', limit: 20 }]);
    expect(read('collections')).toEqual([{ kind: 'accountCollections', id: account.id, limit: 24 }]);
    const preview = Object.values(planReads(platformRegistry, views.overview!, { subject, account }).reads);
    expect(preview).toContainEqual({ kind: 'account', handle: account.handle });
    expect(preview).toContainEqual({ kind: 'accountPosts', id: account.id, limit: 4 });
    expect(preview).toContainEqual({ kind: 'accountThreads', id: account.id, threadKind: 'review', limit: 4 });
    expect(preview).toContainEqual({ kind: 'accountCollections', id: account.id, limit: 3 });
    expect(preview.length).toBeLessThanOrEqual(16);
    expect(preview.map(readCost).reduce((sum, cost) => sum + cost, 0)).toBeLessThanOrEqual(128);
  }
});

test('an agent without an account plans no account read, and an account view resolves for a person subject', () => {
  for (const type of agents) {
    const reads = Object.values(planReads(platformRegistry, templateViews(entry(type)).overview!, { subject }).reads);
    expect(reads.some((read) => read.kind.startsWith('account'))).toBe(false);
  }
  expect(resolveView(profile, { type: 'schema:Person' }, 'posts')).toMatchObject({
    scope: 'type',
    key: 'schema:Person',
  });
  expect(resolveView(profile, { type: 'schema:Recipe' }, 'posts')).toBeNull();
});
