import { expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { BrowserContext, Page } from 'playwright';
import { decodePreferenceValues } from '@rezics/client';
import { PROBLEMS } from '../../../../services/kernel/src/http/problem-error.ts';
import { LIBRARY_PAGE_LIMIT } from '../../src/library/reads.ts';
import { prepareNativeAuthMessages, startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { prepareLibraryDirectory } from './library-directory-readiness.ts';
import { createLibraryEntry, prepareLibraryEntryCreator } from './library-navigation-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
import { observePersonalWebReturn, sampleLibraryKernelReturn } from './personal-web-return-observation.ts';
import { prepareNativeWebSearch } from './search-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const lifecycle = new NativeTestLifecycle('first-public personal Web paths');
const library = '/en/library';
const settings = '/en/settings';
let stack: NativeWebStack;
let auth: NativeAuthStack;

nativeBeforeAll(lifecycle, 600_000, async () => {
  await prepareNativeAuthMessages();
  await prepareNativeWebSearch('first-public-personal');
  stack = await startNativeWebStack({
    bundledClient: process.env.NATIVE_WEB_BUNDLED_CLIENT === '1',
    observePersonalAccess: true,
  });
  auth = await startAuthStack(stack, { preparedMessages: true, useHeadlessShell: true });
});
nativeAfterAll(lifecycle, 180_000);

async function accountPage(persona: 'alice' | 'bob', path: string) {
  // newContext registers the fresh context with the active nativeTest lifecycle.
  const context = await auth.newContext(persona);
  const page = await signInForPersonalPage(persona, context, path);
  await auth.settlePageApp();
  await browserExpect(page).toHaveURL(new URL(path, stack.web).href);
  return page;
}

async function signInForPersonalPage(persona: 'alice' | 'bob', context: BrowserContext, path: string) {
  const target = new URL(path, stack.web);
  const observation = observePersonalWebReturn(context, target);
  const kernelStart = target.pathname === library ? stack.kernelRequests().length : undefined;
  try {
    return (await auth.signIn(persona, { context, returnTo: path })).continueOnPage();
  } catch (cause) {
    const browser = observation.snapshot();
    const kernel = kernelStart === undefined ? null : await sampleLibraryKernelReturn(stack, kernelStart);
    throw new Error(
      `Native personal Web return to ${target.pathname} as ${persona}: ${JSON.stringify({ browser, kernel })}`,
      { cause },
    );
  } finally {
    observation.stop();
  }
}

async function openFeature(feature: 'personal_library' | 'reading_progress') {
  const response = await stack.kernel(
    `/v1/platform/exposure/${feature}:open`,
    { method: 'POST', headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) } },
    'governor',
  );
  expect(response.status).toBe(200);
}

async function read(path: string, persona: 'alice' | 'bob') {
  const response = await stack.kernel(path, {}, persona);
  expect(response.status, `GET ${path} as ${persona}`).toBe(200);
  return response.json();
}

async function ownerWrite(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>) {
  const response = await stack.kernel(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify(body),
    },
    'alice',
  );
  expect(response.status, `${method} ${path} as alice`).toBe(method === 'POST' ? 201 : 200);
  return response.json();
}

async function createTrackedSubject() {
  const { authorization } = await stack.authPersona('alice');
  return createLibraryEntry(stack, 'alice', authorization);
}

nativeTest(
  'W14 returns from the exact Subject to the filtered private state shelf',
  240_000,
  async () => {
    // Ordered shelves use the native reading-progress admission in addition to entry exposure.
    await openFeature('reading_progress');
    const subject = await createTrackedSubject();
    const { libraryEntry } = await read(`/v1/libraryEntries/${subject.id}?view=FULL`, 'alice');
    expect(libraryEntry.subjectId).toBe(subject.id);
    const page = await accountPage('alice', library);
    const start = stack.kernelRequests().length;
    const stateLink = page.locator(`[data-shelf-status-strip] a[href*="state=${libraryEntry.state}"]`);
    await stateLink.click();
    await browserExpect(page).toHaveURL((url) => url.searchParams.get('state') === libraryEntry.state);
    await page.getByRole('button', { name: 'Type: All types', exact: true }).click();
    await page.getByRole('dialog').locator('a[href*="type=schema%3ABook"]').click();
    await browserExpect(page).toHaveURL(
      (url) =>
        url.pathname === library &&
        url.searchParams.get('state') === libraryEntry.state &&
        url.searchParams.get('type') === 'schema:Book',
    );
    const shelfUrl = page.url();
    const target = page
      .getByRole('main')
      .getByRole('link', { name: 'Native library member', exact: true })
      .and(page.locator(`a[href^="/en/subjects/${subject.id}/"]`));
    await browserExpect(target).toBeVisible();
    await stack.syncKernelRequests();
    const bounded = stack
      .kernelRequests()
      .slice(start)
      .some(({ method, url, fixtureRequest, responseStatus }) => {
        const request = new URL(url, stack.kernelOrigin);
        const limit = Number(request.searchParams.get('limit'));
        return (
          !fixtureRequest &&
          method === 'GET' &&
          responseStatus === 200 &&
          request.pathname === '/v1/libraryEntries' &&
          request.searchParams.get('type') === 'schema:Book' &&
          request.searchParams.get('state') === libraryEntry.state &&
          request.searchParams.get('view') === 'FULL' &&
          Number.isInteger(limit) &&
          limit > 0 &&
          limit <= 100
        );
      });
    expect(bounded, 'the mounted shelf read the selected native type and state with a bounded limit').toBe(true);
    await target.click();
    await browserExpect(page).toHaveURL((url) => url.pathname.startsWith(`/en/subjects/${subject.id}/`));
    await browserExpect(
      page.getByRole('heading', { level: 1, name: 'Native library member', exact: true }),
    ).toBeVisible();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await browserExpect(page).toHaveURL(shelfUrl);
    await browserExpect(target).toBeVisible();
  },
  lifecycle,
);

nativeTest(
  'W15 creates a private label in Library and reads back the exact owner shelf',
  240_000,
  async () => {
    await openFeature('personal_library');
    // The FULL label shelf requires progress admission even when the label has no assignments.
    await openFeature('reading_progress');
    const alice = await accountPage('alice', library);
    await alice.locator('[data-shelf-filters]').getByRole('link', { name: 'Labels', exact: true }).click();
    await browserExpect(alice).toHaveURL(new URL(`${library}/labels`, stack.web).href);
    const name = `Private label ${crypto.randomUUID()}`;
    const form = alice.getByRole('form', { name: 'Create label', exact: true });
    await form.getByRole('textbox').fill(name);
    await form.getByRole('button', { name: 'Create label', exact: true }).click();
    const link = alice.getByRole('link', { name, exact: true });
    await browserExpect(link).toBeVisible();
    const path = `/v1/libraryLabels?${new URLSearchParams({ q: name, limit: '2' })}`;
    const { labels } = await read(path, 'alice');
    expect(labels).toHaveLength(1);
    const { id: labelId, name: labelName } = labels[0];
    expect(typeof labelId).toBe('string');
    expect(labelName).toBe(name);
    await link.click();
    await browserExpect(alice).toHaveURL(
      (url) => url.pathname === library && url.searchParams.get('label') === labelId,
    );
    await browserExpect(alice.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    const shelfUrl = alice.url();
    await alice.context().close();

    expect((await read(path, 'bob')).labels).toEqual([]);
    expect((await stack.kernel(path, {}, 'anonymous')).status).toBe(401);
    const bob = await accountPage('bob', library);
    expect((await bob.goto(shelfUrl, { waitUntil: 'domcontentloaded' }))?.status()).toBe(404);
    await browserExpect(bob.getByRole('heading', { level: 1, name: /not found/i })).toBeVisible();
    await browserExpect(bob.getByRole('main')).not.toContainText(name);
  },
  lifecycle,
);

nativeTest(
  'W17 filters the owner’s built-in Everything Collection, follows its native cursor, and opens the exact Subject',
  600_000,
  async (signal) => {
    const owner = await stack.authPersona('bob');
    const createEntry = await prepareLibraryEntryCreator(stack, 'bob', owner.authorization);
    const property = 'schema:datePublished';
    const filterKey = `r.${property}`;
    const filterValue = '1990,1999';
    const createDatedEntry = async (title: string, year: number) => {
      const { id } = await createEntry(title, {
        [property]: [
          {
            property: { id: property },
            value: {
              type: 'value',
              content: {
                time: `+${year}-00-00T00:00:00Z`,
                precision: 9,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/books' } },
                ],
              },
            ],
          },
        ],
      });
      return { id, title };
    };
    const matching: { id: string; title: string }[] = [];
    for (let index = 0; index <= LIBRARY_PAGE_LIMIT; index++) {
      signal.throwIfAborted();
      matching.push(await createDatedEntry(`Everything result ${index + 1}`, 1995));
    }
    await createDatedEntry('Everything result outside the range', 1985);

    await prepareLibraryDirectory(stack, owner.accountId, signal);
    const directory = await stack.kernel(`/v1/collections?curatorAccountId=${owner.accountId}&limit=100`, {}, 'bob');
    if (directory.status !== 200) {
      const problem: unknown = directory.headers.get('content-type')?.startsWith('application/problem+json')
        ? await directory.json().catch(() => null)
        : null;
      const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
      const knownCode = typeof code === 'string' && Object.hasOwn(PROBLEMS, code) ? code : 'unclassified';
      throw new Error(
        `Collections setup after owner index readiness: GET /v1/collections as Bob for Bob returned ${directory.status} ${knownCode}`,
      );
    }
    const { collections } = (await directory.json()) as {
      collections: { id: string; builtinKind?: string; curatorAccountId: string; visibility: string }[];
    };
    const everything = collections.find((collection) => collection.builtinKind === 'everything');
    if (!everything) throw new Error('The native owner directory did not return Everything');
    expect(everything.curatorAccountId).toBe(owner.accountId);
    expect(everything.visibility).toBe('private');
    const collectionPath = `/en/collections/${encodeURIComponent(everything.id)}`;
    const membersPath = `/v1/collections/${encodeURIComponent(everything.id)}/members`;
    async function mountedMemberQuery(start: number, cursor: string | null) {
      await stack.syncKernelRequests();
      const request = stack
        .kernelRequests()
        .slice(start)
        .findLast(({ method, url, fixtureRequest, responseStatus }) => {
          if (fixtureRequest || method !== 'GET' || responseStatus !== 200) return false;
          const address = new URL(url, stack.kernelOrigin);
          return (
            address.pathname === membersPath &&
            address.searchParams.has('filter') &&
            address.searchParams.get('cursor') === cursor
          );
        });
      if (!request) throw new Error('The mounted Everything Collection did not complete its filtered native read');
      const query = new URL(request.url, stack.kernelOrigin).searchParams;
      expect(query.get('view')).toBe('FULL');
      expect(query.get('limit')).toBe(String(LIBRARY_PAGE_LIMIT));
      return query.get('filter')!;
    }

    const page = await accountPage('bob', library);
    const link = page.getByRole('link', { name: 'Everything', exact: true });
    await browserExpect(link).toHaveAttribute('href', collectionPath);
    await link.click();
    await browserExpect(page).toHaveURL(new URL(collectionPath, stack.web).href);
    await page.locator('html[data-hydrated]').waitFor();
    await browserExpect(page.getByRole('heading', { level: 1, name: 'Everything', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const filters = page.getByRole('dialog', { name: 'Filters', exact: true });
    await filters.getByRole('searchbox', { name: 'Find a property' }).fill(property);
    await filters.getByRole('combobox', { name: 'Property', exact: true }).click();
    await page.getByRole('option', { name: 'publication date', exact: true }).click();
    await filters.locator(`input[name="range.from.${property}"]:visible`).fill('1990');
    await filters.locator(`input[name="range.to.${property}"]:visible`).fill('1999');
    await stack.syncKernelRequests();
    const firstStart = stack.kernelRequests().length;
    await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await browserExpect(page).toHaveURL(
      (url) =>
        url.pathname === collectionPath &&
        url.searchParams.get(filterKey) === filterValue &&
        !url.searchParams.has('cursor'),
      { timeout: 120_000 },
    );
    const more = page
      .getByRole('navigation', { name: 'Members', exact: true })
      .getByRole('link', { name: 'More', exact: true });
    try {
      await browserExpect(more).toBeVisible({ timeout: 120_000 });
    } catch (cause) {
      const requests = await settledWithin(stack.sampleKernelRequests(), 1_500).catch(() => undefined);
      const reads = requests
        ?.slice(firstStart)
        .filter((request) => {
          if (request.fixtureRequest || request.method !== 'GET') return false;
          return new URL(request.url, stack.kernelOrigin).pathname === membersPath;
        })
        .slice(-8)
        .map((request) => {
          const { searchParams } = new URL(request.url, stack.kernelOrigin);
          const body = request.failure?.body;
          let code: string | undefined;
          let missingCanonicalSource = false;
          if (body && body.length <= 8192) {
            try {
              const problem = JSON.parse(body) as { code?: unknown; detail?: unknown } | null;
              if (typeof problem?.code === 'string' && Object.hasOwn(PROBLEMS, problem.code)) code = problem.code;
              missingCanonicalSource =
                problem?.detail ===
                'The current logical owner binding has no prepared canonical Collection Source scope.';
            } catch {
              // Report only known problem metadata from the mounted read.
            }
          }
          return {
            status: request.responseStatus ?? null,
            filtered: searchParams.has('filter'),
            continuation: searchParams.has('cursor'),
            ownerAuthenticated: request.access?.authenticated === true && request.access.actorId === owner.accountId,
            code,
            missingCanonicalSource,
          };
        });
      console.error(`Native Everything members after filter apply: ${JSON.stringify(reads ?? null)}`);
      throw cause;
    }
    const filter = await mountedMemberQuery(firstStart, null);
    expect(JSON.parse(filter)).toEqual({ statement: { property, range: { gte: 1990, lte: 1999 } } });

    const members = page.locator('[data-collection-members] a[data-slot="list-row-link"]');
    await browserExpect(members).toHaveCount(LIBRARY_PAGE_LIMIT);
    const firstPageIds = await members.evaluateAll((links) =>
      links.map((item) => new URL((item as HTMLAnchorElement).href).pathname.split('/')[3]!),
    );
    const remaining = matching.filter(({ id }) => !firstPageIds.includes(id));
    expect(remaining).toHaveLength(1);
    const target = remaining[0]!;
    const emitted = new URL((await more.getAttribute('href'))!, stack.web);
    expect(emitted.pathname).toBe(collectionPath);
    expect(emitted.searchParams.get(filterKey)).toBe(filterValue);
    const cursor = emitted.searchParams.get('cursor');
    if (!cursor) throw new Error('The filtered Everything page did not emit a native continuation cursor');

    const secondStart = stack.kernelRequests().length;
    await more.click();
    await browserExpect(page).toHaveURL(emitted.href, { timeout: 120_000 });
    const subjectPath = `/en/subjects/${target.id}/`;
    const member = members
      .and(page.getByRole('link', { name: target.title, exact: true }))
      .and(page.locator(`a[href^="${subjectPath}"]`));
    await browserExpect(member).toBeVisible({ timeout: 120_000 });
    await browserExpect(members).toHaveCount(1);
    expect(await mountedMemberQuery(secondStart, cursor)).toBe(filter);

    const subjectUrl = new URL((await member.getAttribute('href'))!, stack.web);
    await member.click();
    await browserExpect(page).toHaveURL(subjectUrl.href);
    await browserExpect(page.getByRole('heading', { level: 1, name: target.title, exact: true })).toBeVisible();
  },
  lifecycle,
);

nativeTest(
  'W19 updates a Library progress session and returns to its subject-filtered list',
  240_000,
  async () => {
    const subject = await createTrackedSubject();
    await openFeature('reading_progress');
    const { progressSession } = await ownerWrite('POST', '/v1/progressSessions', {
      subjectId: subject.id,
      mode: 'scalar_amount',
      unit: 'page',
      total: '300',
    });
    const { id: sessionId } = progressSession;
    expect(typeof sessionId).toBe('string');
    expect(progressSession.subjectId).toBe(subject.id);
    const index = `${library}/progress?subjectId=${encodeURIComponent(subject.id)}`;
    const page = await accountPage('alice', index);
    const detail = `${library}/progress/${sessionId}`;
    const row = page.getByRole('main').locator(`a[href="${detail}"]`);
    await row.click();
    await browserExpect(page).toHaveURL((url) => url.pathname === detail);
    await page.getByRole('button', { name: 'Update progress', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('125');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await browserExpect(page.getByText(/125\s*\/\s*300\s+Page/).first()).toBeVisible();
    const path = `/v1/progressSessions/${sessionId}?view=FULL`;
    const { progressSession: saved } = await read(path, 'alice');
    expect(saved.id).toBe(sessionId);
    expect(saved.subjectId).toBe(subject.id);
    expect(saved.mode).toBe('scalar_amount');
    expect(saved.unit).toBe('page');
    expect(saved.amount).toBe('125');
    expect(saved.total).toBe('300');
    expect((await stack.kernel(path, {}, 'bob')).status).toBe(404);
    await page.getByRole('link', { name: 'Return to progress', exact: true }).click();
    await browserExpect(page).toHaveURL(new URL(index, stack.web).href);
    await browserExpect(row).toBeVisible();
  },
  lifecycle,
);

nativeTest(
  'W20 resolves a concurrent copy edit, saves it, and restores the deleted holding',
  240_000,
  async () => {
    const subject = await createTrackedSubject();
    const { copy } = await ownerWrite('POST', '/v1/copies', {
      subjectId: subject.id,
      kind: 'physical',
      status: 'owned',
      location: 'First shelf',
    });
    const { id: copyId, revision } = copy;
    expect(typeof copyId).toBe('string');
    expect(copy.subjectId).toBe(subject.id);
    expect(typeof revision).toBe('number');
    const path = `/v1/copies/${copyId}`;
    const page = await accountPage('alice', `${library}/copies?subjectId=${subject.id}`);
    const edit = async () => {
      await page.locator(`button[data-copy-edit-id="${copyId}"]`).click();
      await page.getByRole('menuitem', { name: 'Edit copy', exact: true }).click();
    };
    await edit();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const note = 'Kept after reviewing the newer location';
    await page.getByLabel('Note', { exact: true }).fill(note);
    const newer = await ownerWrite('PATCH', path, { revision, location: 'Second shelf' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const review = page.getByRole('region', { name: 'Review current details', exact: true });
    await review.getByRole('button', { name: 'Review current Copy', exact: true }).click();
    await browserExpect(review.getByText('Second shelf', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Use current details', exact: true }).click();
    await browserExpect(page.getByLabel('Note', { exact: true })).toHaveValue(note);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(page.getByText(note, { exact: true })).toBeVisible();
    const saved = (await read(path, 'alice')).copy;
    const fields = {
      id: copyId,
      subjectId: subject.id,
      kind: 'physical',
      status: 'owned',
      location: 'Second shelf',
      note,
    };
    for (const [field, value] of Object.entries(fields)) expect(saved[field], field).toBe(value);
    expect(saved.revision).toBeGreaterThan(newer.copy.revision);

    await edit();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete this copy', exact: true }).click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await browserExpect(undo).toBeVisible();
    expect((await stack.kernel(path, {}, 'alice')).status).toBe(404);
    await undo.click();
    await browserExpect(page.getByText(note, { exact: true })).toBeVisible();
    const restored = (await read(path, 'alice')).copy;
    for (const [field, value] of Object.entries(fields)) expect(restored[field], field).toBe(value);
    expect((await stack.kernel(path, {}, 'bob')).status).toBe(404);
  },
  lifecycle,
);

async function preferences(persona: 'alice' | 'bob') {
  // Read stored values independently of the browser session that this journey signs out.
  const { accountId, authorization } = await stack.authPersona(persona, ['account:read']);
  const response = await stack.kernel(`/v1/accounts/${accountId}/preferences`, { headers: { authorization } });
  expect(response.status, `Read stored preferences as ${persona}`).toBe(200);
  const current = decodePreferenceValues(await response.json());
  if (!current) throw new Error(`Invalid native reading preferences for ${persona}`);
  return current;
}

function covers(page: Page) {
  return page.locator('#reading').getByRole('switch', { name: 'Show covers withheld for suitability', exact: true });
}

nativeTest(
  'W25 saves a reading preference and recovers the replacement account’s own settings',
  240_000,
  async () => {
    const before = await preferences('alice');
    const other = await preferences('bob');
    expect(before.suitability).toBe(other.suitability);
    const show = before.suitability !== 'show';
    const page = await accountPage('alice', settings);
    await browserExpect(covers(page)).toHaveAttribute('aria-checked', String(!show));
    await covers(page).click();
    await browserExpect(page.locator('#reading').getByText('Saved', { exact: true })).toBeVisible();
    const saved = await preferences('alice');
    expect(saved.suitability).toBe(show ? 'show' : 'blur');
    expect(saved.version).toBeGreaterThan(before.version);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await browserExpect(covers(page)).toHaveAttribute('aria-checked', String(show));

    // Keep the original settings tab open across the actual sign-out and replacement login.
    const account = await page.context().newPage();
    await account.goto(new URL(settings, stack.web).href, { waitUntil: 'domcontentloaded' });
    await account.locator('#account-menu-button').click();
    const [response] = await Promise.all([
      account.waitForResponse((r) => new URL(r.url()).pathname === '/auth/sign-out' && r.request().method() === 'POST'),
      account.getByRole('button', { name: 'Sign out', exact: true }).click(),
    ]);
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    await browserExpect
      .poll(async () =>
        (await page.context().cookies(stack.web)).some((cookie) => cookie.name === '__Host-rezics_session'),
      )
      .toBe(false);
    await account.close();
    const replacementPage = await signInForPersonalPage('bob', page.context(), settings);
    await auth.settlePageApp();
    await browserExpect(covers(replacementPage)).toHaveAttribute('aria-checked', String(!show));
    await page.bringToFront();
    await browserExpect(covers(page).and(page.locator(`[aria-checked="${show}"]`))).not.toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await browserExpect(covers(page)).toHaveAttribute('aria-checked', String(!show));
    expect(await preferences('bob')).toEqual(other);
    expect(await preferences('alice')).toEqual(saved);
  },
  lifecycle,
);
