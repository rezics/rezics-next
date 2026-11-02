import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { RatingOutcome } from '../src/features/pages/subject-ratings';
import type { RatingSourceOwner } from '../src/features/pages/subject-ratings-view';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/one' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
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

const { createRoot } = await import('react-dom/client');
const { RatingSourceStatus } = await import('../src/features/pages/subject-ratings-view');

type Kind = RatingOutcome<string>;
const failed: Kind = { kind: 'failed' };
const idle: Kind = { kind: 'idle' };
const ready: Kind = { kind: 'ready', value: 'ok' };
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
const votes = { count: 0 };
const recoveries: string[] = [];
let setFigure: (outcome: Kind) => void = () => {};

function group(source: string) {
  return host.querySelector<HTMLElement>(`[data-source="${source}"]`);
}
function retry(source: string) {
  return group(source)?.querySelector<HTMLButtonElement>('button') ?? null;
}

function Board({ owner, question, figure }: { owner: RatingSourceOwner; question: Kind; figure: Kind }) {
  const [sources, setSources] = useState({ question, figure });
  setFigure = (outcome) => setSources((current) => ({ ...current, figure: outcome }));
  const status = (source: 'question' | 'figure', outcome: Kind, result: ReactNode) =>
    createElement(
      RatingSourceStatus,
      {
        key: source,
        outcome,
        source,
        locale: 'en',
        owner,
        retry: () => {
          recoveries.push(source);
          setSources((current) => ({ ...current, [source]: idle }));
        },
      },
      result,
    );
  return createElement('div', null, [
    createElement('button', { key: 'vote', type: 'button', 'data-vote': '', onClick: () => votes.count++ }, 'Vote'),
    status(
      'question',
      sources.question,
      sources.question.kind === 'ready' ? createElement('p', { 'data-result': 'question' }, 'question') : null,
    ),
    status(
      'figure',
      sources.figure,
      sources.figure.kind === 'ready' ? createElement('p', { 'data-result': 'figure' }, 'figure') : null,
    ),
  ]);
}

async function show(owner: RatingSourceOwner, question: Kind = failed, figure: Kind = failed) {
  root ??= createRoot(host);
  votes.count = 0;
  recoveries.length = 0;
  await act(async () =>
    root!.render(
      createElement(Board, {
        key: `${owner.subject}:${owner.population ?? ''}:${owner.incarnation ?? ''}`,
        owner,
        question,
        figure,
      }),
    ),
  );
}

async function activate(source: string) {
  const button = retry(source)!;
  button.focus();
  await act(async () => button.click());
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.replaceChildren();
});

afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  await window.happyDOM.close();
});

test('one source retry stays on its named target through idle and ready while a sibling stays failed', async () => {
  await show({ subject: 'one' });
  const sibling = retry('question');
  await activate('figure');
  expect(recoveries).toEqual(['figure']);
  expect(votes.count).toBe(0);
  expect(retry('figure')).toBeNull();
  expect(window.document.activeElement).toBe(group('figure'));
  expect(retry('question')).toBe(sibling);
  await act(async () => setFigure(ready));
  expect(window.document.activeElement).toBe(group('figure'));
  expect(group('figure')?.querySelector('[data-result="figure"]')).not.toBeNull();
  expect(retry('question')).not.toBeNull();
  expect(votes.count).toBe(0);
});

test('repeat failure restores Retry; moved focus, owner replacement and unmount do not', async () => {
  await show({ subject: 'one', population: 'alpha', incarnation: '1' });
  await activate('figure');
  await act(async () => setFigure(failed));
  expect(window.document.activeElement).toBe(retry('figure'));

  const elsewhere = host.querySelector<HTMLButtonElement>('[data-vote]')!;
  await activate('figure');
  elsewhere.focus();
  await act(async () => setFigure(ready));
  expect(window.document.activeElement).toBe(elsewhere);

  await show({ subject: 'one', population: 'alpha', incarnation: '1' });
  await activate('figure');
  await show({ subject: 'two', population: 'beta', incarnation: '2' });
  expect(window.document.activeElement).not.toBe(group('figure'));
  expect(window.document.activeElement).not.toBe(retry('figure'));

  await activate('figure');
  await act(async () => root!.unmount());
  root = undefined;
  expect(host.querySelector('[data-source="figure"]')).toBeNull();
  expect(votes.count).toBe(0);
});
