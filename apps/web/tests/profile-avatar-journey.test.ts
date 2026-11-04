import { expect, test } from 'bun:test';
import { spyOn } from 'bun:test';
import { UploadRefusal, type UploadRefusalReason } from '../src/threads/upload';
import type { AvatarResume } from '../src/settings/profile-avatar-upload';
import { ProfileAvatarUpload, type AvatarUpload } from '../src/settings/profile-avatar-upload';
import { observeProfile, type ProfileValues } from '../src/settings/profile-data';
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
  return observeProfile({
    accountId,
    kind: 'actor',
    displayName: 'Avery',
    biography: 'Saved biography',
    avatar: summary('saved-avatar'),
    links: [{ label: 'Home', url: 'https://example.test' }],
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
  });
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

function recovery(editor: ProfileEditor, resumeAvailable = true) {
  const calls: {
    operation: 'upload' | 'resume';
    target: string;
    file: File;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<{ src: string }>>;
  }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const request = (operation: 'upload' | 'resume', target: string, file: File, signal: AbortSignal) => {
    const result = deferred<{ src: string }>();
    calls.push({ operation, target, file, signal, result });
    return result.promise;
  };
  const upload: AvatarUpload = (...args) => request('upload', ...args);
  const resume: AvatarResume = (...args) => request('resume', ...args);
  const controller = new ProfileAvatarUpload(
    editor,
    upload,
    {
      createObjectURL: () => {
        const url = `blob:recovery-${created.length}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
    },
    resumeAvailable ? resume : undefined,
  );
  return { controller, calls, created, revoked, disconnect: controller.connect() };
}
function refusal(reason: UploadRefusalReason, mediaId?: string, retryAfter?: number) {
  const failure = new UploadRefusal(reason, retryAfter);
  if (mediaId) failure.mediaId = mediaId;
  return failure;
}
function recoveryEditor(initial = profile()) {
  return new ProfileEditor(
    {
      read: async () => initial,
      save: async (attempt) => ({ ok: true, profile: attempt.after }),
    },
    initial,
  );
}

test('Recover an avatar upload using its existing reservation preserving native identity and exact recovery bounds', async () => {
  const editor = recoveryEditor();
  const boundary = recovery(editor);
  const selected = file();
  boundary.controller.choose(selected);
  boundary.calls[0]!.result.reject(refusal('unavailable', 'native-avatar-reservation'));
  await settle();
  const originalUrl = boundary.controller.snapshot().url;
  expect(boundary.controller.canRetry()).toBe(true);
  expect(editor.snapshot().draft?.avatar).toEqual(profile().avatar);
  // Each deliberate click delegates once to the existing transport, whose frozen tests own 32 reads / 60 seconds.
  for (let index = 1; index <= 2; index++) {
    boundary.controller.retry();
    boundary.controller.retry();
    expect(boundary.calls).toHaveLength(index + 1);
    const call = boundary.calls[index]!;
    expect(call.operation).toBe('resume');
    expect(call.target).toBe('native-avatar-reservation');
    expect(call.file).toBe(selected);
    expect(call.signal).not.toBe(boundary.calls[index - 1]!.signal);
    call.result.reject(index === 1 ? new Error('Read response lost') : refusal('unavailable', 'another-id'));
    await settle();
    expect(boundary.controller.snapshot().url).toBe(originalUrl);
    expect(boundary.controller.snapshot().phase).toBe('error');
    expect(editor.snapshot().draft?.avatar).toEqual(profile().avatar);
  }
  boundary.controller.retry();
  boundary.calls[3]!.result.resolve({ src: 'different-reservation' });
  await settle();
  expect(boundary.controller.snapshot().phase).toBe('error');
  expect(editor.snapshot().draft?.avatar).toEqual(profile().avatar);
  boundary.controller.retry();
  boundary.calls[4]!.result.resolve({ src: 'native-avatar-reservation' });
  await settle();
  expect(boundary.calls.map(({ operation }) => operation)).toEqual(['upload', 'resume', 'resume', 'resume', 'resume']);
  expect(boundary.calls[0]!.target).toBe(profile().accountId);
  expect(boundary.calls.slice(1).every(({ target }) => target === 'native-avatar-reservation')).toBe(true);
  expect(boundary.controller.snapshot()).toEqual({ phase: 'ready', url: originalUrl });
  expect(editor.snapshot().draft?.avatar).toEqual({ media: 'native-avatar-reservation' });
  expect(editor.snapshot().known?.avatar).toEqual(profile().avatar);
  expect(boundary.revoked).toEqual([]);
  boundary.disconnect();
  expect(boundary.revoked).toEqual(boundary.created);
});

test('native file refusals require a new selection while closed and unavailable reasons remain distinct', async () => {
  for (const reason of ['type', 'too-large', 'rejected', 'closed', 'unavailable'] as const) {
    const boundary = recovery(recoveryEditor());
    boundary.controller.choose(file());
    boundary.calls[0]!.result.reject(refusal(reason, reason === 'rejected' ? 'rejected-reservation' : undefined));
    await settle();
    expect(boundary.controller.snapshot().failure).toEqual({ reason });
    const retryable = reason === 'closed' || reason === 'unavailable';
    expect(boundary.controller.canRetry()).toBe(retryable);
    if (!retryable) {
      boundary.controller.retry();
      expect(boundary.calls).toHaveLength(1);
      const replacement = file();
      boundary.controller.choose(replacement);
      expect(boundary.calls[1]!.file).toBe(replacement);
      expect(boundary.calls[1]!.operation).toBe('upload');
      expect(boundary.revoked).toEqual([boundary.created[0]!]);
    }
    boundary.disconnect();
    expect(boundary.revoked).toEqual(boundary.created);
  }
});

test('actual rate delays block upload and resume IO through replacement, cancellation and removal until an explicit retry', async () => {
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const boundary = recovery(recoveryEditor());
  try {
    const selected = file();
    boundary.controller.choose(selected);
    boundary.calls[0]!.result.reject(refusal('rate-limited', 'original-reservation', 7));
    await settle();
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      failure: { reason: 'rate-limited', retryAfter: 7 },
      retryAt: 8_000,
    });
    now = 7_999;
    boundary.controller.retry();
    expect(boundary.calls).toHaveLength(1);
    now = 8_000;
    await settle();
    expect(boundary.calls).toHaveLength(1);
    boundary.controller.retry();
    expect(boundary.calls[1]).toMatchObject({ operation: 'resume', target: 'original-reservation', file: selected });
    boundary.calls[1]!.result.reject(refusal('rate-limited', 'original-reservation', 11));
    await settle();
    boundary.controller.choose(file());
    expect(boundary.controller.snapshot().url).toBe('blob:recovery-1');
    boundary.controller.retry();
    boundary.controller.cancel();
    boundary.controller.choose(file());
    boundary.controller.remove();
    const replacement = file();
    boundary.controller.choose(replacement);
    expect(boundary.calls).toHaveLength(2);
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      failure: { reason: 'rate-limited', retryAfter: 11 },
      retryAt: 19_000,
    });
    now = 18_999;
    boundary.controller.retry();
    expect(boundary.calls).toHaveLength(2);
    now = 19_000;
    await settle();
    expect(boundary.calls).toHaveLength(2);
    boundary.controller.retry();
    expect(boundary.calls).toHaveLength(3);
    expect(boundary.calls[2]).toMatchObject({ operation: 'upload', target: profile().accountId, file: replacement });
    boundary.calls[2]!.result.resolve({ src: 'replacement-reservation' });
    await settle();
    expect(boundary.controller.snapshot().phase).toBe('ready');
  } finally {
    boundary.disconnect();
    clock.mockRestore();
  }
  expect(boundary.revoked).toEqual(boundary.created);
});

test('late reservation recovery cannot survive cancellation, removal, replacement, actor teardown or remount', async () => {
  for (const action of ['cancel', 'remove', 'replace', 'actor', 'remount'] as const) {
    const editor = recoveryEditor();
    const boundary = recovery(editor);
    boundary.controller.choose(file());
    boundary.calls[0]!.result.reject(refusal('unavailable', 'old-reservation'));
    await settle();
    boundary.controller.retry();
    const resuming = boundary.calls[1]!;
    let disconnect = boundary.disconnect;
    if (action === 'cancel') boundary.controller.cancel();
    if (action === 'remove') boundary.controller.remove();
    if (action === 'replace') boundary.controller.choose(file());
    if (action === 'actor') editor.retire();
    if (action === 'remount') {
      disconnect();
      disconnect = boundary.controller.connect();
    }
    expect(resuming.signal.aborted).toBe(true);
    resuming.result.resolve({ src: 'old-reservation' });
    await settle();
    expect(editor.snapshot().draft?.avatar).toEqual(
      action === 'actor' ? undefined : action === 'remove' ? null : profile().avatar,
    );
    expect(boundary.controller.snapshot().phase).not.toBe('ready');
    if (action === 'actor') {
      const next = recoveryEditor(profile('account-two'));
      expect(next.snapshot().draft).toEqual(profile('account-two'));
    }
    disconnect();
    expect(boundary.revoked).toEqual(boundary.created);
    expect(boundary.revoked.every((url) => url.startsWith('blob:recovery-'))).toBe(true);
  }
});

test('a known reservation without an injected resume binding stays unknown instead of reserving another upload', async () => {
  const editor = recoveryEditor();
  const boundary = recovery(editor, false);
  boundary.controller.choose(file());
  boundary.calls[0]!.result.reject(refusal('unavailable', 'retained-reservation'));
  await settle();
  boundary.controller.retry();
  expect(boundary.calls).toHaveLength(1);
  expect(boundary.controller.canRetry()).toBe(false);
  expect(boundary.controller.snapshot()).toMatchObject({ phase: 'error', url: boundary.created[0] });
  expect(editor.snapshot().draft?.avatar).toEqual(profile().avatar);
  boundary.disconnect();
});
