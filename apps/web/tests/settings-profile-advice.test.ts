import { expect, test } from 'bun:test';
import { accountProfileEditing, createKernelClient } from '@rezics/client';
import { loadProfileRecord, observeProfile, saveProfileRecord, type ProfileValues } from '../src/settings/profile-data';
import { ProfileEditor, type ProfileAttempt } from '../src/settings/profile-write';
import { EditableProfileReadError } from '../src/settings/editable-profile-source';

const actorId = '019a0000-0000-7000-8000-000000000001';
const operatorId = '019a0000-0000-7000-8000-000000000003';

function actor(viewerId = actorId): ProfileValues {
  return observeProfile(
    {
      accountId: actorId,
      kind: 'actor',
      displayName: 'Avery',
      biography: 'Notes',
      avatar: null,
      links: [{ label: 'Home', url: 'https://example.test' }],
      publicViews: { posts: true, reviews: true, collections: false, realms: false },
    },
    viewerId,
  );
}

function nativeBody(profile: ProfileValues) {
  return {
    profile: {
      id: profile.accountId,
      kind: profile.kind,
      handle: null,
      displayName: profile.displayName,
      bio: profile.biography,
      links: profile.links,
      avatar: profile.avatar,
      publicViews: profile.publicViews,
      ...(profile.kind === 'organization' ? { speakersListed: profile.speakersListed } : {}),
    },
    editing: profile.editing,
  };
}

test('changed native advice after reload keeps the draft in review and does not rebuild an uncertain command', async () => {
  let current = actor();
  const attempts: ProfileAttempt[] = [];
  const editor = new ProfileEditor(
    {
      read: async () => structuredClone(current),
      save: async (attempt) => {
        attempts.push(attempt);
        throw new Error('Reply lost');
      },
    },
    current,
  );
  editor.edit({ displayName: 'Original name' });
  await editor.submit('profile');
  const original = editor.snapshot().attempt;
  expect(typeof original?.idempotencyKey).toBe('string');
  expect(original?.patch).toEqual({ displayName: 'Original name' });
  editor.edit({ biography: 'Later draft' });
  current = {
    ...current,
    displayName: 'Device name',
    editing: accountProfileEditing(operatorId, { id: actorId, kind: 'actor' }),
  };
  await editor.reload();
  expect(editor.snapshot().attempt).toBe(original);
  expect(editor.snapshot().phase).toBe('uncertain');
  expect(editor.snapshot().draft?.displayName).toBe('Original name');
  expect(editor.snapshot().draft?.biography).toBe('Later draft');
  expect(attempts).toHaveLength(1);

  const idle = new ProfileEditor({ read: async () => structuredClone(current), save: async () => ({ ok: true, profile: current }) }, actor());
  idle.edit({ biography: 'Keep this' });
  await idle.reload();
  expect(idle.snapshot().phase).toBe('review');
  expect(idle.snapshot().draft?.biography).toBe('Keep this');
  expect(idle.snapshot().known?.editing.viewer.accountId).toBe(operatorId);
  idle.review();
  expect(idle.snapshot().phase).toBe('idle');
});

test('denial retires private values and advice while a fresh native GET still confirms after an uncertain save', async () => {
  let current = actor();
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'PATCH') {
        const patch = (await request.json()) as Partial<ProfileValues> & { avatar?: string | null };
        current = {
          ...current,
          ...patch,
          avatar: patch.avatar === undefined ? current.avatar : patch.avatar === null ? null : { media: patch.avatar },
          publicViews: { ...current.publicViews, ...patch.publicViews },
          editing: current.editing,
        };
        return Response.json({ accountId: actorId });
      }
      return Response.json(nativeBody(current), { headers: { 'cache-control': 'private, no-store' } });
    }) as typeof fetch,
  });
  const editor = new ProfileEditor(
    {
      read: () => loadProfileRecord(client, 'Bearer self', actorId),
      save: (attempt) =>
        saveProfileRecord(client, 'Bearer self', actorId, attempt.before, attempt.after, attempt.idempotencyKey),
    },
    current,
  );
  editor.edit({ displayName: 'Saved name' });
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('saved');
  expect(editor.snapshot().known?.displayName).toBe('Saved name');
  expect(editor.snapshot().known?.editing).toEqual(accountProfileEditing(actorId, { id: actorId, kind: 'actor' }));
  editor.unavailable(new EditableProfileReadError(403));
  expect(editor.snapshot().known).toBeNull();
  expect(editor.snapshot().draft).toBeNull();
  expect(editor.snapshot().readAuthority).toBe('denied');
  expect(editor.snapshot().attempt).toBeNull();
});
