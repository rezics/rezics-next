import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { startAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

const stacks: NativeWebStack[] = [];
const authStacks: Awaited<ReturnType<typeof startAuthStack>>[] = [];
const lifecycle = new NativeTestLifecycle('native private Library export restore walk');
const evidence = resolve(import.meta.dir, '../../../../.temp/private-library-archive-restore');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const messagesRoot = resolve(import.meta.dir, '../../messages');
const repositoryRoot = resolve(import.meta.dir, '../../../..');

function gitHead(): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

setDefaultTimeout(300_000);

nativeBeforeAll(lifecycle, 600_000, async () => {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  stacks.push(await startNativeWebStack());
});

afterEach(async () => {
  for (const auth of authStacks.splice(0).reverse()) await auth.stop();
}, 180_000);

afterAll(async () => {
  for (const stack of stacks.splice(0).reverse()) await stack.stop();
}, 180_000);
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

async function waitForSuggestion(stack: NativeWebStack, id: string, label: string) {
  const until = Date.now() + 60_000;
  const query = `/v1/subjects:suggest?q=${encodeURIComponent(label)}&limit=10&languages=en`;
  while (Date.now() < until) {
    const response = await stack.kernel(query);
    if (response.status === 200) {
      const body = (await response.json()) as { subjects?: { id: string }[] };
      if (body.subjects?.some((item) => item.id === id)) return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Native suggestions did not include ${id} for ${label}`);
}

async function message(locale: (typeof locales)[number], key: string) {
  const body = (await Bun.file(resolve(messagesRoot, `${locale}.json`)).json()) as Record<string, string>;
  return body[key]!;
}

async function openGates(stack: NativeWebStack) {
  for (const group of ['personal_library', 'collections', 'reading_progress'] as const) {
    const opened = await stack.kernel(
      `/v1/platform/exposure/${group}:open`,
      { method: 'POST', headers: { 'idempotency-key': key() } },
      'governor',
    );
    expect(opened.status, await opened.clone().text()).toBe(200);
  }
}

async function prepareOwnerLibrary(stack: NativeWebStack) {
  await openGates(stack);
  const alice = await stack.authPersona('alice');
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
  const active = await json<{ digest: string }>(
    await stack.kernel('/v1/definitions/active'),
    200,
    'active definition',
  );
  const released = await json<{
    release: {
      types: Record<string, { library?: { profileId?: string } }>;
      libraryProfiles: Record<
        string,
        { entryStateSet?: { states: { id: string; role: string }[] } }
      >;
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
          'idempotency-key': crypto.randomUUID(),
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
          'idempotency-key': crypto.randomUUID(),
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
          'idempotency-key': crypto.randomUUID(),
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
          'idempotency-key': crypto.randomUUID(),
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
          'idempotency-key': crypto.randomUUID(),
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
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ after: null }),
      },
      'alice',
    ),
    200,
    'member order',
  );
  const label = await json<{ label: { id: string } }>(
    await stack.kernel(
      '/v1/libraryLabels',
      {
        method: 'POST',
        headers: {
          authorization: alice.authorization,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ name: `Archive label ${marker}` }),
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
          'idempotency-key': crypto.randomUUID(),
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
          'idempotency-key': crypto.randomUUID(),
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
    sessionId: session.progressSession.id,
    stateId: activeState!.id,
  };
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

test('owner exports a populated Library and restores Collection, Entry and progress through actual pages', async () => {
  const stack = stacks[0]!;
  const prepared = await prepareOwnerLibrary(stack);
  const auth = await startAuthStack(stack);
  authStacks.push(auth);
  const signedIn = await auth.signIn('alice', { returnTo: '/en/library/export' });
  const page = signedIn.context.pages().at(-1)!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${stack.web}/en/library/export`, { waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: 'Export your Library' }).waitFor({ state: 'visible' });
  const archivePath = await downloadArchive(page);
  const artifact = JSON.parse(await readFile(archivePath, 'utf8')) as {
    manifest: { version: number; coverage?: string; rows: number; sections: string[] };
    records: { section: string }[];
  };
  expect(artifact.manifest.version).toBe(4);
  expect(artifact.manifest.coverage).toBe('private-library-owner-facts-v4');
  expect(artifact.records.some((row) => row.section === 'entries')).toBe(true);
  expect(artifact.records.some((row) => row.section === 'collections')).toBe(true);
  expect(artifact.records.some((row) => row.section === 'occurrences')).toBe(true);
  expect(artifact.records.some((row) => row.section === 'labels')).toBe(true);
  expect(artifact.records.some((row) => row.section === 'sessions')).toBe(true);
  expect(new TextDecoder().decode(await readFile(archivePath))).toContain('"version":4');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Recover Collections', exact: true }).click();
  await hydrated(page);
  await page.getByRole('heading', { name: 'Recover a curated Collection' }).waitFor({
    state: 'visible',
  });
  await page.getByLabel('Completed Library export file').setInputFiles(archivePath);
  await page.getByRole('button', { name: 'Upload and preview', exact: true }).click();
  await page.getByRole('button', { name: 'Review this Collection', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
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
  const restored = page.locator('[data-receiving-collection]');
  await restored.waitFor({ state: 'visible', timeout: 30_000 });
  const restoredId = await restored.getAttribute('data-receiving-collection');
  expect(restoredId).toBeTruthy();
  expect(restoredId).not.toBe(prepared.collectionId);
  await expect(restored).toContainText('private');
  await expect(restored).toContainText('First archived note');
  await expect(restored).toContainText('Repeated occurrence');
  const nativeCollection = await json<{
    collection: { id: string; title: string; visibility: string; memberCount: number };
  }>(
    await stack.kernel(`/v1/collections/${restoredId}`, undefined, 'alice'),
    200,
    'owner collection readback',
  );
  expect(nativeCollection.collection).toMatchObject({
    id: restoredId,
    title: prepared.collectionTitle,
    visibility: 'private',
    memberCount: 2,
  });
  const members = await json<{ members: { note: string | null; subjectId: string }[] }>(
    await stack.kernel(`/v1/collections/${restoredId}/members?view=FULL&limit=100`, undefined, 'alice'),
    200,
    'owner members readback',
  );
  expect(members.members.map((row) => row.note)).toEqual(['Repeated occurrence', 'First archived note']);
  expect(members.members.every((row) => row.subjectId === prepared.subjectId)).toBe(true);
  const bobDenied = await stack.kernel(`/v1/collections/${restoredId}`, undefined, 'bob');
  expect([403, 404]).toContain(bobDenied.status);

  await page.getByRole('button', { name: 'Start another recovery', exact: true }).click();
  await page.getByRole('button', { name: 'Use the original archive', exact: true }).click();
  await page.getByRole('button', { name: 'Review this Collection', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Cancel recovery', exact: true }).click();
  await page.getByRole('button', { name: 'Stop new recovery steps', exact: true }).click();
  await page.getByRole('button', { name: 'Start another recovery', exact: true }).click();
  await page.getByRole('button', { name: 'Use the original archive', exact: true }).click();
  await page.getByRole('button', { name: 'Review this Collection', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: 'Recover from a Library archive' }).click();
  await hydrated(page);
  await page.getByRole('heading', { name: 'Recover from a Library archive' }).waitFor({ state: 'visible' });
  await page.getByLabel('Choose your completed Library archive').setInputFiles(archivePath);
  await page.getByText('entries', { exact: true }).first().waitFor({ state: 'visible', timeout: 60_000 });
  const entryForm = page.locator('article').filter({ hasText: '· entries ·' }).first();
  await entryForm.getByLabel('Current canonical Subject ID').fill(prepared.subjectId);
  await entryForm.getByRole('button', { name: /Select record / }).click();
  const labelForm = page.locator('article').filter({ hasText: '· labels ·' }).first();
  await labelForm.getByLabel('Choose a label operation').selectOption('create');
  await labelForm.getByRole('button', { name: /Select record / }).click();
  await page.getByRole('button', { name: 'Review selected changes', exact: true }).click();
  await page
    .getByText('I confirm these exact displayed records, review revisions and choices.', { exact: false })
    .waitFor({ state: 'visible' });
  await page
    .getByRole('checkbox', {
      name: 'I confirm these exact displayed records, review revisions and choices. A refreshed review requires confirmation again.',
    })
    .check();
  await page.getByRole('button', { name: 'Apply confirmed changes', exact: true }).click();
  await page.getByRole('button', { name: 'Read actual current facts' }).first().waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Read actual current facts' }).first().click();
  const entryRead = await json<{ libraryEntry: { subjectId: string; state: string } }>(
    await stack.kernel(`/v1/libraryEntries/${prepared.subjectId}`, undefined, 'alice'),
    200,
    'entry readback',
  );
  expect(entryRead.libraryEntry.subjectId).toBe(prepared.subjectId);

  await page.getByRole('link', { name: 'Recover archived progress' }).click();
  await hydrated(page);
  await page.getByLabel('Completed Library export JSON (32 MiB maximum)').setInputFiles(archivePath);
  await page.getByRole('button', { name: 'Map this occurrence', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Map this occurrence', exact: true }).click();
  await page.getByLabel('Current canonical Subject UUID').fill(prepared.subjectId);
  await page.getByRole('button', { name: 'Read current profile choices', exact: true }).click();
  const pair = page.getByLabel('Current mode and unit');
  await pair.waitFor({ state: 'visible', timeout: 30_000 });
  await pair.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Review this exact mapping', exact: true }).click();
  await page
    .getByRole('checkbox', {
      name: 'I reviewed this review ID and mapping and consent to one fresh private Session for this occurrence.',
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

  const bob = await auth.signIn('bob', { returnTo: `/en/collections/${restoredId}` });
  const bobPage = bob.context.pages().at(-1)!;
  await bobPage.goto(`${stack.web}/en/collections/${restoredId}`, { waitUntil: 'domcontentloaded' });
  await hydrated(bobPage);
  await expect(bobPage.getByRole('heading', { name: prepared.collectionTitle })).toHaveCount(0);

  const headings: Record<string, string> = {};
  for (const locale of locales) {
    await page.goto(`${stack.web}/${locale}/library/export`, { waitUntil: 'domcontentloaded' });
    await hydrated(page);
    const expected = await message(locale, 'library_export_title');
    await page.getByRole('heading', { name: expected }).waitFor({ state: 'visible' });
    headings[locale] = expected;
  }
  await page.goto(`${stack.web}/zh-Hant/library/recover-collections`, { waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: await message('zh-Hant', 'library_archive_recovery_title') }).waitFor({
    state: 'visible',
  });
  await page.goto(`${stack.web}/ja/library/recover-archive`, { waitUntil: 'domcontentloaded' });
  await hydrated(page);
  await page.getByRole('heading', { name: await message('ja', 'library_archive_title') }).waitFor({
    state: 'visible',
  });

  await writeFile(
    resolve(evidence, 'provenance.json'),
    JSON.stringify(
      {
        sourceRevision: gitHead(),
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
          progressSessionCount: sessions.progressSessions.length,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
});
