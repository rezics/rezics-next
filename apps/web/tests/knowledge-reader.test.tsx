import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import {
  knowledgeDocumentId,
  knowledgeExactRequest,
  knowledgeLicence,
  knowledgeLiveRequest,
  knowledgePublicationText,
  knowledgeReady,
  knowledgeReadyDocument,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeTitle,
} from '../src/stories/knowledge-document-fixtures';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { KnowledgeDocumentPage } = await import('../src/knowledge/page');
const { knowledgeExactHref, knowledgeLiveHref } = await import('../src/knowledge/public-read');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

setLocale('en', { reload: false });

function html(
  page: Parameters<typeof KnowledgeDocumentPage>[0]['page'],
  request = knowledgeLiveRequest,
  extra: Partial<Parameters<typeof KnowledgeDocumentPage>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(KnowledgeDocumentPage, { request, page, origin: 'https://site.test', ...extra }),
  );
}

const former = [knowledgePublicationText, knowledgeTitle, knowledgeLicence, 'data-slot="document-body"'];

test('live and exact selected readers render the supplied canonical body and citation', () => {
  const live = html(knowledgeReady);
  expect(live).toContain(knowledgePublicationText);
  expect(live).toContain(knowledgeTitle);
  expect(live).toContain(knowledgeLicence);
  expect(live).toContain(m.knowledge_live_kind());
  expect(live).toContain(m.knowledge_unattributed());
  expect(live).not.toMatch(/anonymous|deleted/i);
  expect(live).toContain(`/subjects/${knowledgeSubjectId}/`);
  expect(live).toContain(knowledgeExactHref('en', knowledgeDocumentId, knowledgeRevisionId));
  expect(live).toContain(m.knowledge_citation_copy());
  expect(live).not.toContain(m.knowledge_current_open());
  expect(live).toContain('min-h-11');

  const exact = html(knowledgeReady, knowledgeExactRequest);
  expect(exact).toContain(m.knowledge_exact_kind());
  expect(exact).toContain(knowledgePublicationText);
  expect(exact).toContain(m.knowledge_current_open());
  expect(exact).toContain(knowledgeLiveHref('en', knowledgeDocumentId));
});

test('native outcome states hide public body and keep exact failure from becoming live success', () => {
  for (const [page, message, retry, current] of [
    [{ state: 'preparing' as const }, m.knowledge_preparing(), false, false],
    [{ state: 'not-found' as const, status: 404 as const }, m.knowledge_not_found(), false, true],
    [{ state: 'denied' as const, status: 403 as const }, m.knowledge_denied(), true, true],
    [{ state: 'unavailable' as const, status: 503 }, m.knowledge_unavailable(), true, true],
  ] as const) {
    const rendered = html(page, knowledgeExactRequest, { onRetry: () => undefined });
    expect(rendered).toContain(message);
    for (const value of former) expect(rendered).not.toContain(value);
    expect(rendered.includes(m.knowledge_retry())).toBe(retry);
    expect(rendered.includes(m.knowledge_current_open())).toBe(current);
  }
  const mismatched = html(
    { state: 'ready', document: { ...knowledgeReadyDocument, revisionId: knowledgeDocumentId } },
    knowledgeExactRequest,
  );
  expect(mismatched).toContain(m.knowledge_unavailable());
  for (const value of former) expect(mismatched).not.toContain(value);
});
