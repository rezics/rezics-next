import { expect, mock, spyOn, test } from 'bun:test';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import type { Locale } from '../src/paraglide/runtime.js';
import { currentShelfWorkContext, prepareShelfWorkContext } from '../src/library/shelf-work-context/context';
import {
  contextExampleRelease,
  shelfContextExamples,
  shelfExampleId,
} from '../src/library/shelf-work-context/examples';
import { ShelfWorkContextView } from '../src/library/shelf-work-context/view';
import { ReceivedEntryReader } from '../src/library/received-entry-reading/view';
import type { ShelfRow } from '../src/library/shelf-rows';
import { shelfHref } from '../src/library/shelf-params';
import { displayLibraryTitle } from '../src/library/title';
import { subjectHref } from '../src/subject/subject-href';
import * as start from '../.storybook/react-start';

const html = (entry: ReturnType<typeof shelfContextExamples>[number], locale = 'en', isCurrent = () => true) =>
  renderToStaticMarkup(createElement(ShelfWorkContextView, { entry, locale, isCurrent }));

function readingHtml(entry: ReturnType<typeof shelfContextExamples>[number], locale = 'en') {
  const row: ShelfRow = { entry, conflict: false, failure: null };
  return renderToStaticMarkup(
    createElement(ReceivedEntryReader, {
      id: 'entry-reading-test',
      headingRef: createRef<HTMLHeadingElement>(),
      row,
      locale,
      isCurrent: () => true,
      progressAdmitted: true,
      close: () => {},
      openProgress: () => {},
    }),
  );
}

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
  const assignment = {
    ...entry,
    id: shelfExampleId(800),
    labelId: shelfExampleId(801),
    entryIdentity: { subjectId: entry.subjectId, revision: entry.revision, incarnationId: entry.incarnationId ?? null },
  };
  const bound = { ...assignment, workContext: prepareShelfWorkContext(assignment, contextExampleRelease, 'en') };
  expect(
    currentShelfWorkContext({ ...bound, entryIdentity: { ...assignment.entryIdentity, revision: 8 } }, 'en'),
  ).toBeNull();
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

test('received Entry reading keeps supplied dates, active Progress and exact Work links in an accessible narrow and wide surface', () => {
  for (const locale of ['en', 'zh-Hant', 'ja']) {
    const entry = shelfContextExamples(locale)[0]!;
    entry.createdAt = '2042-06-07T08:09:10.000Z';
    entry.updatedAt = '2043-07-08T09:10:11.000Z';
    entry.finishedAt = null;
    delete entry.lastActivityAt;
    entry.activeProgressSession = {
      mode: 'scalar_amount',
      unit: 'page',
      amount: '0.50',
      total: null,
      completedUnitCount: 0,
      locator: null,
      unitLabel: 'pages',
      unitLabelLanguage: 'en',
    };
    const output = readingHtml(entry, locale);
    const options = { locale: locale as Locale };
    const title = displayLibraryTitle(entry.subject!.label, locale).text;
    const work = subjectHref({ id: entry.subject!.id, label: title }, locale).href;

    expect(output).toContain('role="dialog"');
    expect(output).toContain('aria-modal="false"');
    expect(output).toContain('inset-x-0 bottom-0');
    expect(output).toContain('sm:inset-y-0');
    expect(output).toContain('sm:w-[min(38rem,calc(100vw-1rem))]');
    expect(output).toContain(`href="${work}"`);
    expect(output).toContain('data-received-entry-progress-destination');
    expect(output).toContain(m.library_entry_reading_state_heading({}, options));
    expect(output).toContain(m.library_entry_reading_exact_value({}, options));
    expect(output).toContain('2042-06-07T08:09:10.000Z');
    expect(output).toContain('2043-07-08T09:10:11.000Z');
    expect(output).toContain(m.library_entry_reading_date_not_supplied({}, options));
    expect(output).toContain(m.library_entry_reading_date_empty({}, options));
    expect(output).toContain('<bdi>0.50</bdi>');
    expect(output).toContain(m.library_entry_reading_total_unknown({}, options));
    expect(output).toContain(m.library_entry_reading_context_heading({}, options));
    expect(output).toContain(m.library_entry_reading_close({}, options));
  }
});

test('an unavailable Subject keeps its state literal and has no Work or Progress destination', () => {
  const entry = shelfContextExamples('en')[4]!;
  entry.state = 'released-custom-state-id';
  delete entry.stateLabel;
  const output = readingHtml(entry);

  expect(output).toContain('released-custom-state-id');
  expect(output).toContain(m.library_entry_reading_state_unreleased());
  expect(output).toContain(m.library_subject_unavailable());
  expect(output).toContain(m.library_entry_reading_context_unavailable());
  expect(output).toContain(m.library_entry_reading_work_unavailable());
  expect(output).toContain(m.library_entry_reading_progress_destination_unavailable());
  expect(output).not.toContain('data-received-entry-work-destination');
  expect(output).not.toContain('data-received-entry-progress-destination');
  expect(output).not.toContain('href=');
});
