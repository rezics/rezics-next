import { afterAll, expect } from 'bun:test';
import { documentText, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Page } from 'playwright';
import { expect as visible } from 'playwright/test';
import { GLOBAL_CONTEXT } from '../../../services/kernel/src/semantic/definitions.ts';
import { m } from '../src/paraglide/messages.js';
import { authoredGlobalVisitHref, authoredPublicCorrectionHref } from '../src/features/catalogue/authored-public-visit';
import { subjectHref } from '../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './native/auth-stack.ts';
import {
  createCatalogueReviewSubject,
  grantCatalogueReviewAuthority,
  listCatalogueReviewCandidates,
  publicLanguages,
  readPublicSubject,
} from './native/catalogue-review-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './native/lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './native/stack.ts';

const property = 'schema:abstract';
const title = 'Cited editorial publication';
const currentText = 'The existing public abstract remains selected.';
const replacementText = 'An original account of the book, written for this catalogue.';
const citation = 'https://catalogue.example.test/editorial/abstract';
const lifecycle = new NativeTestLifecycle('cited editorial seeded journey');
let stack: NativeWebStack;
let auth: NativeAuthStack;
let subjectId: string;
let publicHref: string;

async function hydrate(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function json<T>(response: Response, status: number, action: string): Promise<T> {
  const text = await response.text();
  expect(response.status, `${action}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

nativeBeforeAll(lifecycle, 360_000, async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  const [alice, bob] = await Promise.all([auth.signIn('alice'), auth.signIn('bob')]);
  if ((await alice.response()).status() !== 200 || (await bob.response()).status() !== 200)
    throw new Error('Native Alice and Bob must sign in through the served Auth forms');
  await grantCatalogueReviewAuthority(stack);
  const aliceId = (await stack.authPersona('alice')).accountId;
  const grant = await stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: aliceId },
        actions: ['context:accept', 'context:adopt', 'context:create'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  expect(grant.status, await grant.text()).toBe(201);

  const created = await stack.kernel(
    '/v1/subjects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({
        type: 'schema:Book',
        labels: { en: title },
        statements: {
          [property]: [
            {
              property: { id: property },
              value: {
                type: 'value',
                content: { document: fromPlainText(currentText), language: 'en', licence: 'CC-BY-4.0' },
              },
              references: [
                { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
              ],
              qualifiers: [],
              rank: 'normal',
            },
          ],
        },
      }),
    },
    'editor',
  );
  const createdBody = await json<{ subject: { id: string } }>(created, 201, 'create cited book');
  subjectId = createdBody.subject.id;
  publicHref = subjectHref({ id: subjectId, label: title }, 'en').href;
});

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

nativeTest(
  'cited editorial contribution through publication completes for every served persona',
  900_000,
  async () => {
    const competing = await createCatalogueReviewSubject(stack);
    const bobPage = await (await auth.context('bob')).newPage();
    bobPage.setDefaultTimeout(30_000);
    await bobPage.goto(new URL(`${competing.href}?candidateField=schema:inLanguage`, stack.web).href, {
      waitUntil: 'domcontentloaded',
    });
    await hydrate(bobPage);
    await bobPage.getByRole('button', { name: 'Review proposals', exact: true }).click();
    await bobPage.locator('#candidate-field').selectOption('schema:inLanguage');
    await bobPage.locator('[data-candidate-item]').first().waitFor({ state: 'visible' });
    await bobPage
      .locator('[data-candidate-item]')
      .filter({ hasText: 'Japanese' })
      .getByRole('button', { name: 'Review suggestion', exact: true })
      .click();
    await bobPage.getByRole('button', { name: 'Accept suggestion', exact: true }).last().click();
    const acceptRegion = bobPage.locator('section[aria-labelledby]').filter({ hasText: 'Confirm: Accept suggestion' });
    await acceptRegion.waitFor({ state: 'visible' });
    await acceptRegion.getByRole('button', { name: 'Accept suggestion', exact: true }).click();
    await bobPage.getByRole('status').filter({ hasText: 'Suggestion accepted' }).waitFor({ state: 'visible' });
    expect(publicLanguages((await readPublicSubject(stack, competing.id)).subject)).toEqual([]);

    await bobPage.getByRole('button', { name: 'Reload current values', exact: true }).click();
    const japanese = bobPage.locator('[data-candidate-choice]').filter({ hasText: 'Japanese' });
    const japaneseBox = japanese.getByRole('checkbox');
    await japaneseBox.waitFor({ state: 'visible' });
    if (!(await japaneseBox.isChecked())) await japaneseBox.click();
    await bobPage.locator(`#rank-${competing.japanese.id}`).selectOption('preferred');
    await bobPage.getByRole('button', { name: 'Select for public subject', exact: true }).last().click();
    const adoptRegion = bobPage
      .locator('section[aria-labelledby]')
      .filter({ hasText: 'Confirm: Select for public subject' });
    await adoptRegion.waitFor({ state: 'visible' });
    await adoptRegion.getByRole('button', { name: 'Select for public subject', exact: true }).click();
    await bobPage
      .getByRole('status')
      .filter({ hasText: 'The public reader confirms this selection' })
      .waitFor({ state: 'visible' });
    await bobPage.close();

    const publicAfter = publicLanguages((await readPublicSubject(stack, competing.id)).subject);
    expect(publicAfter).toEqual([{ id: competing.japanese.id, rank: 'preferred', content: 'ja' }]);
    const listed = await listCatalogueReviewCandidates(stack, competing.id);
    expect(listed.candidates.find((item) => item.id === competing.japanese.id)?.decision).toBe('accepted');
    expect(listed.candidates.find((item) => item.id === competing.korean.id)?.decision ?? null).toBeNull();

    const anonymous = await (await auth.context('anonymous')).newPage();
    anonymous.setDefaultTimeout(30_000);
    const publicPage = await anonymous.goto(new URL(competing.href, stack.web).href, { waitUntil: 'domcontentloaded' });
    expect(publicPage?.status()).toBe(200);
    await hydrate(anonymous);
    const visibleText = await anonymous.locator('main').innerText();
    expect(visibleText).toContain(competing.label);
    expect(visibleText).toContain('Japanese');
    expect(visibleText).not.toContain(competing.korean.id);
    expect(publicPage?.request().headers().authorization).toBeUndefined();
    await anonymous.setViewportSize({ width: 390, height: 844 });
    await visible(anonymous.locator('main')).toBeVisible();
    await anonymous.setViewportSize({ width: 1280, height: 900 });
    await visible(anonymous.locator('main')).toBeVisible();
    await anonymous.close();

    const alice = await auth.signIn('alice');
    const page = await alice.context.newPage();
    page.setDefaultTimeout(30_000);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const authoredHref = `${publicHref}/authored`;
      await page.goto(`${stack.web}${authoredHref}`, { waitUntil: 'domcontentloaded' });
      await hydrate(page);
      const form = page.locator('form');
      await visible(form).toBeVisible();
      const editor = form.locator('.ProseMirror');
      await visible(page.getByRole('region', { name: m.authored_selected() })).toContainText(currentText);
      await editor.fill(replacementText);
      await form.getByLabel(m.authored_language()).fill('en');
      await form.getByLabel(m.authored_licence()).fill('CC-BY-4.0');
      await form.getByLabel(m.authored_citation()).fill(citation);
      await form.getByRole('checkbox', { name: m.authored_original() }).click();
      const candidatePath = `/v1/subjects/${subjectId}/candidates`;
      const observedFrom = stack.kernelRequests().length;
      let droppedResponse: { status: number; body: string } | undefined;
      const dropFirstProposalResponse = async (route: import('playwright').Route) => {
        if (
          !droppedResponse &&
          route.request().method() === 'POST' &&
          route.request().postData()?.includes(replacementText)
        ) {
          const response = await route.fetch();
          droppedResponse = { status: response.status(), body: await response.text() };
          await route.abort('failed');
          return;
        }
        await route.continue();
      };
      await page.route('**/_serverFn/**', dropFirstProposalResponse);
      await form.getByRole('button', { name: m.correction_submit() }).focus();
      await page.keyboard.press('Enter');
      const retry = page.getByRole('button', { name: m.correction_retry() });
      await visible(retry).toBeVisible();
      await retry.click();
      await page.unroute('**/_serverFn/**', dropFirstProposalResponse);
      await visible(page.getByRole('button', { name: m.correction_review() })).toBeVisible();
      await visible(page.getByRole('region', { name: m.authored_selected() })).toContainText(currentText);
      await visible(page.getByRole('region', { name: m.authored_selected() })).not.toContainText(replacementText);
      await stack.syncKernelRequests();
      const attempts = stack
        .kernelRequests()
        .slice(observedFrom)
        .filter((request) => request.method === 'POST' && request.url.split('?')[0] === candidatePath);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.idempotencyKey).toBeTruthy();
      expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey);

      const candidates = await json<{
        candidates: {
          id: string;
          statement: { value: { content: { document?: string; digest?: string; language?: string } } };
        }[];
      }>(
        await stack.kernel(
          `/v1/subjects/${subjectId}/candidates?property=${encodeURIComponent(property)}&context=${GLOBAL_CONTEXT}&limit=20`,
          {},
          'alice',
        ),
        200,
        'list authored candidates',
      );
      const candidate = candidates.candidates.find(
        (item) =>
          item.statement.value.content.language === 'en' && typeof item.statement.value.content.document === 'string',
      );
      if (!candidate?.statement.value.content.document || !candidate.statement.value.content.digest)
        throw new Error('Native candidate did not return its authored document locator and digest');

      const review = page.locator('#candidate-review');
      await page.getByRole('button', { name: m.correction_review() }).click();
      await visible(review).toBeVisible();
      await review.getByRole('button', { name: m.candidate_accept() }).click();
      await review.getByRole('button', { name: m.candidate_accept() }).last().click();
      await visible(review.getByText(m.candidate_accepted())).toBeVisible();
      await review.getByRole('button', { name: m.candidate_reload() }).click();
      const oldChoice = review.locator('[data-candidate-choice]').filter({ hasText: currentText });
      const newChoice = review.locator('[data-candidate-choice]').filter({ hasText: replacementText });
      await oldChoice.getByRole('checkbox').click();
      await newChoice.getByRole('checkbox').click();
      await review.getByRole('button', { name: m.candidate_adopt() }).click();
      await review.getByRole('button', { name: m.candidate_adopt() }).last().click();
      await visible(page.getByRole('region', { name: m.authored_selected() })).toContainText(replacementText);

      const publicDocument = await json<{
        document: { candidateId: string; digest: string; language: string; body: DocumentSnapshot };
      }>(await stack.kernel(`/v1/documents/${candidate.statement.value.content.document}`), 200, 'anonymous document');
      expect(publicDocument.document).toMatchObject({
        candidateId: candidate.id,
        digest: candidate.statement.value.content.digest,
        language: 'en',
      });
      expect(documentText(publicDocument.document.body)).toContain(replacementText);

      const independent = await (await auth.context('anonymous')).newPage();
      independent.setDefaultTimeout(30_000);
      await independent.goto(new URL(publicHref, stack.web).href, { waitUntil: 'domcontentloaded' });
      await hydrate(independent);
      await visible(independent.locator('main')).toContainText(replacementText);
      await visible(independent.locator('main')).not.toContainText(currentText);
      await independent.close();

      const room = await json<{ context: { id: string } }>(
        await stack.kernel(
          '/v1/contexts',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
            body: JSON.stringify({ labels: { en: 'Editorial room' } }),
          },
          'alice',
        ),
        201,
        'create editorial context',
      );
      const unsupported = authoredPublicCorrectionHref(`${publicHref}/authored`, {
        subject: subjectId,
        context: room.context.id,
        locale: 'en',
        returnHref: publicHref,
      });
      await page.goto(`${stack.web}${unsupported}`, { waitUntil: 'domcontentloaded' });
      await hydrate(page);
      await visible(page.getByRole('alert')).toContainText(m.authored_public_unsupported());
      const fresh = page.getByRole('link', { name: m.authored_public_fresh_global() });
      await visible(fresh).toBeVisible();
      await visible(page.getByRole('link', { name: m.authored_public_return() })).toBeVisible();
      await page.keyboard.press('Tab');
      await fresh.focus();
      await page.keyboard.press('Enter');
      await hydrate(page);
      await visible(page.getByRole('status')).toContainText(m.authored_public_fresh_notice());
      expect(new URL(page.url()).search).toContain('publicReturn=');
      expect(new URL(page.url()).search).not.toContain('origin=');
      expect(authoredGlobalVisitHref(`${publicHref}/authored`, subjectId, 'en', publicHref)).not.toContain('via=');

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(
        `${stack.web}${authoredPublicCorrectionHref(`${publicHref}/authored`, {
          subject: subjectId,
          context: GLOBAL_CONTEXT,
          locale: 'en',
          returnHref: publicHref,
        })}`,
        { waitUntil: 'domcontentloaded' },
      );
      await hydrate(page);
      await visible(page.getByRole('link', { name: m.authored_public_return() })).toBeVisible();
      await visible(page.locator('form')).toBeVisible();

      const zh = publicHref.replace('/en/', '/zh-Hans/');
      await page.goto(`${stack.web}${zh}/authored`, { waitUntil: 'domcontentloaded' });
      await hydrate(page);
      await visible(page.locator('h1, form').first()).toBeVisible();

      const suspended = await stack.authPersona('suspended');
      const refused = await fetch(`${stack.kernelOrigin}/v1/subjects/${subjectId}/candidates`, {
        method: 'POST',
        headers: {
          authorization: suspended.authorization,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({
          statement: {
            property: { id: property },
            value: { type: 'value', content: { document: fromPlainText('no'), language: 'en', licence: 'CC-BY-4.0' } },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }],
          },
        }),
      });
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      expect(await refused.text()).toContain('invalid_credentials');
    } finally {
      await page.close();
      await alice.context.close();
    }
  },
  lifecycle,
);
