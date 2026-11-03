import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { m } from '../../src/paraglide/messages.js';
import { candidateContext } from '../../src/subject/candidates.ts';
import {
  createNativeCatalogueWorkPartsFixture,
  type NativeCatalogueWorkPartsFixture,
  type WorkPartsSubject,
} from './catalogue-work-parts-fixture.ts';
import { hydrate } from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCatalogueWorkPartsFixture;

beforeAll(async () => {
  fixture = await createNativeCatalogueWorkPartsFixture();
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

async function openWorkParts(page: Page, subject: WorkPartsSubject): Promise<void> {
  const navigation = await page.goto(`${fixture.stack.web}${subjectHref(subject, 'en').href}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(navigation?.status()).toBe(200);
  await hydrate(page);
  const contents = page.getByRole('link', { name: m.subject_contents(), exact: true });
  await playExpect(contents).toBeVisible();
  await contents.click();
  const editor = page.getByRole('link', { name: m.work_parts_title(), exact: true });
  await playExpect(editor).toBeVisible();
  await editor.click();
  await playExpect(page.getByLabel('Relation', { exact: true })).toBeVisible();
}

async function confirm(page: Page, label: string): Promise<void> {
  const action = page.getByRole('button', { name: label, exact: true });
  await action.first().click();
  const group = page.getByRole('group', { name: `Confirm: ${label}`, exact: true });
  await playExpect(group).toBeVisible();
  await group.getByRole('button', { name: label, exact: true }).click();
}

function requests(path: string, method: string) {
  return fixture.stack.kernelRequests().filter(
    (request) => request.method === method && request.url.split('?')[0] === path && !request.fixtureRequest,
  );
}

type PublicSubject = {
  subject: {
    statements: Record<
      string,
      {
        value: { type: string; content?: unknown };
        qualifiers: { property: { id: string }; value: { type: string; content?: unknown } }[];
        references: { parts: { property: { id: string }; value: { type: string; content?: unknown } }[] }[];
      }[]>;
  };
};

async function publicSubject(id: string): Promise<PublicSubject> {
  const response = await fixture.stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PublicSubject;
}

describe('native catalogue work-parts correction', () => {
  test('Contents continues native members, conceals failed reads, and selects a correction from the owning part', async () => {
    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    try {
      await openWorkParts(page, fixture.series);
      const relation = page.getByLabel('Relation', { exact: true });
      await relation.selectOption({ label: 'Members' });
      await playExpect(page.getByRole('button', { name: m.work_parts_more(), exact: true })).toBeVisible();
      await playExpect(page.getByRole('status').filter({ hasText: '21' }).first()).toBeVisible();
      await playExpect(page.getByText(m.work_parts_slice(), { exact: false })).toBeVisible();
      const accuracy = fixture.memberStream.count.exact ? m.work_parts_exact() : m.work_parts_at_least();
      await playExpect(
        page.getByRole('status').filter({ hasText: `${accuracy}: ${fixture.memberStream.count.value}` }).first(),
      ).toBeVisible();
      const freshness = page.getByText(m.work_parts_pending(), { exact: true });
      if (fixture.memberStream.caughtUp) await playExpect(freshness).not.toBeVisible();
      else await playExpect(freshness).toBeVisible();

      await page.getByRole('button', { name: m.work_parts_more(), exact: true }).click();
      const lastBook = fixture.books[20]!;
      await playExpect(page.getByRole('heading', { name: lastBook.label, exact: true })).toBeVisible();
      await playExpect(page.getByRole('heading', { name: fixture.books[0]!.label, exact: true })).not.toBeVisible();

      const linkReadsBeforeMore = requests(`/v1/subjects/${fixture.series.id}/links`, 'GET');
      const continued = linkReadsBeforeMore.at(-1);
      expect(continued?.responseStatus).toBe(200);
      const continuation = new URLSearchParams(continued?.url.split('?')[1] ?? '').get('cursor');
      expect(continuation).toBeTruthy();
      expect(new URLSearchParams(continued?.url.split('?')[1] ?? '').get('context')).toBe(candidateContext);

      await page.getByRole('button', { name: m.work_parts_correct(), exact: true }).click();
      const position = page.getByLabel('position', { exact: true });
      await playExpect(position).toHaveValue('21');
      await position.fill('22');

      await fixture.stack.injectKernelFailureOnce({
        method: 'GET',
        path: `/v1/subjects/${fixture.series.id}/links`,
        status: 503,
        body: JSON.stringify({
          type: 'https://rezics.com/problems/overloaded',
          title: 'Overloaded',
          status: 503,
          code: 'overloaded',
        }),
      });
      const reload = () => page.getByRole('button', { name: m.candidate_reload(), exact: true }).last();
      await reload().click();
      await playExpect(page.getByRole('alert')).toBeVisible();
      await fixture.stack.syncKernelRequests();
      expect(requests(`/v1/subjects/${fixture.series.id}/links`, 'GET').at(-1)?.responseStatus).toBe(503);
      await playExpect(page.getByRole('heading', { name: lastBook.label, exact: true })).not.toBeVisible();
      await reload().click();
      await playExpect(page.getByRole('heading', { name: lastBook.label, exact: true })).toBeVisible();
      await playExpect(position).toHaveValue('22');
      await fixture.stack.syncKernelRequests();
      expect(requests(`/v1/subjects/${fixture.series.id}/links`, 'GET').at(-1)?.responseStatus).toBe(200);

      await confirm(page, m.relation_propose());
      await playExpect(page.getByText(m.relation_proposed(), { exact: true })).toBeVisible();
      await fixture.stack.syncKernelRequests();
      const proposalRequest = requests(`/v1/subjects/${lastBook.id}/candidates`, 'POST').at(-1);
      expect(proposalRequest?.responseStatus).toBe(201);
      expect(proposalRequest?.idempotencyKey).toBeTruthy();
      expect(proposalRequest?.session).toBeTruthy();
      const proposal = JSON.parse(proposalRequest?.body ?? 'null') as {
        statement: {
          property: { id: string };
          value: { type: string; content?: unknown };
          qualifiers: { property: { id: string }; value: { type: string; content?: unknown } }[];
          references: { parts: { property: { id: string }; value: { type: string; content?: unknown } }[] }[];
        };
      };
      expect(proposal.statement.property.id).toBe('wdt:P179');
      expect(proposal.statement.value.content).toBe(fixture.series.id);
      expect(proposal.statement.qualifiers).toEqual([
        expect.objectContaining({
          property: { id: 'schema:position' },
          value: expect.objectContaining({ type: 'value', content: '22' }),
        }),
      ]);
      expect(proposal.statement.references).toHaveLength(2);
      expect(proposal.statement.references.map((reference) => reference.parts.length)).toEqual([1, 1]);
      expect(
        proposal.statement.references.map((reference) => reference.parts[0]?.property.id),
      ).toEqual(['schema:url', 'schema:url']);
      const slotReads = requests(`/v1/subjects/${lastBook.id}/candidates`, 'GET');
      const slotQuery = new URLSearchParams(slotReads.at(-1)?.url.split('?')[1] ?? '');
      expect(slotQuery.get('property')).toBe('wdt:P179');
      expect(slotQuery.get('target')).toBe(fixture.series.id);
      expect(slotQuery.get('context')).toBe(candidateContext);
      expect(slotQuery.has('key')).toBe(false);

      const beforeSelection = await publicSubject(lastBook.id);
      const current = beforeSelection.subject.statements['wdt:P179']?.[0];
      expect(current?.qualifiers.find((snak) => snak.property.id === 'schema:position')?.value.content).toBe('21');

      const review = page.getByRole('region', { name: m.relation_review_slot(), exact: true });
      await review.getByRole('button', { name: m.candidate_accept(), exact: true }).waitFor({ state: 'visible' });
      await confirm(page, m.candidate_accept());
      await playExpect(page.getByText(m.candidate_accepted(), { exact: true })).toBeVisible();
      await review.getByRole('button', { name: m.candidate_reload(), exact: true }).click();
      await review.getByRole('button', { name: m.candidate_adopt(), exact: true }).waitFor({ state: 'visible' });
      const streamReadsBeforeSelection = requests(`/v1/subjects/${fixture.series.id}/links`, 'GET').length;
      await confirm(page, m.candidate_adopt());
      await playExpect(page.getByRole('status').filter({ hasText: m.candidate_selected() })).toBeVisible();
      await fixture.stack.syncKernelRequests();
      const streamReads = requests(`/v1/subjects/${fixture.series.id}/links`, 'GET');
      expect(streamReads.length).toBeGreaterThan(streamReadsBeforeSelection);
      const selectedRead = streamReads.at(-1)!;
      expect(selectedRead.responseStatus).toBe(200);
      const selectedQuery = new URLSearchParams(selectedRead.url.split('?')[1] ?? '');
      expect(selectedQuery.get('cursor')).toBe(continuation);
      expect(selectedQuery.get('property')).toBe('wdt:P179');

      const afterSelection = await publicSubject(lastBook.id);
      const selected = afterSelection.subject.statements['wdt:P179']?.[0];
      expect(selected?.qualifiers.find((snak) => snak.property.id === 'schema:position')?.value.content).toBe('22');
    } finally {
      await page.close();
    }
  });

  test('position correction preserves other qualifiers and citations, separate targets, and unsupported Context', async () => {
    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    try {
      await openWorkParts(page, fixture.series);
      await page.getByLabel('Relation', { exact: true }).selectOption({ label: 'Story arcs' });
      await playExpect(page.getByRole('heading', { name: fixture.firstArc.label, exact: true })).toBeVisible();
      await page.getByRole('button', { name: m.work_parts_correct(), exact: true }).click();
      const position = page.getByLabel('position', { exact: true });
      await playExpect(position).toHaveValue('1');
      await position.fill('2');
      await confirm(page, m.relation_propose());
      await playExpect(page.getByText(m.relation_proposed(), { exact: true })).toBeVisible();
      await fixture.stack.syncKernelRequests();
      const proposalRequest = requests(`/v1/subjects/${fixture.series.id}/candidates`, 'POST').at(-1);
      expect(proposalRequest?.responseStatus).toBe(201);
      const proposal = JSON.parse(proposalRequest?.body ?? 'null') as {
        statement: {
          property: { id: string };
          value: { type: string; content?: unknown };
          qualifiers: { property: { id: string }; value: { type: string; content?: unknown } }[];
          references: { parts: { property: { id: string }; value: { type: string; content?: unknown } }[] }[];
        };
      };
      expect(proposal.statement.property.id).toBe('rezics:storyArc');
      expect(proposal.statement.value.content).toBe(fixture.firstArc.id);
      expect(proposal.statement.qualifiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: { id: 'rezics:firstPart' },
            value: expect.objectContaining({ content: '1' }),
          }),
          expect.objectContaining({
            property: { id: 'rezics:lastPart' },
            value: expect.objectContaining({ content: '2' }),
          }),
          expect.objectContaining({
            property: { id: 'schema:position' },
            value: expect.objectContaining({ content: '2' }),
          }),
        ]),
      );
      expect(proposal.statement.references).toHaveLength(2);
      expect(proposal.statement.references.map((reference) => reference.parts.length)).toEqual([1, 1]);

      const beforeSelection = await publicSubject(fixture.series.id);
      const originalArcs = beforeSelection.subject.statements['rezics:storyArc'];
      expect(originalArcs).toHaveLength(1);
      expect(originalArcs?.[0]?.value.content).toBe(fixture.firstArc.id);
      expect(originalArcs?.[0]?.qualifiers.find((snak) => snak.property.id === 'schema:position')?.value.content).toBe(
        '1',
      );

      const picker = page.getByRole('combobox', { name: m.work_parts_pick(), exact: true });
      await picker.fill(fixture.secondArc.label);
      await playExpect(page.getByRole('option', { name: fixture.secondArc.label, exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole('option', { name: fixture.secondArc.label, exact: true }).click();
      await page.getByRole('button', { name: m.work_parts_draft(), exact: true }).click();
      const newEditor = page.getByRole('region', { name: m.relation_title(), exact: true }).last();
      await playExpect(newEditor).toBeVisible();
      await newEditor.getByRole('button', { name: m.relation_review_slot(), exact: true }).click();
      await playExpect(
        newEditor.getByText(`${fixture.series.id} · rezics:storyArc · ${fixture.secondArc.id}`, { exact: true }),
      ).toBeVisible();
      await fixture.stack.syncKernelRequests();
      const newSlotRead = requests(`/v1/subjects/${fixture.series.id}/candidates`, 'GET').at(-1);
      const newSlot = new URLSearchParams(newSlotRead?.url.split('?')[1] ?? '');
      expect(newSlot.get('property')).toBe('rezics:storyArc');
      expect(newSlot.get('target')).toBe(fixture.secondArc.id);
      expect(newSlot.get('context')).toBe(candidateContext);
      expect(newSlot.has('key')).toBe(false);
      await playExpect(page.getByRole('heading', { name: fixture.firstArc.label, exact: true })).toBeVisible();
      const original = await publicSubject(fixture.series.id);
      expect(original.subject.statements['rezics:storyArc']).toHaveLength(1);
      expect(original.subject.statements['rezics:storyArc']?.[0]?.value.content).toBe(fixture.firstArc.id);

      await fixture.stack.syncKernelRequests();
      const beforeUnsupported = fixture.stack.kernelRequests().length;
      const context = crypto.randomUUID();
      const unsupported = `${fixture.stack.web}${subjectHref(fixture.series, 'en').href}/work-parts?context=${context}`;
      const response = await page.goto(unsupported, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await hydrate(page);
      await playExpect(page.getByText(m.relation_context(), { exact: true })).toBeVisible();
      await fixture.stack.syncKernelRequests();
      expect(
        fixture.stack
          .kernelRequests()
          .slice(beforeUnsupported)
          .filter((request) => request.url.split('?')[0] === `/v1/subjects/${fixture.series.id}`),
      ).toHaveLength(0);
    } finally {
      await page.close();
    }
  });
});
