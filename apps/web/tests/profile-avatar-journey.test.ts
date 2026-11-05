import { expect, test } from 'bun:test';
import { spyOn } from 'bun:test';
import {
  createMediaReservationIntent,
  readSiteAvatarUploadAdvice,
  uploadAvatar,
  UploadRefusal,
  type MediaReservationIntent,
  type UploadRefusalReason,
} from '../src/threads/upload';
import type { AvatarAdviceRead, AvatarAdviceReadResult, AvatarResume } from '../src/settings/profile-avatar-upload';
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
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const adviceTypes = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'] as const;
function advice(accountId: string, actions: ['upload'] | [] = ['upload']) {
  return {
    viewerState: 'signed_in' as const,
    viewer: { accountId },
    target: { containerId: accountId, purpose: 'avatar' as const },
    constraints: { mediaTypes: adviceTypes, maxByteCount: 20_971_520 as const },
    allowedActions: actions,
  };
}
function adviceResult(body: unknown, result: Partial<AvatarAdviceReadResult> = {}): AvatarAdviceReadResult {
  return { ok: true, body, responseTime: Date.now(), ...result };
}
async function submit(controller: ProfileAvatarUpload, selected = file()) {
  controller.choose(selected);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await settle();
    if (['original-only', 'crop', 'uploading', 'error', 'ready'].includes(controller.snapshot().phase)) break;
  }
  if (controller.snapshot().phase === 'original-only' || controller.snapshot().phase === 'crop')
    controller.useOriginal();
}
function uploads(editor: ProfileEditor, readAdvice?: AvatarAdviceRead) {
  const requests: {
    accountId: string;
    file: File;
    signal: AbortSignal;
    intent?: MediaReservationIntent;
    result: ReturnType<typeof deferred<{ src: string }>>;
  }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const upload: AvatarUpload = (accountId, file, signal, intent, onStage) => {
    onStage?.('reservation');
    const result = deferred<{ src: string }>();
    requests.push({ accountId, file, signal, intent, result });
    // Intentionally ignore abort: ownership must also guard an already completed provider response.
    return result.promise;
  };
  const controller = new ProfileAvatarUpload(
    editor,
    upload,
    {
      createObjectURL: () => {
        const url = `blob:owned-${created.length}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
    },
    undefined,
    readAdvice ?? (async () => adviceResult(advice(editor.snapshot().draft?.accountId ?? ''))),
  );
  return { controller, requests, created, revoked, disconnect: controller.connect() };
}
async function mounted(editor: ProfileEditor, readAdvice?: AvatarAdviceRead) {
  const boundary = uploads(editor, readAdvice);
  await settle();
  await settle();
  return boundary;
}

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
  const boundary = await mounted(editor);
  editor.edit({ biography: 'Unrelated unsaved biography' });
  await submit(boundary.controller);
  expect(boundary.controller.snapshot()).toEqual({
    phase: 'uploading',
    url: 'blob:owned-0',
    advice: 'allowed',
    stage: 'reservation',
  });
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  expect(editor.snapshot().known).toEqual(initial);
  expect(writes).toHaveLength(0);
  expect(boundary.requests[0]?.accountId).toBe(initial.accountId);

  boundary.requests[0]!.result.resolve({ src: 'uploaded-avatar' });
  await settle();
  expect(boundary.controller.snapshot()).toEqual({ phase: 'ready', url: 'blob:owned-0', advice: 'allowed' });
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
  expect(boundary.controller.snapshot()).toEqual({ phase: 'idle', url: null, advice: 'allowed' });
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
  const boundary = await mounted(editor);
  editor.edit({ displayName: 'Unsaved name', publicViews: { ...initial.publicViews, realms: true } });
  await submit(boundary.controller);
  boundary.controller.cancel();
  expect(boundary.requests[0]?.signal.aborted).toBe(true);
  boundary.requests[0]!.result.resolve({ src: 'late-cancelled' });
  await settle();
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  expect(boundary.controller.snapshot().phase).toBe('cancelled');

  await submit(boundary.controller);
  await submit(boundary.controller);
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

  await submit(boundary.controller);
  boundary.disconnect();
  const next = profile('account-two');
  const nextEditor = new ProfileEditor(
    { read: async () => next, save: async (attempt) => ({ ok: true, profile: attempt.after }) },
    next,
  );
  const nextBoundary = await mounted(nextEditor);
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
  const boundary = await mounted(editor);
  const selected = file();
  await submit(boundary.controller, selected);
  boundary.requests[0]!.result.reject(new Error('Upload refused'));
  await settle();
  expect(boundary.controller.snapshot()).toEqual({
    phase: 'error',
    url: 'blob:owned-0',
    stage: 'reservation',
    advice: 'allowed',
  });
  expect(editor.snapshot().draft?.avatar).toEqual(initial.avatar);
  boundary.controller.retry();
  expect(boundary.requests[1]?.file).toBe(selected);
  expect(boundary.requests[1]?.intent).toBe(boundary.requests[0]?.intent);
  expect(boundary.requests[1]?.signal).not.toBe(boundary.requests[0]?.signal);
  boundary.requests[1]!.result.resolve({ src: 'retry-upload' });
  await settle();
  boundary.controller.remove();
  expect(editor.snapshot().draft?.avatar).toBeNull();
  expect(editor.snapshot().known?.avatar).toEqual(initial.avatar);
  expect(writes).toHaveLength(0);
  await editor.submit('profile');
  expect(writes[0]?.patch).toEqual({ avatar: null });
  await submit(boundary.controller);
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
  const boundary = await mounted(editor);
  await submit(boundary.controller);
  boundary.requests[0]!.result.resolve({ src: 'uploaded-avatar' });
  await settle();
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('uncertain');
  await submit(boundary.controller);
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

function recovery(editor: ProfileEditor, resumeAvailable = true, readAdvice?: AvatarAdviceRead) {
  const calls: {
    operation: 'upload' | 'resume';
    target: string;
    file: File;
    signal: AbortSignal;
    intent?: MediaReservationIntent;
    result: ReturnType<typeof deferred<{ src: string }>>;
  }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const request = (
    operation: 'upload' | 'resume',
    target: string,
    file: File,
    signal: AbortSignal,
    intent?: MediaReservationIntent,
  ) => {
    const result = deferred<{ src: string }>();
    calls.push({ operation, target, file, signal, intent, result });
    return result.promise;
  };
  const upload: AvatarUpload = (accountId, file, signal, intent, onStage) => {
    onStage?.('reservation');
    return request('upload', accountId, file, signal, intent);
  };
  const resume: AvatarResume = (mediaId, file, signal) => request('resume', mediaId, file, signal);
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
    readAdvice ?? (async () => adviceResult(advice(editor.snapshot().draft?.accountId ?? ''))),
  );
  return { controller, calls, created, revoked, disconnect: controller.connect() };
}
async function mountedRecovery(editor: ProfileEditor, resumeAvailable = true, readAdvice?: AvatarAdviceRead) {
  const boundary = recovery(editor, resumeAvailable, readAdvice);
  await settle();
  await settle();
  return boundary;
}
function refusal(reason: UploadRefusalReason, mediaId?: string, retryAfter?: number) {
  const failure = new UploadRefusal(reason, retryAfter);
  if (mediaId) failure.mediaId = mediaId;
  if (retryAfter !== undefined) {
    failure.retryAfterHeader = String(retryAfter);
    failure.responseTime = Date.now();
  }
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
  const boundary = await mountedRecovery(editor);
  const selected = file();
  await submit(boundary.controller, selected);
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
  expect(boundary.controller.snapshot()).toEqual({ phase: 'ready', url: originalUrl, advice: 'allowed' });
  expect(editor.snapshot().draft?.avatar).toEqual({ media: 'native-avatar-reservation' });
  expect(editor.snapshot().known?.avatar).toEqual(profile().avatar);
  expect(boundary.revoked).toEqual([]);
  boundary.disconnect();
  expect(boundary.revoked).toEqual(boundary.created);
});

test('native file refusals require a new selection while closed and unavailable reasons remain distinct', async () => {
  for (const reason of ['type', 'too-large', 'rejected', 'closed', 'unavailable'] as const) {
    const boundary = await mountedRecovery(recoveryEditor());
    await submit(boundary.controller);
    boundary.calls[0]!.result.reject(refusal(reason, reason === 'rejected' ? 'rejected-reservation' : undefined));
    await settle();
    expect(boundary.controller.snapshot().failure).toEqual({ reason });
    const retryable = reason === 'closed' || reason === 'unavailable';
    expect(boundary.controller.canRetry()).toBe(retryable);
    if (!retryable) {
      boundary.controller.retry();
      expect(boundary.calls).toHaveLength(1);
      const replacement = file();
      await submit(boundary.controller, replacement);
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
  const boundary = await mountedRecovery(recoveryEditor());
  try {
    const selected = file();
    await submit(boundary.controller, selected);
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
    await submit(boundary.controller);
    expect(boundary.controller.snapshot().url).toBe('blob:recovery-1');
    boundary.controller.retry();
    boundary.controller.cancel();
    await submit(boundary.controller);
    boundary.controller.remove();
    const replacement = file();
    await submit(boundary.controller, replacement);
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
    const boundary = await mountedRecovery(editor);
    await submit(boundary.controller);
    boundary.calls[0]!.result.reject(refusal('unavailable', 'old-reservation'));
    await settle();
    boundary.controller.retry();
    const resuming = boundary.calls[1]!;
    let disconnect = boundary.disconnect;
    if (action === 'cancel') boundary.controller.cancel();
    if (action === 'remove') boundary.controller.remove();
    if (action === 'replace') await submit(boundary.controller);
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
  const boundary = await mountedRecovery(editor, false);
  await submit(boundary.controller);
  boundary.calls[0]!.result.reject(refusal('unavailable', 'retained-reservation'));
  await settle();
  boundary.controller.retry();
  expect(boundary.calls).toHaveLength(1);
  expect(boundary.controller.canRetry()).toBe(false);
  expect(boundary.controller.snapshot()).toMatchObject({ phase: 'error', url: boundary.created[0] });
  expect(editor.snapshot().draft?.avatar).toEqual(profile().avatar);
  boundary.disconnect();
});

test('upload admission follows current advice independently of profile-reference editing', async () => {
  const initial = profile();
  const writable = new ProfileEditor(
    { read: async () => initial, save: async (attempt) => ({ ok: true, profile: attempt.after }) },
    initial,
  );
  const denied = await mounted(writable, async () => adviceResult(advice(initial.accountId, [])));
  expect(denied.controller.canUpload()).toBe(false);
  await submit(denied.controller);
  expect(denied.requests).toHaveLength(0);
  denied.controller.remove();
  expect(writable.snapshot().draft?.avatar).toBeNull();
  denied.disconnect();

  const malformed = await mounted(writable, async () => adviceResult({ viewerState: 'signed_in' }));
  expect(malformed.controller.snapshot().advice).toBe('unavailable');
  await submit(malformed.controller);
  expect(malformed.requests).toHaveLength(0);
  malformed.disconnect();

  const readOnly = new ProfileEditor(
    {
      read: async () => initial,
      save: async (attempt) => ({ ok: true, profile: attempt.after }),
      canWrite: () => false,
    },
    initial,
  );
  const admitted = await mounted(readOnly);
  expect(readOnly.canWrite()).toBe(false);
  expect(admitted.controller.canUpload()).toBe(true);
  await submit(admitted.controller);
  expect(admitted.requests).toHaveLength(1);
  admitted.disconnect();
});

test('unavailable upload advice can be deliberately retried without selecting or uploading a file', async () => {
  const editor = recoveryEditor();
  const fresh = deferred<AvatarAdviceReadResult>();
  let reads = 0;
  const boundary = uploads(editor, async () => {
    reads++;
    if (reads === 1) throw new Error('advice unavailable');
    return fresh.promise;
  });
  await settle();
  expect(boundary.controller.snapshot().advice).toBe('unavailable');
  expect(boundary.controller.canOfferAdviceRetry()).toBe(true);
  boundary.controller.retryAdvice();
  expect(reads).toBe(2);
  fresh.resolve(adviceResult(advice(profile().accountId)));
  await settle();
  expect(boundary.controller.snapshot().advice).toBe('allowed');
  expect(boundary.controller.canUpload()).toBe(true);
  expect(boundary.requests).toHaveLength(0);
  boundary.disconnect();
});

test('retiring a target without a selection fences its late advice response', async () => {
  const editor = recoveryEditor();
  const late = deferred<AvatarAdviceReadResult>();
  let signal: AbortSignal | undefined;
  const boundary = uploads(editor, async (requestSignal) => {
    signal = requestSignal;
    return late.promise;
  });
  expect(boundary.controller.snapshot()).toMatchObject({ phase: 'idle', url: null, advice: 'loading' });
  editor.retire();
  expect(signal?.aborted).toBe(true);
  expect(boundary.controller.snapshot()).toMatchObject({ phase: 'idle', url: null, advice: 'unavailable' });
  late.resolve(adviceResult(advice(profile().accountId)));
  await settle();
  expect(boundary.controller.snapshot().advice).toBe('unavailable');
  expect(boundary.controller.canUpload()).toBe(false);
  expect(boundary.requests).toHaveLength(0);
  boundary.disconnect();
});

test('advice recovery preserves an uncertain reservation and its original upload deadline', async () => {
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const editor = recoveryEditor();
  const responses = [
    Response.json(advice(profile().accountId)),
    new Response(null, { status: 429, headers: { 'retry-after': '3' } }),
    Response.json(advice(profile().accountId), { headers: { 'retry-after': '1' } }),
  ];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);
  const boundary = await mountedRecovery(editor, true, readSiteAvatarUploadAdvice);
  try {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const selected = file();
    await submit(boundary.controller, selected);
    const original = boundary.calls[0]!;
    original.result.reject(refusal('rate-limited', 'original-reservation', 7));
    await settle();
    const originalUrl = boundary.controller.snapshot().url;
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      url: originalUrl,
      stage: 'reservation',
      failure: { reason: 'rate-limited', retryAfter: 7 },
      retryAt: 8_000,
      advice: 'allowed',
    });

    now = 2_000;
    boundary.controller.retryAdvice();
    await settle();
    await settle();
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      url: originalUrl,
      stage: 'reservation',
      retryAt: 8_000,
      advice: 'unavailable',
      adviceRetryAt: 5_000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(boundary.calls).toHaveLength(1);
    expect(boundary.controller.canRetry()).toBe(false);

    now = 4_999;
    boundary.controller.retryAdvice();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    now = 5_000;
    boundary.controller.retryAdvice();
    await settle();
    await settle();
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      url: originalUrl,
      retryAt: 8_000,
      advice: 'allowed',
      adviceRetryAt: 6_000,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(boundary.calls).toHaveLength(1);

    now = 7_999;
    boundary.controller.retry();
    expect(boundary.calls).toHaveLength(1);
    now = 8_000;
    boundary.controller.retry();
    expect(boundary.calls[1]).toMatchObject({
      operation: 'resume',
      target: 'original-reservation',
      file: selected,
    });
    expect(boundary.calls[0]!.intent?.file).toBe(selected);
  } finally {
    boundary.disconnect();
    fetchSpy.mockRestore();
    clock.mockRestore();
  }
  expect(boundary.revoked).toEqual(boundary.created);
});

test('an unknown reservation acknowledgement retries the original intent; a new file starts another', async () => {
  const editor = recoveryEditor();
  const boundary = await mountedRecovery(editor);
  const selected = file();
  await submit(boundary.controller, selected);
  const original = boundary.calls[0]!.intent;
  expect(original?.file).toBe(selected);
  expect(original?.body).toEqual({
    containerId: profile().accountId,
    purpose: 'avatar',
    mediaType: 'image/png',
    byteCount: selected.size,
  });
  boundary.calls[0]!.result.reject(refusal('unavailable'));
  await settle();
  boundary.controller.retry();
  expect(boundary.calls[1]?.operation).toBe('upload');
  expect(boundary.calls[1]?.intent).toBe(original);
  boundary.calls[1]!.result.reject(refusal('unavailable'));
  await settle();
  const other = file();
  await submit(boundary.controller, other);
  expect(boundary.calls[2]?.intent).not.toBe(original);
  expect(boundary.calls[2]?.intent?.key).not.toBe(original?.key);
  expect(boundary.calls[2]?.file).toBe(other);
  boundary.disconnect();
});

test('lost site reservation acknowledgement retries the original key and body on the actual uploader', async () => {
  const posts: { key: string | null; body: unknown }[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init = {}) => {
    if (init.method === 'POST') {
      posts.push({
        key: new Headers(init.headers).get('idempotency-key'),
        body: JSON.parse(String(init.body)),
      });
      if (posts.length === 1) throw new Error('acknowledgement lost');
    }
    return new Response(null, { status: 503 });
  });
  try {
    const selected = file();
    const intent = createMediaReservationIntent(
      { containerId: profile().accountId },
      selected,
      'avatar',
      profile().accountId,
    );
    await expect(
      uploadAvatar(profile().accountId, selected, new AbortController().signal, intent),
    ).rejects.toMatchObject({ reason: 'unavailable', mediaId: undefined });
    await expect(
      uploadAvatar(profile().accountId, selected, new AbortController().signal, intent),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(posts).toHaveLength(2);
    expect(posts[0]?.key).toBe(JSON.stringify(intent.key));
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]?.body).toEqual(intent.body);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('command waits keep the longest response-time Retry-After through delayed catch, 503 dates and replacement', async () => {
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const dateDeadline = 14_401_000;
  const httpDate = new Date(dateDeadline).toUTCString();
  const mediaId = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
  const selected = file();
  let mode: 'absent' | 'limit' | 'date' = 'absent';
  const delayed = (status: number, retryAfter: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('private-body'));
        },
        cancel() {
          now += 4_000;
        },
      }),
      { status, headers: { 'retry-after': retryAfter } },
    );
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init = {}) => {
    if (mode === 'absent') return new Response(null, { status: 503 });
    if (mode === 'limit') return delayed(429, '7200');
    if (init.method === 'POST')
      return Response.json({
        media: { id: mediaId, state: 'reserved', mediaType: selected.type, byteCount: selected.size },
      });
    return delayed(503, httpDate);
  });
  const refuse = async () =>
    uploadAvatar(profile().accountId, selected, new AbortController().signal).catch((error: unknown) => error);
  const editor = recoveryEditor();
  const boundary = await mountedRecovery(editor);
  try {
    await submit(boundary.controller, selected);
    boundary.calls[0]!.result.reject(await refuse());
    await settle();
    expect(boundary.controller.snapshot().retryAt ?? 0).toBe(0);
    expect(boundary.calls).toHaveLength(1);

    now = 1_000;
    mode = 'limit';
    boundary.controller.retry();
    const limited = await refuse();
    expect(limited).toMatchObject({
      reason: 'rate-limited',
      retryAfter: 3600,
      retryAfterHeader: '7200',
      responseTime: 1_000,
    });
    expect(now).toBe(5_000);
    boundary.calls[1]!.result.reject(limited);
    await settle();
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      failure: { reason: 'rate-limited', retryAfter: 3600 },
      retryAt: 7_201_000,
    });

    const replacement = file();
    await submit(boundary.controller, replacement);
    expect(boundary.calls).toHaveLength(2);
    expect(boundary.controller.snapshot().retryAt).toBe(7_201_000);

    now = 7_201_000;
    await settle();
    expect(boundary.calls).toHaveLength(2);

    mode = 'date';
    boundary.controller.retry();
    const paused = await refuse();
    expect(paused).toMatchObject({
      reason: 'unavailable',
      retryAfterHeader: httpDate,
      mediaId,
      responseTime: 7_201_000,
    });
    boundary.calls[2]!.result.reject(paused);
    await settle();
    expect(boundary.controller.snapshot()).toMatchObject({
      phase: 'error',
      failure: { reason: 'unavailable' },
      retryAt: dateDeadline,
    });
    now = dateDeadline - 1;
    boundary.controller.retry();
    expect(boundary.calls).toHaveLength(3);
    now = dateDeadline;
    await settle();
    expect(boundary.calls).toHaveLength(3);

    boundary.controller.retry();
    expect(boundary.calls[3]).toMatchObject({ operation: 'resume', target: mediaId, file: replacement });
    boundary.calls[3]!.result.resolve({ src: mediaId });
    await settle();
    expect(boundary.controller.snapshot().phase).toBe('ready');
    expect(editor.snapshot().draft?.avatar).toEqual({ media: mediaId });
  } finally {
    boundary.disconnect();
    fetchSpy.mockRestore();
    clock.mockRestore();
  }
});
