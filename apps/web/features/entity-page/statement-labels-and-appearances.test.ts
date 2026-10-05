import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resourceHref } from '../address/path.ts';
import { relationRows } from '../work-levels/relation-rows.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { appearances, componentStatements, predicateLabels, statements } from './fixtures.ts';
import { copyOf } from './messages.ts';
import { presentStatements } from './statement-groups.ts';
import { standaloneHrefFor } from './route.ts';
import { RelationsView, StatementsView } from './views.tsx';

const hrefFor = standaloneHrefFor({}, resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d'));
const draw = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe('Statements without a label', () => {
  test('values of a predicate with no label share "Other facts" and the page name is not repeated', () => {
    const { labelled, other } = presentStatements(statements().groups, predicateLabels, 'Kirito');
    expect(labelled.map(group => group.predicate)).toEqual([
      'https://schema.org/name', 'https://schema.org/alternateName', 'https://schema.org/birthDate']);
    // The Japanese name is a different name, so it stays; the English one is the heading's.
    expect(labelled[0]!.items).toHaveLength(1);
    expect(other).toHaveLength(1);
  });
  test('a page whose only statement is its own name has nothing to list', () => {
    const { labelled, other } = presentStatements(componentStatements.groups, new Map(), 'معرض الهولوغرام');
    expect([labelled, other]).toEqual([[], []]);
  });
  test('no heading is drawn empty', () => {
    const html = draw(createElement(StatementsView, { page: { ok: true, data: statements() }, names: new Map(),
      labels: predicateLabels, ownName: 'Kirito', cursor: undefined, hrefFor, t: copyOf('en'), messages: workMessages.en }));
    expect(html).toContain('Other facts');
    expect(html).not.toMatch(/<h3[^>]*><\/h3>/);
  });
});

describe('Appearances', () => {
  test('an occurrence read from the character is one item led by its Work, with the role and credited name', () => {
    const rows = relationRows(appearances().items, { together: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.style).toBe('row');
    const [first, second] = rows[0]!.items;
    expect(first!.appearance!.alongside.map(part => part.target.kind === 'resource' && part.target.summary?.status === 'available'
      ? part.target.summary.name.value : null)).toEqual(['Supporting character']);
    expect(first!.appearance!.creditedName).toEqual({ lexical: 'Mikoto', language: 'en' });
    expect(second!.appearance!.creditedName).toBeUndefined();
  });
  test('without `together` the role stays its own row, as Zones and Work pages read it', () => {
    expect(relationRows(appearances().items)).toHaveLength(2);
  });
  test('the page draws each Work with its role and no detached role chips', () => {
    const html = draw(createElement(RelationsView, { page: { ok: true, data: appearances() }, cursor: undefined, hrefFor,
      locale: 'en', t: copyOf('en'), messages: workMessages.en }));
    expect(html).not.toContain('data-role-chip');
    expect(html.match(/data-appearance-part/g)).toHaveLength(2);
    expect(html).toContain('A Certain Magical Index');
    expect(html).toContain('Supporting character');
  });
});
