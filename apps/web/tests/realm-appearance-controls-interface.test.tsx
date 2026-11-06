import { expect, test } from 'bun:test';
import {
  createRealmAppearance,
  realmAppearanceHasUnsavedChanges,
  type RealmAppearanceAdapter,
  type RealmAppearanceCommand,
  type RealmAppearanceResult,
  type RealmAppearanceSelection,
} from '../src/community/realm-presentation';
import { configured, image, revisionId } from '../src/kernel/fake/community';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const file = () => new File(['image'], 'image.png', { type: 'image/png' });
function boundary(overrides: Partial<RealmAppearanceAdapter> = {}) {
  const commands: RealmAppearanceCommand[] = [];
  const adapter: RealmAppearanceAdapter = {
    read: async () => ({ kind: 'ready', snapshot: configured }),
    change: async (command) => {
      commands.push(command);
      return { kind: 'unavailable' };
    },
    select: async () => ({ kind: 'image', image }),
    upload: async () => ({ id: image.id }),
    resume: async () => ({ id: image.id }),
    ...overrides,
  };
  return {
    control: createRealmAppearance(configured.realmId, { kind: 'ready', snapshot: configured }, adapter),
    commands,
  };
}

test('cancel and clear retire a pending upload preview before a late response or save', async () => {
  const preview = deferred<RealmAppearanceSelection>();
  const { control, commands } = boundary({ select: () => preview.promise });
  const pending = control.upload('avatar', file());
  await Promise.resolve();
  expect(control.getSnapshot().pendingUpload?.mediaId).toBe(image.id);
  expect(realmAppearanceHasUnsavedChanges(control.getSnapshot(), configured.presentation)).toBe(true);
  control.cancelUpload();
  control.choose('avatar', { kind: 'image', image });
  const clearing = control.upload('avatar', file());
  await Promise.resolve();
  control.clear('avatar');
  expect(realmAppearanceHasUnsavedChanges(control.getSnapshot(), configured.presentation)).toBe(false);
  preview.resolve({ kind: 'image', image });
  await Promise.all([pending, clearing]);
  expect(control.getSnapshot().draft?.avatar.state).toBe('none');
  expect(control.getSnapshot().pendingUpload).toBeNull();
  await control.save();
  expect(commands[0]?.presentation.avatarMediaId).toBeNull();
});

test('a new file replaces an uncertain reservation and cannot be overwritten by an older upload', async () => {
  const old = deferred<{ id: string }>();
  const signals: AbortSignal[] = [];
  let uploads = 0;
  let resumes = 0;
  const { control, commands } = boundary({
    upload: async (_realm, _slot, _file, signal) => {
      signals.push(signal);
      if (++uploads === 1) return old.promise;
      if (uploads === 2) throw Object.assign(new Error('processing unavailable'), { mediaId: revisionId });
      return { id: image.id };
    },
    resume: async () => {
      resumes++;
      return { id: revisionId };
    },
  });
  const pending = control.upload('avatar', file());
  await control.upload('avatar', file());
  expect(signals[0]?.aborted).toBe(true);
  expect(control.getSnapshot().pendingUpload?.mediaId).toBe(revisionId);
  await control.upload('banner', file());
  old.resolve({ id: revisionId });
  await pending;
  expect(resumes).toBe(0);
  expect(control.getSnapshot().draft?.banner).toEqual({ state: 'available', value: image });
  expect(control.getSnapshot().draft?.presentation.avatarMediaId).toBeNull();
  await control.save();
  expect(commands[0]?.presentation).toEqual({ ...configured.presentation, bannerMediaId: image.id });
});

test('an uncertain reservation retries the caller key and file, repeating the same reservation command', async () => {
  const keys: string[] = [];
  const uploaded: File[] = [];
  const original = file();
  const { control } = boundary({
    upload: async (_realm, _slot, attempted, _signal, key) => {
      keys.push(key);
      uploaded.push(attempted);
      if (keys.length === 1) throw Object.assign(new Error('reservation unavailable'), { reason: 'unavailable' });
      return { id: image.id };
    },
  });
  await control.upload('avatar', original);
  expect(control.getSnapshot().pendingUpload).toEqual({ slot: 'avatar', mediaId: null });
  await control.upload('avatar');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(uploaded[1]).toBe(original);
  expect(control.getSnapshot().pendingUpload).toBeNull();
  expect(control.getSnapshot().draft?.avatar).toEqual({ state: 'available', value: image });
});

test('a changed revision retires uploads and stale saves while recovery replays the exact operation', async () => {
  const upload = deferred<{ id: string }>();
  const saved = deferred<RealmAppearanceResult>();
  const commands: RealmAppearanceCommand[] = [];
  let selects = 0;
  const { control } = boundary({
    upload: () => upload.promise,
    select: async () => {
      selects++;
      return { kind: 'image', image };
    },
    change: async (command) => {
      commands.push(command);
      return commands.length === 1
        ? saved.promise
        : { kind: 'confirmed', snapshot: { ...configured, head: revisionId } };
    },
  });
  const pendingUpload = control.upload('avatar', file());
  control.observe({ kind: 'ready', snapshot: { ...configured, head: revisionId } });
  upload.resolve({ id: image.id });
  await pendingUpload;
  expect(selects).toBe(0);
  expect(control.getSnapshot().pendingUpload).toBeNull();
  control.reviewConflict();
  const pendingSave = control.save();
  const current = { ...configured, head: image.id };
  control.observe({ kind: 'ready', snapshot: current });
  expect(control.getSnapshot().phase).toBe('uncertain');
  control.cancelUpload();
  await control.save();
  expect(commands[1]).toEqual(commands[0]);
  expect(control.getSnapshot().read).toEqual({ kind: 'ready', snapshot: current });
  expect(control.getSnapshot().phase).toBe('conflict');
  control.observe({ kind: 'ready', snapshot: { ...current, realmId: revisionId } });
  saved.resolve({ kind: 'confirmed', snapshot: { ...configured, head: revisionId } });
  await pendingSave;
  await control.save();
  expect(control.getSnapshot().read.kind).toBe('hidden');
  expect(commands).toHaveLength(2);
});

test('refreshing a newer head retires a known pending reservation', async () => {
  const { control } = boundary({
    upload: async () => {
      throw Object.assign(new Error('processing unavailable'), { mediaId: image.id });
    },
    read: async () => ({ kind: 'ready', snapshot: { ...configured, head: revisionId } }),
  });
  await control.upload('avatar', file());
  expect(control.getSnapshot().pendingUpload?.mediaId).toBe(image.id);
  await control.refresh();
  expect(control.getSnapshot().pendingUpload).toBeNull();
  expect(control.getSnapshot().phase).toBe('conflict');
});

test('confirmed replay preserves current image disclosure even when the receipt has the current head', async () => {
  const saved = deferred<RealmAppearanceResult>();
  const receipt = {
    ...configured,
    head: revisionId,
    presentation: { ...configured.presentation, avatarMediaId: image.id },
  };
  let calls = 0;
  const { control } = boundary({
    change: async () => (++calls === 1 ? saved.promise : { kind: 'confirmed', snapshot: receipt }),
  });
  control.choose('avatar', { kind: 'image', image });
  const saving = control.save();
  const current = { ...receipt, avatar: { state: 'unavailable' as const, value: null } };
  control.observe({ kind: 'ready', snapshot: current });
  saved.resolve({ kind: 'confirmed', snapshot: receipt });
  await saving;
  await control.save();
  expect(control.getSnapshot().read).toEqual({ kind: 'ready', snapshot: current });
  expect(control.getSnapshot().draft?.avatar).toEqual(current.avatar);
  expect(control.getSnapshot().phase).toBe('saved');
});
