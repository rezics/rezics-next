import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromMarkdown } from '@rezics/document';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { Subject } from '../src/subject/types';
import type { OverviewValue } from '../src/features/pages/overview';
import type { Stmt } from '../src/features/pages/shared';
import recording from '../src/kernel/recorded/subject-page.json';
import subjectRecording from '../src/kernel/recorded/subject.json';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
type PublicTextResult = { ok: false } | { ok: true; document: Record<string, unknown> };
const readPublicSubjectDocument = mock(async (_input: unknown): Promise<PublicTextResult> => ({ ok: false }));
mock.module('../src/features/pages/subject-queries.ts', () => ({ readPublicSubjectDocument }));
const { Summary, OverviewContext } = await import('../src/features/pages/overview');
const require = createRequire(import.meta.url);
const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));

function reading(text: string, language = 'en', statements: Stmt[] = []): OverviewValue {
  const subject = structuredClone(subjectRecording.subject) as Subject;
  subject.descriptions = { [language]: text };
  subject.statements = { 'schema:abstract': statements } as Subject['statements'];
  const read = Object.values(
    planReads(platformRegistry, recording.document as CompositionDocument, { subject: subject.id }).reads,
  ).find((read) => read.kind === 'subject')!;
  return {
    locale: 'en',
    subject: subject.id,
    link: ({ children, ...props }) => <a {...props}>{children}</a>,
    reader: { spoilerLevel: 0, suitability: 'blur' },
    labels: {
      spoilerShow: 'Show spoilers',
      spoilerHide: 'Hide spoilers',
      documentSpoiler: 'Reveal inline spoiler',
      cover: { withheld: 'Withheld', reveal: 'Reveal', credit: 'Credit', via: 'Via' },
    },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Show spoilers',
    details: 'Details',
    cover: 'Cover',
    coverVia: 'Via',
    licence: 'Licence',
    source: 'Source',
    sources: 'Sources',
    sections: new Map([['summary', { ok: true, read, body: { subject, related: {} } }]]),
    about: {
      statements: 'facts',
      facts: <div data-testid="facts">Facts</div>,
      tags: <div data-testid="tags">Tags</div>,
    },
    relations: {},
    relationNodes: [],
  };
}

function composition(value: OverviewValue) {
  return (
    <OverviewContext.Provider value={value}>
      <Summary id="summary" />
    </OverviewContext.Provider>
  );
}

function render(value: OverviewValue) {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(composition(value));
  return window.document.body;
}

function rich(markdown: string, level = 0): Stmt {
  return {
    id: '0494501a-36af-8cc7-95c9-d7ffe4728201',
    rank: 'normal',
    property: { id: 'schema:abstract', data_type: 'document' },
    value: { type: 'value', content: { language: 'en', document: fromMarkdown(markdown, 'text') } },
    qualifiers: level
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: `+${level}`, unit: '1' } },
          },
        ]
      : [],
    references: [],
  };
}

function missingSummary(documentId: string, subjectId?: string) {
  const statement = rich('');
  statement.value.content = { language: 'en', document: documentId, digest: `digest-${documentId}` };
  const value = reading('', 'en', [statement]);
  if (subjectId) {
    value.subject = subjectId;
    const section = value.sections.get('summary');
    if (!section?.ok) throw new Error('Expected a Subject summary fixture');
    (section.body.subject as Subject).id = subjectId;
  }
  return { value, statement };
}

function availableDocument(value: OverviewValue, statement: Stmt, text: string) {
  const content = statement.value.type === 'value' ? (statement.value.content as Record<string, unknown>) : {};
  const subject = value.sections.get('summary');
  if (!subject?.ok || !statement.id) throw new Error('Expected a Subject summary fixture');
  return {
    id: content.document,
    subjectId: (subject.body.subject as Subject).id,
    candidateId: statement.id,
    digest: content.digest,
    language: content.language,
    revision: 1,
    availability: 'available',
    body: fromMarkdown(text, 'text'),
  };
}

async function mountSummary(value: OverviewValue) {
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(composition(value)));
  return {
    host,
    render: async (next: OverviewValue) => act(async () => root.render(composition(next))),
    close: async () => {
      await act(async () => root.unmount());
      for (const key of globals) {
        const descriptor = saved.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('short descriptions stay inline through the 420-character/two-paragraph boundary', () => {
  for (const text of ['A short description.', 'a'.repeat(420), 'First line\nSecond line\n\nSecond paragraph.']) {
    const body = render(reading(text));
    expect(body.querySelector('details')).toBeNull();
    expect(body.querySelector('[data-slot="subject-summary"] > div p')?.textContent).toBe(text);
    expect(body.querySelector('p')?.className).toContain('whitespace-pre-wrap');
    expect(body.querySelector('[data-slot="subject-text-unavailable"]')).toBeNull();
  }
});

test('Long fallback Subject descriptions remain bounded before explicit expansion while complete text language and spoiler controls stay accessible', () => {
  const text = `  ${'Une histoire de voyage. '.repeat(28)}\n\nLa suite.\nUne autre ligne.  `;
  const body = render(reading(text, 'fr'));
  const details = body.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  const full = details.querySelector(':scope > p')!;
  expect(details.hasAttribute('open')).toBe(false);
  expect(details.firstElementChild).toBe(summary);
  expect(summary.hasAttribute('role')).toBe(false);
  expect(summary.getAttribute('onclick')).toBeNull();
  expect(summary.textContent).toContain(m.subject_summary_expand({}, { locale: 'en' }));
  expect(summary.textContent).toContain(m.subject_summary_collapse({}, { locale: 'en' }));
  expect(summary.querySelector('[lang="fr"]')?.textContent.length).toBeLessThanOrEqual(421);
  expect(summary.className).toContain('min-h-11');
  expect(summary.className).toContain('min-w-11');
  expect(summary.className).toContain('focus-visible:outline-2');
  expect(full.getAttribute('lang')).toBe('fr');
  expect(full.textContent).toBe(text);
  expect(details.querySelectorAll(':scope > p')).toHaveLength(1);
  expect(summary.querySelector('span')?.className).toContain('group-open:hidden');
  // Native open changes reveal the same stored text; there is no JS body replacement or second full prose copy.
  details.open = true;
  expect(details.querySelector(':scope > p')).toBe(full);
  expect(full.textContent).toBe(text);
  details.open = false;
  expect(full.textContent).toBe(text);
  const languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of('fr')!;
  expect(body.textContent).toContain(languageName);
  const about = body.querySelector('[data-slot="subject-summary"]')!;
  const children = [...about.children];
  expect(children.indexOf(body.querySelector('[data-testid="facts"]')!)).toBeLessThan(
    children.indexOf(body.querySelector('[data-testid="tags"]')!),
  );
  expect(children.at(-1)?.textContent).toBe('Details');
});

test('excerpt preserves graphemes, paragraph boundaries, literal markup and unbroken tokens', () => {
  for (const cluster of ['😀', 'e\u0301', '👩🏽‍🚀', '🇫🇷']) {
    const text = `${'a'.repeat(419)}${cluster} trailing text`;
    const body = render(reading(text));
    expect(body.querySelector('summary > span')?.textContent).toBe(`${'a'.repeat(419)}…`);
    expect(body.querySelector('details > p')?.textContent).toBe(text);
  }
  for (const separator of ['\n\n', '\r\n\r\n', '\r\r', '\n \t\n']) {
    const text = `First\nline${separator}Second paragraph${separator}Third paragraph`;
    const value = reading(text);
    const body = render(value);
    // HTML parsing may normalize CR/CRLF to LF; the serialized body still carries the original text.
    const lines = (text: string) => text.replace(/\r\n?/g, '\n');
    expect(lines(body.querySelector('summary > span')!.textContent)).toBe(
      lines(`First\nline${separator}Second paragraph…`),
    );
    expect(lines(body.querySelector('details > p')!.textContent)).toBe(lines(text));
    expect(renderToStaticMarkup(composition(value))).toContain(text);
  }
  const token = `https://example.test/${'x'.repeat(1000)}`;
  const text = `<script>alert('literal')</script> <a href="/private">plain text</a> ${token}`;
  const body = render(reading(text));
  expect(body.querySelector('script')).toBeNull();
  expect(body.querySelector('details a')).toBeNull();
  expect(body.querySelector('details > p')?.textContent).toBe(text);
  expect(body.querySelector('details > p')?.className).toContain('[overflow-wrap:anywhere]');
});

test('unavailable rich text stays unavailable alongside bounded fallback; selected rich summaries retain links and spoiler boundaries', () => {
  const unavailable = rich('Unavailable document');
  unavailable.value.content = { language: 'en', document: 'missing-document', digest: 'sha256:missing' };
  const fallback = 'Fallback only. '.repeat(60);
  const body = render(reading(fallback, 'en', [unavailable]));
  expect(body.querySelector('[data-slot="subject-text-unavailable"]')).not.toBeNull();
  expect(body.querySelector('details > p')?.textContent).toBe(fallback);

  const markdown = `Visible start >!secret ending!< ${'ordinary prose '.repeat(50)} [Complete link](https://example.test/complete)`;
  const selected = render(reading('Fallback must not render.', 'en', [rich(markdown)]));
  expect(selected.textContent).not.toContain('Fallback must not render.');
  expect(selected.querySelector('summary')?.textContent).not.toContain('secret ending');
  expect(selected.querySelector('summary a')).toBeNull();
  expect(selected.querySelector('details [data-slot="document-body"] a')?.getAttribute('href')).toBe(
    'https://example.test/complete',
  );
  expect(selected.textContent).toContain('Reveal inline spoiler');

  const gated = render(reading('Fallback must not render.', 'en', [rich(markdown, 1)]));
  expect(gated.textContent).toContain('Show spoilers');
  expect(gated.textContent).not.toContain('Visible start');
  expect(gated.querySelector('details')).toBeNull();
  const permitted = reading('Fallback must not render.', 'en', [rich(markdown, 1)]);
  permitted.reader = { spoilerLevel: 1, suitability: 'blur' };
  expect(render(permitted).querySelector('details')).not.toBeNull();
});

test('failed public text retries in place, blocks overlapping clicks, and renders the recovered document', async () => {
  readPublicSubjectDocument.mockReset();
  let rejectFirst!: (result: PublicTextResult) => void;
  let calls = 0;
  const fixture = missingSummary('text-retry');
  readPublicSubjectDocument.mockImplementation(() => {
    calls += 1;
    return calls === 1
      ? new Promise((resolve) => (rejectFirst = resolve))
      : Promise.resolve({
          ok: true,
          document: availableDocument(fixture.value, fixture.statement, 'Recovered prose.'),
        });
  });
  const mounted = await mountSummary(fixture.value);
  try {
    const retry = mounted.host.querySelector('a')!;
    expect(retry.getAttribute('href')).toBe('/v1/documents/text-retry');
    await act(async () => retry.click());
    await act(async () => retry.click());
    expect(calls).toBe(1);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      rejectFirst({ ok: false });
      await Promise.resolve();
    });
    expect(mounted.host.querySelector('[data-slot="subject-text-unavailable"]')).not.toBeNull();
    await act(async () => {
      mounted.host.querySelector('a')!.click();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    expect(mounted.host.textContent).toContain('Recovered prose.');
    expect(mounted.host.querySelector('[data-slot="subject-text-unavailable"]')).toBeNull();
  } finally {
    await mounted.close();
  }
});

test('late text for another Subject is discarded and an available empty document clears the failure', async () => {
  readPublicSubjectDocument.mockReset();
  let finishFirst!: (result: PublicTextResult) => void;
  let calls = 0;
  const first = missingSummary('text-first', 'subject-first');
  const second = missingSummary('text-second', 'subject-second');
  readPublicSubjectDocument.mockImplementation(() => {
    calls += 1;
    return calls === 1
      ? new Promise((resolve) => (finishFirst = resolve))
      : Promise.resolve({ ok: true, document: availableDocument(second.value, second.statement, '') });
  });
  const mounted = await mountSummary(first.value);
  try {
    await act(async () => mounted.host.querySelector('a')!.click());
    await mounted.render(second.value);
    await act(async () => mounted.host.querySelector('a')!.click());
    expect(calls).toBe(1);
    expect(mounted.host.querySelector('a')?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      finishFirst({ ok: true, document: availableDocument(first.value, first.statement, 'Late first Subject text.') });
      await Promise.resolve();
    });
    expect(mounted.host.textContent).not.toContain('Late first Subject text.');
    expect(mounted.host.querySelector('[data-slot="subject-text-unavailable"]')).not.toBeNull();
    await act(async () => {
      mounted.host.querySelector('a')!.click();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    expect(mounted.host.querySelector('[data-slot="subject-text-unavailable"]')).toBeNull();
    expect(mounted.host.querySelector('[data-slot="document-body"]')).not.toBeNull();
  } finally {
    await mounted.close();
  }
});

test('the actual spoiler gate reveals and hides by keyboard and resets for a different summary statement', async () => {
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'MutationObserver',
    'ResizeObserver',
    'Event',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'CSS',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    const value = reading('', 'en', [rich('Hidden story. '.repeat(60), 1)]);
    await act(async () => root.render(composition(value)));
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe('Show spoilers');
    expect(button.className).toContain('min-h-11');
    expect(button.className).toContain('min-w-11');
    expect(button.className).toContain('focus-visible:outline-2');
    button.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toBe('Hide spoilers');
    expect(host.querySelector('details')?.open).toBe(false);
    await act(async () => user.keyboard(' '));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Show spoilers');
    await act(async () => user.click(button));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const changed = rich('Different hidden story. '.repeat(60), 1);
    changed.id = '0494501a-36af-8cc7-95c9-d7ffe4728202';
    await act(async () => root.render(composition(reading('', 'en', [changed]))));
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Different hidden story.');
  } finally {
    await act(async () => root.unmount());
    for (const key of globals) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
