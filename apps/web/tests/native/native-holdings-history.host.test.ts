import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page, Response } from 'playwright';
import {
  createNativeHoldingsHistoryFixture,
  nativeJson,
  type NativeHoldingsHistoryFixture,
  type NativeLibrarySubject,
} from './native-holdings-history-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeHoldingsHistoryFixture;

beforeAll(async () => {
  fixture = await createNativeHoldingsHistoryFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

const key = () => `"${crypto.randomUUID()}"`;

function redactPostBody(body: string | null): string | null {
  if (body === null) return null;
  return body.replace(/("(?:[^"]*(?:authorization|csrf|token)[^"]*)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2');
}

async function postJson(fixture: NativeHoldingsHistoryFixture, path: string, body: unknown, persona = 'alice') {
  return fixture.stack.kernel(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key() },
      body: JSON.stringify(body),
    },
    persona,
  );
}

async function subjectPage(subject: NativeLibrarySubject): Promise<string> {
  // Keep this UI-dependent module out of test-file evaluation. The isolated
  // native stack starts only after beforeAll, when its normal startup path has
  // generated the real Paraglide messages module.
  const { subjectHref } = await import('../../src/subject/subject-href.ts');
  return `${fixture.stack.web}${subjectHref(subject, 'en').href}`;
}

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function beginProgress(
  subject: NativeLibrarySubject,
  expectedModes: string[],
  expectedUnits: string[],
  selectedMode: string,
  selectedUnit: string,
  total?: string,
): Promise<string> {
  const page = fixture.alicePage;
  const navigation = await page.goto(await subjectPage(subject));
  expect(navigation?.status()).toBe(200);
  await hydrated(page);
  await page.getByRole('link', { name: 'Start progress', exact: true }).click();
  const unit = page.getByLabel('Unit', { exact: true });
  await unit.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor({ state: 'visible' });
  const modes = page.getByRole('group', { name: 'Mode', exact: true }).getByRole('radio');
  await modes.first().waitFor({ state: 'visible' });
  const modeLabels: Record<string, string> = {
    scalar_amount: 'Amount',
    cursor_position: 'Cursor position',
    completed_units: 'Completed units',
  };
  const allowedModes = await modes.evaluateAll((items) =>
    items.map((item) => item.closest('label')?.textContent?.trim() ?? null),
  );
  expect(allowedModes).toEqual(expectedModes.map((mode) => modeLabels[mode]));
  const modeIndex = expectedModes.indexOf(selectedMode);
  expect(modeIndex).toBeGreaterThanOrEqual(0);
  if (modeIndex > 0) await modes.nth(modeIndex).click();
  const allowedUnits = await unit
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(allowedUnits).toEqual(expectedUnits);
  await unit.selectOption(selectedUnit);
  if (total !== undefined) await page.getByLabel('Total', { exact: true }).fill(total);
  const postResponses: { response: Response; url: string; status: number; requestBody: string | null }[] = [];
  const capturePostResponse = (response: Response) => {
    if (response.request().method() !== 'POST') return;
    const url = response.url();
    const status = response.status();
    const requestBody = redactPostBody(response.request().postData());
    postResponses.push({ response, url, status, requestBody });
  };
  page.on('response', capturePostResponse);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const startOutcome = await Promise.race([
    page.waitForURL((url) => /\/en\/library\/progress\/[0-9a-f-]+$/i.test(url.pathname)).then(() => 'started' as const),
    page
      .getByRole('alert')
      .waitFor({ state: 'visible' })
      .then(() => 'refused' as const),
  ]);
  page.off('response', capturePostResponse);
  if (startOutcome === 'refused') {
    const responseBodies = await Promise.all(
      postResponses.map(async ({ response, url, status, requestBody }) => ({
        url,
        status,
        body: await response.text().catch((error: unknown) => `[response body unavailable: ${String(error)}]`),
        requestBody,
      })),
    );
    await fixture.stack.kernel('/v1/definitions/active', {}, 'alice');
    const requests = fixture.stack
      .kernelRequests()
      .filter(({ method, url }) => method === 'POST' && url.startsWith('/v1/progressSessions'))
      .map(({ method, url, body, failure }) => ({ method, url, body, failure }));
    throw new Error(
      `Progress start for ${subject.id} showed ${await page.getByRole('alert').innerText()}; web POST responses ${JSON.stringify(responseBodies)}; native starts: ${JSON.stringify(requests)}`,
    );
  }
  await page.waitForLoadState('networkidle');
  await hydrated(page);
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!);
  await page.getByRole('button', { name: 'Update progress', exact: true }).click();
  const inputName = selectedMode === 'scalar_amount' ? 'Amount' : 'Position';
  try {
    await page.getByRole('spinbutton', { name: inputName, exact: true }).waitFor({ state: 'visible' });
  } catch {
    throw new Error(
      `Update progress did not expose ${inputName}; served page: ${await page.locator('body').innerText()}`,
    );
  }
  return sessionId;
}

async function sessionSnapshot(sessionId: string) {
  const response = await fixture.stack.kernel(
    `/v1/progressSessions/${encodeURIComponent(sessionId)}?view=FULL`,
    {},
    'alice',
  );
  return nativeJson<{ progressSession: Record<string, unknown> }>(response, 200);
}

async function assertOnlyPublishedLog(accountId: string, logId: string) {
  const response = await fixture.stack.kernel(
    `/v1/publishedLogs?accountId=${encodeURIComponent(accountId)}&limit=100`,
    {},
    'alice',
  );
  const page = await nativeJson<{ publishedLogs: { id: string }[]; next: string | null }>(response, 200);
  expect(page.publishedLogs.map((log) => log.id)).toEqual([logId]);
  expect(page.next).toBeNull();
}

describe('native holdings and progress history', () => {
  test('a served Book copies page saves the activated copy kind and note as a native copy', async () => {
    const { stack, alicePage, bobPage, book } = fixture;
    const browserResponses: { method: string; status: number; url: string }[] = [];
    const browserPostResponses: Response[] = [];
    const browserFailures: { method: string; url: string; error: string | null }[] = [];
    alicePage.on('response', (response) => {
      const method = response.request().method();
      const url = response.url();
      browserResponses.push({ method, status: response.status(), url });
      if (method === 'POST') browserPostResponses.push(response);
    });
    alicePage.on('requestfailed', (request) =>
      browserFailures.push({ method: request.method(), url: request.url(), error: request.failure() }),
    );

    let navigation = await alicePage.goto(await subjectPage(book));
    expect(navigation?.status()).toBe(200);
    await hydrated(alicePage);
    await alicePage.getByRole('link', { name: 'Your copies', exact: true }).click();
    await alicePage.waitForURL((url) => url.pathname === '/en/library/copies');
    await hydrated(alicePage);
    expect(new URL(alicePage.url()).searchParams.get('subjectId')).toBe(book.id);
    await alicePage.getByRole('link', { name: 'All copies', exact: true }).waitFor({ state: 'visible' });
    await alicePage.getByRole('button', { name: 'Add a copy', exact: true }).click();
    const copyForm = alicePage.locator('form[aria-label="Add a copy"]');
    await copyForm.waitFor({ state: 'visible' });
    const kind = alicePage.getByLabel('Kind', { exact: true });
    if ((await kind.count()) === 0) {
      throw new Error(
        `The activated Book profile did not render its copy-kind choices. Served copy form: ${await copyForm.innerText()}; page: ${await alicePage.locator('body').innerText()}`,
      );
    }
    const offeredKinds = await kind
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(offeredKinds).toEqual(['physical', 'digital']);
    await kind.selectOption('physical');
    const status = alicePage.getByLabel('Status', { exact: true });
    const physicalStatuses = await status
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(physicalStatuses).toEqual(['owned', 'disposed']);
    await kind.selectOption('digital');
    const digitalStatuses = await status
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(digitalStatuses).toEqual(['owned']);
    await kind.selectOption('physical');
    await status.selectOption('owned');
    await alicePage.getByRole('button', { name: 'Add copy', exact: true }).click();
    const copyCreateOutcome = await Promise.race([
      alicePage
        .getByRole('button', { name: 'More actions', exact: true })
        .waitFor({ state: 'visible' })
        .then(() => 'created' as const),
      alicePage
        .getByRole('alert')
        .waitFor({ state: 'visible' })
        .then(() => 'refused' as const),
    ]);
    if (copyCreateOutcome === 'refused') {
      const browserResponseBodies = await Promise.all(
        browserPostResponses.map(async (response) => ({
          method: response.request().method(),
          status: response.status(),
          url: response.url(),
          body: await response.text().catch((error: unknown) => `[response body unavailable: ${String(error)}]`),
          requestBody: redactPostBody(response.request().postData()),
        })),
      );
      await stack.kernel('/v1/definitions/active', {}, 'alice');
      const request = stack.kernelRequests().findLast(({ method, url }) => method === 'POST' && url === '/v1/copies');
      const formFields = await copyForm.evaluate((form) => Object.fromEntries(new FormData(form).entries()));
      throw new Error(
        `Copy create showed ${await alicePage.getByRole('alert').innerText()}; form fields ${JSON.stringify(formFields)}; form idempotency key ${await copyForm.getAttribute('data-idempotency-key')}; native request POST ${request?.url ?? '/v1/copies'} ${request?.body ?? 'request body unavailable'} returned ${request?.failure?.status ?? 'no captured failure'} ${request?.failure?.body ?? ''}; served POST responses ${JSON.stringify(browserResponseBodies.slice(-5))}; recent kernel requests ${JSON.stringify(
          stack
            .kernelRequests()
            .slice(-8)
            .map(({ method, url, body, failure }) => ({ method, url, body, failure })),
        )}; expected a saved physical/owned copy with its profile pin.`,
      );
    }
    await alicePage.getByRole('button', { name: 'More actions', exact: true }).waitFor({ state: 'visible' });

    await alicePage.getByRole('button', { name: 'More actions', exact: true }).click();
    await alicePage.getByRole('menuitem', { name: 'Edit copy', exact: true }).click();
    await alicePage.getByRole('button', { name: 'More', exact: true }).click();
    const copyNote = 'Alice exact native copy note';
    await alicePage.getByLabel('Note', { exact: true }).fill(copyNote);
    await alicePage.getByRole('button', { name: 'Save', exact: true }).click();
    await alicePage.getByText(copyNote, { exact: true }).waitFor({ state: 'visible' });
    await alicePage.reload();
    await hydrated(alicePage);
    await alicePage.getByText(copyNote, { exact: true }).waitFor({ state: 'visible' });

    const copiesResponse = await stack.kernel(
      `/v1/copies?subjectId=${encodeURIComponent(book.id)}&limit=100&view=FULL`,
      {},
      'alice',
    );
    const copies = await nativeJson<{
      copies: { id: string; kind: string | null; status: string; note: string | null; revision: number }[];
      next: string | null;
    }>(copiesResponse, 200);
    expect(copies.copies).toHaveLength(1);
    const copy = copies.copies[0]!;
    expect(copy).toMatchObject({ kind: 'physical', status: 'owned', note: copyNote, revision: 2 });
    expect(copies.next).toBeNull();

    const bobCopy = await stack.kernel(`/v1/copies/${encodeURIComponent(copy.id)}`, {}, 'bob');
    expect(bobCopy.status).toBe(404);
    const bobCopies = await stack.kernel(`/v1/copies?subjectId=${encodeURIComponent(book.id)}&limit=100`, {}, 'bob');
    const bobCopyPage = await nativeJson<{ copies: { id: string; note: string | null }[]; next: string | null }>(
      bobCopies,
      200,
    );
    expect(bobCopyPage).toEqual({ copies: [], next: null });
    await bobPage.goto(`${stack.web}/en/library/copies?subjectId=${encodeURIComponent(book.id)}`);
    await hydrated(bobPage);
    expect(await bobPage.getByText(copyNote, { exact: true }).count()).toBe(0);
    const anonymousContext = await fixture.auth.context('anonymous');
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(`${stack.web}/en/library/copies?subjectId=${encodeURIComponent(book.id)}`);
    await hydrated(anonymousPage);
    expect(await anonymousPage.getByText(copyNote, { exact: true }).count()).toBe(0);

    await alicePage.getByRole('button', { name: 'More actions', exact: true }).click();
    await alicePage.getByRole('menuitem', { name: 'Edit copy', exact: true }).click();
    await alicePage.getByRole('button', { name: 'More', exact: true }).click();
    await alicePage.getByLabel('Note', { exact: true }).fill('Alice stale browser edit');
    const occupiedUpdate = await stack.kernel(
      `/v1/copies/${encodeURIComponent(copy.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'idempotency-key': key() },
        body: JSON.stringify({
          revision: copy.revision,
          status: copy.status,
          location: null,
          source: null,
          acquiredOn: null,
          disposedOn: null,
          note: 'Alice native concurrent edit',
        }),
      },
      'alice',
    );
    expect(occupiedUpdate.status).toBe(200);
    await alicePage.getByRole('button', { name: 'Save', exact: true }).click();
    const staleAlert = alicePage.getByRole('alert');
    await staleAlert.waitFor({ state: 'visible' });
    expect(await staleAlert.innerText()).toContain('This copy changed since you started editing');
    await alicePage.getByRole('button', { name: 'Cancel', exact: true }).click();
    await alicePage.reload();
    await hydrated(alicePage);
    await alicePage.getByRole('button', { name: 'More actions', exact: true }).click();
    const copyMenu = alicePage.getByRole('menuitem');
    const copyMenuItems = await copyMenu.allTextContents();
    if (!copyMenuItems.includes('Edit copy'))
      throw new Error(
        `After reload the saved physical copy offered menu items ${JSON.stringify(copyMenuItems)}; page: ${await alicePage.locator('body').innerText()}`,
      );
    await alicePage.getByRole('menuitem', { name: 'Edit copy', exact: true }).click();
    await alicePage.getByRole('button', { name: 'Delete', exact: true }).click();
    await alicePage.getByRole('alertdialog').getByRole('button', { name: 'Delete this copy', exact: true }).click();
    await alicePage.getByText('You have no copies of this edition.', { exact: true }).waitFor({ state: 'visible' });
    expect(await alicePage.getByRole('button', { name: /undo/i }).count()).toBe(0);
    const deletedCopy = await stack.kernel(`/v1/copies/${encodeURIComponent(copy.id)}`, {}, 'alice');
    expect(deletedCopy.status).toBe(404);
    expect(browserFailures).toEqual([]);
    expect(
      browserResponses.some(
        ({ method, status, url }) => method === 'GET' && status === 200 && url.includes('/en/library/copies'),
      ),
    ).toBe(true);
  });

  test('Book and Recipe progress stays native, publication is explicit, and History follows every cursor', async () => {
    const { stack, alicePage, bobPage, book, recipe } = fixture;
    const browserResponses: { method: string; status: number; url: string }[] = [];
    const browserFailures: { method: string; url: string; error: string | null }[] = [];
    alicePage.on('response', (response) =>
      browserResponses.push({ method: response.request().method(), status: response.status(), url: response.url() }),
    );
    alicePage.on('requestfailed', (request) =>
      browserFailures.push({ method: request.method(), url: request.url(), error: request.failure() }),
    );
    let navigation: Awaited<ReturnType<typeof alicePage.goto>>;
    const bookModes = ['scalar_amount'];
    const bookUnits = ['page'];
    const bookSessionId = await beginProgress(book, bookModes, bookUnits, 'scalar_amount', 'page', '300');
    await alicePage.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('125');
    await alicePage.getByRole('button', { name: 'Record', exact: true }).click();
    await alicePage.reload();
    await hydrated(alicePage);
    const bookSession = await sessionSnapshot(bookSessionId);
    expect(bookSession.progressSession).toMatchObject({
      mode: 'scalar_amount',
      unit: 'page',
      amount: '125',
      total: '300',
    });
    await alicePage.getByText(/125\s*\/\s*300\s+Page/).waitFor({ state: 'visible' });

    // The activated bundled profiles expose Book scalar/page and Recipe scalar/minute, but no cursor_position mode.
    // Keep the current UI choices exact and verify the producer refuses this absent pair without persisting a row.
    const unsupportedCursor = await postJson(fixture, '/v1/progressSessions', {
      subjectId: book.id,
      mode: 'cursor_position',
      unit: 'percent',
    });
    const unsupportedCursorBody = await unsupportedCursor.json();
    expect(unsupportedCursor.status).toBe(422);
    expect(unsupportedCursorBody).toMatchObject({ code: 'unsupported_library_profile' });
    const bookSessions = await stack.kernel(
      `/v1/progressSessions?subjectId=${encodeURIComponent(book.id)}&limit=100`,
      {},
      'alice',
    );
    const bookSessionPage = await nativeJson<{ progressSessions: { id: string }[] }>(bookSessions, 200);
    expect(bookSessionPage.progressSessions.map((session) => session.id)).toEqual([bookSessionId]);

    const recipeSessionId = await beginProgress(recipe, ['scalar_amount'], ['minute'], 'scalar_amount', 'minute', '90');
    const privateAmount = '37';
    await alicePage.getByRole('spinbutton', { name: 'Amount', exact: true }).fill(privateAmount);
    await alicePage.getByRole('button', { name: 'Record', exact: true }).click();
    await alicePage.reload();
    await hydrated(alicePage);
    const recipeSession = await sessionSnapshot(recipeSessionId);
    expect(recipeSession.progressSession).toMatchObject({
      mode: 'scalar_amount',
      unit: 'minute',
      amount: privateAmount,
      total: '90',
    });
    await alicePage.getByText(/37\s*\/\s*90\s+Minute/).waitFor({ state: 'visible' });

    await alicePage.goto(`${stack.web}/en/library/progress/${encodeURIComponent(bookSessionId)}`);
    await hydrated(alicePage);
    await alicePage.getByLabel('Publish note', { exact: true }).fill('Alice explicitly published this log');
    await alicePage.getByRole('button', { name: 'Publish', exact: true }).click();
    await alicePage.waitForURL((url) => url.pathname.startsWith('/en/logs/'));
    const logId = decodeURIComponent(new URL(alicePage.url()).pathname.split('/').at(-1)!);
    expect(await alicePage.getByText('Alice explicitly published this log', { exact: true }).count()).toBe(1);

    const aliceIdentity = await stack.authPersona('alice');
    await assertOnlyPublishedLog(aliceIdentity.accountId, logId);
    const publicLogResponse = await stack.kernel(`/v1/publishedLogs/${encodeURIComponent(logId)}`);
    const publicLog = await nativeJson<{ publishedLog: Record<string, unknown> }>(publicLogResponse, 200);
    expect(publicLog.publishedLog).toMatchObject({ id: logId, note: 'Alice explicitly published this log' });
    expect(publicLog.publishedLog).not.toHaveProperty('amount');
    expect(publicLog.publishedLog).not.toHaveProperty('unit');
    expect(publicLog.publishedLog).not.toHaveProperty('sessionId');
    const bobPrivateSession = await stack.kernel(
      `/v1/progressSessions/${encodeURIComponent(recipeSessionId)}?view=FULL`,
      {},
      'bob',
    );
    expect(bobPrivateSession.status).toBe(404);
    const anonymousPrivateSession = await stack.kernel(
      `/v1/progressSessions/${encodeURIComponent(recipeSessionId)}?view=FULL`,
    );
    expect(anonymousPrivateSession.status).toBe(401);
    await bobPage.goto(`${stack.web}/en/logs/${encodeURIComponent(logId)}`);
    await hydrated(bobPage);
    expect(await bobPage.getByText('Alice explicitly published this log', { exact: true }).count()).toBe(1);
    await bobPage.goto(`${stack.web}/en/library/progress?subjectId=${encodeURIComponent(recipe.id)}`);
    await hydrated(bobPage);
    expect(await bobPage.getByText(/37\s*\/\s*90\s+Minute/).count()).toBe(0);

    const anonymousContext = await fixture.auth.context('anonymous');
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(`${stack.web}/en/logs/${encodeURIComponent(logId)}`);
    await hydrated(anonymousPage);
    expect(await anonymousPage.getByText('Alice explicitly published this log', { exact: true }).count()).toBe(1);
    expect(await anonymousPage.getByText(/37\s*\/\s*90\s+Minute/).count()).toBe(0);

    const historySubject = await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key() },
        body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Fixed selected growth subject' } }),
      },
      'editor',
    );
    const selectedGrowthSubject = (await nativeJson<{ subject: { id: string; type: string } }>(historySubject, 201))
      .subject;
    const unrelatedSubjectResponse = await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key() },
        body: JSON.stringify({ type: 'schema:Book', labels: { en: 'Unrelated growth subject' } }),
      },
      'editor',
    );
    const unrelatedSubject = (
      await nativeJson<{ subject: { id: string; type: string } }>(unrelatedSubjectResponse, 201)
    ).subject;
    const growthSamples: number[] = [];
    for (const target of [1, 8, 64]) {
      const existing = target === 1 ? 0 : target === 8 ? 1 : 8;
      for (let index = existing; index < target; index += 1) {
        const progressResponse = await postJson(fixture, '/v1/progressSessions', {
          subjectId: unrelatedSubject.id,
          mode: 'scalar_amount',
          unit: 'page',
          total: null,
        });
        await nativeJson(progressResponse, 201);
      }
      if (target !== 1) await Bun.sleep(5_100);
      const before = stack.kernelRequests().length;
      const selectedUrl = `${stack.web}/en/library/progress?subjectId=${encodeURIComponent(selectedGrowthSubject.id)}`;
      const selectedResponse = await alicePage.goto(selectedUrl);
      expect(selectedResponse?.status()).toBe(200);
      await hydrated(alicePage);
      await stack.kernel('/v1/definitions/active', {}, 'alice');
      const reads = stack
        .kernelRequests()
        .slice(before)
        .filter(
          ({ method, url }) =>
            method === 'GET' &&
            (url.startsWith('/v1/progressSessions?') || url === `/v1/subjects/${selectedGrowthSubject.id}`),
        );
      growthSamples.push(reads.length);
      expect(reads.map(({ url }) => url.split('?')[0]).sort()).toEqual(
        [`/v1/progressSessions`, `/v1/subjects/${selectedGrowthSubject.id}`].sort(),
      );
    }
    console.info(
      `native-holdings-history-growth: selected-progress-page requests at unrelated sessions 1/8/64 = ${growthSamples.join('/')}`,
    );
    expect(growthSamples).toEqual([2, 2, 2]);

    const generatedNotes = Array.from(
      { length: 100 },
      (_, index) => `Cursor history ${String(index + 1).padStart(3, '0')}`,
    );
    for (const note of generatedNotes) {
      const sessionResponse = await postJson(fixture, '/v1/progressSessions', {
        subjectId: book.id,
        mode: 'scalar_amount',
        unit: 'page',
        total: null,
      });
      const session = await nativeJson<{ progressSession: { id: string } }>(sessionResponse, 201);
      const logResponse = await postJson(fixture, '/v1/publishedLogs', { sessionId: session.progressSession.id, note });
      await nativeJson(logResponse, 201);
    }

    const firstNativeHistoryResponse = await stack.kernel(
      `/v1/publishedLogs?accountId=${encodeURIComponent(aliceIdentity.accountId)}&limit=100`,
      {},
      'alice',
    );
    const firstNativeHistory = await nativeJson<{
      publishedLogs: { id: string; note: string | null }[];
      next: string | null;
    }>(firstNativeHistoryResponse, 200);
    expect(firstNativeHistory.publishedLogs).toHaveLength(100);
    expect(firstNativeHistory.next).toBeTruthy();
    const nextNativeHistoryResponse = await stack.kernel(
      `/v1/publishedLogs?accountId=${encodeURIComponent(aliceIdentity.accountId)}&limit=100&cursor=${encodeURIComponent(firstNativeHistory.next!)}`,
      {},
      'alice',
    );
    const nextNativeHistory = await nativeJson<{
      publishedLogs: { id: string; note: string | null }[];
      next: string | null;
    }>(nextNativeHistoryResponse, 200);
    expect(nextNativeHistory.publishedLogs).toHaveLength(1);
    expect(nextNativeHistory.next).toBeNull();
    expect(
      new Set([...firstNativeHistory.publishedLogs, ...nextNativeHistory.publishedLogs].map((log) => log.note)),
    ).toEqual(new Set([...generatedNotes, 'Alice explicitly published this log']));

    const sessionUrl = `${stack.web}/en/library/progress/${encodeURIComponent(bookSessionId)}`;
    navigation = await alicePage.goto(sessionUrl);
    expect(navigation?.status()).toBe(200);
    await hydrated(alicePage);
    const logsRegion = alicePage.getByRole('region', { name: 'Published logs', exact: true });
    await logsRegion.getByText(generatedNotes[0]!, { exact: true }).waitFor({ state: 'visible' });
    const firstNotes = await logsRegion.locator('ol > li p.whitespace-pre-wrap').allTextContents();
    expect(firstNotes).toHaveLength(100);
    expect(firstNotes).toEqual(firstNativeHistory.publishedLogs.map((log) => log.note ?? ''));
    const moreLogs = logsRegion.getByRole('link', { name: 'More published logs', exact: true });
    const emittedCursor = new URL(await moreLogs.getAttribute('href')!, stack.web).searchParams.get('logs');
    expect(emittedCursor).toBe(firstNativeHistory.next);
    const beforeFollowingCursor = stack.kernelRequests().length;
    await moreLogs.click();
    await alicePage.waitForURL((url) => url.searchParams.get('logs') === emittedCursor);
    await stack.kernel('/v1/definitions/active', {}, 'alice');
    const cursorRequest = stack
      .kernelRequests()
      .slice(beforeFollowingCursor)
      .find(({ url }) => url.startsWith('/v1/publishedLogs?'));
    expect(cursorRequest).toBeDefined();
    expect(new URL(cursorRequest!.url, stack.kernelOrigin).searchParams.get('cursor')).toBe(emittedCursor);
    const nextNotes = await logsRegion.locator('ol > li p.whitespace-pre-wrap').allTextContents();
    expect(nextNotes).toEqual(nextNativeHistory.publishedLogs.map((log) => log.note ?? ''));
    expect(await logsRegion.getByRole('link', { name: 'More published logs', exact: true }).count()).toBe(0);

    await alicePage.goto(`${stack.web}/en/logs/${encodeURIComponent(logId)}`);
    await hydrated(alicePage);
    expect(await alicePage.getByRole('button', { name: 'Delete log', exact: true }).count()).toBe(1);
    expect(await alicePage.getByRole('button', { name: /undo/i }).count()).toBe(0);
    await alicePage.getByRole('button', { name: 'Delete log', exact: true }).click();
    await alicePage.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await alicePage.getByRole('status').filter({ hasText: 'This log has been deleted.' }).waitFor({ state: 'visible' });
    const retracted = await stack.kernel(`/v1/publishedLogs/${encodeURIComponent(logId)}`);
    expect(retracted.status).toBe(404);

    expect(browserFailures).toEqual([]);
    expect(
      browserResponses.some(
        ({ method, status, url }) =>
          method === 'GET' && status === 200 && new URL(url).pathname.startsWith('/en/library/progress/'),
      ),
    ).toBe(true);
    console.info(
      `native-holdings-history-receipt: browser-responses=${browserResponses.length} browser-failures=${browserFailures.length} cursor=${emittedCursor}`,
    );
  });

  test('unprofiled subjects refuse new writes without inventing a state, copy kind, or progress unit', async () => {
    const { stack, alicePage, person } = fixture;
    const progressResponse = await alicePage.goto(
      `${stack.web}/en/library/progress?subjectId=${encodeURIComponent(person.id)}`,
    );
    expect(progressResponse?.status()).toBe(200);
    await hydrated(alicePage);
    await alicePage
      .getByRole('status')
      .filter({ hasText: 'This item does not support this kind of progress.' })
      .waitFor({ state: 'visible' });
    expect(await alicePage.getByLabel('Unit', { exact: true }).count()).toBe(0);

    const copiesResponse = await alicePage.goto(
      `${stack.web}/en/library/copies?subjectId=${encodeURIComponent(person.id)}`,
    );
    expect(copiesResponse?.status()).toBe(200);
    await hydrated(alicePage);
    expect(await alicePage.getByRole('button', { name: 'Add a copy', exact: true }).count()).toBe(0);
    await alicePage
      .getByRole('status')
      .filter({ hasText: 'This item’s library profile does not support that copy type and status.' })
      .waitFor({ state: 'visible' });

    const copyRequest = {
      subjectId: person.id,
      kind: 'physical',
      status: 'owned',
      location: null,
      source: null,
      acquiredOn: null,
      disposedOn: null,
      note: null,
    };
    const unsupportedCopyResponse = await postJson(fixture, '/v1/copies', copyRequest);
    const unsupportedCopyBody = await unsupportedCopyResponse.json();
    if (
      unsupportedCopyResponse.status !== 422 ||
      (unsupportedCopyBody as { code?: string }).code !== 'unsupported_library_profile'
    ) {
      throw new Error(
        `Native request POST /v1/copies ${JSON.stringify(copyRequest)} returned ${unsupportedCopyResponse.status} ${JSON.stringify(unsupportedCopyBody)}; expected 422 unsupported_library_profile with no write.`,
      );
    }

    const progressRequest = {
      subjectId: person.id,
      mode: 'scalar_amount',
      unit: 'page',
      total: null,
    };
    const unsupportedProgressResponse = await postJson(fixture, '/v1/progressSessions', progressRequest);
    const unsupportedProgressBody = await unsupportedProgressResponse.json();
    if (
      unsupportedProgressResponse.status !== 422 ||
      (unsupportedProgressBody as { code?: string }).code !== 'unsupported_library_profile'
    ) {
      throw new Error(
        `Native request POST /v1/progressSessions ${JSON.stringify(progressRequest)} returned ${unsupportedProgressResponse.status} ${JSON.stringify(unsupportedProgressBody)}; expected 422 unsupported_library_profile with no write.`,
      );
    }
  });
});
