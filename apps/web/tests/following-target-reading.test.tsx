import { expect, test } from 'bun:test';
import { follow, mountFollowing, page } from './helpers/following-reading';
import { prepareFollowing } from '../src/library/following-reading/presentation';

test('one native-order index at 1/10/20 rows; repeated exact selections do not prepare identities again', () => {
  for (const n of [1, 10, 20]) {
    let presentations = 0;
    const follows = Array.from({ length: n }, (_, i) => {
      const row = follow(i % 2 ? 'collection' : 'subject', `target-${i}`);
      Object.defineProperty(row.target, 'label', { get: () => { presentations++; return `Native ${i}`; } });
      return row;
    });
    const index = prepareFollowing(page(...follows), 'en');
    expect(index.rows.map(row => row.follow.targetId)).toEqual(follows.map(row => row.targetId));
    expect(index.byId.size).toBe(n);
    expect(presentations).toBe(n);
    for (let i = 0; i < 100; i++) expect(index.byId.get(`target-${i % n}`)?.follow).toBe(follows[i % n]);
    expect(presentations).toBe(n);
  }
});

test('inspect supplied Subject, Collection and unavailable identity without point reads or guessed destinations', async () => {
  let reads = 0;
  const subject = follow('subject', 'subject-id');
  const collection = follow('collection', 'collection-id');
  const missing = { ...follow('space', 'missing-id'), target: null };
  const h = await mountFollowing(page(subject, collection, missing), async input => { reads++; return { ...input, result: { state: 'unavailable' } }; });
  try {
    expect(reads).toBe(0);
    for (const row of [subject, collection]) {
      await h.inspect(row.targetId);
      const panel = h.host.querySelector('[role="dialog"]')!;
      expect(panel.textContent).toContain(row.target!.label as string);
      expect(panel.querySelector('a')?.getAttribute('href')).toContain(row.targetType === 'subject' ? '/en/subjects/subject-id/' : '/en/collections/collection-id');
    }
    const missingRow = h.host.querySelector('[data-follow-target-type="space"]')!;
    await h.settle(() => missingRow.querySelector<HTMLButtonElement>('button[aria-label^="Inspect "]')!.click());
    const panel = h.host.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain('public identity is currently unavailable');
    expect(panel.querySelector('a')).toBeNull();
    expect(panel.textContent).toContain('Followed Space ID');
    expect(panel.textContent).toContain('missing-id');
    expect(reads).toBe(0);
  } finally { await h.dispose(); }
});
