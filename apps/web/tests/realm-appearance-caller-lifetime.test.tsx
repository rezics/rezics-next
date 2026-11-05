import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import * as start from '../.storybook/react-start';
import type {
  RealmAppearanceAdapter,
  RealmAppearanceCommand,
  RealmAppearanceRead,
  RealmAppearanceResult,
  RealmAppearanceSelection,
  RealmAppearanceSnapshot,
  RealmAppearanceChoice,
} from '../src/community/realm-presentation';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/quiet-novel-club-appearance' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  HTMLInputElement: window.HTMLInputElement,
  File: window.File,
  Event: window.Event,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const appearanceRealmId = '01a1a100-0000-7000-8000-000000000002';
const replacementRealmId = id(51);
const reader = id(20);
const nextHead = id(31);
const otherPost = id(41);
const imageId = id(42);
const revisionId = id(43);
const viewer = (subject = reader, csrfToken: string | null = 'csrf-one') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});

type Calls = {
  reads: string[];
  changes: { command: RealmAppearanceCommand; csrfToken: string | null }[];
  selections: RealmAppearanceChoice[];
  uploads: { realmId: string; purpose: string; signal: AbortSignal }[];
  resumes: { mediaId: string; signal: AbortSignal }[];
};
const calls: Calls = { reads: [], changes: [], selections: [], uploads: [], resumes: [] };
let operations: {
  read: (realmId: string) => Promise<RealmAppearanceRead>;
  change: (command: RealmAppearanceCommand, csrfToken: string | null) => Promise<RealmAppearanceResult>;
  select: (choice: RealmAppearanceChoice) => Promise<RealmAppearanceSelection>;
  upload: (realmId: string, purpose: string, signal: AbortSignal) => Promise<{ id: string }>;
  resume: (mediaId: string, signal: AbortSignal) => Promise<{ id: string }>;
};

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/space-actions', () => ({
  readRealmAppearanceSettings: async ({ data }: { data: { realmId: string } }) => {
    calls.reads.push(data.realmId);
    return operations.read(data.realmId);
  },
  changeRealmAppearanceSettings: async ({ data, headers }: { data: RealmAppearanceCommand; headers: HeadersInit }) => {
    const csrfToken = new Headers(headers).get('X-CSRF-Token');
    calls.changes.push({ command: structuredClone(data), csrfToken });
    return operations.change(data, csrfToken);
  },
  resolveRealmAppearanceChoice: async ({ data }: { data: RealmAppearanceChoice }) => {
    calls.selections.push(structuredClone(data));
    return operations.select(data);
  },
}));
mock.module('../src/threads/upload', () => ({
  uploadRealmImage: async (realmId: string, purpose: string, _file: File, signal: AbortSignal) => {
    calls.uploads.push({ realmId, purpose, signal });
    return operations.upload(realmId, purpose, signal);
  },
  resumeRealmImageUpload: async (mediaId: string, _file: File, _realmId: string, signal: AbortSignal) => {
    calls.resumes.push({ mediaId, signal });
    return operations.resume(mediaId, signal);
  },
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { RealmAppearancePanel } = await import('../src/community/realm-presentation-panel');
const { RealmAppearanceSettings } = await import('../src/community/realm-presentation-settings');
const { createRealmAppearance } = await import('../src/community/realm-presentation');
const { createRealmAppearanceCallerLifetime } = await import('../src/community/realm-appearance-caller-lifetime');
const { configured, image } = await import('../src/kernel/fake/community');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { within, userEvent } = await import('storybook/test');

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
const user = userEvent.setup({ document: window.document as unknown as Document });
let root: Root | undefined;
let client: QueryClient | undefined;
let panelRealmId = appearanceRealmId;
let renderMarker = 0;
let settingsInitial: RealmAppearanceRead = { kind: 'ready', snapshot: configured };
let settingsAdapter: RealmAppearanceAdapter;

const snapshotFor = (realmId = appearanceRealmId, head = configured.head): RealmAppearanceSnapshot => ({
  ...configured,
  realmId,
  head,
  contextId: realmId === appearanceRealmId ? configured.contextId : id(52),
  title: realmId === appearanceRealmId ? configured.title : 'Replacement realm',
});
const ready = (snapshot = snapshotFor()): RealmAppearanceRead => ({ kind: 'ready', snapshot });
const explicitRules = (postId: string, revision = revisionId, title = `Rules ${postId}`): RealmAppearanceSelection => ({
  kind: 'rules',
  rules: { postId, revisionId: revision, title, summary: 'Explicit fixture summary.' },
});
const explicitImageReference = (
  choice: Extract<RealmAppearanceChoice, { kind: 'image' }>,
): RealmAppearanceSelection => ({
  kind: 'image-reference',
  mediaId: choice.mediaId,
  realmId: choice.realmId,
  purpose: choice.purpose,
});
const callerLifetime = (adapter: RealmAppearanceAdapter, valid: () => boolean = () => true) =>
  createRealmAppearanceCallerLifetime({
    realmId: configured.realmId,
    source: null,
    client: null,
    revision: 0,
    dataUpdateCount: 0,
    dataUpdatedAt: 0,
    subject: reader,
    csrfToken: 'csrf-one',
    locale: 'en',
    ready: true,
    adapter,
    valid,
  });

function defaultOperations() {
  operations = {
    read: async (realmId) => ready(snapshotFor(realmId)),
    change: async () => ({ kind: 'unavailable' }),
    select: async (choice) =>
      choice.kind === 'rules' ? explicitRules(choice.postId, choice.revisionId) : explicitImageReference(choice),
    upload: async () => ({ id: imageId }),
    resume: async (mediaId) => ({ id: mediaId }),
  };
}

function resetCalls() {
  calls.reads.length = 0;
  calls.changes.length = 0;
  calls.selections.length = 0;
  calls.uploads.length = 0;
  calls.resumes.length = 0;
}

function PanelHarness() {
  return (
    <div data-render-marker={renderMarker}>
      <RealmAppearancePanel realmId={panelRealmId} />
    </div>
  );
}

function SettingsHarness() {
  return <RealmAppearanceSettings realmId={configured.realmId} initial={settingsInitial} adapter={settingsAdapter} />;
}

function tree(node: ReactNode) {
  return <StrictMode>{client ? <QueryClientProvider client={client}>{node}</QueryClientProvider> : node}</StrictMode>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function paint(node: ReactNode) {
  await act(async () => {
    root!.render(tree(node));
    await tick();
  });
}

async function mountPanel(session = viewer()) {
  await close();
  resetCalls();
  defaultOperations();
  panelRealmId = appearanceRealmId;
  renderMarker = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, session);
  root = createRoot(host);
  await paint(<PanelHarness />);
  await within(host).findByRole('region', { name: m.realm_appearance_heading() });
}

async function mountSettings(adapter: RealmAppearanceAdapter, initial: RealmAppearanceRead = ready()) {
  await close();
  resetCalls();
  settingsInitial = initial;
  settingsAdapter = adapter;
  client = undefined;
  root = createRoot(host);
  await paint(<SettingsHarness />);
  await within(host).findByRole('region', { name: m.realm_appearance_heading() });
}

async function close() {
  if (root) {
    await act(async () => {
      root!.unmount();
      await tick();
    });
    root = undefined;
  }
  host.textContent = '';
}

async function updateSession(session: ReturnType<typeof viewer>) {
  await act(async () => {
    client!.setQueryData(sessionQuery.queryKey, session);
    await tick();
  });
}

async function rerenderPanel() {
  renderMarker++;
  await paint(<PanelHarness />);
}

function baseAdapter(): RealmAppearanceAdapter {
  return {
    read: async () => ready(),
    change: async () => ({ kind: 'unavailable' }),
    select: async (choice) =>
      choice.kind === 'rules' ? explicitRules(choice.postId, choice.revisionId) : explicitImageReference(choice),
    upload: async () => ({ id: imageId }),
    resume: async (mediaId) => ({ id: mediaId }),
  };
}

afterEach(async () => {
  await close();
  client?.clear();
  client = undefined;
  resetCalls();
  defaultOperations();
  panelRealmId = appearanceRealmId;
  renderMarker = 0;
  settingsInitial = ready();
  await setLocale('en', { reload: false });
});

afterAll(async () => {
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('Complete Realm appearance caller and selection lifetime', () => {
  test('the default Panel binds its original CSRF caller, isolates same-account cache revisions and ignores late saves', async () => {
    await mountPanel();
    expect(calls.reads).toContain(appearanceRealmId);

    const oldWrite = deferred<RealmAppearanceResult>();
    operations.change = async () => oldWrite.promise;
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_save() }));
    expect(calls.changes).toHaveLength(1);
    expect(calls.changes[0]?.csrfToken).toBe('csrf-one');
    const oldCommand = structuredClone(calls.changes[0]!.command);

    await updateSession(viewer(reader, 'csrf-two'));
    await within(host).findByRole('region', { name: m.realm_appearance_heading() });
    expect(calls.reads.filter((value) => value === appearanceRealmId).length).toBeGreaterThanOrEqual(2);
    oldWrite.resolve({
      kind: 'confirmed',
      snapshot: { ...snapshotFor(), head: nextHead, presentation: oldCommand.presentation },
    });
    await act(async () => tick());
    expect(within(host).queryByText(m.realm_appearance_saved())).toBeNull();

    operations.change = async () => ({ kind: 'unavailable' });
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_save() }));
    expect(calls.changes).toHaveLength(2);
    expect(calls.changes[1]?.csrfToken).toBe('csrf-two');
    expect(calls.changes[1]?.command.key).not.toBe(oldCommand.key);
  });

  test('healthy rerenders preserve an open draft while locale, Realm and QueryClient replacement retire the old visit', async () => {
    await mountPanel();
    const view = within(host);
    await user.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    const postInput = view.getByRole('textbox', { name: m.realm_appearance_post_id() });
    await user.type(postInput, imageId);
    await rerenderPanel();
    expect((within(host).getByRole('textbox', { name: m.realm_appearance_post_id() }) as HTMLInputElement).value).toBe(
      imageId,
    );

    const oldWrite = deferred<RealmAppearanceResult>();
    operations.change = async () => oldWrite.promise;
    await user.click(within(host).getByRole('button', { name: m.editor_cancel() }));
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_save() }));
    const oldCommand = structuredClone(calls.changes[0]!.command);

    panelRealmId = replacementRealmId;
    await rerenderPanel();
    await within(host).findByRole('heading', { name: m.realm_appearance_heading() });
    oldWrite.resolve({
      kind: 'confirmed',
      snapshot: { ...snapshotFor(), head: nextHead, presentation: oldCommand.presentation },
    });
    await act(async () => tick());
    expect(within(host).queryByText(m.realm_appearance_saved())).toBeNull();
    expect(calls.reads).toContain(replacementRealmId);

    const currentWrite = deferred<RealmAppearanceResult>();
    operations.change = async () => currentWrite.promise;
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_save() }));
    const currentCommand = structuredClone(calls.changes.at(-1)!.command);
    await setLocale('fr', { reload: false });
    await rerenderPanel();
    currentWrite.resolve({
      kind: 'confirmed',
      snapshot: { ...snapshotFor(replacementRealmId), head: nextHead, presentation: currentCommand.presentation },
    });
    await act(async () => tick());
    expect(within(host).queryByText(m.realm_appearance_saved())).toBeNull();

    const replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    replacementClient.setQueryData(sessionQuery.queryKey, viewer());
    client = replacementClient;
    await rerenderPanel();
    expect(calls.reads.filter((value) => value === replacementRealmId).length).toBeGreaterThanOrEqual(2);
  });

  test('readiness loss and away/back cache updates retire the caller before stale callbacks can send', async () => {
    await mountPanel();
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_select_rules() }));
    const queuedSelection = within(host).getByRole('textbox', { name: m.realm_appearance_post_id() });
    await user.type(queuedSelection, imageId);
    await updateSession({ state: 'signed-out', subject: reader, csrfToken: null });
    expect(within(host).queryByRole('region', { name: m.realm_appearance_heading() })).toBeNull();
    expect(calls.changes).toHaveLength(0);

    await act(async () => {
      client!.setQueryData(sessionQuery.queryKey, viewer(id(21), 'csrf-away'));
      client!.setQueryData(sessionQuery.queryKey, viewer());
      await tick();
    });
    await rerenderPanel();
    await within(host).findByRole('region', { name: m.realm_appearance_heading() });
    expect(calls.changes).toHaveLength(0);
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_save() }));
    expect(calls.changes).toHaveLength(1);
    expect(calls.changes[0]?.csrfToken).toBe('csrf-one');
  });

  test('the default Panel aborts original upload and resume transports before their chained selection read', async () => {
    await mountPanel();
    const firstUpload = deferred<{ id: string }>();
    operations.upload = async () => firstUpload.promise;
    await user.upload(
      within(host).getByLabelText(`${m.realm_appearance_icon()}: ${m.realm_appearance_upload()}`),
      new File(['image'], 'icon.png', { type: 'image/png' }),
    );
    await within(host).findByText(m.realm_appearance_uploading());
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]?.signal.aborted).toBe(false);
    await updateSession(viewer(reader, 'csrf-two'));
    expect(calls.uploads[0]?.signal.aborted).toBe(true);
    firstUpload.resolve({ id: imageId });
    await act(async () => tick());
    expect(calls.selections).toHaveLength(0);

    await mountPanel();
    const reservationFailure = Object.assign(new Error('processing unavailable'), { mediaId: imageId });
    operations.upload = async () => {
      throw reservationFailure;
    };
    const resume = deferred<{ id: string }>();
    operations.resume = async () => resume.promise;
    await user.upload(
      within(host).getByLabelText(`${m.realm_appearance_icon()}: ${m.realm_appearance_upload()}`),
      new File(['image'], 'icon.png', { type: 'image/png' }),
    );
    await within(host).findByText(m.realm_appearance_upload_pending());
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_retry_upload() }));
    expect(calls.resumes).toHaveLength(1);
    await updateSession(viewer(reader, 'csrf-two'));
    expect(calls.resumes[0]?.signal.aborted).toBe(true);
    resume.resolve({ id: imageId });
    await act(async () => tick());
    expect(calls.selections).toHaveLength(0);
  });

  test('the actual Settings selection fences changed input, closed/reopened selections and a newer head', async () => {
    const requests: {
      choice: RealmAppearanceChoice;
      response: ReturnType<typeof deferred<RealmAppearanceSelection>>;
    }[] = [];
    const adapter: RealmAppearanceAdapter = {
      ...baseAdapter(),
      select: (choice) => {
        const response = deferred<RealmAppearanceSelection>();
        requests.push({ choice: structuredClone(choice), response });
        return response.promise;
      },
    };
    await mountSettings(adapter);
    const view = within(host);
    await user.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_post_id() }), imageId);
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_revision_id() }), revisionId);
    await user.click(view.getByRole('button', { name: m.realm_appearance_preview() }));

    const post = view.getByRole('textbox', { name: m.realm_appearance_post_id() });
    await user.clear(post);
    await user.type(post, otherPost);
    await user.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    expect(requests).toHaveLength(2);
    requests[0]!.response.resolve(explicitRules(imageId, revisionId, 'Obsolete input result'));
    await act(async () => tick());
    expect(view.queryByText('Obsolete input result')).toBeNull();
    requests[1]!.response.resolve(explicitRules(otherPost, revisionId, 'Current input result'));
    await view.findByText('Current input result');

    await user.click(view.getByRole('button', { name: m.editor_cancel() }));
    await user.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_post_id() }), imageId);
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_revision_id() }), revisionId);
    await user.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    await user.click(view.getByRole('button', { name: m.editor_cancel() }));
    await user.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_post_id() }), imageId);
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_revision_id() }), revisionId);
    await user.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    expect(requests).toHaveLength(4);
    requests[2]!.response.resolve({ kind: 'unavailable' });
    await act(async () => tick());
    expect(view.queryByText(m.realm_appearance_selection_unavailable())).toBeNull();
    requests[3]!.response.resolve(explicitRules(imageId, revisionId, 'Reopened selection result'));
    await view.findByText('Reopened selection result');

    await user.click(view.getByRole('button', { name: m.editor_cancel() }));
    await user.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_post_id() }), imageId);
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_revision_id() }), revisionId);
    await user.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    const oldHeadResponse = requests[4]!.response;
    settingsInitial = ready(snapshotFor(appearanceRealmId, nextHead));
    await paint(<SettingsHarness />);
    expect(within(host).queryByRole('textbox', { name: m.realm_appearance_post_id() })).toBeNull();
    oldHeadResponse.resolve(explicitRules(imageId, revisionId, 'Old head result'));
    await act(async () => tick());
    expect(within(host).queryByText('Old head result')).toBeNull();
  });

  test('the current visit retains uncertain save identity and explicit conflict review uses the current head', async () => {
    const requests: {
      command: RealmAppearanceCommand;
      response: ReturnType<typeof deferred<RealmAppearanceResult>>;
    }[] = [];
    let currentHead = configured.head;
    const adapter: RealmAppearanceAdapter = {
      ...baseAdapter(),
      read: async () => ready(snapshotFor(appearanceRealmId, currentHead)),
      change: (command) => {
        const response = deferred<RealmAppearanceResult>();
        requests.push({ command: structuredClone(command), response });
        return response.promise;
      },
    };
    await mountSettings(adapter);
    const view = within(host);
    await user.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_post_id() }), imageId);
    await user.type(view.getByRole('textbox', { name: m.realm_appearance_revision_id() }), revisionId);
    await user.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    await user.click(view.getByRole('button', { name: m.realm_appearance_use_selection() }));

    await user.click(view.getByRole('button', { name: m.realm_appearance_save() }));
    expect(requests).toHaveLength(1);
    const exact = structuredClone(requests[0]!.command);
    requests[0]!.response.resolve({ kind: 'unavailable' });
    await view.findByText(m.realm_appearance_uncertain());
    await user.click(view.getByRole('button', { name: m.realm_appearance_retry() }));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.command).toEqual(exact);
    requests[1]!.response.resolve({ kind: 'conflict' });
    await view.findByText(m.realm_appearance_conflict());

    currentHead = nextHead;
    await user.click(view.getByRole('button', { name: m.realm_appearance_refresh() }));
    await view.findByRole('button', { name: m.realm_appearance_review() });
    await user.click(view.getByRole('button', { name: m.realm_appearance_review() }));
    await user.click(view.getByRole('button', { name: m.realm_appearance_save() }));
    expect(requests).toHaveLength(3);
    expect(requests[2]?.command.head).toBe(nextHead);
    expect(requests[2]?.command.key).not.toBe(exact.key);
  });

  test('retired reads, saves, uploads and resumed media cannot publish late state or start chained selection', async () => {
    const read = deferred<RealmAppearanceRead>();
    let readCalls = 0;
    const adapter: RealmAppearanceAdapter = {
      ...baseAdapter(),
      read: async () => {
        readCalls++;
        return read.promise;
      },
    };
    const lifetime = callerLifetime(adapter);
    const control = createRealmAppearance(configured.realmId, ready(), adapter, () => id(60), lifetime);
    const pendingRead = control.refresh();
    expect(readCalls).toBe(1);
    lifetime.retire();
    read.resolve(ready(snapshotFor(appearanceRealmId, nextHead)));
    await pendingRead;
    expect(control.getSnapshot().read).toEqual({ kind: 'hidden' });

    const queued = callerLifetime(adapter);
    const retiredControl = createRealmAppearance(configured.realmId, ready(), adapter, () => id(60), queued);
    queued.retire();
    await retiredControl.refresh();
    await retiredControl.save();
    await retiredControl.upload(
      'avatar',
      new window.File(['image'], 'icon.png', { type: 'image/png' }) as unknown as File,
    );
    expect(readCalls).toBe(1);

    let queuedReads = 0;
    const queuedAdapter = {
      ...baseAdapter(),
      read: async () => {
        queuedReads++;
        return ready();
      },
    };
    const queuedLifetime = callerLifetime(queuedAdapter);
    const queuedControl = createRealmAppearance(
      configured.realmId,
      ready(),
      queuedAdapter,
      () => id(64),
      queuedLifetime,
    );
    const stopQueued = queuedControl.subscribe(() => {
      if (queuedControl.getSnapshot().busy) queuedLifetime.retire();
    });
    await queuedControl.refresh();
    stopQueued();
    expect(queuedReads).toBe(0);

    let queuedWrites = 0;
    const queuedWriteAdapter = {
      ...baseAdapter(),
      change: async () => {
        queuedWrites++;
        return { kind: 'unavailable' as const };
      },
    };
    const queuedWriteLifetime = callerLifetime(queuedWriteAdapter);
    const queuedWriteControl = createRealmAppearance(
      configured.realmId,
      ready(),
      queuedWriteAdapter,
      () => id(65),
      queuedWriteLifetime,
    );
    const stopQueuedWrite = queuedWriteControl.subscribe(() => {
      if (queuedWriteControl.getSnapshot().busy) queuedWriteLifetime.retire();
    });
    await queuedWriteControl.save();
    stopQueuedWrite();
    expect(queuedWrites).toBe(0);

    const lateSave = deferred<RealmAppearanceResult>();
    const saveAdapter = {
      ...baseAdapter(),
      change: async () => lateSave.promise,
    };
    const saveLifetime = callerLifetime(saveAdapter);
    const saveControl = createRealmAppearance(configured.realmId, ready(), saveAdapter, () => id(62), saveLifetime);
    const pendingSave = saveControl.save();
    expect(saveControl.getSnapshot().attempt).not.toBeNull();
    saveLifetime.retire();
    lateSave.resolve({ kind: 'confirmed', snapshot: { ...snapshotFor(), head: nextHead } });
    await pendingSave;
    expect(saveControl.getSnapshot().read).toEqual({ kind: 'hidden' });

    const lateUpload = deferred<{ id: string }>();
    let uploadSignal: AbortSignal | undefined;
    let selectCalls = 0;
    const uploadAdapter: RealmAppearanceAdapter = {
      ...baseAdapter(),
      upload: async (_realmId, _slot, _file, signal) => {
        uploadSignal = signal;
        return lateUpload.promise;
      },
      select: async () => {
        selectCalls++;
        return explicitRules(image.id, revisionId);
      },
    };
    const uploadLifetime = callerLifetime(uploadAdapter);
    const uploadControl = createRealmAppearance(
      configured.realmId,
      ready(),
      uploadAdapter,
      () => id(63),
      uploadLifetime,
    );
    const pendingUpload = uploadControl.upload(
      'avatar',
      new window.File(['image'], 'icon.png', { type: 'image/png' }) as unknown as File,
    );
    expect(uploadSignal?.aborted).toBe(false);
    uploadLifetime.retire();
    expect(uploadSignal?.aborted).toBe(true);
    lateUpload.resolve({ id: imageId });
    await pendingUpload;
    expect(uploadControl.getSnapshot().read).toEqual({ kind: 'hidden' });
    expect(selectCalls).toBe(0);
  });

  test('upload resume keeps a known pending media ID through effect replay and checks the current head before select', async () => {
    const failedWithReservation = Object.assign(new Error('processing unavailable'), { mediaId: imageId });
    const resumed = deferred<{ id: string }>();
    let resumeCalls = 0;
    const selected: RealmAppearanceChoice[] = [];
    const adapter: RealmAppearanceAdapter = {
      ...baseAdapter(),
      upload: async () => {
        throw failedWithReservation;
      },
      resume: async (_mediaId, _file, _realmId, signal) => {
        expect(signal.aborted).toBe(false);
        if (resumeCalls++ === 0) return resumed.promise;
        return { id: imageId };
      },
      select: async (choice) => {
        selected.push(structuredClone(choice));
        return explicitImageReference(choice as Extract<RealmAppearanceChoice, { kind: 'image' }>);
      },
    };
    const control = createRealmAppearance(configured.realmId, ready(), adapter, () => id(61));
    await control.upload('avatar', new window.File(['image'], 'icon.png', { type: 'image/png' }) as unknown as File);
    expect(control.getSnapshot().pendingUpload).toEqual({ slot: 'avatar', mediaId: imageId });

    const oldResume = control.upload('avatar');
    control.disconnect();
    const reconnect = control.connect();
    resumed.resolve({ id: imageId });
    await oldResume;
    expect(selected).toHaveLength(0);
    expect(control.getSnapshot().pendingUpload).toEqual({ slot: 'avatar', mediaId: imageId });

    await control.upload('avatar');
    expect(selected).toEqual([{ kind: 'image', realmId: configured.realmId, mediaId: imageId, purpose: 'realm-icon' }]);
    expect(control.getSnapshot().draft?.presentation.avatarMediaId).toBe(imageId);
    reconnect();
  });
});
