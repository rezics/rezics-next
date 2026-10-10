import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiLocales } from '../i18n/define.ts';
import { copyOf } from '../features/entity-page/messages.ts';
import { statements, predicateLabels } from '../features/entity-page/fixtures.ts';
import { standaloneHrefFor } from '../features/entity-page/route.ts';
import { StatementsView } from '../features/entity-page/views.tsx';
import { attributed, ccBySa, creditedOnly, hostOnly, instrumentOnly, sourceUrl, unassessed } from '../features/rights-mark/fixtures.ts';
import { messages } from '../features/rights-mark/messages.ts';
import { licenceLabel, RightsMark, RightsRunRows, rightsRuns } from '../features/rights-mark/rights-mark.tsx';
import { resourceHref } from '../features/address/path.ts';
import { messages as workMessages } from '../features/work-page/messages.ts';
import { work } from '../features/work-page/fixtures.ts';
import { WorkAbout } from '../features/work-page/work-header.tsx';

const draw = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const marks = (html: string) => html.match(/data-rights-mark/g)?.length ?? 0;

describe('rights mark', () => {
  test('an assessed credit names the source, links it, and keeps the licence and share-alike', () => {
    const html = draw(createElement(RightsMark, { rights: attributed, locale: 'en' }));
    expect(html).toContain('Source: ');
    expect(html).toContain('>Example</a>');
    expect(html).toContain(`href="${sourceUrl}"`);
    expect(html).not.toContain(`>${sourceUrl}<`);
    expect(html).toContain('CC BY-SA 3.0');
    expect(html).toContain(`href="${ccBySa}"`);
    expect(html).toContain(messages.en.shareAlike);
    expect(marks(html)).toBe(1);
    // The same licence URL is not repeated for the attribution and the read.
    expect(html.match(/CC BY-SA 3\.0/g)).toHaveLength(1);
  });

  test('a notice that is only an address shows the host, not the address', () => {
    const html = draw(createElement(RightsMark, { rights: hostOnly, locale: 'en' }));
    expect(html).toContain('Source: ');
    expect(html).toContain('>example.test</a>');
    expect(html).toContain(`href="${sourceUrl}"`);
    expect(html).not.toContain(`>${sourceUrl}<`);
  });

  test('an assessed read with only a licence shows that link', () => {
    const html = draw(createElement(RightsMark, { rights: instrumentOnly, locale: 'en' }));
    expect(html).toContain('CC BY-SA 3.0');
    expect(html).not.toContain(messages.en.shareAlike);
    expect(html).not.toContain('Source:');
    expect(marks(html)).toBe(1);
  });

  test('an unassessed read renders nothing', () => {
    expect(draw(createElement(RightsMark, { rights: unassessed, locale: 'en' }))).toBe('');
    const about = draw(createElement(WorkAbout, { work, messages: workMessages.en, locale: 'en' }));
    expect(about).toContain('A surveyor maps a delta');
    expect(about).not.toContain('data-rights-mark');
  });

  test('one mark for a run of rows with identical rights', () => {
    const rows = [
      { id: 'a', text: 'Born in 2008', rights: attributed },
      { id: 'b', text: 'Also known as the Black Swordsman', rights: attributed },
      { id: 'c', text: 'Member of the Knights', rights: attributed },
    ];
    expect(rightsRuns(rows, row => row.rights)).toHaveLength(1);
    const html = draw(createElement(RightsRunRows, {
      locale: 'en',
      rows: rows.map(row => ({ id: row.id, rights: row.rights, children: row.text })),
    }));
    expect(marks(html)).toBe(1);
    expect(html.match(/data-rights-run/g)).toHaveLength(1);
    for (const row of rows) expect(html).toContain(row.text);

    const split = [
      ...rows,
      { id: 'd', text: 'Original title', rights: creditedOnly },
      { id: 'e', text: 'First published in 2012', rights: creditedOnly },
    ];
    expect(rightsRuns(split, row => row.rights).map(run => run.items.length)).toEqual([3, 2]);
    const splitHtml = draw(createElement(RightsRunRows, {
      locale: 'en',
      rows: split.map(row => ({ id: row.id, rights: row.rights, children: row.text })),
    }));
    expect(marks(splitHtml)).toBe(2);
  });

  test('a statement list uses the page read once, not once per row', () => {
    const page = { ...statements(), factObligations: attributed };
    const html = draw(createElement(StatementsView, {
      page: { ok: true, data: page }, labels: predicateLabels, ownName: 'Kirito', names: new Map(),
      cursor: undefined, hrefFor: standaloneHrefFor({}, resourceHref('/e/', '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d')),
      locale: 'en', t: copyOf('en'), messages: workMessages.en,
    }));
    expect(html).toContain('キリト');
    expect(html).toContain('Also known as');
    expect(marks(html)).toBe(1);
    expect(html).toContain(messages.en.shareAlike);
  });

  test('a description keeps the credit outside the folded text', () => {
    const html = draw(createElement(WorkAbout, {
      work: { ...work, descriptionObligations: attributed }, messages: workMessages.en, locale: 'de',
    }));
    const description = html.indexOf('A surveyor maps a delta');
    const mark = html.indexOf('data-rights-mark');
    expect(description).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(description);
    expect(html).toContain(messages.de.shareAlike);
  });

  test('every returned duty is shown, and a Creative Commons deed uses its public name', () => {
    expect(licenceLabel(ccBySa)).toBe('CC BY-SA 3.0');
    expect(licenceLabel('https://creativecommons.org/licenses/by/4.0/')).toBe('CC BY 4.0');
    expect(licenceLabel('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('CC0 1.0');
    expect(licenceLabel('https://example.test/licence')).toBe('https://example.test/licence');
    const html = draw(createElement(RightsMark, { rights: {
      status: 'assessed', use: 'wiki_display', instrument: null,
      obligations: [
        { kind: 'notice_retention', instrument: 'https://example.test/licence', appliesTo: 'display', notice: '© Example' },
        { kind: 'change_indication', instrument: 'https://example.test/licence', appliesTo: 'all', notice: null },
        { kind: 'non_commercial', instrument: 'https://example.test/licence', appliesTo: 'display', notice: null },
        { kind: 'no_derivatives', instrument: 'https://example.test/licence', appliesTo: 'display', notice: null },
        { kind: 'other', instrument: 'https://example.test/licence', appliesTo: 'display', notice: 'No model training' },
      ],
    }, locale: 'en' }));
    expect(html).toContain(messages.en.noticeRetention);
    expect(html).toContain('© Example');
    expect(html).toContain(messages.en.changeIndication);
    expect(html).toContain(messages.en.nonCommercial);
    expect(html).toContain(messages.en.noDerivatives);
    expect(html).toContain('No model training');
    expect(html).not.toContain(messages.en.otherTerms);
    expect(html).toContain('href="https://example.test/licence"');
  });

  test('each locale has the duty notes', () => {
    for (const locale of uiLocales) {
      const copy = messages[locale];
      for (const value of Object.values(copy)) expect(value.trim().length).toBeGreaterThan(0);
      const html = draw(createElement(RightsMark, { rights: attributed, locale }));
      expect(html).toContain(copy.source);
      expect(html).toContain(copy.shareAlike);
    }
  });
});
