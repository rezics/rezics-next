import * as profilePresentation from '../src/settings/ports/profile-editor-view';
import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountProfileEditor } from '../src/accounts/profile-editor/editor';
import type { ProfileAttempt } from '../src/settings/profile-write';
import type { ProfileValues, ProfileSaveResult } from '../src/settings/profile-data';
import { EditableProfileReadError } from '../src/settings/editable-profile-source';
import { m } from '../src/paraglide/messages.js';

const profile: ProfileValues = {
  accountId: '00000000-0000-7000-8000-000000000002',
  kind: 'organization',
  displayName: 'Managed organization',
  biography: 'Original biography',
  avatar: null,
  links: [],
  publicViews: { posts: false, reviews: true, collections: false, realms: false },
  speakersListed: false,
};

test('review captures the exact draft, recoverable refusal keeps it, and unknown submission reconciles before a new command', async () => {
  let current = profile;
  let response: ProfileSaveResult | null = { ok: false, status: 422, message: '' };
  const writes: ProfileAttempt[] = [];
  const editor = new AccountProfileEditor(
    {
      read: async () => current,
      save: async (attempt) => {
        writes.push(attempt);
        if (!response) throw new Error('Reply lost');
        return response;
      },
    },
    profile,
  );
  editor.edit({ displayName: 'Reviewed name', biography: 'Retained draft' });
  await editor.submit('profile');
  expect(writes).toHaveLength(0);
  // A confirmation subscriber must not change the command while its dialog closes.
  const unsubscribe = editor.subscribeConfirmation(() => editor.edit({ displayName: 'Continued draft' }));
  await editor.confirm();
  unsubscribe();
  expect(writes[0]?.patch.displayName).toBe('Reviewed name');
  expect(writes[0]?.after.accountId).toBe(profile.accountId);
  expect(editor.snapshot().phase).toBe('refused');
  expect(editor.snapshot().draft?.biography).toBe('Retained draft');
  expect(editor.snapshot().draft?.displayName).toBe('Continued draft');
  response = null;
  await editor.submit('profile');
  await editor.confirm();
  expect(editor.snapshot().phase).toBe('uncertain');
  const unresolved = editor.snapshot().attempt;
  await editor.submit('profile');
  await editor.confirm();
  expect(writes).toHaveLength(2);
  current = unresolved!.after;
  await editor.reload();
  expect(editor.snapshot().phase).toBe('uncertain');
  expect(editor.snapshot().attempt).toBe(unresolved);
  response = { ok: true, profile: current };
  await editor.retry();
  expect(writes[2]).toBe(unresolved);
  expect(editor.snapshot().phase).toBe('saved');
  expect(editor.snapshot().attempt).toBeNull();
});

test('a retired target or session cancels approval and ignores an old save response', async () => {
  let active = true;
  let writes = 0;
  const editor = new AccountProfileEditor(
    {
      isCurrent: () => active,
      read: async () => profile,
      save: async () => {
        writes++;
        return { ok: true, profile };
      },
    },
    profile,
  );
  editor.edit({ displayName: 'Old account draft' });
  await editor.submit('profile');
  active = false;
  await editor.confirm();
  expect(writes).toBe(0);
  expect(editor.confirmationSnapshot()).toBeNull();
  expect(editor.snapshot().draft).toBeNull();

  let resolve!: (result: ProfileSaveResult) => void;
  const pending = new AccountProfileEditor(
    {
      read: async () => profile,
      save: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    profile,
  );
  pending.edit({ displayName: 'In flight' });
  await pending.submit('profile');
  const completion = pending.confirm();
  pending.retire();
  resolve({ ok: true, profile });
  await completion;
  expect(pending.snapshot().phase).toBe('unavailable');
  expect(pending.snapshot().draft).toBeNull();
});

test('failed managed readback preserves visible acknowledgement separately from unknown delivery', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { AccountProfileView } = await import('../src/accounts/profile-editor/page');
  for (const acknowledged of [true, false]) {
    const editor = new AccountProfileEditor(
      {
        read: async () => {
          throw new EditableProfileReadError(503);
        },
        save: async () => (acknowledged ? { ok: true, profile } : { ok: false, status: 503, message: '' }),
      },
      profile,
    );
    editor.edit({ biography: 'Private retained draft' });
    await editor.submit('profile');
    await editor.confirm();
    const html = renderToStaticMarkup(
      createElement(AccountProfileView, {
        presentation: profilePresentation,
        accountId: profile.accountId,
        editor,
        page: { state: 'unavailable' },
      }),
    );
    expect(html.includes(m.settings_profile_acknowledged_stale())).toBe(acknowledged);
    expect(html.includes(m.settings_profile_retry_save())).toBe(!acknowledged);
    expect(html).not.toContain('Private retained draft');
    expect(editor.snapshot().attempt).not.toBeNull();
  }
});

test('a managed read failure without a retained command shows its Retry-After wait on the reload control', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { AccountProfileView } = await import('../src/accounts/profile-editor/page');
  let reads = 0;
  const editor = new AccountProfileEditor({
    read: async () => {
      reads++;
      throw new EditableProfileReadError(503, { status: 429, code: 'rate_limited', retryAfter: '120' });
    },
    save: async () => ({ ok: false, status: 503, message: '' }),
  });
  await editor.reload();
  expect(reads).toBe(1);
  const render = (target: AccountProfileEditor) =>
    renderToStaticMarkup(
      createElement(AccountProfileView, {
        presentation: profilePresentation,
        accountId: profile.accountId,
        editor: target,
        page: { state: 'unavailable' },
      }),
    );
  const reloadControl = (html: string) =>
    html.match(new RegExp(`<button([^>]*)>${m.settings_profile_reload_current()}</button>`))?.[1];
  const waiting = render(editor);
  expect(waiting).toContain(m.account_profile_unavailable());
  expect(waiting).toContain(`${m.settings_profile_reload_current()}: ${m.settings_retry_wait()}`);
  expect(reloadControl(waiting)).toMatch(/\sdisabled=""/);
  // The editor itself also refuses the early read; the control only presents that wait.
  await editor.reload();
  expect(reads).toBe(1);
  const unlimited = new AccountProfileEditor({
    read: async () => {
      throw new EditableProfileReadError(503);
    },
    save: async () => ({ ok: false, status: 503, message: '' }),
  });
  await unlimited.reload();
  const ready = render(unlimited);
  expect(ready).not.toContain(m.settings_retry_wait());
  expect(reloadControl(ready)).toBeString();
  expect(reloadControl(ready)).not.toMatch(/\sdisabled=""/);
});

test('the delegated Profile page consumes the route runtime without ambient session or native reads', async () => {
  const { AccountProfilePage } = await import('../src/accounts/profile-editor/page');
  type Runtime = import('../src/accounts/profile-editor/ports').AccountProfileRuntime;
  const runtime: Runtime = {
    useSession: () => ({
      session: { state: 'signed-out', csrfToken: null },
      observation: 'signed-out-observation',
      bind: () => {
        throw new Error('A signed-out page must not create an editor');
      },
    }),
    read: async () => {
      throw new Error('A signed-out page must not read a private Profile');
    },
    save: async () => {
      throw new Error('A signed-out page must not dispatch a command');
    },
  };
  const html = renderToStaticMarkup(
    createElement(AccountProfilePage, {
      accountId: profile.accountId,
      runtime,
      presentation: profilePresentation,
    }),
  );
  expect(html).toContain(m.account_profile_signed_out());
  expect(html).not.toContain(profile.displayName!);
});
