import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Release } from '@rezics/definitions';
import { fromPlainText, serializeDocument } from '@rezics/document';
import recorded from '../src/kernel/recorded/definitions-release.json';
import { projectQuotationFromPage, type QuotationPage } from '../src/features/catalogue/quotation';

mock.module('cloudflare:workers', () => ({ env: {} }));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const quote = uuid(701),
  english = uuid(702),
  japanese = uuid(703),
  speaker = uuid(704),
  creator = uuid(705);
const speakerStatement = uuid(706),
  creatorStatement = uuid(707),
  hidden = uuid(708);
const body = fromPlainText('The exact authored quotation');
const digest = createHash('sha256').update(serializeDocument(body)).digest('hex');
const source = 'https://archive.example.test/text-evidence';
const contextSource = 'https://archive.example.test/speaker-evidence';
const snak = (id: string, data_type: string, content: unknown) => ({
  property: { id, data_type },
  value: { type: 'value' as const, content },
});
const spoiler = snak('rezics:spoilerLevel', 'quantity', { amount: '1' });
const citation = (hash: string, url: string) => ({ hash, parts: [snak('schema:url', 'url', url)] });
function fixture(): QuotationPage {
  const statement = (id: string, property: string, datatype: string, content: unknown, spoiled = false) => ({
    id,
    ...snak(property, datatype, content),
    rank: 'normal',
    qualifiers: spoiled ? [spoiler] : [],
    references: [],
  });
  return {
    subject: quote,
    reads: {
      subject: {
        status: 200,
        body: {
          subject: {
            id: quote,
            type: 'schema:Quotation',
            revision: 3,
            release: recorded.digest,
            context: uuid(1),
            labels: { en: 'Retained quotation' },
            descriptions: {},
            aliases: {},
            resolution: {},
            relationCounts: {},
            sourceRecords: [],
            statements: {
              'schema:text': [
                {
                  ...statement(
                    english,
                    'schema:text',
                    'document',
                    { document: uuid(709), digest, language: 'en' },
                    true,
                  ),
                  qualifiers: [spoiler, snak('schema:creator', 'wikibase-item', creator)],
                  references: [citation('text-ref', source)],
                },
                statement(japanese, 'schema:text', 'document', { document: uuid(710), digest, language: 'ja' }),
              ],
              'schema:spokenByCharacter': [
                {
                  ...statement(speakerStatement, 'schema:spokenByCharacter', 'wikibase-item', speaker, true),
                  references: [citation('speaker-ref', contextSource)],
                },
              ],
              'schema:creator': [statement(creatorStatement, 'schema:creator', 'wikibase-item', creator)],
              'schema:about': [statement(uuid(711), 'schema:about', 'wikibase-item', hidden)],
            },
          },
          related: {
            [speaker]: { type: 'wd:Q95074', labels: { en: 'Hidden speaker' } },
            [creator]: { type: 'schema:Person', labels: { en: 'Independent creator' } },
          },
          account: null,
          summary: null,
          documents: {
            [english]: {
              id: uuid(709),
              subjectId: quote,
              candidateId: english,
              digest,
              language: 'en',
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

test('each quotation assertion owns its evidence, language choice, inspection and caller disclosure', async () => {
  const release = recorded.release as unknown as Release;
  const original = fixture();
  const reading = await projectQuotationFromPage(release, original, 'en');
  if (!reading.ok || !reading.selected) throw new Error('quotation missing');
  expect(reading.selected.statements.map((text) => [text.language, text.status])).toEqual([
    ['en', 'current'],
    ['ja', 'unavailable'],
  ]);
  const envelope = original.reads.subject!.body as { subject: { statements: Record<string, unknown[]> } };
  const native = envelope.subject;
  expect(reading.selected.statements[0]!.assertion?.statement).toEqual(native.statements['schema:text'][0]);
  expect(reading.selected.contexts[0]!.assertion?.statement).toEqual(native.statements['schema:spokenByCharacter'][0]);
  expect(reading.selected.contexts[0]!.references?.[0]?.hash).toBe('speaker-ref');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.invalid/en/subjects/${quote}/quotation/quotations` });
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
  const { QuotationView } = await import('../src/features/pages/quotation-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let calls = 0;
  async function mount(initial = reading, reader = 'one', quoteIntent?: string, resume = false) {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            CandidateReaderBoundary,
            { observed: { state: 'signed-out', csrfToken: reader }, address: quote },
            h(QuotationView, {
              id: quote,
              locale: 'en',
              initial: resume ? undefined : initial,
              quote: quoteIntent,
              transport: {
                read: async () => {
                  calls++;
                  return initial;
                },
              },
            }),
          ),
        ),
      ),
    );
  }
  async function reveal(index: number) {
    const buttons = [...host.querySelectorAll('button')].filter((node) =>
      node.textContent?.includes(m.thread_reveal_spoiler()),
    );
    await act(async () => buttons[index]!.click());
  }
  async function language(id: string) {
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = id;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  }
  try {
    await mount();
    expect(host.innerHTML).not.toContain(source);
    expect(host.innerHTML).not.toContain(contextSource);
    expect(host.innerHTML).not.toContain('Hidden speaker');
    expect(host.innerHTML).not.toContain(hidden);
    expect(host.textContent).toContain('Independent creator');
    expect(host.querySelector('h2')?.textContent).not.toContain(quote);
    expect(host.querySelector('[data-action-state="unavailable"]')).toBeTruthy();
    expect(host.textContent).not.toContain(m.quotation_correct());
    expect(host.textContent).toContain(m.quotation_authoring());
    await reveal(0);
    expect(host.textContent).toContain('The exact authored quotation');
    expect(host.querySelector(`a[href="${source}"]`)).toBeTruthy();
    expect(host.innerHTML).not.toContain(contextSource);
    const inspect = host.querySelector(`a[href*="statement=${english}"]`)! as HTMLAnchorElement;
    const address = new URL(inspect.href);
    expect(address.pathname).toContain(quote);
    expect(address.searchParams.get('property')).toBe('schema:text');
    expect(address.searchParams.get('context')).toBe(uuid(1));
    const returnTo = address.searchParams.get('via')!;
    expect(new URL(returnTo, window.location.origin).searchParams.get('quote')).toBe(quote);
    const hide = [...host.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(m.subject_spoiler_hide()),
    )!;
    await act(async () => hide.click());
    expect(host.innerHTML).not.toContain(source);
    await reveal(1);
    expect(host.textContent).toContain('Hidden speaker');
    expect(host.querySelector(`a[href="${contextSource}"]`)).toBeTruthy();
    expect(host.innerHTML).not.toContain(source);
    expect(host.querySelector(`a[href*="statement=${speakerStatement}"]`)).toBeTruthy();
    await language(japanese);
    expect(host.textContent).toContain(m.quotation_unavailable());
    expect(host.textContent).not.toContain('The exact authored quotation');
    expect(calls).toBe(0); // Language is a local choice on the retained bounded response.
    // The existing volatile receipt retains language on a native detail return, without carrying bodies or reveals.
    const missingInspection = host.querySelector(`a[href*="statement=${japanese}"]`)! as HTMLAnchorElement;
    const missingReturn = new URL(missingInspection.href).searchParams.get('via')!;
    await act(async () =>
      missingInspection.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    await act(async () => root.render(null));
    window.history.replaceState(null, '', missingReturn);
    await mount(reading, 'one', quote, true);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe(japanese);
    expect(document.activeElement?.tagName).toBe('H2');
    window.history.replaceState(null, '', `/en/subjects/${quote}/quotation/quotations`);
    await mount(reading, 'two');
    expect(host.innerHTML).not.toContain(source);
    expect(host.innerHTML).not.toContain(contextSource);
    await reveal(0);
    const replacement = await projectQuotationFromPage(release, fixture(), 'en');
    if (!replacement.ok) throw new Error('replacement missing');
    replacement.selected!.observation = 'replacement-release';
    replacement.public.subject.release = 'sha256:replacement-release';
    replacement.actions = [{ action: 'statement:propose', operationId: 'subject.propose', state: 'denied' }];
    await mount(replacement, 'two');
    expect(host.innerHTML).not.toContain(source);
    expect(host.querySelector('[data-action-state="denied"]')).toBeTruthy();
    replacement.actions = [{ action: 'statement:propose', operationId: 'unrelated.operation', state: 'allowed' }];
    await mount({ ...replacement }, 'two');
    expect(host.textContent).not.toContain(m.quotation_correct());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('structured bodies and oversized associations fail without scalar, cached or partial evidence', async () => {
  const release = recorded.release as unknown as Release;
  const page = fixture();
  const envelope = page.reads.subject!.body as {
    documents: Record<string, { body: unknown; candidateId: string }>;
    subject: { statements: Record<string, { qualifiers: unknown[] }[]> };
  };
  envelope.documents[english]!.body = { text: 'guessed scalar' };
  let read = await projectQuotationFromPage(release, page, 'en');
  expect(read.ok && read.selected?.statements[0]?.status).toBe('unsupported');
  expect(read.ok && read.selected?.statements[0]?.text).toBeUndefined();
  envelope.documents[english]!.body = body;
  envelope.documents[english]!.candidateId = japanese;
  read = await projectQuotationFromPage(release, page, 'en');
  expect(read.ok && read.selected?.statements[0]?.status).toBe('unavailable');
  envelope.subject.statements['schema:spokenByCharacter']![0]!.qualifiers = Array(33).fill(spoiler);
  read = await projectQuotationFromPage(release, page, 'en');
  expect(read.ok && read.selected?.statements[0]?.status).toBe('unavailable');
  expect(read.ok && read.selected?.contexts).toEqual([]);
});
