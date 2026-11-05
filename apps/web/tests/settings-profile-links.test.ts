import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileLinks } from '../src/settings/profile-links';
import { ProfileEditor, profileFieldErrors, type ProfileAttempt } from '../src/settings/profile-write';
import type { ProfileValues } from '../src/settings/profile-data';
import { m } from '../src/paraglide/messages.js';

const duplicate = { label: 'Notes', url: 'https://example.test/notes' };
const initial: ProfileValues = {
  accountId: '019a0000-0000-7000-8000-000000000001',
  kind: 'actor',
  displayName: 'Avery',
  biography: 'Keep this biography',
  avatar: null,
  links: Array.from({ length: 5 }, () => ({ ...duplicate })),
  publicViews: { posts: true, reviews: true, collections: true, realms: false },
};

test('five duplicate links remain separate named rows with visible labels and addressable validation fields', () => {
  const links = initial.links.map((link, index) => (index === 2 ? { ...link, url: 'http://example.test' } : link));
  const errors = profileFieldErrors({ ...initial, links });
  const html = renderToStaticMarkup(
    createElement(ProfileLinks, {
      links,
      disabled: false,
      onChange: () => {
        throw new Error('Rendering must not edit the draft');
      },
      ids: 'profile',
      errors,
      fieldError: (field) => (errors[field] ? createElement('p', { id: `profile-${field}-error` }, 'Use HTTPS') : null),
    }),
  );
  expect(html.match(/<fieldset\b/g)).toHaveLength(5);
  for (let index = 0; index < 5; index++) {
    expect(html).toContain(m.settings_profile_link_named_row({ number: index + 1, label: 'Notes' }));
    for (const field of ['label', 'url']) {
      expect(html).toContain(`id="profile-${field}-${index}"`);
      expect(html).toContain(`for="profile-${field}-${index}"`);
    }
    expect(html).toContain(`aria-labelledby="profile-link-row-${index}-remove profile-link-row-${index}"`);
  }
  expect(html).toContain('aria-invalid="true" aria-describedby="profile-url-2-error"');
  expect(html).toContain('id="profile-url-2-error"');
  expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
});

test('editing and removing a middle duplicate preserves all other rows and the draft through late readback', async () => {
  let confirm: ((value: { ok: true; profile: ProfileValues }) => void) | undefined;
  const attempts: ProfileAttempt[] = [];
  let current = structuredClone(initial);
  const editor = new ProfileEditor(
    {
      read: async () => structuredClone(current),
      save: (attempt) => {
        attempts.push(attempt);
        return new Promise((resolve) => {
          confirm = resolve;
        });
      },
    },
    initial,
  );
  editor.edit({ displayName: 'Pending name' });
  const saving = editor.submit('profile');
  const links = editor
    .snapshot()
    .draft!.links.map((link, index) =>
      index === 2 ? { label: 'Edited middle', url: 'https://example.test/edited' } : link,
    );
  editor.edit({ links, biography: 'Unsaved biography' });
  editor.edit({ links: editor.snapshot().draft!.links.filter((_, index) => index !== 1) });
  const expected = [duplicate, links[2]!, duplicate, duplicate];
  expect(editor.snapshot().draft?.links).toEqual(expected);
  current = structuredClone(attempts[0]!.after);
  confirm!({ ok: true, profile: current });
  await saving;
  await editor.reload();
  expect(editor.snapshot().draft).toMatchObject({
    displayName: 'Pending name',
    biography: 'Unsaved biography',
    links: expected,
  });
  expect(editor.snapshot().phase).toBe('review');
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.patch).toEqual({ displayName: 'Pending name' });
  expect(editor.snapshot().draft?.links.every((link) => Object.keys(link).sort().join() === 'label,url')).toBe(true);
});
