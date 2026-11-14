import { expect, test } from 'bun:test';
import { follow, mountFollowing, page, realmId, spaceId } from './helpers/following-reading';
import { prepareFollowing } from '../src/library/following-reading/presentation';

test('one native-order index at 1/10/20 rows; repeated exact selections do not prepare identities again', () => {
  for (const n of [1, 10, 20]) {
    let presentations = 0;
    const follows = Array.from({ length: n }, (_, i) => {
      const row = follow(i % 2 ? 'collection' : 'subject', `target-${i}`);
      Object.defineProperty(row.target, 'label', {
        get: () => {
          presentations++;
          return `Native ${i}`;
        },
      });
      return row;
    });
    const index = prepareFollowing(page(...follows), 'en');
    expect(index.rows.map((row) => row.follow.targetId)).toEqual(follows.map((row) => row.targetId));
    expect(index.byId.size).toBe(n);
    expect(presentations).toBe(n);
    for (let i = 0; i < 100; i++) expect(index.byId.get(`target-${i % n}`)?.follow).toBe(follows[i % n]);
    expect(presentations).toBe(n);
  }
});

test('a mixed twenty-row page inspects supplied Subject, Collection and missing identity without initial point reads', async () => {
  let reads = 0;
  const subject = follow('subject', 'subject-id');
  const collection = follow('collection', 'collection-id');
  const missing = { ...follow('space', 'missing-id'), target: null };
  const suppliedSpace = {
    ...follow('space', spaceId),
    destination: { kind: 'space' as const, spaceId, address: 'quiet / reading' },
    actions: {
      status: 'available' as const,
      resourceType: 'community.realm' as const,
      resourceId: realmId,
      viewerActions: [{ action: 'realm:join', operations: ['realm.join', 'realm.leave'] }],
    },
  };
  const follows = [
    subject,
    collection,
    suppliedSpace,
    missing,
    ...Array.from({ length: 16 }, (_, i) =>
      follow((['space', 'subject', 'collection'] as const)[i % 3]!, `mixed-${i}`),
    ),
  ];
  const h = await mountFollowing(page(...follows), async (input) => {
    reads++;
    return { ...input, result: { state: 'unavailable' } };
  });
  try {
    expect(reads).toBe(0);
    expect(
      [...h.host.querySelectorAll('[data-follow-target-type]')].map((row) =>
        row.getAttribute('data-follow-target-type'),
      ),
    ).toEqual(follows.map((row) => row.targetType));
    expect(h.host.querySelector<HTMLAnchorElement>(`[data-follow-target-type="space"] a`)?.getAttribute('href')).toBe(
      '/en/spaces/quiet%20%2Freading',
    );
    expect(h.host.querySelector(`[data-follow-target-type="space"] a`)?.getAttribute('href')).not.toContain(spaceId);
    for (const row of [subject, collection]) {
      await h.inspect(row.targetId);
      const panel = h.host.querySelector('[role="dialog"]')!;
      expect(panel.textContent).toContain(row.target!.label as string);
      expect(panel.querySelector('a')?.getAttribute('href')).toContain(
        row.targetType === 'subject' ? '/en/subjects/subject-id/' : '/en/collections/collection-id',
      );
    }
    const missingRow = h.host.querySelectorAll('[data-follow-target-type="space"]')[1]!;
    await h.settle(() => missingRow.querySelector<HTMLButtonElement>('button[aria-label^="Inspect "]')!.click());
    const panel = h.host.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain('public identity is currently unavailable');
    expect(panel.querySelector('a')).toBeNull();
    expect(panel.textContent).toContain('Followed Space ID');
    expect(panel.textContent).toContain('missing-id');
    expect(reads).toBe(0);
  } finally {
    await h.dispose();
  }
});

test('Collection exposure withdrawal retires retained links and inspection without losing the follow', async () => {
  const h = await mountFollowing(page(follow('collection')));
  try {
    await h.inspect(spaceId);
    const link = h.host.querySelector<HTMLAnchorElement>('[role="dialog"] a')!;
    await h.settle(() => {
      h.client.setQueriesData(
        { predicate: ({ queryKey }) => queryKey[0] === 'exposure' && queryKey[1] === 'viewer' },
        { subject: 'owner', admitted: ['personal_library'] },
      );
      expect(link.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    });
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')).toBeNull();
    expect(h.host.textContent).toContain('Actions for this destination are currently unavailable');
    expect(h.host.querySelector('[data-follow-target-type="collection"]')).not.toBeNull();
  } finally {
    await h.dispose();
  }
});

test('identity leads independent Open and Inspect controls; current prose precedes disclosed references and command meaning', async () => {
  let reads = 0;
  const supplied = {
    ...follow('space'),
    reason: 'membership' as const,
    destination: { kind: 'space' as const, spaceId, address: 'quiet-reading' },
  };
  const h = await mountFollowing(page(supplied), async (input) => {
    reads++;
    return {
      ...input,
      result: {
        state: 'ready',
        space: {
          spaceId,
          realmId,
          title: 'The current reading circle',
          summary: 'Read slowly together.',
          address: 'quiet-reading',
        },
      },
    };
  });
  try {
    const row = h.host.querySelector<HTMLElement>('[data-follow-target]')!;
    const open = row.querySelector<HTMLAnchorElement>('[data-content-item-slot="trailing"] a')!;
    expect(open.getAttribute('aria-label')).toBe('Open space title');
    expect(open.getAttribute('href')).toBe('/en/spaces/quiet-reading');
    expect(open.closest('button')).toBeNull();
    expect(row.textContent).not.toContain('Required by membership');
    expect(row.textContent).not.toContain(spaceId);
    expect(reads).toBe(0);
    const inspect = await h.inspect(spaceId);
    expect(inspect.getAttribute('aria-expanded')).toBe('true');
    expect(inspect.getAttribute('aria-controls')).toBe('following-inspection');
    expect(row.dataset.followingSelected).toBe('true');
    const panel = h.host.querySelector<HTMLElement>('[role="dialog"]')!;
    const current = panel.querySelector<HTMLElement>('[data-following-current-identity]')!;
    expect(current.textContent).toContain('The current reading circle');
    expect(current.textContent).toContain('Read slowly together.');
    const details = panel.querySelector<HTMLDetailsElement>('details')!;
    expect(details.open).toBe(false);
    expect(current.compareDocumentPosition(details) & h.window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await h.settle(() => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain(spaceId);
    expect(details.textContent).toContain('Required by membership');
    expect(details.textContent).toContain('Removing this follow does not leave a community');
    expect(reads).toBe(1);
    await h.settle(() => panel.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(inspect.getAttribute('aria-expanded')).toBe('false');
    expect(row.dataset.followingSelected).toBeUndefined();
    expect(h.window.document.activeElement).toBe(inspect);
  } finally {
    await h.dispose();
  }
});
