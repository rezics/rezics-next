import { expect, test } from 'bun:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { SummaryLink } from './names.tsx';
import { iri, summary } from './fixtures.ts';
import type { NameSummary } from './types.ts';

const router: AppRouterInstance = { bfcacheId: '', refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
const render = (element: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
const labels = { unavailable: 'Could not load', unnamed: 'Unnamed', undisclosed: 'Name not shown' };

test('names distinguish a failed read, an undisclosed answer and a truly empty disclosed name', () => {
  const cases: [NameSummary | undefined, string, string][] = [
    [undefined, 'unavailable', labels.unavailable],
    [{ reference: iri('1'), status: 'unavailable-read' }, 'unavailable', labels.unavailable],
    [{ reference: iri('2'), status: 'unavailable' }, 'undisclosed', labels.undisclosed],
    [summary(iri('3'), ''), 'unnamed', labels.unnamed],
  ];
  for (const [resource, state, text] of cases) {
    const html = render(<SummaryLink summary={resource} {...labels} />);
    expect(html).toContain(`data-name-state="${state}"`);
    expect(html).toContain(text);
    if (state !== 'unnamed') expect(html).not.toContain('href=');
  }
  const html = render(<SummaryLink summary={summary(iri('4'), 'Known sibling')} {...labels} />);
  expect(html).toContain('Known sibling');
  expect(html).toContain('href=');
  expect(html).not.toContain('data-name-state');
});
