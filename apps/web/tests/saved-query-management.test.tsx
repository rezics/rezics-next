import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { act, createContext, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CollectionWriteResult } from '../src/library/collection-edit';
import type { ManagedSavedQuery } from '../src/library/saved-query-management/controller';
import type { DynamicCollectionPage } from '../src/library/dynamic-collection';
import { m } from '../src/paraglide/messages.js';
import { savedQueryReturnTo } from '../src/library/saved-query-management/return-to';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { captureCollectionCommand, captureCollectionDelete, captureCollectionUpdate } = await import(
  '../src/library/collection-commands'
);
const { SavedQueryManagementController } = await import('../src/library/saved-query-management/controller');

let admissionOperations: string[] = [];
let csrfOperations: string[] = [];
let csrfReply: (operation: string) => string | null = () => null;

mock.module('../src/session/query', () => ({
  useSession: () => ({ state: 'signed-in', subject: 'alice', csrfToken: 'csrf-original' }),
}));
mock.module('../src/library/collection-current-admission', () => ({
  useCollectionCurrentAdmission: () => ({
    owner: 1,
    observed: () => true,
    current: (operation: string) => {
      admissionOperations.push(operation);
      return true;
    },
    csrf: (operation: string) => {
      csrfOperations.push(operation);
      return csrfReply(operation);
    },
  }),
}));
mock.module('../src/library/saved-query-publication', () => ({ SavedQueryPublicationAction: () => null }));
type DialogRoot = { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode };
type DialogButton = { children: ReactNode; disabled?: boolean; onClick?: () => void };
const dialogOpenChange = createContext<(open: boolean) => void>(() => {});
const dialogPart = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/alert-dialog', () => ({
  AlertDialog: ({ open, onOpenChange, children }: DialogRoot) =>
    open ? <dialogOpenChange.Provider value={onOpenChange}>{children}</dialogOpenChange.Provider> : null,
  AlertDialogAction: ({ children, onClick, disabled }: DialogButton) => (
    <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
  ),
  AlertDialogCancel: ({ children, disabled }: DialogButton) => {
    const onOpenChange = useContext(dialogOpenChange);
    return <button type="button" disabled={disabled} onClick={() => onOpenChange(false)}>{children}</button>;
  },
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div data-slot="alert-dialog-content">{children}</div>,
  AlertDialogDescription: dialogPart,
  AlertDialogFooter: dialogPart,
  AlertDialogHeader: dialogPart,
  AlertDialogTitle: dialogPart,
}));

const { SavedQueryManagement } = await import('../src/library/saved-query-management');

function ownerPage(changes: Partial<ManagedSavedQuery> = {}): ManagedSavedQuery {
  return {
    id: 'saved-query-1',
    title: 'Current title',
    description: 'Current description',
    revision: 7,
    curatorAccountId: 'alice',
    visibility: 'private',
    viewerActions: {
      state: 'ready',
      actions: [
        { action: 'collection:update', operations: ['collection.update'] },
        { action: 'collection:delete', operations: ['collection.delete'] },
      ],
    },
    ...changes,
  };
}

function dynamicPage(changes: Partial<ManagedSavedQuery> = {}): DynamicCollectionPage {
  return {
    ...ownerPage(changes),
    curator: null,
    members: [],
    next: null,
    preparing: false,
    retryAfterMs: 0,
    unavailable: false,
  };
}

async function installBrowser() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://site.test/en/collections/saved-query-1' });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    Node: browser.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    browser,
    restore() {
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickButton(document: Document, label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
  await settle();
}

function dialogContent(document: Document): HTMLElement {
  const content = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!content) throw new Error('Expected an open management dialog');
  return content;
}

function makeController({
  current = ownerPage(),
  update,
  remove,
  onMetadata = () => {},
  onDeleted = () => {},
}: {
  current?: ManagedSavedQuery;
  update?: typeof captureCollectionUpdate;
  remove?: typeof captureCollectionDelete;
  onMetadata?: (page: ManagedSavedQuery) => void;
  onDeleted?: () => void;
} = {}) {
  return new SavedQueryManagementController({
    collectionId: 'saved-query-1',
    viewerId: 'alice',
    readCurrent: async () => current,
    isCurrent: () => true,
    csrf: () => 'csrf-original',
    onMetadata,
    onDeleted,
    ...(update ? { update } : {}),
    ...(remove ? { remove } : {}),
  });
}

test('metadata recovery admits once, retries the exact command, and retires detached callbacks', async () => {
  const requests: unknown[] = [];
  let attempt = 0;
  let observed: ManagedSavedQuery | undefined;
  const controller = makeController({
    onMetadata: (page) => {
      observed = page;
    },
    update: (data, csrf) =>
      captureCollectionCommand(data, csrf, async (request) => {
        requests.push(request);
        attempt += 1;
        return attempt === 1
          ? ({ ok: false, reason: 'unavailable' } satisfies CollectionWriteResult)
          : ({ ok: true, id: 'saved-query-1', revision: 8 } satisfies CollectionWriteResult);
      }),
  });
  await controller.open();
  const detachedSetTitle = controller.setTitle;
  controller.setTitle('New title');
  controller.setDescription('New description');
  const firstSave = controller.save();
  const duplicateSave = controller.save();
  expect(controller.getSnapshot().busy).toBe(true);
  await Promise.all([firstSave, duplicateSave]);

  const first = controller.getSnapshot().intent;
  expect(first?.operation).toBe('collection.update');
  expect(controller.getSnapshot().outcome).toBe('unknown');
  expect(requests).toHaveLength(1);
  if (first?.operation !== 'collection.update') throw new Error('Expected a retained metadata command');
  expect(first.command.request.data).toEqual({
    collectionId: 'saved-query-1',
    revision: 7,
    title: 'New title',
    description: 'New description',
    visibility: 'private',
    idempotencyKey: expect.any(String),
  });
  expect(first.command.request.data).not.toHaveProperty('rule');
  expect(first.command.request.headers).toEqual({ 'X-CSRF-Token': 'csrf-original' });

  await controller.retryOriginal();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(first.command.request);
  expect(controller.getSnapshot().snapshot?.revision).toBe(8);
  expect(controller.getSnapshot().snapshot?.title).toBe('New title');
  expect(observed?.description).toBe('New description');
  controller.retire();
  const nextVisit = makeController();
  await nextVisit.open();
  detachedSetTitle('Must stay with retired visit');
  expect(controller.getSnapshot().phase).toBe('closed');
  expect(nextVisit.getSnapshot().title).toBe('Current title');
});

test('delete requires review and retries the same revisioned request before returning success', async () => {
  const requests: unknown[] = [];
  let attempt = 0;
  let deleted = 0;
  const controller = makeController({
    onDeleted: () => {
      deleted += 1;
    },
    remove: (data, csrf) =>
      captureCollectionCommand(data, csrf, async (request) => {
        requests.push(request);
        attempt += 1;
        return attempt === 1
          ? ({ ok: false, reason: 'unavailable' } satisfies CollectionWriteResult)
          : ({ ok: true, id: 'saved-query-1' } satisfies CollectionWriteResult);
      }),
  });
  await controller.open();
  controller.requestDelete();
  expect(controller.getSnapshot().dialog).toBe('delete');
  expect(requests).toHaveLength(0);

  await controller.confirmDelete();
  const intent = controller.getSnapshot().intent;
  expect(intent?.operation).toBe('collection.delete');
  expect(controller.getSnapshot().outcome).toBe('unknown');
  expect(deleted).toBe(0);
  if (intent?.operation !== 'collection.delete') throw new Error('Expected a retained delete command');
  expect(intent.command.request.data).toEqual({
    collectionId: 'saved-query-1',
    revision: 7,
    idempotencyKey: expect.any(String),
  });

  await controller.retryOriginal();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(intent.command.request);
  expect(deleted).toBe(1);
});

test('a built-in or another owner cannot enter saved-query management', async () => {
  for (const current of [ownerPage({ builtinKind: 'everything' }), ownerPage({ curatorAccountId: 'bob' })]) {
    const controller = makeController({ current });
    await controller.open();
    expect(controller.getSnapshot().phase).toBe('denied');
    expect(controller.can('collection.update')).toBe(false);
    expect(controller.can('collection.delete')).toBe(false);
  }
});

test('delete return addresses stay on the same bounded locale page', () => {
  const search = new URLSearchParams({ cursor: 'next+/page==', layout: 'previews' });
  const directory = `/en/library/collections?${search}`;
  expect(savedQueryReturnTo(directory, 'en')).toBe(directory);
  expect(savedQueryReturnTo('https://outside.test/en/library/collections', 'en')).toBe('/en/library/collections');
  expect(savedQueryReturnTo('/fr/library/collections?layout=rows', 'en')).toBe('/en/library/collections');
  expect(savedQueryReturnTo('/en/library/collections?layout=rows&extra=1', 'en')).toBe('/en/library/collections');
});

test('mounted manager callbacks keep their originating controller state and ports', async () => {
  admissionOperations = [];
  csrfOperations = [];
  csrfReply = () => null;
  const harness = await installBrowser();
  const host = harness.browser.document.createElement('div');
  harness.browser.document.body.append(host);
  const root: Root = createRoot(host);
  const pages = [dynamicPage(), dynamicPage(), dynamicPage({ title: 'Reconciled server title' })];
  const metadata: ManagedSavedQuery[] = [];
  let reads = 0;
  const readCurrent = async () => pages[reads++] ?? pages[pages.length - 1]!;

  try {
    await act(async () =>
      root.render(
        <SavedQueryManagement
          page={dynamicPage()}
          viewerId="alice"
          readCurrent={readCurrent}
          onMetadata={(page) => metadata.push(page)}
        />,
      ),
    );
    const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
    const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
    const user = userEvent.setup({ document: harness.browser.document });
    await clickButton(harness.browser.document, m.library_saved_query_manage(), host);
    expect(reads).toBe(1);
    expect(metadata[0]).toMatchObject({ id: 'saved-query-1', revision: 7, title: 'Current title' });

    const title = host.querySelector<HTMLInputElement>('input');
    const description = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!title || !description) throw new Error('Expected the mounted metadata editor');
    await act(async () => {
      await user.clear(title);
      await user.type(title, 'Draft title');
      await user.clear(description);
      await user.type(description, 'Draft description');
    });
    await settle();
    expect(title.value).toBe('Draft title');
    expect(description.value).toBe('Draft description');
    expect(metadata).toHaveLength(1);

    await clickButton(harness.browser.document, m.library_collection_cancel(), host);
    expect(dialogContent(harness.browser.document).textContent).toContain(
      m.library_saved_query_management_leave_title(),
    );
    await clickButton(
      harness.browser.document,
      m.library_saved_query_management_leave_confirm(),
      dialogContent(harness.browser.document),
    );
    expect(host.querySelector('#collection-edit-form')).toBeNull();

    await clickButton(harness.browser.document, m.library_saved_query_manage(), host);
    expect(reads).toBe(2);
    const reopenedTitle = host.querySelector<HTMLInputElement>('input');
    if (!reopenedTitle) throw new Error('Expected the reopened metadata editor');
    await act(async () => {
      await user.clear(reopenedTitle);
      await user.type(reopenedTitle, 'Unsaved title');
    });
    await settle();
    await clickButton(harness.browser.document, m.library_collection_save(), host);
    expect(host.textContent).toContain(m.library_saved_query_management_refused());

    await clickButton(harness.browser.document, m.library_saved_query_management_read_current(), host);
    expect(dialogContent(harness.browser.document).textContent).toContain(
      m.library_saved_query_management_reconcile_title(),
    );
    await clickButton(
      harness.browser.document,
      m.library_saved_query_management_reconcile_confirm(),
      dialogContent(harness.browser.document),
    );
    expect(reads).toBe(3);
    expect(metadata.at(-1)?.title).toBe('Reconciled server title');

    await clickButton(harness.browser.document, m.library_collection_delete(), host);
    expect(dialogContent(harness.browser.document).textContent).toContain('saved-query-1');
    await clickButton(
      harness.browser.document,
      m.library_collection_cancel(),
      dialogContent(harness.browser.document),
    );
    expect(host.textContent).toContain(m.library_saved_query_management_heading());

    await clickButton(harness.browser.document, m.library_collection_delete(), host);
    await clickButton(
      harness.browser.document,
      m.library_collection_delete_confirm(),
      dialogContent(harness.browser.document),
    );
    expect(csrfOperations).toContain('collection.update');
    expect(csrfOperations).toContain('collection.delete');
    expect(admissionOperations).toContain('collection.get');
    expect(admissionOperations).toContain('collection.update');
    expect(admissionOperations).toContain('collection.delete');
    expect(host.textContent).toContain(m.library_saved_query_management_refused());
  } finally {
    await act(async () => root.unmount());
    host.remove();
    harness.restore();
    await harness.browser.happyDOM.close();
  }
});

