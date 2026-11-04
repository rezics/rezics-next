import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, createElement, useState, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { ProfileReadResult, ProfileSaveResult, ProfileValues } from '../src/settings/profile-data';
import type { ProfileAttempt, ProfileEditor } from '../src/settings/profile-write';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const accountA = '019a0000-0000-7000-8000-000000000101';
const accountB = '019a0000-0000-7000-8000-000000000102';
const avatarId = '019a0000-0000-7000-8000-000000000201';
const readRequests: Deferred<ProfileReadResult>[] = [];
const saveRequests: { attempt: ProfileAttempt; headers: Headers; result: Deferred<ProfileSaveResult> }[] = [];
const uploadRequests: {
  accountId: string;
  file: File;
  signal: AbortSignal;
  result: Deferred<{ src: string }>;
}[] = [];

function readProfileBoundary() {
  const request = deferred<ProfileReadResult>();
  readRequests.push(request);
  return request.promise;
}

function saveProfileBoundary(input: { data: ProfileAttempt; headers?: HeadersInit }) {
  const request = { attempt: input.data, headers: new Headers(input.headers), result: deferred<ProfileSaveResult>() };
  saveRequests.push(request);
  return request.result.promise;
}

function uploadAvatarBoundary(accountId: string, file: File, signal: AbortSignal) {
  const request = { accountId, file, signal, result: deferred<{ src: string }>() };
  uploadRequests.push(request);
  return request.result.promise;
}

class MockUploadRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly retryAfter?: number,
  ) {
    super(reason);
  }
  mediaId?: string;
}

// These are the native/BFF and upload transport boundaries. The reader, editor, cache, composition and cards stay real.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/settings/actions', () => ({ readProfile: readProfileBoundary, saveProfile: saveProfileBoundary }));
mock.module('../src/threads/upload', () => ({
  createMediaReservationIntent: () => undefined,
  readSiteAvatarUploadAdvice: async () => avatarAdvice(),
  UploadRefusal: MockUploadRefusal,
  uploadAvatar: uploadAvatarBoundary,
  resumeReplyImageUpload: uploadAvatarBoundary,
}));

function profile(accountId = accountA): ProfileValues {
  return {
    accountId,
    kind: 'organization',
    displayName: 'Current organization',
    biography: 'Current organization biography',
    avatar: {
      media: avatarId,
      width: 96,
      height: 80,
      placeholder: { thumbhash: 'profile-avatar-thumbhash', color: '#123456' },
      variants: [
        { format: 'avif', width: 96 },
        { format: 'webp', width: 48 },
      ],
      focalPoint: { x: 0.25, y: 0.75 },
      credit: null,
    },
    links: [{ label: 'Website', url: 'https://organization.example.test' }],
    publicViews: { posts: true, reviews: true, collections: false, realms: true },
    speakersListed: false,
  };
}

function successRead(value: ProfileValues): ProfileReadResult {
  return { ok: true, profile: value };
}

function failedRead(status: number, retryAfter?: string): ProfileReadResult {
  return { ok: false, status, failure: { status, ...(retryAfter ? { retryAfter } : {}) } };
}

function session(subject: string, csrfToken: string | null) {
  return { state: 'signed-in' as const, subject, csrfToken };
}

function avatarAdvice() {
  return {
    viewerState: 'signed_in',
    viewer: { accountId: accountA },
    target: { containerId: accountA, purpose: 'avatar' },
    constraints: {
      mediaTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      maxByteCount: 20_971_520,
    },
    allowedActions: ['upload'],
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// This complete supported-reader journey is authored for the landing acceptance and intentionally UNRUN here.
test('the connected Profile and Public activity journey shares safe reads and permanently retires replaced owners', async () => {
  readRequests.length = 0;
  saveRequests.length = 0;
  uploadRequests.length = 0;

  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/settings' });
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  class TestURL extends URL {
    static override createObjectURL(_blob: Blob) {
      const url = `blob:profile-reader-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    }
    static override revokeObjectURL(url: string) {
      revokedUrls.push(url);
    }
  }
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    URL: TestURL,
    File: window.File,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let root: import('react-dom/client').Root | undefined;
  let client: import('@tanstack/react-query').QueryClient | undefined;
  try {
    const [reactDom, query, routerApi, sessionApi, profileApi, activityApi, hookApi, accountApi, serverDom, messages] =
      await Promise.all([
        import('react-dom/client'),
        import('@tanstack/react-query'),
        import('@tanstack/react-router'),
        import('../src/session/query'),
        import('../src/settings/profile'),
        import('../src/settings/public-views'),
        import('../src/settings/profile-write-query'),
        import('../src/accounts/profile-editor/editor'),
        import('react-dom/server'),
        import('../src/paraglide/messages.js'),
      ]);
    const { createRoot } = reactDom;
    const { QueryClient, QueryClientProvider } = query;
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = routerApi;
    const { sessionQuery } = sessionApi;
    const { ProfileCard, ProfileSection } = profileApi;
    const { PublicViewsCard, PublicViewsSection } = activityApi;
    const { useProfileEditor } = hookApi;
    const { AccountProfileEditor } = accountApi;
    const { renderToStaticMarkup } = serverDom;
    const { m } = messages;
    const surfaceEditors: ProfileEditor[] = [];
    let currentEditor: ProfileEditor | undefined;
    let currentReadable = false;
    let currentWritable = false;
    let nativeProfile = profile();
    let setPublicOnly = (_value: boolean) => {};

    function Probe() {
      const result = useProfileEditor();
      surfaceEditors.push(result.editor);
      currentEditor = result.editor;
      currentReadable = result.readable;
      currentWritable = result.writable;
      return null;
    }

    function Surface() {
      const [publicOnly, setPublicOnlyState] = useState(false);
      setPublicOnly = (value) => setPublicOnlyState(value);
      return createElement(
        'main',
        null,
        publicOnly ? null : createElement(ProfileSection),
        createElement(PublicViewsSection),
        createElement(Probe),
        createElement(Probe),
      );
    }

    const rootRoute = createRootRoute({ component: () => createElement(Outlet) });
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings',
      component: Surface,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([settingsRoute]),
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, session(accountA, null));
    const host = window.document.createElement('main');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);

    const flush = async () => {
      await act(async () => {
        await tick();
        await Promise.resolve();
      });
    };
    const render = async (node: ReactNode = createElement(RouterProvider, { router })) =>
      act(async () => {
        root!.render(createElement(QueryClientProvider, { client: client! }, createElement(StrictMode, null, node)));
        await Promise.resolve();
      });
    const until = async (predicate: () => boolean, label: string) => {
      for (let turn = 0; turn < 120; turn++) {
        if (predicate()) return;
        await flush();
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const editor = () => {
      if (!currentEditor) throw new Error('The production ProfileSection did not mount its shared editor.');
      return currentEditor;
    };
    const button = (label: string, occurrence = 0) => {
      const matches = [...host.querySelectorAll('button')].filter((item) => item.textContent?.trim() === label);
      const result = matches[occurrence];
      if (!result) throw new Error(`Missing button: ${label}`);
      return result;
    };
    const publicSwitch = (label: string) => {
      const labelNode = [...host.querySelectorAll('label')].find((item) => item.textContent?.includes(label));
      const result = labelNode?.querySelector<HTMLButtonElement>('[role="switch"]');
      if (!result) throw new Error(`Missing public activity switch: ${label}`);
      return result;
    };
    const togglePublicSwitch = async (label: string) => {
      const control = publicSwitch(label).closest('label')?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!control) throw new Error(`Missing public activity switch input: ${label}`);
      await click(control);
    };
    const resolveRead = async (index: number, value: ProfileReadResult) => {
      await act(async () => {
        const request = readRequests[index];
        if (!request) throw new Error(`Missing current-profile read ${index}.`);
        request.resolve(value);
        await tick();
      });
    };
    const resolveWrite = async (index: number, value: ProfileSaveResult, applied?: ProfileValues) => {
      await act(async () => {
        const request = saveRequests[index];
        if (!request) throw new Error(`Missing profile write ${index}.`);
        if (applied) nativeProfile = structuredClone(applied);
        request.result.resolve(value);
        await tick();
      });
    };
    const click = async (element: HTMLElement) =>
      act(async () => {
        element.click();
        await Promise.resolve();
      });

    await render();
    await until(() => readRequests.length >= 1, 'the first same-account profile read');
    expect(readRequests).toHaveLength(1);
    expect(new Set(surfaceEditors).size).toBe(1);
    const readOnlyEditor = editor();
    expect(currentReadable).toBe(true);
    expect(currentWritable).toBe(false);
    expect(readOnlyEditor.canWrite()).toBe(false);
    await resolveRead(0, successRead(nativeProfile));
    await until(() => readOnlyEditor.snapshot().readAuthority === 'allowed', 'read-only profile data');

    const displayName = host.querySelector<HTMLInputElement>('input[id$="-displayName"]');
    const biography = host.querySelector<HTMLTextAreaElement>('textarea');
    expect(displayName?.value).toBe('Current organization');
    expect(displayName?.disabled).toBe(true);
    expect(biography?.value).toBe('Current organization biography');
    expect(biography?.disabled).toBe(true);
    expect(
      renderToStaticMarkup(createElement(ProfileCard, { editor: readOnlyEditor, writable: false, readable: true })),
    ).toContain(avatarId);
    expect(host.innerHTML).toContain('organization.example.test');
    expect(publicSwitch(m.settings_public_reviews()).getAttribute('aria-checked')).toBe('true');
    expect(publicSwitch(m.settings_public_reviews()).getAttribute('aria-disabled')).toBe('true');
    expect(publicSwitch(m.settings_public_speakers()).getAttribute('aria-checked')).toBe('false');
    expect(publicSwitch(m.settings_public_speakers()).getAttribute('aria-disabled')).toBe('true');
    expect(button(m.settings_profile_reload_current()).disabled).toBe(false);
    const readOnlyState = readOnlyEditor.snapshot();
    readOnlyEditor.edit({ biography: 'A read-only callback must not change this.' });
    await readOnlyEditor.submit('profile');
    await readOnlyEditor.retry();
    expect(readOnlyEditor.snapshot()).toBe(readOnlyState);
    expect(saveRequests).toHaveLength(0);

    const capturedReadOnlyReload = readOnlyEditor.reload.bind(readOnlyEditor);
    const firstReload = readRequests.length;
    await click(button(m.settings_profile_reload_current()));
    await until(() => readRequests.length === firstReload + 1, 'the safe read-only reload');
    await resolveRead(firstReload, failedRead(503, '60'));
    await until(() => readOnlyEditor.snapshot().readRetryAt > Date.now(), 'the read-only Retry-After wait');
    const readRetryAt = readOnlyEditor.snapshot().readRetryAt;
    expect(readOnlyEditor.snapshot().known).toEqual(nativeProfile);
    expect(saveRequests).toHaveLength(0);
    expect(host.textContent?.split(m.settings_retry_wait()).length).toBeGreaterThan(2);
    const reloadButtons = [...host.querySelectorAll('button')].filter(
      (item) => item.textContent?.trim() === m.settings_profile_reload_current(),
    );
    expect(reloadButtons.length).toBeGreaterThan(1);
    expect(reloadButtons.every((item) => item.disabled)).toBe(true);
    const actualNow = Date.now;
    let remountedMarkup = '';
    try {
      Date.now = () => readRetryAt;
      remountedMarkup = renderToStaticMarkup(
        createElement(PublicViewsCard, { editor: readOnlyEditor, writable: false, readable: true }),
      );
    } finally {
      Date.now = actualNow;
    }
    expect(remountedMarkup).not.toContain(m.settings_retry_wait());
    expect(new window.DOMParser().parseFromString(remountedMarkup, 'text/html').querySelector('button')?.disabled).toBe(
      false,
    );
    await capturedReadOnlyReload();
    expect(readRequests).toHaveLength(firstReload + 1);
    expect(readOnlyEditor.snapshot().readRetryAt).toBe(readRetryAt);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((item) => item.queryKey),
      ),
    ).not.toContain('csrf-secret-one');

    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountA, 'csrf-secret-one')));
    await until(() => readRequests.length === firstReload + 2, 'a fresh writable observation');
    expect(readOnlyEditor.snapshot().known).toBeNull();
    expect(readOnlyEditor.snapshot().draft).toBeNull();
    expect(readOnlyEditor.snapshot().readRetryAt).toBe(0);
    const readsAfterRetirement = readRequests.length;
    await capturedReadOnlyReload();
    expect(readRequests).toHaveLength(readsAfterRetirement);
    const writableEditor = editor();
    expect(writableEditor).not.toBe(readOnlyEditor);
    expect(currentReadable).toBe(true);
    expect(currentWritable).toBe(true);
    await resolveRead(firstReload + 1, successRead(nativeProfile));
    await until(() => writableEditor.snapshot().readAuthority === 'allowed', 'the current-token profile');
    expect(displayName?.isConnected).toBe(false);
    const currentName = host.querySelector<HTMLInputElement>('input[id$="-displayName"]');
    expect(currentName?.disabled).toBe(false);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((item) => item.queryKey),
      ),
    ).not.toContain('csrf-secret-one');

    await act(async () =>
      writableEditor.edit({
        displayName: 'Updated organization',
        biography: 'Updated biography',
        links: [{ label: 'Updated site', url: 'https://updated.example.test' }],
      }),
    );
    expect(host.querySelector<HTMLInputElement>('input[id$="-displayName"]')?.value).toBe('Updated organization');
    const profileSaveCount = saveRequests.length;
    await click(button(m.settings_profile_save()));
    await until(() => saveRequests.length === profileSaveCount + 1, 'the profile command');
    const profileCommand = saveRequests[profileSaveCount]!;
    expect(profileCommand.attempt.before.accountId).toBe(accountA);
    expect(profileCommand.attempt.after.accountId).toBe(accountA);
    expect(profileCommand.attempt.patch).toEqual({
      displayName: 'Updated organization',
      biography: 'Updated biography',
      links: [{ label: 'Updated site', url: 'https://updated.example.test' }],
    });
    expect(profileCommand.headers.get('X-CSRF-Token')).toBe('csrf-secret-one');
    const profileAfter = profileCommand.attempt.after;
    const profileReadback = readRequests.length;
    const capturedRetry = writableEditor.retry.bind(writableEditor);
    await resolveWrite(profileSaveCount, { ok: true, profile: profileAfter }, profileAfter);
    await until(() => readRequests.length === profileReadback + 1, 'profile save readback');
    await resolveRead(profileReadback, failedRead(503));
    await until(
      () => writableEditor.snapshot().acknowledged && writableEditor.snapshot().readStatus === 'failed',
      'the acknowledged profile with an unavailable current read',
    );
    expect(host.textContent?.includes(m.settings_profile_acknowledged_stale())).toBe(true);
    await act(async () => setPublicOnly(true));
    expect(editor()).toBe(writableEditor);
    await capturedRetry();
    expect(saveRequests).toHaveLength(profileSaveCount + 1);
    expect(
      [...host.querySelectorAll('button')].filter((item) =>
        [m.settings_profile_retry_save(), m.settings_public_activity_retry()].includes(item.textContent?.trim() ?? ''),
      ),
    ).toHaveLength(0);
    await act(async () => writableEditor.edit({ displayName: 'Current organization' }));
    nativeProfile = { ...profileAfter, displayName: 'Another writer', biography: 'Current native biography' };
    const deliberateRead = readRequests.length;
    await click(button(m.settings_profile_reload_current()));
    await until(() => readRequests.length === deliberateRead + 1, 'the deliberate current-profile read');
    await resolveRead(deliberateRead, successRead(nativeProfile));
    await until(
      () => !writableEditor.snapshot().acknowledged && writableEditor.snapshot().attempt === null,
      'acknowledged recovery resolution',
    );
    expect(saveRequests).toHaveLength(profileSaveCount + 1);
    expect(writableEditor.snapshot().known?.displayName).toBe('Another writer');
    expect(writableEditor.snapshot().draft?.displayName).toBe('Current organization');
    expect(writableEditor.snapshot().draft?.biography).toBe('Current native biography');
    await act(async () => setPublicOnly(false));
    await until(
      () => host.querySelector<HTMLTextAreaElement>('textarea')?.value === 'Current native biography',
      'new native Profile values after switching back',
    );

    const reviewSwitch = publicSwitch(m.settings_public_reviews());
    expect(reviewSwitch.getAttribute('aria-disabled')).toBeNull();
    const viewSaveCount = saveRequests.length;
    await togglePublicSwitch(m.settings_public_reviews());
    expect(publicSwitch(m.settings_public_reviews()).getAttribute('aria-checked')).toBe('false');
    await click(button(m.settings_profile_save_activity()));
    await until(() => saveRequests.length === viewSaveCount + 1, 'the public activity command');
    const viewCommand = saveRequests[viewSaveCount]!;
    expect(viewCommand.attempt.scope).toBe('views');
    expect(viewCommand.attempt.patch).toEqual({ publicViews: { reviews: false } });
    expect(viewCommand.headers.get('X-CSRF-Token')).toBe('csrf-secret-one');
    const viewsAfter = viewCommand.attempt.after;
    const viewsReadback = readRequests.length;
    await resolveWrite(viewSaveCount, { ok: true, profile: viewsAfter }, viewsAfter);
    await until(() => readRequests.length === viewsReadback + 1, 'public activity readback');
    await resolveRead(viewsReadback, successRead(viewsAfter));
    await until(
      () => writableEditor.snapshot().phase === 'review' && writableEditor.snapshot().attempt === null,
      'public activity confirmation with the later Profile draft retained',
    );
    expect(writableEditor.snapshot().known?.publicViews.reviews).toBe(false);
    expect(writableEditor.snapshot().draft?.displayName).toBe('Current organization');

    const speakerSwitch = publicSwitch(m.settings_public_speakers());
    expect(speakerSwitch.getAttribute('aria-checked')).toBe('false');
    const speakerSaveCount = saveRequests.length;
    await togglePublicSwitch(m.settings_public_speakers());
    expect(publicSwitch(m.settings_public_speakers()).getAttribute('aria-checked')).toBe('true');
    await click(button(m.settings_profile_save_activity()));
    await until(() => saveRequests.length === speakerSaveCount + 1, 'organization speaker listing command');
    const speakerCommand = saveRequests[speakerSaveCount]!;
    expect(speakerCommand.attempt.patch).toEqual({ speakersListed: true });
    const speakersAfter = speakerCommand.attempt.after;
    const speakerReadback = readRequests.length;
    await resolveWrite(speakerSaveCount, { ok: true, profile: speakersAfter }, speakersAfter);
    await until(() => readRequests.length === speakerReadback + 1, 'organization speaker readback');
    await resolveRead(speakerReadback, successRead(speakersAfter));
    await until(() => writableEditor.snapshot().phase === 'saved', 'organization speaker confirmation');

    await act(async () => writableEditor.edit({ biography: 'Uncertain original command' }));
    const uncertainWrite = saveRequests.length;
    await click(button(m.settings_profile_save()));
    await until(() => saveRequests.length === uncertainWrite + 1, 'the original uncertain command');
    const originalAttempt = saveRequests[uncertainWrite]!.attempt;
    await resolveWrite(uncertainWrite, { ok: false, status: 503, message: '', failure: { status: 503 } });
    expect(writableEditor.snapshot().attempt).toBe(originalAttempt);
    expect(writableEditor.snapshot().phase).toBe('uncertain');
    const refusalRead = readRequests.length;
    const refusalReload = writableEditor.reload();
    await until(() => readRequests.length === refusalRead + 1, 'a current read refusal');
    await resolveRead(refusalRead, failedRead(403));
    await refusalReload;
    expect(writableEditor.snapshot().readAuthority).toBe('denied');
    expect(writableEditor.snapshot().attempt).toBe(originalAttempt);
    const retryWrite = saveRequests.length;
    await click(button(m.settings_profile_retry_save()));
    await until(() => saveRequests.length === retryWrite + 1, 'the exact original retry');
    expect(saveRequests[retryWrite]!.attempt).toBe(originalAttempt);
    expect(saveRequests[retryWrite]!.attempt.idempotencyKey).toBe(originalAttempt.idempotencyKey);
    expect(saveRequests[retryWrite]!.headers.get('X-CSRF-Token')).toBe('csrf-secret-one');
    const retryAfter = originalAttempt.after;
    const readsBeforeDeniedRetry = readRequests.length;
    await resolveWrite(retryWrite, { ok: true, profile: retryAfter }, retryAfter);
    expect(readRequests).toHaveLength(readsBeforeDeniedRetry);
    expect(writableEditor.snapshot().attempt).toBe(originalAttempt);
    const recoveryRead = readRequests.length;
    const recovery = writableEditor.reload();
    await until(() => readRequests.length === recoveryRead + 1, 'current readback after refusal');
    await resolveRead(recoveryRead, successRead(nativeProfile));
    await recovery;
    expect(writableEditor.snapshot().attempt).toBeNull();
    expect(writableEditor.snapshot().phase).toBe('saved');

    // The production avatar component owns and cancels its own upload promise on credential replacement.
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.disabled).toBe(false);
    const gif = new window.File(['gif bytes'], 'selected-avatar.gif', { type: 'image/gif' });
    if (!fileInput) throw new Error('The connected profile avatar chooser was not rendered.');
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [gif] });
    await act(async () => fileInput!.dispatchEvent(new window.Event('change', { bubbles: true })));
    await until(
      () => host.textContent?.includes(m.settings_profile_crop_use_original()) === true,
      'the original avatar option',
    );
    await click(button(m.settings_profile_crop_use_original()));
    await until(() => uploadRequests.length === 1, 'the pending avatar upload');
    const oldUpload = uploadRequests[0]!;
    expect(oldUpload.accountId).toBe(accountA);
    const tokenOneEditor = writableEditor;
    const tokenOneSnapshot = tokenOneEditor.snapshot();
    const beforeCredentialChange = readRequests.length;
    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountA, 'csrf-secret-two')));
    await until(() => readRequests.length === beforeCredentialChange + 1, 'a fresh credential observation');
    expect(tokenOneEditor.snapshot().known).toBeNull();
    expect(tokenOneEditor.snapshot().draft).toBeNull();
    expect(oldUpload.signal.aborted).toBe(true);
    const tokenTwoEditor = editor();
    expect(tokenTwoEditor).not.toBe(tokenOneEditor);
    await resolveRead(beforeCredentialChange, successRead(nativeProfile));
    await until(() => tokenTwoEditor.snapshot().readAuthority === 'allowed', 'the replacement credential profile');
    await act(async () => {
      oldUpload.result.resolve({ src: 'late-avatar-from-old-owner' });
      await tick();
    });
    expect(tokenOneEditor.snapshot()).not.toBe(tokenOneSnapshot);
    expect(tokenOneEditor.snapshot().known).toBeNull();
    expect(tokenTwoEditor.snapshot().draft?.avatar).toEqual(nativeProfile.avatar);
    expect(saveRequests).toHaveLength(retryWrite + 1);

    // A late successful save, its finally path, and its cache confirmation cannot affect a new owner.
    await act(async () => tokenTwoEditor.edit({ displayName: 'Pending old credential write' }));
    const staleWriteIndex = saveRequests.length;
    await click(button(m.settings_profile_save()));
    await until(() => saveRequests.length === staleWriteIndex + 1, 'the pending old credential write');
    const oldWrite = saveRequests[staleWriteIndex]!;
    expect(oldWrite.headers.get('X-CSRF-Token')).toBe('csrf-secret-two');
    const tokenTwoSnapshot = tokenTwoEditor.snapshot();
    const beforeNextCredential = readRequests.length;
    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountA, 'csrf-secret-four')));
    await until(() => readRequests.length === beforeNextCredential + 1, 'the next credential observation');
    const tokenThreeEditor = editor();
    expect(tokenTwoEditor.snapshot().known).toBeNull();
    await resolveRead(beforeNextCredential, successRead(nativeProfile));
    await until(() => tokenThreeEditor.snapshot().readAuthority === 'allowed', 'the current owner after replacement');
    const beforeLateWriteReads = readRequests.length;
    await resolveWrite(staleWriteIndex, { ok: true, profile: { ...nativeProfile, displayName: 'Late old success' } });
    expect(readRequests).toHaveLength(beforeLateWriteReads);
    expect(tokenTwoEditor.snapshot()).not.toBe(tokenTwoSnapshot);
    expect(tokenTwoEditor.snapshot().known).toBeNull();
    expect(tokenThreeEditor.snapshot().draft?.displayName).toBe(nativeProfile.displayName);
    const currentOwnerKey = client
      .getQueryCache()
      .findAll({ queryKey: ['settings', 'profile'] })
      .at(-1)?.queryKey;
    expect(currentOwnerKey).toBeDefined();
    expect(client.getQueryData(currentOwnerKey!)).toEqual(nativeProfile);

    // A new owner can still write and complete readback immediately after the old finally settles.
    await act(async () => tokenThreeEditor.edit({ biography: 'Fresh owner remains writable' }));
    const freshWriteIndex = saveRequests.length;
    await click(button(m.settings_profile_save()));
    await until(() => saveRequests.length === freshWriteIndex + 1, 'the new owner write');
    expect(saveRequests[freshWriteIndex]!.headers.get('X-CSRF-Token')).toBe('csrf-secret-four');
    const freshAfter = saveRequests[freshWriteIndex]!.attempt.after;
    const freshReadback = readRequests.length;
    await resolveWrite(freshWriteIndex, { ok: true, profile: freshAfter }, freshAfter);
    await until(() => readRequests.length === freshReadback + 1, 'the fresh owner readback');
    await resolveRead(freshReadback, successRead(freshAfter));
    await until(() => tokenThreeEditor.snapshot().phase === 'saved', 'fresh owner confirmation');

    // A late failure and its finally path from another retired owner cannot mark or block the fresh owner.
    await act(async () => tokenThreeEditor.edit({ biography: 'Pending old credential failure' }));
    const staleFailureIndex = saveRequests.length;
    await click(button(m.settings_profile_save()));
    await until(() => saveRequests.length === staleFailureIndex + 1, 'the pending old credential failure');
    const beforeFailureCredential = readRequests.length;
    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountA, 'csrf-secret-four')));
    await until(() => readRequests.length === beforeFailureCredential + 1, 'a fresh owner after the pending write');
    const tokenFourEditor = editor();
    expect(tokenThreeEditor.snapshot().known).toBeNull();
    expect(host.textContent).not.toContain('Pending old credential failure');
    await resolveWrite(staleFailureIndex, {
      ok: false,
      status: 503,
      message: 'late failure from a retired owner',
      failure: { status: 503, retryAfter: '120' },
    });
    expect(tokenThreeEditor.snapshot().known).toBeNull();
    expect(tokenThreeEditor.snapshot().failure).toBeUndefined();
    expect(tokenThreeEditor.snapshot().commandRetryAt).toBe(0);
    expect(tokenFourEditor.snapshot().failure).toBeUndefined();
    await resolveRead(beforeFailureCredential, successRead(nativeProfile));
    await until(() => tokenFourEditor.snapshot().readAuthority === 'allowed', 'the fresh owner after late failure');

    // A-to-B-to-A cannot revive the original A owner, and both delayed reads stay local to their retired editors.
    const pendingReloadIndex = readRequests.length;
    const pendingReload = tokenFourEditor.reload();
    await until(() => readRequests.length === pendingReloadIndex + 1, 'the pending A reload');
    const aEditor = tokenFourEditor;
    const aSnapshot = aEditor.snapshot();
    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountB, 'csrf-b')));
    await until(() => readRequests.length === pendingReloadIndex + 2, 'the B observation');
    const bEditor = editor();
    expect(aEditor.snapshot().known).toBeNull();
    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountA, 'csrf-secret-four')));
    await until(() => readRequests.length === pendingReloadIndex + 3, 'the returned A observation');
    const returnedAEditor = editor();
    expect(returnedAEditor).not.toBe(aEditor);
    expect(returnedAEditor).not.toBe(bEditor);
    await resolveRead(pendingReloadIndex + 1, successRead(profile(accountB)));
    await resolveRead(pendingReloadIndex, successRead({ ...nativeProfile, biography: 'Late A reload' }));
    await pendingReload;
    await resolveRead(pendingReloadIndex + 2, successRead(nativeProfile));
    await until(() => returnedAEditor.snapshot().readAuthority === 'allowed', 'the final current A profile');
    expect(aEditor.snapshot()).not.toBe(aSnapshot);
    expect(aEditor.snapshot().known).toBeNull();
    expect(bEditor.snapshot().known).toBeNull();
    expect(returnedAEditor.snapshot().draft).toEqual(nativeProfile);

    // A failed successful-session observation retires the owner; restoring success creates a fresh observation.
    const beforeSessionError = returnedAEditor;
    const errorReloadIndex = readRequests.length;
    const sessionErrorReload = beforeSessionError.reload();
    await until(() => readRequests.length === errorReloadIndex + 1, 'the read pending during session failure');
    await act(async () => {
      const queryRecord = client!.getQueryCache().find({ queryKey: sessionQuery.queryKey });
      if (!queryRecord) throw new Error('The successful session query was not installed.');
      queryRecord.setState({
        ...queryRecord.state,
        status: 'error',
        error: new Error('Session read failed'),
        fetchStatus: 'idle',
      });
    });
    await flush();
    expect(beforeSessionError.snapshot().known).toBeNull();
    expect(beforeSessionError.snapshot().draft).toBeNull();
    const errorStateEditor = editor();
    await act(async () => client!.setQueryData(sessionQuery.queryKey, { state: 'unknown', csrfToken: null }));
    await flush();
    const unknownEditor = editor();
    expect(unknownEditor).not.toBe(errorStateEditor);
    await act(async () => client!.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null }));
    await flush();
    const signedOutEditor = editor();
    expect(signedOutEditor).not.toBe(unknownEditor);
    expect(currentReadable).toBe(false);
    expect(currentWritable).toBe(false);
    await signedOutEditor.reload();
    expect(readRequests).toHaveLength(errorReloadIndex + 1);
    await act(async () => client!.setQueryData(sessionQuery.queryKey, session(accountA, 'csrf-secret-four')));
    await until(() => readRequests.length === errorReloadIndex + 2, 'a fresh observation after session error');
    const afterErrorEditor = editor();
    expect(afterErrorEditor).not.toBe(beforeSessionError);
    await resolveRead(errorReloadIndex, successRead({ ...nativeProfile, biography: 'Late read after session error' }));
    await sessionErrorReload;
    expect(beforeSessionError.snapshot().known).toBeNull();
    expect(afterErrorEditor.snapshot().known).toBeNull();
    await resolveRead(errorReloadIndex + 1, successRead(nativeProfile));
    await until(() => afterErrorEditor.snapshot().readAuthority === 'allowed', 'the restored reader');

    // Removing this editor's own query also retires it and deletes only its private projection.
    const removedEditor = afterErrorEditor;
    const afterRemovalRead = readRequests.length;
    const removalReload = removedEditor.reload();
    await until(() => readRequests.length === afterRemovalRead + 1, 'the read pending during profile query removal');
    const activeProfileQuery = client
      .getQueryCache()
      .findAll({ queryKey: ['settings', 'profile'] })
      .find((candidate) => candidate.state.data !== undefined);
    const removeTarget = activeProfileQuery;
    if (!removeTarget) throw new Error('The active private profile query was not found.');
    await act(async () => client!.getQueryCache().remove(removeTarget));
    await flush();
    expect(removedEditor.snapshot().known).toBeNull();
    expect(removedEditor.snapshot().draft).toBeNull();

    // Restore through a fresh owner, then unmount with a pending reload and settle it late.
    await until(() => readRequests.length >= afterRemovalRead + 2, 'the post-removal owner');
    const postRemovalEditor = editor();
    await resolveRead(afterRemovalRead, successRead({ ...nativeProfile, biography: 'Late read after query removal' }));
    await removalReload;
    expect(removedEditor.snapshot().known).toBeNull();
    expect(postRemovalEditor.snapshot().known).toBeNull();
    await resolveRead(afterRemovalRead + 1, successRead(nativeProfile));
    await until(() => postRemovalEditor.snapshot().readAuthority === 'allowed', 'the post-removal current read');
    const finalReadIndex = readRequests.length;
    const finalReload = postRemovalEditor.reload();
    await until(() => readRequests.length === finalReadIndex + 1, 'the final pending reload');
    await act(async () => root!.unmount());
    root = undefined;
    await flush();
    expect(postRemovalEditor.snapshot().known).toBeNull();
    expect(postRemovalEditor.snapshot().draft).toBeNull();
    await resolveRead(finalReadIndex, successRead({ ...nativeProfile, biography: 'Late unmounted read' }));
    await finalReload;
    expect(postRemovalEditor.snapshot().known).toBeNull();

    root = createRoot(host as unknown as HTMLElement);
    const remountReadIndex = readRequests.length;
    await render();
    await until(() => readRequests.length === remountReadIndex + 1, 'the fresh remount observation');
    const remountedEditor = editor();
    expect(remountedEditor).not.toBe(postRemovalEditor);
    await resolveRead(remountReadIndex, successRead(nativeProfile));
    await until(() => remountedEditor.snapshot().readAuthority === 'allowed', 'usable remounted profile data');
    await act(async () => root!.unmount());
    root = undefined;
    await flush();
    expect(remountedEditor.snapshot().known).toBeNull();

    // Injected Accounts editors still use their own IO and defaults; explicit writable=false stays hidden.
    const standaloneWrites: ProfileAttempt[] = [];
    const standalone = new AccountProfileEditor(
      {
        read: async () => ({ ...nativeProfile, displayName: 'Standalone Accounts edit' }),
        save: async (attempt) => {
          standaloneWrites.push(attempt);
          return { ok: true, profile: attempt.after };
        },
      },
      nativeProfile,
    );
    const injectedMarkup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(ProfileCard, { editor: standalone }),
        createElement(PublicViewsCard, { editor: standalone }),
      ),
    );
    expect(injectedMarkup).toContain(`value="${nativeProfile.displayName}"`);
    const injectedDocument = new window.DOMParser().parseFromString(injectedMarkup, 'text/html');
    expect(injectedDocument.querySelector('input[id$="-displayName"]')?.disabled).toBe(false);
    expect(
      [...injectedDocument.querySelectorAll('[role="switch"]')].every(
        (item) => item.getAttribute('aria-disabled') !== 'true',
      ),
    ).toBe(true);
    const hiddenMarkup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(ProfileCard, { editor: standalone, writable: false }),
        createElement(PublicViewsCard, { editor: standalone, writable: false }),
      ),
    );
    expect(hiddenMarkup).not.toContain('Current organization biography');
    expect(hiddenMarkup).not.toContain('role="switch"');
    const readableMarkup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(ProfileCard, { editor: standalone, writable: false, readable: true }),
        createElement(PublicViewsCard, { editor: standalone, writable: false, readable: true }),
      ),
    );
    expect(readableMarkup).toContain(nativeProfile.biography);
    const readableDocument = new window.DOMParser().parseFromString(readableMarkup, 'text/html');
    expect(readableDocument.querySelector('input')?.disabled).toBe(true);
    expect(readableDocument.querySelector('[role="switch"]')?.getAttribute('aria-disabled')).toBe('true');
    standalone.edit({ displayName: 'Standalone Accounts edit' });
    await standalone.submit('profile');
    expect(standalone.confirmationSnapshot()).toBe('profile');
    await standalone.confirm();
    expect(standaloneWrites).toHaveLength(1);
    expect(standalone.snapshot().phase).toBe('saved');
    standalone.retire();
    expect(createdUrls).toEqual(revokedUrls);
  } finally {
    if (root) await act(async () => root!.unmount());
    client?.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
