import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubjectPersonalLease } from '../src/features/pages/subject-personal-reader';
import type { RatingWriteInput } from '../src/features/pages/rating-control';
import { sessionQueryKey } from '../src/session/browser-state';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { QUESTION, type RatingQuestion } from '../src/features/pages/subject-ratings';

test('composed rating controls label and submit their own question, value and return address independently', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/composed' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { RatingControlView, SubjectRatingControl } = await import('../src/features/pages/rating-control');
  const questions: RatingQuestion[] = [
    { id: QUESTION, revision: 1, label: 'Your rating', grain: 'work', scale: { min: 0, max: 20, displayStep: 1 } },
    {
      id: '00000000-0000-7000-8000-000000000002',
      revision: 1,
      label: 'Your second rating',
      grain: 'work',
      scale: { min: 4, max: 44, displayStep: 4 },
    },
  ];
  const saved: (number | null)[][] = [[], []];
  const controls = questions.map((question, index) => (
    <RatingControlView
      key={index}
      question={question}
      subjectId={`subject-${index}`}
      locale="en"
      returnTo={`/en/subjects/subject-${index}/rating?view=${index}#rating`}
      state={{ kind: 'ready', units: index === 0 ? 0 : 20 }}
      pending={false}
      failure={null}
      onSet={(value) => saved[index]!.push(value)}
      onClear={() => saved[index]!.push(null)}
    />
  ));
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => root.render(controls));
    const forms = [...host.querySelectorAll('form')];
    expect(forms).toHaveLength(2);
    for (const [index, form] of forms.entries()) {
      const input = form.querySelector('input[type="range"]')!;
      const label = form.querySelector('label')!;
      expect(label.control).toBe(input);
      expect(label.textContent).toBe(questions[index]!.label);
      expect(window.document.getElementById(input.id)).toBe(input);
      await act(async () =>
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
      );
      const units = index === 0 ? 1 : 24;
      expect(Object.fromEntries(new window.FormData(form))).toEqual({
        questionId: questions[index]!.id,
        subjectId: `subject-${index}`,
        units: String(units),
        returnTo: `/en/subjects/subject-${index}/rating?view=${index}#rating`,
      });
      await act(async () => {
        if (index === 0) form.querySelector('button')!.click();
        else form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(saved[index]).toEqual([units]);
      expect(saved[1 - index]).toEqual(index === 0 ? [] : [1, null]);
      await act(async () => form.querySelectorAll('button')[1]!.click());
      expect(saved[index]).toEqual([units, null]);
    }
    // Parse the server's fallback as active HTML, as a reader with scripting disabled receives it.
    const fallback = window.document.createElement('main');
    fallback.innerHTML = renderToStaticMarkup(
      <>
        {controls}
        {controls}
      </>,
    )
      .match(/<noscript>([\s\S]*?)<\/noscript>/g)!
      .map((html) => html.replace(/<\/?noscript>/g, ''))
      .join('');
    window.document.body.append(fallback);
    const fallbackForms = [...fallback.querySelectorAll('form')];
    expect(fallbackForms).toHaveLength(4);
    expect(new Set([...fallback.querySelectorAll('[id]')].map((node) => node.id)).size).toBe(
      fallback.querySelectorAll('[id]').length,
    );
    for (const [position, form] of fallbackForms.entries()) {
      const index = position % questions.length;
      const input = form.querySelector('input[type="range"]')!;
      expect(form.querySelector('label')!.control).toBe(input);
      input.value = String(index === 0 ? 7 : 28);
      for (const intent of ['save', 'clear']) {
        const button = form.querySelector<HTMLButtonElement>(`button[value="${intent}"]`)!;
        const fields = new window.FormData(form, button);
        expect([...fields.entries()]).toEqual([
          ['questionId', questions[index]!.id],
          ['subjectId', `subject-${index}`],
          ['returnTo', `/en/subjects/subject-${index}/rating?view=${index}#rating`],
          ['units', input.value],
          ['intent', button.value],
        ]);
        expect(form.getAttribute('action')).toBe(fields.get('returnTo'));
      }
    }
    // A lost response must never turn the next click into a new vote command.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'original-credential' });
    const binding: SubjectPersonalLease = {
      key: 'reader-lease',
      reader: 'reader',
      subjectId: 'subject-0',
      locale: 'en',
      view: 'overview',
      scope: { reader: 'reader', admission: 1, view: 'overview', cacheEpoch: 0 },
      isCurrent: () => true,
      retire: () => {},
      beginRatingWrite: () => ({
        id: 1,
        sequence: 1,
        ownsCache: () => true,
        commit: () => {},
        rollback: (fallback) => fallback,
        preserveUncertainty: () => {},
      }),
    };
    const commands: RatingWriteInput[] = [];
    const renderRecovery = async (question = questions[0]!) =>
      act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <SubjectRatingControl
              question={question}
              subjectId="subject-0"
              locale="en"
              returnTo="/en/original#rating"
              session="signed-in"
              own={{ reader: 'reader', kind: 'ready', units: 10 }}
              binding={binding}
              write={async (input) => {
                commands.push(input);
                return 'uncertain';
              }}
            />
          </QueryClientProvider>,
        ),
      );
    await renderRecovery();
    await act(async () => host.querySelector('form')!.querySelectorAll('button')[1]!.click());
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      units: null,
      expectedReader: 'reader',
      expectedCredential: 'original-credential',
      question: { id: questions[0]!.id, revision: 1, meaning: 'Your rating' },
    });
    expect(Object.isFrozen(commands[0])).toBe(true);
    client.setQueryData(sessionQueryKey, {
      state: 'signed-in',
      subject: 'reader',
      csrfToken: 'replacement-credential',
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="rating-uncertain"] button')!.click());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>('[data-slot="rating-uncertain"] button')[1]!.click(),
    );
    expect(host.querySelector('[data-slot="rating-uncertain"]')).toBeNull();
    await act(async () => host.querySelector('form')!.querySelectorAll('button')[1]!.click());
    expect(commands[2]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    expect(commands[2]).toMatchObject({ expectedCredential: 'replacement-credential' });
    await renderRecovery({ ...questions[0]!, revision: 2 });
    expect(host.querySelector('[data-slot="rating-uncertain"]')).toBeNull();
    expect(host.querySelector('form')!.getAttribute('action')).toBe('/en/original#rating');
    client.clear();
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
