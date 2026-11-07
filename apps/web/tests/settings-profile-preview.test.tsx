import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfilePreview } from '../src/settings/profile-preview';
import { ProfileEditor } from '../src/settings/profile-write';
import { profileChanges, profileHasLocalPreview, type ProfileValues } from '../src/settings/profile-data';
import { m } from '../src/paraglide/messages.js';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient';
import { performanceAmbientTree } from './performance-ambient';

const settingsAmbient = createBrowserSettingsAmbient();

const draft: ComponentProps<typeof ProfilePreview> = {
  displayName: 'Unsaved name',
  biography: 'Unsaved biography',
  avatar: null,
  localAvatarUrl: null,
  links: [{ label: 'Notes', url: 'https://example.test/notes?q=local#draft', valid: true }],
  hasUnsavedChanges: true,
};

test('only approved safe supplied destinations become links, even with stale approval', () => {
  for (const link of [
    { url: 'https://example.test/rejected', valid: false },
    ...[
      'javascript:alert(1)',
      'data:text/html,hello',
      'http://example.test',
      '//example.test',
      'https://user:secret@example.test',
      'https://example.test\n',
      'https://',
      `https://example.test/${'x'.repeat(2048)}`,
    ].map((url) => ({ url, valid: true })),
  ]) {
    const html = renderToStaticMarkup(
      performanceAmbientTree(<ProfilePreview {...draft} links={[{ ...link, label: 'Rejected' }]} />),
    );
    expect(html).not.toContain('<a ');
    expect(html).toContain(m.settings_profile_preview_invalid_link());
  }
});

test('open, update, close and reopen the local draft without submitting or changing activity visibility', async () => {
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
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  let submits = 0;
  const render = (values: typeof draft) =>
    act(() =>
      root.render(
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submits++;
          }}
        >
          <input type="checkbox" name="public-posts" defaultChecked />
          <ProfilePreview {...values} />
        </form>,
      ),
    );
  try {
    await render(draft);
    const toggle = host.querySelector('button')!;
    const region = host.querySelector('section')!;
    expect(region.hidden).toBe(true);
    expect(toggle.getAttribute('type')).toBe('button');
    await act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region.hidden).toBe(false);
    expect(region.querySelector('h4')?.textContent).toBe(draft.displayName);
    const link = region.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(draft.links[0]!.url);
    expect(link.getAttribute('rel')).toBe('nofollow noopener noreferrer ugc');
    const updated = {
      ...draft,
      displayName: 'Edited while open',
      biography: 'New\nbiography',
      links: [{ label: 'Invalid edit', url: 'http://example.test', valid: true }],
    };
    await render(updated);
    expect(region.querySelector('h4')?.textContent).toBe(updated.displayName);
    expect(region.textContent).toContain(updated.biography);
    expect(region.querySelector('a')).toBeNull();
    expect(region.querySelector('[role="status"]')?.textContent).toBe(m.settings_profile_preview_draft());
    await act(() => toggle.click());
    expect(region.hidden).toBe(true);
    await render({ ...updated, displayName: 'Edited while closed' });
    await act(() => toggle.click());
    expect(region.hidden).toBe(false);
    expect(region.querySelector('h4')?.textContent).toBe('Edited while closed');
    expect(host.querySelector<HTMLInputElement>('[name="public-posts"]')?.checked).toBe(true);
    expect(submits).toBe(0);
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test('matching current fields do not mark the local preview as saved while the original is unacknowledged', async () => {
  const initial: ProfileValues = {
    accountId: '019a0000-0000-7000-8000-000000000001',
    kind: 'actor',
    displayName: 'Avery',
    biography: 'Reading notes',
    avatar: null,
    links: [],
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
  };
  const editor = new ProfileEditor(
    {
      ambient: settingsAmbient,
      read: async () => initial,
      save: async () => {
        throw new Error('Response lost');
      },
    },
    initial,
  );
  editor.edit({ displayName: 'Submitted name' });
  await editor.submit('profile');
  editor.edit({ displayName: initial.displayName });
  const snapshot = editor.snapshot();
  const draft = snapshot.draft;
  expect(snapshot.attempt).not.toBeNull();
  expect(draft?.displayName).toBe(initial.displayName);
  const changed =
    snapshot.known != null && draft != null && Object.keys(profileChanges(snapshot.known, draft)).length > 0;
  expect(changed).toBe(false);
  expect(profileHasLocalPreview(changed, false, snapshot.attempt, snapshot.acknowledged)).toBe(true);
  const html = renderToStaticMarkup(
    performanceAmbientTree(
      createElement(ProfilePreview, {
        displayName: draft!.displayName,
        biography: draft!.biography,
        avatar: draft!.avatar,
        localAvatarUrl: null,
        hasUnsavedChanges: profileHasLocalPreview(changed, false, snapshot.attempt, snapshot.acknowledged),
        links: [],
      }),
    ),
  );
  expect(html).toContain(m.settings_profile_preview_draft());
  expect(html).not.toContain(m.settings_profile_preview_saved());
});

test('a clean or confirmed current profile displays the saved preview while pending command readback stays local', () => {
  for (const [changed, localAvatar, attempt, acknowledged, local] of [
    [false, false, null, false, false],
    [true, false, null, false, true],
    [false, true, null, false, true],
    [false, false, {}, false, true],
    [false, false, {}, true, true],
  ] as const) {
    const hasUnsavedChanges = profileHasLocalPreview(changed, localAvatar, attempt, acknowledged);
    expect(hasUnsavedChanges).toBe(local);
    const html = renderToStaticMarkup(
      performanceAmbientTree(<ProfilePreview {...draft} hasUnsavedChanges={hasUnsavedChanges} />),
    );
    expect(html).toContain(local ? m.settings_profile_preview_draft() : m.settings_profile_preview_saved());
  }
});
