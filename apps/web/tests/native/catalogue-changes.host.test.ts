import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { expect as pageExpect } from 'playwright/test';
import { m } from '../../src/paraglide/messages.js';
import { languageName } from '../../src/subject/language.ts';
import { valueExplanationHref } from '../../src/features/catalogue/value-explanation.ts';
import { startCatalogueChangesFixture, type CatalogueChangesFixture } from './catalogue-changes-fixture.ts';

let fixture: CatalogueChangesFixture;
beforeAll(async () => {
  fixture = await startCatalogueChangesFixture();
}, 300_000);
afterAll(async () => fixture && fixture.close(), 180_000);

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function explain(page: Page, revision: number): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`Revision ${revision}(?!\\d)`) });
  await pageExpect(button).toBeVisible();
  await button.click();
  await pageExpect(
    page.getByRole('heading', { name: m.changes_revision({ revision: String(revision) }) }),
  ).toBeVisible();
}

async function replaceTermsName(page: Page, name: string): Promise<void> {
  const group = page.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Name' }) });
  await group.locator('select').selectOption('set');
  await group.getByLabel('Name', { exact: true }).fill(name);
}

test('the served Changes route explains native terms and recorded adoption independently of the current reading', async () => {
  const { stack, auth, id, label, path, selected } = fixture;
  const signedIn = await auth.signIn('alice');
  expect(signedIn.url).toStartWith(stack.web);
  expect((await signedIn.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
  const page = signedIn.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.goto(`${stack.web}${path}/changes`, { waitUntil: 'domcontentloaded' });
  await hydrate(page);
  const changes = page.locator('[data-slot="subject-changes"]');
  await pageExpect(changes.getByRole('heading', { name: m.changes_title(), exact: true })).toBeVisible();
  await pageExpect(
    changes.getByRole('button', { name: new RegExp(`Revision ${fixture.termsRevision}(?!\\d)`) }),
  ).toHaveCount(0);

  await changes.getByRole('button', { name: m.changes_more() }).click();
  await pageExpect(
    changes.getByRole('button', { name: new RegExp(`Revision ${fixture.termsRevision}(?!\\d)`) }),
  ).toBeVisible();

  await fixture.setProposalAuthority(false);
  await explain(page, fixture.termsRevision);
  await pageExpect(changes.getByText(m.changes_correction_denied())).toBeVisible();
  await pageExpect(changes.getByRole('link', { name: m.changes_correct_terms() })).toHaveCount(0);
  await pageExpect(changes.getByText(m.changes_terms())).toBeVisible();

  await fixture.setProposalAuthority(true);
  await explain(page, fixture.termsRevision);
  await pageExpect(changes.getByRole('link', { name: m.changes_correct_terms() })).toBeVisible();
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    bodyIncludes: id,
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/overloaded',
      title: 'Overloaded',
      status: 503,
      code: 'overloaded',
      detail: 'PRIVATE ACTION FAILURE',
    }),
  });
  await explain(page, fixture.termsRevision);
  await pageExpect(changes.getByText(m.changes_correction_unavailable())).toBeVisible();
  await pageExpect(changes.getByRole('link', { name: m.changes_correct_terms() })).toHaveCount(0);
  await pageExpect(changes.getByText(m.changes_terms())).toBeVisible();
  expect(await changes.textContent()).not.toContain('PRIVATE ACTION FAILURE');

  await explain(page, fixture.termsRevision);
  const correctionLink = changes.getByRole('link', { name: m.changes_correct_terms() });
  await pageExpect(correctionLink).toBeVisible();
  const beforeCorrectionResponse = await stack.kernel(`/v1/subjects/${id}`);
  expect(beforeCorrectionResponse.status).toBe(200);
  const beforeCorrection = (await beforeCorrectionResponse.json()) as { subject: { revision: number } };
  await correctionLink.click();
  await pageExpect(page.getByRole('heading', { name: 'Edit names and descriptions', exact: true })).toBeVisible();
  await pageExpect(page.getByRole('link', { name: m.changes_return_to_changes() })).toBeVisible();
  const revisedName = `Current correction ${crypto.randomUUID().slice(0, 8)}`;
  await replaceTermsName(page, revisedName);
  await page.getByRole('button', { name: 'Save terms', exact: true }).click();
  await pageExpect(page.getByText('Terms saved.', { exact: true })).toBeVisible();
  await stack.refreshKernelRequests();
  const termsPatch = stack
    .kernelRequests()
    .filter((request) => !request.fixtureRequest && request.method === 'PATCH' && request.url === `/v1/subjects/${id}/terms`)
    .at(-1);
  expect(termsPatch?.ifMatch).toBe(`"${beforeCorrection.subject.revision}"`);
  const correctedResponse = await stack.kernel(`/v1/subjects/${id}`);
  expect(correctedResponse.status).toBe(200);
  const corrected = (await correctedResponse.json()) as { subject: { labels: Record<string, string> } };
  expect(corrected.subject.labels.en).toBe(revisedName);
  await page.getByRole('link', { name: m.changes_return_to_changes() }).click();
  await hydrate(page);
  await pageExpect(changes.getByRole('button', { name: new RegExp(`Revision ${fixture.termsRevision}(?!\\d)`) })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await pageExpect(changes.getByText(m.changes_terms())).toBeVisible();
  await pageExpect(changes.getByRole('link', { name: m.changes_current(), exact: true })).toBeVisible();

  await explain(page, fixture.termsRevision);
  await pageExpect(changes.getByText(m.changes_terms())).toBeVisible();
  await pageExpect(changes.getByText(m.changes_name(), { exact: true })).toBeVisible();
  await pageExpect(changes.getByText(languageName('fr', 'en')!, { exact: true })).toBeVisible();
  await pageExpect(changes.getByText(m.changes_description(), { exact: true })).toBeVisible();
  await pageExpect(changes.getByText(languageName('ja', 'en')!, { exact: true })).toBeVisible();
  await pageExpect(changes.getByText(m.changes_aliases(), { exact: true })).toBeVisible();
  await pageExpect(changes.getByText(languageName('de', 'en')!, { exact: true })).toBeVisible();
  await pageExpect(changes.getByText(m.changes_current_notice())).toBeVisible();
  expect(await changes.textContent()).not.toContain('Personne native');
  expect(await changes.textContent()).not.toContain(selected.content);

  await explain(page, fixture.firstAdoption);
  await pageExpect(changes.getByText(m.changes_adopted_detail())).toBeVisible();
  await pageExpect(changes.getByText(m.context_replace())).toBeVisible();
  await pageExpect(
    changes.getByText(`${m.facts_selected_value({ number: '1' })} · ${m.candidate_rank_normal()}`),
  ).toBeVisible();
  await pageExpect(changes.getByText(m.changes_current_notice())).toBeVisible();
  await pageExpect(changes.getByText(m.context_selected())).toHaveCount(0);

  await explain(page, fixture.firstProposal);
  await pageExpect(changes.getByText(m.changes_proposal_detail())).toBeVisible();
  await pageExpect(changes.getByText(m.value_not_selected())).toBeVisible();

  await explain(page, fixture.secondAdoption);
  await pageExpect(
    changes.getByText(`${m.facts_selected_value({ number: '1' })} · ${m.candidate_rank_preferred()}`),
  ).toBeVisible();

  await explain(page, fixture.firstAdoption);
  await pageExpect(
    changes.getByText(`${m.facts_selected_value({ number: '1' })} · ${m.candidate_rank_normal()}`),
  ).toBeVisible();
  await pageExpect(changes.getByText(m.candidate_rank_preferred())).toHaveCount(0);

  await explain(page, fixture.createRevision);
  await pageExpect(changes.getByText(m.changes_limited())).toBeVisible();

  const detailPath = `/v1/subjects/${id}/revisions/${fixture.termsRevision}`;
  await stack.injectKernelFailureOnce({
    method: 'GET',
    path: detailPath,
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/overloaded',
      title: 'Overloaded',
      status: 503,
      code: 'overloaded',
      detail: 'PRIVATE DETAIL FAILURE',
    }),
  });
  await explain(page, fixture.termsRevision);
  await pageExpect(changes.getByText(m.changes_unavailable())).toBeVisible();
  await pageExpect(changes.getByRole('button', { name: m.changes_retry_detail() })).toBeVisible();
  await pageExpect(
    changes.getByRole('button', { name: new RegExp(`Revision ${fixture.termsRevision}(?!\\d)`) }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await changes.textContent()).not.toContain('PRIVATE DETAIL FAILURE');
  await changes.getByRole('button', { name: m.changes_retry_detail() }).click();
  await pageExpect(changes.getByText(m.changes_terms())).toBeVisible();

  await stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/subjects/${id}/revisions/${fixture.createRevision}`,
    status: 404,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/not_found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'CONCEALED DETAIL',
    }),
  });
  await explain(page, fixture.createRevision);
  await pageExpect(changes.getByText(m.changes_missing())).toBeVisible();
  expect(await changes.textContent()).not.toContain('CONCEALED DETAIL');
  await pageExpect(
    changes.getByRole('button', { name: new RegExp(`Revision ${fixture.createRevision}(?!\\d)`) }),
  ).toHaveAttribute('aria-pressed', 'true');

  await stack.syncKernelRequests();
  const served = stack
    .kernelRequests()
    .filter(
      (request) =>
        !request.fixtureRequest && request.method === 'GET' && request.url.startsWith(`/v1/subjects/${id}/revisions/`),
    );
  expect(served.some((request) => request.url.startsWith(detailPath))).toBe(true);

  await page.goto(
    `${stack.web}${valueExplanationHref({ id, title: label, property: 'schema:url', statement: selected.id }, 'en')}`,
    { waitUntil: 'domcontentloaded' },
  );
  await hydrate(page);
  const why = page.locator('[data-slot="value-explanation"]');
  await pageExpect(why.getByRole('heading', { name: m.value_why(), exact: true })).toBeVisible();
  await pageExpect(why.getByText(selected.content)).toBeVisible();
  await pageExpect(why.getByText(m.changes_proposal_detail())).toBeVisible();
  await pageExpect(why.getByText(m.context_selected())).toBeVisible();
  await pageExpect(why.getByText(m.changes_terms())).toHaveCount(0);
  await pageExpect(why.getByRole('link', { name: m.changes_title(), exact: true })).toBeVisible();
}, 900_000);
