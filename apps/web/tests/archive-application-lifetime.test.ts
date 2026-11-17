import { afterAll, expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { QueryClient } = await import('@tanstack/react-query');
const { libraryApplication } = await import('../src/session/library-application');
const { exposureQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { createKernelClient } = await import('@rezics/client');
const { ArchiveEntryRecoveryJourney } = await import('../src/library/archive-entry-recovery/controller');
const { archiveRecoveryNative } = await import('../src/library/archive-entry-recovery/native');
const { ProgressRecoveryJourney } = await import('../src/library/archive-progress-recovery/controller');
const { progressRecoveryNative } = await import('../src/library/archive-progress-recovery/native');
const { holdCompletedArchive, completedArchiveFor, bindArchiveCustodyOwner } =
  await import('../src/library/private-export/custody');
afterAll(() => mock.restore());

const session = (subject: string) => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });

test('archive callbacks distinguish equal observations, ABA and removed/recreated session queries', () => {
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const observer = libraryApplication.recoveryObservation(client);
  const original = observer.read();
  expect(observer.read()).toBe(original);
  client.setQueryData(['unrelated'], 'public');
  expect(observer.read()).toBe(original);
  client.setQueryData(['session'], session('A'));
  expect(observer.read().identity).not.toBe(original.identity);
  const replacement = observer.read();
  client.setQueryData(['session'], session('B'));
  client.setQueryData(['session'], session('A'));
  expect(observer.read().identity).not.toBe(replacement.identity);
  const beforeRemoval = observer.read();
  client.removeQueries({ queryKey: ['session'], exact: true });
  client.setQueryData(['session'], session('A'));
  expect(observer.read().identity).not.toBe(beforeRemoval.identity);
  client.clear();
});

test('application observation retires completed private bytes synchronously before account return', () => {
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const observer = libraryApplication.recoveryObservation(client);
  const stop = observer.subscribe(() => bindArchiveCustodyOwner(observer.read().subject ?? ''));
  // Custody owns a copy of the downloaded bytes and erases it at reader replacement.
  holdCompletedArchive(
    'A',
    {
      filename: 'archive.json',
      mediaType: 'application/json',
      bytes: new Uint8Array([65, 66]),
    },
    { exportId: 'export', capturedAt: '2026-11-07T00:00:00Z', version: 4 },
  );
  const held = completedArchiveFor('A')!;
  client.setQueryData(['session'], session('B'));
  expect(completedArchiveFor('A')).toBeNull();
  expect([...held.bytes]).toEqual([0, 0]);
  client.setQueryData(['session'], session('A'));
  expect(completedArchiveFor('A')).toBeNull();
  stop();
  client.clear();
});

test('capture readiness follows an initial read in flight without requiring an unrequested exposure query or a permission grant', async () => {
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const observer = libraryApplication.recoveryObservation(client);
  expect(observer.read().initializing).toBe(false);
  const query = client.getQueryCache().build(client, exposureQuery);
  expect(observer.read().initializing).toBe(false);
  let refuse!: () => void;
  const read = client.fetchQuery({
    ...exposureQuery,
    retry: false,
    queryFn: () =>
      new Promise<string[]>((_resolve, reject) => {
        refuse = () => reject(new Error('Exposure unavailable'));
      }),
  });
  expect(observer.read().initializing).toBe(true);
  refuse();
  await expect(read).rejects.toThrow('Exposure unavailable');
  expect(query.state.status).toBe('error');
  expect(observer.read().initializing).toBe(false);
  client.setQueryData(exposureQuery.queryKey, []);
  const settled = observer.read();
  expect(settled.initializing).toBe(false);
  client.setQueryData(exposureQuery.queryKey, []);
  expect(observer.read().identity).not.toBe(settled.identity);
  client.clear();
});

test('installed Library composition keeps recovery sections independent and erases custody before React catches up', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const { act, createElement, Fragment } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  const { LibraryApplicationBoundary } = await import('../src/session/library-application');
  const { useRecoveryLifetime } = await import('../src/library/recovery-lifetime');
  const window = new Window({ url: 'https://site.test/en/library/archive' });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(window.document.createElement('div'));
  const client = new QueryClient();
  client.setQueryData(['session'], session('A'));
  const sections = new Map<string, ReturnType<typeof useRecoveryLifetime>>();
  const retireControllers: (() => void)[] = [];
  function Section({ name }: { name: string }) {
    sections.set(name, useRecoveryLifetime(`/en/library/archive/${name}`, 'en'));
    return null;
  }
  try {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            LibraryApplicationBoundary,
            null,
            createElement(
              Fragment,
              null,
              createElement(Section, { name: 'entries' }),
              createElement(Section, { name: 'progress' }),
            ),
          ),
        ),
      );
    });
    const viewer = viewerExposureLifetime(client).getSnapshot();
    if (viewer.state !== 'signed-in') throw new Error('Expected the installed signed-in observation');
    let finishGlobal!: () => void;
    let finishScoped!: () => void;
    let globalRead!: Promise<unknown>;
    let scopedRead!: Promise<unknown>;
    await act(async () => {
      globalRead = client.fetchQuery({
        ...exposureQuery,
        queryFn: () =>
          new Promise<string[]>((resolve) => {
            finishGlobal = () => resolve([]);
          }),
      });
      scopedRead = client.fetchQuery({
        ...viewerExposureQuery(viewer.observation),
        gcTime: Infinity,
        queryFn: () =>
          new Promise((resolve) => {
            finishScoped = () => resolve({ subject: 'A', admitted: [], state: 'ready' as const });
          }),
      });
    });
    const early = { entries: sections.get('entries')!.current(), progress: sections.get('progress')!.current() };
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const requests: {
      method: string;
      path: string;
      key: string | null;
      authorization: string | null;
      bytes: string;
    }[] = [];
    const id = '00000000-0000-4000-8000-000000000001';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const entryStatus = {
      uploadId: id,
      createdAt: new Date().toISOString(),
      expiresAt,
      state: 'ready',
      rows: 1,
      recordBytes: 2,
      coverage: [],
    };
    const kernel = createKernelClient('http://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        requests.push({
          method: request.method,
          path,
          key: request.headers.get('idempotency-key'),
          authorization: request.headers.get('authorization'),
          bytes: await request.text(),
        });
        if (request.method === 'POST') {
          await acknowledgement;
          return Response.json(
            path === '/v1/libraryArchiveMerges'
              ? entryStatus
              : { uploadId: id, holdings: 0, progressRecords: 1, expiresAt },
          );
        }
        if (path.endsWith('/preview'))
          return Response.json({
            uploadId: id,
            state: 'ready',
            coverage: [],
            records: [
              { ordinal: 0, section: 'entries', status: 'unresolved', evidence: {}, review: null, reviewRevision: 0 },
            ],
            next: null,
          });
        if (path.endsWith('/progress'))
          return Response.json({
            uploadId: id,
            state: 'inspecting',
            expiresAt,
            manifest: {},
            coverage: [],
            occurrences: [{ ordinal: 3, evidence: { section: 'sessions', session_id: id } }],
            next: null,
          });
        return Response.json({
          uploadId: id,
          state: 'inspecting',
          expiresAt,
          manifest: {},
          coverage: [],
          holdings: 0,
          rows: [],
          next: null,
        });
      }) as typeof fetch,
    });
    const capture = () => {
      const entryScope = sections.get('entries')!,
        progressScope = sections.get('progress')!;
      const binding = {
        viewer: 'A',
        credentialEpoch: 'csrf-A',
        csrfEpoch: 'csrf-A',
        admission: 'installed',
        source: 'native-file',
        route: entryScope.address,
        locale: 'en',
        exposure: 'installed',
      };
      const entries = new ArchiveEntryRecoveryJourney(
        archiveRecoveryNative(kernel, 'Bearer original'),
        () => (entryScope.current() ? binding : null),
        Date.now() + 60_000,
      );
      const native = progressRecoveryNative(kernel, 'Bearer original');
      const progress = new ProgressRecoveryJourney(
        {
          ...native,
          choices: async () => {
            throw new Error('No mapping requested');
          },
        },
        crypto.randomUUID(),
        () => progressScope.current(),
      );
      entryScope.onRetire(() => entries.retire());
      progressScope.onRetire(() => progress.dispose());
      retireControllers.push(
        () => entries.retire(),
        () => progress.dispose(),
      );
      return { entries, progress };
    };
    let captured = early.entries && early.progress ? capture() : undefined;
    const file = () => new File([' {"manifest":{},"records":[]} '], 'original.json');
    let uploads = captured
      ? Promise.all([captured.entries.upload(file()), captured.progress.upload(file())])
      : undefined;
    await act(async () => {
      finishGlobal();
      await globalRead;
    });
    const duringScopedRead = sections.get('entries')!.current();
    await act(async () => {
      finishScoped();
      await scopedRead;
    });
    if (!captured) {
      captured = capture();
      uploads = Promise.all([captured.entries.upload(file()), captured.progress.upload(file())]);
    }
    acknowledge();
    await uploads;
    const reads = requests
      .filter(({ method }) => method === 'GET')
      .map(({ path }) =>
        path.endsWith('/preview') ? 'preview' : path.endsWith('/progress') ? 'progress' : 'holdings',
      );
    console.info('Archive initial producer handoff', {
      early,
      duringScopedRead,
      reads,
      entryRetained: !!captured.entries.snapshot().state?.page,
      progressRetained: !!captured.progress.snapshot().occurrences,
    });
    expect(early).toEqual({ entries: false, progress: false });
    expect(duringScopedRead).toBe(false);
    expect(reads).toContain('preview');
    expect(reads).toContain('progress');
    expect(captured.entries.snapshot().state?.page?.rows[0]?.ordinal).toBe(0);
    expect(captured.progress.snapshot().occurrences?.occurrences[0]?.ordinal).toBe(3);
    const writes = requests.filter(({ method }) => method === 'POST');
    expect(writes).toHaveLength(2);
    expect(
      writes.every(
        ({ bytes, key, authorization }) =>
          bytes === ' {"manifest":{},"records":[]} ' && !!key && authorization === 'Bearer original',
      ),
    ).toBe(true);
    captured.entries.retire();
    captured.progress.dispose();
    const beforeEqualExposure = sections.get('progress')!;
    await act(async () => {
      const queryKey = viewerExposureQuery(viewer.observation).queryKey;
      client.setQueryData(queryKey, client.getQueryData(queryKey));
      expect(beforeEqualExposure.current()).toBe(false);
    });
    const entries = sections.get('entries')!;
    const progress = sections.get('progress')!;
    expect(entries.current()).toBe(true);
    expect(progress.current()).toBe(true);
    entries.retire();
    expect(entries.current()).toBe(false);
    expect(progress.current()).toBe(true);
    let retired = false;
    progress.onRetire(() => {
      retired = true;
    });
    const same = client.getQueryData(['session']);
    const updatedAt = client.getQueryState(['session'])!.dataUpdatedAt;
    await act(async () => {
      client.setQueryData(['session'], same, { updatedAt });
      expect(retired).toBe(true);
      expect(progress.current()).toBe(false);
    });
    holdCompletedArchive(
      'A',
      { filename: 'archive.json', mediaType: 'application/json', bytes: new Uint8Array([1, 2]) },
      { exportId: 'installed', capturedAt: '2026-11-07T00:00:00Z', version: 4 },
    );
    const held = completedArchiveFor('A')!;
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
      expect(completedArchiveFor('A')).toBeNull();
      expect([...held.bytes]).toEqual([0, 0]);
      client.setQueryData(['session'], session('A'));
      expect(completedArchiveFor('A')).toBeNull();
    });
    expect(progress.current()).toBe(false);
  } finally {
    for (const retire of retireControllers) retire();
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
