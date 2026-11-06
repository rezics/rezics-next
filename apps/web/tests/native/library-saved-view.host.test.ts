import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle';
import { startNativeWebStack, type NativeWebStack } from './stack';
import { subjectHref } from '../../src/subject/subject-href';
import { m } from '../../src/paraglide/messages.js';

setDefaultTimeout(900_000);

const standardQuestion = '00000000-0000-7000-8000-000000000001';
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const evidenceDirectory = resolve(import.meta.dir, '../../../../.temp/library-saved-view');
const lifecycle = new NativeTestLifecycle('saved Library view');

let stack: NativeWebStack;
let auth: NativeAuthStack;
let fixture: {
  title: string;
  type: string;
  subjectId: string;
  state: string;
  unit: string;
  sessionId: string;
  amount: string;
  labelId: string;
  labelName: string;
  voteUnits: number;
};

nativeBeforeAll(lifecycle, 900_000, async () => {
  stack = await startNativeWebStack();
  await expect(await stack.kernel('/v1/definitions/active')).toBeInstanceOf(Response);
  for (const group of ['personal_library', 'reading_progress'] as const) {
    const opened = await stack.kernel(
      `/v1/platform/exposure/${group}:open`,
      { method: 'POST', headers: { 'idempotency-key': `"${crypto.randomUUID()}"` } },
      'governor',
    );
    expect(opened.status).toBe(200);
  }
  fixture = await seedOwnerLibrary(stack);
  auth = await startAuthStack(stack);
});

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

function key() {
  return `"${crypto.randomUUID()}"`;
}

type ReleaseBody = {
  release: {
    types: Record<string, { library?: { profileId?: string } }>;
    libraryProfiles: Record<
      string,
      {
        entryStateSet?: { states: { id: string; role: string }[] };
        progress?: { allowed?: { mode: string; units?: { id: string }[] }[] };
      }
    >;
  };
};

async function readRelease(native: NativeWebStack) {
  const active = await native.kernel('/v1/definitions/active');
  expect(active.status).toBe(200);
  const { digest } = (await active.json()) as { digest: string };
  const released = await native.kernel(`/v1/definitions/releases/${encodeURIComponent(digest)}`);
  expect(released.status).toBe(200);
  return (await released.json()) as ReleaseBody;
}

async function seedOwnerLibrary(native: NativeWebStack) {
  const owner = await native.authPersona('alice');
  const title = `Saved Library walk ${crypto.randomUUID().slice(0, 8)}`;
  const release = await readRelease(native);
  const type = 'schema:ComicSeries';
  expect(release.release.types[type]?.library?.profileId, 'ComicSeries names its Library profile').toBeDefined();
  const created = await native.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key() },
      body: JSON.stringify({ type, labels: { en: title } }),
    },
    'editor',
  );
  expect(created.status, await created.clone().text()).toBe(201);
  const { subject } = (await created.json()) as { subject: { id: string } };
  const profileId = release.release.types[type]?.library?.profileId;
  expect(profileId, 'the accepted type names its Library profile').toBeDefined();
  const profile = release.release.libraryProfiles[profileId!]!;
  const activeState = profile.entryStateSet?.states.find((state) => state.role === 'active');
  expect(activeState, 'the accepted Library profile has its active state').toBeDefined();
  const unit = profile.progress?.allowed?.find((item) => item.mode === 'scalar_amount')?.units?.[0]?.id;
  expect(unit, 'the accepted Library profile has a scalar progress unit').toBeDefined();
  const entry = await native.kernel(
    `/v1/libraryEntries/${subject.id}`,
    {
      method: 'PUT',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({ state: activeState!.id }),
    },
    'alice',
  );
  expect(entry.status, await entry.clone().text()).toBe(201);
  const started = await native.kernel(
    '/v1/progressSessions',
    {
      method: 'POST',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({
        subjectId: subject.id,
        mode: 'scalar_amount',
        unit,
      }),
    },
    'alice',
  );
  expect(started.status, await started.clone().text()).toBe(201);
  const startedBody = (await started.json()) as {
    progressSession: { id: string; revision: number };
  };
  const recorded = await native.kernel(
    `/v1/progressSessions/${startedBody.progressSession.id}:record`,
    {
      method: 'POST',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({
        revision: startedBody.progressSession.revision,
        amount: '12',
      }),
    },
    'alice',
  );
  expect(recorded.status, await recorded.clone().text()).toBe(200);
  const labelName = `Walk label ${crypto.randomUUID().slice(0, 6)}`;
  const labelCreated = await native.kernel(
    '/v1/libraryLabels',
    {
      method: 'POST',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({ name: labelName }),
    },
    'alice',
  );
  expect(labelCreated.status, await labelCreated.clone().text()).toBe(201);
  const labelBody = (await labelCreated.json()) as { label: { id: string } };
  const assigned = await native.kernel(
    `/v1/libraryLabels/${labelBody.label.id}:assign`,
    {
      method: 'POST',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({ subjectId: subject.id }),
    },
    'alice',
  );
  expect(assigned.status, await assigned.clone().text()).toBe(200);
  const voteUnits = 16;
  const voted = await native.kernel(
    `/v1/subjects/${subject.id}/ratings/${standardQuestion}/vote`,
    {
      method: 'PUT',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({ units: voteUnits }),
    },
    'alice',
  );
  expect(voted.status, await voted.clone().text()).toBe(200);
  return {
    title,
    type,
    subjectId: subject.id,
    state: activeState!.id,
    unit: unit!,
    sessionId: startedBody.progressSession.id,
    amount: '12',
    labelId: labelBody.label.id,
    labelName,
    voteUnits,
  };
}

function writeEvidence(body: Record<string, unknown>) {
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(resolve(evidenceDirectory, 'walk.json'), `${JSON.stringify(body, null, 2)}\n`);
}

function layoutControl(page: Page, name: string) {
  return page
    .getByRole('button', { name })
    .or(page.getByRole('radio', { name }))
    .or(page.getByRole('link', { name }));
}

test('touched Library labels exist in every launch locale', () => {
  for (const locale of locales) {
    expect(m.library_heading({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_nav_labels({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_my_ratings_nav({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_progress_index_refresh({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_continue({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_layout_list({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_sort_created({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_sort_apply({}, { locale }).trim().length).toBeGreaterThan(0);
    expect(m.library_summary_heading({}, { locale }).trim().length).toBeGreaterThan(0);
  }
});

test('the Library owner reads and edits the saved view through native pages and APIs', async () => {
  const owner = await stack.authPersona('alice');
  const journey = await auth.signIn('alice');
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${stack.web}/en/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('heading', { name: m.library_heading() }).waitFor();
  await page.getByText(fixture.title).waitFor();
  const counts = page.getByRole('navigation', { name: m.library_summary_heading() });
  await counts
    .getByRole('link', { name: new RegExp(`${m.library_state_all()}\\s*\\d[\\d,]*\\s*/\\s*\\d`) })
    .waitFor();
  await page.getByRole('link', { name: m.library_nav_labels() }).waitFor();
  await page.locator('[data-received-entry-reading-trigger]').first().waitFor();
  await page.locator('[data-received-entry-reading-trigger]').first().click();
  await page.locator('[data-received-entry-reading]').waitFor();
  expect(await page.locator('[data-entry-reading-progress]').innerText()).toContain('12');
  await page.locator('[data-received-entry-reading-close]').click();

  await layoutControl(page, m.library_layout_list()).click();
  await page.waitForURL(/layout=list/);
  await page.locator('select[name="orderBy"]').waitFor();
  await page.locator('select[name="orderBy"]').selectOption('createdAt');
  await page.getByRole('button', { name: m.library_sort_apply() }).click();
  await page.waitForURL(/orderBy=createdAt/);
  await page.goto(
    `${stack.web}/en/library?layout=list&orderBy=createdAt&state=${encodeURIComponent(fixture.state)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByText(fixture.title).waitFor();

  const subjectUrl = subjectHref({ id: fixture.subjectId, label: fixture.title }, 'en').href;
  await page.getByRole('link', { name: fixture.title }).first().click();
  await page.waitForURL(new RegExp(fixture.subjectId));
  await page.getByRole('heading', { name: fixture.title, exact: true }).waitFor();
  await page.getByRole('heading', { name: m.library_configured_heading() }).waitFor();
  const amount = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: m.library_configured_progress_heading() }) })
    .locator('input');
  await amount.waitFor();
  const stored = await amount.inputValue();
  await page.getByRole('button', { name: m.library_progress_index_refresh() }).click();
  await expect.poll(async () => amount.inputValue()).toBe(stored);
  await amount.fill('9');
  const current = await stack.kernel(`/v1/progressSessions/${fixture.sessionId}?view=FULL`, {}, 'alice');
  expect(current.status).toBe(200);
  const currentBody = (await current.json()) as { progressSession: { revision: number } };
  const recorded = await stack.kernel(
    `/v1/progressSessions/${fixture.sessionId}:record`,
    {
      method: 'POST',
      headers: {
        authorization: owner.authorization,
        'content-type': 'application/json',
        'idempotency-key': key(),
      },
      body: JSON.stringify({
        revision: currentBody.progressSession.revision,
        amount: '15',
        measureId: fixture.unit,
      }),
    },
    'alice',
  );
  expect(recorded.status, await recorded.clone().text()).toBe(200);
  await page.getByRole('button', { name: m.library_progress_index_refresh() }).click();
  await expect.poll(async () => amount.inputValue()).toBe('9');
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  expect(page.url()).toContain('orderBy=createdAt');
  expect(page.url()).toContain('layout=list');
  await page.getByText(fixture.title).waitFor();

  await page.goto(`${stack.web}/en/library/continue`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByText(fixture.title).waitFor();
  await page.getByRole('button', { name: m.home_continue_actions({ title: fixture.title }) }).click();
  const openSubject = page
    .getByRole('menuitem', { name: m.home_continue_open_subject() })
    .or(page.getByRole('link', { name: m.home_continue_open_subject() }));
  await openSubject.click();
  await page.waitForURL(new RegExp(fixture.subjectId));
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.getByText(fixture.title).waitFor();

  await page.goto(`${stack.web}/en/library/progress?subjectId=${fixture.subjectId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByText(fixture.title).waitFor();
  await page.getByRole('button', { name: m.library_progress_index_refresh() }).click();
  await page.getByText(fixture.title).waitFor();

  await page.goto(`${stack.web}/en/library/labels`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByText(fixture.labelName).waitFor();

  await page.goto(`${stack.web}/en/library/ratings`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('heading', { name: m.library_my_ratings_heading() }).waitFor();
  await page.getByText(fixture.title).waitFor();

  await page.goto(`${stack.web}/en/library?layout=list&orderBy=createdAt`, { waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByText(fixture.title).waitFor();
  const listControl = layoutControl(page, m.library_layout_list());
  const box = await listControl.boundingBox();
  expect(box).toBeTruthy();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByText(fixture.title).waitFor();
  await page.emulateMedia({ colorScheme: 'light' });

  for (const locale of ['zh-Hant', 'ja'] as const) {
    await page.goto(`${stack.web}/${locale}/library`, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor();
    await page.getByRole('heading', { name: m.library_heading({}, { locale }) }).waitFor();
    await page.getByText(fixture.title).waitFor();
    await page.getByRole('link', { name: m.library_nav_labels({}, { locale }) }).waitFor();
  }

  const entries = await stack.kernel('/v1/libraryEntries?limit=20&view=FULL', {}, 'alice');
  expect(entries.status, await entries.clone().text()).toBe(200);
  const entryPage = (await entries.json()) as { libraryEntries: { subjectId: string; state: string }[] };
  expect(entryPage.libraryEntries.some((row) => row.subjectId === fixture.subjectId)).toBe(true);
  const summary = await stack.kernel('/v1/libraryShelfSummary', {}, 'alice');
  expect(summary.status, await summary.clone().text()).toBe(200);
  const summaryBody = (await summary.json()) as { tabs: { all: { shown: number; total: number } } };
  expect(summaryBody.tabs.all.total).toBeGreaterThanOrEqual(1);
  const sessions = await stack.kernel(
    `/v1/progressSessions?subjectId=${fixture.subjectId}&limit=100&view=FULL`,
    {},
    'alice',
  );
  expect(sessions.status, await sessions.clone().text()).toBe(200);
  const sessionPage = (await sessions.json()) as {
    progressSessions: { id: string; amount: string | null }[];
  };
  expect(sessionPage.progressSessions.some((row) => row.id === fixture.sessionId)).toBe(true);
  const labels = await stack.kernel('/v1/libraryLabels?limit=20', {}, 'alice');
  expect(labels.status, await labels.clone().text()).toBe(200);
  const vote = await stack.kernel(
    `/v1/subjects/${fixture.subjectId}/ratings/${standardQuestion}/vote`,
    {},
    'alice',
  );
  expect(vote.status, await vote.clone().text()).toBe(200);
  expect(await vote.json()).toMatchObject({ units: fixture.voteUnits });

  await page.goto(`${stack.web}/en/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByText(fixture.title).waitFor();

  writeEvidence({
    sourceRevision: process.env.GOAL_SOURCE_REVISION ?? null,
    personas: ['alice', 'bob'],
    owner: { account: 'alice', role: 'library-owner' },
    subject: { id: fixture.subjectId, type: fixture.type, title: fixture.title },
    native: {
      entryState: fixture.state,
      progressSessionId: fixture.sessionId,
      labelId: fixture.labelId,
      voteUnits: fixture.voteUnits,
      summaryAllTotal: summaryBody.tabs.all.total,
    },
    routes: [
      '/en/library',
      '/en/library/continue',
      '/en/library/progress',
      '/en/library/labels',
      '/en/library/ratings',
      subjectUrl,
    ],
  });
});

test('a different member does not receive the owner Library, labels or vote', async () => {
  const journey = await auth.signIn('bob');
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.goto(`${stack.web}/en/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('heading', { name: m.library_heading() }).waitFor();
  expect(await page.getByText(fixture.title).count()).toBe(0);
  const entries = await stack.kernel('/v1/libraryEntries?limit=20', {}, 'bob');
  expect(entries.status, await entries.clone().text()).toBe(200);
  const entryPage = (await entries.json()) as { libraryEntries: { subjectId: string }[] };
  expect(entryPage.libraryEntries.some((row) => row.subjectId === fixture.subjectId)).toBe(false);
  const labelShelf = await page.goto(`${stack.web}/en/library?label=${fixture.labelId}`);
  expect(labelShelf?.status()).toBe(404);
  const vote = await stack.kernel(
    `/v1/subjects/${fixture.subjectId}/ratings/${standardQuestion}/vote`,
    {},
    'bob',
  );
  expect([401, 403, 404]).toContain(vote.status);
});
