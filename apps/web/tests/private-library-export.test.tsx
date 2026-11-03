import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  EXPORT_COMPLETENESS,
  EXPORT_FORMAT,
  EXPORT_PAGE_ROWS,
  EXPORT_PRIVACY,
  EXPORT_VERSION,
  type ExportArtifact,
  type ExportCommand,
  type ExportManifest,
  type ExportPage,
  type ExportPort,
  type ExportRecord,
  type ExportStatus,
} from '../src/library/private-export/contract';
import { exportCallTotal, expectedExportCalls } from '../src/library/private-export/cost';
import { createExportJourney } from '../src/library/private-export/controller';
import { parseAssembledArtifact } from '../src/library/private-export/artifact';
import { libraryNavigation } from '../src/library/navigation';
import type { ExportVisit } from '../src/library/private-export/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/export' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  MouseEvent: window.MouseEvent,
  Event: window.Event,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  URL: window.URL,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { m } = await import('../src/paraglide/messages.js');
const { LibraryExportPortContext } = await import('../src/library/private-export/port');
const { PrivateLibraryExportPage } = await import('../src/library/private-export/page');

const exportId = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const first = 'cursor-first';

const visit = (viewer = 'alice', csrf = 'csrf-1'): ExportVisit => {
  const controller = new AbortController();
  let retired = false;
  return {
    subject: viewer,
    csrfToken: csrf,
    controller,
    retire() {
      retired = true;
      controller.abort();
    },
    current() {
      return !retired;
    },
  };
};

function coverage(extra: Partial<ExportStatus> = {}): ExportStatus {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportId,
    capturedAt: '2026-11-03 12:00:00+00',
    expiresAt: '2026-11-03 12:15:00+00',
    privacy: EXPORT_PRIVACY,
    completeness: EXPORT_COMPLETENESS,
    sections: ['entries', 'labels'],
    omissions: {
      trash: 'excluded',
      reimport: 'unavailable',
    },
    fullExport: false,
    state: 'collecting',
    first,
    ...extra,
  };
}

function manifest(rows: number, recordBytes: number): ExportManifest {
  const status = coverage({ state: 'ready', first: null });
  return { ...status, rows, recordBytes };
}

function recordOf(index: number): ExportRecord {
  return {
    section: 'entries',
    subject_id: `0192f3a0-6c1e-7b2a-9d4e-${index.toString(16).padStart(12, '0')}`,
    state: 'active',
    revision: '1',
    created_at: '2026-01-01 00:00:00+00',
    library_profile_pin: null,
  };
}

function pageOf(records: ExportRecord[], extra: Partial<ExportPage> = {}): ExportPage {
  return { exportId, state: 'collecting', records, next: null, manifest: null, ...extra };
}

function pagesFor(total: number, emptyAfter = 0): ExportPage[] {
  const pages: ExportPage[] = [];
  let remaining = total;
  let index = 0;
  while (remaining > 0) {
    const take = Math.min(EXPORT_PAGE_ROWS, remaining);
    const slice = Array.from({ length: take }, (_, offset) => recordOf(index + offset));
    remaining -= take;
    index += take;
    const last = remaining === 0;
    pages.push(
      pageOf(slice, {
        next: last && emptyAfter === 0 ? null : `cursor-${pages.length + 1}`,
        state: last && emptyAfter === 0 ? 'ready' : 'collecting',
        manifest: last && emptyAfter === 0 ? manifest(total, take * 80) : null,
      }),
    );
    if (pages.length === 1 && emptyAfter > 0 && remaining > 0) {
      pages.push(pageOf([], { next: `cursor-${pages.length + 1}` }));
    }
  }
  for (let extra = 0; extra < emptyAfter; extra += 1) {
    const last = extra === emptyAfter - 1;
    pages.push(
      pageOf([], {
        next: last ? null : `cursor-empty-${extra}`,
        state: last ? 'ready' : 'collecting',
        manifest: last ? manifest(total, total * 80) : null,
      }),
    );
  }
  if (total === 0) {
    return [pageOf([], { state: 'ready', next: null, manifest: manifest(0, 0) })];
  }
  return pages;
}

function recordingPort(
  pages: ExportPage[],
  options: {
    create?: ExportPort['create'];
    status?: ExportStatus;
    failCreateOnce?: boolean;
    staleOnStatus?: boolean;
  } = {},
): {
  port: ExportPort;
  creates: string[];
  pageCursors: string[];
  cancels: string[];
  statuses: string[];
} {
  const creates: string[] = [];
  const pageCursors: string[] = [];
  const cancels: string[] = [];
  const statuses: string[] = [];
  let createAttempts = 0;
  const byCursor = new Map<string, ExportPage>();
  let cursor = first;
  for (const page of pages) {
    byCursor.set(cursor, page);
    cursor = page.next ?? `done-${byCursor.size}`;
  }
  const port: ExportPort = {
    async create(command) {
      creates.push(command.key);
      createAttempts += 1;
      if (options.failCreateOnce && createAttempts === 1) return { kind: 'unknown', command };
      if (options.create) return options.create(command);
      return { kind: 'status', status: coverage() };
    },
    async status(command) {
      statuses.push(command.exportId);
      if (options.staleOnStatus) return { kind: 'status', status: coverage({ state: 'stale', first: null }) };
      return { kind: 'status', status: options.status ?? coverage({ state: 'ready', first }) };
    },
    async page(command) {
      pageCursors.push(command.cursor);
      const page = byCursor.get(command.cursor);
      if (!page) return { kind: 'unavailable' };
      return { kind: 'page', page };
    },
    async cancel(command) {
      cancels.push(command.exportId);
      return { kind: 'cancelled', status: coverage({ state: 'cancelled', first: null }) };
    },
  };
  return { port, creates, pageCursors, cancels, statuses };
}

let host: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label);
}

async function click(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function waitFor(text: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (host.textContent?.includes(text)) return;
    await settle();
  }
  expect(host.textContent).toContain(text);
}

async function mount(port: ExportPort, current: ExportVisit | null = visit()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <LibraryExportPortContext.Provider value={port}>
          <PrivateLibraryExportPage visit={current} />
        </LibraryExportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/export'] }),
  });
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await settle();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('navigation, coverage language, interpolation and 44px actions exist before capture', async () => {
  expect(libraryNavigation.some((entry) => entry.id === 'library.export')).toBe(true);
  expect(m.library_export_progress({ records: 3, pages: 2 })).toContain('3');
  expect(m.library_export_progress({ records: 3, pages: 2 })).toContain('2');
  const { port } = recordingPort(pagesFor(16, 1));
  await mount(port);
  expect(host.textContent).toContain(m.library_export_full_false());
  expect(host.textContent).toContain(m.library_export_no_reimport());
  expect(host.textContent).toContain(m.library_export_coverage());
  const capture = button(m.library_export_capture());
  expect(capture?.className).toContain('min-h-11');
  expect(capture?.className).toContain('min-w-11');
});

test('empty continuation reaches a final manifest; missing manifest yields no file', async () => {
  const ready = recordingPort(pagesFor(16, 1));
  const journey = createExportJourney({ port: ready.port, visit: visit() });
  let snap = await journey.capture();
  expect(snap.stage).toBe('ready');
  expect(snap.hasArtifact).toBe(true);
  expect(snap.manifest?.completeness).toBe(EXPORT_COMPLETENESS);
  expect(snap.manifest?.fullExport).toBe(false);
  expect(ready.pageCursors[0]).toBe(first);
  expect(snap.cost.emptyPages).toBeGreaterThan(0);
  const file = parseAssembledArtifact(
    (await (async () => {
      let bytes: Uint8Array | null = null;
      const delivered = createExportJourney({
        port: recordingPort(pagesFor(16, 1)).port,
        visit: visit(),
        deliver(artifact) {
          bytes = artifact.bytes;
          return true;
        },
      });
      await delivered.capture();
      await delivered.download();
      return bytes;
    })())!,
  );
  expect(file?.records).toHaveLength(16);
  expect(file?.manifest.omissions.reimport).toBe('unavailable');

  const partial = recordingPort([pageOf([recordOf(0)], { next: null, state: 'collecting', manifest: null })]);
  const blocked = createExportJourney({ port: partial.port, visit: visit() });
  snap = await blocked.capture();
  expect(snap.hasArtifact).toBe(false);
  expect(snap.stage).toBe('unavailable');
});

test('uncertain create retries the original key; save retry keeps identical bytes', async () => {
  const pages = pagesFor(16, 0);
  const ready = recordingPort(pages, { failCreateOnce: true });
  const held: Uint8Array[] = [];
  let failSave = true;
  const journey = createExportJourney({
    port: ready.port,
    visit: visit(),
    deliver(file) {
      held.push(file.bytes);
      if (failSave) {
        failSave = false;
        return false;
      }
      return true;
    },
  });
  let snap = await journey.capture();
  expect(snap.notice?.kind).toBe('unknown');
  expect(ready.creates).toHaveLength(1);
  const key = ready.creates[0]!;
  snap = await journey.retryUnknown();
  expect(ready.creates).toEqual([key, key]);
  expect(snap.stage).toBe('ready');
  snap = await journey.download();
  expect(snap.stage).toBe('save-failed');
  snap = await journey.download();
  expect(snap.notice?.kind).toBe('saved');
  expect(held).toHaveLength(2);
  expect(held[0]).toEqual(held[1]);
  expect(ready.creates).toHaveLength(2);
});

test('stale replay, cancellation, retirement and signed-out stay distinct', async () => {
  const ready = recordingPort(pagesFor(16, 0), { staleOnStatus: true });
  const journey = createExportJourney({ port: ready.port, visit: visit() });
  let snap = await journey.capture();
  expect(snap.hasArtifact).toBe(true);
  snap = await journey.replay();
  expect(snap.stage).toBe('stale');
  expect(snap.hasArtifact).toBe(false);

  const live = recordingPort(pagesFor(128, 1));
  let cancelling: ReturnType<typeof createExportJourney>;
  cancelling = createExportJourney({
    port: live.port,
    visit: visit(),
    onChange(current) {
      if (current.stage === 'capturing' && current.pages >= 1 && live.cancels.length === 0) void cancelling.cancel();
    },
  });
  snap = await cancelling.capture();
  expect(snap.stage).toBe('cancelled');
  expect(snap.hasArtifact).toBe(false);
  expect(live.cancels).toEqual([exportId]);

  const { port } = recordingPort(pagesFor(1, 0));
  await mount(port, visit('alice', 'csrf-a'));
  await click(m.library_export_capture());
  await waitFor(m.library_export_ready());
  await mount(port, visit('bob', 'csrf-b'));
  expect(host.textContent).toContain(m.library_export_capture());
  expect(host.textContent).not.toContain(m.library_export_ready());

  await mount(port, null);
  expect(host.textContent).toContain(m.library_export_sign_in());
});

test('growth at 16, 128 and 1,024 records stays linear in pages and bounded per page', async () => {
  for (const total of [16, 128, 1_024]) {
    const pages = pagesFor(total, 1);
    const { port, pageCursors } = recordingPort(pages);
    const held: Uint8Array[] = [];
    const journey = createExportJourney({
      port,
      visit: visit(),
      deliver(file) {
        held.push(file.bytes);
        return true;
      },
    });
    const snap = await journey.capture();
    expect(snap.hasArtifact).toBe(true);
    expect(snap.cost.maxPageRecords).toBeLessThanOrEqual(EXPORT_PAGE_ROWS);
    expect(snap.cost.pagesVisited).toBe(pages.length);
    expect(snap.cost.emptyPages).toBeGreaterThan(0);
    expect(snap.cost.recordsProcessed).toBe(total);
    expect(snap.cost.prefixCopies).toBe(0);
    expect(snap.cost.finalizeCount).toBe(1);
    expect(exportCallTotal(snap.cost)).toBe(
      expectedExportCalls({
        pages: snap.cost.pagesVisited,
        create: snap.cost.calls.create,
        status: snap.cost.calls.status,
        cancel: snap.cost.calls.cancel,
        retries: snap.cost.retries,
      }),
    );
    expect(pageCursors).toHaveLength(pages.length);
    expect(pageCursors.length).not.toBe(Math.ceil(total / EXPORT_PAGE_ROWS));
    await journey.download();
    await journey.download();
    expect(held).toHaveLength(2);
    expect(held[0]).toEqual(held[1]);
    expect(snap.cost.calls.create).toBe(1);
    const limited = recordingPort([
      pageOf(
        Array.from({ length: 16 }, (_, index) => recordOf(index)),
        { state: 'limit' },
      ),
    ]);
    const rejected = createExportJourney({ port: limited.port, visit: visit() });
    const terminal = await rejected.capture();
    expect(terminal.stage).toBe('limit');
    expect(terminal.hasArtifact).toBe(false);
  }
});
