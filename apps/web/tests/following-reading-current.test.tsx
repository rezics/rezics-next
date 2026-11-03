import { expect, test } from 'bun:test';
import { deferred, follow, mountFollowing, page, realmId, spaceId } from './helpers/following-reading';
import type { MineFollow } from '../src/library/mine-following';
import type { SpaceRead } from '../src/library/following-reading/space-reader';

const ready = (address: string | null, admittedRealm: string | null = realmId): SpaceRead => ({
  subject: 'owner',
  locale: 'en',
  spaceId,
  result: {
    state: 'ready',
    space: { spaceId, title: 'Current native title', summary: 'Native summary', address, realmId: admittedRealm },
  },
});

const realmActions = {
  status: 'available' as const,
  resourceType: 'community.realm' as const,
  resourceId: realmId,
  viewerActions: [{ action: 'realm:join', operations: ['realm.join', 'realm.leave'] }],
};

function projectedSpace(destination: NonNullable<MineFollow['destination']>): MineFollow {
  return { ...follow('space'), destination, actions: realmActions };
}

test('denied, preparing, unavailable, retired and ready without a destination retain the follow and retry focus', async () => {
  let reads = 0;
  const pending = deferred<SpaceRead>();
  const h = await mountFollowing(page(follow('space')), async (input) => {
    reads++;
    if (reads === 2) return pending.promise;
    return reads === 4 ? ready(null, null) : { ...input, result: { state: reads === 1 ? 'denied' : 'retired' } };
  });
  try {
    const trigger = await h.inspect(spaceId);
    expect(h.host.textContent).toContain('This community read was denied');
    const retry = () =>
      [...h.host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === 'Try again',
      )!;
    await h.settle(() => {
      retry().focus();
      retry().click();
    });
    expect(h.window.document.activeElement?.id).toBe('following-inspection-title');
    expect(h.host.textContent).toContain('Reading this community');
    expect(h.host.querySelector('[role="dialog"] a')).toBeNull();
    await h.settle(() =>
      pending.resolve({ subject: 'owner', locale: 'en', spaceId, result: { state: 'unavailable' } }),
    );
    expect(h.host.textContent).toContain('could not be read');
    await h.settle(() => retry().click());
    expect(h.host.textContent).toContain('no longer readable here');
    await h.settle(() => retry().click());
    expect(h.host.textContent).toContain('No currently readable destination');
    expect(h.host.textContent).toContain('Actions for this destination are currently unavailable');
    expect(h.host.querySelector('[role="dialog"] a')).toBeNull();
    expect(reads).toBe(4);
    await h.settle(() =>
      h.host
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(h.window.document.activeElement).toBe(trigger);
    expect(h.host.querySelector('[data-follow-target-type="space"]')).not.toBeNull();
  } finally {
    await h.dispose();
  }
});

test('at 1/10/20 follows initial reads stay zero and only the deliberately inspected community makes one point read', async () => {
  for (const n of [1, 10, 20]) {
    const pending = deferred<SpaceRead>();
    let reads = 0;
    const first = projectedSpace({ kind: 'space', spaceId, address: 'current-address' });
    const h = await mountFollowing(
      page(...Array.from({ length: n }, (_, i) => (i ? follow('space', `space-${i}`) : first))),
      () => {
        reads++;
        return pending.promise;
      },
    );
    try {
      expect(reads).toBe(0);
      await h.inspect(spaceId);
      expect(reads).toBe(1);
      expect(h.host.querySelector('[role="dialog"]')?.textContent).toContain('Reading this community');
      await h.settle(() => pending.resolve(ready('current-address')));
      const hrefs = [...h.host.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')].map((link) =>
        link.getAttribute('href'),
      );
      expect(hrefs).toContain('/en/spaces/current-address');
      expect(hrefs).toContain(`/en/realms/${realmId}`);
      expect(h.host.textContent).toContain('Native summary');
      expect(reads).toBe(1);
    } finally {
      await h.dispose();
    }
  }
});

test('same-ID fresh observations discard old address/admission; replacement, exposure and account changes retire in-flight responses', async () => {
  const pending = deferred<SpaceRead>();
  let reads = 0;
  const accountPending = deferred<SpaceRead>();
  const h = await mountFollowing(page(projectedSpace({ kind: 'space', spaceId, address: 'old-address' })), async () =>
    ++reads === 1
      ? ready('old-address')
      : reads === 2
        ? ready(null, null)
        : reads === 3
          ? pending.promise
          : reads === 4
            ? ready(null)
            : accountPending.promise,
  );
  try {
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')?.getAttribute('href')).toContain('old-address');
    await h.replace(page(projectedSpace({ kind: 'space', spaceId, address: 'new-address' })));
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')).toBeNull();
    expect(h.host.textContent).toContain('No currently readable destination');
    expect(h.host.textContent).not.toContain('old-address');
    await h.inspect(spaceId);
    await h.replace(page(projectedSpace({ kind: 'space', spaceId, address: 'new-address' })));
    await h.settle(() => pending.resolve(ready('late-address')));
    expect(h.host.textContent).not.toContain('late-address');
    await h.replace(page(projectedSpace({ kind: 'realm', realmId })));
    await h.inspect(spaceId);
    expect(
      [...h.host.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')].map((link) => link.getAttribute('href')),
    ).toContain(`/en/realms/${realmId}`);
    await h.admit([]);
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.admit();
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.inspect(spaceId);
    await h.account('other');
    await h.settle(() => accountPending.resolve(ready('old-account-address')));
    expect(h.host.textContent).not.toContain('old-account-address');
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.host.textContent).not.toContain('Current native title');
  } finally {
    await h.dispose();
  }
});
