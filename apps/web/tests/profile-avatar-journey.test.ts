import { expect, test } from 'bun:test';
import { ProfileAvatarUpload, type AvatarUpload } from '../src/settings/profile-avatar-upload';
import type { ProfileValues } from '../src/settings/profile-data';
import { ProfileEditor, type ProfileAttempt } from '../src/settings/profile-write';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function summary(media: string) {
  return {
    media,
    width: 80,
    height: 80,
    placeholder: { thumbhash: '', color: '#123456' },
    variants: [{ format: 'webp' as const, width: 80 }],
    focalPoint: null,
    credit: null,
  };
}
function profile(accountId = 'account-one'): ProfileValues {
  return {
    accountId,
    kind: 'actor',
    displayName: 'Avery',
    biography: 'Saved biography',
    avatar: summary('saved-avatar'),
    links: [{ label: 'Home', url: 'https://example.test' }],
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
  };
}
const file = () => new File(['local bytes'], 'private-file-name.png', { type: 'image/png' });
function uploads(editor: ProfileEditor) {
  const requests: {
    accountId: string;
    file: File;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<{ src: string }>>;
  }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const upload: AvatarUpload = (accountId, file, signal) => {
    const result = deferred<{ src: string }>();
    requests.push({ accountId, file, signal, result });
    // Intentionally ignore abort: ownership must also guard an already completed provider response.
    return result.promise;
  };
  const controller = new ProfileAvatarUpload(editor, upload, {
    createObjectURL: () => {
      const url = `blob:owned-${created.length}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
  });
  return { controller, requests, created, revoked, disconnect: controller.connect() };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('A selected avatar has an immediate honest local preview while the existing upload and explicit profile save retain their separate states', async () => {
  const initial = profile();
  const readback = deferred<ProfileValues>();
  const writes: ProfileAttempt[] = [];
  const editor = new ProfileEditor(
    {
      save: async (attempt) => {
        writes.push(attempt);
        return { ok: true, profile: attempt.after };
      },
      read: () => readback.promise,
    },
    initial,
  );
  const boundary = uploads(editor);
  editor.edit({ biography: 'Unrelated unsaved biography' });
  boundary.controller.choose(file());
  expect(boundary.controller.snapshot()).toEqual({ phase: 'uploading', url: 'blob:owned-0' });
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  expect(editor.snapshot().known).toEqual(initial);
  expect(writes).toHaveLength(0);
  expect(boundary.requests[0]?.accountId).toBe(initial.accountId);

  boundary.requests[0]!.result.resolve({ src: 'uploaded-avatar' });
  await settle();
  expect(boundary.controller.snapshot()).toEqual({ phase: 'ready', url: 'blob:owned-0' });
  expect(editor.snapshot().draft?.avatar).toEqual({ media: 'uploaded-avatar' });
  expect(editor.snapshot().known?.avatar).toEqual(initial.avatar);
  expect(writes).toHaveLength(0);
  const saving = editor.submit('profile');
  await settle();
  expect(writes[0]?.patch).toEqual({ avatar: 'uploaded-avatar', biography: 'Unrelated unsaved biography' });
  expect(JSON.stringify(writes)).not.toContain('blob:');
  expect(JSON.stringify(writes)).not.toContain('private-file-name');
  expect(editor.snapshot().phase).toBe('reloading');
  expect(boundary.controller.snapshot().phase).toBe('ready');
  expect(boundary.revoked).toEqual([]);
  readback.resolve({ ...initial, avatar: summary('uploaded-avatar'), biography: 'Unrelated unsaved biography' });
  await saving;
  expect(editor.snapshot().phase).toBe('saved');
  expect(editor.snapshot().draft?.avatar).toEqual(summary('uploaded-avatar'));
  expect(boundary.controller.snapshot()).toEqual({ phase: 'idle', url: null });
  expect(boundary.revoked).toEqual(boundary.created);
  boundary.disconnect();
  expect(boundary.revoked).toEqual(boundary.created);
});

test('Cancel, replacement or account change cannot apply a late upload to the wrong draft or discard the previous saved avatar', async () => {
  const initial = profile();
  const editor = new ProfileEditor(
    { read: async () => initial, save: async (attempt) => ({ ok: true, profile: attempt.after }) },
    initial,
  );
  const boundary = uploads(editor);
  editor.edit({ displayName: 'Unsaved name', publicViews: { ...initial.publicViews, realms: true } });
  boundary.controller.choose(file());
  boundary.controller.cancel();
  expect(boundary.requests[0]?.signal.aborted).toBe(true);
  boundary.requests[0]!.result.resolve({ src: 'late-cancelled' });
  await settle();
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  expect(boundary.controller.snapshot().phase).toBe('cancelled');

  boundary.controller.choose(file());
  boundary.controller.choose(file());
  expect(boundary.requests[1]?.signal.aborted).toBe(true);
  boundary.requests[2]!.result.resolve({ src: 'replacement' });
  await settle();
  boundary.requests[1]!.result.resolve({ src: 'late-replaced' });
  await settle();
  expect(editor.snapshot().draft?.avatar).toEqual({ media: 'replacement' });
  boundary.controller.cancel();
  expect(editor.snapshot().draft).toEqual({
    ...initial,
    displayName: 'Unsaved name',
    publicViews: { ...initial.publicViews, realms: true },
  });
  expect(editor.snapshot().known).toEqual(initial);

  boundary.controller.choose(file());
  boundary.disconnect();
  const next = profile('account-two');
  const nextEditor = new ProfileEditor(
    { read: async () => next, save: async (attempt) => ({ ok: true, profile: attempt.after }) },
    next,
  );
  const nextBoundary = uploads(nextEditor);
  expect(boundary.requests[3]?.signal.aborted).toBe(true);
  boundary.requests[3]!.result.resolve({ src: 'late-old-account' });
  await settle();
  expect(nextEditor.snapshot().draft).toEqual(next);
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  expect(editor.snapshot().draft?.displayName).toBe('Unsaved name');
  expect(boundary.revoked).toEqual(boundary.created);
  nextBoundary.disconnect();
});

test('upload failure retries only the owned file, removal stays a draft, and unavailable accounts stop the request', async () => {
  const initial = profile();
  const writes: ProfileAttempt[] = [];
  const editor = new ProfileEditor(
    {
      read: async () => ({ ...initial, avatar: null }),
      save: async (attempt) => {
        writes.push(attempt);
        return { ok: true, profile: attempt.after };
      },
    },
    initial,
  );
  const boundary = uploads(editor);
  const selected = file();
  boundary.controller.choose(selected);
  boundary.requests[0]!.result.reject(new Error('Upload refused'));
  await settle();
  expect(boundary.controller.snapshot()).toEqual({ phase: 'error', url: 'blob:owned-0' });
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  boundary.controller.retry();
  expect(boundary.requests[1]?.file).toBe(selected);
  expect(boundary.requests[1]?.signal).not.toBe(boundary.requests[0]?.signal);
  boundary.requests[1]!.result.resolve({ src: 'retry-upload' });
  await settle();
  boundary.controller.remove();
  expect(editor.snapshot().draft?.avatar).toBeNull();
  expect(editor.snapshot().known?.avatar).toEqual(initial.avatar);
  expect(writes).toHaveLength(0);
  await editor.submit('profile');
  expect(writes[0]?.patch).toEqual({ avatar: null });
  boundary.controller.choose(file());
  editor.unavailable();
  expect(boundary.requests[2]?.signal.aborted).toBe(true);
  boundary.requests[2]!.result.resolve({ src: 'late-denied' });
  await settle();
  expect(editor.snapshot().draft?.avatar).toBeNull();
  expect(boundary.revoked).toEqual(boundary.created);
  boundary.disconnect();
});

test('an uncertain profile save retains its immutable retry and local draft until native readback confirms it', async () => {
  const initial = profile();
  const writes: ProfileAttempt[] = [];
  const editor = new ProfileEditor(
    {
      read: async () => ({ ...initial, avatar: summary('uploaded-avatar') }),
      save: async (attempt) => {
        writes.push(attempt);
        if (writes.length === 1) throw new Error('Response lost');
        return { ok: true, profile: attempt.after };
      },
    },
    initial,
  );
  const boundary = uploads(editor);
  boundary.controller.choose(file());
  boundary.requests[0]!.result.resolve({ src: 'uploaded-avatar' });
  await settle();
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('uncertain');
  boundary.controller.choose(file());
  boundary.controller.remove();
  boundary.controller.cancel();
  expect(boundary.requests).toHaveLength(1);
  expect(boundary.controller.snapshot().phase).toBe('ready');
  editor.edit({ biography: 'Later unsaved text' });
  await editor.retry();
  expect(writes[1]).toBe(writes[0]!);
  expect(editor.snapshot().known?.avatar).toEqual(summary('uploaded-avatar'));
  expect(editor.snapshot().draft?.biography).toBe('Later unsaved text');
  expect(boundary.revoked).toEqual(boundary.created);
  boundary.disconnect();
});
