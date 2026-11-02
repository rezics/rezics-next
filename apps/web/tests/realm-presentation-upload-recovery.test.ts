import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { configured, image } from '../src/kernel/fake/community';
import { createRealmAppearance, type RealmAppearanceAdapter } from '../src/community/realm-presentation';

mock.module('../src/session/query', () => ({ sessionCsrfToken: () => 'site-csrf' }));
const { uploadRealmImage, resumeRealmImageUpload } = await import('../src/threads/upload');
const realm = configured.realmId;
const [icon, banner, other] = ['0192f3a0-6c1e-7b2a-9d4e-0000000000a1', '0192f3a0-6c1e-7b2a-9d4e-0000000000a2', '0192f3a0-6c1e-7b2a-9d4e-0000000000a3'];
const calls: { method: string; path: string; body: RequestInit['body']; signal?: AbortSignal }[] = [];
let stop = () => {};
const pic = (bytes: string) => new File([bytes], 'image.png', { type: 'image/png' });
const media = (id: string, state: string, source: File, container = realm) =>
  Response.json({ media: { id, state, mediaType: source.type, byteCount: source.size, containerId: container } });
const posts = () => calls.filter((call) => call.method === 'POST');
const puts = () => calls.filter((call) => call.method === 'PUT');
const use = (handler: (path: string, init: RequestInit) => Response | Promise<Response>) => {
  calls.length = 0;
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input, init = {}) => {
    calls.push({ method: init.method ?? 'GET', path: String(input), body: init.body, signal: init.signal ?? undefined });
    return handler(String(input), init);
  }) as typeof fetch);
  stop = () => spy.mockRestore();
};
function open() {
  const selected: string[] = [];
  const saved: unknown[] = [];
  const adapter: RealmAppearanceAdapter = {
    read: async () => ({ kind: 'ready', snapshot: configured }),
    change: async (command) => (saved.push(command), { kind: 'unavailable' }),
    select: async (choice) =>
      choice.kind === 'image'
        ? (selected.push(choice.mediaId), { kind: 'image', image: { ...image, id: choice.mediaId, containerId: realm } })
        : { kind: 'unavailable' },
    upload: (id, slot, file, signal) => uploadRealmImage(id, slot === 'avatar' ? 'realm-icon' : 'realm-banner', file, signal),
    resume: resumeRealmImageUpload,
  };
  return { selected, saved, control: createRealmAppearance(realm, { kind: 'ready', snapshot: configured }, adapter) };
}
afterEach(() => stop());

test('Realm icon and banner retry finishes the original upload without a new reservation', async () => {
  for (const [slot, id, purpose] of [['avatar', icon, 'realm-icon'], ['banner', banner, 'realm-banner']] as const) {
    const file = pic(`${slot}-bytes`);
    use((_path, init) =>
      init.method === 'POST' ? media(id, 'reserved', file)
      : init.method === 'PUT' ? new Response(null, { status: puts().length > 1 ? 204 : 503 })
      : media(id, puts().length > 1 ? 'available' : 'reserved', file));
    const view = open();
    await view.control.upload(slot, file);
    await view.control.upload(slot);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]!.body)).purpose).toBe(purpose);
    expect(await (puts()[1]!.body as Blob).text()).toBe(`${slot}-bytes`);
    expect(view.control.getSnapshot().draft?.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId']).toBe(id);
    expect(view.saved).toHaveLength(0);
  }
});

test('uncertain completion reconciles the original id; abort, retirement and replacement cannot select old bytes', async () => {
  const file = pic('landed-bytes');
  const next = pic('replacement-bytes');
  use((_path, init) =>
    init.method === 'POST' ? media(icon, 'reserved', file)
    : init.method === 'PUT' ? Promise.reject(new Error('lost completion'))
    : media(icon, 'available', file));
  let view = open();
  await view.control.upload('avatar', file);
  await view.control.upload('avatar');
  expect([posts().length, puts().length, view.selected[0], view.saved.length]).toEqual([1, 1, icon, 0]);
  use((_path, init) =>
    init.method === 'POST' ? media(icon, 'reserved', file)
    : init.method === 'PUT' ? new Response(null, { status: 204 })
    : media(icon, 'rejected', file));
  view = open();
  await view.control.upload('avatar', file);
  const held = calls.length;
  await view.control.upload('avatar');
  expect(calls).toHaveLength(held);
  expect(view.control.getSnapshot().pendingUpload).toBeNull();
  let go!: () => void;
  const gate = new Promise<void>((resolve) => (go = resolve));
  use((_path, init) => {
    if (init.method === 'POST') return media(posts().length === 1 ? icon : other, 'reserved', posts().length === 1 ? file : next);
    if (init.method === 'PUT' && calls.at(-1)?.path.endsWith(icon)) {
      go();
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true }));
    }
    return media(other, 'available', next);
  });
  view = open();
  const first = view.control.upload('avatar', file);
  await gate;
  await view.control.upload('avatar', next);
  await first;
  expect(view.selected).toEqual([other]);
  expect(puts().some((call) => call.signal?.aborted)).toBe(true);
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  use((_path, init) =>
    init.method === 'POST' ? media(icon, 'reserved', file)
    : init.method === 'PUT' ? new Response(null, { status: 503 })
    : (started(), new Promise((resolve) => (release = resolve))));
  view = open();
  await view.control.upload('avatar', file);
  const retry = view.control.upload('avatar');
  await ready;
  view.control.disconnect();
  await Promise.resolve();
  release(media(icon, 'available', file));
  await retry;
  expect(view.selected).toHaveLength(0);
  expect(view.control.getSnapshot().draft).toBeNull();
  use((_path, init) =>
    init.method === 'POST' ? media(icon, 'reserved', file)
    : init.method === 'PUT' ? new Response(null, { status: 503 })
    : media(icon, 'reserved', file, other));
  view = open();
  await view.control.upload('avatar', file);
  await view.control.upload('avatar');
  expect(puts()).toHaveLength(1);
  expect(view.selected).toHaveLength(0);
});
