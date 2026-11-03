import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { expect as ui } from 'playwright/test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { applyReuse, previewReuse, referenceGroupLimit } from '../../src/features/catalogue/reference-reuse.ts';
import { factHolder, stageFact, type FactDraft } from '../../src/features/catalogue/subject-facts.ts';
import { subjectFactsFixture } from '../../src/kernel/fake/subject-facts.ts';
import {
  startCatalogueFactsFixture,
  type CatalogueFactsFixture,
  type CatalogueFactsStatement,
} from './catalogue-facts-fixture.ts';

setDefaultTimeout(900_000);
let fixture: CatalogueFactsFixture;

beforeAll(async () => {
  fixture = await startCatalogueFactsFixture();
}, 600_000);
afterAll(async () => fixture?.close(), 180_000);

const extra = {
  property: { id: 'schema:inLanguage' },
  value: { type: 'value' as const, content: 'fr' },
};

test('reuse copies a complete group, refuses over-limit and locked targets, and keeps independent clones', async () => {
  const fake = subjectFactsFixture();
  const read = await fake.transport.read();
  if (!read.ok) throw new Error('Expected current facts');
  const date = stageFact(read, 'schema:datePublished', read.public.subject.statements['schema:datePublished']![0]!.id)!;
  const language = stageFact(read, 'schema:inLanguage', read.public.subject.statements['schema:inLanguage']![0]!.id)!;
  const group = { parts: [...date.statement.references[0]!.parts, extra] };
  date.statement.references[0] = structuredClone(group);
  language.statement.value = { type: 'value', content: 'de' };
  const copied = applyReuse(
    [date, language],
    { holder: factHolder(date), property: date.property, groupIndex: 0, snapshot: structuredClone(group) },
    [factHolder(language)],
    read.release,
  );
  expect(copied.applied).toEqual([{ holder: factHolder(language), property: language.property, index: 1 }]);
  expect(copied.drafts[1]!.statement.references).toHaveLength(2);
  expect(copied.drafts[1]!.statement.references[1]).toEqual(group);
  expect(copied.drafts[1]!.statement.references[1]).not.toBe(copied.drafts[0]!.statement.references[0]);
  copied.drafts[1]!.statement.references[1]!.parts[1]!.value = { type: 'value', content: 'ja' };
  expect(copied.drafts[0]!.statement.references[0]!.parts[1]!.value).toEqual({ type: 'value', content: 'fr' });

  const full: FactDraft = {
    ...language,
    statement: { ...language.statement, references: Array.from({ length: referenceGroupLimit }, () => structuredClone(group)) },
  };
  expect(previewReuse(full, group, bundledRelease, factHolder(date))).toEqual({ ok: false, reason: 'limit' });

  const locked: FactDraft = {
    ...date,
    command: { id: fake.date.id, key: '00000000-0000-4000-8000-000000000001', statement: date.statement },
  };
  const skipped = applyReuse(
    [locked, language],
    {
      holder: factHolder(language),
      property: language.property,
      groupIndex: 0,
      snapshot: structuredClone(language.statement.references[0]!),
    },
    [factHolder(locked)],
    read.release,
  );
  expect(skipped.refused[0]?.reason).toBe('locked');
  expect(skipped.drafts[0]!.command).toEqual(locked.command);
});

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${action}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

async function open(page: Page) {
  const response = await page.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.getByRole('heading', { name: 'Edit facts', exact: true }).waitFor({ state: 'visible' });
}

async function stage(page: Page, field: string) {
  const region = page.getByRole('region', { name: field, exact: true });
  await region.getByRole('button', { name: 'Edit this field', exact: true }).click();
  await region.getByText('Private proposal draft').waitFor({ state: 'visible' });
}

async function addPart(group: Locator, property: string, label: RegExp, value: string) {
  await group.getByLabel('Add citation part', { exact: true }).selectOption(property);
  await group.getByRole('button', { name: 'Add', exact: true }).click();
  const part = group.locator('div[data-statement-addition]').filter({ hasText: label }).last();
  await part.getByRole('textbox').fill(value);
}

test('production Edit facts copies a multi-part reference into two drafts and proposes the reviewed bodies', async () => {
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page);
  await stage(page, 'publication date');
  await page.getByRole('region', { name: 'publication date', exact: true }).getByLabel('Day', { exact: true }).fill('8');
  const dateRefs = page.getByRole('region', { name: 'publication date', exact: true }).getByRole('group', { name: /Citations 1/ });
  await addPart(dateRefs, 'schema:inLanguage', /language/i, 'fr');
  await stage(page, 'language');
  await page.getByRole('region', { name: 'language', exact: true }).getByLabel('Value', { exact: true }).fill('ja');
  await stage(page, 'URL');
  await page.getByRole('region', { name: 'URL', exact: true }).getByLabel('URL', { exact: true }).fill('https://example.org/catalogue-facts/reused');

  await dateRefs.getByRole('button', { name: /Reuse this reference/ }).click();
  const panel = page.locator('[data-fact-reuse]');
  await panel.waitFor({ state: 'visible' });
  await ui(panel.getByText('fr', { exact: true })).toBeVisible();
  await panel.getByRole('checkbox', { name: 'language', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'URL', exact: true }).click();
  await panel.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();
  await ui(panel.getByText('Copied onto 2 drafts.', { exact: true })).toBeVisible();

  const languageRefs = page.getByRole('region', { name: 'language', exact: true }).getByRole('group', { name: /Citations 2/ });
  await ui(languageRefs.getByText('fr', { exact: true })).toBeVisible();
  const urlRefs = page.getByRole('region', { name: 'URL', exact: true }).getByRole('group', { name: /Citations 2/ });
  await ui(urlRefs.getByText('fr', { exact: true })).toBeVisible();
  await languageRefs.locator('div[data-statement-addition]').filter({ hasText: /language/i }).getByRole('textbox').fill('nl');
  await ui(dateRefs.getByText('fr', { exact: true })).toBeVisible();
  await ui(urlRefs.getByText('fr', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Review included changes', exact: true }).click();
  await page.getByRole('button', { name: 'Submit included changes / retry unresolved', exact: true }).click();
  await ui(page.getByText('Proposed, awaiting review.', { exact: false })).toHaveCount(3);

  const subject = new URL(fixture.path, fixture.stack.web).pathname.split('/')[3]!;
  const query = (property: string) =>
    `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '20' })}`;
  const [language, url] = await Promise.all([
    json<{ candidates: { statement: CatalogueFactsStatement }[] }>(
      await fixture.stack.kernel(query('schema:inLanguage'), {}, 'alice'),
      200,
      'language candidates',
    ),
    json<{ candidates: { statement: CatalogueFactsStatement }[] }>(
      await fixture.stack.kernel(query('schema:url'), {}, 'alice'),
      200,
      'url candidates',
    ),
  ]);
  expect(
    language.candidates.some((candidate) =>
      candidate.statement.references.some((reference) =>
        reference.parts.some(
          (part) =>
            part.property.id === 'schema:inLanguage' &&
            JSON.stringify(part.value) === JSON.stringify({ type: 'value', content: 'nl' }),
        ),
      ),
    ),
  ).toBe(true);
  expect(
    url.candidates.some((candidate) =>
      candidate.statement.references.some((reference) =>
        reference.parts.some(
          (part) => part.property.id === 'schema:inLanguage' && JSON.stringify(part.value) === JSON.stringify({ type: 'value', content: 'fr' }),
        ),
      ),
    ),
  ).toBe(true);
});
