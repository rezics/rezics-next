import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Release } from '@rezics/definitions';
import { fromPlainText, serializeDocument } from '@rezics/document';
import recorded from '../src/kernel/recorded/definitions-release.json';
import { projectQuotationFromPage, quotationTypeAdmitted } from '../src/features/catalogue/quotation';

mock.module('cloudflare:workers', () => ({ env: {} }));

const quote = '00000000-0000-4000-8000-00000000c002';
const context = '00000000-0000-4000-8000-000000000001';
const work = '00000000-0000-4000-8000-00000000c001';
const speaker = '00000000-0000-4000-8000-00000000c003';
const credited = '00000000-0000-4000-8000-00000000c005';
const textStatement = '00000000-0000-4000-8000-00000000e021';
const documentId = '00000000-0000-4000-8000-00000000d021';
const sourceHash = 'sha256:quotation-native-source-1';
const sourceUrl = 'https://archive.example.test/record/quotation-native';
const body = fromPlainText('I will return');
const digest = createHash('sha256').update(serializeDocument(body)).digest('hex');
const release = recorded.release as unknown as Release;

function snak(property: string, data_type: string, content: unknown) {
  return { property: { id: property, data_type }, value: { type: 'value' as const, content } };
}

function page(actions: { action: string; operationId: string; state: 'denied' | 'unavailable' }[]) {
  return {
    subject: quote,
    viewer: { kind: 'anonymous' as const },
    actions,
    reads: {
      subject: {
        status: 200,
        body: {
          subject: {
            id: quote,
            type: 'schema:Quotation',
            revision: 1,
            release: recorded.digest,
            context,
            labels: { en: 'I will return' },
            descriptions: {},
            aliases: {},
            statements: {
              'schema:text': [
                {
                  id: textStatement,
                  rank: 'normal',
                  property: { id: 'schema:text', data_type: 'document' },
                  value: { type: 'value', content: { document: documentId, digest, language: 'en' } },
                  qualifiers: [],
                  references: [
                    {
                      hash: sourceHash,
                      parts: [snak('schema:url', 'url', sourceUrl)],
                    },
                  ],
                },
              ],
              'schema:spokenByCharacter': [
                {
                  id: '00000000-0000-4000-8000-00000000e022',
                  rank: 'normal',
                  property: { id: 'schema:spokenByCharacter', data_type: 'wikibase-item' },
                  value: { type: 'value', content: speaker },
                  qualifiers: [],
                  references: [],
                },
              ],
              'schema:about': [
                {
                  id: '00000000-0000-4000-8000-00000000e023',
                  rank: 'normal',
                  property: { id: 'schema:about', data_type: 'wikibase-item' },
                  value: { type: 'value', content: work },
                  qualifiers: [],
                  references: [],
                },
              ],
              'schema:creator': [
                {
                  id: '00000000-0000-4000-8000-00000000e024',
                  rank: 'normal',
                  property: { id: 'schema:creator', data_type: 'wikibase-item' },
                  value: { type: 'value', content: credited },
                  qualifiers: [],
                  references: [],
                },
              ],
            },
            resolution: {},
            relationCounts: {},
            sourceRecords: [],
          },
          account: null,
          related: {
            [work]: { type: 'schema:Book', labels: { en: 'Work' } },
            [speaker]: { type: 'wd:Q95074', labels: { en: 'Hero' } },
            [credited]: { type: 'schema:Person', labels: { en: 'Credited author' } },
          },
          summary: null,
          documents: {
            [textStatement]: {
              id: documentId,
              subjectId: quote,
              candidateId: textStatement,
              language: 'en',
              digest,
              availability: 'available',
              licence: 'CC-BY-4.0',
              body,
            },
          },
        },
      },
    },
  };
}

test('recorded native quotation page keeps exact text, work, speaker and denied correction', async () => {
  expect(quotationTypeAdmitted(release)).toBe(true);
  const current = await projectQuotationFromPage(
    release,
    page([{ action: 'statement:propose', operationId: 'subject.propose', state: 'denied' }]),
    'en',
  );
  if (!current.ok || !current.selected) throw new Error('expected recorded quotation');
  expect(current.admitted).toBe(true);
  expect(current.viewer).toEqual({ kind: 'anonymous' });
  expect(current.selected.statements[0]?.language).toBe('en');
  expect(current.selected.statements[0]?.body?.ok).toBe(true);
  expect(current.selected.contexts.map((context) => [context.kind, context.status, context.label])).toEqual([
    ['speaker', 'current', 'Hero'],
    ['credited', 'current', 'Credited author'],
    ['work', 'current', 'Work'],
    ['voice', 'unknown', undefined],
  ]);
  expect(current.selected.statements[0]?.sourceStatus).toBe('current');
  expect(current.selected.contexts.find((context) => context.kind === 'speaker')?.id).not.toBe(
    current.selected.contexts.find((context) => context.kind === 'credited')?.id,
  );

  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/quote/quote/quotations' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Document',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { QuotationView } = await import('../src/features/pages/quotation-view');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const clientQuery = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const denied = current;
  const unavailable = await projectQuotationFromPage(
    release,
    page([{ action: 'statement:propose', operationId: 'subject.propose', state: 'unavailable' }]),
    'en',
  );
  async function show(initial: typeof denied) {
    clientQuery.clear();
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client: clientQuery },
          h(QuotationView, {
            id: quote,
            locale: 'en',
            context,
            transport: { read: async () => initial },
            initial,
          }),
        ),
      ),
    );
  }
  try {
    await show(denied);
    expect(host.textContent).toContain(m.quotation_denied());
    expect(host.textContent).not.toContain(m.quotation_correct());
    expect(host.querySelector('[data-action-state="denied"]')).not.toBeNull();
    await show(unavailable);
    expect(host.textContent).toContain(m.quotation_unavailable());
    expect(host.querySelector('[data-action-state="unavailable"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    clientQuery.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
