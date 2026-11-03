import { expect, test } from 'bun:test';
import { deferred, follow, mountFollowing, page, spaceId } from './helpers/following-reading';

test('keyboard close restores only the current trigger; ordinary links keep the localized destination and native continuation', async () => {
  const h = await mountFollowing({ ...page(follow('subject')), next: 'opaque/page+' });
  try {
    const trigger = await h.inspect(spaceId);
    expect(h.window.document.activeElement?.id).toBe('following-inspection-title');
    const link = h.host.querySelector<HTMLAnchorElement>('[role="dialog"] a')!;
    expect(link.getAttribute('href')).toContain('/en/subjects/');
    expect(link.target).toBe('');
    await h.settle(() => h.host.querySelector('[role="dialog"]')!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.window.document.activeElement).toBe(trigger);
    expect(new URL(h.host.querySelector<HTMLAnchorElement>('nav a')!.href).searchParams.get('cursor')).toBe('opaque/page+');
    await h.inspect(spaceId);
    await h.settle(() => h.window.dispatchEvent(new h.window.Event('pagehide')));
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    const show = new h.window.Event('pageshow'); Object.defineProperty(show, 'persisted', { value: true });
    await h.settle(() => h.window.dispatchEvent(show));
    expect(h.refreshes).toBe(1);
    await h.inspect(spaceId);
    await h.router.navigate({ to: '/library/following', search: { cursor: 'new-page' } });
    await h.settle();
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
  } finally { await h.dispose(); }
});

test('clipboard refusal is honest and delayed success cannot restore feedback or focus after source replacement', async () => {
  const h = await mountFollowing(page(follow('subject')));
  try {
    await h.inspect(spaceId);
    const copy = () => h.host.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Copy "]')!;
    h.window.navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
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
  } finally { await h.dispose(); }
});
