import { afterAll, expect as bunExpect, setDefaultTimeout, test } from 'bun:test';
import { documentText, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { expect } from 'playwright/test';
import { m } from '../../src/paraglide/messages.js';
import {
  authoredDocumentError,
  authoredDocumentErrors,
  authoredStatement,
  validateAuthored,
} from '../../src/features/catalogue/authored-field';
import type { StatementInput } from '../../src/features/catalogue/statement-editor';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(600_000);

const property = 'schema:abstract';
const title = 'Authored document preview';
const currentText = 'The current public document remains selected until an explicit decision.';
const citation = 'https://example.org/authored-preview';
const untrustedText = '<script>window.__draftPreviewExecuted=true</script>';
const lifecycle = new NativeTestLifecycle('native authored document preview suite');
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
  const selectedBody = (await selected.json()) as { subject: { statements: Record<string, { id: string }[]> } };
  initialStatementId = selectedBody.subject.statements[property]?.[0]?.id ?? '';
  if (!initialStatementId) throw new Error('Native Book creation returned no selected abstract');
  auth = await startAuthStack(stack);
});

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

test('malformed authored documents stay unchanged and grouped evidence stays exact', () => {
  const malformed = { ...fromPlainText('keep this input'), doc: null } as unknown as DocumentSnapshot;
  const original = structuredClone(malformed);
  const references: StatementInput['references'] = [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: citation } },
        { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
      ],
    },
  ];
  const statement = authoredStatement(property, malformed, 'fr', 'CC-BY-4.0', references);
  bunExpect(authoredDocumentError(malformed)).toBe('invalid_format');
  bunExpect(validateAuthored(statement).some((error) => error.pointer.includes('/value/content/document'))).toBe(true);
  bunExpect(authoredDocumentError(fromPlainText('repaired document'))).toBeUndefined();
  bunExpect(malformed).toEqual(original);
  bunExpect(statement.references).toEqual(references);
  bunExpect(statement.references).not.toBe(references);

  const oversizedWithMedia = fromPlainText('x'.repeat(2 * 1024 * 1024)) as unknown as {
    doc: { content: { type: string }[] };
  };
  oversizedWithMedia.doc.content.push({ type: 'media' });
  bunExpect(authoredDocumentErrors(oversizedWithMedia)).toEqual(['out_of_range', 'unsupported']);
});

test('a contributor previews, edits, submits and explicitly selects the exact authored document', async () => {
  const journey = await auth.signIn('alice');
  const page = await journey.context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    const href = subjectHref({ id: subjectId, label: title }, 'en').href;
    await page.goto(`${stack.web}${href}/authored`, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });

    const form = page.locator('form');
    const editor = form.locator('.ProseMirror');
    await expect(form).toBeVisible();
    await expect(editor).toHaveText('');
    const selected = page.getByRole('region', { name: m.authored_selected() });
    await expect(selected).toContainText(currentText);

    await editor.fill(untrustedText);
    await form.getByLabel(m.authored_language()).fill('en');
    await form.getByLabel(m.authored_licence()).fill('CC-BY-4.0');
    await form.getByLabel(m.authored_citation()).fill(citation);
    await form.getByLabel(m.correction_add_part()).selectOption('schema:inLanguage');
    await form.getByRole('button', { name: m.correction_add() }).click();
    await form.getByLabel(m.correction_value()).last().fill('en');
    const original = form.getByRole('checkbox', { name: m.authored_original() });
    await original.click();
    await expect(original).toBeChecked();

    await form.getByRole('button', { name: m.authored_preview_draft() }).click();
    const preview = page.getByRole('region', { name: m.authored_preview_step() });
    await expect(preview).toContainText(untrustedText);
    await expect(preview).toContainText(currentText);
    await expect(preview.getByRole('region', { name: m.authored_evidence() })).toContainText(citation);
    await expect(preview.getByRole('region', { name: m.authored_evidence() })).toContainText('en');
    await expect(preview.locator('script')).toHaveCount(0);
    const executed = await page.evaluate(
      () => (window as unknown as { __draftPreviewExecuted?: boolean }).__draftPreviewExecuted,
    );
    expect(executed).toBeUndefined();

    await preview.getByRole('button', { name: m.authored_continue_review() }).click();
    const review = page.getByRole('region', { name: m.authored_review_contribution() });
    await expect(review).toContainText(m.authored_submit_notice());
    await review.getByRole('button', { name: m.authored_edit_draft() }).click();
    await expect(page.getByRole('button', { name: m.authored_review_step() })).toBeDisabled();
    await expect(original).toBeFocused();
    await form.getByLabel(m.authored_language()).fill('fr');
    await form.getByRole('button', { name: m.authored_preview_draft() }).click();
    const revisedPreview = page.getByRole('region', { name: m.authored_preview_step() });
    await expect(revisedPreview).toContainText(untrustedText);
    await expect(revisedPreview.getByRole('region', { name: m.authored_current_comparison() })).toContainText('en');
    await revisedPreview.getByRole('button', { name: m.authored_continue_review() }).click();
    const finalReview = page.getByRole('region', { name: m.authored_review_contribution() });
    await expect(finalReview).toContainText('fr');
    await expect(finalReview).toContainText(currentText);

    const candidatePath = `/v1/subjects/${subjectId}/candidates`;
    const observedFrom = stack.kernelRequests().length;
    await stack.injectKernelFailureOnce({
      method: 'POST',
      path: candidatePath,
      status: 503,
      body: JSON.stringify({ code: 'dependency_unavailable' }),
    });
    await finalReview.getByRole('button', { name: m.authored_submit_contribution() }).click();
    const retry = page.getByRole('button', { name: m.correction_retry() }).first();
    await expect(retry).toBeVisible();
    await page.getByRole('button', { name: m.authored_compose_step() }).click();
    await expect(form.getByLabel(m.authored_language())).toBeDisabled();
    await expect(editor).toHaveText(untrustedText);
    await retry.click();
    await expect(page.getByRole('button', { name: m.correction_review() })).toBeVisible();

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
        references: { parts: { property: { id: string }; value: { type: string; content: string } }[] }[];
        value: { content: { document: DocumentSnapshot; language: string; licence: string } };
      };
    };
    expect(requestBody.statement.value.content).toMatchObject({ language: 'fr', licence: 'CC-BY-4.0' });
    expect(documentText(requestBody.statement.value.content.document)).toContain(untrustedText);
    expect(requestBody.statement.references).toEqual([
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: citation } },
          { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
        ],
      },
    ]);

    const beforeSelection = await stack.kernel(`/v1/subjects/${subjectId}`);
    expect(beforeSelection.status).toBe(200);
    const beforeSelectionBody = (await beforeSelection.json()) as {
      subject: { statements: Record<string, { id: string }[]> };
    };
    expect(beforeSelectionBody.subject.statements[property]?.map((statement) => statement.id)).toEqual([
      initialStatementId,
    ]);

    await page.getByRole('button', { name: m.correction_review() }).click();
    const candidateReview = page.getByRole('region', { name: m.candidate_review() });
    await expect(candidateReview).toContainText(untrustedText);
    await candidateReview.getByRole('button', { name: m.candidate_reload() }).click();
    const originalChoice = candidateReview.locator('[data-candidate-choice]').filter({ hasText: currentText });
    const submittedChoice = candidateReview.locator('[data-candidate-choice]').filter({ hasText: untrustedText });
    const originalCheckbox = originalChoice.getByRole('checkbox');
    const submittedCheckbox = submittedChoice.getByRole('checkbox');
    await expect(originalCheckbox).toBeChecked();
    await expect(submittedCheckbox).not.toBeChecked();
    await originalCheckbox.click();
    await submittedCheckbox.click();
    await candidateReview.getByRole('button', { name: m.candidate_adopt() }).click();
    await candidateReview.getByRole('button', { name: m.candidate_adopt() }).last().click();

    const selectedAgain = page.getByRole('region', { name: m.authored_selected() });
    await expect(selectedAgain).toContainText(untrustedText);
    await expect(selectedAgain).not.toContainText(currentText);
    const currentSubject = await stack.kernel(`/v1/subjects/${subjectId}`);
    expect(currentSubject.status).toBe(200);
    const currentSubjectBody = (await currentSubject.json()) as {
      subject: {
        statements: Record<
          string,
          { id: string; value: { type: string; content: { document?: string; digest?: string; language?: string } } }[]
        >;
      };
    };
    const selectedStatement = currentSubjectBody.subject.statements[property]?.[0];
    expect(selectedStatement?.id).not.toBe(initialStatementId);
    const documentId = selectedStatement?.value.content.document;
    expect(documentId).toBeTruthy();
    const currentDocument = await stack.kernel(`/v1/documents/${documentId}`);
    expect(currentDocument.status).toBe(200);
    const currentDocumentBody = (await currentDocument.json()) as { document: { body: DocumentSnapshot } };
    expect(documentText(currentDocumentBody.document.body)).toContain(untrustedText);
  } finally {
    await page.close();
    await journey.context.close();
  }
});
