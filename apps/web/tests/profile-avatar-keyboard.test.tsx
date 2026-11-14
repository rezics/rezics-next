import { expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type { Root } from 'react-dom/client';
import type { Window as HappyWindow } from 'happy-dom';
import { ProfileAvatar, useProfileAvatarUpload } from '../src/settings/profile-avatar';
import type { SettingsAvatarMedia } from '../src/settings/ports/content';
import { SettingsAmbientProvider } from '../src/settings/adapters/ambient-view';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient';
import type { ProfileValues } from '../src/settings/profile-model';
import { ProfileEditor } from '../src/settings/profile-write';
import { createMediaReservationIntent } from '../src/threads/upload';
import { UploadRefusal } from '../src/threads/upload-vocabulary';
import { m } from '../src/paraglide/messages.js';

const ambient = createBrowserSettingsAmbient();
const pending = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const profile = (accountId = 'account-one'): ProfileValues => ({
  accountId,
  kind: 'actor',
  displayName: 'Avery',
  biography: 'Saved biography',
  avatar: null,
  links: [],
  publicViews: { posts: true, reviews: true, collections: true, realms: false },
});
function editorFor(initial = profile()) {
  return new ProfileEditor(
    {
      ambient,
      read: async () => initial,
      save: async (attempt) => ({ ok: true, profile: attempt.after }),
    },
    initial,
  );
}
function fixture(editor: ProfileEditor) {
  const uploads: ReturnType<typeof pending<{ src: string }>>[] = [];
  const signals: AbortSignal[] = [];
  const content: SettingsAvatarMedia = {
    createIntent: (accountId, file) =>
      createMediaReservationIntent({ containerId: accountId }, file, 'avatar', accountId),
    upload: (_accountId, _file, signal, _intent, onStage) => {
      const result = pending<{ src: string }>();
      uploads.push(result);
      signals.push(signal);
      onStage?.('reservation');
      return result.promise;
    },
    resume: async () => {
      throw new Error('This fixture has no prior reservation');
    },
    readAdvice: async () => {
      const accountId = editor.snapshot().draft?.accountId ?? 'account-one';
      return {
        ok: true,
        responseTime: Date.now(),
        body: {
          viewerState: 'signed_in',
          viewer: { accountId },
          target: { containerId: accountId, purpose: 'avatar' },
          constraints: {
            mediaTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
            maxByteCount: 20_971_520,
          },
          allowedActions: ['upload'],
        },
      };
    },
  };
  return { editor, uploads, signals, content };
}

function MountedAvatar({ editor, content }: { editor: ProfileEditor; content: SettingsAvatarMedia }) {
  const profileState = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const upload = useProfileAvatarUpload(editor, !profileState.draft, content);
  const values = profileState.draft;
  return (
    <SettingsAmbientProvider ambient={ambient}>
      {values ? (
        <ProfileAvatar
          avatar={values.avatar}
          known={profileState.known?.avatar ?? null}
          mediaSource={() => ''}
          upload={upload}
          disabled={false}
        />
      ) : null}
      <label>
        Continue editing
        <textarea aria-label="Continue editing" />
      </label>
    </SettingsAmbientProvider>
  );
}

type BrowserContext = {
  browser: HappyWindow;
  host: HTMLElement;
  root: Root;
  user: import('@testing-library/user-event').UserEvent;
  within: typeof import('@testing-library/dom').within;
  waitFor: typeof import('@testing-library/dom').waitFor;
};
async function inBrowser(work: (context: BrowserContext) => Promise<void>) {
  const { Window } = await import('happy-dom');
  const browser = new Window({ url: 'https://rezics.test/settings#profile' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    File: browser.File,
    Blob: browser.Blob,
    URL: browser.URL,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    writable: true,
    value: async () => ({ width: 1, height: 1, close() {} }),
  });
  const canvas = browser.HTMLCanvasElement.prototype;
  const originalCreateUrl = Object.getOwnPropertyDescriptor(browser.URL, 'createObjectURL');
  const originalRevokeUrl = Object.getOwnPropertyDescriptor(browser.URL, 'revokeObjectURL');
  let preview = 0;
  Object.defineProperty(browser.URL, 'createObjectURL', {
    configurable: true,
    value: () => `blob:avatar-${preview++}`,
  });
  Object.defineProperty(browser.URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  const oldContext = Object.getOwnPropertyDescriptor(canvas, 'getContext');
  const oldToBlob = Object.getOwnPropertyDescriptor(canvas, 'toBlob');
  Object.defineProperty(canvas, 'getContext', { configurable: true, value: () => ({ drawImage() {} }) });
  Object.defineProperty(canvas, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => callback(new browser.Blob(['cropped fixture'], { type: 'image/png' })),
  });
  const [{ createRoot }, { default: userEvent }, { within, waitFor }] = await Promise.all([
    import('react-dom/client'),
    import('@testing-library/user-event'),
    import('@testing-library/dom'),
  ]);
  const host = browser.document.createElement('main');
  browser.document.body.append(host);
  const root = createRoot(host);
  try {
    await work({ browser, host, root, user: userEvent.setup(), within, waitFor });
  } finally {
    await act(() => root.unmount());
    await browser.happyDOM.abort();
    if (oldContext) Object.defineProperty(canvas, 'getContext', oldContext);
    else Reflect.deleteProperty(canvas, 'getContext');
    if (oldToBlob) Object.defineProperty(canvas, 'toBlob', oldToBlob);
    else Reflect.deleteProperty(canvas, 'toBlob');
    if (originalCreateUrl) Object.defineProperty(browser.URL, 'createObjectURL', originalCreateUrl);
    else Reflect.deleteProperty(browser.URL, 'createObjectURL');
    if (originalRevokeUrl) Object.defineProperty(browser.URL, 'revokeObjectURL', originalRevokeUrl);
    else Reflect.deleteProperty(browser.URL, 'revokeObjectURL');
    if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

async function mount(root: Root, fixture: ReturnType<typeof fixture>) {
  await act(async () => root.render(<MountedAvatar editor={fixture.editor} content={fixture.content} />));
}
function avatarGroup(host: HTMLElement, within: BrowserContext['within']) {
  return within(host).getByRole('group', { name: m.settings_profile_avatar() });
}
function tinyPng(browser: HappyWindow) {
  return new browser.File(
    [
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8,
        6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 1, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0,
      ]),
    ],
    'avatar.png',
    { type: 'image/png' },
  );
}
async function chooseFile(context: BrowserContext, file: File) {
  const group = avatarGroup(context.host, context.within);
  const input = group.querySelector<HTMLInputElement>('input[type="file"]')!;
  await context.user.upload(input, file);
  return group;
}
async function chooseOriginalOnly(context: BrowserContext) {
  const file = new context.browser.File(['fixture bytes'], 'avatar.png', { type: 'image/png' });
  const group = await chooseFile(context, file);
  await context.within(group).findByText(m.settings_profile_crop_original_only());
  return group;
}
async function waitForUpload(context: BrowserContext, fixture: ReturnType<typeof fixture>, count = 1) {
  await context.waitFor(() => expect(fixture.uploads).toHaveLength(count));
  const cancel = context.within(avatarGroup(context.host, context.within)).getByRole('button', {
    name: m.settings_profile_avatar_cancel(),
  });
  return cancel;
}

test('keyboard Apply keeps focus through failure, then explicit Retry returns to Choose', async () =>
  inBrowser(async (context) => {
    const fixtureState = fixture(editorFor());
    await mount(context.root, fixtureState);
    const group = await chooseFile(context, tinyPng(context.browser) as unknown as File);
    const crop = await context.within(group).findByRole('region', { name: m.settings_profile_crop_heading() });
    const apply = context.within(crop).getByRole('button', { name: m.settings_profile_crop_apply() });
    apply.focus();
    await context.user.keyboard('{Enter}');
    const cancel = await waitForUpload(context, fixtureState);
    expect(context.browser.document.activeElement).toBe(cancel);
    fixtureState.uploads[0]!.reject(new UploadRefusal('unavailable'));
    await context.within(group).findByRole('alert');
    expect(context.browser.document.activeElement).toBe(cancel);
    const retry = context.within(group).getByRole('button', { name: m.settings_profile_avatar_retry() });
    retry.focus();
    await context.user.keyboard('{Enter}');
    const choose = context.within(group).getByRole('button', { name: m.settings_profile_choose_avatar() });
    await context.waitFor(() => expect(fixtureState.uploads).toHaveLength(2));
    expect(context.browser.document.activeElement).toBe(choose);
    fixtureState.uploads[1]!.resolve({ src: 'uploaded-fixture-avatar' });
    await context.within(group).findByText(m.settings_profile_avatar_ready());
    expect(context.browser.document.activeElement).toBe(choose);
  }));

test('keyboard Use original in original-only state moves focus before its control disappears', async () =>
  inBrowser(async (context) => {
    const fixtureState = fixture(editorFor());
    await mount(context.root, fixtureState);
    const group = await chooseOriginalOnly(context);
    const original = context.within(group).getByRole('button', { name: m.settings_profile_crop_use_original() });
    original.focus();
    await context.user.keyboard('{Enter}');
    const cancel = await waitForUpload(context, fixtureState);
    expect(context.browser.document.activeElement).toBe(cancel);
    fixtureState.uploads[0]!.resolve({ src: 'uploaded-fixture-avatar' });
    await context.within(group).findByText(m.settings_profile_avatar_ready());
    expect(context.browser.document.activeElement).toBe(cancel);
  }));

test('a delayed upload does not pull focus back after the user moves into profile editing', async () =>
  inBrowser(async (context) => {
    const fixtureState = fixture(editorFor());
    await mount(context.root, fixtureState);
    const group = await chooseOriginalOnly(context);
    context.within(group).getByRole('button', { name: m.settings_profile_crop_use_original() }).focus();
    await context.user.keyboard('{Enter}');
    await waitForUpload(context, fixtureState);
    await context.user.keyboard('{Tab}');
    const continuation = context.within(context.host).getByRole('textbox', { name: 'Continue editing' });
    expect(context.browser.document.activeElement).toBe(continuation);
    fixtureState.uploads[0]!.resolve({ src: 'uploaded-fixture-avatar' });
    await context.within(group).findByText(m.settings_profile_avatar_ready());
    expect(context.browser.document.activeElement).toBe(continuation);
  }));

test('cancel returns to Choose, and account replacement retires a late focus intent', async () =>
  inBrowser(async (context) => {
    const first = fixture(editorFor());
    await mount(context.root, first);
    const group = await chooseOriginalOnly(context);
    context.within(group).getByRole('button', { name: m.settings_profile_crop_use_original() }).focus();
    await context.user.keyboard('{Enter}');
    const cancel = await waitForUpload(context, first);
    await context.user.keyboard('{Enter}');
    const choose = context.within(group).getByRole('button', { name: m.settings_profile_choose_avatar() });
    expect(context.browser.document.activeElement).toBe(choose);
    expect(first.signals[0]?.aborted).toBe(true);
    first.uploads[0]!.resolve({ src: 'late-cancelled-avatar' });
    await Promise.resolve();
    expect(context.browser.document.activeElement).toBe(choose);

    await chooseOriginalOnly(context);
    context.within(group).getByRole('button', { name: m.settings_profile_crop_use_original() }).focus();
    await context.user.keyboard('{Enter}');
    await waitForUpload(context, first, 2);
    const next = fixture(editorFor(profile('account-two')));
    await act(async () => {
      first.editor.retire();
      context.root.render(<MountedAvatar editor={next.editor} content={next.content} />);
    });
    const nextContinuation = context.within(context.host).getByRole('textbox', { name: 'Continue editing' });
    nextContinuation.focus();
    first.uploads[1]!.resolve({ src: 'late-old-account-avatar' });
    await Promise.resolve();
    expect(context.browser.document.activeElement).toBe(nextContinuation);
    expect(context.browser.document.activeElement).not.toBe(cancel);
  }));
