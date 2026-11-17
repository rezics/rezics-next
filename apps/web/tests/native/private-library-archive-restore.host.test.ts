import { expect } from 'bun:test';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Locator, Page, Request, Response } from 'playwright';
import { subjectGenerations } from '../../../../services/kernel/src/search/indices.ts';
import { createOpenSearch } from '../../../../services/kernel/src/search/opensearch.ts';
import { SESSION_COOKIE } from '../../src/session/cookies.ts';
import { prepareNativeAuthMessages, startAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
import { prepareNativeWebSearch } from './search-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';
import { readSubjectPublicationFrontier } from './subject-publication-observation.ts';
import { archiveProgressOperation } from './archive-progress-observation.ts';
import { archiveLabelServerReply, type ArchiveLabelIdentity } from './archive-label-observation.ts';

let stack: NativeWebStack;
let archiveSubject: Awaited<ReturnType<typeof prepareArchiveSubject>>;
const lifecycle = new NativeTestLifecycle('native private Library export restore walk');
const entryOnly = process.env.WEB_ARCHIVE_ENTRY_FOCUSED === '1';
const evidence = resolve(
  import.meta.dir,
  entryOnly
    ? '../../../../.temp/private-library-archive-entry-focused'
    : '../../../../.temp/private-library-archive-restore',
);
const provenance = resolve(evidence, 'provenance.json');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const messagesRoot = resolve(import.meta.dir, '../../messages');
const repositoryRoot = resolve(import.meta.dir, '../../../..');

// The check runner separately binds and verifies the source manifest of a Git-free transfer.
function gitHead(): string | null {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

async function writeArchiveProvenance(result: object, path = provenance) {
  const pending = `${path}.pending`;
  await writeFile(pending, JSON.stringify({ sourceRevision: gitHead(), ...result }, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, path);
}

nativeBeforeAll(lifecycle, 600_000, async (signal) => {
  const setupDeadline = Date.now() + 600_000;
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'starting-native-stack' });
  await writeArchiveProvenance(
    { outcome: 'unreached', phase: 'before-progress' },
    resolve(evidence, 'progress-boundary.json'),
  );
  await prepareNativeAuthMessages();
  await prepareNativeWebSearch('library-archive');
  stack = await startNativeWebStack({
    observeBookSearchPreparation: !entryOnly,
    observeArchiveEntry: true,
    observeArchiveProgress: true,
    observePersonalAccess: true,
  });
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'preparing-archive-subject' });
  archiveSubject = await prepareArchiveSubject(stack);
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'waiting-for-subject-publication' });
  const generation = await waitForSubjectPublication(stack, signal, setupDeadline);
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'preparing-owner-library', generation });
});

nativeAfterAll(lifecycle, 180_000);

function key() {
  return `"${crypto.randomUUID()}"`;
}

async function json<T>(response: Response, status: number, label: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${label}: ${text}`).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

async function hydrated(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function visitLocalizedArchive(
  page: Page,
  locale: (typeof locales)[number],
  route: 'export' | 'recover-collections' | 'recover-archive',
  titleKey: string,
) {
  const target = new URL(`/${locale}/library/${route}`, stack.web);
  const issuer = new URL(stack.issuerOrigin).origin;
  const classifyPath = (href: string) => {
    const { origin, pathname } = new URL(href);
    if (origin !== target.origin) return origin === issuer ? 'issuer' : 'outside-web';
    if (pathname === target.pathname) return 'expected';
    if (locales.some((value) => pathname === `/${value}/library/${route}`)) return 'other-locale';
    if (pathname.startsWith('/auth/')) return 'web-auth';
    return 'other-web';
  };
  const browserErrors = new Set<string>();
  const recordError = (kind: string) => {
    if (browserErrors.size < 8) browserErrors.add(kind);
  };
  const documents: { status: number; path: string }[] = [];
  const observeResponse = (response: Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
      if (documents.length === 4) documents.shift();
      documents.push({ status: response.status(), path: classifyPath(response.url()) });
    } else if (request.resourceType() === 'script' && response.status() >= 400) {
      recordError(`script-http-${response.status()}`);
    }
  };
  const observeRequestFailure = (request: Request) => {
    const resource = request.resourceType();
    if (resource !== 'document' && resource !== 'script') return;
    const reason = request.failure()?.errorText ?? '';
    recordError(`${resource}-${/^net::ERR_[A-Z0-9_]{1,40}$/u.test(reason) ? reason : 'request-failed'}`);
  };
  const observePageError = ({ name, message }: Error) => {
    if (/dynamically imported module|module script failed/u.test(message)) recordError('module-load');
    else if (/hydrat(?:e|ion)/iu.test(message)) recordError('hydration');
    else recordError(['TypeError', 'SyntaxError', 'ReferenceError', 'RangeError'].includes(name) ? name : 'page-error');
  };
  page.on('response', observeResponse);
  page.on('requestfailed', observeRequestFailure);
  page.on('pageerror', observePageError);
  let stage = 'navigation';
  try {
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    stage = 'hydration';
    await hydrated(page);
    stage = 'localized-heading';
    const expected = await message(locale, titleKey);
    await page.getByRole('heading', { name: expected }).waitFor({ state: 'visible' });
    stage = 'ready';
    return expected;
  } finally {
    const [shell, sessionCookie] = await Promise.all([
      settledWithin(
        page.evaluate(
          (requestedLocale) => ({
            webShell: !!document.querySelector('[data-client-load-recovery]'),
            hydrated: document.documentElement.hasAttribute('data-hydrated'),
            clientLoadFailed: document.documentElement.hasAttribute('data-client-load-failed'),
            localeMatches: document.documentElement.lang === requestedLocale,
            accountMenu: !!document.querySelector('#account-menu-button'),
            sessionPending: !!document.querySelector('[data-session-pending]'),
            accountUnavailable: !!document.querySelector('[data-account-unavailable]'),
          }),
          locale,
        ),
        500,
      ).catch(() => undefined),
      settledWithin(
        page
          .context()
          .cookies(target.origin)
          .then((cookies) => cookies.some(({ name, httpOnly, value }) => name === SESSION_COOKIE && httpOnly && value)),
        500,
      ).catch(() => undefined),
    ]);
    page.off('response', observeResponse);
    page.off('requestfailed', observeRequestFailure);
    page.off('pageerror', observePageError);
    console.info(
      'Native Library Archive localized visit',
      JSON.stringify({
        actor: 'alice',
        locale,
        route,
        stage,
        documents,
        currentPath: classifyPath(page.url()),
        sessionCookie: sessionCookie ?? null,
        shell: shell ?? null,
        browserErrors: [...browserErrors],
      }),
    );
  }
}

async function leaveRecoveryFor(page: Page, name: string, departure: 'accept' | 'stay' | 'settled' = 'accept') {
  const destinations = page.getByRole('navigation', {
    name: await message('en', 'library_archive_destinations'),
    exact: true,
  });
  const destination = destinations.getByRole('link', { name, exact: true });
  const current = page.url();
  if (departure === 'settled') {
    await destination.click();
  } else {
    await Promise.all([
      page.waitForEvent('dialog').then(async (dialog) => {
        expect(dialog.type()).toBe('beforeunload');
        if (departure === 'stay') await dialog.dismiss();
        else await dialog.accept();
      }),
      destination.click(),
    ]);
  }
  if (departure === 'stay') expect(page.url()).toBe(current);
  else await hydrated(page);
}

async function waitForSubjectPublication(stack: NativeWebStack, signal: AbortSignal, setupDeadline: number) {
  const url = process.env.OPENSEARCH_URL;
  const prefix = stack.searchWorker?.prefix;
  if (!url || !prefix) throw new Error('Native Library Archive Search setup has no owned Subject worker');
  const search = createOpenSearch(url, { timeoutMs: 1_500 });
  console.info('Native Library Archive setup: waiting for ordinary Subject publication');
  let observed = false;
  for (;;) {
    signal.throwIfAborted();
    const { active } = await subjectGenerations(search, prefix, undefined, signal);
    if (active !== null) {
      console.info('Native Library Archive setup: ordinary Subject publication ready', { generation: active });
      return active;
    }
    if (!observed && Date.now() >= setupDeadline - 5_000) {
      observed = true;
      const frontier = await readSubjectPublicationFrontier(stack, setupDeadline - 2_000).catch(() => undefined);
      console.info('Native Library Archive setup: Subject publication frontier', frontier ?? null);
      await writeArchiveProvenance({
        outcome: 'incomplete',
        phase: 'waiting-for-subject-publication',
        frontier: frontier ?? null,
      });
    }
    await Bun.sleep(1_000);
  }
}

async function waitForSuggestion(stack: NativeWebStack, id: string, label: string) {
  const until = Date.now() + 60_000;
  const query = `/v1/subjects:suggest?q=${encodeURIComponent(label)}&limit=10&languages=en`;
  let lastStatus: number | undefined;
  let lastCount: number | undefined;
  let lastProblem: string | undefined;
  while (Date.now() < until) {
    const response = await stack.kernel(query);
    lastStatus = response.status;
    lastProblem = undefined;
    lastCount = undefined;
    if (response.status === 200) {
      const body = (await response.json()) as { subjects?: { id: string }[] };
      if (body.subjects?.some((item) => item.id === id)) return;
      lastCount = body.subjects?.length;
    } else {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      if (typeof body?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code)) lastProblem = body.code;
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Native suggestions did not include ${id} for ${label}; last HTTP=${lastStatus ?? 'none'}, count=${lastCount ?? 'unavailable'}, problem=${lastProblem ?? 'none'}`,
  );
}

async function message(locale: (typeof locales)[number], key: string) {
  const body = (await Bun.file(resolve(messagesRoot, `${locale}.json`)).json()) as Record<string, string>;
  return body[key]!;
}

async function openGates(stack: NativeWebStack) {
  for (const group of ['personal_library', 'collections', 'reading_progress', 'search'] as const) {
    const opened = await stack.kernel(
      `/v1/platform/exposure/${group}:open`,
      { method: 'POST', headers: { 'idempotency-key': key() } },
      'governor',
    );
    expect(opened.status, await opened.clone().text()).toBe(200);
  }
}

async function prepareArchiveSubject(stack: NativeWebStack) {
  await openGates(stack);
  const marker = crypto.randomUUID().slice(0, 8);
  const title = `Native archive work ${marker}`;
  const collectionTitle = `Portable archive ${marker}`;
  const createdSubject = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key() },
      body: JSON.stringify({ type: 'schema:Book', labels: { en: title } }),
    },
    'editor',
  );
  const { subject } = await json<{ subject: { id: string } }>(createdSubject, 201, 'create subject');
  return { subject, title, collectionTitle, marker };
}

async function prepareOwnerLibrary(stack: NativeWebStack) {
  const { subject, title, collectionTitle, marker } = archiveSubject;
  const alice = await stack.authPersona('alice');
  const active = await json<{ digest: string }>(await stack.kernel('/v1/definitions/active'), 200, 'active definition');
  const released = await json<{
    release: {
      types: Record<string, { library?: { profileId?: string } }>;
      libraryProfiles: Record<string, { entryStateSet?: { states: { id: string; role: string }[] } }>;
    };
  }>(await stack.kernel(`/v1/definitions/releases/${encodeURIComponent(active.digest)}`), 200, 'release');
  const profileId = released.release.types['schema:Book']?.library?.profileId;
  const activeState = released.release.libraryProfiles[profileId!]?.entryStateSet?.states.find(
    (state) => state.role === 'active',
  );
  const entry = await stack.kernel(
    `/v1/libraryEntries/${subject.id}`,
    {
      method: 'PUT',
      headers: {
        authorization: alice.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({ state: activeState!.id }),
    },
    'alice',
  );
  expect(entry.status, await entry.clone().text()).toBe(201);
  const collection = await json<{ collection: { id: string } }>(
    await stack.kernel(
      '/v1/collections',
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ title: collectionTitle, visibility: 'private' }),
      },
      'alice',
    ),
    201,
    'create collection',
  );
  const first = await json<{ member: { id: string } }>(
    await stack.kernel(
      `/v1/collections/${collection.collection.id}/members`,
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ subjectId: subject.id }),
      },
      'alice',
    ),
    201,
    'first member',
  );
  const second = await json<{ member: { id: string } }>(
    await stack.kernel(
      `/v1/collections/${collection.collection.id}/members`,
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ subjectId: subject.id }),
      },
      'alice',
    ),
    201,
    'repeated member',
  );
  await json<unknown>(
    await stack.kernel(
      `/v1/collections/${collection.collection.id}/members/${first.member.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ note: 'First archived note' }),
      },
      'alice',
    ),
    200,
    'first note',
  );
  await json<unknown>(
    await stack.kernel(
      `/v1/collections/${collection.collection.id}/members/${second.member.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ note: 'Repeated occurrence' }),
      },
      'alice',
    ),
    200,
    'second note',
  );
  await json<unknown>(
    await stack.kernel(
      `/v1/collections/${collection.collection.id}/members/${second.member.id}:move`,
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ after: null }),
      },
      'alice',
    ),
    200,
    'member order',
  );
  const labelName = `Archive label ${marker}`;
  const label = await json<{ label: { id: string } }>(
    await stack.kernel(
      '/v1/libraryLabels',
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ name: labelName }),
      },
      'alice',
    ),
    201,
    'create label',
  );
  await json<unknown>(
    await stack.kernel(
      `/v1/libraryLabels/${label.label.id}:assign`,
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ subjectId: subject.id }),
      },
      'alice',
    ),
    200,
    'assign label',
  );
  const session = await json<{ progressSession: { id: string } }>(
    await stack.kernel(
      '/v1/progressSessions',
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ subjectId: subject.id, mode: 'scalar_amount', unit: 'page', total: '12' }),
      },
      'alice',
    ),
    201,
    'create progress',
  );
  await waitForSuggestion(stack, subject.id, title);
  return {
    alice,
    subjectId: subject.id,
    title,
    collectionId: collection.collection.id,
    collectionTitle,
    labelId: label.label.id,
    labelName,
    sessionId: session.progressSession.id,
    stateId: activeState!.id,
  };
}

async function readOwnerLabelPage(prefix: string) {
  const query = new URLSearchParams({ q: prefix, limit: '3' });
  return json<{ labels: { id: string; name: string; revision: number }[]; next: string | null }>(
    await stack.kernel(`/v1/libraryLabels?${query}`, undefined, 'alice'),
    200,
    'owner label readback',
  );
}

async function downloadArchive(page: Page) {
  await page.getByRole('button', { name: 'Create this export', exact: true }).click();
  await page.locator('[data-export-stage="ready"]').waitFor({ state: 'visible', timeout: 120_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download JSON', exact: true }).click(),
  ]);
  const archivePath = resolve(evidence, download.suggestedFilename() || 'library-export.json');
  await download.saveAs(archivePath);
  return archivePath;
}

function archiveBoundaryRequests(prefix: string) {
  return stack
    .kernelRequests()
    .filter(({ fixtureRequest, url }) => !fixtureRequest && (url === prefix || url.startsWith(`${prefix}/`)))
    .slice(-8)
    .map(({ url, method, responseStatus, failure }) => {
      const path = url.split('?')[0];
      let problem: { code?: unknown } | null = null;
      try {
        if (failure?.body) problem = JSON.parse(failure.body);
      } catch {
        // Transport errors can have a non-JSON response.
      }
      const code = problem?.code;
      const tail = path?.split('/').at(-1);
      return {
        operation:
          path === prefix
            ? 'upload'
            : tail === 'collections' || tail === 'preview' || tail === 'progress'
              ? tail
              : 'status',
        method,
        status: responseStatus ?? null,
        ...(typeof code === 'string' && /^[a-z0-9_]{1,64}$/u.test(code) ? { code } : {}),
      };
    });
}

async function recordCollectionPreviewFailure(page: Page, responses: readonly number[]) {
  const [notices] = await Promise.allSettled([
    page.locator('main [role="status"], main [role="alert"]').allTextContents(),
    stack.syncKernelRequests(),
  ]);
  const observation = {
    path: new URL(page.url()).pathname,
    responses,
    native: archiveBoundaryRequests('/v1/libraryArchiveCollectionRecoveries'),
    notices:
      notices.status === 'fulfilled'
        ? notices.value
            .map((text) => text.trim())
            .filter(Boolean)
            .slice(0, 6)
            .map((text) => text.slice(0, 180))
        : [],
  };
  console.info('Native Library Archive Collection preview boundary', observation);
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'waiting-for-collection-preview', observation });
}

function observeArchiveServerPosts(page: Page, responses: number[], inspect?: (response: Response) => void) {
  const origin = new URL(page.url()).origin;
  const observe = (response: Response) => {
    const url = new URL(response.url());
    if (
      responses.length < 8 &&
      url.origin === origin &&
      url.pathname.startsWith('/_serverFn/') &&
      response.request().method() === 'POST'
    ) {
      responses.push(response.status());
      inspect?.(response);
    }
  };
  page.on('response', observe);
  return () => page.off('response', observe);
}

function observeArchiveLabelServerReplies(page: Page) {
  const replies: NonNullable<ArchiveLabelIdentity>[] = [];
  const pending = new Set<Promise<void>>();
  let unreadable = 0;
  let seen = 0;
  const origin = new URL(page.url()).origin;
  const observe = (response: Response) => {
    const url = new URL(response.url());
    if (
      seen >= 8 ||
      url.origin !== origin ||
      !url.pathname.startsWith('/_serverFn/') ||
      response.request().method() !== 'POST'
    )
      return;
    seen++;
    const task = (async () => {
      try {
        const identity = await archiveLabelServerReply(await response.json());
        if (identity && replies.length < 8) replies.push(identity);
      } catch {
        unreadable++;
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on('response', observe);
  return async () => {
    page.off('response', observe);
    const drained = await settledWithin(
      Promise.allSettled(pending).then(() => true),
      2_000,
    );
    return { replies, unreadable, drained: drained === true };
  };
}

type EntryOrdinals = Readonly<{ entries: number; labels: number }>;

function entryUploadObservation(page: Page, ordinals: EntryOrdinals, forms: readonly Locator[]) {
  const posts: { status: number; serialized: boolean; privateNoStore: boolean; format: string }[] = [];
  const pageErrors = new Set<string>();
  const observeError = ({ message }: Error) => {
    const known = [
      'Archive viewer changed',
      'Archive sender changed',
      'Invalid archive command',
      'invalid_private_value',
      'retired_visit',
    ];
    pageErrors.add(known.find((value) => message === value) ?? 'other');
  };
  page.on('pageerror', observeError);
  return {
    inspect(response: Response) {
      const headers = response.headers();
      const contentType = headers['content-type']?.split(';')[0];
      posts.push({
        status: response.status(),
        serialized: headers['x-tss-serialized'] === 'true',
        privateNoStore: headers['cache-control'] === 'private, no-store',
        format:
          contentType === 'application/json' ? 'json' : contentType === 'application/x-tss-framed' ? 'framed' : 'other',
      });
    },
    async record(stage: string, matched: boolean) {
      const [native, ui] = await Promise.all([
        settledWithin(stack.syncKernelRequests(), 2_000)
          .then(() =>
            stack
              .kernelRequests()
              .flatMap(({ fixtureRequest, responseStatus, archiveEntry }) => {
                if (fixtureRequest || !archiveEntry) return [];
                const { result, ...metadata } = archiveEntry;
                const window = result?.window ?? null;
                return [
                  {
                    ...metadata,
                    status: responseStatus ?? null,
                    state: result?.state ?? null,
                    expiry: result?.expiry ?? null,
                    coverage: result?.coverage ?? null,
                    window: window && {
                      rows: window.rows,
                      hasNext: window.hasNext,
                      entries:
                        window.matches.find(
                          ({ section, ordinal }) => section === 'entries' && ordinal === ordinals.entries,
                        )?.status ?? null,
                      labels:
                        window.matches.find(
                          ({ section, ordinal }) => section === 'labels' && ordinal === ordinals.labels,
                        )?.status ?? null,
                    },
                  },
                ];
              })
              .slice(-8),
          )
          .catch(() => null),
        settledWithin(
          (async () => {
            const notices = [
              'library_archive_entry_preparing',
              'library_archive_entry_working',
              'library_archive_present_refused',
              'library_archive_recovery_uncertain',
              'library_archive_entry_expired',
              'library_archive_unavailable',
            ] as const;
            const [select, retry, ...noticeText] = await Promise.all([
              message('en', 'library_archive_entry_select'),
              message('en', 'library_window_retry'),
              ...notices.map((key) => message('en', key)),
            ]);
            const visible = {
              preview: page.locator('#archive-rows'),
              inventory: page.locator('#archive-inventory'),
              entryForm: forms[0]!,
              labelForm: forms[1]!,
              retry: page.getByRole('button', { name: retry, exact: true }),
              entrySelect: entrySelectButton(page, select!, ordinals.entries),
              labelSelect: entrySelectButton(page, select!, ordinals.labels),
            };
            const [controls, statuses] = await Promise.all([
              Promise.all(Object.entries(visible).map(async ([name, locator]) => [name, await locator.isVisible()])),
              Promise.all(
                noticeText.map(async (text) => page.getByRole('status').filter({ hasText: text }).first().isVisible()),
              ),
            ]);
            return { visible: Object.fromEntries(controls), notices: notices.filter((_, index) => statuses[index]) };
          })(),
          2_000,
        ).catch(() => undefined),
      ]);
      const observation = { stage, matched, posts, native, ui: ui ?? null, pageErrors: [...pageErrors] };
      console.info('Native Library Archive Entry upload boundary', observation);
      await writeArchiveProvenance(observation, resolve(evidence, 'entry-boundary.json'));
      if (!matched) await writeArchiveProvenance({ outcome: 'incomplete', phase: 'entry-upload', observation });
      return observation;
    },
    stop: () => page.off('pageerror', observeError),
  };
}

async function startCollectionPreview(page: Page, archivePath?: string) {
  const responses: number[] = [];
  const stopObserving = observeArchiveServerPosts(page, responses);
  try {
    if (archivePath === undefined) {
      await page.getByRole('button', { name: 'Use the original archive', exact: true }).click();
    } else {
      await page.getByLabel('Completed Library export file').setInputFiles(archivePath);
      await page.getByRole('button', { name: 'Upload and preview', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Review this Collection', exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });
  } catch (error) {
    await recordCollectionPreviewFailure(page, responses).catch(() => undefined);
    throw error;
  } finally {
    stopObserving();
  }
}

function progressUploadObservation(page: Page, ordinal: number, mapOccurrence: Locator) {
  const posts: { status: number; serialized: boolean; privateNoStore: boolean; json: boolean }[] = [];
  const pageErrors = new Set<string>();
  const observeError = (error: Error) => {
    const known = ['Archive viewer changed', 'Archive sender changed', 'Invalid archive command'];
    if (pageErrors.size < 8)
      pageErrors.add(
        known.includes(error.message) ? error.message : error.name === 'SyntaxError' ? 'invalid-json' : 'other',
      );
  };
  page.on('pageerror', observeError);
  return {
    inspect(response: Response) {
      const headers = response.headers();
      posts.push({
        status: response.status(),
        serialized: headers['x-tss-serialized'] === 'true',
        privateNoStore: headers['cache-control'] === 'private, no-store',
        json: headers['content-type']?.split(';')[0] === 'application/json',
      });
    },
    async record(stage: string, matched: boolean) {
      const synchronized = await settledWithin(
        stack.syncKernelRequests().then(() => true),
        2_000,
      ).catch(() => false);
      const native = stack
        .kernelRequests()
        .flatMap(({ fixtureRequest, url, method, responseStatus, archiveProgress }) => {
          const operation = archiveProgressOperation(method, url.split('?')[0]!);
          if (fixtureRequest || operation === null) return [];
          const { ordinals, ...result } = archiveProgress?.result ?? {};
          return [
            {
              operation,
              method,
              status: responseStatus ?? null,
              response: archiveProgress
                ? {
                    ...archiveProgress,
                    result: archiveProgress.result && {
                      ...result,
                      matchingOrdinal: ordinals?.includes(ordinal) ?? null,
                    },
                  }
                : null,
            },
          ];
        })
        .slice(-8);
      const ui = await settledWithin(
        (async () => {
          const noticeKeys = [
            'preparing',
            'ready',
            'uncertain',
            'recoverable',
            'refused',
            'expired',
            'oversize',
            'cancelled',
            'removed',
          ] as const;
          const notices = await Promise.all(
            noticeKeys.map(async (name) =>
              (await page
                .getByRole('status')
                .filter({ hasText: await message('en', `library_archive_progress_${name}`) })
                .first()
                .isVisible())
                ? name
                : null,
            ),
          );
          const controls = {
            chooser: page.getByLabel(await message('en', 'library_archive_progress_file'), { exact: true }),
            occurrences: page.getByRole('region', {
              name: await message('en', 'library_archive_progress_occurrences'),
              exact: true,
            }),
            coverage: page.getByRole('region', {
              name: await message('en', 'library_archive_recovery_coverage_title'),
              exact: true,
            }),
            inspect: page.getByRole('button', {
              name: await message('en', 'library_archive_progress_inspect'),
              exact: true,
            }),
            retry: page.getByRole('button', {
              name: await message('en', 'library_archive_progress_retry'),
              exact: true,
            }),
            mapOccurrence,
          };
          const visible = await Promise.all(
            Object.entries(controls).map(async ([name, locator]) => {
              const count = await locator.count();
              return [
                name,
                {
                  count,
                  visible: await locator.first().isVisible(),
                  enabled: count === 1 ? await locator.isEnabled() : null,
                },
              ];
            }),
          );
          return {
            controls: Object.fromEntries(visible),
            notices: notices.filter(Boolean),
            unavailable: await page
              .getByRole('status')
              .filter({ hasText: await message('en', 'library_archive_unavailable') })
              .first()
              .isVisible(),
            empty: await page
              .getByText(await message('en', 'library_archive_progress_empty'), { exact: true })
              .isVisible(),
          };
        })(),
        2_000,
      ).catch(() => undefined);
      const observation = {
        recovery: 'progress',
        stage,
        matched,
        posts,
        readerSynchronized: synchronized === true,
        native,
        ui: ui ?? null,
        pageErrors: [...pageErrors],
      };
      console.info('Native Library Archive Progress upload boundary', observation);
      await writeArchiveProvenance(observation, resolve(evidence, 'progress-boundary.json'));
      if (!matched)
        await writeArchiveProvenance({ outcome: 'incomplete', phase: 'uploading-recovery-archive', observation });
    },
    stop: () => page.off('pageerror', observeError),
  };
}

async function uploadRecoveryArchive(
  page: Page,
  archivePath: string,
  recovery: 'entry' | 'progress',
  chooser: Locator,
  records: readonly Locator[],
  entryOrdinals?: EntryOrdinals,
  progressOrdinal?: number,
) {
  const responses: number[] = [];
  const entry = entryOrdinals ? entryUploadObservation(page, entryOrdinals, records) : undefined;
  const progress =
    progressOrdinal === undefined ? undefined : progressUploadObservation(page, progressOrdinal, records[0]!);
  const stopObserving = observeArchiveServerPosts(page, responses, entry?.inspect ?? progress?.inspect);
  const deadline = performance.now() + 60_000;
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const enabledChooser = chooser.and(page.locator('input[type="file"]:enabled:visible'));
  let stage = 'enabled-chooser';
  let matched = false;
  let observation: Awaited<ReturnType<NonNullable<typeof entry>['record']>> | undefined;
  try {
    // setInputFiles can target a disabled input before the private recovery controller connects.
    await enabledChooser.waitFor({ state: 'visible', timeout: remaining() });
    stage = 'select-file';
    await enabledChooser.setInputFiles(archivePath, { timeout: remaining() });
    stage = 'matching-records';
    await Promise.all(records.map((record) => record.waitFor({ state: 'visible', timeout: remaining() })));
    matched = true;
  } catch (error) {
    if (entry || progress) throw error;
    await settledWithin(stack.syncKernelRequests(), 2_000).catch(() => undefined);
    const observation = {
      recovery,
      stage,
      server: { method: 'POST', statuses: responses },
      native: archiveBoundaryRequests(recovery === 'entry' ? '/v1/libraryArchiveMerges' : '/v1/libraryCopyArchives'),
    };
    console.info('Native Library Archive upload boundary', observation);
    await writeArchiveProvenance({ outcome: 'incomplete', phase: 'uploading-recovery-archive', observation }).catch(
      () => undefined,
    );
    throw error;
  } finally {
    stopObserving();
    if (entry) {
      entry.stop();
      observation = await entry.record(stage, matched).catch(() => undefined);
    }
    if (progress) {
      progress.stop();
      await progress.record(stage, matched).catch(() => undefined);
    }
  }
  if (entryOnly && entry) {
    expect(observation?.native).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'upload', status: 200, state: 'ready' }),
        expect.objectContaining({
          operation: 'preview',
          status: 200,
          firstPage: true,
          state: 'ready',
          window: expect.objectContaining({ entries: 'unresolved', labels: 'unresolved' }),
        }),
      ]),
    );
  }
}

function entrySelectButton(page: Page, pattern: string, ordinal: number) {
  return page.getByRole('button', { name: pattern.replace('{ordinal}', String(ordinal)), exact: true });
}

async function leaveExportFor(page: Page, name: string, path: string) {
  const destination = page
    .getByRole('navigation', { name: await message('en', 'library_archive_destinations'), exact: true })
    .getByRole('link', { name, exact: true });
  const restoreHref = await destination.getAttribute('href');
  expect(restoreHref).toBeTruthy();
  const restoreUrl = new URL(restoreHref!, page.url());
  expect(restoreUrl.origin).toBe(new URL(page.url()).origin);
  expect(restoreUrl.pathname.replace(/^\/en(?=\/)/u, '')).toBe(path);
  await destination.click();
  const leaveExport = page.getByRole('alertdialog', {
    name: await message('en', 'library_export_leave_title'),
    exact: true,
  });
  await leaveExport.getByRole('button', { name: await message('en', 'library_export_leave'), exact: true }).click();
  await hydrated(page);
}

async function restoreCollection(
  page: Page,
  archivePath: string,
  prepared: Awaited<ReturnType<typeof prepareOwnerLibrary>>,
) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await leaveExportFor(page, await message('en', 'library_export_restore_collections'), '/library/recover-collections');
  await page.getByRole('heading', { name: 'Recover a curated Collection' }).waitFor({
    state: 'visible',
  });
  const entryDestination = await message('en', 'library_archive_title');
  await startCollectionPreview(page, archivePath);
  await leaveRecoveryFor(page, entryDestination, 'stay');
  await page.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await page.getByRole('button', { name: 'Stop new recovery steps', exact: true }).click();
  await page.locator('[data-recovery-state="cancelled"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: 'Start another recovery', exact: true }).click();
  await startCollectionPreview(page);
  await page.getByRole('button', { name: 'Review this Collection', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle selection for this page', exact: true }).click();
  await page.getByRole('button', { name: 'Review selection', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Edition', exact: true });
  await picker.fill(prepared.title);
  await page.getByRole('option', { name: prepared.title }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('option', { name: prepared.title }).click();
  await page.getByRole('button', { name: 'Review this exact selection', exact: true }).click();
  await page
    .getByText('I reviewed the selected occurrences and understand that this creates a new private Collection.')
    .waitFor({ state: 'visible' });
  await page
    .getByRole('checkbox', {
      name: 'I reviewed the selected occurrences and understand that this creates a new private Collection.',
    })
    .check();
  await page.getByRole('button', { name: 'Apply this review', exact: true }).click();
  await page.getByRole('button', { name: 'Read the current Collection', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Read the current Collection', exact: true }).click();
  const receiving = page.locator('[data-receiving-collection]');
  const restored = receiving.and(page.locator('[aria-busy="false"]:not([data-receiving-collection=""])'));
  try {
    await restored.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const notices = await receiving
      .getByRole('status')
      .allTextContents()
      .catch(() => []);
    const observation = { notices };
    console.info('Native Library Archive Collection readback boundary', observation);
    await writeArchiveProvenance({
      outcome: 'incomplete',
      phase: 'waiting-for-collection-readback',
      observation,
    }).catch(() => undefined);
    throw error;
  }
  const restoredId = await restored.getAttribute('data-receiving-collection');
  expect(restoredId).toBeTruthy();
  expect(restoredId).not.toBe(prepared.collectionId);
  const restoredText = await restored.innerText();
  expect(restoredText).toContain(await message('en', 'library_visibility_private'));
  expect(restoredText).toContain('First archived note');
  expect(restoredText).toContain('Repeated occurrence');
  const nativeCollection = await json<{
    collection: { id: string; title: string; visibility: string; memberCount: number };
  }>(await stack.kernel(`/v1/collections/${restoredId}`, undefined, 'alice'), 200, 'owner collection readback');
  expect(nativeCollection.collection).toMatchObject({
    id: restoredId,
    title: prepared.collectionTitle,
    visibility: 'private',
    memberCount: 2,
  });
  const members = await json<{ members: { note: string | null; subjectId: string }[] }>(
    await stack.kernel(
      `/v1/collections/${restoredId}/members?view=FULL&limit=100`,
      { headers: { 'accept-language': 'en' } },
      'alice',
    ),
    200,
    'owner members readback',
  );
  expect(members.members.map((row) => row.note)).toEqual(['Repeated occurrence', 'First archived note']);
  expect(members.members.every((row) => row.subjectId === prepared.subjectId)).toBe(true);
  const bobDenied = await stack.kernel(`/v1/collections/${restoredId}`, undefined, 'bob');
  expect([403, 404]).toContain(bobDenied.status);

  return { restoredId, nativeCollection, members, bobDenied };
}

async function restoreOwnerLibrary() {
  const prepared = await prepareOwnerLibrary(stack);
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'restoring-library' });
  const auth = await startAuthStack(stack, { preparedMessages: true, useHeadlessShell: true });
  const signedIn = await auth.signIn('alice', { returnTo: '/en/library/export' });
  const page = signedIn.continueOnPage();
  await auth.settlePageApp();
  expect(auth.pageAppProcess(), 'Auth UI retired before the owner Archive journey').toBeUndefined();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${stack.web}/en/library/export`, { waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: 'Export your Library' }).waitFor({ state: 'visible' });
  const archivePath = await downloadArchive(page);
  const artifact = JSON.parse(await readFile(archivePath, 'utf8')) as {
    manifest: { version: number; coverage?: string; rows: number; sections: string[] };
    records: {
      section: string;
      subject_id?: string;
      label_id?: string;
      normalized_name?: string;
      session_id?: string;
    }[];
  };
  const entryOrdinal = artifact.records.findIndex(
    (row) => row.section === 'entries' && row.subject_id === prepared.subjectId,
  );
  const labelOrdinal = artifact.records.findIndex(
    (row) => row.section === 'labels' && row.label_id === prepared.labelId,
  );
  const sessionOrdinal = artifact.records.findIndex(
    (row) => row.section === 'sessions' && row.session_id === prepared.sessionId,
  );
  expect(artifact.manifest.version).toBe(1);
  expect(artifact.manifest.coverage).toBe('private-library-owner-facts-v1');
  expect(entryOrdinal).toBeGreaterThanOrEqual(0);
  expect(artifact.records.some((row) => row.section === 'collections')).toBe(true);
  expect(artifact.records.some((row) => row.section === 'occurrences')).toBe(true);
  expect(labelOrdinal).toBeGreaterThanOrEqual(0);
  expect(artifact.records[labelOrdinal]?.normalized_name).toBe(prepared.labelName);
  expect(sessionOrdinal).toBeGreaterThanOrEqual(0);
  expect(new TextDecoder().decode(await readFile(archivePath))).toContain('"version":1');

  const collection = entryOnly ? null : await restoreCollection(page, archivePath, prepared);

  // Free the downloaded name while keeping the source label and its identity live.
  const {
    labels: [sourceLabel],
  } = await readOwnerLabelPage(prepared.labelName);
  expect(sourceLabel).toMatchObject({ id: prepared.labelId, name: prepared.labelName });
  const renamedLabelName = `${prepared.labelName} (source)`;
  const { label: renameReceipt } = await json<{ label: { id: string; revision: number } }>(
    await stack.kernel(
      `/v1/libraryLabels/${prepared.labelId}`,
      {
        method: 'PATCH',
        headers: {
          authorization: prepared.alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ name: renamedLabelName, revision: sourceLabel!.revision }),
      },
      'alice',
    ),
    200,
    'rename source label',
  );
  expect(renameReceipt).toEqual({ id: prepared.labelId, revision: sourceLabel!.revision + 1 });

  await page.setViewportSize({ width: 1440, height: 900 });
  const entryDestination = await message('en', 'library_archive_title');
  if (collection) {
    await page.locator('[data-recovery-state="complete"], [data-recovery-state="partial"]').waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    await leaveRecoveryFor(page, entryDestination, 'settled');
  } else {
    await leaveExportFor(page, await message('en', 'library_export_restore_entries'), '/library/recover-archive');
  }
  expect(new URL(page.url()).pathname).toBe('/en/library/recover-archive');
  await page.getByRole('heading', { name: 'Recover from a Library archive' }).waitFor({ state: 'visible' });
  const records = page.getByRole('region', { name: await message('en', 'library_archive_entry_records'), exact: true });
  const selectRecord = await message('en', 'library_archive_entry_select');
  const entrySelect = entrySelectButton(page, selectRecord, entryOrdinal);
  const labelSelect = entrySelectButton(page, selectRecord, labelOrdinal);
  const entryForm = records
    .getByRole('article')
    .filter({ hasText: await message('en', 'library_export_section_entries'), has: entrySelect });
  const labelForm = records
    .getByRole('article')
    .filter({ hasText: await message('en', 'library_export_section_labels'), has: labelSelect });
  await uploadRecoveryArchive(
    page,
    archivePath,
    'entry',
    page.getByLabel(await message('en', 'library_archive_choose_file'), { exact: true }),
    [entryForm, labelForm],
    { entries: entryOrdinal, labels: labelOrdinal },
  );
  await entryForm.getByLabel(await message('en', 'library_archive_entry_subject_id')).fill(prepared.subjectId);
  await entryForm.locator(entrySelect).click();
  await labelForm.getByRole('combobox', { name: await message('en', 'library_archive_entry_label_choice') }).click();
  await page
    .getByRole('option', { name: await message('en', 'library_archive_entry_create_label'), exact: true })
    .click();
  await labelForm.locator(labelSelect).click();
  const steps = page.getByRole('navigation', { name: await message('en', 'library_archive_steps'), exact: true });
  await steps
    .getByRole('button', { name: `3. ${await message('en', 'library_archive_review_step')}`, exact: true })
    .click();
  await page.getByRole('button', { name: await message('en', 'library_archive_entry_review'), exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: await message('en', 'library_archive_entry_confirm'),
      exact: true,
    })
    .check();
  const finishLabelReplies = observeArchiveLabelServerReplies(page);
  await page.getByRole('button', { name: await message('en', 'library_archive_entry_apply'), exact: true }).click();
  const results = page.getByRole('region', { name: await message('en', 'library_archive_results_step'), exact: true });
  const labelResult = results
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: prepared.labelName, exact: true }) });
  const readCurrent = labelResult.getByRole('button', {
    name: await message('en', 'library_archive_entry_read_current'),
    exact: true,
  });
  await readCurrent.waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await labelResult.getByText(await message('en', 'library_archive_entry_evidence'), { exact: true }).click();
  const labelEvidence = labelResult.locator('pre');
  const labelMapping = JSON.parse((await labelEvidence.textContent()) ?? 'null') as {
    ordinal?: unknown;
    section?: unknown;
    status?: unknown;
    labelId?: unknown;
  } | null;
  const visibleLabelMapping = JSON.parse(await labelEvidence.innerText()) as { labelId?: unknown } | null;
  expect(labelMapping?.ordinal).toBe(labelOrdinal);
  expect(labelMapping?.section).toBe('labels');
  expect(labelMapping?.status).toBe('acknowledged');
  const displayedResultLabelId = labelMapping?.labelId;
  expect(typeof displayedResultLabelId).toBe('string');
  await stack.syncKernelRequests();
  const applyRequest = stack
    .kernelRequests()
    .findLast(
      ({ fixtureRequest, method, url, responseStatus }) =>
        !fixtureRequest &&
        method === 'POST' &&
        responseStatus === 200 &&
        /^\/v1\/libraryArchiveMerges\/[0-9a-f-]{36}\/apply$/u.test(url),
    );
  if (!applyRequest) throw new Error('No successful native Archive apply was observed for the mounted visit');
  const resultPath = applyRequest.url.replace(/\/apply$/u, '/results?after=-1&limit=100');
  const { results: appliedRows } = await json<{
    results: {
      section: string;
      ordinal: number;
      status: string;
      result?: { effect?: string; labelId?: string };
    }[];
  }>(await stack.kernel(resultPath, { signal: AbortSignal.timeout(2_000) }, 'alice'), 200, 'owner Archive result');
  const applied = appliedRows.find((item) => item.section === 'labels' && item.ordinal === labelOrdinal);
  expect(applied?.status).toBe('acknowledged');
  expect(applied?.result?.effect).toBe('label.create');
  const restoredLabelId = applied?.result?.labelId;
  if (typeof restoredLabelId !== 'string' || restoredLabelId.length === 0) {
    throw new Error('The acknowledged native Archive result has no created label ID');
  }
  expect(restoredLabelId).not.toBe(prepared.labelId);

  await readCurrent.click();
  const currentLabel = results.locator('section').filter({
    has: page.getByRole('heading', { name: await message('en', 'library_archive_entry_current'), exact: true }),
  });
  await currentLabel.getByText(prepared.labelName, { exact: true }).waitFor({ state: 'visible' });
  await currentLabel.getByText(await message('en', 'library_archive_entry_evidence'), { exact: true }).click();
  const displayed = JSON.parse((await currentLabel.locator('pre').textContent()) ?? 'null') as {
    label?: { id?: unknown; name?: unknown; revision?: unknown };
  } | null;
  const { labels: currentLabels, next } = await readOwnerLabelPage(prepared.labelName);
  const pointResponse = await stack.kernel(
    `/v1/libraryLabelAssignments?${new URLSearchParams({ labelId: restoredLabelId, view: 'FULL', limit: '1' })}`,
    { signal: AbortSignal.timeout(2_000) },
    'alice',
  );
  const point = pointResponse.status === 200 ? ((await pointResponse.json()) as { label?: { id?: string } }) : null;
  const bff = await finishLabelReplies();
  const observed = stack.kernelRequests();
  const nativeCurrent = observed.findLast(
    ({ fixtureRequest, method, url }) =>
      !fixtureRequest && method === 'GET' && url.startsWith('/v1/libraryLabelAssignments?'),
  );
  const nativeResult = observed.findLast(
    ({ fixtureRequest, method, url }) => fixtureRequest && method === 'GET' && url === resultPath,
  );
  const nativePrefix = observed.findLast(
    ({ fixtureRequest, method, url }) =>
      fixtureRequest &&
      method === 'GET' &&
      url.startsWith('/v1/libraryLabels?') &&
      new URL(url, stack.kernelOrigin).searchParams.get('q') === prepared.labelName,
  );
  const currentRequestId = nativeCurrent
    ? new URL(nativeCurrent.url, stack.kernelOrigin).searchParams.get('labelId')
    : null;
  const nativeApplyId = applyRequest.archiveLabel?.labels.find((row) => row.ordinal === labelOrdinal)?.labelId;
  const nativeResultId = nativeResult?.archiveLabel?.labels.find((row) => row.ordinal === labelOrdinal)?.labelId;
  const bffApplied = bff.replies.findLast((row) => row.kind === 'applied');
  const bffApplyId = bffApplied?.labels.find((row) => row.ordinal === labelOrdinal)?.labelId;
  const bffCurrentId = bff.replies.findLast((row) => row.kind === 'label')?.labelId;
  const identity = {
    applyOwnerMatches: applyRequest.access?.authenticated
      ? applyRequest.access.actorId === prepared.alice.accountId
      : null,
    resultOwnerMatches: nativeResult?.access?.authenticated
      ? nativeResult.access.actorId === prepared.alice.accountId
      : null,
    currentOwnerMatches: nativeCurrent?.access?.authenticated
      ? nativeCurrent.access.actorId === prepared.alice.accountId
      : null,
    prefixOwnerMatches: nativePrefix?.access?.authenticated
      ? nativePrefix.access.actorId === prepared.alice.accountId
      : null,
    nativeApplyObserved: typeof nativeApplyId === 'string',
    nativeApplyMatchesResults: nativeApplyId === restoredLabelId,
    nativeResultObserved: typeof nativeResultId === 'string',
    resultTransportMatchesNative: nativeResultId === restoredLabelId,
    bffApplyObserved: typeof bffApplyId === 'string',
    bffApplyMatchesNativeVisit: !!bffApplied && bffApplied.uploadId === applyRequest.archiveLabel?.uploadId,
    bffApplyMatchesNativeApply: bffApplyId && nativeApplyId ? bffApplyId === nativeApplyId : null,
    displayedMatchesBffApply: displayedResultLabelId === bffApplyId,
    bffCurrentObserved: typeof bffCurrentId === 'string',
    bffCurrentMatchesDisplayed: bffCurrentId ? bffCurrentId === displayed?.label?.id : null,
    displayedCurrentMatchesApply: displayed?.label?.id === displayedResultLabelId,
    currentRequestMatchesApply: currentRequestId === displayedResultLabelId,
    nativeCurrentMatchesDisplayed: nativeCurrent?.archiveLabel?.labelId === displayed?.label?.id,
    prefixMatchesDisplayed: currentLabels.some((row) => row.id === displayed?.label?.id),
    nativePrefixMatchesResults: nativePrefix?.archiveLabel?.labelIds.includes(restoredLabelId) ?? null,
    nativePrefixObserved: nativePrefix?.archiveLabel?.kind === 'labels',
    prefixTransportMatchesNative:
      JSON.stringify(currentLabels.map((row) => row.id)) === JSON.stringify(nativePrefix?.archiveLabel?.labelIds),
    pointStatus: pointResponse.status,
    pointMatchesResults: point?.label?.id === restoredLabelId,
    bffRepliesDrained: bff.drained,
    unreadableBffReplies: bff.unreadable,
  };
  console.info('Native Archive label identity boundaries', identity);
  await writeArchiveProvenance({ outcome: 'incomplete', phase: 'owner-label-identity', identity });
  const renamedSourceLabel = currentLabels.find((label) => label.id === prepared.labelId);
  const restoredLabel = currentLabels.find((label) => label.id === restoredLabelId);
  let labelDisagreement: object | undefined;
  if (restoredLabel?.name !== prepared.labelName || displayed?.label?.id !== restoredLabelId) {
    labelDisagreement = {
      outcome: 'incomplete',
      phase: 'owner-label-prefix-readback',
      identity,
      browser: {
        labelEvidenceMatchesNative: displayedResultLabelId === restoredLabelId,
        visibleEvidenceMatchesNative: visibleLabelMapping?.labelId === restoredLabelId,
        currentMatchesNative: displayed?.label?.id === restoredLabelId,
        currentNameMatches: displayed?.label?.name === prepared.labelName,
      },
      prefix: {
        status: 200,
        count: currentLabels.length,
        hasNext: typeof next === 'string',
        matchesNative: restoredLabel?.name === prepared.labelName,
      },
    };
    await writeArchiveProvenance(labelDisagreement);
  }
  const assertLabelReadbacks = () => {
    expect(displayedResultLabelId).toBe(restoredLabelId);
    expect(visibleLabelMapping?.labelId).toBe(restoredLabelId);
    expect(pointResponse.status).toBe(200);
    expect(point?.label?.id).toBe(restoredLabelId);
    expect(renamedSourceLabel).toEqual({ ...renameReceipt, name: renamedLabelName });
    expect(restoredLabel).toMatchObject({ id: restoredLabelId, name: prepared.labelName });
    expect(displayed?.label).toMatchObject({ id: restoredLabelId, name: prepared.labelName });
  };

  const entryRead = await json<{ libraryEntry: { subjectId: string; state: string } }>(
    await stack.kernel(`/v1/libraryEntries/${prepared.subjectId}`, undefined, 'alice'),
    200,
    'entry readback',
  );
  expect(entryRead.libraryEntry).toMatchObject({ subjectId: prepared.subjectId, state: prepared.stateId });

  if (!collection) {
    assertLabelReadbacks();
    await writeArchiveProvenance({
      outcome: 'passed',
      phase: 'entry-readback',
      entryStatePreserved: true,
      sourceLabelRenamed: true,
      distinctLabelCreated: true,
      currentLabelRead: true,
    });
    return;
  }
  const { restoredId, nativeCollection, members, bobDenied } = collection;
  await page.getByRole('link', { name: 'Recover archived progress' }).click();
  await hydrated(page);
  expect(new URL(page.url()).pathname).toBe('/en/library/recover-progress');
  const item = (await message('en', 'library_archive_present_item')).replace('{number}', String(sessionOrdinal + 1));
  const occurrence = page
    .getByRole('region', { name: await message('en', 'library_archive_progress_occurrences'), exact: true })
    .getByRole('listitem')
    .filter({ hasText: `${item} ·` });
  const mapOccurrence = occurrence.getByRole('button', { name: 'Map this occurrence', exact: true });
  await uploadRecoveryArchive(
    page,
    archivePath,
    'progress',
    page.getByLabel(await message('en', 'library_archive_progress_file'), { exact: true }),
    [mapOccurrence],
    undefined,
    sessionOrdinal,
  );
  await mapOccurrence.click();
  await page.getByLabel(await message('en', 'library_archive_progress_subject')).fill(prepared.subjectId);
  await page.getByRole('button', { name: 'Read current profile choices', exact: true }).click();
  const pair = page.getByRole('combobox', { name: await message('en', 'library_archive_progress_pair') });
  await pair.waitFor({ state: 'visible', timeout: 30_000 });
  await pair.click();
  await page.getByRole('option', { name: /^Amount · pages?$/i }).click();
  await page.getByRole('button', { name: 'Review this exact mapping', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: await message('en', 'library_archive_progress_consent'),
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: 'Confirm and create this Session', exact: true }).click();
  await page.getByRole('button', { name: 'Read current Session and exact units', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Read current Session and exact units', exact: true }).click();
  const sessions = await json<{ progressSessions: { id: string; subjectId: string }[] }>(
    await stack.kernel(
      `/v1/progressSessions?subjectId=${encodeURIComponent(prepared.subjectId)}&limit=100`,
      undefined,
      'alice',
    ),
    200,
    'progress readback',
  );
  expect(sessions.progressSessions.some((row) => row.id === prepared.sessionId)).toBe(true);
  expect(sessions.progressSessions.length).toBeGreaterThan(1);
  if (labelDisagreement)
    await writeArchiveProvenance({ ...labelDisagreement, entryStatePreserved: true, progressSessionRestored: true });
  await leaveRecoveryFor(page, await message('en', 'library_export_title'));

  const headings: Record<string, string> = {};
  for (const locale of locales) {
    headings[locale] = await visitLocalizedArchive(page, locale, 'export', 'library_export_title');
  }
  await visitLocalizedArchive(page, 'zh-Hant', 'recover-collections', 'library_archive_recovery_title');
  await visitLocalizedArchive(page, 'ja', 'recover-archive', 'library_archive_title');

  // Finish Alice's localized visits before opening Bob's separate context.
  await signedIn.context.close();
  const bob = await auth.signIn('bob', { returnTo: `/en/collections/${restoredId}` });
  const bobPage = bob.continueOnPage();
  await bobPage.goto(`${stack.web}/en/collections/${restoredId}`, { waitUntil: 'domcontentloaded' });
  await hydrated(bobPage);
  expect(await bobPage.getByRole('heading', { name: prepared.collectionTitle }).count()).toBe(0);
  await auth.stop();

  assertLabelReadbacks();
  await writeArchiveProvenance({
    outcome: 'passed',
    stack: { kernel: stack.kernelOrigin, web: stack.web },
    personas: { owner: 'alice', otherMember: 'bob' },
    seed: {
      subjectId: prepared.subjectId,
      sourceCollectionId: prepared.collectionId,
      restoredCollectionId: restoredId,
      labelId: prepared.labelId,
      sourceSessionId: prepared.sessionId,
    },
    archive: {
      path: archivePath,
      version: artifact.manifest.version,
      rows: artifact.manifest.rows,
      sections: artifact.manifest.sections,
    },
    locales: headings,
    native: {
      restoredVisibility: nativeCollection.collection.visibility,
      restoredMemberCount: nativeCollection.collection.memberCount,
      memberNotes: members.members.map((row) => row.note),
      otherMemberStatus: bobDenied.status,
      renamedSourceLabel,
      restoredLabel,
      labelIdentity: identity,
      progressSessionCount: sessions.progressSessions.length,
    },
  });
}

nativeTest(
  entryOnly
    ? 'owner exports a populated Library and restores Entry and Label through actual pages'
    : 'owner exports a populated Library and restores Collection, Entry and progress through actual pages',
  300_000,
  restoreOwnerLibrary,
  lifecycle,
);
