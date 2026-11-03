import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { hydrate, readPublicStatements, readSlotCandidates, waitForSuggestion } from './catalogue-relations-fixture.ts';
import { startCatalogueStoryArcFixture, type NativeStoryArcFixture } from './catalogue-story-arc-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

setDefaultTimeout(900_000);

const storyArcType = 'wd:Q2620972';
const storyArcProperty = 'rezics:storyArc';
const citation = 'https://example.org/native-story-arc-range';
let fixture: NativeStoryArcFixture;

beforeAll(async () => {
  fixture = await startCatalogueStoryArcFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

type CreatedInput = {
  type?: string;
  labels?: Record<string, string>;
  statements?: unknown;
  source?: unknown;
  sourceRecords?: unknown;
};

type RelationProposal = {
  statement?: {
    value?: { content?: unknown };
    qualifiers?: { property?: { id?: string }; value?: { content?: unknown } }[];
    references?: { parts?: { property?: { id?: string }; value?: { content?: unknown } }[] }[];
  };
  source?: unknown;
  sourceRecords?: unknown;
};

function subjectPosts(label: string): NativeKernelRequest[] {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body)
      return false;
    return (JSON.parse(request.body) as CreatedInput).labels?.en === label;
  });
}

function candidatePosts(id: string): NativeKernelRequest[] {
  return fixture.stack
    .kernelRequests()
    .filter(
      (request) =>
        !request.fixtureRequest && request.method === 'POST' && request.url === `/v1/subjects/${id}/candidates`,
    );
}

async function confirmNamed(page: Page, action: string): Promise<void> {
  const group = page.getByRole('group', { name: `Confirm: ${action}` });
  if (!(await group.isVisible())) {
    await page.getByRole('button', { name: action, exact: true }).last().click();
    await playExpect(group).toBeVisible();
  }
  await group.getByRole('button', { name: action, exact: true }).click();
}

async function addQualifier(work: Locator, id: string, label: string, value: string) {
  await work.getByLabel('Qualifier', { exact: true }).selectOption(id);
  await work.getByRole('button', { name: 'Add a qualifier', exact: true }).click();
  await work.getByRole('textbox', { name: label, exact: true }).fill(value);
}

test('creating a story arc keeps parent linking, read recovery, and selection as separate native actions', async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const arcLabel = `Native narrative arc ${marker}`;
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const createPath = `/en/catalogue/story-arc?work=${fixture.parent.id}`;
  const opened = await page.goto(`${fixture.stack.web}${createPath}`, { waitUntil: 'domcontentloaded' });
  expect(opened?.status()).toBe(200);
  await hydrate(page);
  expect(await page.locator('html').getAttribute('lang')).toBe('en');
  expect(new URL(page.url()).pathname).toBe('/en/catalogue/story-arc');
  await playExpect(page.getByRole('heading', { name: fixture.parent.label })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(arcLabel);
  await fixture.stack.injectCreatedSubjectReadFailureOnce({
    status: 503,
    body: '{"title":"Temporarily unavailable"}',
  });
  await page.getByRole('button', { name: 'Create subject', exact: true }).click();
  await playExpect(page.getByRole('status').filter({ hasText: 'Subject created.' })).toBeVisible();
  await playExpect(
    page.getByText('The subject was created, but its ordinary reader is unavailable. Retry opening it.'),
  ).toBeVisible();

  await fixture.stack.syncKernelRequests();
  const created = subjectPosts(arcLabel);
  expect(created).toHaveLength(1);
  expect(created[0]?.responseStatus).toBe(201);
  expect(created[0]?.authorization?.startsWith('Bearer ')).toBe(true);
  const body = JSON.parse(created[0]!.body!) as CreatedInput;
  expect(body.type).toBe(storyArcType);
  expect(body.labels).toEqual({ en: arcLabel });
  expect(body).not.toHaveProperty('statements');
  expect(body).not.toHaveProperty('source');
  expect(body).not.toHaveProperty('sourceRecords');
  const failedRead = fixture.stack
    .kernelRequests()
    .find(
      (request) =>
        request.method === 'GET' && request.url.startsWith('/v1/subjects/') && request.failure?.status === 503,
    );
  expect(failedRead).toBeDefined();
  const arcId = failedRead!.url.slice('/v1/subjects/'.length);
  expect(await readPublicStatements(fixture.stack, fixture.parent.id, storyArcProperty)).toEqual([]);
  const arc = await fixture.stack.kernel(`/v1/subjects/${arcId}`);
  expect(arc.status).toBe(200);
  const arcRead = (await arc.json()) as { subject: { id: string; type: string; statements?: Record<string, unknown> } };
  expect(arcRead.subject).toMatchObject({ id: arcId, type: storyArcType });
  expect(arcRead.subject.statements?.[storyArcProperty]).toBeUndefined();

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await playExpect(page.getByRole('link', { name: 'Connect and correct this arc' })).toBeVisible();
  await waitForSuggestion(fixture.stack, { id: arcId, type: storyArcType, label: arcLabel });
  const editor = subjectHref({ id: arcId, label: arcLabel }, 'en');
  const editorOpened = await page.goto(`${fixture.stack.web}${editor.href}/story-arc?work=${fixture.parent.id}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(editorOpened?.status()).toBe(200);
  await hydrate(page);
  expect(new URL(page.url()).pathname).toBe(`${editor.href}/story-arc`);
  await playExpect(
    page.getByRole('region', { name: 'Arc identity' }).getByText(arcLabel, { exact: true }),
  ).toBeVisible();
  const work = page.getByRole('region', { name: 'Work and arc order' });
  await work.getByRole('button', { name: 'Open relation editor', exact: true }).click();
  await playExpect(work.getByLabel('Relation', { exact: true })).toBeVisible();
  const offered = await work
    .getByLabel('Relation', { exact: true })
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
  expect(offered).toEqual([storyArcProperty]);
  await work.getByLabel('Relation', { exact: true }).selectOption(storyArcProperty);
  const target = work.getByRole('combobox', { name: 'Target subject', exact: true });
  await target.fill(arcLabel);
  await playExpect(page.getByRole('option', { name: arcLabel })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('option', { name: arcLabel }).click();
  await addQualifier(work, 'schema:position', 'position', '1');
  await addQualifier(work, 'rezics:firstPart', 'First part', '1');
  await addQualifier(work, 'rezics:lastPart', 'Last part', '8');
  await work.getByLabel('Citation URL', { exact: true }).fill(citation);
  await work.getByRole('button', { name: 'Add citation', exact: true }).click();
  await confirmNamed(page, 'Propose relation');
  await playExpect(page.getByRole('status').filter({ hasText: 'Relation proposed.' })).toBeVisible();
  await fixture.stack.syncKernelRequests();
  const proposal = candidatePosts(fixture.parent.id).at(-1);
  expect(proposal?.responseStatus).toBe(201);
  const proposed = JSON.parse(proposal!.body!) as RelationProposal;
  expect(proposed.statement?.value?.content).toBe(arcId);
  expect(proposed.statement?.qualifiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        property: expect.objectContaining({ id: 'schema:position' }),
        value: { content: '1' },
      }),
      expect.objectContaining({
        property: expect.objectContaining({ id: 'rezics:firstPart' }),
        value: { content: '1' },
      }),
      expect.objectContaining({
        property: expect.objectContaining({ id: 'rezics:lastPart' }),
        value: { content: '8' },
      }),
    ]),
  );
  expect(proposed.statement?.references?.[0]?.parts).toContainEqual(
    expect.objectContaining({
      property: expect.objectContaining({ id: 'schema:url' }),
      value: expect.objectContaining({ content: citation }),
    }),
  );
  expect(proposed).not.toHaveProperty('source');
  expect(proposed).not.toHaveProperty('sourceRecords');
  expect(await readPublicStatements(fixture.stack, fixture.parent.id, storyArcProperty)).toEqual([]);
  const slot = { property: storyArcProperty, target: arcId };
  const pending = await readSlotCandidates(fixture.stack, fixture.parent.id, slot);
  expect(pending).toHaveLength(1);

  await confirmNamed(page, 'Accept suggestion');
  await playExpect(page.getByRole('status').filter({ hasText: 'Suggestion accepted' })).toBeVisible();
  expect(await readPublicStatements(fixture.stack, fixture.parent.id, storyArcProperty)).toEqual([]);

  await confirmNamed(page, 'Select for public subject');
  await playExpect(
    page.getByRole('status').filter({ hasText: 'This suggestion is selected in the current public subject.' }),
  ).toBeVisible();
  const selected = await readPublicStatements(fixture.stack, fixture.parent.id, storyArcProperty);
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({
    id: pending[0]!.id,
    value: { content: arcId },
  });
  expect(selected[0]?.qualifiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ property: expect.objectContaining({ id: 'schema:position' }) }),
      expect.objectContaining({ property: expect.objectContaining({ id: 'rezics:firstPart' }) }),
      expect.objectContaining({ property: expect.objectContaining({ id: 'rezics:lastPart' }) }),
    ]),
  );
  const stillArc = await fixture.stack.kernel(`/v1/subjects/${arcId}`);
  expect(stillArc.status).toBe(200);
  expect(((await stillArc.json()) as { subject: { type: string } }).subject.type).toBe(storyArcType);
  await page.close();
});

test('a Realm address stays unavailable, and a volume, season or release is not an arc', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const realm = crypto.randomUUID();
  await fixture.stack.syncKernelRequests();
  const start = fixture.stack.kernelRequests().length;
  const realmOpened = await page.goto(`${fixture.stack.web}/en/catalogue/story-arc?realm=${realm}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(realmOpened?.status()).toBe(200);
  await hydrate(page);
  await playExpect(
    page.getByText('Relation contributions are available from the canonical Global reading.'),
  ).toBeVisible();
  expect(await page.getByRole('button', { name: 'Create subject', exact: true }).count()).toBe(0);

  for (const subject of [fixture.volume, fixture.season, fixture.release]) {
    const href = `${subjectHref(subject, 'en').href}/story-arc`;
    const opened = await page.goto(`${fixture.stack.web}${href}`, { waitUntil: 'domcontentloaded' });
    expect(opened?.status()).toBe(200);
    await hydrate(page);
    await playExpect(page.getByRole('alert').filter({ hasText: 'Check the value and citations.' })).toBeVisible();
    expect(await page.getByRole('button', { name: 'Create subject', exact: true }).count()).toBe(0);
    expect(await page.getByRole('heading', { name: subject.label, exact: true }).count()).toBe(0);
  }
  await fixture.stack.syncKernelRequests();
  expect(
    fixture.stack
      .kernelRequests()
      .slice(start)
      .filter((request) => !request.fixtureRequest && request.method === 'POST' && request.url === '/v1/subjects'),
  ).toEqual([]);
  await page.close();
});
