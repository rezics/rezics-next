import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resourceHref } from '../address/path.ts';
import { RelationRows } from '../work-levels/connections.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { relationRows } from '../work-levels/relation-rows.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { relationshipsFrom } from '../wiki/entity.ts';
import { appearances, componentStatements, predicateLabels, statements, withheldCreditAppearance } from './fixtures.ts';
import { alter, identityEntry } from './identity-fixtures.ts';
import { copyOf } from './messages.ts';
import { presentStatements } from './statement-groups.ts';
import { standaloneHrefFor } from './route.ts';
import { WikiEntity } from '../../zones/official/franchise-wiki/slots.tsx';
import * as wiki from '../wiki/fixtures.ts';
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
  test('a withheld credited name keeps the role, links to its reference, and shows neither the name nor the IRI', () => {
    const page = withheldCreditAppearance();
    const subject = 'https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d';
    const rows = relationRows(page.items, { together: true });
    expect(rows[0]!.items[0]!.appearance!.creditedName).toEqual({ reference: subject, status: 'unavailable' });
    expect(JSON.stringify(rows)).not.toContain('Hidden Alias');
    const html = draw(createElement(RelationsView, { page: { ok: true, data: page }, cursor: undefined, hrefFor,
      locale: 'en', t: copyOf('en'), messages: workMessages.en }));
    expect(html).toContain('Translator');
    expect(html).toContain('Name not shown');
    expect(html).toContain('data-credited-unavailable');
    expect(html).toContain(resourceHref('/e/', subject));
    expect(html).not.toContain('Hidden Alias');
    expect(html).not.toContain(subject);
    expect(html).not.toContain('data-credited-name=""');
  });
  test('an empty credit and a withheld reference that is not an id are left out', () => {
    const page = appearances();
    const role = page.items[0]!.rendering!.projections.find(projection => projection.toRole === 'role')!;
    const credit = role.arguments.find(argument => argument.role === 'subject')!;
    credit.creditedName = { lexical: '', language: 'en' } as typeof credit.creditedName;
    expect(relationRows(page.items, { together: true })[0]!.items[0]!.appearance!.creditedName).toBeUndefined();
    credit.creditedName = { reference: 'https://example.test/not-an-id', status: 'unavailable' } as unknown as typeof credit.creditedName;
    expect(relationRows(page.items, { together: true })[0]!.items[0]!.appearance!.creditedName).toBeUndefined();
    const html = draw(createElement(RelationsView, { page: { ok: true, data: page }, cursor: undefined, hrefFor,
      locale: 'en', t: copyOf('en'), messages: workMessages.en }));
    expect(html).not.toContain('data-credited-name');
    expect(html).not.toContain('https://example.test/not-an-id');
    expect(html).toContain('Supporting character');
  });
  test('a withheld credit on a translator stays on the connection and links the label', () => {
    const entry = identityEntry('work', 'translator', alter);
    entry.rendering!.projections[0]!.labels = {
      noun: 'Translator', heading: 'Translator', plurals: { other: 'Translator' }, grammaticalForms: [],
    };
    const argument = entry.rendering!.projections[0]!.arguments[0]!;
    argument.creditedName = {
      lexical: 'Hidden Alias', language: 'en', reference: alter.reference, status: 'unavailable',
    } as typeof argument.creditedName;
    const rows = relationRows([entry]);
    expect(rows[0]!.items[0]!.creditedName).toEqual({ reference: alter.reference, status: 'unavailable' });
    const html = draw(createElement(RelationRows, { rows, locale: 'en', t: levelsCopy('en') }));
    expect(html).toContain('Translator');
    expect(html).toContain('Name not shown');
    expect(html).toContain('data-credited-unavailable');
    expect(html).toContain(resourceHref('/e/', alter.reference));
    expect(html).not.toContain('Hidden Alias');
    expect(html).not.toContain(alter.reference);
  });
  test('the wiki adapter carries a withheld appearance credit to the slot', async () => {
    const subject = 'https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d';
    const page = resourceHref('/e/', subject);
    const { relationships } = await relationshipsFrom(withheldCreditAppearance().items, async reference => resourceHref('/e/', reference));
    const credits = relationships.flatMap(row => row.others.flatMap(other =>
      'withheldCredit' in other && typeof other.withheldCredit === 'string' ? [other.withheldCredit] : []));
    expect(relationships.some(row => row.label === 'Translator')).toBe(true);
    expect(credits).toContain(page);
    expect(JSON.stringify(relationships)).not.toContain('Hidden Alias');
    expect(JSON.stringify(relationships)).not.toContain(subject);
    const html = draw(createElement(WikiEntity, {
      zone: wiki.zoneFor('en'), fallback: null,
      Link: ({ href, children }) => createElement('a', { href }, children),
      entity: { ...wiki.elizabeth, relationships }, position: wiki.atEverything, mount: null, rest: null,
    }));
    expect(html).toContain('Translator');
    expect(html).toContain('Name not shown');
    expect(html).toContain('data-credited-unavailable');
    expect(html).toContain(page);
    expect(html).not.toContain('Hidden Alias');
    expect(html).not.toContain(subject);
  });
  test('the wiki slot shows a withheld credit as its own label and still shows a recorded one', () => {
    const html = draw(createElement(WikiEntity, {
      zone: wiki.zoneFor('en'), fallback: null,
      Link: ({ href, children }) => createElement('a', { href }, children),
      entity: wiki.elizabethCreditWithheld, position: wiki.atEverything, mount: null, rest: null,
    }));
    expect(html).toContain('Translator');
    expect(html).toContain('Arthur');
    expect(html).toContain('Name not shown');
    expect(html).toContain('>Lizzy<');
    expect(html).not.toContain('Hidden Alias');
    expect(html).not.toContain('https://rezics.com/id/');
    expect(html).toContain('data-credited-unavailable');
  });
});
