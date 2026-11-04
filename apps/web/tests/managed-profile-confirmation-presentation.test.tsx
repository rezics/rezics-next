import { expect, test } from 'bun:test';
import { AccountProfileEditor } from '../src/accounts/profile-editor/editor';
import type { ProfileAttempt } from '../src/settings/profile-write';
import { observeProfile, type ProfileValues, type ProfileSaveResult } from '../src/settings/profile-data';

const profile: ProfileValues = observeProfile(
  {
    accountId: '00000000-0000-7000-8000-000000000002',
    kind: 'organization',
    displayName: 'Managed organization',
    biography: 'Original biography',
    avatar: null,
    links: [],
    publicViews: { posts: false, reviews: true, collections: false, realms: false },
    speakersListed: false,
  },
  '00000000-0000-7000-8000-000000000001',
);

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
