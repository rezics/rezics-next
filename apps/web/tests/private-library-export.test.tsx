import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { LibraryExportStatus } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  EXPORT_COMPLETENESS,
  EXPORT_FORMAT,
  EXPORT_PAGE_ROWS,
  EXPORT_PRIVACY,
  EXPORT_SECTIONS_V1,
  EXPORT_SECTIONS_V2,
  EXPORT_SECTIONS_V3,
  EXPORT_SECTIONS_V4,
  EXPORT_V2_COVERAGE,
  EXPORT_V3_COVERAGE,
  EXPORT_V4_COVERAGE,
  EXPORT_VERSION,
  type ExportArtifact,
  type ExportCommand,
  type ExportManifest,
  type ExportPage,
  type ExportPort,
  type ExportRecord,
  type ExportStatus,
  type ExportSectionTotals,
  type ExportSection,
  type ExportVersion,
  encodedRecordBytes,
  isExportStatus,
  sectionsForExportVersion,
} from '../src/library/private-export/contract';
import { exportCallTotal, expectedExportCalls } from '../src/library/private-export/cost';
import { createExportJourney } from '../src/library/private-export/controller';
import { parseAssembledArtifact } from '../src/library/private-export/artifact';
import { libraryNavigation } from '../src/library/navigation';
import type { ExportVisit } from '../src/library/private-export/visit';
import { exportRecording, recordedExportPort } from '../src/library/private-export/recording';

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
const capturedAt = new Date(Date.now() + 60_000).toISOString();
const expiresAt = new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString();
const omissions = {
  trash: 'excluded',
  providerIdentifiers: 'stored evidence only',
  personalImportEvidence: 'retained rows only',
  commerce: 'excluded',
  publication: 'excluded',
  reimport: 'unavailable',
};

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

function coverage(extra: Partial<ExportStatus> = {}, version: ExportVersion = EXPORT_VERSION): ExportStatus {
  const common = {
    format: EXPORT_FORMAT,
    exportId,
    capturedAt,
    expiresAt,
    privacy: EXPORT_PRIVACY,
    completeness: EXPORT_COMPLETENESS,
    omissions,
    fullExport: false,
    state: 'collecting',
    first,
  };
  const versioned =
    version === 1
      ? { ...common, version: 1 as const, sections: [...EXPORT_SECTIONS_V1] }
      : version === 2
        ? { ...common, version: 2 as const, coverage: EXPORT_V2_COVERAGE, sections: [...EXPORT_SECTIONS_V2] }
        : version === 3
          ? { ...common, version: 3 as const, coverage: EXPORT_V3_COVERAGE, sections: [...EXPORT_SECTIONS_V3] }
          : { ...common, version: 4 as const, coverage: EXPORT_V4_COVERAGE, sections: [...EXPORT_SECTIONS_V4] };
  return { ...versioned, ...extra } as ExportStatus;
}

function manifest(records: readonly ExportRecord[], version: ExportVersion = EXPORT_VERSION): ExportManifest {
  const status = coverage({ state: 'ready', first: null }, version);
  const { state: _state, first: _first, ...base } = status;
  const sections = version === 1 ? [] : sectionsForExportVersion(version);
  const sectionTotals = Object.fromEntries(
    sections.map((section) => [
      section,
      records.reduce(
        (total, record) =>
          record.section === section
            ? { rows: total.rows + 1, recordBytes: total.recordBytes + encodedRecordBytes(record) }
            : total,
        { rows: 0, recordBytes: 0 },
      ),
    ]),
  ) as ExportSectionTotals<ExportSection>;
  const recordBytes = records.reduce((sum, record) => sum + encodedRecordBytes(record), 0);
  if (base.version === 1) return { ...base, rows: records.length, recordBytes };
  return { ...base, rows: records.length, recordBytes, sectionTotals };
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

function journalRecord(index: number, units?: number | null): ExportRecord {
  const sessionId = `0192f3a0-6c1e-7b2a-9d4e-${index.toString(16).padStart(12, '0')}`;
  return {
    section: 'journals',
    accountId: 'owner-1',
    sessionId,
    subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    versionSubjectId: null,
    state: 'active',
    progressRevision: 4,
    libraryProfilePin: null,
    startedAt: '2026-11-04T11:00:00.000Z',
    completedAt: null,
    lastChangedAt: '2026-11-04T11:05:00.000Z',
    journal: {
      sessionId,
      revision: 5,
      startDate: { year: 2024 },
      finishDate: null,
      reflection: '',
      ...(units === undefined ? {} : { assessment: { meaningRevision: 1, units } }),
    },
  };
}

function pageOf(records: ExportRecord[], extra: Partial<ExportPage> = {}): ExportPage {
  return { exportId, state: 'collecting', records, next: null, manifest: null, ...extra };
}

function pagesFor(total: number, emptyAfter = 0): ExportPage[] {
  const pages: ExportPage[] = [];
  const allRecords = Array.from({ length: total }, (_, index) => recordOf(index));
  const finalManifest = manifest(allRecords);
  let remaining = total;
  let index = 0;
  while (remaining > 0) {
    const take = Math.min(EXPORT_PAGE_ROWS, remaining);
    const slice = allRecords.slice(index, index + take);
    remaining -= take;
    index += take;
    const last = remaining === 0;
    pages.push(
      pageOf(slice, {
        next: last && emptyAfter === 0 ? null : `cursor-${pages.length + 1}`,
        state: last && emptyAfter === 0 ? 'ready' : 'collecting',
        manifest: last && emptyAfter === 0 ? finalManifest : null,
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
        manifest: last ? finalManifest : null,
      }),
    );
  }
  if (total === 0) {
    return [pageOf([], { state: 'ready', next: null, manifest: finalManifest })];
  }
  return pages;
}

function recordingPort(
  pages: ExportPage[],
  options: {
    create?: ExportPort['create'];
    status?: ExportStatus;
    version?: ExportVersion;
    failCreateOnce?: boolean;
    failPageOnce?: boolean;
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
  let pageFailures = 0;
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
      return { kind: 'status', status: coverage({}, options.version) };
    },
    async status(command) {
      statuses.push(command.exportId);
      if (options.staleOnStatus)
        return { kind: 'status', status: coverage({ state: 'stale', first: null }, options.version) };
      return { kind: 'status', status: options.status ?? coverage({ state: 'ready', first }, options.version) };
    },
    async page(command) {
      pageCursors.push(command.cursor);
      if (options.failPageOnce && pageFailures++ === 0) return { kind: 'unknown', command };
      const page = byCursor.get(command.cursor);
      if (!page) return { kind: 'unavailable' };
      return { kind: 'page', page };
    },
    async cancel(command) {
      cancels.push(command.exportId);
      return { kind: 'cancelled', status: coverage({ state: 'cancelled', first: null }, options.version) };
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

async function mount(
  port: ExportPort,
  current: ExportVisit | null = visit(),
  runtime: Parameters<typeof PrivateLibraryExportPage>[0] = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <LibraryExportPortContext.Provider value={port}>
          <PrivateLibraryExportPage visit={current} {...runtime} />
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

test('version 3 preserves owner records and assessments, then verifies every section total before saving exact bytes', async () => {
  const records: ExportRecord[] = [
    recordOf(0),
    {
      section: 'annotations',
      accountId: 'owner-1',
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
      entryIncarnationId: null,
      libraryProfilePin: null,
      annotationRevision: 3,
      note: null,
      priority: null,
      annotationUpdatedAt: null,
    },
    {
      section: 'provenance',
      accountId: 'owner-1',
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
      entryIncarnationId: null,
      libraryProfilePin: null,
      observation: {
        provider: 'vndb',
        recordId: 'source-row-1',
        revision: 2,
        privacy: { status: 'known', meaning: 'private' },
        sourceCreated: { status: 'known', value: '2024', precision: 'year', zone: 'unknown' },
        sourceUpdated: { status: 'cleared' },
        recordedAt: '2026-11-04T12:01:00.000Z',
      },
    },
    journalRecord(2, 0),
    journalRecord(3, null),
  ];
  const finalManifest = manifest(records, 3);
  const pages = [
    pageOf(records.slice(0, 2), { next: 'cursor-empty', state: 'collecting' }),
    pageOf([], { next: 'cursor-final', state: 'collecting' }),
    pageOf(records.slice(2), { state: 'ready', manifest: finalManifest }),
  ];
  const ready = recordingPort(pages, { version: 3 });
  const delivered: Uint8Array[] = [];
  const journey = createExportJourney({
    port: ready.port,
    visit: visit(),
    deliver(file) {
      delivered.push(file.bytes.slice());
      return true;
    },
  });

  const snap = await journey.capture();
  expect(snap.stage).toBe('ready');
  expect(snap.cost.pagesVisited).toBe(3);
  expect(snap.cost.emptyPages).toBe(1);
  expect(snap.cost.maxPageRecords).toBeLessThanOrEqual(EXPORT_PAGE_ROWS);
  expect(ready.pageCursors).toEqual([first, 'cursor-empty', 'cursor-final']);
  expect(snap.manifest?.version).toBe(3);
  expect(Object.keys(snap.manifest?.version === 3 ? snap.manifest.sectionTotals : {})).toEqual([...EXPORT_SECTIONS_V3]);
  expect(snap.manifest?.version === 3 ? snap.manifest.sectionTotals.annotations : null).toEqual({
    rows: 1,
    recordBytes: encodedRecordBytes(records[1]!),
  });
  expect(snap.manifest?.version === 3 ? snap.manifest.sectionTotals.units : null).toEqual({
    rows: 0,
    recordBytes: 0,
  });
  expect(snap.manifest?.version === 3 ? snap.manifest.sectionTotals.journals.rows : null).toBe(2);
  await journey.download();
  expect(delivered).toHaveLength(1);
  const exactBytes = new TextDecoder().decode(delivered[0]);
  expect(exactBytes).toBe(JSON.stringify({ manifest: finalManifest, records }));
  expect(exactBytes).toContain('"assessment":{"meaningRevision":1,"units":0}');
  expect(exactBytes).toContain('"assessment":{"meaningRevision":1,"units":null}');
  expect(parseAssembledArtifact(delivered[0]!)).toEqual({ manifest: finalManifest, records });
});

test('mounted version 4 coverage reaches the completed download state with all 21 totals', async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:https://site.test/private-export';
  URL.revokeObjectURL = () => {};
  try {
    const capture = exportRecording(4);
    const recording = recordedExportPort(capture);
    const files: Uint8Array[] = [];
    await mount(recording.port, visit(), {
      now: recording.now,
      deliver: (file) => {
        files.push(file.bytes);
        return true;
      },
    });
    expect(host.textContent).toContain(m.library_export_version({ version: 4 }));
    expect(host.textContent).toContain(m.library_export_section_annotations());
    expect(host.textContent).toContain(m.library_export_section_provenance());
    expect(host.textContent).toContain(m.library_export_section_journals());
    expect(host.textContent).toContain(m.library_export_section_vndb());
    expect(host.textContent).toContain(m.library_export_section_anilist());
    await click(m.library_export_capture());
    await waitFor(m.library_export_ready());
    expect(host.textContent).toContain(m.library_export_section_total({ rows: 0, bytes: 0 }));
    expect(host.textContent).toContain(m.library_export_section_vndb_evidence());
    expect(host.textContent).toContain(m.library_export_section_anilist_evidence());
    expect(host.textContent).toContain(m.library_export_no_reimport());
    await click(m.library_export_download());
    await waitFor(m.library_export_downloaded());
    expect(new TextDecoder().decode(files[0])).toBe(capture.artifact);
    expect(recording.commands.map((command) => command.kind)).toEqual(['create', ...capture.pages.map(() => 'page')]);
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      m.library_export_download(),
    ]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('stored version 1 keeps its original sections and retries the exact cursor', async () => {
  const records = [recordOf(7)];
  const stored = coverage({}, 1);
  const oldPage = pageOf(records, { state: 'ready', manifest: manifest(records, 1) });
  const calls = recordingPort([oldPage], {
    create: async () => ({ kind: 'status', status: stored }),
    failPageOnce: true,
  });
  const journey = createExportJourney({ port: calls.port, visit: visit() });

  let snap = await journey.capture();
  expect(snap.notice).toMatchObject({ kind: 'unknown', command: { kind: 'page', cursor: first } });
  snap = await journey.retryUnknown();
  expect(snap.stage).toBe('ready');
  expect(snap.hasArtifact).toBe(true);
  expect(snap.manifest).toMatchObject({
    version: 1,
    sections: [...EXPORT_SECTIONS_V1],
    rows: 1,
    recordBytes: encodedRecordBytes(records[0]!),
  });
  expect(snap.manifest?.version === 1 && 'sectionTotals' in snap.manifest).toBe(false);
  expect(calls.creates).toHaveLength(1);
  expect(calls.pageCursors).toEqual([first, first]);
});

test('stored version 2 keeps its original journal shape, totals and exact retry cursor', async () => {
  const records = [journalRecord(7)];
  const stored = coverage({}, 2);
  const pages = [pageOf(records, { state: 'ready', manifest: manifest(records, 2) })];
  const calls = recordingPort(pages, { create: async () => ({ kind: 'status', status: stored }), failPageOnce: true });
  const delivered: Uint8Array[] = [];
  const journey = createExportJourney({
    port: calls.port,
    visit: visit(),
    deliver(file) {
      delivered.push(file.bytes.slice());
      return true;
    },
  });

  let snap = await journey.capture();
  expect(snap.notice).toMatchObject({ kind: 'unknown', command: { kind: 'page', cursor: first } });
  snap = await journey.retryUnknown();
  expect(snap.manifest?.version).toBe(2);
  expect(calls.pageCursors).toEqual([first, first]);
  await journey.download();
  expect(new TextDecoder().decode(delivered[0]!)).not.toContain('assessment');
});

test('version 3 refuses missing or malformed journal assessment fields', async () => {
  for (const record of [journalRecord(8), journalRecord(9, 21)]) {
    const page = pageOf([record], { state: 'ready', manifest: manifest([record], 3) });
    const journey = createExportJourney({ port: recordingPort([page], { version: 3 }).port, visit: visit() });
    const snap = await journey.capture();
    expect(snap.stage).toBe('unavailable');
    expect(snap.hasArtifact).toBe(false);
  }
});

test('mixed versions, captures and section totals refuse the final artifact', async () => {
  const capture = exportRecording(4);
  const records = capture.pages.flatMap((page) => page.records);
  const last = capture.pages.at(-1)!;
  const good = last.manifest!;
  if (good.version !== 4) throw new Error('Expected a version 4 fixture');
  const wrongTotals = {
    ...good,
    sectionTotals: {
      ...good.sectionTotals,
      vndbEvidence: { rows: 0, recordBytes: 0 },
      anilistEvidence: {
        rows: good.sectionTotals.vndbEvidence.rows + good.sectionTotals.anilistEvidence.rows,
        recordBytes: good.sectionTotals.vndbEvidence.recordBytes + good.sectionTotals.anilistEvidence.recordBytes,
      },
    },
  };
  const wrongCapture = {
    ...good,
    exportId: '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb',
  };
  const mismatches: ExportManifest[] = [
    manifest(records, 1),
    manifest(records, 2),
    manifest(records, 3),
    wrongCapture,
    wrongTotals,
  ];
  for (const mismatched of mismatches) {
    const recording = recordedExportPort({
      ...capture,
      pages: [...capture.pages.slice(0, -1), { ...last, manifest: mismatched }],
    });
    const journey = createExportJourney({ port: recording.port, now: recording.now, visit: visit() });
    const snap = await journey.capture();
    expect(snap.stage).toBe('unavailable');
    expect(snap.hasArtifact).toBe(false);
  }
  const recording = recordedExportPort({
    ...capture,
    pages: [...capture.pages.slice(0, -1), { ...last, state: 'stale', manifest: good }],
  });
  const terminal = createExportJourney({
    port: recording.port,
    now: recording.now,
    visit: visit(),
  });
  const terminalSnap = await terminal.capture();
  expect(terminalSnap.hasArtifact).toBe(false);
});

test('V4 requires its exact inventory and coverage; V3 cannot append providers and unknown versions stay unavailable', () => {
  expect(EXPORT_SECTIONS_V3).toHaveLength(17);
  expect(EXPORT_SECTIONS_V4.slice(17)).toEqual(['vndbUploads', 'vndbEvidence', 'anilistUploads', 'anilistEvidence']);
  const producer = exportRecording(4);
  expect(producer.status.sections).toEqual([...EXPORT_SECTIONS_V4]);
  const final = producer.pages.at(-1)!.manifest!;
  if (final.version !== 4) throw new Error('Expected the published V4 producer');
  expect(Object.keys(final.sectionTotals)).toEqual([...EXPORT_SECTIONS_V4]);
  expect(EXPORT_SECTIONS_V4.slice(17).map((section) => final.sectionTotals[section].rows)).toEqual([1, 2, 1, 1]);
  const installed: LibraryExportStatus = producer.status;
  expect(isExportStatus(installed)).toBe(true);
  for (const status of [
    { ...coverage(), version: 5 },
    { ...coverage(), coverage: EXPORT_V3_COVERAGE },
    { ...coverage(), sections: EXPORT_SECTIONS_V3 },
    { ...coverage({}, 3), sections: EXPORT_SECTIONS_V4 },
    { ...coverage(), sections: [...EXPORT_SECTIONS_V4].reverse() },
  ])
    expect(isExportStatus(status)).toBe(false);
});

test('producer V1/V4 retain exact cursors, sections and file bytes across unknown create/page and save retry', async () => {
  for (const version of [1, 4] as const) {
    const capture = exportRecording(version);
    const recording = recordedExportPort(capture);
    let createFailed = false,
      pageFailed = false;
    const calls: ExportCommand[] = [];
    const port: ExportPort = {
      ...recording.port,
      async create(command) {
        calls.push(command);
        if (!createFailed) {
          createFailed = true;
          return { kind: 'unknown', command };
        }
        return recording.port.create(command);
      },
      async page(command) {
        calls.push(command);
        if (!pageFailed) {
          pageFailed = true;
          return { kind: 'unknown', command };
        }
        return recording.port.page(command);
      },
    };
    const files: Uint8Array[] = [];
    const journey = createExportJourney({
      port,
      visit: visit(),
      now: recording.now,
      deliver: (file) => {
        files.push(file.bytes);
        return files.length > 1;
      },
    });
    expect((await journey.capture()).hasArtifact).toBe(false);
    expect((await journey.retryUnknown()).hasArtifact).toBe(false);
    expect((await journey.retryUnknown()).stage).toBe('ready');
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[2]).toEqual(calls[3]);
    expect(recording.commands.filter((command) => command.kind === 'page').map((command) => command.cursor)).toEqual([
      capture.status.first,
      ...capture.pages.slice(0, -1).map((page) => page.next),
    ]);
    expect((await journey.download()).stage).toBe('save-failed');
    await journey.download();
    expect(files[0]).toBe(files[1]);
    expect(new TextDecoder().decode(files[0])).toBe(capture.artifact);
    const journals = capture.pages.flatMap((page) => page.records).filter((record) => record.section === 'journals');
    if (version === 4)
      for (const units of [null, 0])
        expect(journals.map((record) => record.journal)).toContainEqual(
          expect.objectContaining({ assessment: { meaningRevision: 1, units } }),
        );
    expect(capture.status.sections).toHaveLength(version === 1 ? 14 : 21);
  }
});

test('failure, source invalidation, expiry and viewer or credential retirement clear incomplete producer bytes', async () => {
  for (const outcome of ['unavailable', 'retire', 'stale', 'expiry', 'viewer', 'csrf'] as const) {
    const current = visit();
    const capture = exportRecording(4);
    const recording = recordedExportPort(capture);
    let clock = recording.now();
    let journey: ReturnType<typeof createExportJourney>;
    const port: ExportPort = {
      ...recording.port,
      async page(command) {
        if (journey.snapshot().records === 0) return recording.port.page(command);
        expect(journey.snapshot().cost.retainedBytes).toBeGreaterThan(0);
        if (outcome === 'retire') current.retire();
        if (outcome === 'viewer') current.subject = 'replacement-viewer';
        if (outcome === 'csrf') current.csrfToken = 'replacement-credential';
        if (outcome === 'expiry') clock = Date.parse(capture.status.expiresAt);
        if (outcome === 'stale')
          return {
            kind: 'page',
            page: { exportId: capture.status.exportId, state: 'stale', records: [], next: null, manifest: null },
          };
        return { kind: 'unavailable' };
      },
    };
    journey = createExportJourney({ port, visit: current, now: () => clock });
    const snap = await journey.capture();
    expect(snap.records).toBe(0);
    expect(snap.cost.retainedBytes).toBe(0);
    expect(snap.hasArtifact).toBe(false);
  }
});

test('fixed expiry and viewer retirement discard late private pages', async () => {
  const records = [recordOf(4)];
  const deadline = 900_000;
  let clock = deadline - 1;
  const status = coverage({
    capturedAt: new Date(0).toISOString(),
    expiresAt: new Date(deadline).toISOString(),
  });
  const finalManifest = {
    ...manifest(records),
    capturedAt: status.capturedAt,
    expiresAt: status.expiresAt,
  };
  const expiringPort: ExportPort = {
    async create() {
      return { kind: 'status', status };
    },
    async status() {
      return { kind: 'status', status };
    },
    async page() {
      clock = deadline;
      return { kind: 'page', page: pageOf(records, { state: 'ready', manifest: finalManifest }) };
    },
    async cancel() {
      return { kind: 'cancelled', status: coverage({ state: 'cancelled', first: null }) };
    },
  };
  const expired = await createExportJourney({ port: expiringPort, visit: visit(), now: () => clock }).capture();
  expect(expired.stage).toBe('expired');
  expect(expired.hasArtifact).toBe(false);

  let finishPage!: (result: Awaited<ReturnType<ExportPort['page']>>) => void;
  const latePage = new Promise<Awaited<ReturnType<ExportPort['page']>>>((resolve) => {
    finishPage = resolve;
  });
  const pendingPort: ExportPort = {
    async create() {
      return { kind: 'status', status: coverage() };
    },
    async status() {
      return { kind: 'status', status: coverage() };
    },
    async page() {
      return latePage;
    },
    async cancel() {
      return { kind: 'cancelled', status: coverage({ state: 'cancelled', first: null }) };
    },
  };
  const current = visit('alice', 'csrf-a');
  const journey = createExportJourney({ port: pendingPort, visit: current });
  const pending = journey.capture();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  current.retire();
  finishPage({ kind: 'page', page: pageOf(records, { state: 'ready', manifest: manifest(records) }) });
  await pending;
  expect(journey.live()).toBe(false);
  expect(journey.snapshot().hasArtifact).toBe(false);
  expect(journey.snapshot().records).toBe(0);
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

test('pending local save admits one delivery and retries the exact artifact after false or throw', async () => {
  const ready = recordingPort(pagesFor(1));
  const attempts: Array<ReturnType<typeof Promise.withResolvers<boolean>>> = [];
  const bytes: Uint8Array[] = [];
  const reentries: Promise<unknown>[] = [];
  let journey!: ReturnType<typeof createExportJourney>;
  let reenteredFromChange = false;
  journey = createExportJourney({
    port: ready.port,
    visit: visit(),
    onChange(snapshot) {
      if (snapshot.busy && ['ready', 'empty', 'save-failed'].includes(snapshot.stage) && !reenteredFromChange) {
        reenteredFromChange = true;
        reentries.push(journey.download(), journey.replay());
      }
    },
    deliver(file) {
      bytes.push(file.bytes);
      const pending = Promise.withResolvers<boolean>();
      attempts.push(pending);
      if (attempts.length === 1) reentries.push(journey.download(), journey.replay());
      return pending.promise;
    },
  });
  const complete = await journey.capture();
  const key = complete.requestKey;
  const pages = [...ready.pageCursors];
  const delivery = journey.download();
  expect(journey.snapshot()).toMatchObject({ busy: true, hasArtifact: true });
  await Promise.all(reentries);
  expect(attempts).toHaveLength(1);
  expect(ready.statuses).toEqual([]);
  expect(ready.pageCursors).toEqual(pages);
  attempts[0]!.resolve(false);
  expect(await delivery).toMatchObject({ stage: 'save-failed', busy: false, hasArtifact: true });
  const retryAfterFalse = journey.download();
  attempts[1]!.reject(new Error('local save failed'));
  expect(await retryAfterFalse).toMatchObject({ stage: 'save-failed', busy: false, hasArtifact: true });
  const retryAfterThrow = journey.download();
  attempts[2]!.resolve(true);
  expect(await retryAfterThrow).toMatchObject({ stage: 'ready', busy: false, notice: { kind: 'saved' } });
  expect(bytes[0]).toBe(bytes[1]);
  expect(bytes[1]).toBe(bytes[2]);
  expect(journey.snapshot().requestKey).toBe(key);
  expect(ready.creates).toEqual([key]);
  expect(ready.statuses).toEqual([]);
  expect(ready.pageCursors).toEqual(pages);

  const mounted = recordingPort(pagesFor(1));
  const handoff = Promise.withResolvers<boolean>();
  let deliveries = 0;
  await mount(mounted.port, visit(), {
    deliver: () => {
      deliveries += 1;
      return handoff.promise;
    },
  });
  await click(m.library_export_capture());
  await waitFor(m.library_export_ready());
  await click(m.library_export_download());
  expect(button(m.library_export_download())?.disabled).toBe(true);
  expect(deliveries).toBe(1);
  await act(async () => handoff.resolve(true));
  await waitFor(m.library_export_downloaded());
  expect(button(m.library_export_download())?.disabled).toBe(false);
});

test('retired, replaced and expired visits discard pending delivery completion', async () => {
  for (const outcome of ['retire', 'viewer', 'csrf', 'expiry'] as const) {
    const ready = recordingPort(pagesFor(1));
    const current = visit();
    const pending = Promise.withResolvers<boolean>();
    let clock = Date.now();
    const journey = createExportJourney({ port: ready.port, visit: current, now: () => clock, deliver: () => pending.promise });
    expect((await journey.capture()).hasArtifact).toBe(true);
    const pages = [...ready.pageCursors];
    const delivery = journey.download();
    expect(journey.snapshot()).toMatchObject({ busy: true, hasArtifact: true });
    if (outcome === 'retire') current.retire();
    if (outcome === 'viewer') current.subject = 'replacement-viewer';
    if (outcome === 'csrf') current.csrfToken = 'replacement-credential';
    if (outcome === 'expiry') clock = Date.parse(expiresAt);
    pending.resolve(true);
    expect(await delivery).toMatchObject({
      stage: outcome === 'expiry' ? 'expired' : 'coverage',
      busy: false,
      notice: null,
      hasArtifact: false,
      cost: { retainedBytes: 0 },
    });
    expect(ready.creates).toHaveLength(1);
    expect(ready.statuses).toEqual([]);
    expect(ready.pageCursors).toEqual(pages);
  }
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
    const limited = recordingPort([pageOf([], { state: 'limit' })]);
    const rejected = createExportJourney({ port: limited.port, visit: visit() });
    const terminal = await rejected.capture();
    expect(terminal.stage).toBe('limit');
    expect(terminal.hasArtifact).toBe(false);
  }
});

test('mounted cancellation retries its uncertain command once and ignores late pages before and after acknowledgement', async () => {
  const fixture = recordingPort(pagesFor(32));
  const page = Promise.withResolvers<Awaited<ReturnType<ExportPort['page']>>>();
  let attempt = Promise.withResolvers<Awaited<ReturnType<ExportPort['cancel']>>>();
  const commands: ExportCommand[] = [];
  const port: ExportPort = {
    ...fixture.port,
    page: (command) => (fixture.pageCursors.length === 0 ? fixture.port.page(command) : page.promise),
    cancel(command) {
      commands.push(command);
      return attempt.promise;
    },
  };
  await mount(port);
  await click(m.library_export_capture());
  await waitFor(m.library_export_progress({ records: 16, pages: 1 }));
  await click(m.library_export_cancel());
  expect(host.textContent).toContain(m.library_export_cancelling());
  expect(document.activeElement?.textContent).toBe(m.library_export_cancelling());
  expect(button(m.library_export_cancel())).toBeUndefined();
  expect(commands).toHaveLength(1);
  await act(async () => attempt.resolve({ kind: 'unknown', command: commands[0]! }));
  await waitFor(m.library_export_cancel_uncertain());
  expect(document.activeElement?.textContent).toBe(m.library_export_cancel_uncertain());
  expect(button(m.library_export_capture())).toBeUndefined();
  expect(button(m.library_export_download())).toBeUndefined();
  attempt = Promise.withResolvers();
  await click(m.library_export_retry_command());
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  await act(async () => page.resolve({ kind: 'unknown', command: { kind: 'page', exportId, cursor: first } }));
  expect(host.textContent).toContain(m.library_export_cancelling());
  await act(async () => attempt.resolve({ kind: 'cancelled', status: coverage({ state: 'cancelled', first: null }) }));
  await waitFor(m.library_export_cancelled());
  expect(document.activeElement?.textContent).toBe(m.library_export_cancelled());
  expect(button(m.library_export_download())).toBeUndefined();
  expect(fixture.creates).toHaveLength(1);
  await click(m.library_export_restart());
  expect(button(m.library_export_capture())).toBeDefined();
  expect(fixture.creates).toHaveLength(1);
});

test('in-flight cancel and retry coalesce; late final pages cannot restore cancelled or retired bytes', async () => {
  for (const retire of [false, true]) {
    const page = Promise.withResolvers<Awaited<ReturnType<ExportPort['page']>>>();
    let ack = Promise.withResolvers<Awaited<ReturnType<ExportPort['cancel']>>>();
    const fixture = recordingPort(pagesFor(1));
    const commands: ExportCommand[] = [];
    const current = visit();
    const journey = createExportJourney({
      visit: current,
      port: {
        ...fixture.port,
        page: () => page.promise,
        cancel(command) {
          commands.push(command);
          return ack.promise;
        },
      },
    });
    const capture = journey.capture();
    await settle();
    const cancelling = journey.cancel();
    const duplicate = journey.cancel();
    await settle();
    expect(commands).toHaveLength(1);
    expect(journey.snapshot()).toMatchObject({ stage: 'cancelling', records: 0, hasArtifact: false });
    ack.resolve({ kind: 'unknown', command: commands[0]! });
    await Promise.all([cancelling, duplicate]);
    const key = journey.snapshot().requestKey;
    expect(journey.restart().requestKey).toBe(key);
    await journey.replay();
    ack = Promise.withResolvers();
    const retry = journey.retryUnknown();
    const repeated = journey.retryUnknown();
    await settle();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    if (retire) current.csrfToken = 'replacement';
    ack.resolve({ kind: 'cancelled', status: coverage({ state: 'cancelled', first: null }) });
    await Promise.all([retry, repeated]);
    page.resolve({ kind: 'page', page: pagesFor(1)[0]! });
    await capture;
    expect(journey.snapshot()).toMatchObject({
      stage: retire ? 'coverage' : 'cancelled',
      records: 0,
      hasArtifact: false,
    });
    expect(journey.snapshot().cost.retainedBytes).toBe(0);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.statuses).toHaveLength(0);
  }
});

test('cancellation distinguishes native refusal and expiry; pending create cannot be abandoned', async () => {
  for (const kind of ['denied', 'unavailable', 'expired'] as const) {
    const fixture = recordingPort(pagesFor(1));
    const journey = createExportJourney({
      visit: visit(),
      port: {
        ...fixture.port,
        page: async (command) => ({ kind: 'unknown', command }),
        cancel: async () =>
          kind === 'expired' ? { kind: 'cancelled', status: coverage({ state: 'expired', first: null }) } : { kind },
      },
    });
    await journey.capture();
    expect((await journey.cancel()).stage).toBe(kind);
    expect(journey.snapshot().hasArtifact).toBe(false);
  }
  const created = Promise.withResolvers<Awaited<ReturnType<ExportPort['create']>>>();
  const fixture = recordingPort(pagesFor(1), { create: () => created.promise });
  const journey = createExportJourney({ port: fixture.port, visit: visit() });
  const capture = journey.capture();
  const key = journey.snapshot().requestKey;
  await journey.cancel();
  expect(journey.restart().requestKey).toBe(key);
  expect(fixture.cancels).toHaveLength(0);
  created.resolve({ kind: 'unknown', command: { kind: 'create', key } });
  await capture;
  await journey.capture();
  expect(journey.restart().requestKey).toBe(key);
  expect(fixture.creates).toEqual([key]);
  await journey.retryUnknown();
  expect(fixture.creates).toEqual([key, key]);
});
