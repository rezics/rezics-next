import { afterAll, expect } from 'bun:test';
import { documentText, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Page } from 'playwright';
import { expect as visible } from 'playwright/test';
import { m } from '../src/paraglide/messages.js';
import { authoredGlobalVisitHref, authoredPublicCorrectionHref } from '../src/features/catalogue/authored-public-visit';
import { subjectHref } from '../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './native/auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './native/lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './native/stack.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const language = 'schema:inLanguage';
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

async function command(path: string, body: unknown, persona: string, expected: number, label: string) {
  return json<Record<string, unknown>>(
    await stack.kernel(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify(body),
      },
      persona,
    ),
    expected,
    label,
  );
}

async function grantAccount(accountId: string, actions: string[]) {
  await command(
    '/v1/grants',
    { resource: { route: 0, id: globalContext }, subject: { kind: 'account', id: accountId }, actions, valid: '(,)' },
    'governor',
    201,
    `grant ${actions.join(',')}`,
  );
}

type ReviewSubject = {
  id: string;
  label: string;
  href: string;
  japanese: { id: string };
  korean: { id: string };
};

async function createCompetingLanguages(): Promise<ReviewSubject> {
  const label = `Native compare ${crypto.randomUUID().slice(0, 8)}`;
  const created = await command('/v1/subjects', { type: 'schema:Book', labels: { en: label } }, 'editor', 201, 'book');
  const id = (created.subject as { id: string }).id;
  const propose = async (content: string, name: string) => {
    const result = await command(
      `/v1/subjects/${id}/candidates`,
      {
        statement: {
          property: { id: language },
          value: { type: 'value', content },
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: `https://catalogue.example.test/editorial/${content}` },
                },
              ],
            },
          ],
        },
      },
      'alice',
      201,
      name,
    );
    if (typeof result.candidate !== 'string') throw new Error(`Proposal for ${name} returned no candidate`);
    return { id: result.candidate };
  };
  return {
    id,
    label,
    href: subjectHref({ id, label }, 'en').href,
    japanese: await propose('ja', 'Japanese'),
    korean: await propose('ko', 'Korean'),
  };
}

function publicLanguages(subject: {
  statements: Record<string, { id: string; rank: string; value: { content?: unknown } }[]>;
}) {
  return (subject.statements[language] ?? [])
    .filter((statement) => statement.rank === 'normal' || statement.rank === 'preferred')
    .map((statement) => ({ id: statement.id, rank: statement.rank, content: statement.value.content }));
}

nativeBeforeAll(lifecycle, 360_000, async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  const [alice, bob] = await Promise.all([auth.signIn('alice'), auth.signIn('bob')]);
  if ((await alice.response()).status() !== 200 || (await bob.response()).status() !== 200)
    throw new Error('Native Alice and Bob must sign in through the served Auth forms');
  const [aliceAccount, bobAccount] = await Promise.all([stack.authPersona('alice'), stack.authPersona('bob')]);
  await grantAccount(aliceAccount.accountId, ['subject:create', 'statement:propose']);
  await grantAccount(bobAccount.accountId, ['context:accept', 'context:adopt']);
  await grantAccount(aliceAccount.accountId, ['context:accept', 'context:adopt', 'context:create']);

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
    const competing = await createCompetingLanguages();
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
    expect(
      publicLanguages(
        (
          await json<{ subject: Parameters<typeof publicLanguages>[0] }>(
            await stack.kernel(`/v1/subjects/${competing.id}`),
            200,
            'public before adopt',
          )
        ).subject,
      ),
    ).toEqual([]);

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

    const publicAfter = publicLanguages(
      (
        await json<{ subject: Parameters<typeof publicLanguages>[0] }>(
          await stack.kernel(`/v1/subjects/${competing.id}`),
          200,
          'public after adopt',
        )
      ).subject,
    );
    expect(publicAfter).toEqual([{ id: competing.japanese.id, rank: 'preferred', content: 'ja' }]);
    const listed = await json<{ candidates: { id: string; decision: string | null }[] }>(
      await stack.kernel(
        `/v1/subjects/${competing.id}/candidates?property=${encodeURIComponent(language)}&context=${globalContext}&limit=20`,
        {},
        'bob',
      ),
      200,
      'list competing candidates',
    );
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
          `/v1/subjects/${subjectId}/candidates?property=${encodeURIComponent(property)}&context=${globalContext}&limit=20`,
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
          context: globalContext,
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
