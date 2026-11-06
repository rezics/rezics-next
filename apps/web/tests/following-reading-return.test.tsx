import { expect, test } from 'bun:test';
import { deferred, follow, mountFollowing, page, realmId, spaceId } from './helpers/following-reading';

test('keyboard close restores only the current trigger; ordinary links keep the localized destination and native continuation', async () => {
  const h = await mountFollowing({ ...page(follow('subject')), next: 'opaque/page+' });
  try {
    const destination = h.host.querySelector<HTMLAnchorElement>('[data-follow-target-type="subject"] a')!;
    destination.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await h.settle(() =>
      destination.dispatchEvent(new h.window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true })),
    );
    expect(h.window.history.state.followingReturn.kind).toBe('all');
    const trigger = await h.inspect(spaceId);
    expect(h.window.document.activeElement?.id).toBe('following-inspection-title');
    const link = h.host.querySelector<HTMLAnchorElement>('[role="dialog"] a')!;
    expect(link.getAttribute('href')).toContain('/en/subjects/');
    expect(link.target).toBe('');
    await h.settle(() =>
      h.host
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.window.document.activeElement).toBe(trigger);
    expect(new URL(h.host.querySelector<HTMLAnchorElement>('nav a')!.href).searchParams.get('cursor')).toBe(
      'opaque/page+',
    );
    await h.inspect(spaceId);
    await h.settle(() => h.window.dispatchEvent(new h.window.Event('pagehide')));
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    const show = new h.window.Event('pageshow');
    Object.defineProperty(show, 'persisted', { value: true });
    await h.settle(() => h.window.dispatchEvent(show));
    expect(h.refreshes).toBe(1);
    expect(h.window.document.activeElement).toBe(trigger);
    expect(h.host.textContent).toContain('Updating this page before opening another target');
    expect(h.host.querySelector('[data-follow-target-type="subject"] a')).toBeNull();
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.replace({ ...page(follow('subject')), next: 'opaque/page+' });
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')).not.toBeNull();
    await h.router.navigate({ to: '/library/following', search: { cursor: 'new-page' } });
    await h.settle();
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await h.dispose();
  }
});

test('clipboard refusal is honest and delayed success cannot restore feedback or focus after source replacement', async () => {
  const h = await mountFollowing(page(follow('subject')));
  try {
    await h.inspect(spaceId);
    const copy = () => h.host.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Copy "]')!;
    h.window.navigator.clipboard.writeText = async () => {
      throw new Error('clipboard denied');
    };
    await h.settle(() => copy().click());
    expect(h.host.textContent).toContain('Could not copy');
    const pending = deferred<void>();
    h.window.navigator.clipboard.writeText = () => pending.promise;
    await h.settle(() => copy().click());
    const oldTrigger = h.host.querySelector<HTMLButtonElement>('button[aria-label^="Inspect "]')!;
    await h.replace(page(follow('subject')));
    await h.settle(() => pending.resolve());
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.host.textContent).not.toContain('Copied');
    expect(h.window.document.activeElement).not.toBe(oldTrigger);
    await h.inspect(spaceId);
    const accountCopy = deferred<void>();
    h.window.navigator.clipboard.writeText = () => accountCopy.promise;
    await h.settle(() => copy().click());
    await h.account('other');
    await h.settle(() => accountCopy.resolve());
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.host.textContent).not.toContain('Copied');
  } finally {
    await h.dispose();
  }
});

test('supplied Realm membership navigation suspends the private journey until a fresh Following page returns', async () => {
  const supplied = {
    ...follow('space'),
    destination: { kind: 'space' as const, spaceId, address: 'quiet / reading' },
    actions: {
      status: 'available' as const,
      resourceType: 'community.realm' as const,
      resourceId: realmId,
      viewerActions: [{ action: 'realm:join', operations: ['realm.join', 'realm.leave'] }],
    },
  };
  const h = await mountFollowing(page(supplied), async (input) => ({
    ...input,
    result: {
      state: 'ready',
      space: { spaceId, title: 'Current', summary: '', address: 'quiet / reading', realmId },
    },
  }));
  try {
    await h.inspect(spaceId);
    const action = [...h.host.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')].find((link) =>
      link.href.endsWith(`/realms/${realmId}`),
    )!;
    expect(action.getAttribute('href')).toBe(`/en/realms/${realmId}`);
    expect(action.target).toBe('');
    expect(action.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true);
    await h.settle(() => h.window.dispatchEvent(new h.window.Event('pagehide')));
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.host.querySelector('[data-follow-target-type="space"] a')).toBeNull();
    const show = new h.window.Event('pageshow');
    Object.defineProperty(show, 'persisted', { value: true });
    await h.settle(() => h.window.dispatchEvent(show));
    expect(h.refreshes).toBe(1);
    expect(h.host.textContent).toContain('Updating this page before opening another target');
    await h.replace(page(supplied));
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')).not.toBeNull();
  } finally {
    await h.dispose();
  }
});
