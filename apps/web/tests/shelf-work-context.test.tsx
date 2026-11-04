import { expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentShelfWorkContext, prepareShelfWorkContext } from '../src/library/shelf-work-context/context';
import {
  contextExampleRelease,
  shelfContextExamples,
  shelfExampleId,
} from '../src/library/shelf-work-context/examples';
import { ShelfWorkContextView } from '../src/library/shelf-work-context/view';
import { shelfHref } from '../src/library/shelf-params';
import * as start from '../.storybook/react-start';

const html = (entry: ReturnType<typeof shelfContextExamples>[number], locale = 'en', isCurrent = () => true) =>
  renderToStaticMarkup(createElement(ShelfWorkContextView, { entry, locale, isCurrent }));

test('homonyms retain exact creator roles, localized destinations and partial date precision, separate from state', () => {
  const entries = shelfContextExamples('en');
  const original = structuredClone(entries);
  expect(html(entries[0]!)).toContain('Author');
  expect(html(entries[1]!)).toContain('Director');
  expect(html(entries[1]!)).not.toContain('Author');
  expect(html(entries[0]!)).toContain(`/en/subjects/${shelfExampleId(500)}/`);
  expect(html(entries[1]!)).toContain(`/en/subjects/${shelfExampleId(501)}/`);
  expect(entries[0]!.workContext!.facts[1]!.text).toBe('2020');
  expect(entries[1]!.workContext!.facts[1]!.text).toBe('May 2021');
  expect(entries[2]!.workContext!.facts[1]!.text).toBe('May 3, 2022');
  expect(html(entries[2]!)).toContain('Based on');
  const ja = shelfContextExamples('ja')[1]!;
  expect(html(ja, 'ja')).toContain('監督');
  expect(html(ja, 'ja')).toContain(`/ja/subjects/${shelfExampleId(501)}/`);
  for (const entry of entries) expect(html(entry)).not.toMatch(/In progress|12|score|rating/);
  expect(entries).toEqual(original);
});

test('missing, withheld, stale or replaced contexts have no link; released bounds cannot hydrate another row', () => {
  const entry = shelfContextExamples('en')[0]!;
  for (const changed of [
    { ...entry, subject: null },
    { ...entry, revision: 8 },
    { ...entry, incarnationId: shelfExampleId(999) },
    { ...entry, subjectId: shelfExampleId(998) },
    { ...entry, subject: { ...entry.subject!, id: shelfExampleId(997) } },
  ])
    expect(currentShelfWorkContext(changed, 'en')).toBeNull();
  expect(html(entry, 'en', () => false)).toBe('');
  expect(html(entry, 'ja')).toBe('');
  expect(html(shelfContextExamples('en')[3]!)).toBe('');
  expect(html(shelfContextExamples('en')[4]!)).toBe('');
  expect(prepareShelfWorkContext(entry, undefined, 'en')).toBeNull();
  const withheld = {
    ...entry,
    facts: { 'schema:author': [{ kind: 'item' as const, id: shelfExampleId(500), labels: {} }] },
  };
  expect(prepareShelfWorkContext(withheld, contextExampleRelease, 'en')?.facts).toEqual([]);
  const many = {
    ...entry,
    facts: {
      'schema:author': Array.from({ length: 100 }, (_, n) => ({
        kind: 'item' as const,
        id: shelfExampleId(500 + n),
        labels: { en: `Creator ${n}` },
      })),
    },
  };
  expect(prepareShelfWorkContext(many, contextExampleRelease, 'en')?.facts).toHaveLength(3);
  const assignment = { ...entry, id: shelfExampleId(800), labelId: shelfExampleId(801) };
  const bound = { ...assignment, workContext: prepareShelfWorkContext(assignment, contextExampleRelease, 'en') };
  expect(currentShelfWorkContext({ ...bound, id: shelfExampleId(802) }, 'en')).toBeNull();
  expect(currentShelfWorkContext({ ...bound, labelId: shelfExampleId(803) }, 'en')).toBeNull();
});

test('actual label shelf list, grid and table retain context, state and progress without turning tombstones into links', async () => {
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const exposure = await import('../src/kernel/exposure');
  const admission = spyOn(exposure, 'useOperation').mockReturnValue(false);
  try {
    const { LabelShelfEntries } = await import('../src/library/shelf-view');
    const label = { id: shelfExampleId(800), name: 'Adaptations' };
    const entries = shelfContextExamples('en').map((entry, index) => {
      const row = { ...entry, id: shelfExampleId(900 + index), labelId: label.id };
      return { ...row, workContext: prepareShelfWorkContext(row, contextExampleRelease, 'en') };
    });
    for (const layout of ['list', 'grid', 'table'] as const) {
      const output = renderToStaticMarkup(
        createElement(LabelShelfEntries, { entries, label, locale: 'en', layout, size: 'm', csrfToken: null }),
      );
      expect(output.match(/data-slot="shelf-work-context"/g)).toHaveLength(3);
      expect(output).toContain('Director');
      expect(output).toContain('In progress');
      expect(output).toContain('data-slot="tombstone"');
      expect(output).not.toContain(`/subjects/${entries[4]!.subjectId}/`);
      expect(output).not.toContain('href=""');
      const address = new URL(
        shelfHref('en', { label: label.id, type: 'schema:Book', layout, size: 'l', columns: 'title,status' }),
        'https://site.test',
      );
      expect(address.searchParams.get('label')).toBe(label.id);
      expect(address.searchParams.get('layout')).toBe(layout);
    }
  } finally {
    admission.mockRestore();
  }
});
