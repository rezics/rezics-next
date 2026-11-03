import { afterAll, setDefaultTimeout, test } from 'bun:test';
import { documentText, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { expect } from 'playwright/test';
import { m } from '../../src/paraglide/messages.js';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(600_000);

const property = 'schema:abstract';
const globalContext = '00000000-0000-8000-8000-000000000000';
const title = 'Native original catalogue text';
const currentText = 'The existing public abstract remains selected.';
const replacementText = 'An original account of the book, written for this catalogue.';
const citation = 'https://example.org/native-original-text';
const lifecycle = new NativeTestLifecycle('native catalogue authored suite');
let stack: NativeWebStack;
let auth: NativeAuthStack;
let subjectId: string;
let initialStatementId: string;

nativeBeforeAll(lifecycle, 360_000, async () => {
  stack = await startNativeWebStack();
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
                {
                  parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }],
                },
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
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { subject?: { id?: string } };
  subjectId = createdBody.subject?.id ?? '';
  if (!subjectId) throw new Error('Native Book creation returned no subject id');

  const selected = await stack.kernel(`/v1/subjects/${subjectId}`);
  expect(selected.status).toBe(200);
  const selectedBody = (await selected.json()) as {
    subject: { statements: Record<string, { id: string }[]> };
  };
  initialStatementId = selectedBody.subject.statements[property]?.[0]?.id ?? '';
  if (!initialStatementId) throw new Error('Native Book creation returned no selected abstract');
  auth = await startAuthStack(stack);
});

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

test('a contributor submits, retries, reviews and selects an original abstract through the native session BFF', async () => {
  const journey = await auth.signIn('alice');
  const page = await journey.context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    const href = subjectHref({ id: subjectId, label: title }, 'en').href;
    await page.goto(`${stack.web}${href}/authored`, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });

    const form = page.locator('form');
    await expect(form).toBeVisible();
    const editor = form.locator('.ProseMirror');
    await expect(editor).toHaveText('');
    const selectedRegion = page.getByRole('region', { name: m.authored_selected() });
    await expect(selectedRegion).toContainText(currentText);
    await expect(selectedRegion).not.toContainText(replacementText);

    await editor.fill(replacementText);
    await form.getByLabel(m.authored_language()).fill('en');
    await form.getByLabel(m.authored_licence()).fill('CC-BY-4.0');
    await form.getByLabel(m.authored_citation()).fill(citation);
    const original = form.getByRole('checkbox', { name: m.authored_original() });
    await original.click();
    await expect(original).toBeChecked();

    const candidatePath = `/v1/subjects/${subjectId}/candidates`;
    const observedFrom = stack.kernelRequests().length;
    await stack.injectKernelFailureOnce({
      method: 'POST',
      path: candidatePath,
      status: 503,
      body: JSON.stringify({ code: 'dependency_unavailable' }),
    });
    await form.getByRole('button', { name: m.correction_submit() }).click();
    const retry = page.getByRole('button', { name: m.correction_retry() });
    await expect(retry).toBeVisible();
    await expect(selectedRegion).toContainText(currentText);
    await retry.click();
    await expect(page.getByRole('button', { name: m.correction_review() })).toBeVisible();
    await expect(selectedRegion).toContainText(currentText);
    await expect(selectedRegion).not.toContainText(replacementText);

    await stack.syncKernelRequests();
    const attempts = stack
      .kernelRequests()
      .slice(observedFrom)
      .filter((request) => request.method === 'POST' && request.url.split('?')[0] === candidatePath);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.failure?.status).toBe(503);
    expect(attempts[0]?.authorization).toMatch(/^Bearer /);
    expect(attempts[1]?.authorization).toMatch(/^Bearer /);
    expect(attempts[0]?.idempotencyKey).toBeTruthy();
    expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey);
    expect(attempts[1]?.body).toBe(attempts[0]?.body);

    const requestBody = JSON.parse(attempts[1]!.body!) as {
      statement: {
        references: { parts: { value: { content: string } }[] }[];
        value: { content: { document: DocumentSnapshot; language: string; licence: string } };
      };
    };
    expect(requestBody.statement.value.content).toMatchObject({ language: 'en', licence: 'CC-BY-4.0' });
    expect(documentText(requestBody.statement.value.content.document)).toContain(replacementText);
    expect(requestBody.statement.references[0]?.parts[0]?.value.content).toBe(citation);

    const pending = await stack.kernel(`/v1/subjects/${subjectId}`);
    expect(pending.status).toBe(200);
    const pendingBody = (await pending.json()) as {
      subject: { statements: Record<string, { id: string }[]> };
    };
    expect(pendingBody.subject.statements[property]?.map((statement) => statement.id)).toEqual([initialStatementId]);

    const candidatesResponse = await stack.kernel(
      `/v1/subjects/${subjectId}/candidates?property=${encodeURIComponent(property)}&context=${globalContext}&limit=20`,
      undefined,
      'alice',
    );
    expect(candidatesResponse.status).toBe(200);
    const candidatesBody = (await candidatesResponse.json()) as {
      candidates: {
        id: string;
        statement: {
          value: {
            type: string;
            content: { document?: string; digest?: string; language?: string };
          };
        };
      }[];
    };
    const candidate = candidatesBody.candidates.find(
      (item) =>
        item.statement.value.type === 'value' &&
        item.statement.value.content.language === 'en' &&
        typeof item.statement.value.content.document === 'string',
    );
    if (!candidate?.statement.value.content.document || !candidate.statement.value.content.digest)
      throw new Error('The native candidate did not return its authored document locator and digest');

    await page.getByRole('button', { name: m.correction_review() }).click();
    const candidateBody = page.getByRole('region', { name: m.authored_candidate() });
    await expect(candidateBody).toContainText(replacementText);
    const candidateDocumentId = candidate.statement.value.content.document;
    const candidateDocumentResponse = await stack.kernel(`/v1/documents/${candidateDocumentId}`, undefined, 'alice');
    expect(candidateDocumentResponse.status).toBe(200);
    const candidateDocumentBody = (await candidateDocumentResponse.json()) as {
      document: {
        id: string;
        subjectId: string;
        candidateId: string;
        digest: string;
        language: string;
        licence: string;
        availability: string;
        body: DocumentSnapshot;
      };
    };
    expect(candidateDocumentBody.document).toMatchObject({
      id: candidateDocumentId,
      subjectId,
      candidateId: candidate.id,
      digest: candidate.statement.value.content.digest,
      language: 'en',
      licence: 'CC-BY-4.0',
      availability: 'available',
    });
    expect(documentText(candidateDocumentBody.document.body)).toContain(replacementText);

    const review = page.locator('#candidate-review');
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: m.candidate_accept() }).click();
    await review.getByRole('button', { name: m.candidate_accept() }).last().click();
    await expect(review.getByText(m.candidate_accepted())).toBeVisible();
    await expect(selectedRegion).toContainText(currentText);

    const afterAcceptance = await stack.kernel(`/v1/subjects/${subjectId}`);
    expect(afterAcceptance.status).toBe(200);
    const acceptedBody = (await afterAcceptance.json()) as {
      subject: { statements: Record<string, { id: string }[]> };
    };
    expect(acceptedBody.subject.statements[property]?.map((statement) => statement.id)).toEqual([initialStatementId]);

    await review.getByRole('button', { name: m.candidate_reload() }).click();
    const oldChoice = review.locator('[data-candidate-choice]').filter({ hasText: currentText });
    const newChoice = review.locator('[data-candidate-choice]').filter({ hasText: replacementText });
    const oldCheckbox = oldChoice.getByRole('checkbox');
    const newCheckbox = newChoice.getByRole('checkbox');
    await expect(oldCheckbox).toBeChecked();
    await expect(newCheckbox).not.toBeChecked();
    await oldCheckbox.click();
    await newCheckbox.click();
    await review.getByRole('button', { name: m.candidate_adopt() }).click();
    await review.getByRole('button', { name: m.candidate_adopt() }).last().click();
    await expect(selectedRegion).toContainText(replacementText);
    await expect(selectedRegion).not.toContainText(currentText);

    const publicSubjectResponse = await stack.kernel(`/v1/subjects/${subjectId}`);
    expect(publicSubjectResponse.status).toBe(200);
    const publicSubjectBody = (await publicSubjectResponse.json()) as {
      subject: {
        statements: Record<
          string,
          { id: string; value: { type: string; content: { document?: string; digest?: string; language?: string } } }[]
        >;
      };
    };
    const publicSelection = publicSubjectBody.subject.statements[property] ?? [];
    expect(publicSelection.map((statement) => statement.id)).toEqual([candidate.id]);
    expect(publicSelection[0]?.value.content.document).toBe(candidateDocumentId);

    await stack.syncKernelRequests();
    expect(
      stack
        .kernelRequests()
        .slice(observedFrom)
        .some(
          (request) =>
            !request.fixtureRequest &&
            request.method === 'GET' &&
            request.url === `/v1/documents/${candidateDocumentId}` &&
            request.authorization === null,
        ),
    ).toBe(true);
    const publicDocumentResponse = await stack.kernel(`/v1/documents/${candidateDocumentId}`);
    expect(publicDocumentResponse.status).toBe(200);
    const publicDocumentBody = (await publicDocumentResponse.json()) as {
      document: { candidateId: string; digest: string; body: DocumentSnapshot };
    };
    expect(publicDocumentBody.document).toMatchObject({
      candidateId: candidate.id,
      digest: candidate.statement.value.content.digest,
    });
    expect(documentText(publicDocumentBody.document.body)).toContain(replacementText);
  } finally {
    await page.close();
    await journey.context.close();
  }
});
