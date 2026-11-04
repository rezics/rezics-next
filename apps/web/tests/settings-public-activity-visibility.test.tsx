import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { ProfileEditor, type ProfileAttempt } from '../src/settings/profile-write';
import { observeProfile, type ProfileValues } from '../src/settings/profile-data';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('explicit activity save recovers refusal and uncertainty without losing later choices or sharing preview writes', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://rezics.test/settings#profile' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ProfileCard } = await import('../src/settings/profile');
  const { PublicViewsCard } = await import('../src/settings/public-views');
  let current: ProfileValues = observeProfile({
    accountId: '019a0000-0000-7000-8000-000000000001',
    kind: 'organization',
    displayName: 'Original',
    biography: null,
    avatar: null,
    links: [],
    speakersListed: true,
    publicViews: { posts: true, reviews: true, collections: true, realms: true },
  });
  const sent: ProfileAttempt[] = [];
  const editor = new ProfileEditor(
    {
      read: async () => current,
      save: async (attempt) => {
        sent.push(attempt);
        if (sent.length === 1) return { ok: false, status: 409, message: '' };
        if (sent.length === 2) throw new Error('Response lost');
        current = {
          ...current,
          ...attempt.patch,
          publicViews: { ...current.publicViews, ...attempt.patch.publicViews },
          avatar: current.avatar,
        };
        return { ok: true, profile: current };
      },
    },
    current,
  );
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!;
  const toggle = (label: string) =>
    [...host.querySelectorAll('label')]
      .find((element) => element.textContent === label)!
      .querySelector<HTMLButtonElement>('[role="switch"]')!;
  const click = (element: HTMLElement) => act(() => element.click());
  try {
    await act(() =>
      root.render(
        <>
          <ProfileCard editor={editor} previewActive />
          <PublicViewsCard editor={editor} />
        </>,
      ),
    );
    const posts = toggle(m.settings_public_posts());
    await click(posts);
    await click(toggle(m.settings_public_speakers()));
    expect(sent).toHaveLength(0);
    expect(host.textContent).toContain(m.settings_public_activity_unsaved());
    await click(button(m.settings_profile_preview_open()));
    await act(() => editor.edit({ biography: 'Local biography' }));
    await click(button(m.settings_profile_preview_close()));
    expect(sent).toHaveLength(0);
    expect(posts.getAttribute('aria-checked')).toBe('false');
    expect(editor.snapshot().known?.publicViews.posts).toBe(true);

    await click(button(m.settings_profile_save_activity()));
    expect(host.textContent).toContain(m.settings_public_activity_conflict());
    expect(posts.getAttribute('aria-checked')).toBe('false');
    expect(button(m.settings_profile_save_activity()).disabled).toBe(false);
    await click(button(m.settings_profile_save_activity()));
    const original = editor.snapshot().attempt!;
    expect(original.patch).toEqual({ publicViews: { posts: false }, speakersListed: false });
    expect(original.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
    expect(host.textContent).toContain(m.settings_public_activity_unknown());
    await click(button(m.settings_profile_reload_current()));
    expect(sent).toHaveLength(2);
    expect(editor.snapshot().attempt).toBe(original);
    expect(posts.getAttribute('aria-checked')).toBe('false');
    expect(button(m.settings_profile_save_activity()).disabled).toBe(true);

    // A return to the original choice must survive replay of the earlier opposite choice.
    await click(posts);
    await click(button(m.settings_profile_preview_open()));
    expect(sent).toHaveLength(2);
    await click(button(m.settings_public_activity_retry()));
    expect(sent[2]).toBe(original);
    expect(editor.snapshot().attempt).toBeNull();
    expect(editor.snapshot().known?.publicViews.posts).toBe(false);
    expect(posts.getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain(m.settings_public_activity_unsaved());
    expect(host.textContent).not.toContain(m.settings_saved());

    await click(button(m.settings_profile_save()));
    expect(sent[3]!.patch).toEqual({ biography: 'Local biography' });
    expect(editor.snapshot().known?.publicViews.posts).toBe(false);
    expect(posts.getAttribute('aria-checked')).toBe('true');
    await click(button(m.settings_profile_save_activity()));
    expect(sent[4]!.patch).toEqual({ publicViews: { posts: true } });
    expect(editor.snapshot().known?.publicViews.posts).toBe(true);
    expect(host.textContent).not.toContain(m.settings_public_activity_unsaved());
    expect(host.textContent).toContain(m.settings_saved());
    expect(button(m.settings_profile_save_activity())).toBeUndefined();
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
